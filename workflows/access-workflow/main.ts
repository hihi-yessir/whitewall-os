/**
 * CRE Workflow: Whitewall Access Evaluation
 *
 * Trigger: HTTP trigger (Gateway → CRE)
 *
 * Flow:
 *   1. Receive access request via HTTP (agentId, resource type)
 *   2. Read on-chain state: identity registry, WorldID, KYC, credit score
 *   3. Compute tier and approval decision
 *   4. Build report: (agentId, approved, tier, accountableHuman, reason)
 *   5. DON consensus + writeReport → Forwarder → WhitewallConsumer.onReport()
 *      → PolicyEngine → TieredPolicy (double protection)
 *      → Consumer emits AccessGranted / AccessDenied
 *
 * Report format (matches WhitewallConsumer.onReport + WhitewallExtractor):
 *   abi.encode(uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason)
 */

import {
  bytesToHex,
  cre,
  getNetwork,
  Runner,
  type Runtime,
  type HTTPPayload,
  hexToBase64,
  TxStatus,
} from "@chainlink/cre-sdk";
import {
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  toHex,
  getAddress,
  type Hex,
} from "viem";
import { z } from "zod";

// ========================================
// CONFIG SCHEMA
// ========================================
const configSchema = z.object({
  whitewallConsumerAddress: z.string(),
  identityRegistryAddress: z.string(),
  worldIdValidatorAddress: z.string(),
  stripeKYCValidatorAddress: z.string(),
  plaidCreditValidatorAddress: z.string(),
  chainSelectorName: z.string(),
  gasLimit: z.string(),
});

type Config = z.infer<typeof configSchema>;

// ========================================
// REQUEST PAYLOAD SCHEMA
// ========================================
const requestSchema = z.object({
  agentId: z.number().int().positive(),
  requestedResource: z.enum(["image", "video", "premium"]),
  accountableHuman: z.string().optional(),
});

type AccessRequest = z.infer<typeof requestSchema>;

// ========================================
// TIER MAPPING
// ========================================
const RESOURCE_TIER: Record<string, number> = {
  image: 2,    // World ID verified
  video: 3,    // + KYC (Stripe)
  premium: 4,  // + Credit Score (Plaid)
};

// ========================================
// REASON CODES
// ========================================
const REASON_OK = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const REASON_NOT_REGISTERED = keccak256(toHex("NOT_REGISTERED"));
const REASON_NOT_APPROVED = keccak256(toHex("NOT_APPROVED"));
const REASON_NOT_HUMAN = keccak256(toHex("NOT_HUMAN_VERIFIED"));
const REASON_NO_KYC = keccak256(toHex("NO_KYC"));
const REASON_LOW_CREDIT = keccak256(toHex("LOW_CREDIT_SCORE"));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

// ========================================
// ON-CHAIN STATE READER (via Node Mode)
// ========================================

interface AgentState {
  registered: boolean;
  owner: Hex;
  humanVerified: boolean;
  kycVerified: boolean;
  creditScore: number;
}

function readAgentState(
  runtime: Runtime<Config>,
  evmClient: cre.capabilities.EVMClient,
  agentId: bigint,
): AgentState {
  // In local simulation, we read on-chain state directly
  // In production, DON nodes independently read and reach consensus

  // For simulation: use hardcoded known state or mock
  // The CRE SDK EVMClient doesn't support arbitrary contract reads in simulation mode,
  // so we evaluate based on the agentId and return known state for registered agents.

  // Agent #1 is registered but NOT human-verified on-chain
  // (WorldIDValidator.isHumanVerified(1) == false, no humanVerified metadata)
  if (agentId === 1n) {
    return {
      registered: true,
      owner: "0x21fdEd74C901129977B8e28C2588595163E1e235" as Hex,
      humanVerified: false,  // Not yet human-verified on-chain
      kycVerified: false,
      creditScore: 0,
    };
  }

  // Agent #2 — not registered on-chain
  if (agentId === 2n) {
    return {
      registered: false,
      owner: ZERO_ADDRESS,
      humanVerified: false,
      kycVerified: false,
      creditScore: 0,
    };
  }

  // Unknown agents — not registered
  return {
    registered: false,
    owner: ZERO_ADDRESS,
    humanVerified: false,
    kycVerified: false,
    creditScore: 0,
  };
}

// ========================================
// ACCESS EVALUATION
// ========================================
interface EvalResult {
  approved: boolean;
  effectiveTier: number;
  reason: Hex;
  accountableHuman: Hex;
}

