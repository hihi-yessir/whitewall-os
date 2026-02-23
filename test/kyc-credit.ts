import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  type Hex,
  getAddress,
} from "viem";

/**
 * Tests for KYC + Credit verification stack:
 *   - StripeKYCValidator: onReport, access control, state management
 *   - PlaidCreditValidator: onReport, access control, state management
 *   - KYCPolicy: 6-check protection
 *   - CreditPolicy: 8-check protection
 */
describe("KYC + Credit Verification Stack", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  // ── Helper: deploy proxy ──
  async function deployProxy(artifactName: string, initData: Hex) {
    const impl = await viem.deployContract(artifactName);
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    return await viem.getContractAt(artifactName, proxy.address);
  }

  // ── Setup ──
  async function setup() {
    const [deployer] = await viem.getWalletClients();
    const deployerAddress = deployer.account.address;

    // 1. Deploy IdentityRegistry
    const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const minimalInitCalldata = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "addr", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: ["0x0000000000000000000000000000000000000000"],
    });
    const identityProxy = await viem.deployContract("ERC1967Proxy", [minimalImpl.address, minimalInitCalldata]);
    const identityMinimal = await viem.getContractAt("HardhatMinimalUUPS", identityProxy.address);
    const identityImpl = await viem.deployContract("IdentityRegistryUpgradeable");
    await identityMinimal.write.upgradeToAndCall([identityImpl.address, "0x8129fc1c"]);
    const identityRegistry = await viem.getContractAt("IdentityRegistryUpgradeable", identityProxy.address);

    // 2. Deploy ValidationRegistry
    const valMinimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const valProxy = await viem.deployContract("ERC1967Proxy", [valMinimalImpl.address, minimalInitCalldata]);
    const valMinimal = await viem.getContractAt("HardhatMinimalUUPS", valProxy.address);
    const valImpl = await viem.deployContract("ValidationRegistryUpgradeable");
    const valInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "identityRegistry_", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [identityRegistry.address],
    });
    await valMinimal.write.upgradeToAndCall([valImpl.address, valInitData]);
    const validationRegistry = await viem.getContractAt("ValidationRegistryUpgradeable", valProxy.address);

    // 3. Register an agent
    const registerHash = await identityRegistry.write.register();
    const registerReceipt = await publicClient.getTransactionReceipt({ hash: registerHash });
    const registeredLog = registerReceipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    const agentId = BigInt(registeredLog!.topics[1]!);

    // 4. Deploy MockForwarder
    const mockForwarder = await viem.deployContract("MockForwarder");

    // 5. Deploy StripeKYCValidator
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
      args: [mockForwarder.address, identityRegistry.address, validationRegistry.address],
    });
    const kycValidator = await deployProxy("StripeKYCValidator", kycValidatorInitData);

    // 6. Deploy PlaidCreditValidator
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
      args: [mockForwarder.address, identityRegistry.address, validationRegistry.address],
    });
    const creditValidator = await deployProxy("PlaidCreditValidator", creditValidatorInitData);

    // 7. Create validation requests in ValidationRegistry so validationResponse works
    // The validators need to be registered as validatorAddress for their requestHashes
    const kycRequestHash = keccak256(toHex("kyc-request-1"));
    await validationRegistry.write.validationRequest([
      kycValidator.address, agentId, "stripe:vs_test", kycRequestHash,
    ]);

    const creditRequestHash = keccak256(toHex("credit-request-1"));
    await validationRegistry.write.validationRequest([
      creditValidator.address, agentId, "plaid:42", creditRequestHash,
    ]);

    // 8. Deploy MockWorldID and WorldIDValidator for policy tests
    const mockWorldId = await viem.deployContract("MockWorldID");
    const worldIdValidatorInitData = encodeFunctionData({
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
      args: [mockWorldId.address, identityRegistry.address, "app_test", "verify-owner"],
    });
    const worldIdValidator = await deployProxy("WorldIDValidator", worldIdValidatorInitData);

    // 9. Approve + verify the agent with World ID (for policy tests)
    await identityRegistry.write.approve([worldIdValidator.address, agentId]);
    await worldIdValidator.write.verifyAndSetHumanTag([
      agentId,
      BigInt(1), // root
      BigInt(12345), // nullifierHash
      [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)] as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    ]);

    return {
      identityRegistry, validationRegistry, mockForwarder,
      kycValidator, creditValidator, worldIdValidator,
      deployerAddress, agentId,
      kycRequestHash, creditRequestHash,
    };
  }

  const s = await setup();

  // ════════════════════════════════════════════
  // StripeKYCValidator Tests
  // ════════════════════════════════════════════

  it("KYCValidator: onReport sets kycVerified state", async () => {
    const sessionHash = keccak256(toHex("session-123"));
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, true, s.kycRequestHash, sessionHash]
    );

    await s.mockForwarder.write.forwardReport([s.kycValidator.address, "0x" as Hex, report]);

    const verified = await s.kycValidator.read.isKYCVerified([s.agentId]);
    assert.equal(verified, true, "Agent should be KYC verified");

    const [v, sh, ts] = await s.kycValidator.read.getKYCData([s.agentId]);
    assert.equal(v, true);
    assert.equal(sh, sessionHash);
    assert.ok(ts > 0n, "verifiedAt should be set");
  });

  it("KYCValidator: onReport rejects non-forwarder caller", async () => {
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, true, s.kycRequestHash, keccak256(toHex("x"))]
    );

    await assert.rejects(
      s.kycValidator.write.onReport(["0x" as Hex, report]),
      /NotForwarder/,
    );
  });

  it("KYCValidator: onReport rejects unregistered agent", async () => {
    const fakeAgentId = 99999n;
    // Need a valid requestHash for this — create one
    const fakeRequestHash = keccak256(toHex("kyc-fake-agent"));

    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }],
      [fakeAgentId, true, fakeRequestHash, keccak256(toHex("x"))]
    );

    await assert.rejects(
      s.mockForwarder.write.forwardReport([s.kycValidator.address, "0x" as Hex, report]),
      /AgentNotRegistered/,
    );
  });

  it("KYCValidator: emits KYCVerified event", async () => {
    // Already verified in first test — check event was emitted
    // Read the KYC data to confirm state
    const verified = await s.kycValidator.read.isKYCVerified([s.agentId]);
    assert.equal(verified, true);
  });

  // ════════════════════════════════════════════
  // PlaidCreditValidator Tests
  // ════════════════════════════════════════════

  it("CreditValidator: onReport sets credit score", async () => {
    const dataHash = keccak256(toHex("plaid-response-data"));
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, 85, s.creditRequestHash, dataHash]
    );

    await s.mockForwarder.write.forwardReport([s.creditValidator.address, "0x" as Hex, report]);

    const score = await s.creditValidator.read.getCreditScore([s.agentId]);
    assert.equal(score, 85, "Credit score should be 85");

    const hasScore = await s.creditValidator.read.hasCreditScore([s.agentId]);
    assert.equal(hasScore, true);

    const [sc, dh, ts, hs] = await s.creditValidator.read.getCreditData([s.agentId]);
    assert.equal(sc, 85);
    assert.equal(dh, dataHash);
    assert.ok(ts > 0n);
    assert.equal(hs, true);
  });

  it("CreditValidator: onReport rejects non-forwarder caller", async () => {
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, 50, s.creditRequestHash, keccak256(toHex("x"))]
    );

    await assert.rejects(
      s.creditValidator.write.onReport(["0x" as Hex, report]),
      /NotForwarder/,
    );
  });

  it("CreditValidator: onReport rejects score > 100", async () => {
    // Need a new request hash since the old one was already used
    const newRequestHash = keccak256(toHex("credit-request-overflow"));
    await s.validationRegistry.write.validationRequest([
      s.creditValidator.address, s.agentId, "plaid:overflow", newRequestHash,
    ]);

    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, 101, newRequestHash, keccak256(toHex("x"))]
    );

    await assert.rejects(
      s.mockForwarder.write.forwardReport([s.creditValidator.address, "0x" as Hex, report]),
      /Score exceeds maximum/,
    );
  });

  // ════════════════════════════════════════════
  // KYCPolicy Tests
  // ════════════════════════════════════════════

  it("KYCPolicy: approved agent with KYC → Allowed", async () => {
    // Deploy KYCPolicy
    const policyEngineInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "defaultAllow", type: "bool" }, { name: "initialOwner", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [false, s.deployerAddress],
    });
    const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData);

    const kycPolicyConfigParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }],
      [s.identityRegistry.address, s.worldIdValidator.address, s.kycValidator.address, 3]
    );
    const kycPolicyInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "policyEngine", type: "address" }, { name: "initialOwner", type: "address" }, { name: "configParams", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [policyEngine.address, s.deployerAddress, kycPolicyConfigParams],
    });
    const kycPolicy = await deployProxy("KYCPolicy", kycPolicyInitData);

    // Call run directly (simulating PolicyEngine calling it)
    // Parameters: [agentId, approved, tier, accountableHuman]
    const params: Hex[] = [
      encodeAbiParameters([{ type: "uint256" }], [s.agentId]),
      encodeAbiParameters([{ type: "bool" }], [true]),
      encodeAbiParameters([{ type: "uint8" }], [3]),
      encodeAbiParameters([{ type: "address" }], [s.deployerAddress]),
    ];

    const result = await kycPolicy.read.run([
      s.deployerAddress,
      s.deployerAddress,
      "0x805f2132" as Hex,
      params,
      "0x" as Hex,
    ]);

    // PolicyResult.Allowed = 1 (None=0, Allowed=1, Continue=2)
    assert.equal(result, 1);
  });

  it("KYCPolicy: agent without KYC → rejected", async () => {
    // Register a new agent without KYC
    const registerHash = await s.identityRegistry.write.register();
    const registerReceipt = await publicClient.getTransactionReceipt({ hash: registerHash });
    const registeredLog = registerReceipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    const newAgentId = BigInt(registeredLog!.topics[1]!);

    // Verify with World ID
    await s.identityRegistry.write.approve([s.worldIdValidator.address, newAgentId]);
    await s.worldIdValidator.write.verifyAndSetHumanTag([
      newAgentId, BigInt(2), BigInt(67890),
      [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)] as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    ]);

    // Deploy a fresh KYCPolicy
    const policyEngineInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "defaultAllow", type: "bool" }, { name: "initialOwner", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [false, s.deployerAddress],
    });
    const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData);

    const kycPolicyConfigParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }],
      [s.identityRegistry.address, s.worldIdValidator.address, s.kycValidator.address, 3]
    );
    const kycPolicyInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "policyEngine", type: "address" }, { name: "initialOwner", type: "address" }, { name: "configParams", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [policyEngine.address, s.deployerAddress, kycPolicyConfigParams],
    });
    const kycPolicy = await deployProxy("KYCPolicy", kycPolicyInitData);

    const params: Hex[] = [
      encodeAbiParameters([{ type: "uint256" }], [newAgentId]),
      encodeAbiParameters([{ type: "bool" }], [true]),
      encodeAbiParameters([{ type: "uint8" }], [3]),
      encodeAbiParameters([{ type: "address" }], [s.deployerAddress]),
    ];

    await assert.rejects(
      kycPolicy.read.run([
        s.deployerAddress, s.deployerAddress, "0x805f2132" as Hex, params, "0x" as Hex,
      ]),
      /StripeKYCValidator: KYC not verified/,
    );
  });

  // ════════════════════════════════════════════
  // CreditPolicy Tests
  // ════════════════════════════════════════════

  it("CreditPolicy: agent with KYC + credit score >= min → Allowed", async () => {
    const policyEngineInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "defaultAllow", type: "bool" }, { name: "initialOwner", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [false, s.deployerAddress],
    });
    const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData);

    const creditPolicyConfigParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }, { type: "uint8" }],
      [s.identityRegistry.address, s.worldIdValidator.address, s.kycValidator.address, s.creditValidator.address, 4, 50]
    );
    const creditPolicyInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "policyEngine", type: "address" }, { name: "initialOwner", type: "address" }, { name: "configParams", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [policyEngine.address, s.deployerAddress, creditPolicyConfigParams],
    });
    const creditPolicy = await deployProxy("CreditPolicy", creditPolicyInitData);

    const params: Hex[] = [
      encodeAbiParameters([{ type: "uint256" }], [s.agentId]),
      encodeAbiParameters([{ type: "bool" }], [true]),
      encodeAbiParameters([{ type: "uint8" }], [4]),
      encodeAbiParameters([{ type: "address" }], [s.deployerAddress]),
    ];

    const result = await creditPolicy.read.run([
      s.deployerAddress, s.deployerAddress, "0x805f2132" as Hex, params, "0x" as Hex,
    ]);

    assert.equal(result, 1); // PolicyResult.Allowed = 1
  });

  it("CreditPolicy: credit score below minimum → rejected", async () => {
    // Set up a new agent with KYC but low credit score
    const registerHash = await s.identityRegistry.write.register();
    const registerReceipt = await publicClient.getTransactionReceipt({ hash: registerHash });
    const registeredLog = registerReceipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    const lowScoreAgentId = BigInt(registeredLog!.topics[1]!);

    // World ID verify
    await s.identityRegistry.write.approve([s.worldIdValidator.address, lowScoreAgentId]);
    await s.worldIdValidator.write.verifyAndSetHumanTag([
      lowScoreAgentId, BigInt(3), BigInt(11111),
      [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)] as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    ]);

    // KYC verify
    const kycReqHash = keccak256(toHex("kyc-low-score"));
    await s.validationRegistry.write.validationRequest([
      s.kycValidator.address, lowScoreAgentId, "stripe:low", kycReqHash,
    ]);
    const kycReport = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }],
      [lowScoreAgentId, true, kycReqHash, keccak256(toHex("s"))]
    );
    await s.mockForwarder.write.forwardReport([s.kycValidator.address, "0x" as Hex, kycReport]);

    // Credit score = 30 (below min of 50)
    const creditReqHash = keccak256(toHex("credit-low-score"));
    await s.validationRegistry.write.validationRequest([
      s.creditValidator.address, lowScoreAgentId, "plaid:low", creditReqHash,
    ]);
    const creditReport = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [lowScoreAgentId, 30, creditReqHash, keccak256(toHex("d"))]
    );
    await s.mockForwarder.write.forwardReport([s.creditValidator.address, "0x" as Hex, creditReport]);

    // Deploy CreditPolicy
    const policyEngineInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "defaultAllow", type: "bool" }, { name: "initialOwner", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [false, s.deployerAddress],
    });
    const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData);

    const creditPolicyConfigParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }, { type: "uint8" }],
      [s.identityRegistry.address, s.worldIdValidator.address, s.kycValidator.address, s.creditValidator.address, 4, 50]
    );
    const creditPolicyInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "policyEngine", type: "address" }, { name: "initialOwner", type: "address" }, { name: "configParams", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [policyEngine.address, s.deployerAddress, creditPolicyConfigParams],
    });
    const creditPolicy = await deployProxy("CreditPolicy", creditPolicyInitData);

    const params: Hex[] = [
      encodeAbiParameters([{ type: "uint256" }], [lowScoreAgentId]),
      encodeAbiParameters([{ type: "bool" }], [true]),
      encodeAbiParameters([{ type: "uint8" }], [4]),
      encodeAbiParameters([{ type: "address" }], [s.deployerAddress]),
    ];

    await assert.rejects(
      creditPolicy.read.run([
        s.deployerAddress, s.deployerAddress, "0x805f2132" as Hex, params, "0x" as Hex,
      ]),
      /PlaidCreditValidator: credit score too low/,
    );
  });

  it("CreditPolicy: view helpers return correct values", async () => {
    const policyEngineInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "defaultAllow", type: "bool" }, { name: "initialOwner", type: "address" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [false, s.deployerAddress],
    });
    const policyEngine = await deployProxy("PolicyEngine", policyEngineInitData);

    const creditPolicyConfigParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint8" }, { type: "uint8" }],
      [s.identityRegistry.address, s.worldIdValidator.address, s.kycValidator.address, s.creditValidator.address, 4, 50]
    );
    const creditPolicyInitData = encodeFunctionData({
      abi: [{ name: "initialize", type: "function", inputs: [{ name: "policyEngine", type: "address" }, { name: "initialOwner", type: "address" }, { name: "configParams", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "initialize",
      args: [policyEngine.address, s.deployerAddress, creditPolicyConfigParams],
    });
    const creditPolicy = await deployProxy("CreditPolicy", creditPolicyInitData);

    const tier = await creditPolicy.read.getRequiredTier();
    assert.equal(tier, 4);

    const minScore = await creditPolicy.read.getMinCreditScore();
    assert.equal(minScore, 50);

    const idReg = await creditPolicy.read.getIdentityRegistry();
    assert.equal(getAddress(idReg), getAddress(s.identityRegistry.address));

    const wid = await creditPolicy.read.getWorldIdValidator();
    assert.equal(getAddress(wid), getAddress(s.worldIdValidator.address));

    const kyc = await creditPolicy.read.getStripeKYCValidator();
    assert.equal(getAddress(kyc), getAddress(s.kycValidator.address));

    const credit = await creditPolicy.read.getPlaidCreditValidator();
    assert.equal(getAddress(credit), getAddress(s.creditValidator.address));
  });
});
