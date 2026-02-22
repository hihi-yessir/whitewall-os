/**
 * CRE Workflow: Credit Score via Plaid (Confidential HTTP)
 *
 * Trigger: EVM log trigger on ValidationRegistry — ValidationRequest events
 *          filtered by address (ValidationRegistry contract)
 *
 * Flow:
 *   1. Decode ValidationRequest event → extract agentId, requestURI, requestHash
 *   2. Parse requestURI ("plaid:<agentId>")
 *   3. Confidential HTTP: POST Plaid balance/get with pre-exchanged access token
 *      - API keys injected from DON vault (TEE enclave — never exposed to nodes)
 *      - Response AES-GCM encrypted in transit through DON network
 *   4. Parse response → compute credit score (0-100)
 *   5. Build report → writeReport → Forwarder → PlaidCreditValidator.onReport()
 *
 * Consensus: DON consensus via ConfidentialHTTPClient capability
 */

import {
  bytesToHex,
  cre,
  getNetwork,
  Runner,
  type Runtime,
  type EVMLog,
  hexToBase64,
} from "@chainlink/cre-sdk";
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  keccak256,
  toHex,
} from "viem";
import { z } from "zod";

// ========================================
// CONFIG SCHEMA
// ========================================
const configSchema = z.object({
  validationRegistryAddress: z.string(),
  plaidCreditValidatorAddress: z.string(),
  chainSelectorName: z.string(),
  gasLimit: z.string(),
});

type Config = z.infer<typeof configSchema>;

// ========================================
// EVENT ABI
// ========================================
const eventAbi = parseAbi([
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
]);

// ========================================
// CREDIT SCORE COMPUTATION
// ========================================
function computeCreditScore(accounts: any[]): number {
  let score = 0;

  // 1. Total balance (40 points max)
  const totalBalance = accounts.reduce((sum: number, acc: any) => {
    return sum + (acc.balances?.current || 0);
  }, 0);
  score += Math.min(40, Math.floor((totalBalance / 1000) * 40));

  // 2. Account count (10 points max)
  score += Math.min(
    10,
    accounts.length * 3 + (accounts.length >= 3 ? 1 : 0)
  );

  // 3. No negative balances (30 points)
  const hasNegative = accounts.some(
    (acc: any) => (acc.balances?.current || 0) < 0
  );
  if (!hasNegative) score += 30;

  // 4. Account type diversity (20 points max)
  const types = new Set(accounts.map((acc: any) => acc.type));
  score += Math.min(20, types.size * 5);

  return Math.max(0, Math.min(100, score));
}

// ========================================
// LOG TRIGGER HANDLER
// ========================================
const onLogTrigger = (runtime: Runtime<Config>, log: EVMLog): string => {
  const topics = log.topics.map((topic) => bytesToHex(topic)) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const data = bytesToHex(log.data);

  // Decode the ValidationRequest event
  const decodedLog = decodeEventLog({
    abi: eventAbi,
    data,
    topics,
  });

  if (decodedLog.eventName !== "ValidationRequest") {
    throw new Error(`Unexpected event: ${decodedLog.eventName}`);
  }

  const { validatorAddress, agentId, requestURI, requestHash } =
    decodedLog.args;

  runtime.log(
    `ValidationRequest: validator=${validatorAddress} agentId=${agentId} uri=${requestURI}`
  );

  // Filter: only process events for our credit validator
  const expectedValidator =
    runtime.config.plaidCreditValidatorAddress.toLowerCase();
  if (validatorAddress.toLowerCase() !== expectedValidator) {
    runtime.log(
      `Skipping: validator ${validatorAddress} != expected ${expectedValidator}`
    );
    return "Skipped: wrong validator";
  }

  // Parse requestURI: "plaid:<agentId>"
  if (!requestURI.startsWith("plaid:")) {
    throw new Error(`Invalid requestURI format: ${requestURI}`);
  }
  runtime.log(`Plaid request for agentId=${agentId}`);

  // ========================================
  // CONFIDENTIAL HTTP: Plaid Balance API
  // - API keys injected from DON vault (TEE enclave — never exposed to individual nodes)
  // - Response AES-GCM encrypted in transit through DON network
  // ========================================
  const confidentialHttpClient = new cre.capabilities.ConfidentialHTTPClient();

  const plaidResp = confidentialHttpClient.sendRequest(runtime, {
    vaultDonSecrets: [
      { key: "PLAID_CLIENT_ID", namespace: "" },
      { key: "PLAID_SECRET", namespace: "" },
      { key: "PLAID_ACCESS_TOKEN", namespace: "" },
    ],
    request: {
      url: "https://sandbox.plaid.com/accounts/balance/get",
      method: "POST",
      bodyString: '{"client_id":"{{.PLAID_CLIENT_ID}}","secret":"{{.PLAID_SECRET}}","access_token":"{{.PLAID_ACCESS_TOKEN}}"}',
      multiHeaders: {
        "Content-Type": { values: ["application/json"] },
      },
      encryptOutput: true,
    },
  }).result();

  const responseBody = new TextDecoder().decode(plaidResp.body);
  const plaidParsed = JSON.parse(responseBody);
  const accounts = plaidParsed.accounts as any[];

  runtime.log(`Plaid returned ${accounts.length} accounts`);

  const score = computeCreditScore(accounts);
  runtime.log(`Computed credit score: ${score}/100`);

  // Data hash for on-chain traceability (hash of real Plaid response)
  const dataHash = keccak256(toHex(responseBody));

  // Encode report: abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)
  const reportData = encodeAbiParameters(
    parseAbiParameters(
      "uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash"
    ),
    [agentId, score, requestHash, dataHash]
  );

  runtime.log(`Report data encoded: ${reportData.slice(0, 66)}...`);

  // Get network and EVM client
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    throw new Error(
      `Network not found: ${runtime.config.chainSelectorName}`
    );
  }

  const evmClient = new cre.capabilities.EVMClient(
    network.chainSelector.selector
  );

  // Generate DON-signed report
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  // Write report → Forwarder → PlaidCreditValidator.onReport()
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.plaidCreditValidatorAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: runtime.config.gasLimit,
      },
    })
    .result();

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));
  runtime.log(`Credit report written! tx: ${txHash}`);

  return txHash;
};

// ========================================
// WORKFLOW INITIALIZATION
// ========================================
const initWorkflow = (config: Config) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    throw new Error(
      `Network not found: ${config.chainSelectorName}`
    );
  }

  const evmClient = new cre.capabilities.EVMClient(
    network.chainSelector.selector
  );

  return [
    cre.handler(
      evmClient.logTrigger({
        addresses: [config.validationRegistryAddress],
      }),
      onLogTrigger
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  });
  await runner.run(initWorkflow);
}

main();
