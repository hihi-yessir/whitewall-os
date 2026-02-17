import type { Address } from "viem";

export interface AgentStatus {
  isRegistered: boolean;
  isHumanVerified: boolean;
  tier: number;
  owner: Address;
  agentWallet: Address;
}

export interface AccessGrantedEvent {
  agentId: bigint;
  accountableHuman: Address;
  tier: number;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}
