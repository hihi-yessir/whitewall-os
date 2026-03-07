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
 * Full fresh redeployment of ALL Whitewall OS contracts
 * EXCEPT IdentityRegistry + ValidationRegistry (ERC-8004 singletons — stay as-is).
 *
 * Deploys (in order):
 *   1. WorldIDValidator (UUPS proxy) + initializeV2
 *   2. PolicyEngine (UUPS proxy)
 *   3. WhitewallExtractor (plain)
 *   4. StripeKYCValidator (UUPS proxy)
 *   5. PlaidCreditValidator (UUPS proxy)
 *   6. TieredPolicy (UUPS proxy)
 *   7. WhitewallConsumer (UUPS proxy)
 *
 * Then wires:
 *   8. PolicyEngine: attach + setExtractor + addPolicy
 *   9. PlaidCreditValidator: setSgxDcapVerifier + setExpectedMrEnclave
 *
 * Then verifies:
 *   10. All owners, configs, wiring
 */

// ── ERC-8004 Singletons (NOT redeployed) ──
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Hex;
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Hex;

// ── External contracts (NOT redeployed) ──
const CRE_FORWARDER = "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5" as Hex;
const WORLD_ID_ROUTER = "0x42FF98C4E85212a5D31358ACbFe76a621b50fC02" as Hex;
const AUTOMATA_DCAP_VERIFIER = "0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F" as Hex;
const EXPECTED_MRENCLAVE = "0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c" as Hex;

// ── WorldID config ──
const WORLDID_APP_ID = process.env.WORLDID_APP_ID ?? "app_staging_dae27f9b14a30e0e0917797aceac795a";
const WORLDID_ACTION_ID = process.env.WORLDID_ACTION_ID ?? "verify-owner";
const WORLDID_ACTION_PREFIX = "verify-owner-";

