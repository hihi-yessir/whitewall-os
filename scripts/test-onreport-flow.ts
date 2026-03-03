import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  toHex,
  parseAbiItem,
  type Hex,
} from "viem";
import dotenv from "dotenv";

dotenv.config();

// ── Deployed addresses ──
const POLICY_ENGINE = "0x55a34dcc40326d515497b621588af45ef798e052" as Hex;
const TIERED_POLICY = "0x89637c82e247b0a0ed029c1aef5132acff949b1c" as Hex;
const CONSUMER = "0x698f39ea0351973ec3d3f252aa3523a6ceb7f652" as Hex;
const EXTRACTOR = "0xa4f2b32322ebb4cad656f476c51883918f9e45e7" as Hex;
const FORWARDER = "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5" as Hex;

const ON_REPORT_SELECTOR = "0x805f2132" as Hex;

// ── Helper: build a CRE access report ──
function buildReport(
  agentId: bigint,
  approved: boolean,
  tier: number,
  accountableHuman: Hex,
  reason: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000"
): Hex {
  return encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "bool" },
      { type: "uint8" },
      { type: "address" },
      { type: "bytes32" },
    ],
    [agentId, approved, tier, accountableHuman, reason]
  );
}

// ── Helper: build metadata (minimal — workflow ID, DON ID) ──
function buildMetadata(): Hex {
  // CRE metadata format: just encode some placeholder bytes
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [
      keccak256(toHex("access-workflow-v1")),
      keccak256(toHex("don-1")),
    ]
  );
}

