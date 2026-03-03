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
  worldIdValidatorAbi,
  whitewallConsumerAbi,
  stripeKYCValidatorAbi,
  plaidCreditValidatorAbi,
} from "./abis.js";
import { addresses, type ChainName, type WhitewallOSAddresses, type PolicyConfig } from "./addresses.js";
import type { AgentStatus, FullAgentStatus, AccessGrantedEvent } from "./types.js";

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
