import hre from "hardhat";

async function main() {
  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();

  const consumer = await viem.getContractAt("WhitewallConsumer", "0xec3114ea6bb29f77b63cd1223533870b663120bb");

  const owner = await consumer.read.owner();
  const forwarder = await consumer.read.getForwarder();

  console.log("Consumer owner:", owner);
  console.log("Our address:", deployer.account.address);
  console.log("We are owner:", owner.toLowerCase() === deployer.account.address.toLowerCase());
  console.log("Current forwarder:", forwarder);
}

main().catch(console.error);
