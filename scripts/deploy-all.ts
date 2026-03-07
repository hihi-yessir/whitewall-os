import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import dotenv from "dotenv";

dotenv.config();

/**
 * Deploy full Whitewall OS stack (ACE + Validators):
 *   1. PolicyEngine (proxy)
 *   2. WhitewallExtractor (no proxy — stateless)
 *   3. StripeKYCValidator (proxy)
 *   4. PlaidCreditValidator (proxy)
 *   5. TieredPolicy (proxy) — unified policy composing all tier checks
 *   6. WhitewallConsumer (proxy)
 *   7. Wire: setExtractor + addPolicy + attachTarget
 *
 * Existing (NOT redeployed):
 *   - IdentityRegistry
 *   - ValidationRegistry
 *   - WorldIDValidator
 */

// ── Existing deployed addresses ──
const IDENTITY_REGISTRY = (process.env.IDENTITY_REGISTRY_ADDRESS ?? "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Hex;
const VALIDATION_REGISTRY = (process.env.VALIDATION_REGISTRY_ADDRESS ?? "0x8004Cb1BF31DAf7788923b405b754f57acEB4272") as Hex;
const WORLD_ID_VALIDATOR = (process.env.WORLD_ID_VALIDATOR_ADDRESS ?? "0xcadd809084debc999ce93384806da8ea90318e11") as Hex;

// CRE Forwarder — placeholder until CRE workflow deploys its own
const FORWARDER = (process.env.FORWARDER_ADDRESS ?? "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5") as Hex;

// TieredPolicy config
const MIN_CREDIT_SCORE = 50;

// onReport selector: bytes4(keccak256("onReport(bytes,bytes)"))
const ON_REPORT_SELECTOR = "0x805f2132" as Hex;

// Basescan verification
const BASESCAN_API_KEY = "7E6Y58996D4USJQTKZ5VG8HP95KQPDYP6G";
const VERIFY_API = "https://api.etherscan.io/v2/api?chainid=84532";

async function verifyContract(address: string, standardInput: object, contractName: string, constructorArgs = "") {
  const payload = new URLSearchParams({
    apikey: BASESCAN_API_KEY,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: address,
    sourceCode: JSON.stringify(standardInput),
    codeformat: "solidity-standard-json-input",
    contractname: contractName,
    compilerversion: "v0.8.26+commit.8a97fa7a",
    constructorArguements: constructorArgs,
  });

  const res = await fetch(VERIFY_API, { method: "POST", body: payload });
  const json = await res.json() as { status: string; result: string };

  if (json.status !== "1") {
    console.log(`  ⚠ Verification submit failed: ${json.result}`);
    return null;
  }

  console.log(`  📤 Submitted (GUID: ${json.result})`);

  // Poll for result
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const checkRes = await fetch(`${VERIFY_API}&module=contract&action=checkverifystatus&guid=${json.result}&apikey=${BASESCAN_API_KEY}`);
    const checkJson = await checkRes.json() as { status: string; result: string };
    if (checkJson.result === "Pending in queue") continue;
    if (checkJson.status === "1") {
      console.log(`  ✅ Verified!`);
      return true;
    }
    console.log(`  ❌ ${checkJson.result}`);
    return false;
  }
  console.log(`  ⏳ Still pending after 50s`);
  return null;
}

