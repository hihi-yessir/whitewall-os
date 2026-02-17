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
  humanVerifiedPolicyAbi,
  identityRegistryAbi,
  worldIdValidatorAbi,
  whitewallConsumerAbi,
} from "./abis.js";
import { addresses, type ChainName, type WhitewallOSAddresses, type PolicyConfig } from "./addresses.js";
import type { AgentStatus, AccessGrantedEvent } from "./types.js";

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
   * Reads policy config from on-chain HumanVerifiedPolicy contract.
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

  /** Read policy configuration from the on-chain HumanVerifiedPolicy contract */
  private async loadPolicyConfig(): Promise<void> {
    const [identityRegistry, worldIdValidator, requiredTier] =
      await Promise.all([
        this.client.readContract({
          address: this.addrs.humanVerifiedPolicy,
          abi: humanVerifiedPolicyAbi,
          functionName: "getIdentityRegistry",
        }),
        this.client.readContract({
          address: this.addrs.humanVerifiedPolicy,
          abi: humanVerifiedPolicyAbi,
          functionName: "getWorldIdValidator",
        }),
        this.client.readContract({
          address: this.addrs.humanVerifiedPolicy,
          abi: humanVerifiedPolicyAbi,
          functionName: "getRequiredTier",
        }),
      ]);

    this.policy = { identityRegistry, worldIdValidator, requiredTier };
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

    const tier = humanVerified ? this.policyConfig.requiredTier : 1;

    return {
      isRegistered: true,
      isHumanVerified: humanVerified,
      tier,
      owner,
      agentWallet,
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
