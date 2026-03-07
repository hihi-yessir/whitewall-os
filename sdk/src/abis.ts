// ── TieredPolicy — unified policy, SDK reads all config from here ──

export const tieredPolicyAbi = [
  {
    inputs: [],
    name: "getIdentityRegistry",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getWorldIdValidator",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getStripeKYCValidator",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPlaidCreditValidator",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getMinCreditScore",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── IdentityRegistry ──

export const identityRegistryAbi = [
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "getAgentWallet",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "metadataKey", type: "string" },
    ],
    name: "getMetadata",
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "agentURI", type: "string" },
      { indexed: true, name: "owner", type: "address" },
    ],
    name: "Registered",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    inputs: [{ name: "agentURI", type: "string" }],
    name: "register",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "validator", type: "address" },
      { name: "agentId", type: "uint256" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ── ValidationRegistry ──

export const validationRegistryAbi = [
  {
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "validatorAddresses", type: "address[]" },
      { name: "tag", type: "string" },
    ],
    name: "getSummary",
    outputs: [
      { name: "count", type: "uint64" },
      { name: "avgResponse", type: "uint8" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "getAgentValidations",
    outputs: [{ name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "requestHash", type: "bytes32" }],
    name: "getValidationStatus",
    outputs: [
      { name: "validatorAddress", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "response", type: "uint8" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
      { name: "lastUpdate", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "validatorAddress", type: "address" },
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "requestURI", type: "string" },
      { indexed: true, name: "requestHash", type: "bytes32" },
    ],
    name: "ValidationRequest",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "validatorAddress", type: "address" },
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "requestHash", type: "bytes32" },
      { indexed: false, name: "response", type: "uint8" },
      { indexed: false, name: "responseURI", type: "string" },
      { indexed: false, name: "responseHash", type: "bytes32" },
      { indexed: false, name: "tag", type: "string" },
    ],
    name: "ValidationResponse",
    type: "event",
  },
] as const;

// ── WorldIDValidator ──

export const worldIdValidatorAbi = [
  {
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "root", type: "uint256" },
      { name: "nullifierHash", type: "uint256" },
      { name: "proof", type: "uint256[8]" },
    ],
    name: "verifyAndSetHumanTag",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "isHumanVerified",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── StripeKYCValidator ──

export const stripeKYCValidatorAbi = [
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "isKYCVerified",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "getKYCData",
    outputs: [
      { name: "verified", type: "bool" },
      { name: "sessionHash", type: "bytes32" },
      { name: "verifiedAt", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── PlaidCreditValidator ──

export const plaidCreditValidatorAbi = [
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "getCreditScore",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "hasCreditScore",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "uint256" }],
    name: "getCreditData",
    outputs: [
      { name: "score", type: "uint8" },
      { name: "dataHash", type: "bytes32" },
      { name: "verifiedAt", type: "uint256" },
      { name: "hasScore", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "score", type: "uint8" },
      { indexed: false, name: "dataHash", type: "bytes32" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
    name: "CreditScoreSet",
    type: "event",
  },
  {
    inputs: [],
    name: "getSgxConfig",
    outputs: [
      { name: "verifier", type: "address" },
      { name: "mrEnclave", type: "bytes32" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── Legacy policy ABIs removed ──
// KYCPolicy and CreditPolicy replaced by unified TieredPolicy

// ── WhitewallConsumer ──

export const whitewallConsumerAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "accountableHuman", type: "address" },
      { indexed: false, name: "tier", type: "uint8" },
    ],
    name: "AccessGranted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "reason", type: "bytes32" },
    ],
    name: "AccessDenied",
    type: "event",
  },
] as const;
