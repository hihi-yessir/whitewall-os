import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from "viem";
import dotenv from "dotenv";

dotenv.config();

/**
 * Deploy KYC + Credit verification stack:
 *   1. StripeKYCValidator (proxy)
 *   2. PlaidCreditValidator (proxy)
 *   3. KYCPolicy (proxy)
 *   4. CreditPolicy (proxy)
 *
 * Required env vars:
 *   IDENTITY_REGISTRY_ADDRESS
 *   VALIDATION_REGISTRY_ADDRESS
 *   WORLD_ID_VALIDATOR_ADDRESS
 *   POLICY_ENGINE_ADDRESS
 *   FORWARDER_ADDRESS (CRE Forwarder)
 */

// Existing deployed addresses
const IDENTITY_REGISTRY = (process.env.IDENTITY_REGISTRY_ADDRESS ?? "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Hex;
const VALIDATION_REGISTRY = (process.env.VALIDATION_REGISTRY_ADDRESS ?? "0x8004Cb1BF31DAf7788923b405b754f57acEB4272") as Hex;
const WORLD_ID_VALIDATOR = (process.env.WORLD_ID_VALIDATOR_ADDRESS ?? "0xcadd809084debc999ce93384806da8ea90318e11") as Hex;
const POLICY_ENGINE = (process.env.POLICY_ENGINE_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex;
const FORWARDER = (process.env.FORWARDER_ADDRESS ?? "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5") as Hex;

// Policy config
const KYC_REQUIRED_TIER = 3;
const CREDIT_REQUIRED_TIER = 4;
const MIN_CREDIT_SCORE = 50;

async function main() {
  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address;

  console.log(`\nDeployer: ${deployerAddress}`);
  console.log(`Identity Registry: ${IDENTITY_REGISTRY}`);
  console.log(`Validation Registry: ${VALIDATION_REGISTRY}`);
  console.log(`World ID Validator: ${WORLD_ID_VALIDATOR}`);
  console.log(`Policy Engine: ${POLICY_ENGINE}`);
  console.log(`Forwarder: ${FORWARDER}\n`);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ── Helper: deploy proxy ──
  async function deployProxy(artifactName: string, initData: Hex) {
    const impl = await viem.deployContract(artifactName);
    console.log(`  ${artifactName} impl: ${impl.address}`);
    await sleep(5000);
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    console.log(`  ${artifactName} proxy: ${proxy.address}`);
    await sleep(5000);
    return { proxy: proxy.address, impl: impl.address };
  }

  // ── 1. StripeKYCValidator ──
  console.log("1. Deploying StripeKYCValidator...");
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
  const kycValidator = await deployProxy("StripeKYCValidator", kycValidatorInitData);

  // ── 2. PlaidCreditValidator ──
  console.log("\n2. Deploying PlaidCreditValidator...");
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
  const creditValidator = await deployProxy("PlaidCreditValidator", creditValidatorInitData);

  // ── 3. KYCPolicy ──
  console.log("\n3. Deploying KYCPolicy...");
  const kycPolicyConfigParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }],
    [IDENTITY_REGISTRY, WORLD_ID_VALIDATOR, kycValidator.proxy as Hex, KYC_REQUIRED_TIER]
  );
  const kycPolicyInitData = encodeFunctionData({
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
    args: [POLICY_ENGINE, deployerAddress, kycPolicyConfigParams],
  });
  const kycPolicy = await deployProxy("KYCPolicy", kycPolicyInitData);

  // ── 4. CreditPolicy ──
  console.log("\n4. Deploying CreditPolicy...");
  const creditPolicyConfigParams = encodeAbiParameters(
    [
      { type: "address" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint8" }, { type: "uint8" },
    ],
    [
      IDENTITY_REGISTRY, WORLD_ID_VALIDATOR, kycValidator.proxy as Hex,
      creditValidator.proxy as Hex, CREDIT_REQUIRED_TIER, MIN_CREDIT_SCORE,
    ]
  );
  const creditPolicyInitData = encodeFunctionData({
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
    args: [POLICY_ENGINE, deployerAddress, creditPolicyConfigParams],
  });
  const creditPolicy = await deployProxy("CreditPolicy", creditPolicyInitData);

  // ── Summary ──
  console.log("\n" + "=".repeat(60));
  console.log("KYC + Credit Stack Deployed Successfully!");
  console.log("=".repeat(60));
  console.log(`StripeKYCValidator:    ${kycValidator.proxy}`);
  console.log(`PlaidCreditValidator:  ${creditValidator.proxy}`);
  console.log(`KYCPolicy:             ${kycPolicy.proxy}`);
  console.log(`CreditPolicy:          ${creditPolicy.proxy}`);
  console.log("=".repeat(60));
  console.log(`\nForwarder (placeholder): ${FORWARDER}`);
  console.log("→ Update with real CRE Forwarder addresses after CRE workflow deployment");
  console.log("→ Call: StripeKYCValidator.setForwarder(realForwarderAddress)");
  console.log("→ Call: PlaidCreditValidator.setForwarder(realForwarderAddress)");

  console.log("\n── CRE Workflow Config ──");
  console.log(`KYC Validator (writeReport target): ${kycValidator.proxy}`);
  console.log(`Credit Validator (writeReport target): ${creditValidator.proxy}`);
  console.log("KYC Report ABI: abi.encode(uint256 agentId, bool verified, bytes32 requestHash, bytes32 sessionHash)");
  console.log("Credit Report ABI: abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
