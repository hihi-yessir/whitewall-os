import type { Address } from "viem";

export type ChainName = "baseSepolia";

export interface WhitewallOSAddresses {
  policyEngine: Address;
  tieredPolicy: Address;
  whitewallConsumer: Address;
  stripeKYCValidator: Address;
  plaidCreditValidator: Address;
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
    policyEngine: "0x12816c0c79981726627a550b73e9627b81be95be",
    tieredPolicy: "0x63b4d2e051180c3c0313eb71a9bdda8554432e23",
    whitewallConsumer: "0xb5845901c590f06ffa480c31b96aca7eff4dfb3e",
    stripeKYCValidator: "0x12b456dcc0e669eeb1d96806c8ef87b713d39cc8",
    plaidCreditValidator: "0x9a0ed706f1714961bf607404521a58decddc2636",
  },
} as const;
