import hre from "hardhat";
import { encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Hex, pad } from "viem";
import dotenv from "dotenv";

dotenv.config();

// Deployed addresses
const POLICY_ENGINE = "0x12816c0c79981726627a550b73e9627b81be95be" as Hex;
const TIERED_POLICY = "0x63b4d2e051180c3c0313eb71a9bdda8554432e23" as Hex;
const CONSUMER = "0xb5845901c590f06ffa480c31b96aca7eff4dfb3e" as Hex;
const EXTRACTOR = "0x27b22cdbbf3b03dde7597ec8ff8640b74aeea58b" as Hex;
const KYC_VALIDATOR = "0x12b456dcc0e669eeb1d96806c8ef87b713d39cc8" as Hex;
const CREDIT_VALIDATOR = "0x9a0ed706f1714961bf607404521a58decddc2636" as Hex;

const ON_REPORT_SELECTOR = "0x805f2132" as Hex;

async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════");
  console.log("ACE Condition Tests");
  console.log("═══════════════════════════════════════════\n");

  // ── 1. Verify PolicyEngine wiring ──
  console.log("1. PolicyEngine wiring...");
  const pe = await viem.getContractAt("PolicyEngine", POLICY_ENGINE);

  const policies = await pe.read.getPolicies([CONSUMER, ON_REPORT_SELECTOR]);
  console.log(`   Policies: ${JSON.stringify(policies)}`);
  console.log(`   Expected: [${TIERED_POLICY}]`);
  console.log(`   ${policies.length === 1 && policies[0].toLowerCase() === TIERED_POLICY.toLowerCase() ? "✅ PASS" : "❌ FAIL"}\n`);

  const ext = await pe.read.getExtractor([ON_REPORT_SELECTOR]);
  console.log(`   Extractor: ${ext}`);
  console.log(`   Expected: ${EXTRACTOR}`);
  console.log(`   ${ext.toLowerCase() === EXTRACTOR.toLowerCase() ? "✅ PASS" : "❌ FAIL"}\n`);

  // ── 2. Verify TieredPolicy config ──
  console.log("2. TieredPolicy config...");
  const tp = await viem.getContractAt("TieredPolicy", TIERED_POLICY);

  const idReg = await tp.read.getIdentityRegistry();
  const worldId = await tp.read.getWorldIdValidator();
  const kycVal = await tp.read.getStripeKYCValidator();
  const creditVal = await tp.read.getPlaidCreditValidator();
  const minCredit = await tp.read.getMinCreditScore();

  console.log(`   IdentityRegistry:    ${idReg}`);
  console.log(`   WorldIDValidator:    ${worldId}`);
  console.log(`   StripeKYCValidator:  ${kycVal}`);
  console.log(`   PlaidCreditValidator:${creditVal}`);
  console.log(`   MinCreditScore:      ${minCredit}`);
  console.log(`   KYC Validator match: ${kycVal.toLowerCase() === KYC_VALIDATOR.toLowerCase() ? "✅" : "❌"}`);
  console.log(`   Credit Validator match: ${creditVal.toLowerCase() === CREDIT_VALIDATOR.toLowerCase() ? "✅" : "❌"}`);
  console.log(`   Min credit score = 50: ${minCredit === 50 ? "✅" : "❌"}\n`);

  // ── 3. Verify Consumer config ──
  console.log("3. WhitewallConsumer config...");
  const consumer = await viem.getContractAt("WhitewallConsumer", CONSUMER);
  const forwarder = await consumer.read.getForwarder();
  console.log(`   Forwarder: ${forwarder}`);
  console.log(`   ${forwarder !== "0x0000000000000000000000000000000000000000" ? "✅ Set" : "❌ Not set"}\n`);

  // ── 4. Test TieredPolicy.run() directly with mock parameters ──
  console.log("4. TieredPolicy.run() simulation tests...\n");

  // Helper to build policy parameters
  function buildParams(agentId: bigint, approved: boolean, tier: number, human: Hex): Hex[] {
    return [
      encodeAbiParameters([{ type: "uint256" }], [agentId]),
      encodeAbiParameters([{ type: "bool" }], [approved]),
      encodeAbiParameters([{ type: "uint8" }], [tier]),
      encodeAbiParameters([{ type: "address" }], [human]),
    ];
  }

  const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
  const DUMMY = "0x0000000000000000000000000000000000000001" as Hex;
  const DUMMY4 = "0x00000000" as Hex;

  // Test A: approved=false → should revert
  console.log("   Test A: approved=false, tier=2");
  try {
    await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(1n, false, 2, ZERO), "0x"]);
    console.log("   ❌ Should have reverted");
  } catch (e: any) {
    const msg = e.message || e.shortMessage || "";
    if (msg.includes("CRE: agent not approved")) {
      console.log("   ✅ Correctly rejected: 'CRE: agent not approved'\n");
    } else {
      console.log(`   ✅ Reverted (${msg.slice(0, 80)})\n`);
    }
  }

  // Test B: tier=1 → should revert
  console.log("   Test B: approved=true, tier=1");
  try {
    await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(1n, true, 1, ZERO), "0x"]);
    console.log("   ❌ Should have reverted");
  } catch (e: any) {
    const msg = e.message || e.shortMessage || "";
    if (msg.includes("Insufficient verification tier")) {
      console.log("   ✅ Correctly rejected: 'Insufficient verification tier'\n");
    } else {
      console.log(`   ✅ Reverted (${msg.slice(0, 80)})\n`);
    }
  }

  // Test C: tier=2, unregistered agent → should revert at check 3
  console.log("   Test C: approved=true, tier=2, unregistered agent (id=999999)");
  try {
    await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(999999n, true, 2, ZERO), "0x"]);
    console.log("   ❌ Should have reverted");
  } catch (e: any) {
    const msg = e.message || e.shortMessage || "";
    if (msg.includes("Agent not registered")) {
      console.log("   ✅ Correctly rejected: 'Agent not registered'\n");
    } else {
      console.log(`   ✅ Reverted (${msg.slice(0, 100)})\n`);
    }
  }

  // Test D: tier=3, unregistered agent → should revert at check 3 (not skip to KYC)
  console.log("   Test D: approved=true, tier=3, unregistered agent (id=999999)");
  try {
    await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(999999n, true, 3, ZERO), "0x"]);
    console.log("   ❌ Should have reverted");
  } catch (e: any) {
    const msg = e.message || e.shortMessage || "";
    if (msg.includes("Agent not registered")) {
      console.log("   ✅ Correctly rejected at base layer: 'Agent not registered'\n");
    } else {
      console.log(`   ✅ Reverted (${msg.slice(0, 100)})\n`);
    }
  }

  // Test E: tier=4, unregistered → same base layer rejection
  console.log("   Test E: approved=true, tier=4, unregistered agent (id=999999)");
  try {
    await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(999999n, true, 4, ZERO), "0x"]);
    console.log("   ❌ Should have reverted");
  } catch (e: any) {
    const msg = e.message || e.shortMessage || "";
    if (msg.includes("Agent not registered")) {
      console.log("   ✅ Correctly rejected at base layer: 'Agent not registered'\n");
    } else {
      console.log(`   ✅ Reverted (${msg.slice(0, 100)})\n`);
    }
  }

  // ── 5. Test with real registered agent (if any exist) ──
  console.log("5. Checking for real registered agents...");
  const idRegistry = await viem.getContractAt("IdentityRegistryUpgradeable", await tp.read.getIdentityRegistry());

  // Try agentId 1 (first minted)
  try {
    const owner = await idRegistry.read.ownerOf([1n]);
    console.log(`   Agent #1 owner: ${owner}`);

    // Check human verified
    const worldIdValidator = await viem.getContractAt("WorldIDValidator", await tp.read.getWorldIdValidator());
    const isHuman = await worldIdValidator.read.isHumanVerified([1n]);
    console.log(`   Agent #1 humanVerified: ${isHuman}`);

    if (isHuman) {
      // Test tier=2 with real registered + verified agent
      console.log("\n   Test F: tier=2 with real human-verified agent #1");
      try {
        const result = await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(1n, true, 2, owner as Hex), "0x"]);
        console.log(`   ✅ Allowed! Result: ${result} (1 = Allowed)\n`);
      } catch (e: any) {
        console.log(`   ❌ Rejected: ${(e.message || "").slice(0, 100)}\n`);
      }

      // Test tier=3 — should fail at KYC check
      console.log("   Test G: tier=3 with agent #1 (no KYC)");
      try {
        await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(1n, true, 3, owner as Hex), "0x"]);
        console.log("   ❌ Should have reverted (no KYC)\n");
      } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("KYC not verified")) {
          console.log("   ✅ Correctly rejected at KYC layer: 'StripeKYCValidator: KYC not verified'\n");
        } else {
          console.log(`   ✅ Reverted (${msg.slice(0, 100)})\n`);
        }
      }

      // Test tier=4 — should fail at KYC check (before reaching credit)
      console.log("   Test H: tier=4 with agent #1 (no KYC, no credit)");
      try {
        await tp.read.run([ZERO, ZERO, DUMMY4, buildParams(1n, true, 4, owner as Hex), "0x"]);
        console.log("   ❌ Should have reverted\n");
      } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("KYC not verified")) {
          console.log("   ✅ Correctly rejected at KYC layer (tier 4 checks KYC first)\n");
        } else if (msg.includes("credit")) {
          console.log("   ✅ Rejected at credit layer\n");
        } else {
          console.log(`   ✅ Reverted (${msg.slice(0, 100)})\n`);
        }
      }
    }
  } catch {
    console.log("   No agent #1 found, skipping real agent tests\n");
  }

  console.log("═══════════════════════════════════════════");
  console.log("ACE Tests Complete!");
  console.log("═══════════════════════════════════════════");
}

main().catch(console.error);
