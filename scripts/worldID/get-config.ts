import { network } from "hardhat";

const CONFIG = {
  worldIdValidator: "0xff7fd06a8213d3aeefd0a2f61c0ebdabf32ccbda" as const,
};

const WORLD_ID_VALIDATOR_ABI = [
  {
    name: "getConfig",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "worldIdRouter", type: "address" },
      { name: "identityRegistry", type: "address" },
      { name: "externalNullifier", type: "uint256" }
    ]
  }
] as const;

async function main() {
  console.log("🔍 Fetching WorldIDValidator Configuration...\n");

  const { viem } = await network.connect("baseSepolia");
  const publicClient = await viem.getPublicClient();

  try {
    const [router, registry, extNullifier] = await publicClient.readContract({
      address: CONFIG.worldIdValidator,
      abi: WORLD_ID_VALIDATOR_ABI,
      functionName: "getConfig",
    });

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`WorldID Router: ${router}`);
    console.log(`Identity Registry: ${registry}`);
    console.log(`External Nullifier (Hash): ${extNullifier.toString()}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    console.log("프론트엔드와 대조해보세요:");
    console.log("- 배포 로그에 찍혔던 External Nullifier 값과 위 값이 일치하나요?");
    console.log("- IDKit에서 계산되는 해시값과 일치해야 트랜잭션이 성공합니다.");

  } catch (e: any) {
    console.error("에러 발생:", e.message);
  }
}

main().then(() => process.exit(0)).catch(console.error);