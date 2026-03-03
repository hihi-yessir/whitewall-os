import hre from "hardhat";
import { keccak256, toHex, encodeFunctionData, type Hex } from "viem";
import dotenv from "dotenv";

dotenv.config();

// ── New deployment (2026-02-24) ──
const POLICY_ENGINE = "0x12816c0c79981726627a550b73e9627b81be95be" as Hex;
const EXTRACTOR = "0x27b22cdbbf3b03dde7597ec8ff8640b74aeea58b" as Hex;
const TIERED_POLICY = "0x63b4d2e051180c3c0313eb71a9bdda8554432e23" as Hex;
const CONSUMER = "0xb5845901c590f06ffa480c31b96aca7eff4dfb3e" as Hex;

const ON_REPORT_SELECTOR = "0x805f2132" as Hex;

const BASESCAN_API_KEY = "7E6Y58996D4USJQTKZ5VG8HP95KQPDYP6G";
const VERIFY_API = "https://api.etherscan.io/v2/api?chainid=84532";

async function verifyContract(address: string, standardInput: object, contractName: string) {
  const payload = new URLSearchParams({
    apikey: BASESCAN_API_KEY,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: address,
    sourceCode: JSON.stringify(standardInput),
    codeformat: "solidity-standard-json-input",
    contractname: contractName,
    compilerversion: "v0.8.26+commit.8a97fa7a",
    constructorArguements: "",
  });

  const res = await fetch(VERIFY_API, { method: "POST", body: payload });
  const json = await res.json() as { status: string; result: string };

  if (json.status !== "1") {
    console.log(`  ⚠ Submit failed: ${json.result}`);
    return;
  }

  console.log(`  📤 Submitted (GUID: ${json.result})`);
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const checkRes = await fetch(`${VERIFY_API}&module=contract&action=checkverifystatus&guid=${json.result}&apikey=${BASESCAN_API_KEY}`);
    const checkJson = await checkRes.json() as { status: string; result: string };
    if (checkJson.result === "Pending in queue") continue;
    if (checkJson.status === "1") { console.log(`  ✅ Verified!`); return; }
    console.log(`  ❌ ${checkJson.result}`);
    return;
  }
  console.log(`  ⏳ Still pending`);
}

async function main() {
  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  console.log("═══════════════════════════════════════════");
  console.log("Wiring PolicyEngine + Verification");
  console.log("═══════════════════════════════════════════\n");

  const pe = await viem.getContractAt("PolicyEngine", POLICY_ENGINE);

  // Step 1: Set extractor
  console.log("1. Setting extractor for onReport...");
  try {
    await pe.write.setExtractor([ON_REPORT_SELECTOR, EXTRACTOR]);
    await sleep(5000);
    console.log("   ✅ Extractor set");
  } catch (e: any) {
    console.log(`   ${e.message?.slice(0, 80)}`);
  }

  // Step 2: Add TieredPolicy
  console.log("\n2. Adding TieredPolicy to consumer onReport...");
  const policyParamNames: Hex[] = [
    keccak256(toHex("agentId")),
    keccak256(toHex("approved")),
    keccak256(toHex("tier")),
    keccak256(toHex("accountableHuman")),
  ];
  try {
    await pe.write.addPolicy([CONSUMER, ON_REPORT_SELECTOR, TIERED_POLICY, policyParamNames]);
    await sleep(5000);
    console.log("   ✅ TieredPolicy added");
  } catch (e: any) {
    console.log(`   ${e.message?.slice(0, 120)}`);
  }

  // Step 3: Verify wiring
  console.log("\n3. Verifying wiring...");
  const ext = await pe.read.getExtractor([ON_REPORT_SELECTOR]);
  console.log(`   Extractor: ${ext} ${ext.toLowerCase() === EXTRACTOR.toLowerCase() ? "✅" : "❌"}`);

  const policies = await pe.read.getPolicies([CONSUMER, ON_REPORT_SELECTOR]);
  console.log(`   Policies: ${JSON.stringify(policies)}`);
  console.log(`   TieredPolicy: ${policies.length > 0 && policies[0].toLowerCase() === TIERED_POLICY.toLowerCase() ? "✅" : "❌"}`);

  // Step 4: Verify all contracts on Basescan
  console.log("\n4. Verifying contracts on Basescan...\n");

  const fs = await import("fs");
  const path = await import("path");
  const buildInfoDir = path.join(import.meta.dirname!, "..", "artifacts", "build-info");
  const biFiles = fs.readdirSync(buildInfoDir).filter((f: string) => f.endsWith(".json") && !f.includes(".output."));

  let standardInput: object | null = null;
  for (const biFile of biFiles) {
    const bi = JSON.parse(fs.readFileSync(path.join(buildInfoDir, biFile), "utf-8"));
    const sources = Object.keys(bi.input?.sources ?? {});
    if (sources.some((s: string) => s.includes("TieredPolicy"))) {
      standardInput = bi.input;
      break;
    }
  }

  if (!standardInput) {
    console.log("  ⚠ Could not find build-info — skipping verification");
    return;
  }

  const deployments = [
    { name: "PolicyEngine", impl: "0xf1e187ac100e6b2d1daf896d36c7f518e04a9547", contractPath: "project/contracts/ace/vendor/core/PolicyEngine.sol:PolicyEngine" },
    { name: "WhitewallExtractor", impl: EXTRACTOR, contractPath: "project/contracts/ace/WhitewallExtractor.sol:WhitewallExtractor" },
    { name: "StripeKYCValidator", impl: "0xf6afce65d1414a3d2db10d55ec3057eaa42b0262", contractPath: "project/contracts/StripeKYCValidator.sol:StripeKYCValidator" },
    { name: "PlaidCreditValidator", impl: "0xa6549e31519c65282f0aadd753d4dd452f634f97", contractPath: "project/contracts/PlaidCreditValidator.sol:PlaidCreditValidator" },
    { name: "TieredPolicy", impl: "0xf17349229930ce0cd34c60cd9364442aaabc89c9", contractPath: "project/contracts/ace/TieredPolicy.sol:TieredPolicy" },
    { name: "WhitewallConsumer", impl: "0x1a1bf7daade6c1bd72dcdc369b1df843255b663b", contractPath: "project/contracts/ace/WhitewallConsumer.sol:WhitewallConsumer" },
  ];

  for (const dep of deployments) {
    console.log(`  Verifying ${dep.name} (${dep.impl})...`);
    await verifyContract(dep.impl, standardInput, dep.contractPath);
    await sleep(2000);
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("✅ Wiring + Verification Complete!");
  console.log("═══════════════════════════════════════════");
}

main().catch(console.error);
