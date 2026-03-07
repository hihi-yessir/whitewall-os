import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
  type WatchEventReturnType,
  zeroAddress,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  tieredPolicyAbi,
  identityRegistryAbi,
  validationRegistryAbi,
  worldIdValidatorAbi,
  whitewallConsumerAbi,
  stripeKYCValidatorAbi,
  plaidCreditValidatorAbi,
} from "./abis.js";
import { addresses, type ChainName, type WhitewallOSAddresses, type PolicyConfig } from "./addresses.js";
import type {
  AgentStatus,
  FullAgentStatus,
  AccessGrantedEvent,
  AccessDeniedEvent,
  ValidationSummary,
  ValidationStatus,
  ValidationRequestEvent,
  ValidationResponseEvent,
  KYCData,
  CreditData,
  SgxConfig,
  CreditScoreSetEvent,
} from "./types.js";

const chainMap: Record<ChainName, Chain> = {
  baseSepolia,
};

export interface WhitewallOSConfig {
  chain: ChainName;
  rpcUrl?: string;
  /** Pass your own viem PublicClient to skip internal client creation */
  publicClient?: PublicClient<Transport, Chain>;
}

export class WhitewallOS {
  private client: PublicClient<Transport, Chain>;
  private addrs: WhitewallOSAddresses;
  private policy: PolicyConfig | null = null;

  private constructor(client: PublicClient<Transport, Chain>, addrs: WhitewallOSAddresses) {
    this.client = client;
    this.addrs = addrs;
  }

  /**
   * Create and connect a WhitewallOS instance.
   * Reads policy config from on-chain TieredPolicy contract.
   */
  static async connect(config: WhitewallOSConfig): Promise<WhitewallOS> {
    const addrs = addresses[config.chain];
    const client =
      config.publicClient ??
      createPublicClient({
        chain: chainMap[config.chain],
        transport: http(config.rpcUrl),
      });

    const instance = new WhitewallOS(client, addrs);
    await instance.loadPolicyConfig();
    return instance;
  }

  /** Read policy configuration from the on-chain TieredPolicy contract */
  private async loadPolicyConfig(): Promise<void> {
    const [identityRegistry, worldIdValidator, stripeKYCValidator, plaidCreditValidator, minCreditScore] =
      await Promise.all([
        this.client.readContract({
          address: this.addrs.tieredPolicy,
          abi: tieredPolicyAbi,
          functionName: "getIdentityRegistry",
        }),
        this.client.readContract({
          address: this.addrs.tieredPolicy,
          abi: tieredPolicyAbi,
          functionName: "getWorldIdValidator",
        }),
        this.client.readContract({
          address: this.addrs.tieredPolicy,
          abi: tieredPolicyAbi,
          functionName: "getStripeKYCValidator",
        }),
        this.client.readContract({
          address: this.addrs.tieredPolicy,
          abi: tieredPolicyAbi,
          functionName: "getPlaidCreditValidator",
        }),
        this.client.readContract({
          address: this.addrs.tieredPolicy,
          abi: tieredPolicyAbi,
          functionName: "getMinCreditScore",
        }),
      ]);

    this.policy = {
      identityRegistry,
      worldIdValidator,
      stripeKYCValidator,
      plaidCreditValidator,
      minCreditScore,
    };
  }

  private get policyConfig(): PolicyConfig {
    if (!this.policy) throw new Error("WhitewallOS not connected. Use WhitewallOS.connect()");
    return this.policy;
  }

  // ─── Core Read Methods ───

  async isRegistered(agentId: bigint): Promise<boolean> {
    try {
      const owner = await this.client.readContract({
        address: this.policyConfig.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
      });
      return owner !== zeroAddress;
    } catch {
      return false;
    }
  }

  async isHumanVerified(agentId: bigint): Promise<boolean> {
    return this.client.readContract({
      address: this.policyConfig.worldIdValidator,
      abi: worldIdValidatorAbi,
      functionName: "isHumanVerified",
      args: [agentId],
    });
  }