// ── Policy config ──
const MIN_CREDIT_SCORE = 50;
const ON_REPORT_SELECTOR = "0x805f2132" as Hex;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address;

  const balance = await publicClient.getBalance({ address: deployerAddress });

  console.log("\n" + "═".repeat(60));
  console.log("Whitewall OS — Full Fresh Redeployment");
  console.log("═".repeat(60));
  console.log(`Deployer:              ${deployerAddress}`);
  console.log(`Balance:               ${(Number(balance) / 1e18).toFixed(4)} ETH`);
  console.log(`IdentityRegistry:      ${IDENTITY_REGISTRY} (kept)`);
  console.log(`ValidationRegistry:    ${VALIDATION_REGISTRY} (kept)`);
  console.log(`CRE Forwarder:         ${CRE_FORWARDER}`);
  console.log(`World ID Router:       ${WORLD_ID_ROUTER}`);
  console.log(`Automata DCAP:         ${AUTOMATA_DCAP_VERIFIER}`);
  console.log("═".repeat(60) + "\n");

  if (balance < 10000000000000000n) { // 0.01 ETH
    throw new Error("Insufficient balance. Need at least 0.01 ETH for deployment.");
  }

  // Track all deployments
  const deployed: Record<string, { proxy: Hex; impl: Hex }> = {};

  // ── Helper: deploy UUPS proxy ──
  async function deployProxy(name: string, initData: Hex): Promise<{ proxy: Hex; impl: Hex }> {
    const impl = await viem.deployContract(name);
    console.log(`  impl: ${impl.address}`);
    await sleep(5000);
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    console.log(`  proxy: ${proxy.address}`);
    await sleep(5000);
    const result = { proxy: proxy.address as Hex, impl: impl.address as Hex };
    deployed[name] = result;
    return result;
  }

  // ════════════════════════════════════════════
  // 1. WorldIDValidator
  // ════════════════════════════════════════════
  console.log("1. WorldIDValidator...");
  const worldIdInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [
        { name: "worldIdRouter_", type: "address" },
        { name: "identityRegistry_", type: "address" },
        { name: "appId_", type: "string" },
        { name: "actionId_", type: "string" },
      ],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [WORLD_ID_ROUTER, IDENTITY_REGISTRY, WORLDID_APP_ID, WORLDID_ACTION_ID],
  });
  const worldId = await deployProxy("WorldIDValidator", worldIdInitData);

  // Call initializeV2 for per-agent nullifier support
  console.log("  Calling initializeV2...");
  const worldIdContract = await viem.getContractAt("WorldIDValidator", worldId.proxy);
  const v2Tx = await worldIdContract.write.initializeV2([WORLDID_APP_ID, WORLDID_ACTION_PREFIX]);
  console.log(`  initializeV2 tx: ${v2Tx}`);
  await sleep(5000);
  const worldIdVersion = await worldIdContract.read.getVersion();
  console.log(`  version: ${worldIdVersion}`);

  // ════════════════════════════════════════════
  // 2. PolicyEngine
  // ════════════════════════════════════════════
  console.log("\n2. PolicyEngine...");
  const policyEngineInitData = encodeFunctionData({
    abi: [{
      name: "initialize", type: "function",
      inputs: [
        { name: "defaultAllow", type: "bool" },
        { name: "initialOwner", type: "address" },
      ],
      outputs: [], stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: [false, deployerAddress],
  });
  const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData);

  // ════════════════════════════════════════════
  // 3. WhitewallExtractor (no proxy)
  // ════════════════════════════════════════════
  console.log("\n3. WhitewallExtractor...");
  const extractor = await viem.deployContract("WhitewallExtractor");
  console.log(`  address: ${extractor.address}`);
  deployed["WhitewallExtractor"] = { proxy: extractor.address as Hex, impl: extractor.address as Hex };
  await sleep(5000);

  // ════════════════════════════════════════════
  // 4. StripeKYCValidator
  // ════════════════════════════════════════════
  console.log("\n4. StripeKYCValidator...");
  const kycInitData = encodeFunctionData({
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
    args: [CRE_FORWARDER, IDENTITY_REGISTRY, VALIDATION_REGISTRY],
  });
  const kycValidator = await deployProxy("StripeKYCValidator", kycInitData);

  // ════════════════════════════════════════════
  // 5. PlaidCreditValidator
  // ════════════════════════════════════════════
  console.log("\n5. PlaidCreditValidator...");
  const creditInitData = encodeFunctionData({
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
    args: [CRE_FORWARDER, IDENTITY_REGISTRY, VALIDATION_REGISTRY],
  });
  const creditValidator = await deployProxy("PlaidCreditValidator", creditInitData);

  // ════════════════════════════════════════════
  // 6. TieredPolicy
  // ════════════════════════════════════════════
  console.log("\n6. TieredPolicy...");
  const tieredPolicyConfigParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }],
    [IDENTITY_REGISTRY, worldId.proxy, kycValidator.proxy, creditValidator.proxy, MIN_CREDIT_SCORE]
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
  const tieredPolicy = await deployProxy("TieredPolicy", tieredPolicyInitData);

  // ════════════════════════════════════════════
  // 7. WhitewallConsumer
  // ════════════════════════════════════════════
  console.log("\n7. WhitewallConsumer...");
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
    args: [deployerAddress, policyEngine.proxy, CRE_FORWARDER],
  });
  const consumer = await deployProxy("WhitewallConsumer", consumerInitData);

  // ════════════════════════════════════════════
  // 8. Wire PolicyEngine
  // ════════════════════════════════════════════
  // NOTE: attach() is NOT needed here — WhitewallConsumer's initialize() calls
  // PolicyProtected.__PolicyProtected_init → _attachPolicyEngine → policyEngine.attach()
  // automatically. Calling attach() again would revert with TargetAlreadyAttached.
  console.log("\n8. Wiring PolicyEngine...");
  const pe = await viem.getContractAt("PolicyEngine", policyEngine.proxy);

  console.log("  8a. setExtractor(onReport, extractor)...");
  await pe.write.setExtractor([ON_REPORT_SELECTOR, extractor.address as Hex]);
  await sleep(5000);

  console.log("  8b. addPolicy(consumer, onReport, tieredPolicy, params)...");
  const policyParamNames: Hex[] = [
    keccak256(toHex("agentId")),
    keccak256(toHex("approved")),
    keccak256(toHex("tier")),
    keccak256(toHex("accountableHuman")),
  ];
  await pe.write.addPolicy([consumer.proxy, ON_REPORT_SELECTOR, tieredPolicy.proxy, policyParamNames]);
  await sleep(5000);

  // ════════════════════════════════════════════
  // 9. Configure SGX on PlaidCreditValidator
  // ════════════════════════════════════════════
  console.log("\n9. Configuring SGX on PlaidCreditValidator...");
  const creditContract = await viem.getContractAt("PlaidCreditValidator", creditValidator.proxy);

  console.log("  9a. setSgxDcapVerifier...");
  await creditContract.write.setSgxDcapVerifier([AUTOMATA_DCAP_VERIFIER]);
  await sleep(5000);

  console.log("  9b. setExpectedMrEnclave...");
  await creditContract.write.setExpectedMrEnclave([EXPECTED_MRENCLAVE]);
  await sleep(5000);

  // ════════════════════════════════════════════
  // 10. Verify EVERYTHING
  // ════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("VERIFICATION");
  console.log("═".repeat(60));

  let allGood = true;
  function check(label: string, actual: string, expected: string) {
    const ok = actual.toLowerCase() === expected.toLowerCase();
    console.log(`  ${ok ? "✅" : "❌"} ${label}: ${actual}`);
    if (!ok) {
      console.log(`     expected: ${expected}`);
      allGood = false;
    }
  }

  // 10a. Owners
  console.log("\n── Owners ──");
  const worldIdOwner = await worldIdContract.read.owner();
  check("WorldIDValidator owner", worldIdOwner, deployerAddress);

  const peOwner = await pe.read.owner();
  check("PolicyEngine owner", peOwner, deployerAddress);

  const kycContract = await viem.getContractAt("StripeKYCValidator", kycValidator.proxy);
  const kycOwner = await kycContract.read.owner();
  check("StripeKYCValidator owner", kycOwner, deployerAddress);

  const creditOwner = await creditContract.read.owner();
  check("PlaidCreditValidator owner", creditOwner, deployerAddress);

  const tieredContract = await viem.getContractAt("TieredPolicy", tieredPolicy.proxy);
  const tieredOwner = await tieredContract.read.owner();
  check("TieredPolicy owner", tieredOwner, deployerAddress);

  const consumerContract = await viem.getContractAt("WhitewallConsumer", consumer.proxy);
  const consumerOwner = await consumerContract.read.owner();
  check("WhitewallConsumer owner", consumerOwner, deployerAddress);

  // 10b. Forwarder settings
  console.log("\n── Forwarder Settings ──");
  const [kycFw] = await kycContract.read.getConfig();
  check("KYCValidator forwarder", kycFw, CRE_FORWARDER);

  const [creditFw] = await creditContract.read.getConfig();
  check("CreditValidator forwarder", creditFw, CRE_FORWARDER);

  const consumerFw = await consumerContract.read.getForwarder();
  check("Consumer forwarder", consumerFw, CRE_FORWARDER);

  // 10c. Registry references
  console.log("\n── Registry References ──");
  const [, kycIr, kycVr] = await kycContract.read.getConfig();
  check("KYCValidator identityRegistry", kycIr, IDENTITY_REGISTRY);
  check("KYCValidator validationRegistry", kycVr, VALIDATION_REGISTRY);

  const [, creditIr, creditVr] = await creditContract.read.getConfig();
  check("CreditValidator identityRegistry", creditIr, IDENTITY_REGISTRY);
  check("CreditValidator validationRegistry", creditVr, VALIDATION_REGISTRY);

  // 10d. SGX config
  console.log("\n── SGX Config ──");
  const [sgxVerifier, mrEnclave] = await creditContract.read.getSgxConfig();
  check("DCAP Verifier", sgxVerifier, AUTOMATA_DCAP_VERIFIER);
  check("MRENCLAVE", mrEnclave, EXPECTED_MRENCLAVE);

  // 10e. CreditValidator version
  const creditVersion = await creditContract.read.getVersion();
  check("CreditValidator version", creditVersion, "2.0.0");

  // 10f. TieredPolicy references
  console.log("\n── TieredPolicy Config ──");
  const tpIr = await tieredContract.read.getIdentityRegistry();
  check("TieredPolicy identityRegistry", tpIr, IDENTITY_REGISTRY);

  const tpWid = await tieredContract.read.getWorldIdValidator();
  check("TieredPolicy worldIdValidator", tpWid, worldId.proxy);

  const tpKyc = await tieredContract.read.getStripeKYCValidator();
  check("TieredPolicy kycValidator", tpKyc, kycValidator.proxy);

  const tpCredit = await tieredContract.read.getPlaidCreditValidator();
  check("TieredPolicy creditValidator", tpCredit, creditValidator.proxy);

  const tpMinScore = await tieredContract.read.getMinCreditScore();
  check("TieredPolicy minCreditScore", tpMinScore.toString(), MIN_CREDIT_SCORE.toString());

  // 10g. PolicyEngine wiring
  console.log("\n── PolicyEngine Wiring ──");
  const ext = await pe.read.getExtractor([ON_REPORT_SELECTOR]);
  check("Extractor for onReport", ext, extractor.address);

  const policies = await pe.read.getPolicies([consumer.proxy, ON_REPORT_SELECTOR]);
  check("Policy for consumer.onReport", policies[0] || "NONE", tieredPolicy.proxy);

  // 10h. WorldIDValidator config
  console.log("\n── WorldIDValidator Config ──");
  check("WorldIDValidator version", worldIdVersion, "1.2.0");
  const worldIdConfig = await worldIdContract.read.getConfig();
  check("WorldIDValidator worldIdRouter", worldIdConfig[0], WORLD_ID_ROUTER);
  check("WorldIDValidator identityRegistry", worldIdConfig[1], IDENTITY_REGISTRY);

  // ════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log(allGood ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED");
  console.log("═".repeat(60));

  console.log(`\n── Deployed Addresses ──`);
  console.log(`WorldIDValidator:      ${worldId.proxy}  (impl: ${worldId.impl})`);
  console.log(`PolicyEngine:          ${policyEngine.proxy}  (impl: ${policyEngine.impl})`);
  console.log(`WhitewallExtractor:    ${extractor.address}`);
  console.log(`StripeKYCValidator:    ${kycValidator.proxy}  (impl: ${kycValidator.impl})`);
  console.log(`PlaidCreditValidator:  ${creditValidator.proxy}  (impl: ${creditValidator.impl})`);
  console.log(`TieredPolicy:          ${tieredPolicy.proxy}  (impl: ${tieredPolicy.impl})`);
  console.log(`WhitewallConsumer:     ${consumer.proxy}  (impl: ${consumer.impl})`);

  console.log(`\n── Kept (ERC-8004 Singletons) ──`);
  console.log(`IdentityRegistry:      ${IDENTITY_REGISTRY}`);
  console.log(`ValidationRegistry:    ${VALIDATION_REGISTRY}`);

  console.log(`\n── External ──`);
  console.log(`CRE Forwarder:         ${CRE_FORWARDER}`);
  console.log(`Automata DCAP:         ${AUTOMATA_DCAP_VERIFIER}`);
  console.log(`World ID Router:       ${WORLD_ID_ROUTER}`);

  // ════════════════════════════════════════════
  // Files that need address updates
  // ════════════════════════════════════════════
  console.log(`\n── FILES TO UPDATE ──`);
  console.log(`
SDK:
  sdk/src/addresses.ts
  sdk-go/addresses.go

CRE Workflows:
  workflows/access-workflow/config.json
  workflows/kyc-workflow/config.json
  workflows/credit-workflow/config.json

Environment:
  .env → WORLD_ID_VALIDATOR_ADDRESS

Scripts (hardcoded addresses):
  scripts/deploy-all.ts
  scripts/wire-fresh.ts
  scripts/test-ace.ts
  scripts/fire-validation-request.ts
  scripts/upgrade-credit-validator-v2.ts
  scripts/set-forwarder.ts
  scripts/check-forwarder.ts
  scripts/worldID/check-approval.ts
  scripts/worldID/check-human-verified.ts
  scripts/worldID/get-config.ts

Docs:
  DEPLOYMENT.md
  DEPLOYMENT_KR.md
  docs/sgx-tee-credit-validator-guide.md
  docs/sgx-tee-credit-validator-guide_KR.md

Frontend (whitewall repo):
  docs/bonding-architecture.md
  X402_FLOW.md
`);

  // Output for easy copy-paste into SDK
  console.log(`── SDK addresses.ts ──`);
  console.log(`{`);
  console.log(`  policyEngine: "${policyEngine.proxy}",`);
  console.log(`  tieredPolicy: "${tieredPolicy.proxy}",`);
  console.log(`  whitewallConsumer: "${consumer.proxy}",`);
  console.log(`  stripeKYCValidator: "${kycValidator.proxy}",`);
  console.log(`  plaidCreditValidator: "${creditValidator.proxy}",`);
  console.log(`}`);

  console.log(`\n── CRE workflow config addresses ──`);
  console.log(`  whitewallConsumerAddress: "${consumer.proxy}"`);
  console.log(`  worldIdValidatorAddress: "${worldId.proxy}"`);
  console.log(`  stripeKYCValidatorAddress: "${kycValidator.proxy}"`);
  console.log(`  plaidCreditValidatorAddress: "${creditValidator.proxy}"`);

  console.log("\n" + "═".repeat(60));
  console.log("DONE — Update the files above, then redeploy CRE workflows.");
  console.log("═".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
