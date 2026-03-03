import hre from "hardhat";

async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();

  const FORWARDER = "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5";
  const consumer = await viem.getContractAt("WhitewallConsumer", "0xec3114ea6bb29f77b63cd1223533870b663120bb");

  console.log("Setting WhitewallConsumer forwarder to:", FORWARDER);
  const tx = await consumer.write.setForwarder([FORWARDER]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`tx: ${tx} (status: ${receipt.status})`);

  const newForwarder = await consumer.read.getForwarder();
  console.log("WhitewallConsumer forwarder now:", newForwarder);
}

main().catch(console.error);
