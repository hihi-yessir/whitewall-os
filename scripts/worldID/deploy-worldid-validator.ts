import { network } from "hardhat";
import { encodeFunctionData } from "viem";

// ============ Configuration ============

// Base Sepolia 배포된 주소들
const CONFIG = {
  baseSepolia: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
    worldIdRouter: "0x42FF98C4E85212a5D31358ACbFe76a621b50fC02" as const,
  }
};

// WorldID 설정 - .env에서 읽어옴
// 프론트엔드에서도 동일한 값 사용해야 함!
function getWorldIdConfig() {
  const appId = process.env.WORLDID_APP_ID;
  const actionId = process.env.WORLDID_ACTION_ID;

  if (!appId) {
    throw new Error("WORLDID_APP_ID not set in .env");
  }
  if (!actionId) {
    throw new Error("WORLDID_ACTION_ID not set in .env");
  }

  return { appId, actionId };
}

// ============ ABI ============

const WORLD_ID_VALIDATOR_ABI = [
  {
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "worldIdRouter_", type: "address" },
      { name: "identityRegistry_", type: "address" },
      { name: "appId_", type: "string" },
      { name: "actionId_", type: "string" }
    ],
    outputs: []
  }
] as const;

// ============ Main ============

async function main() {
  console.log("Deploying WorldIDValidator to Base Sepolia...\n");

  // WorldID 설정 로드 (.env에서)
  const worldIdConfig = getWorldIdConfig();

  // Hardhat 3 + viem:
  // - getWalletClients()가 hardhat.config.ts의 private key로 wallet 생성
  // - deployContract() 호출 시 내부에서 자동으로 트랜잭션 서명
  const { viem } = await network.connect("baseSepolia");
  const [deployer] = await viem.getWalletClients();

  console.log("Deployer:", deployer.account.address);

  const publicClient = await viem.getPublicClient();
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log("Balance:", (Number(balance) / 1e18).toFixed(4), "ETH\n");

  if (balance === 0n) {
    throw new Error("No ETH balance! Get Base Sepolia ETH from faucet first.");
  }

  const config = CONFIG.baseSepolia;

  console.log("📋 Configuration:");
  console.log("   IdentityRegistry:", config.identityRegistry);
  console.log("   WorldID Router:", config.worldIdRouter);
  console.log("   App ID:", worldIdConfig.appId);
  console.log("   Action ID:", worldIdConfig.actionId);
  console.log("");

  // 1. Deploy Implementation
  console.log("1. Deploying WorldIDValidator implementation...");
  const impl = await viem.deployContract("WorldIDValidator");
  console.log("   * Implementation:", impl.address);

  // 2. Prepare init calldata (viem의 encodeFunctionData 사용 - 올바른 function selector 생성)
  const initCalldata = encodeFunctionData({
    abi: WORLD_ID_VALIDATOR_ABI,
    functionName: "initialize",
    args: [
      config.worldIdRouter,
      config.identityRegistry,
      worldIdConfig.appId,
      worldIdConfig.actionId
    ]
  });

  // 3. Deploy Proxy
  console.log("2. Deploying ERC1967Proxy...");
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initCalldata]);
  console.log("   * Proxy:", proxy.address);

  // 4. Verify deployment (약간 대기 - RPC 동기화)
  console.log("3. Verifying deployment...");
  console.log("   * Waiting for RPC sync (3s)...");
  await new Promise(resolve => setTimeout(resolve, 3000));

  const worldIDValidator = await viem.getContractAt("WorldIDValidator", proxy.address);

  let contractConfig: readonly [`0x${string}`, `0x${string}`, bigint];
  let version: string;

  try {
    contractConfig = await worldIDValidator.read.getConfig();
    version = await worldIDValidator.read.getVersion();
  } catch (error) {
    console.log("\n Verification read failed, but deployment likely succeeded!");
    console.log("═══════════════════════════════════════════════════════");
    console.log("WorldIDValidator Proxy:", proxy.address);
    console.log("Implementation:", impl.address);
    console.log("═══════════════════════════════════════════════════════");
    console.log("\n Verify on BaseScan:");
    console.log(`   https://sepolia.basescan.org/address/${proxy.address}`);
    console.log("\n Try calling getConfig() manually on BaseScan to verify initialization.");
    throw error;
  }

  console.log("\n Deployment successful!");
  console.log("═══════════════════════════════════════════════════════");
  console.log("WorldIDValidator Proxy:", proxy.address);
  console.log("Implementation:", impl.address);
  console.log("Version:", version);
  console.log("═══════════════════════════════════════════════════════");
  console.log("\n Contract Config:");
  console.log("   WorldID Router:", contractConfig[0]);
  console.log("   IdentityRegistry:", contractConfig[1]);
  console.log("   External Nullifier:", contractConfig[2].toString());

  console.log("\n View on BaseScan:");
  console.log(`   https://sepolia.basescan.org/address/${proxy.address}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