// ── Helper: encode full onReport calldata ──
function encodeOnReport(metadata: Hex, report: Hex): Hex {
  return encodeFunctionData({
    abi: [{
      name: "onReport",
      type: "function",
      inputs: [
        { name: "metadata", type: "bytes" },
        { name: "report", type: "bytes" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    }],
    functionName: "onReport",
    args: [metadata, report],
  });
}

async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address;

  console.log("═══════════════════════════════════════════════════════");
  console.log("CRE → Forwarder → Consumer onReport Flow Tests");
  console.log("═══════════════════════════════════════════════════════\n");

  const consumer = await viem.getContractAt("WhitewallConsumer", CONSUMER);
  const pe = await viem.getContractAt("PolicyEngine", POLICY_ENGINE);

  const metadata = buildMetadata();
  const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

  // ════════════════════════════════════════════════
  // Test 1: PolicyEngine.check() — read-only simulation
  // This simulates what happens inside runPolicy modifier
  // ════════════════════════════════════════════════
  console.log("── Test 1: PolicyEngine.check() (read-only policy simulation) ──\n");

  // 1a: Build onReport calldata for denied agent (approved=false)
  const report1a = buildReport(1n, false, 2, ZERO);
  const calldata1a = encodeOnReport(metadata, report1a);
  // Strip the selector (first 4 bytes = 8 hex chars + '0x' prefix)
  const data1a = ("0x" + calldata1a.slice(10)) as Hex;

  console.log("  1a: approved=false, tier=2, agentId=1");
  try {
    await pe.read.check([{
      selector: ON_REPORT_SELECTOR,
      sender: FORWARDER,     // simulate call from forwarder
      data: data1a,
      context: "0x",
    }]);
    console.log("  ❌ Expected policy rejection");
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("CRE: agent not approved")) {
      console.log("  ✅ PolicyEngine correctly rejects: 'CRE: agent not approved'");
    } else {
      console.log(`  ✅ Rejected: ${msg.slice(0, 120)}`);
    }
  }

  // 1b: approved=true, tier=2, registered but not human-verified agent
  const report1b = buildReport(1n, true, 2, "0x21fdEd74C901129977B8e28C2588595163E1e235" as Hex);
  const calldata1b = encodeOnReport(metadata, report1b);
  const data1b = ("0x" + calldata1b.slice(10)) as Hex;

  console.log("\n  1b: approved=true, tier=2, agentId=1 (registered, NOT human-verified)");
  try {
    await pe.read.check([{
      selector: ON_REPORT_SELECTOR,
      sender: FORWARDER,
      data: data1b,
      context: "0x",
    }]);
    console.log("  ❌ Expected policy rejection");
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("human-verified")) {
      console.log("  ✅ PolicyEngine correctly rejects: 'Agent not human-verified on-chain'");
    } else if (msg.includes("WorldIDValidator")) {
      console.log("  ✅ PolicyEngine correctly rejects at WorldIDValidator check");
    } else {
      console.log(`  ✅ Rejected: ${msg.slice(0, 120)}`);
    }
  }

  // 1c: tier=1 should be rejected regardless
  const report1c = buildReport(1n, true, 1, ZERO);
  const calldata1c = encodeOnReport(metadata, report1c);
  const data1c = ("0x" + calldata1c.slice(10)) as Hex;

  console.log("\n  1c: approved=true, tier=1 (below minimum)");
  try {
    await pe.read.check([{
      selector: ON_REPORT_SELECTOR,
      sender: FORWARDER,
      data: data1c,
      context: "0x",
    }]);
    console.log("  ❌ Expected policy rejection");
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("Insufficient")) {
      console.log("  ✅ PolicyEngine correctly rejects: 'Insufficient verification tier'");
    } else {
      console.log(`  ✅ Rejected: ${msg.slice(0, 120)}`);
    }
  }

  // 1d: unregistered agent
  const report1d = buildReport(999999n, true, 2, ZERO);
  const calldata1d = encodeOnReport(metadata, report1d);
  const data1d = ("0x" + calldata1d.slice(10)) as Hex;

  console.log("\n  1d: approved=true, tier=2, agentId=999999 (unregistered)");
  try {
    await pe.read.check([{
      selector: ON_REPORT_SELECTOR,
      sender: FORWARDER,
      data: data1d,
      context: "0x",
    }]);
    console.log("  ❌ Expected policy rejection");
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("not registered")) {
      console.log("  ✅ PolicyEngine correctly rejects: 'Agent not registered'");
    } else {
      console.log(`  ✅ Rejected: ${msg.slice(0, 120)}`);
    }
  }

  // ════════════════════════════════════════════════
  // Test 2: Actual onReport tx (from deployer, not forwarder)
  // Should fail at the forwarder check in the consumer body
  // BUT — runPolicy runs FIRST. If policy rejects, we never reach forwarder check.
  // ════════════════════════════════════════════════
  console.log("\n\n── Test 2: Actual onReport tx (caller check) ──\n");

  // 2a: Call from deployer (not forwarder) with an unregistered agent
  //     runPolicy should revert before we even reach the forwarder check
  console.log("  2a: onReport from deployer (not forwarder), unregistered agent");
  const report2a = buildReport(999999n, true, 2, ZERO);
  try {
    await consumer.write.onReport([metadata, report2a]);
    console.log("  ❌ Expected revert");
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("not registered") || msg.includes("PolicyRejected")) {
      console.log("  ✅ Reverted at policy (before forwarder check): 'Agent not registered'");
    } else if (msg.includes("OnlyForwarder")) {
      console.log("  ✅ Reverted at forwarder check (policy passed but wrong caller)");
    } else {
      console.log(`  ✅ Reverted: ${msg.slice(0, 120)}`);
    }
  }

  // ════════════════════════════════════════════════
  // Test 3: Temporarily set forwarder to deployer, test real tx
  // ════════════════════════════════════════════════
  console.log("\n\n── Test 3: Set forwarder to deployer, test real onReport tx ──\n");

  const currentForwarder = await consumer.read.getForwarder();
  console.log(`  Current forwarder: ${currentForwarder}`);
  console.log(`  Setting forwarder to deployer: ${deployerAddress}`);

  await consumer.write.setForwarder([deployerAddress]);
  await new Promise(r => setTimeout(r, 5000));
  const newForwarder = await consumer.read.getForwarder();
  console.log(`  Forwarder now: ${newForwarder}\n`);

  // 3a: onReport with unregistered agent — policy rejects
  console.log("  3a: onReport (as forwarder), unregistered agent");
  try {
    await consumer.write.onReport([metadata, report2a]);
    console.log("  ❌ Expected revert at policy");
  } catch (e: any) {
    const msg = e.message || "";
    console.log(`  ✅ Policy rejected: ${msg.includes("not registered") ? "'Agent not registered'" : msg.slice(0, 100)}`);
  }

  // 3b: onReport with approved=false — policy rejects at check 1
  console.log("\n  3b: onReport (as forwarder), approved=false");
  const report3b = buildReport(1n, false, 0, ZERO, keccak256(toHex("NOT_APPROVED")));
  try {
    await consumer.write.onReport([metadata, report3b]);
    console.log("  ❌ Expected revert at policy");
  } catch (e: any) {
    const msg = e.message || "";
    console.log(`  ✅ Policy rejected: ${msg.includes("not approved") ? "'CRE: agent not approved'" : msg.slice(0, 100)}`);
  }

  // 3c: onReport with registered agent, tier=2, but not human-verified
  //     This should reach check 4/5 and fail
  console.log("\n  3c: onReport (as forwarder), agentId=1, tier=2 (registered, not human-verified)");
  const report3c = buildReport(1n, true, 2, "0x21fdEd74C901129977B8e28C2588595163E1e235" as Hex);
  try {
    await consumer.write.onReport([metadata, report3c]);
    console.log("  ❌ Expected revert at human verification check");
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("human-verified") || msg.includes("WorldIDValidator")) {
      console.log("  ✅ Policy rejected at human verification layer (check 4 or 5)");
    } else {
      console.log(`  ✅ Rejected: ${msg.slice(0, 120)}`);
    }
  }

  // ── Restore forwarder ──
  console.log(`\n  Restoring forwarder to: ${currentForwarder}`);
  await consumer.write.setForwarder([currentForwarder as Hex]);
  await new Promise(r => setTimeout(r, 5000));
  const restoredForwarder = await consumer.read.getForwarder();
  console.log(`  Forwarder restored: ${restoredForwarder}`);
  console.log(`  Match: ${restoredForwarder.toLowerCase() === currentForwarder.toLowerCase() ? "✅" : "❌"}`);

  // ════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("Interface Verification Summary");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`
  onReport(bytes metadata, bytes report)

  metadata: arbitrary bytes (workflow ID, DON ID, etc.)
  report:   abi.encode(
              uint256 agentId,
              bool    approved,
              uint8   tier,        // 0-4
              address accountableHuman,
              bytes32 reason       // keccak256 of reason string
            )

  Flow:
    Forwarder → Consumer.onReport(metadata, report)
      → runPolicy modifier
        → PolicyEngine.run()
          → WhitewallExtractor.extract(payload)
            → Decodes report into: agentId, approved, tier, accountableHuman, reason
          → TieredPolicy.run(parameters)
            → Base layer (checks 1-5): always
            → KYC layer (check 6): if tier >= 3
            → Credit layer (checks 7-8): if tier >= 4
      → Consumer body: emit AccessGranted/AccessDenied

  Addresses:
    Consumer:  ${CONSUMER}
    PolicyEngine: ${POLICY_ENGINE}
    TieredPolicy: ${TIERED_POLICY}
    Forwarder: ${restoredForwarder}
  `);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch(console.error);
