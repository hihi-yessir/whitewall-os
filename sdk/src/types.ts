import type { Address } from "viem";

export interface AgentStatus {
  isRegistered: boolean;
  isHumanVerified: boolean;
  tier: number;
  owner: Address;
  agentWallet: Address;
}

export interface FullAgentStatus extends AgentStatus {
  isKYCVerified: boolean;
  creditScore: number;
  effectiveTier: number; // 0-4 computed from all verification states
}

export interface AccessGrantedEvent {
  agentId: bigint;
  accountableHuman: Address;
  tier: number;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}
