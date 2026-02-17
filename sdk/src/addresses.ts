import type { Address } from "viem";

export type ChainName = "baseSepolia";

export interface WhitewallOSAddresses {
  humanVerifiedPolicy: Address;
  whitewallConsumer: Address;
}

/** Protocol-level policy config, read from on-chain HumanVerifiedPolicy */
export interface PolicyConfig {
  identityRegistry: Address;
  worldIdValidator: Address;
  requiredTier: number;
}

export const addresses: Record<ChainName, WhitewallOSAddresses> = {
  baseSepolia: {
    humanVerifiedPolicy: "0x8f66f55f4ade4e64b105820972d444a56449e8b3",
    whitewallConsumer: "0xec3114ea6bb29f77b63cd1223533870b663120bb",
  },
} as const;
