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

export interface AccessDeniedEvent {
  agentId: bigint;
  reason: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

export interface ValidationSummary {
  count: bigint;
  avgResponse: number;
}

export interface ValidationStatus {
  validatorAddress: Address;
  agentId: bigint;
  response: number;
  responseHash: `0x${string}`;
  tag: string;
  lastUpdate: bigint;
}

export interface ValidationRequestEvent {
  validatorAddress: Address;
  agentId: bigint;
  requestURI: string;
  requestHash: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

export interface ValidationResponseEvent {
  validatorAddress: Address;
  agentId: bigint;
  requestHash: `0x${string}`;
  response: number;
  responseURI: string;
  responseHash: `0x${string}`;
  tag: string;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

export interface KYCData {
  verified: boolean;
  sessionHash: `0x${string}`;
  verifiedAt: bigint;
}

export interface CreditData {
  score: number;
  dataHash: `0x${string}`;
  verifiedAt: bigint;
  hasScore: boolean;
}

export interface SgxConfig {
  verifier: Address;
  mrEnclave: `0x${string}`;
}

export interface CreditScoreSetEvent {
  agentId: bigint;
  score: number;
  dataHash: `0x${string}`;
  timestamp: bigint;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}
