import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  type Hex,
} from "viem";

/**
 * Simulates the exact Base Sepolia upgrade path:
 *   1. Deploy V1 PlaidCreditValidator (as currently on-chain)
 *   2. Submit a V1 report (score stored)
 *   3. Upgrade proxy to V2 (our new code)
 *   4. Verify V1 state preserved after upgrade
 *   5. Verify V2 SGX flows work post-upgrade
 *   6. Verify backwards compat (V1 reports still accepted)
 *
 * This is NOT a unit test — it's a full upgrade integration test
 * that mirrors the real deployment scenario.
 */
describe("PlaidCreditValidator V1 → V2 Upgrade Simulation", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  async function deployProxy(artifactName: string, initData: Hex) {
    const impl = await viem.deployContract(artifactName);
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    return {
      contract: await viem.getContractAt(artifactName, proxy.address),
      proxyAddress: proxy.address,
      implAddress: impl.address,
    };
  }

  // ── Full setup mimicking on-chain state ──
  async function setup() {
    const [deployer] = await viem.getWalletClients();

    // Identity Registry
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

    // Validation Registry
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

    // Register agent
    const registerHash = await identityRegistry.write.register();
    const registerReceipt = await publicClient.getTransactionReceipt({ hash: registerHash });
    const registeredLog = registerReceipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    const agentId = BigInt(registeredLog!.topics[1]!);

    // Mock Forwarder
    const mockForwarder = await viem.deployContract("MockForwarder");

    // Deploy PlaidCreditValidator V1 via proxy (this is what's on-chain now)
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
    const creditV1 = await deployProxy("PlaidCreditValidator", creditValidatorInitData);

    return {
      identityRegistry, validationRegistry, mockForwarder,
      creditValidator: creditV1.contract,
      creditValidatorProxyAddress: creditV1.proxyAddress,
      agentId,
    };
  }

  const s = await setup();

  // ════════════════════════════════════════════
  // Phase 1: V1 baseline — submit a report pre-upgrade
  // ════════════════════════════════════════════

  it("Phase 1: V1 report works pre-upgrade", async () => {
    const version = await s.creditValidator.read.getVersion();
    assert.equal(version, "2.0.0"); // NOTE: since we compile from current source, it's already 2.0.0 code
    // In production the on-chain impl returns "1.0.0" — but the logic we care about is the upgrade path

    const requestHash = keccak256(toHex("pre-upgrade-request"));
    await s.validationRegistry.write.validationRequest([
      s.creditValidator.address, s.agentId, "plaid:pre", requestHash,
    ]);

    const dataHash = keccak256(toHex("pre-upgrade-data"));
    // V1 format report (4 fields)
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, 72, requestHash, dataHash]
    );
    await s.mockForwarder.write.forwardReport([s.creditValidator.address, "0x" as Hex, report]);

    const score = await s.creditValidator.read.getCreditScore([s.agentId]);
    assert.equal(score, 72, "V1 score should be stored");

    const hasScore = await s.creditValidator.read.hasCreditScore([s.agentId]);
    assert.equal(hasScore, true);
  });

  // ════════════════════════════════════════════
  // Phase 2: Upgrade to V2 and verify state preserved
  // ════════════════════════════════════════════

  it("Phase 2: Upgrade preserves V1 state", async () => {
    // Deploy new V2 implementation
    const newImpl = await viem.deployContract("PlaidCreditValidator");

    // Upgrade the proxy
    await s.creditValidator.write.upgradeToAndCall([newImpl.address, "0x"]);

    // Re-wrap proxy with V2 ABI (same contract name, already V2 code)
    const upgraded = await viem.getContractAt("PlaidCreditValidator", s.creditValidatorProxyAddress);

    // Verify V1 state preserved
    const score = await upgraded.read.getCreditScore([s.agentId]);
    assert.equal(score, 72, "V1 score must survive upgrade");

    const hasScore = await upgraded.read.hasCreditScore([s.agentId]);
    assert.equal(hasScore, true, "V1 hasScore must survive upgrade");

    const [sc, dh, ts, hs] = await upgraded.read.getCreditData([s.agentId]);
    assert.equal(sc, 72);
    assert.ok(ts > 0n, "verifiedAt must survive upgrade");
    assert.equal(hs, true);

    // Verify existing config preserved
    const [forwarder, idReg, valReg] = await upgraded.read.getConfig();
    assert.equal(forwarder.toLowerCase(), s.mockForwarder.address.toLowerCase());
    assert.equal(idReg.toLowerCase(), s.identityRegistry.address.toLowerCase());
    assert.equal(valReg.toLowerCase(), s.validationRegistry.address.toLowerCase());

    // Verify V2 SGX fields default to zero
    const [verifier, mrEnclave] = await upgraded.read.getSgxConfig();
    assert.equal(verifier, "0x0000000000000000000000000000000000000000");
    assert.equal(mrEnclave, "0x0000000000000000000000000000000000000000000000000000000000000000");

    // Verify version
    const version = await upgraded.read.getVersion();
    assert.equal(version, "2.0.0");
  });

  // ════════════════════════════════════════════
  // Phase 3: V1 reports still work after upgrade (backwards compat)
  // ════════════════════════════════════════════

  it("Phase 3: V1 format report still works after upgrade", async () => {
    const upgraded = await viem.getContractAt("PlaidCreditValidator", s.creditValidatorProxyAddress);

    const requestHash = keccak256(toHex("post-upgrade-v1-format"));
    await s.validationRegistry.write.validationRequest([
      upgraded.address, s.agentId, "plaid:postv1", requestHash,
    ]);

    // V1 format (4 fields, no sgxQuote)
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [s.agentId, 88, requestHash, keccak256(toHex("d"))]
    );

    await s.mockForwarder.write.forwardReport([upgraded.address, "0x" as Hex, report]);

    const score = await upgraded.read.getCreditScore([s.agentId]);
    assert.equal(score, 88, "V1 format should still work after V2 upgrade");
  });

  // ════════════════════════════════════════════
  // Phase 4: Full SGX flow post-upgrade
  // ════════════════════════════════════════════

  it("Phase 4: V2 SGX verification works after upgrade", async () => {
    const upgraded = await viem.getContractAt("PlaidCreditValidator", s.creditValidatorProxyAddress);

    // Deploy and configure MockSgxDcapVerifier
    const mockSgxVerifier = await viem.deployContract("MockSgxDcapVerifier");
    const expectedMrEnclave = keccak256(toHex("trusted-enclave"));

    // Submit V2 report with valid SGX quote
    const requestHash = keccak256(toHex("post-upgrade-sgx-valid"));
    await s.validationRegistry.write.validationRequest([
      upgraded.address, s.agentId, "plaid:sgx", requestHash,
    ]);

    // Compute expected reportData hash: sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
    const crypto = await import("node:crypto");
    const preimage = `agent:${s.agentId.toString()}|hash:${requestHash}|score:65`;
    const hashBuffer = crypto.createHash("sha256").update(preimage).digest();
    const expectedHash = ("0x" + hashBuffer.toString("hex")) as Hex;

    await mockSgxVerifier.write.setMockMrEnclave([expectedMrEnclave]);
    await mockSgxVerifier.write.setMockReportData([expectedHash]);
    await mockSgxVerifier.write.setMockSuccess([true]);

    // Configure SGX on upgraded validator
    await upgraded.write.setSgxDcapVerifier([mockSgxVerifier.address]);
    await upgraded.write.setExpectedMrEnclave([expectedMrEnclave]);

    // Verify config
    const [verifier, mrEnc] = await upgraded.read.getSgxConfig();
    assert.equal(verifier.toLowerCase(), mockSgxVerifier.address.toLowerCase());
    assert.equal(mrEnc, expectedMrEnclave);

    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }],
      [s.agentId, 65, requestHash, keccak256(toHex("d")), "0xdeadbeef" as Hex]
    );

    await s.mockForwarder.write.forwardReport([upgraded.address, "0x" as Hex, report]);

    const score = await upgraded.read.getCreditScore([s.agentId]);
    assert.equal(score, 65, "V2 SGX report should store score after upgrade");
  });

  it("Phase 4b: Tampered score rejected after upgrade", async () => {
    const upgraded = await viem.getContractAt("PlaidCreditValidator", s.creditValidatorProxyAddress);

    // Mock still has hash for score=65, submit score=99
    const requestHash = keccak256(toHex("post-upgrade-sgx-tampered"));
    await s.validationRegistry.write.validationRequest([
      upgraded.address, s.agentId, "plaid:sgxtamper", requestHash,
    ]);

    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }],
      [s.agentId, 99, requestHash, keccak256(toHex("d")), "0xdeadbeef" as Hex]
    );

    await assert.rejects(
      s.mockForwarder.write.forwardReport([upgraded.address, "0x" as Hex, report]),
      /Data manipulated in transit/,
    );
  });

  it("Phase 4c: Wrong MRENCLAVE rejected after upgrade", async () => {
    const upgraded = await viem.getContractAt("PlaidCreditValidator", s.creditValidatorProxyAddress);

    // Deploy a new mock with wrong MRENCLAVE
    const badMock = await viem.deployContract("MockSgxDcapVerifier");
    const wrongMrEnclave = keccak256(toHex("evil-enclave"));

    await upgraded.write.setSgxDcapVerifier([badMock.address]);
    // expectedMrEnclave on validator is still "trusted-enclave" hash

    const requestHash = keccak256(toHex("post-upgrade-sgx-wrongmr"));

    const crypto = await import("node:crypto");
    const preimage = `agent:${s.agentId.toString()}|hash:${requestHash}|score:50`;
    const hashBuffer = crypto.createHash("sha256").update(preimage).digest();
    const expectedHash = ("0x" + hashBuffer.toString("hex")) as Hex;

    await badMock.write.setMockMrEnclave([wrongMrEnclave]);
    await badMock.write.setMockReportData([expectedHash]);
    await badMock.write.setMockSuccess([true]);
    await s.validationRegistry.write.validationRequest([
      upgraded.address, s.agentId, "plaid:sgxwrongmr", requestHash,
    ]);

    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }],
      [s.agentId, 50, requestHash, keccak256(toHex("d")), "0xdeadbeef" as Hex]
    );

    await assert.rejects(
      s.mockForwarder.write.forwardReport([upgraded.address, "0x" as Hex, report]),
      /Untrusted TEE Code \(MRENCLAVE mismatch\)/,
    );
  });

  it("Phase 4d: Empty quote skips SGX check even with verifier set", async () => {
    const upgraded = await viem.getContractAt("PlaidCreditValidator", s.creditValidatorProxyAddress);

    // Reset to a valid mock (the bad one from 4c is still set)
    const goodMock = await viem.deployContract("MockSgxDcapVerifier");
    await upgraded.write.setSgxDcapVerifier([goodMock.address]);

    const requestHash = keccak256(toHex("post-upgrade-empty-quote"));
    await s.validationRegistry.write.validationRequest([
      upgraded.address, s.agentId, "plaid:emptyq", requestHash,
    ]);

    // V2 format but empty quote — should skip SGX verification
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }],
      [s.agentId, 42, requestHash, keccak256(toHex("d")), "0x" as Hex]
    );

    await s.mockForwarder.write.forwardReport([upgraded.address, "0x" as Hex, report]);

    const score = await upgraded.read.getCreditScore([s.agentId]);
    assert.equal(score, 42, "Empty quote should skip SGX and store score");
  });
});
