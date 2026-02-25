import hre from "hardhat";
import { keccak256, toHex, type Hex, decodeEventLog, parseAbi } from "viem";
import dotenv from "dotenv";

dotenv.config();

/**
 * Fire ValidationRequest transactions on Base Sepolia for CRE simulation.
 */

const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Hex;
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Hex;
const STRIPE_KYC_VALIDATOR = "0x12b456dcc0e669eeb1d96806c8ef87b713d39cc8" as Hex;
const PLAID_CREDIT_VALIDATOR = "0x9a0ed706f1714961bf607404521a58decddc2636" as Hex;

const registeredAbi = parseAbi([
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
const validationRequestAbi = parseAbi([
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
]);

async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address;

  console.log(`Deployer: ${deployerAddress}`);

  const identityRegistry = await viem.getContractAt("IdentityRegistryUpgradeable", IDENTITY_REGISTRY);
  const validationRegistry = await viem.getContractAt("ValidationRegistryUpgradeable", VALIDATION_REGISTRY);

  // Register a new agent
  console.log("Registering new agent...");
  const registerHash = await identityRegistry.write.register();
  console.log(`Register tx: ${registerHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });

  // Find the Registered event using proper viem decoding
  let agentId: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: registeredAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "Registered") {
        agentId = decoded.args.agentId;
        console.log(`Registered agent #${agentId} (owner: ${decoded.args.owner})`);
        break;
      }
    } catch {
      // Not this event, skip
    }
  }

  if (agentId === undefined) {
    throw new Error("Failed to find Registered event in receipt");
  }

  // Verify ownership
  const owner = await identityRegistry.read.ownerOf([agentId]);
  console.log(`Confirmed: ownerOf(${agentId}) = ${owner}`);

  // Fire KYC ValidationRequest
  console.log("\n--- Firing KYC ValidationRequest ---");
  const kycRequestHash = keccak256(toHex(`kyc-e2e-${Date.now()}`));
  const kycTxHash = await validationRegistry.write.validationRequest([
    STRIPE_KYC_VALIDATOR,
    agentId,
    "stripe:vs_1T3KdH8T8bccqlYMzUK9X20c",
    kycRequestHash,
  ]);
  const kycReceipt = await publicClient.waitForTransactionReceipt({ hash: kycTxHash });
  console.log(`KYC ValidationRequest tx: ${kycTxHash}`);

  // Find event log index
  let kycLogIndex = 0;
  for (let i = 0; i < kycReceipt.logs.length; i++) {
    try {
      const decoded = decodeEventLog({
        abi: validationRequestAbi,
        data: kycReceipt.logs[i].data,
        topics: kycReceipt.logs[i].topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "ValidationRequest") {
        kycLogIndex = i;
        console.log(`KYC event at log index ${i}: agentId=${decoded.args.agentId}`);
        break;
      }
    } catch {}
  }

  // Fire Credit ValidationRequest
  console.log("\n--- Firing Credit ValidationRequest ---");
  const creditRequestHash = keccak256(toHex(`credit-e2e-${Date.now()}`));
  const creditTxHash = await validationRegistry.write.validationRequest([
    PLAID_CREDIT_VALIDATOR,
    agentId,
    `plaid:${agentId}`,
    creditRequestHash,
  ]);
  const creditReceipt = await publicClient.waitForTransactionReceipt({ hash: creditTxHash });
  console.log(`Credit ValidationRequest tx: ${creditTxHash}`);

  let creditLogIndex = 0;
  for (let i = 0; i < creditReceipt.logs.length; i++) {
    try {
      const decoded = decodeEventLog({
        abi: validationRequestAbi,
        data: creditReceipt.logs[i].data,
        topics: creditReceipt.logs[i].topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "ValidationRequest") {
        creditLogIndex = i;
        console.log(`Credit event at log index ${i}: agentId=${decoded.args.agentId}`);
        break;
      }
    } catch {}
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("CRE Simulation Commands:");
  console.log("=".repeat(60));
  console.log(`\n# KYC Workflow:`);
  console.log(`cre workflow simulate ./workflows/kyc-workflow \\`);
  console.log(`  --target local-simulation \\`);
  console.log(`  --trigger-index 0 \\`);
  console.log(`  --evm-tx-hash ${kycTxHash} \\`);
  console.log(`  --evm-event-index ${kycLogIndex} \\`);
  console.log(`  --non-interactive --broadcast -v`);
  console.log(`\n# Credit Workflow:`);
  console.log(`cre workflow simulate ./workflows/credit-workflow \\`);
  console.log(`  --target local-simulation \\`);
  console.log(`  --trigger-index 0 \\`);
  console.log(`  --evm-tx-hash ${creditTxHash} \\`);
  console.log(`  --evm-event-index ${creditLogIndex} \\`);
  console.log(`  --non-interactive --broadcast -v`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
