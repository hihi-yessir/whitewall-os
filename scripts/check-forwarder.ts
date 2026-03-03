import hre from "hardhat";

async function main() {
  const { viem } = await hre.network.connect();

  const kyc = await viem.getContractAt("StripeKYCValidator", "0x4e66fe730ae5476e79e70769c379663df4c61a8b");
  const credit = await viem.getContractAt("PlaidCreditValidator", "0xceb46c0f2704d2191570bd81b622200097af9ade");
  const consumer = await viem.getContractAt("WhitewallConsumer", "0xec3114ea6bb29f77b63cd1223533870b663120bb");

  const [kycFw] = await kyc.read.getConfig();
  const [creditFw] = await credit.read.getConfig();
  const consumerFw = await consumer.read.getForwarder();

  console.log("StripeKYCValidator forwarder:", kycFw);
  console.log("PlaidCreditValidator forwarder:", creditFw);
  console.log("WhitewallConsumer forwarder:", consumerFw);
}

main().catch(console.error);
