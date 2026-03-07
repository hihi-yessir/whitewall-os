/**
 * Upserts missing PCCS collateral to Automata's on-chain PCCS on Base Sepolia.
 * This enables SGX DCAP quote verification for our TEE service.
 *
 * Collateral types upserted:
 * 1. FMSPC TCB Info (#18) — TCB levels for our SGX platform
 * 2. QE Identity (#18) — Quoting Enclave identity verification
 * 3. PCK CRL (Platform) — Certificate Revocation List
 * 4. Root CA CRL — Intel Root CA CRL
 *
 * All upsert functions are PERMISSIONLESS — they verify Intel's signature
 * before accepting the data on-chain.
 */

import { createWalletClient, createPublicClient, http, encodeFunctionData, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";

const RPC_URL = "https://sepolia.base.org";
const PRIVATE_KEY = process.env.BASE_SEPOLIA_PRIVATE_KEY!;

// Base Sepolia Automata PCCS addresses
const FMSPC_TCB_DAO_18 = "0x62E8Cd513B12F248804123f7ed12A0601B79FBAc" as const;
const QE_ID_DAO_18 = "0x6eE9602b90E8C451FfBCc8d5Dc9C8A3BF0A4fA56" as const;
const PCS_DAO = "0xB270cD8550DA117E3accec36A90c4b0b48daD342" as const;

// ABIs for upsert functions
const fmspcTcbDaoAbi = [
  {
    name: "upsertFmspcTcb",
    type: "function",
    inputs: [
      {
        name: "tcbInfoObj",
        type: "tuple",
        components: [
          { name: "tcbInfoStr", type: "string" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "attestationId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;

const enclaveIdDaoAbi = [
  {
    name: "upsertEnclaveIdentity",
    type: "function",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "version", type: "uint256" },
      {
        name: "enclaveIdObj",
        type: "tuple",
        components: [
          { name: "identityStr", type: "string" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "attestationId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;

const pcsDaoAbi = [
  {
    name: "upsertPckCrl",
    type: "function",
    inputs: [
      { name: "ca", type: "uint8" },
      { name: "crl", type: "bytes" },
    ],
    outputs: [{ name: "attestationId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    name: "upsertRootCACrl",
    type: "function",
    inputs: [{ name: "rootcacrl", type: "bytes" }],
    outputs: [{ name: "attestationId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    name: "upsertPcsCertificates",
    type: "function",
    inputs: [
      { name: "ca", type: "uint8" },
      { name: "cert", type: "bytes" },
    ],
    outputs: [{ name: "attestationId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;

// CA enum: 0=ROOT, 1=SIGNING, 2=PLATFORM, 3=PROCESSOR
const CA_PLATFORM = 2;
const CA_ROOT = 0;

async function main() {
  const keyHex = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const account = privateKeyToAccount(keyHex as Hex);
  console.log(`Using account: ${account.address}`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);

  // 1. Upsert FMSPC TCB Info
  console.log("\n=== Step 1: Upsert FMSPC TCB Info (eval #18) ===");
  const tcbInfoStr = fs.readFileSync("/tmp/tcb-info-str.txt", "utf-8");
  const tcbSignature = fs.readFileSync("/tmp/tcb-signature.txt", "utf-8").trim() as Hex;

  console.log(`TCB Info length: ${tcbInfoStr.length} chars`);
  console.log(`TCB Signature: ${tcbSignature.slice(0, 20)}...`);

  try {
    const tcbTx = await walletClient.writeContract({
      address: FMSPC_TCB_DAO_18,
      abi: fmspcTcbDaoAbi,
      functionName: "upsertFmspcTcb",
      args: [{ tcbInfoStr, signature: tcbSignature }],
      gas: 10_000_000n,
    });
    console.log(`TCB Info upsert tx: ${tcbTx}`);
    const tcbReceipt = await publicClient.waitForTransactionReceipt({ hash: tcbTx });
    console.log(`TCB Info upsert status: ${tcbReceipt.status}, gas used: ${tcbReceipt.gasUsed}`);
  } catch (e: any) {
    console.error(`TCB Info upsert failed: ${e.message?.slice(0, 200)}`);
  }

  // 2. Upsert QE Identity
  console.log("\n=== Step 2: Upsert QE Identity (eval #18) ===");
  const qeIdentityStr = fs.readFileSync("/tmp/qe-identity-str.txt", "utf-8");
  const qeSignature = fs.readFileSync("/tmp/qe-signature.txt", "utf-8").trim() as Hex;

  console.log(`QE Identity length: ${qeIdentityStr.length} chars`);
  // EnclaveId.QE = 0, pcsApiVersion = 4 (for v4 collateral)
  try {
    const qeTx = await walletClient.writeContract({
      address: QE_ID_DAO_18,
      abi: enclaveIdDaoAbi,
      functionName: "upsertEnclaveIdentity",
      args: [0n, 4n, { identityStr: qeIdentityStr, signature: qeSignature }],
      gas: 5_000_000n,
    });
    console.log(`QE Identity upsert tx: ${qeTx}`);
    const qeReceipt = await publicClient.waitForTransactionReceipt({ hash: qeTx });
    console.log(`QE Identity upsert status: ${qeReceipt.status}, gas used: ${qeReceipt.gasUsed}`);
  } catch (e: any) {
    console.error(`QE Identity upsert failed: ${e.message?.slice(0, 200)}`);
  }

  // 3. Upsert TCB Signing cert chain (needed for TCB info verification)
  console.log("\n=== Step 3: Upsert TCB Signing Certificate Chain ===");
  const rawHeaders = fs.readFileSync("/tmp/tcb-headers.txt", "utf-8");
  const chainMatch = rawHeaders.match(/TCB-Info-Issuer-Chain:\s*(.+)/);
  if (chainMatch) {
    const certChainPem = decodeURIComponent(chainMatch[1].trim());
    const certs = certChainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (certs && certs.length >= 2) {
      // First cert is TCB Signing, second is Root CA
      const signingCertDer = pemToDer(certs[0]);
      const rootCertDer = pemToDer(certs[1]);
      console.log(`TCB Signing cert: ${signingCertDer.length} bytes`);
      console.log(`Root CA cert: ${rootCertDer.length} bytes`);

      // Upsert SIGNING cert (CA=1)
      try {
        const certTx = await walletClient.writeContract({
          address: PCS_DAO,
          abi: pcsDaoAbi,
          functionName: "upsertPcsCertificates",
          args: [1, `0x${Buffer.from(signingCertDer).toString("hex")}` as Hex],
          gas: 3_000_000n,
        });
        console.log(`Signing cert upsert tx: ${certTx}`);
        const certReceipt = await publicClient.waitForTransactionReceipt({ hash: certTx });
        console.log(`Signing cert upsert status: ${certReceipt.status}`);
      } catch (e: any) {
        console.error(`Signing cert upsert failed: ${e.message?.slice(0, 200)}`);
      }

      // Upsert ROOT cert (CA=0)
      try {
        const rootTx = await walletClient.writeContract({
          address: PCS_DAO,
          abi: pcsDaoAbi,
          functionName: "upsertPcsCertificates",
          args: [0, `0x${Buffer.from(rootCertDer).toString("hex")}` as Hex],
          gas: 3_000_000n,
        });
        console.log(`Root cert upsert tx: ${rootTx}`);
        const rootReceipt = await publicClient.waitForTransactionReceipt({ hash: rootTx });
        console.log(`Root cert upsert status: ${rootReceipt.status}`);
      } catch (e: any) {
        console.error(`Root cert upsert failed: ${e.message?.slice(0, 200)}`);
      }
    }
  }

  // 4. Upsert PCK CRL (Platform)
  console.log("\n=== Step 4: Upsert PCK CRL (Platform) ===");
  const pckCrlDer = fs.readFileSync("/tmp/pck-crl-platform.der");
  console.log(`PCK CRL size: ${pckCrlDer.length} bytes`);
  try {
    const crlTx = await walletClient.writeContract({
      address: PCS_DAO,
      abi: pcsDaoAbi,
      functionName: "upsertPckCrl",
      args: [CA_PLATFORM, `0x${pckCrlDer.toString("hex")}` as Hex],
      gas: 3_000_000n,
    });
    console.log(`PCK CRL upsert tx: ${crlTx}`);
    const crlReceipt = await publicClient.waitForTransactionReceipt({ hash: crlTx });
    console.log(`PCK CRL upsert status: ${crlReceipt.status}`);
  } catch (e: any) {
    console.error(`PCK CRL upsert failed: ${e.message?.slice(0, 200)}`);
  }

  // 5. Upsert Root CA CRL
  console.log("\n=== Step 5: Upsert Root CA CRL ===");
  const rootCaCrlHex = fs.readFileSync("/tmp/rootca-crl.hex", "utf-8").trim();
  // Intel returns hex-encoded DER
  const rootCaCrlDer = Buffer.from(rootCaCrlHex, "hex");
  console.log(`Root CA CRL size: ${rootCaCrlDer.length} bytes`);
  try {
    const rootCrlTx = await walletClient.writeContract({
      address: PCS_DAO,
      abi: pcsDaoAbi,
      functionName: "upsertRootCACrl",
      args: [`0x${rootCaCrlDer.toString("hex")}` as Hex],
      gas: 3_000_000n,
    });
    console.log(`Root CA CRL upsert tx: ${rootCrlTx}`);
    const rootCrlReceipt = await publicClient.waitForTransactionReceipt({ hash: rootCrlTx });
    console.log(`Root CA CRL upsert status: ${rootCrlReceipt.status}`);
  } catch (e: any) {
    console.error(`Root CA CRL upsert failed: ${e.message?.slice(0, 200)}`);
  }

  // 6. Final verification — try calling verifyAndAttestOnChain with our quote
  console.log("\n=== Step 6: Test verification with real quote ===");
  const teeResponse = JSON.parse(fs.readFileSync("/tmp/tee-response.json", "utf-8"));
  const quoteHex = `0x${teeResponse.quote}` as Hex;
  console.log(`Quote size: ${teeResponse.quote.length / 2} bytes`);

  try {
    const result = await publicClient.simulateContract({
      address: "0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F",
      abi: [
        {
          name: "verifyAndAttestOnChain",
          type: "function",
          inputs: [{ name: "rawQuote", type: "bytes" }],
          outputs: [
            { name: "success", type: "bool" },
            { name: "output", type: "bytes" },
          ],
          stateMutability: "payable",
        },
      ],
      functionName: "verifyAndAttestOnChain",
      args: [quoteHex],
    });
    console.log(`Verification result: success=${result.result[0]}`);
    if (result.result[0]) {
      console.log(`Output length: ${(result.result[1] as string).length} hex chars`);
      console.log("SGX DCAP QUOTE VERIFIED ON-CHAIN!");
    } else {
      const outputBytes = Buffer.from((result.result[1] as string).slice(2), "hex");
      console.log(`Failure reason: ${outputBytes.toString("ascii")}`);
    }
  } catch (e: any) {
    console.error(`Verification failed: ${e.message?.slice(0, 300)}`);
  }
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

main().catch(console.error);
