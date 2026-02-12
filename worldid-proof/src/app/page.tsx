"use client";
import { IDKitWidget, VerificationLevel, ISuccessResult } from "@worldcoin/idkit";
import { decodeAbiParameters, parseAbi, createPublicClient, createWalletClient, custom, keccak256, encodePacked, http } from "viem";
import { baseSepolia } from "viem/chains";

export default function Home() {
  const contractABI = parseAbi([
    "function verifyAndSetHumanTag(uint256 agentId, uint256 root, uint256 nullifierHash, uint256[8] proof) external"
  ]);

  const handleVerify = async (result: ISuccessResult) => {
    // 1. 클라이언트 설정
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
    const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: custom(window.ethereum) });

    try {
      const unpackedProof = decodeAbiParameters([{ type: "uint256[8]" }], result.proof as `0x${string}`)[0];
      const agentId = 563n;
      const root = BigInt(result.merkle_root);
      const nullifierHash = BigInt(result.nullifier_hash);

      console.log("🚀 트랜잭션 전송 중...");
      
      // 2. 트랜잭션 전송
      const hash = await walletClient.writeContract({
        address: "0xff7fd06a8213d3aeefd0a2f61c0ebdabf32ccbda",
        abi: contractABI,
        functionName: "verifyAndSetHumanTag",
        args: [agentId, root, nullifierHash, unpackedProof],
        gas: 2000000n, // 가스 한도 더 넉넉히 올렸습니다
      });

      console.log("⏳ 블록체인 기록 대기 중... (Hash:", hash, ")");
      
      // 3. ⭐️ 핵심: 트랜잭션이 실제로 블록에 포함될 때까지 대기
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      
      if (receipt.status === "success") {
        console.log("✅ 온체인 기록 성공!");
        alert("축하합니다! 에이전트에 인간 인증 태그가 박혔습니다.");
      } else {
        // 4. 실패했을 경우 상세 에러 추적
        console.error("❌ 트랜잭션 실행 실패 (Reverted)");
        alert("트랜잭션이 전송은 됐으나 온체인에서 거절되었습니다. 콘솔을 확인하세요.");
      }

    } catch (error: any) {
      // 5. RPC 에러나 거절 이유 상세 출력
      console.error("📋 상세 에러 정보:", error);
      
      // 에러 메시지에 'AlreadyVerified'나 'InvalidProof' 같은 커스텀 에러명이 포함되어 있는지 확인하세요
      const errorMsg = error.shortMessage || error.message || "알 수 없는 에러";
      alert(`실패 원인: ${errorMsg}`);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-2xl font-bold mb-8">에이전트 인간 인증 시스템</h1>
      <IDKitWidget
        app_id="app_staging_dae27f9b14a30e0e0917797aceac795a"
        action="verify-owner"
        handleVerify={handleVerify}
        verification_level={VerificationLevel.Device}
        signal="0x0d10f69243b8a2fe4299fa4cc115c3023f4011cf"
      >
        {({ open }) => (
          <button onClick={open} className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold">
            World ID로 인증 시작
          </button>
        )}
      </IDKitWidget>
    </main>
  );
}