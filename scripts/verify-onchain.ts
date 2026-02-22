import hre from "hardhat";

async function main() {
  const { viem } = await hre.network.connect();

  const kycValidator = await viem.getContractAt("StripeKYCValidator", "0x4e66fe730ae5476e79e70769c379663df4c61a8b");
  const creditValidator = await viem.getContractAt("PlaidCreditValidator", "0xceb46c0f2704d2191570bd81b622200097af9ade");

  const agentId = 998n;

  console.log(`\n=== On-chain Verification (Agent #${agentId}) ===`);

  // KYC state
  const isKYC = await kycValidator.read.isKYCVerified([agentId]);
  console.log(`isKYCVerified(${agentId}): ${isKYC}`);

  const [verified, sessionHash, verifiedAt] = await kycValidator.read.getKYCData([agentId]);
  console.log(`KYC: verified=${verified}, sessionHash=${sessionHash.slice(0, 18)}..., verifiedAt=${verifiedAt}`);

  // Credit state
  const hasCreditScore = await creditValidator.read.hasCreditScore([agentId]);
  console.log(`\nhasCreditScore(${agentId}): ${hasCreditScore}`);

  const creditScore = await creditValidator.read.getCreditScore([agentId]);
  console.log(`getCreditScore(${agentId}): ${creditScore}`);

  const [score, dataHash, ts, hs] = await creditValidator.read.getCreditData([agentId]);
  console.log(`Credit: score=${score}, dataHash=${dataHash.slice(0, 18)}..., verifiedAt=${ts}, hasScore=${hs}`);

  console.log("\n=== E2E VERIFICATION COMPLETE ===");
  if (isKYC && hasCreditScore && creditScore > 0) {
    console.log("ALL CHECKS PASSED: KYC verified + Credit score set on-chain via CRE simulation");
  } else {
    console.log("SOME CHECKS FAILED:");
    if (!isKYC) console.log("  - KYC not verified on-chain");
    if (!hasCreditScore) console.log("  - Credit score not set on-chain");
  }
}

main().catch(console.error);