  async getOwner(agentId: bigint): Promise<Address> {
    return this.client.readContract({
      address: this.policyConfig.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
  }

  async getAgentWallet(agentId: bigint): Promise<Address> {
    return this.client.readContract({
      address: this.policyConfig.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    });
  }

  async getTokenURI(agentId: bigint): Promise<string> {
    return this.client.readContract({
      address: this.policyConfig.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [agentId],
    });
  }

  async getMetadata(agentId: bigint, key: string): Promise<`0x${string}`> {
    return this.client.readContract({
      address: this.policyConfig.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "getMetadata",
      args: [agentId, key],
    });
  }

  async balanceOf(owner: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.policyConfig.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  // ─── KYC & Credit Read Methods ───

  async isKYCVerified(agentId: bigint): Promise<boolean> {
    const addr = this.policyConfig.stripeKYCValidator ?? this.addrs.stripeKYCValidator;
    if (!addr) return false;
    try {
      return await this.client.readContract({
        address: addr,
        abi: stripeKYCValidatorAbi,
        functionName: "isKYCVerified",
        args: [agentId],
      });
    } catch {
      return false;
    }
  }

  async getKYCData(agentId: bigint): Promise<KYCData> {
    const addr = this.policyConfig.stripeKYCValidator ?? this.addrs.stripeKYCValidator;
    try {
      const [verified, sessionHash, verifiedAt] = await this.client.readContract({
        address: addr,
        abi: stripeKYCValidatorAbi,
        functionName: "getKYCData",
        args: [agentId],
      });
      return { verified, sessionHash, verifiedAt };
    } catch {
      return {
        verified: false,
        sessionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        verifiedAt: 0n,
      };
    }
  }

  async getCreditScore(agentId: bigint): Promise<number> {
    const addr = this.policyConfig.plaidCreditValidator ?? this.addrs.plaidCreditValidator;
    if (!addr) return 0;
    try {
      return await this.client.readContract({
        address: addr,
        abi: plaidCreditValidatorAbi,
        functionName: "getCreditScore",
        args: [agentId],
      });
    } catch {
      return 0;
    }
  }

  async hasCreditScore(agentId: bigint): Promise<boolean> {
    const addr = this.policyConfig.plaidCreditValidator ?? this.addrs.plaidCreditValidator;
    if (!addr) return false;
    try {
      return await this.client.readContract({
        address: addr,
        abi: plaidCreditValidatorAbi,
        functionName: "hasCreditScore",
        args: [agentId],
      });
    } catch {
      return false;
    }
  }

  async getCreditData(agentId: bigint): Promise<CreditData> {
    const addr = this.policyConfig.plaidCreditValidator ?? this.addrs.plaidCreditValidator;
    try {
      const [score, dataHash, verifiedAt, hasScore] = await this.client.readContract({
        address: addr,
        abi: plaidCreditValidatorAbi,
        functionName: "getCreditData",
        args: [agentId],
      });
      return { score, dataHash, verifiedAt, hasScore };
    } catch {
      return {
        score: 0,
        dataHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        verifiedAt: 0n,
        hasScore: false,
      };
    }
  }

  // ─── TEE / SGX ───

  async getSgxConfig(): Promise<SgxConfig> {
    const addr = this.policyConfig.plaidCreditValidator ?? this.addrs.plaidCreditValidator;
    const [verifier, mrEnclave] = await this.client.readContract({
      address: addr,
      abi: plaidCreditValidatorAbi,
      functionName: "getSgxConfig",
    });
    return { verifier, mrEnclave };
  }

  async isTeeEnabled(): Promise<boolean> {
    const config = await this.getSgxConfig();
    return config.verifier !== zeroAddress;
  }

  // ─── ValidationRegistry ───

  async getValidationSummary(agentId: bigint, validators: Address[] = [], tag = ""): Promise<ValidationSummary> {
    const [count, avgResponse] = await this.client.readContract({
      address: this.addrs.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "getSummary",
      args: [agentId, validators, tag],
    });
    return { count, avgResponse };
  }

  async getAgentValidations(agentId: bigint): Promise<readonly `0x${string}`[]> {
    return this.client.readContract({
      address: this.addrs.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "getAgentValidations",
      args: [agentId],
    });
  }

  async getValidationStatus(requestHash: `0x${string}`): Promise<ValidationStatus> {
    const [validatorAddress, agentId, response, responseHash, tag, lastUpdate] =
      await this.client.readContract({
        address: this.addrs.validationRegistry,
        abi: validationRegistryAbi,
        functionName: "getValidationStatus",
        args: [requestHash],
      });
    return { validatorAddress, agentId, response, responseHash, tag, lastUpdate };
  }

  async getValidatorRequests(validatorAddress: Address): Promise<readonly `0x${string}`[]> {
    return this.client.readContract({
      address: this.addrs.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "getValidatorRequests",
      args: [validatorAddress],
    });
  }

  // ─── Composite: Full Status ───

  async getAgentStatus(agentId: bigint): Promise<AgentStatus> {
    const registered = await this.isRegistered(agentId);
    if (!registered) {
      return {
        isRegistered: false,
        isHumanVerified: false,
        tier: 0,
        owner: zeroAddress,
        agentWallet: zeroAddress,
      };
    }

    const [owner, agentWallet, humanVerified] = await Promise.all([
      this.getOwner(agentId),
      this.getAgentWallet(agentId),
      this.isHumanVerified(agentId),
    ]);

    const tier = humanVerified ? 2 : 1;

    return {
      isRegistered: true,
      isHumanVerified: humanVerified,
      tier,
      owner,
      agentWallet,
    };
  }

  async getFullStatus(agentId: bigint): Promise<FullAgentStatus> {
    const base = await this.getAgentStatus(agentId);
    if (!base.isRegistered) {
      return {
        ...base,
        isKYCVerified: false,
        creditScore: 0,
        effectiveTier: 0,
      };
    }

    const [kycVerified, creditScore] = await Promise.all([
      this.isKYCVerified(agentId),
      this.getCreditScore(agentId),
    ]);

    // Compute effective tier (cumulative):
    // 0 = not registered, 1 = registered, 2 = human verified,
    // 3 = + KYC, 4 = + credit score
    let effectiveTier = base.tier; // 1 or 2
    if (base.isHumanVerified && kycVerified) {
      effectiveTier = 3;
      const minScore = this.policyConfig.minCreditScore ?? 50;
      if (creditScore >= minScore) {
        effectiveTier = 4;
      }
    }

    return {
      ...base,
      isKYCVerified: kycVerified,
      creditScore,
      effectiveTier,
    };
  }

  // ─── Event Watching ───

  onAccessGranted(
    callback: (event: AccessGrantedEvent) => void,
  ): WatchEventReturnType {
    return this.client.watchEvent({
      address: this.addrs.whitewallConsumer,
      event: whitewallConsumerAbi[0], // AccessGranted
      onLogs: (logs) => {
        for (const log of logs) {
          callback({
            agentId: (log as any).args.agentId,
            accountableHuman: (log as any).args.accountableHuman,
            tier: Number((log as any).args.tier),
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
          });
        }
      },
    });
  }

  onAccessDenied(
    callback: (event: AccessDeniedEvent) => void,
  ): WatchEventReturnType {
    return this.client.watchEvent({
      address: this.addrs.whitewallConsumer,
      event: whitewallConsumerAbi[1], // AccessDenied
      onLogs: (logs) => {
        for (const log of logs) {
          callback({
            agentId: (log as any).args.agentId,
            reason: (log as any).args.reason,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
          });
        }
      },
    });
  }

  onRegistered(
    callback: (agentId: bigint, owner: Address) => void,
  ): WatchEventReturnType {
    return this.client.watchEvent({
      address: this.policyConfig.identityRegistry,
      event: identityRegistryAbi[5], // Registered event
      onLogs: (logs) => {
        for (const log of logs) {
          callback(
            (log as any).args.agentId,
            (log as any).args.owner,
          );
        }
      },
    });
  }

  onValidationRequest(
    callback: (event: ValidationRequestEvent) => void,
  ): WatchEventReturnType {
    return this.client.watchEvent({
      address: this.addrs.validationRegistry,
      event: validationRegistryAbi[4], // ValidationRequest event
      onLogs: (logs) => {
        for (const log of logs) {
          callback({
            validatorAddress: (log as any).args.validatorAddress,
            agentId: (log as any).args.agentId,
            requestURI: (log as any).args.requestURI,
            requestHash: (log as any).args.requestHash,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
          });
        }
      },
    });
  }

  onValidationResponse(
    callback: (event: ValidationResponseEvent) => void,
  ): WatchEventReturnType {
    return this.client.watchEvent({
      address: this.addrs.validationRegistry,
      event: validationRegistryAbi[5], // ValidationResponse event
      onLogs: (logs) => {
        for (const log of logs) {
          callback({
            validatorAddress: (log as any).args.validatorAddress,
            agentId: (log as any).args.agentId,
            requestHash: (log as any).args.requestHash,
            response: Number((log as any).args.response),
            responseURI: (log as any).args.responseURI,
            responseHash: (log as any).args.responseHash,
            tag: (log as any).args.tag,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
          });
        }
      },
    });
  }

  onCreditScoreSet(
    callback: (event: CreditScoreSetEvent) => void,
  ): WatchEventReturnType {
    return this.client.watchEvent({
      address: this.policyConfig.plaidCreditValidator,
      event: plaidCreditValidatorAbi[3], // CreditScoreSet event
      onLogs: (logs) => {
        for (const log of logs) {
          callback({
            agentId: (log as any).args.agentId,
            score: Number((log as any).args.score),
            dataHash: (log as any).args.dataHash,
            timestamp: (log as any).args.timestamp,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
          });
        }
      },
    });
  }

  // ─── Utilities ───

  getAddresses(): WhitewallOSAddresses {
    return this.addrs;
  }

  getPolicyConfig(): PolicyConfig {
    return this.policyConfig;
  }

  getPublicClient(): PublicClient<Transport, Chain> {
    return this.client;
  }
}
