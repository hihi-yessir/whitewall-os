import type { Address } from "viem";

export type ChainName = "baseSepolia";

export interface WhitewallOSAddresses {
  policyEngine: Address;
  tieredPolicy: Address;
  whitewallConsumer: Address;
  stripeKYCValidator: Address;
  plaidCreditValidator: Address;
  validationRegistry: Address;
  reputationRegistry: Address;
}

/** Protocol-level policy config, read from on-chain TieredPolicy */
export interface PolicyConfig {
  identityRegistry: Address;
  worldIdValidator: Address;
  stripeKYCValidator: Address;
  plaidCreditValidator: Address;
  minCreditScore: number;
}

export const addresses: Record<ChainName, WhitewallOSAddresses> = {
  baseSepolia: {
    policyEngine: "0xc7afccc4b97786e34c07e4444496256d2f2b0b9a",
    tieredPolicy: "0xdb20a5d22cc7eb2a43628527667021121e80e30d",
    whitewallConsumer: "0x9670cc85a97c07a1bb6353fb968c6a2c153db99f",
    stripeKYCValidator: "0xebba79075ad00a22c5ff9a1f36a379f577265936",
    plaidCreditValidator: "0x07e8653b55a3cd703106c9726a140755204c1ad5",
    validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
} as const;
