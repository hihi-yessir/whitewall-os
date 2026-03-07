import hre from "hardhat";
import type { Hex } from "viem";
import dotenv from "dotenv";

dotenv.config();

/**
 * Upgrade PlaidCreditValidator proxy to V2 (SGX DCAP attestation support).
 *
 * Steps:
 *   1. Deploy new PlaidCreditValidator implementation (V2)
 *   2. Call upgradeToAndCall on the existing proxy
 *   3. Verify version is "2.0.0"
 *   4. Verify getSgxConfig returns defaults (address(0), bytes32(0))
 */

const CREDIT_VALIDATOR_PROXY = "0x07e8653b55a3cd703106c9726a140755204c1ad5" as Hex;

async function main() {
  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log(`Deployer: ${deployer.account.address}`);
  console.log(`PlaidCreditValidator proxy: ${CREDIT_VALIDATOR_PROXY}\n`);

  // Check current version
  const currentProxy = await viem.getContractAt("PlaidCreditValidator", CREDIT_VALIDATOR_PROXY);
  const currentVersion = await currentProxy.read.getVersion();
  console.log(`Current version: ${currentVersion}`);

  // 1. Deploy new V2 implementation
  console.log("\n1. Deploying PlaidCreditValidator V2 implementation...");
  const newImpl = await viem.deployContract("PlaidCreditValidator");
  console.log(`   New implementation: ${newImpl.address}`);

  // Wait for confirmation
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  await sleep(5000);

  // 2. Upgrade proxy to V2 (no re-initialization needed — storage is append-only)
  console.log("\n2. Upgrading proxy to V2...");
  const upgradeTxHash = await currentProxy.write.upgradeToAndCall([newImpl.address, "0x"]);
  console.log(`   Upgrade tx: ${upgradeTxHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: upgradeTxHash });
  console.log(`   Status: ${receipt.status}`);

  await sleep(3000);

  // 3. Verify new version
  const newVersion = await currentProxy.read.getVersion();
  console.log(`\n3. New version: ${newVersion}`);

  // 4. Verify SGX config defaults
  const [verifier, mrEnclave] = await currentProxy.read.getSgxConfig();
  console.log(`\n4. SGX Config:`);
  console.log(`   Verifier: ${verifier}`);
  console.log(`   MRENCLAVE: ${mrEnclave}`);

  // 5. Verify existing state is preserved
  const [forwarder, identityRegistry, validationRegistry] = await currentProxy.read.getConfig();
  console.log(`\n5. Existing config preserved:`);
  console.log(`   Forwarder: ${forwarder}`);
  console.log(`   IdentityRegistry: ${identityRegistry}`);
  console.log(`   ValidationRegistry: ${validationRegistry}`);

  console.log("\n" + "=".repeat(60));
  console.log("PlaidCreditValidator V2 upgrade complete!");
  console.log("=".repeat(60));
  console.log(`\nNew implementation: ${newImpl.address}`);
  console.log(`\nNext steps (post-PR, manual):`);
  console.log(`  1. Deploy DCAP verifier on Base Sepolia`);
  console.log(`  2. PlaidCreditValidator.setSgxDcapVerifier(verifierAddress)`);
  console.log(`  3. PlaidCreditValidator.setExpectedMrEnclave(mrEnclave)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
