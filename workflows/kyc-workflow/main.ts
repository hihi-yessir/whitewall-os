/**
 * CRE Workflow: KYC Verification via Stripe Identity (Confidential HTTP)
 *
 * Trigger: EVM log trigger on ValidationRegistry — ValidationRequest events
 *          filtered by address (ValidationRegistry contract)
 *
 * Flow:
 *   1. Decode ValidationRequest event → extract agentId, requestURI, requestHash
 *   2. Parse requestURI ("stripe:<sessionId>") to get Stripe session ID
 *   3. Confidential HTTP: GET Stripe Identity verification session
 *      - API key injected from DON vault (TEE enclave — never exposed to nodes)
 *      - Response AES-GCM encrypted in transit through DON network
 *   4. Parse response → verified = (status == "verified")
 *   5. Build report → writeReport → Forwarder → StripeKYCValidator.onReport()
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
  stripeKYCValidatorAddress: z.string(),
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

  // Filter: only process events for our KYC validator
  const expectedValidator =
    runtime.config.stripeKYCValidatorAddress.toLowerCase();
  if (validatorAddress.toLowerCase() !== expectedValidator) {
    runtime.log(
      `Skipping: validator ${validatorAddress} != expected ${expectedValidator}`
    );
    return "Skipped: wrong validator";
  }

  // Parse requestURI: "stripe:<sessionId>"
  if (!requestURI.startsWith("stripe:")) {
    throw new Error(`Invalid requestURI format: ${requestURI}`);
  }
  const sessionId = requestURI.slice("stripe:".length);
  runtime.log(`Stripe session ID: ${sessionId}`);

  // ========================================
  // CONFIDENTIAL HTTP: Stripe Identity API
  // - API key loaded from DON vault (TEE enclave — never exposed to individual nodes)
  // - Response AES-GCM encrypted in transit through DON network
  // ========================================
  const confidentialHttpClient = new cre.capabilities.ConfidentialHTTPClient();

  const stripeResp = confidentialHttpClient.sendRequest(runtime, {
    vaultDonSecrets: [
      { key: "STRIPE_SECRET_KEY_B64", namespace: "" },
    ],
    request: {
      url: `https://api.stripe.com/v1/identity/verification_sessions/${sessionId}`,
      method: "GET",
      multiHeaders: {
        "Authorization": { values: ["Basic {{.STRIPE_SECRET_KEY_B64}}"] },
      },
      encryptOutput: true,
    },
  }).result();

  const responseBody = new TextDecoder().decode(stripeResp.body);
  const parsed = JSON.parse(responseBody);
  const status = (parsed.status || "error") as string;
  const id = (parsed.id || sessionId) as string;

  runtime.log(`Stripe session ${id}: status=${status}`);

  // Stripe Identity verification statuses:
  // "verified" — user passed all checks
  // "requires_input" — waiting for user
  // "canceled" — user or system canceled
  const verified = status === "verified";
  const score = verified ? 100 : 0;

  runtime.log(
    `KYC result: verified=${verified} score=${score} for agentId=${agentId}`
  );

  // Session hash for on-chain traceability
  const sessionHash = keccak256(toHex(sessionId));

  // Encode report: abi.encode(uint256 agentId, bool verified, bytes32 requestHash, bytes32 sessionHash)
  const reportData = encodeAbiParameters(
    parseAbiParameters(
      "uint256 agentId, bool verified, bytes32 requestHash, bytes32 sessionHash"
    ),
    [agentId, verified, requestHash, sessionHash]
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

  // Write report → Forwarder → StripeKYCValidator.onReport()
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.stripeKYCValidatorAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: runtime.config.gasLimit,
      },
    })
    .result();

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));
  runtime.log(`KYC report written! tx: ${txHash}`);

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
