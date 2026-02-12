import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  decodeAbiParameters,
  keccak256,
  toHex,
  type Address
} from "viem";

// Mock data
const mockData = {
  root: 12345n,
  nullifierHash: 67890n,
  proof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as const
};

describe("WorldIDValidator", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  // ============ Helpers ============

  async function getAgentIdFromRegistration(txHash: `0x${string}`): Promise<bigint> {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const registeredLog = receipt.logs.find(log =>
      log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    if (!registeredLog || !registeredLog.topics[1]) {
      throw new Error("Registered event not found");
    }
    return BigInt(registeredLog.topics[1]);
  }

  async function deployProxy(implementationAddress: Address, initCalldata: `0x${string}`) {
    return await viem.deployContract("ERC1967Proxy", [implementationAddress, initCalldata]);
  }

  function encodeInitialize(): `0x${string}` {
    return "0x8129fc1c"; // initialize() selector
  }

  function encodeInitializeWithAddress(addr: Address): `0x${string}` {
    const params = encodeAbiParameters([{ type: "address" }], [addr]);
    return ("0xc4d66de8" + params.slice(2)) as `0x${string}`;
  }

  function encodeWorldIDValidatorInitialize(
    worldIdRouter: Address,
    identityRegistry: Address,
    appId: string,
    actionId: string
  ): `0x${string}` {
    const params = encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "string" },
        { type: "string" }
      ],
      [worldIdRouter, identityRegistry, appId, actionId]
    );
    const selector = keccak256(toHex("initialize(address,address,string,string)")).slice(0, 10);
    return (selector + params.slice(2)) as `0x${string}`;
  }

  // ============ Deploy Helpers ============

  // IdentityRegistry: reinitializer(2) onlyOwner → HardhatMinimalUUPS 패턴 필요
  async function deployIdentityRegistryProxy() {
    const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const minimalInitCalldata = encodeInitializeWithAddress("0x0000000000000000000000000000000000000000");
    const proxy = await deployProxy(minimalImpl.address, minimalInitCalldata);

    const realImpl = await viem.deployContract("IdentityRegistryUpgradeable");
    const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
    await minimalProxy.write.upgradeToAndCall([realImpl.address, encodeInitialize()]);

    return await viem.getContractAt("IdentityRegistryUpgradeable", proxy.address);
  }

  async function deployMockWorldID() {
    return await viem.deployContract("MockWorldID");
  }

  // WorldIDValidator: initializer → 바로 배포 가능 (새 컨트랙트)
  async function deployWorldIDValidatorProxy(
    worldIdRouter: Address,
    identityRegistry: Address
  ) {
    const impl = await viem.deployContract("WorldIDValidator");
    const initCalldata = encodeWorldIDValidatorInitialize(
      worldIdRouter,
      identityRegistry,
      "app_test_12345",
      "verify_human"
    );
    const proxy = await deployProxy(impl.address, initCalldata);
    return await viem.getContractAt("WorldIDValidator", proxy.address);
  }

  // ============ Full Test Setup ============

  async function setupTestEnvironment() {
    const wallets = await viem.getWalletClients();
    const identityRegistry = await deployIdentityRegistryProxy();
    const mockWorldID = await deployMockWorldID();
    const worldIDValidator = await deployWorldIDValidatorProxy(
      mockWorldID.address,
      identityRegistry.address
    );

    return { wallets, identityRegistry, mockWorldID, worldIDValidator };
  }

  // ============ Tests ============

  it("Should deploy and initialize correctly", async function () {
    const { mockWorldID, identityRegistry, worldIDValidator } = await setupTestEnvironment();

    const config = await worldIDValidator.read.getConfig();
    assert.equal(config[0].toLowerCase(), mockWorldID.address.toLowerCase());
    assert.equal(config[1].toLowerCase(), identityRegistry.address.toLowerCase());
    assert.ok(config[2] > 0n);

    console.log("✅ Deployment successful");
  });

  it("Should verify and set humanVerified tag", async function () {
    const { identityRegistry, worldIDValidator } = await setupTestEnvironment();

    // 1. Register agent
    const txHash = await identityRegistry.write.register(["ipfs://my-agent"]);
    const agentId = await getAgentIdFromRegistration(txHash);
    console.log("📝 Registered agentId:", agentId);

    // 2. Approve WorldIDValidator
    await identityRegistry.write.approve([worldIDValidator.address, agentId]);
    console.log("✅ Approved WorldIDValidator for agentId:", agentId);

    // 3. Verify with mock data
    await worldIDValidator.write.verifyAndSetHumanTag([
      agentId,
      mockData.root,
      mockData.nullifierHash,
      mockData.proof
    ]);
    console.log("✅ verifyAndSetHumanTag called");

    // 4. Check metadata
    const metadata = await identityRegistry.read.getMetadata([agentId, "humanVerified"]);
    assert.ok(metadata.length > 0, "Metadata should be set");

    // 5. Decode metadata
    const decoded = decodeAbiParameters(
      [
        { type: "bool", name: "isVerified" },
        { type: "address", name: "validator" },
        { type: "uint256", name: "nullifierHash" },
        { type: "uint256", name: "timestamp" },
        { type: "address", name: "verifiedBy" }
      ],
      metadata
    );

    assert.equal(decoded[0], true);
    assert.equal(decoded[1].toLowerCase(), worldIDValidator.address.toLowerCase());
    assert.equal(decoded[2], mockData.nullifierHash);

    console.log("✅ Metadata verified:");
    console.log("   isVerified:", decoded[0]);
    console.log("   validator:", decoded[1]);
    console.log("   nullifierHash:", decoded[2].toString());
    console.log("   timestamp:", decoded[3].toString());
    console.log("   verifiedBy:", decoded[4]);

    // 6. Double-check via isHumanVerified
    const isVerified = await worldIDValidator.read.isHumanVerified([agentId]);
    assert.equal(isVerified, true);
    console.log("✅ isHumanVerified() returns true");
  });

  it("Should reject if not approved", async function () {
    const { identityRegistry, worldIDValidator } = await setupTestEnvironment();

    const txHash = await identityRegistry.write.register(["ipfs://agent"]);
    const agentId = await getAgentIdFromRegistration(txHash);

    // Don't approve!
    await assert.rejects(
      worldIDValidator.write.verifyAndSetHumanTag([
        agentId, mockData.root, mockData.nullifierHash, mockData.proof
      ]),
      /NotApproved/
    );
    console.log("✅ Rejected: NotApproved");
  });

  it("Should reject duplicate nullifier (sybil attack)", async function () {
    const { identityRegistry, worldIDValidator } = await setupTestEnvironment();

    // Register 2 agents
    const tx1 = await identityRegistry.write.register(["ipfs://agent1"]);
    const agentId1 = await getAgentIdFromRegistration(tx1);

    const tx2 = await identityRegistry.write.register(["ipfs://agent2"]);
    const agentId2 = await getAgentIdFromRegistration(tx2);

    // Approve both
    await identityRegistry.write.approve([worldIDValidator.address, agentId1]);
    await identityRegistry.write.approve([worldIDValidator.address, agentId2]);

    // First succeeds
    await worldIDValidator.write.verifyAndSetHumanTag([
      agentId1, mockData.root, mockData.nullifierHash, mockData.proof
    ]);

    // Second fails (same nullifier = same human trying to verify 2 agents)
    await assert.rejects(
      worldIDValidator.write.verifyAndSetHumanTag([
        agentId2, mockData.root, mockData.nullifierHash, mockData.proof
      ]),
      /NullifierAlreadyUsed/
    );
    console.log("✅ Sybil attack blocked: NullifierAlreadyUsed");
  });
});