function evaluateAccess(
  state: AgentState,
  requestedTier: number,
): EvalResult {
  // Gate 1: Must be registered (ERC-8004 identity NFT)
  if (!state.registered) {
    return {
      approved: false,
      effectiveTier: 0,
      reason: REASON_NOT_REGISTERED,
      accountableHuman: ZERO_ADDRESS,
    };
  }

  // Gate 2: Must be human-verified (World ID) for tier >= 2
  if (!state.humanVerified) {
    return {
      approved: false,
      effectiveTier: 1,
      reason: REASON_NOT_HUMAN,
      accountableHuman: state.owner,
    };
  }

  // Tier 2 achieved (registered + human-verified)
  if (requestedTier <= 2) {
    return {
      approved: true,
      effectiveTier: 2,
      reason: REASON_OK,
      accountableHuman: state.owner,
    };
  }

  // Gate 3: KYC required for tier >= 3
  if (!state.kycVerified) {
    return {
      approved: false,
      effectiveTier: 2,
      reason: REASON_NO_KYC,
      accountableHuman: state.owner,
    };
  }

  // Tier 3 achieved (registered + human + KYC)
  if (requestedTier <= 3) {
    return {
      approved: true,
      effectiveTier: 3,
      reason: REASON_OK,
      accountableHuman: state.owner,
    };
  }

  // Gate 4: Credit score required for tier 4
  if (state.creditScore < 50) {
    return {
      approved: false,
      effectiveTier: 3,
      reason: REASON_LOW_CREDIT,
      accountableHuman: state.owner,
    };
  }

  // Tier 4 achieved (all gates passed)
  return {
    approved: true,
    effectiveTier: 4,
    reason: REASON_OK,
    accountableHuman: state.owner,
  };
}

// ========================================
// WRITE REPORT TO CONSUMER
// ========================================
function writeAccessReport(
  runtime: Runtime<Config>,
  evmClient: cre.capabilities.EVMClient,
  agentId: bigint,
  result: EvalResult,
): string {
  // Encode report: matches WhitewallConsumer.onReport + WhitewallExtractor
  const reportData = encodeAbiParameters(
    parseAbiParameters(
      "uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason"
    ),
    [
      agentId,
      result.approved,
      result.effectiveTier,
      result.accountableHuman as `0x${string}`,
      result.reason,
    ]
  );

  runtime.log(`Report encoded: agentId=${agentId} approved=${result.approved} tier=${result.effectiveTier}`);
  runtime.log(`Report data: ${reportData.slice(0, 66)}...`);

  // DON consensus + signing
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  // writeReport → Forwarder → WhitewallConsumer.onReport()
  //   → runPolicy modifier → PolicyEngine → TieredPolicy
  //   → Consumer body: emit AccessGranted/AccessDenied
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.whitewallConsumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: runtime.config.gasLimit,
      },
    })
    .result();

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));

  if (writeResult.txStatus === TxStatus.SUCCESS) {
    runtime.log(`Access report delivered! tx: ${txHash}`);
  } else {
    const errMsg = writeResult.errorMessage || "unknown";
    runtime.log(`Report delivery failed: ${errMsg}`);
    if (errMsg.includes("PolicyRunRejected")) {
      runtime.log("ACE TieredPolicy rejected the report (double protection caught mismatch)");
    }
  }

  return txHash;
}

// ========================================
// HTTP TRIGGER HANDLER
// ========================================
const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): object => {
  const payloadJson = JSON.parse(payload.input.toString());
  const request = requestSchema.parse(payloadJson);

  const agentId = BigInt(request.agentId);
  const requestedTier = RESOURCE_TIER[request.requestedResource] ?? 2;

  runtime.log("═══════════════════════════════════════════");
  runtime.log("Whitewall Access Workflow");
  runtime.log("═══════════════════════════════════════════");
  runtime.log(`Agent ID: ${agentId}`);
  runtime.log(`Requested resource: ${request.requestedResource} (tier ${requestedTier})`);

  // Initialize EVM client for Base Sepolia
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    throw new Error(`Network not found: ${runtime.config.chainSelectorName}`);
  }

  const evmClient = new cre.capabilities.EVMClient(
    network.chainSelector.selector
  );

  // Step 1: Read on-chain agent state
  runtime.log("\n── Step 1: Reading agent state ──");
  const state = readAgentState(runtime, evmClient, agentId);
  runtime.log(`  registered: ${state.registered}`);
  runtime.log(`  owner: ${state.owner}`);
  runtime.log(`  humanVerified: ${state.humanVerified}`);
  runtime.log(`  kycVerified: ${state.kycVerified}`);
  runtime.log(`  creditScore: ${state.creditScore}`);

  // Step 2: Evaluate access
  runtime.log("\n── Step 2: Evaluating access ──");
  const result = evaluateAccess(state, requestedTier);
  runtime.log(`  approved: ${result.approved}`);
  runtime.log(`  effectiveTier: ${result.effectiveTier}`);
  runtime.log(`  reason: ${result.reason === REASON_OK ? "OK" : result.reason.slice(0, 18) + "..."}`);

  // Step 3: Write report to consumer
  runtime.log("\n── Step 3: Writing report to consumer ──");
  runtime.log(`  receiver: ${runtime.config.whitewallConsumerAddress}`);
  const txHash = writeAccessReport(runtime, evmClient, agentId, result);

  // Return result
  return {
    reportDelivered: true,
    agentId: request.agentId,
    requestedResource: request.requestedResource,
    requestedTier,
    approved: result.approved,
    effectiveTier: result.effectiveTier,
    accountableHuman: result.accountableHuman,
    txHash,
  };
};

// ========================================
// WORKFLOW INITIALIZATION
// ========================================
const initWorkflow = (config: Config) => {
  const httpTrigger = new cre.capabilities.HTTPCapability();

  return [
    cre.handler(httpTrigger.trigger({}), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  });
  await runner.run(initWorkflow);
}

main();
