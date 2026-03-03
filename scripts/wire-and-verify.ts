import hre from "hardhat";
import { keccak256, toHex, type Hex } from "viem";
import dotenv from "dotenv";

dotenv.config();

// Deployed addresses from deploy-all.ts run
const POLICY_ENGINE = "0x55a34dcc40326d515497b621588af45ef798e052" as Hex;
const EXTRACTOR = "0xa4f2b32322ebb4cad656f476c51883918f9e45e7" as Hex;
const KYC_VALIDATOR = "0x3a203a013480ab3dc9b6fe809bad44c9bfe8af61" as Hex;
const CREDIT_VALIDATOR = "0xe54beadc9756e64c8c0426ceae9d1d4d770768dd" as Hex;
const TIERED_POLICY = "0x89637c82e247b0a0ed029c1aef5132acff949b1c" as Hex;
const CONSUMER = "0x698f39ea0351973ec3d3f252aa3523a6ceb7f652" as Hex;

// Implementation addresses for verification
const IMPLS = [
  { name: "PolicyEngine", impl: "0x41e0178f49a34971ddbecc60e753b12928f6cc93", path: "project/contracts/ace/vendor/core/PolicyEngine.sol:PolicyEngine" },
  { name: "WhitewallExtractor", impl: EXTRACTOR, path: "project/contracts/ace/WhitewallExtractor.sol:WhitewallExtractor" },
  { name: "StripeKYCValidator", impl: "0x0c933ef2fca6d4299ce7905f52cdd706909140ca", path: "project/contracts/StripeKYCValidator.sol:StripeKYCValidator" },
  { name: "PlaidCreditValidator", impl: "0xfe6eefa21271ee03273c084a06e19f6f77dbc495", path: "project/contracts/PlaidCreditValidator.sol:PlaidCreditValidator" },
  { name: "TieredPolicy", impl: "0xf089cd39af7b1accd1daa024c5229cfdce17d930", path: "project/contracts/ace/TieredPolicy.sol:TieredPolicy" },
  { name: "WhitewallConsumer", impl: "0x237dd4ff0d37f3ffb3d2934af8e4abdd3a4e544e", path: "project/contracts/ace/WhitewallConsumer.sol:WhitewallConsumer" },
];

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
    console.log(`    ⚠ Submit failed: ${json.result}`);
    return;
  }

  console.log(`    📤 Submitted (GUID: ${json.result})`);

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const checkRes = await fetch(`${VERIFY_API}&module=contract&action=checkverifystatus&guid=${json.result}&apikey=${BASESCAN_API_KEY}`);
    const checkJson = await checkRes.json() as { status: string; result: string };
    if (checkJson.result === "Pending in queue") continue;
    if (checkJson.status === "1") {
      console.log(`    ✅ Verified!`);
      return;
    }
    console.log(`    ❌ ${checkJson.result}`);
    return;
  }
  console.log(`    ⏳ Still pending`);
}

async function main() {
  const { viem } = await hre.network.connect();
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ── Step 1: Wire PolicyEngine ──
  console.log("1. Wiring PolicyEngine...\n");
  const pe = await viem.getContractAt("PolicyEngine", POLICY_ENGINE);

  console.log("  Attaching consumer...");
  try {
    await pe.write.attach([CONSUMER]);
    await sleep(5000);
    console.log("  ✅ Consumer attached");
  } catch (e: any) {
    console.log(`  ⚠ ${e.shortMessage || e.message}`);
  }

  console.log("  Setting extractor...");
  try {
    await pe.write.setExtractor([ON_REPORT_SELECTOR, EXTRACTOR]);
    await sleep(5000);
    console.log("  ✅ Extractor set");
  } catch (e: any) {
    console.log(`  ⚠ ${e.shortMessage || e.message}`);
  }

  console.log("  Adding TieredPolicy...");
  const policyParamNames: Hex[] = [
    keccak256(toHex("agentId")),
    keccak256(toHex("approved")),
    keccak256(toHex("tier")),
    keccak256(toHex("accountableHuman")),
  ];
  try {
    await pe.write.addPolicy([CONSUMER, ON_REPORT_SELECTOR, TIERED_POLICY, policyParamNames]);
    await sleep(5000);
    console.log("  ✅ TieredPolicy added");
  } catch (e: any) {
    console.log(`  ⚠ ${e.shortMessage || e.message}`);
  }

  // Verify wiring
  console.log("\n  Verifying wiring...");
  const policies = await pe.read.getPolicies([CONSUMER, ON_REPORT_SELECTOR]);
  console.log(`  Policies for consumer onReport: ${JSON.stringify(policies)}`);
  const ext = await pe.read.getExtractor([ON_REPORT_SELECTOR]);
  console.log(`  Extractor: ${ext}`);

  // ── Step 2: Verify on Basescan ──
  console.log("\n2. Verifying contracts on Basescan...\n");

  const fs = await import("fs");
  const path = await import("path");
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  const biFiles = fs.readdirSync(buildInfoDir).filter((f: string) => f.endsWith(".json") && !f.includes(".output."));

  let standardInput: object | null = null;
  for (const biFile of biFiles) {
    const bi = JSON.parse(fs.readFileSync(path.join(buildInfoDir, biFile), "utf-8"));
    const sources = Object.keys(bi.input?.sources ?? {});
    if (sources.some((s: string) => s.includes("TieredPolicy"))) {
      standardInput = bi.input;
      console.log(`  Using build-info: ${biFile}`);
      break;
    }
  }

  if (!standardInput) {
    console.log("  ⚠ Could not find build-info");
    return;
  }

  for (const dep of IMPLS) {
    console.log(`\n  ${dep.name} (${dep.impl})...`);
    await verifyContract(dep.impl, standardInput, dep.path);
    await sleep(2000);
  }

  console.log("\n✅ Done!");
}

main().catch(console.error);
