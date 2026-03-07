"use client";
import { useState, useCallback } from "react";
import {
  IDKitWidget,
  VerificationLevel,
  ISuccessResult,
} from "@worldcoin/idkit";
import {
  decodeAbiParameters,
  parseAbi,
  parseEventLogs,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
} from "viem";
import { baseSepolia } from "viem/chains";

// ============ Configuration ============
// Move these to .env.local for production
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const WORLD_ID_VALIDATOR = "0xcadd809084debc999ce93384806da8ea90318e11" as Address;
const WORLD_ID_APP_ID = "app_staging_dae27f9b14a30e0e0917797aceac795a";
const WORLD_ID_ACTION = "verify-owner";

// ============ ABIs ============
const identityRegistryABI = parseAbi([
  "function register() external returns (uint256 agentId)",
  "function register(string agentURI) external returns (uint256 agentId)",
  "function approve(address to, uint256 tokenId) external",
  "function getApproved(uint256 tokenId) external view returns (address)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

const worldIDValidatorABI = parseAbi([
  "function verifyAndSetHumanTag(uint256 agentId, uint256 root, uint256 nullifierHash, uint256[8] proof) external",
  "function isHumanVerified(uint256 agentId) external view returns (bool)",
  "function getVerificationData(uint256 agentId) external view returns (bool isVerified, uint256 nullifierHash, uint256 verifiedAt, address verifiedBy)",
  "function isNullifierUsed(uint256 nullifierHash) external view returns (bool)",
  "error InvalidProof()",
  "error AlreadyVerified(uint256 agentId)",
  "error NullifierAlreadyUsed(uint256 nullifierHash)",
  "error NotApproved(uint256 agentId)",
  "error NotAgentOwner(uint256 agentId)",
  "error NotVerified(uint256 agentId)",
]);

// ============ Types ============
type Step = "connect" | "register" | "approve" | "verify" | "done";

interface LogEntry {
  type: "info" | "success" | "error" | "pending";
  message: string;
  timestamp: Date;
}

// ============ Error Decoder ============
function decodeContractError(error: unknown): string {
  if (error instanceof BaseError) {
    const revertError = error.walk(
      (err) => err instanceof ContractFunctionRevertedError
    );
    if (revertError instanceof ContractFunctionRevertedError) {
      const errorName = revertError.data?.errorName;
      if (errorName) {
        switch (errorName) {
          case "NotApproved":
            return "WorldIDValidator is not approved for this agent. Run the 'Approve' step first.";
          case "AlreadyVerified":
            return "This agent is already human-verified.";
          case "NullifierAlreadyUsed":
            return "This World ID has already been used to verify another agent (sybil protection).";
          case "NotAgentOwner":
            return "You are not the owner of this agent.";
          case "InvalidProof":
            return "World ID proof verification failed. The ZK proof is invalid.";
          case "NotVerified":
            return "This agent is not verified.";
          default:
            return `Contract error: ${errorName}`;
        }
      }
    }
    return error.shortMessage || error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// ============ Component ============
export default function Home() {
  const [step, setStep] = useState<Step>("connect");
  const [account, setAccount] = useState<Address | null>(null);
  const [agentId, setAgentId] = useState<bigint | null>(null);
  const [agentIdInput, setAgentIdInput] = useState<string>("");
  const [isApproved, setIsApproved] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [useExistingAgent, setUseExistingAgent] = useState(false);

  const addLog = useCallback((type: LogEntry["type"], message: string) => {
    setLogs((prev) => [...prev, { type, message, timestamp: new Date() }]);
  }, []);

  const getClients = useCallback(async () => {
    if (!window.ethereum) throw new Error("MetaMask not detected");
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });
    const [addr] = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    const walletClient = createWalletClient({
      account: addr as Address,
      chain: baseSepolia,
      transport: custom(window.ethereum),
    });
    return { publicClient, walletClient, account: addr as Address };
  }, []);

  // ============ Step 1: Connect Wallet ============
  const handleConnect = async () => {
    setLoading(true);
    try {
      const { account: addr, publicClient } = await getClients();
      setAccount(addr);
      addLog("success", `Wallet connected: ${addr}`);

      // Check chain
      const chainId = await publicClient.getChainId();
      if (chainId !== baseSepolia.id) {
        addLog("error", `Wrong chain! Please switch to Base Sepolia (chainId: ${baseSepolia.id})`);
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${baseSepolia.id.toString(16)}` }],
          });
          addLog("success", "Switched to Base Sepolia");
        } catch {
          addLog("error", "Failed to switch chain. Please switch manually.");
          return;
        }
      }

      setStep("register");
    } catch (err) {
      addLog("error", decodeContractError(err));
    } finally {
      setLoading(false);
    }
  };

  // ============ Step 2: Register Agent ============
  const handleRegister = async () => {
    setLoading(true);
    try {
      const { publicClient, walletClient } = await getClients();

      addLog("pending", "Registering new agent on IdentityRegistry...");
      const hash = await walletClient.writeContract({
        chain: baseSepolia,
        account: walletClient.account!,
        address: IDENTITY_REGISTRY,
        abi: identityRegistryABI,
        functionName: "register",
      });
      addLog("info", `Tx sent: ${hash}`);
      addLog("pending", "Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        addLog("error", "Registration transaction reverted");
        return;
      }

      // Parse Transfer event to get agentId (ERC-721 mint)
      const transferEvents = parseEventLogs({
        abi: identityRegistryABI,
        logs: receipt.logs,
        eventName: "Transfer",
      });

      if (transferEvents.length === 0) {
        addLog("error", "Could not find agentId from Transfer event");
        return;
      }

      const newAgentId = transferEvents[0].args.tokenId;
      setAgentId(newAgentId);
      addLog("success", `Agent registered! agentId: ${newAgentId}`);
      setStep("approve");
    } catch (err) {
      addLog("error", decodeContractError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleUseExisting = async () => {
    setLoading(true);
    try {
      const parsed = BigInt(agentIdInput);
      const { publicClient } = await getClients();

      // Verify ownership
      const owner = await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryABI,
        functionName: "ownerOf",
        args: [parsed],
      });

      if (owner.toLowerCase() !== account?.toLowerCase()) {
        addLog("error", `You don't own agent #${parsed}. Owner is ${owner}`);
        return;
      }

      setAgentId(parsed);
      addLog("success", `Using existing agent #${parsed}`);

      // Check if already approved
      const approved = await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryABI,
        functionName: "getApproved",
        args: [parsed],
      });

      if (approved.toLowerCase() === WORLD_ID_VALIDATOR.toLowerCase()) {
        addLog("info", "WorldIDValidator already approved for this agent");
        setIsApproved(true);

        // Check if already verified
        const verified = await publicClient.readContract({
          address: WORLD_ID_VALIDATOR,
          abi: worldIDValidatorABI,
          functionName: "isHumanVerified",
          args: [parsed],
        });
        if (verified) {
          addLog("success", "This agent is already human-verified!");
          setIsVerified(true);
          setStep("done");
          return;
        }
        setStep("verify");
      } else {
        setStep("approve");
      }
    } catch (err) {
      addLog("error", decodeContractError(err));
    } finally {
      setLoading(false);
    }
  };

  // ============ Step 3: Approve ============
  const handleApprove = async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const { publicClient, walletClient } = await getClients();

      addLog(
        "pending",
        `Approving WorldIDValidator (${WORLD_ID_VALIDATOR}) for agent #${agentId}...`
      );
      const hash = await walletClient.writeContract({
        chain: baseSepolia,
        account: walletClient.account!,
        address: IDENTITY_REGISTRY,
        abi: identityRegistryABI,
        functionName: "approve",
        args: [WORLD_ID_VALIDATOR, agentId],
      });
      addLog("info", `Tx sent: ${hash}`);
      addLog("pending", "Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        addLog("error", "Approve transaction reverted");
        return;
      }

      // Double-check
      const approved = await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryABI,
        functionName: "getApproved",
        args: [agentId],
      });
      if (approved.toLowerCase() !== WORLD_ID_VALIDATOR.toLowerCase()) {
        addLog("error", "Approval verification failed");
        return;
      }

      setIsApproved(true);
      addLog("success", "WorldIDValidator approved! Ready for verification.");
      setStep("verify");
    } catch (err) {
      addLog("error", decodeContractError(err));
    } finally {
      setLoading(false);
    }
  };

  // ============ Step 4: World ID Verification ============
  const handleWorldIDSuccess = async (result: ISuccessResult) => {
    if (!agentId || !account) return;
    setLoading(true);
    try {
      const { publicClient, walletClient } = await getClients();

      addLog("info", "World ID proof received, decoding...");

      const unpackedProof = decodeAbiParameters(
        [{ type: "uint256[8]" }],
        result.proof as `0x${string}`
      )[0];
      const root = BigInt(result.merkle_root);
      const nullifierHash = BigInt(result.nullifier_hash);

      addLog("info", `Merkle root: ${result.merkle_root.slice(0, 20)}...`);
      addLog("info", `Nullifier: ${result.nullifier_hash.slice(0, 20)}...`);

      // Pre-flight checks
      addLog("pending", "Running pre-flight checks...");

      const alreadyUsed = await publicClient.readContract({
        address: WORLD_ID_VALIDATOR,
        abi: worldIDValidatorABI,
        functionName: "isNullifierUsed",
        args: [nullifierHash],
      });
      if (alreadyUsed) {
        addLog(
          "error",
          "This World ID nullifier is already used. Sybil protection: 1 human = 1 agent."
        );
        return;
      }

      const approved = await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryABI,
        functionName: "getApproved",
        args: [agentId],
      });
      if (approved.toLowerCase() !== WORLD_ID_VALIDATOR.toLowerCase()) {
        addLog("error", "WorldIDValidator is not approved! Go back to approve step.");
        return;
      }

      addLog("success", "Pre-flight checks passed");
      addLog("pending", "Sending verifyAndSetHumanTag transaction...");

      const hash = await walletClient.writeContract({
        chain: baseSepolia,
        account: walletClient.account!,
        address: WORLD_ID_VALIDATOR,
        abi: worldIDValidatorABI,
        functionName: "verifyAndSetHumanTag",
        args: [agentId, root, nullifierHash, unpackedProof],
      });

      addLog("info", `Tx sent: ${hash}`);
      addLog("pending", "Waiting for on-chain confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      if (receipt.status === "success") {
        setIsVerified(true);
        setStep("done");
        addLog("success", "Agent is now HUMAN VERIFIED!");
        addLog(
          "success",
          `View tx: https://sepolia.basescan.org/tx/${hash}`
        );
      } else {
        addLog("error", "Transaction reverted on-chain. Check BaseScan for details.");
        addLog("info", `https://sepolia.basescan.org/tx/${hash}`);
      }
    } catch (err) {
      addLog("error", decodeContractError(err));
    } finally {
      setLoading(false);
    }
  };

  // ============ Render ============
  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Auth-OS: Agent Verification</h1>
        <p className="text-gray-400 mb-8">
          Bond your AI agent to your human identity via World ID
        </p>

        {/* Progress Steps */}
        <div className="flex gap-2 mb-8">
          {(["connect", "register", "approve", "verify", "done"] as Step[]).map(
            (s, i) => (
              <div
                key={s}
                className={`flex-1 h-2 rounded ${
                  step === s
                    ? "bg-blue-500"
                    : (["connect", "register", "approve", "verify", "done"].indexOf(step) > i)
                    ? "bg-green-500"
                    : "bg-gray-700"
                }`}
              />
            )
          )}
        </div>

        {/* Action Panel */}
        <div className="bg-gray-900 rounded-xl p-6 mb-6 border border-gray-800">
          {/* Step 1: Connect */}
          {step === "connect" && (
            <div>
              <h2 className="text-xl font-semibold mb-4">
                Step 1: Connect Wallet
              </h2>
              <p className="text-gray-400 mb-4">
                Connect your wallet to Base Sepolia to get started.
              </p>
              <button
                onClick={handleConnect}
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold"
              >
                {loading ? "Connecting..." : "Connect Wallet"}
              </button>
            </div>
          )}

          {/* Step 2: Register */}
          {step === "register" && (
            <div>
              <h2 className="text-xl font-semibold mb-4">
                Step 2: Register Agent
              </h2>
              <p className="text-gray-400 mb-4">
                Register a new agent NFT on the ERC-8004 IdentityRegistry, or use an existing one.
              </p>

              <div className="flex gap-4 mb-4">
                <button
                  onClick={() => setUseExistingAgent(false)}
                  className={`px-4 py-2 rounded ${
                    !useExistingAgent
                      ? "bg-blue-600"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                >
                  Register New
                </button>
                <button
                  onClick={() => setUseExistingAgent(true)}
                  className={`px-4 py-2 rounded ${
                    useExistingAgent
                      ? "bg-blue-600"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                >
                  Use Existing
                </button>
              </div>

              {useExistingAgent ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Agent ID (e.g. 563)"
                    value={agentIdInput}
                    onChange={(e) => setAgentIdInput(e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-4 py-3 text-white"
                  />
                  <button
                    onClick={handleUseExisting}
                    disabled={loading || !agentIdInput}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold"
                  >
                    {loading ? "Checking..." : "Use This Agent"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleRegister}
                  disabled={loading}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold"
                >
                  {loading ? "Registering..." : "Register New Agent"}
                </button>
              )}
            </div>
          )}

          {/* Step 3: Approve */}
          {step === "approve" && (
            <div>
              <h2 className="text-xl font-semibold mb-4">
                Step 3: Approve WorldIDValidator
              </h2>
              <p className="text-gray-400 mb-4">
                Grant the WorldIDValidator contract permission to write
                &quot;humanVerified&quot; metadata to your agent (#{agentId?.toString()}).
              </p>
              <button
                onClick={handleApprove}
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold"
              >
                {loading ? "Approving..." : "Approve WorldIDValidator"}
              </button>
            </div>
          )}

          {/* Step 4: Verify */}
          {step === "verify" && (
            <div>
              <h2 className="text-xl font-semibold mb-4">
                Step 4: Verify with World ID
              </h2>
              <p className="text-gray-400 mb-4">
                Prove you&apos;re a unique human. This bonds your identity to agent
                #{agentId?.toString()}.
              </p>
              <IDKitWidget
                app_id={WORLD_ID_APP_ID as `app_${string}`}
                action={WORLD_ID_ACTION}
                onSuccess={handleWorldIDSuccess}
                handleVerify={handleWorldIDSuccess}
                verification_level={VerificationLevel.Device}
                signal={account || undefined}
              >
                {({ open }) => (
                  <button
                    onClick={open}
                    disabled={loading}
                    className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold"
                  >
                    {loading
                      ? "Verifying..."
                      : "Verify with World ID"}
                  </button>
                )}
              </IDKitWidget>
            </div>
          )}

          {/* Done */}
          {step === "done" && (
            <div className="text-center">
              <div className="text-5xl mb-4">&#x2705;</div>
              <h2 className="text-2xl font-bold text-green-400 mb-2">
                Human Verified!
              </h2>
              <p className="text-gray-400">
                Agent #{agentId?.toString()} is now cryptographically bonded to
                your human identity.
              </p>
            </div>
          )}
        </div>

        {/* Status Bar */}
        {account && (
          <div className="bg-gray-900 rounded-xl p-4 mb-6 border border-gray-800 flex flex-wrap gap-4 text-sm">
            <div>
              <span className="text-gray-500">Wallet: </span>
              <span className="font-mono">
                {account.slice(0, 6)}...{account.slice(-4)}
              </span>
            </div>
            {agentId !== null && (
              <div>
                <span className="text-gray-500">Agent: </span>
                <span className="font-mono">#{agentId.toString()}</span>
              </div>
            )}
            <div>
              <span className="text-gray-500">Approved: </span>
              <span className={isApproved ? "text-green-400" : "text-red-400"}>
                {isApproved ? "Yes" : "No"}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Verified: </span>
              <span className={isVerified ? "text-green-400" : "text-red-400"}>
                {isVerified ? "Yes" : "No"}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Chain: </span>
              <span>Base Sepolia</span>
            </div>
          </div>
        )}

        {/* Live Terminal */}
        <div className="bg-black rounded-xl border border-gray-800 overflow-hidden">
          <div className="bg-gray-900 px-4 py-2 flex items-center gap-2 border-b border-gray-800">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="ml-2 text-gray-400 text-sm font-mono">
              auth-os terminal
            </span>
          </div>
          <div className="p-4 h-64 overflow-y-auto font-mono text-sm">
            {logs.length === 0 && (
              <div className="text-gray-600">
                Waiting for actions...
              </div>
            )}
            {logs.map((log, i) => (
              <div key={i} className="mb-1">
                <span className="text-gray-600">
                  [{log.timestamp.toLocaleTimeString()}]
                </span>{" "}
                <span
                  className={
                    log.type === "success"
                      ? "text-green-400"
                      : log.type === "error"
                      ? "text-red-400"
                      : log.type === "pending"
                      ? "text-yellow-400"
                      : "text-gray-300"
                  }
                >
                  {log.type === "success"
                    ? "[OK]"
                    : log.type === "error"
                    ? "[ERR]"
                    : log.type === "pending"
                    ? "[...]"
                    : "[INFO]"}
                </span>{" "}
                <span className="text-gray-200">{log.message}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Contract Addresses */}
        <div className="mt-6 text-xs text-gray-600 font-mono">
          <div>IdentityRegistry: {IDENTITY_REGISTRY}</div>
          <div>WorldIDValidator: {WORLD_ID_VALIDATOR}</div>
        </div>
      </div>
    </main>
  );
}
