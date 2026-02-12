import { network } from "hardhat";

const CONFIG = {
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
  worldIdValidator: "0xff7fd06a8213d3aeefd0a2f61c0ebdabf32ccbda" as const,
  agentId: 563n,
};

const IDENTITY_REGISTRY_ABI = [
  {
    name: "getApproved",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  }
] as const;

async function main() {
  console.log(`🔍 Checking approval for Agent ${CONFIG.agentId.toString()}...`);

  const { viem } = await network.connect("baseSepolia");
  const publicClient = await viem.getPublicClient();

  try {
    // IdentityRegistry에서 해당 에이전트 ID에 대해 승인된 주소를 가져옵니다.
    const approvedAddress = await publicClient.readContract({
      address: CONFIG.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "getApproved",
      args: [CONFIG.agentId]
    });

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`현재 승인된 주소: ${approvedAddress}`);
    console.log(`목표 Validator 주소: ${CONFIG.worldIdValidator}`);
    
    if (approvedAddress.toLowerCase() === CONFIG.worldIdValidator.toLowerCase()) {
      console.log("결과: Approve가 완벽하게 되어 있습니다! 바로 인증 진행하세요.");
    } else {
      console.log("결과: Approve가 되어 있지 않거나 다른 주소가 승인됨!");
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  } catch (e: any) {
    console.error("에러 발생:", e.message);
  }
}

main().then(() => process.exit(0)).catch(console.error);