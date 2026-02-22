import type { Address } from "viem";

export type ChainName = "baseSepolia";

export interface WhitewallOSAddresses {
  humanVerifiedPolicy: Address;
  whitewallConsumer: Address;
  /** Optional — set after KYC+Credit stack deployment */
  kycPolicy?: Address;
  creditPolicy?: Address;
  stripeKYCValidator?: Address;
  plaidCreditValidator?: Address;
}

/** Protocol-level policy config, read from on-chain HumanVerifiedPolicy */
export interface PolicyConfig {
  identityRegistry: Address;
  worldIdValidator: Address;
  requiredTier: number;
  /** Optional — populated when KYC/credit validators are deployed */
  stripeKYCValidator?: Address;
  plaidCreditValidator?: Address;
  minCreditScore?: number;
}

export const addresses: Record<ChainName, WhitewallOSAddresses> = {
  baseSepolia: {
    humanVerifiedPolicy: "0x8f66f55f4ade4e64b105820972d444a56449e8b3",
    whitewallConsumer: "0xec3114ea6bb29f77b63cd1223533870b663120bb",
    // KYC+Credit addresses — update after deployment
    // kycPolicy: "0x...",
    // creditPolicy: "0x...",
    // stripeKYCValidator: "0x...",
    // plaidCreditValidator: "0x...",
  },
} as const;
