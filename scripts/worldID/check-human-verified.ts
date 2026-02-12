import { network } from "hardhat";

const CONFIG = {
  worldIdValidator: "0xff7fd06a8213d3aeefd0a2f61c0ebdabf32ccbda" as const,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
  agentId: 563n,
};

const WORLD_ID_VALIDATOR_ABI = [
  {
    name: "isHumanVerified",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    name: "getVerificationData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      { name: "isVerified", type: "bool" },
      { name: "nullifierHash", type: "uint256" },
      { name: "verifiedAt", type: "uint256" },
      { name: "verifiedBy", type: "address" }
    ]
  }
] as const;

const IDENTITY_REGISTRY_ABI = [
  {
    name: "getMetadata",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "metadataKey", type: "string" }
    ],
    outputs: [{ name: "", type: "bytes" }]
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  }
] as const;

async function main() {
  console.log("Checking humanVerified status for Agent", CONFIG.agentId.toString(), "\n");

  const { viem } = await network.connect("baseSepolia");
  const publicClient = await viem.getPublicClient();

  // 1. WorldIDValidator에서 확인
  console.log("1. WorldIDValidator.isHumanVerified()");
  try {
    const isVerified = await publicClient.readContract({
      address: CONFIG.worldIdValidator,
      abi: WORLD_ID_VALIDATOR_ABI,
      functionName: "isHumanVerified",
      args: [CONFIG.agentId]
    });
    console.log("   isHumanVerified:", isVerified);
  } catch (e: any) {
    console.log("   Error:", e.message?.slice(0, 100));
  }

  // 2. WorldIDValidator에서 상세 정보
  console.log("\n2.WorldIDValidator.getVerificationData()");
  try {
    const data = await publicClient.readContract({
      address: CONFIG.worldIdValidator,
      abi: WORLD_ID_VALIDATOR_ABI,
      functionName: "getVerificationData",
      args: [CONFIG.agentId]
    });
    console.log("   isVerified:", data[0]);
    console.log("   nullifierHash:", data[1].toString().slice(0, 20) + "...");
    console.log("   verifiedAt:", new Date(Number(data[2]) * 1000).toISOString());
    console.log("   verifiedBy:", data[3]);
  } catch (e: any) {
    console.log("   Error:", e.message?.slice(0, 100));
  }

  // 3. IdentityRegistry에서 메타데이터 확인
  console.log("\n3. IdentityRegistry.getMetadata('humanVerified')");
  try {
    const metadata = await publicClient.readContract({
      address: CONFIG.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "getMetadata",
      args: [CONFIG.agentId, "humanVerified"]
    });
    console.log("   Raw bytes:", metadata);
    if (metadata && metadata !== "0x") {
      console.log("   humanVerified 메타데이터 존재!");
    } else {
      console.log("   메타데이터 비어있음");
    }
  } catch (e: any) {
    console.log("   Error:", e.message?.slice(0, 100));
  }

  // 4. Agent 소유자 확인
  console.log("\n4. IdentityRegistry.ownerOf()");
  try {
    const owner = await publicClient.readContract({
      address: CONFIG.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "ownerOf",
      args: [CONFIG.agentId]
    });
    console.log("   Agent Owner:", owner);
  } catch (e: any) {
    console.log("   Error:", e.message?.slice(0, 100));
  }

  console.log("\n═══════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
