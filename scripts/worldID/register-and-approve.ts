import { network } from "hardhat";

// ============ Configuration ============

const CONFIG = {
  baseSepolia: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
    worldIdValidator: process.env.WORLD_ID_VALIDATOR_ADDRESS as `0x${string}`,
  }
};

// ============ ABI ============

const IDENTITY_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }]
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" }
    ],
    outputs: []
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  },
  {
    name: "getApproved",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  }
] as const;

// ============ Main ============

async function main() {
  console.log("Registering Agent -> 8004 & Approving WorldIDValidator...\n");

  const config = CONFIG.baseSepolia;

  if (!config.worldIdValidator) {
    throw new Error("WORLD_ID_VALIDATOR_ADDRESS not set in .env");
  }

  const { viem } = await network.connect("baseSepolia");
  const [wallet] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Your Address:", wallet.account.address);
  console.log("IdentityRegistry:", config.identityRegistry);
  console.log("WorldIDValidator:", config.worldIdValidator);
  console.log("");

  // IdentityRegistry 컨트랙트 인스턴스
  const identityRegistry = {
    address: config.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI
  };

  // ============ STEP 1: Agent 등록 (이미 등록된 경우 주석처리) ============
  // console.log("1. Registering new agent...");
  // const registerTx = await wallet.writeContract({
  //   ...identityRegistry,
  //   functionName: "register",
  //   args: []
  // });
  // console.log("   Waiting for confirmation...");
  // const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerTx });
  // const transferEvent = registerReceipt.logs.find(log =>
  //   log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  // );
  // if (!transferEvent || !transferEvent.topics[3]) {
  //   throw new Error("Could not find agentId from transaction");
  // }
  // const agentId = BigInt(transferEvent.topics[3]);

  // 이미 등록된 agentId 사용
  const agentId = 563n;
  console.log("1. Using existing agentId:", agentId.toString());

  // ============ STEP 2: WorldIDValidator Approve ============
  console.log("\n2. Approving WorldIDValidator for agent...");

  const approveTx = await wallet.writeContract({
    ...identityRegistry,
    functionName: "approve",
    args: [config.worldIdValidator, agentId]
  });

  console.log("   Waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  // 검증
  const approved = await publicClient.readContract({
    ...identityRegistry,
    functionName: "getApproved",
    args: [agentId]
  });

  console.log("   Approved! WorldIDValidator can now set metadata");
  console.log("   Tx:", approveTx);

  // ============ Summary ============
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  SUCCESS!");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Agent ID:          ", agentId.toString());
  console.log("Agent Owner:       ", wallet.account.address);
  console.log("Approved Operator: ", approved);
  console.log("═══════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