async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address;

  console.log(`\n${"═".repeat(60)}`);
  console.log("Whitewall OS — Full Stack Deployment");
  console.log(`${"═".repeat(60)}`);
  console.log(`Deployer:             ${deployerAddress}`);
  console.log(`Identity Registry:    ${IDENTITY_REGISTRY}`);
  console.log(`Validation Registry:  ${VALIDATION_REGISTRY}`);
  console.log(`World ID Validator:   ${WORLD_ID_VALIDATOR}`);
  console.log(`Forwarder:            ${FORWARDER}`);
  console.log(`Min Credit Score:     ${MIN_CREDIT_SCORE}\n`);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Track all deployments for verification
  const deployments: { name: string; impl: string; proxy?: string; contractPath: string }[] = [];

  // ── Helper: deploy UUPS proxy ──
  async function deployProxy(artifactName: string, initData: Hex, contractPath: string) {
    const impl = await viem.deployContract(artifactName);
    console.log(`  impl: ${impl.address}`);
    await sleep(5000);
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    console.log(`  proxy: ${proxy.address}`);
    await sleep(5000);
    deployments.push({ name: artifactName, impl: impl.address, proxy: proxy.address, contractPath });
    return { proxy: proxy.address as Hex, impl: impl.address as Hex };
  }

  // ════════════════════════════════════════════
  // 1. PolicyEngine
  // ════════════════════════════════════════════
  console.log("1. PolicyEngine...");
  const policyEngineInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [{ name: "defaultAllow", type: "bool" }, { name: "initialOwner", type: "address" }],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [false, deployerAddress],
  });
  const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData, "project/contracts/ace/vendor/core/PolicyEngine.sol:PolicyEngine");

  // ════════════════════════════════════════════
  // 2. WhitewallExtractor (no proxy — stateless)
  // ════════════════════════════════════════════
  console.log("\n2. WhitewallExtractor...");
  const extractor = await viem.deployContract("WhitewallExtractor");
  console.log(`  address: ${extractor.address}`);
  deployments.push({ name: "WhitewallExtractor", impl: extractor.address, contractPath: "project/contracts/ace/WhitewallExtractor.sol:WhitewallExtractor" });
  await sleep(5000);

  // ════════════════════════════════════════════
  // 3. StripeKYCValidator
  // ════════════════════════════════════════════
  console.log("\n3. StripeKYCValidator...");
  const kycValidatorInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [
        { name: "forwarder_", type: "address" },
        { name: "identityRegistry_", type: "address" },
        { name: "validationRegistry_", type: "address" },
      ],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [FORWARDER, IDENTITY_REGISTRY, VALIDATION_REGISTRY],
  });
  const kycValidator = await deployProxy("StripeKYCValidator", kycValidatorInitData, "project/contracts/StripeKYCValidator.sol:StripeKYCValidator");

  // ════════════════════════════════════════════
  // 4. PlaidCreditValidator
  // ════════════════════════════════════════════
  console.log("\n4. PlaidCreditValidator...");
  const creditValidatorInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [
        { name: "forwarder_", type: "address" },
        { name: "identityRegistry_", type: "address" },
        { name: "validationRegistry_", type: "address" },
      ],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [FORWARDER, IDENTITY_REGISTRY, VALIDATION_REGISTRY],
  });
  const creditValidator = await deployProxy("PlaidCreditValidator", creditValidatorInitData, "project/contracts/PlaidCreditValidator.sol:PlaidCreditValidator");

  // ════════════════════════════════════════════
  // 5. TieredPolicy
  // ════════════════════════════════════════════
  console.log("\n5. TieredPolicy...");
  const tieredPolicyConfigParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }],
    [IDENTITY_REGISTRY, WORLD_ID_VALIDATOR, kycValidator.proxy, creditValidator.proxy, MIN_CREDIT_SCORE]
  );
  const tieredPolicyInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [
        { name: "policyEngine", type: "address" },
        { name: "initialOwner", type: "address" },
        { name: "configParams", type: "bytes" },
      ],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [policyEngine.proxy, deployerAddress, tieredPolicyConfigParams],
  });
  const tieredPolicy = await deployProxy("TieredPolicy", tieredPolicyInitData, "project/contracts/ace/TieredPolicy.sol:TieredPolicy");

  // ════════════════════════════════════════════
  // 6. WhitewallConsumer
  // ════════════════════════════════════════════
  console.log("\n6. WhitewallConsumer...");
  const consumerInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [
        { name: "initialOwner", type: "address" },
        { name: "policyEngine", type: "address" },
        { name: "forwarder", type: "address" },
      ],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [deployerAddress, policyEngine.proxy, FORWARDER],
  });
  const consumer = await deployProxy("WhitewallConsumer", consumerInitData, "project/contracts/ace/WhitewallConsumer.sol:WhitewallConsumer");

  // ════════════════════════════════════════════
  // 7. Wire PolicyEngine
  // ════════════════════════════════════════════
  console.log("\n7. Wiring PolicyEngine...");
  const policyEngineContract = await viem.getContractAt("PolicyEngine", policyEngine.proxy);

  // 7a. Attach consumer as target
  console.log("  Attaching consumer as target...");
  await policyEngineContract.write.attach([consumer.proxy]);
  await sleep(5000);

  // 7b. Set extractor for onReport selector
  console.log("  Setting extractor for onReport...");
  await policyEngineContract.write.setExtractor([ON_REPORT_SELECTOR, extractor.address]);
  await sleep(5000);

  // 7c. Add TieredPolicy for consumer's onReport
  const policyParamNames: Hex[] = [
    keccak256(toHex("agentId")),
    keccak256(toHex("approved")),
    keccak256(toHex("tier")),
    keccak256(toHex("accountableHuman")),
  ];
  console.log("  Adding TieredPolicy to consumer's onReport...");
  await policyEngineContract.write.addPolicy([
    consumer.proxy, ON_REPORT_SELECTOR, tieredPolicy.proxy, policyParamNames,
  ]);
  await sleep(3000);

  // ════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════
  console.log(`\n${"═".repeat(60)}`);
  console.log("✅ Full Stack Deployed!");
  console.log(`${"═".repeat(60)}`);
  console.log(`PolicyEngine:          ${policyEngine.proxy}  (impl: ${policyEngine.impl})`);
  console.log(`WhitewallExtractor:    ${extractor.address}`);
  console.log(`StripeKYCValidator:    ${kycValidator.proxy}  (impl: ${kycValidator.impl})`);
  console.log(`PlaidCreditValidator:  ${creditValidator.proxy}  (impl: ${creditValidator.impl})`);
  console.log(`TieredPolicy:          ${tieredPolicy.proxy}  (impl: ${tieredPolicy.impl})`);
  console.log(`WhitewallConsumer:     ${consumer.proxy}  (impl: ${consumer.impl})`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Forwarder:             ${FORWARDER}`);
  console.log(`onReport selector:     ${ON_REPORT_SELECTOR}`);
  console.log(`${"═".repeat(60)}\n`);

  // ════════════════════════════════════════════
  // 8. Verify on Basescan
  // ════════════════════════════════════════════
  console.log("8. Verifying contracts on Basescan...\n");

  // Load build-info for standard JSON input
  const fs = await import("fs");
  const path = await import("path");
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  const biFiles = fs.readdirSync(buildInfoDir).filter((f: string) => f.endsWith(".json") && !f.includes(".output."));

  // Find the build-info that contains our contracts
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
    console.log("  ⚠ Could not find build-info with TieredPolicy — skipping verification");
  } else {
    for (const dep of deployments) {
      const address = dep.impl; // verify implementations (proxy auto-resolves on Basescan)
      console.log(`  Verifying ${dep.name} (${address})...`);
      await verifyContract(address, standardInput, dep.contractPath);
      await sleep(2000);
    }
  }

  // ════════════════════════════════════════════
  // 9. Output for SDK + frontend
  // ════════════════════════════════════════════
  console.log(`\n── SDK addresses.ts update ──`);
  console.log(`{`);
  console.log(`  tieredPolicy: "${tieredPolicy.proxy}",`);
  console.log(`  whitewallConsumer: "${consumer.proxy}",`);
  console.log(`  stripeKYCValidator: "${kycValidator.proxy}",`);
  console.log(`  plaidCreditValidator: "${creditValidator.proxy}",`);
  console.log(`  policyEngine: "${policyEngine.proxy}",`);
  console.log(`}`);

  console.log(`\n── CRE Workflow targets ──`);
  console.log(`Consumer (ACCESS writeReport): ${consumer.proxy}`);
  console.log(`KYC Validator (KYC writeReport): ${kycValidator.proxy}`);
  console.log(`Credit Validator (CREDIT writeReport): ${creditValidator.proxy}`);
  console.log(`onReport selector: ${ON_REPORT_SELECTOR}`);
  console.log(`Report ABI: (uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
