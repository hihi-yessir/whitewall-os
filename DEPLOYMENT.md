# Whitewall OS — Deployment Report (Base Sepolia)

Last deployed: 2026-02-24

---

## Deployed Contracts

### ACE Stack (UUPS Proxies)

| Contract | Proxy | Implementation | Verified |
|----------|-------|----------------|----------|
| PolicyEngine | `0x12816c0c79981726627a550b73e9627b81be95be` | `0xf1e187ac100e6b2d1daf896d36c7f518e04a9547` | Yes |
| WhitewallExtractor | `0x27b22cdbbf3b03dde7597ec8ff8640b74aeea58b` | (not proxied — stateless) | Yes |
| TieredPolicy | `0x63b4d2e051180c3c0313eb71a9bdda8554432e23` | `0xf17349229930ce0cd34c60cd9364442aaabc89c9` | Yes |
| WhitewallConsumer | `0xb5845901c590f06ffa480c31b96aca7eff4dfb3e` | `0x1a1bf7daade6c1bd72dcdc369b1df843255b663b` | Yes |
| StripeKYCValidator | `0x12b456dcc0e669eeb1d96806c8ef87b713d39cc8` | `0xf6afce65d1414a3d2db10d55ec3057eaa42b0262` | Yes |
| PlaidCreditValidator | `0x9a0ed706f1714961bf607404521a58decddc2636` | `0xa6549e31519c65282f0aadd753d4dd452f634f97` | Yes |

### Identity Stack (unchanged)

| Contract | Address |
|----------|---------|
| IdentityRegistryUpgradeable | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| WorldIDValidator | `0x1258F013d1BA690Dc73EA89Fd48F86E86AD0f124` |

### Infrastructure

| Component | Address |
|-----------|---------|
| CRE Forwarder (Base Sepolia) | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |

All implementations verified on [Basescan](https://sepolia.basescan.org).

---

## PolicyEngine Wiring

```
PolicyEngine (0x1281...)
  ├── Extractor: WhitewallExtractor (0x27b2...) for onReport selector 0x805f2132
  │     Extracts: agentId, approved, tier, accountableHuman, reason
  │
  └── Policy: TieredPolicy (0x63b4...) for WhitewallConsumer (0xb584...) + onReport
        Base layer (always):
          Check 1: approved == true
          Check 2: tier >= 2
          Check 3: IdentityRegistry.ownerOf(agentId) — registered?
          Check 4: IdentityRegistry metadata "humanVerified" — exists?
          Check 5: WorldIDValidator.isHumanVerified(agentId) — tamper-proof
        KYC layer (if tier >= 3):
          Check 6: StripeKYCValidator.isKYCVerified(agentId)
        Credit layer (if tier >= 4):
          Check 7: PlaidCreditValidator.hasCreditScore(agentId)
          Check 8: PlaidCreditValidator.getCreditScore(agentId) >= 50
```

---

## Tiered Access Model

| Tier | Verification | Resource Unlocked |
|:---:|---|---|
| 0 | None | DENIED |
| 1 | Registered (ERC-8004 NFT) | DENIED (below minimum) |
| 2 | + World ID | Image generation |
| 3 | + KYC (Stripe Identity) | Video generation |
| 4 | + Credit Score (Plaid) | Premium/unrestricted |

Each tier is cumulative. TieredPolicy enforces all lower-tier checks before evaluating higher-tier gates.

---

## Test Results

### ACE Condition Tests (`test-ace.ts`)

| Test | Result |
|------|--------|
| PolicyEngine wiring (extractor + policy match) | PASS |
| TieredPolicy config (identityRegistry, worldIdValidator, kycValidator, creditValidator, minCreditScore=50) | PASS |
| Consumer forwarder set to CRE Forwarder | PASS |
| `approved=false, tier=2` rejected: "CRE: agent not approved" | PASS |
| `approved=true, tier=1` rejected: "Insufficient verification tier" | PASS |
| `tier=2, unregistered agent (999999)` rejected: "Agent not registered" | PASS |
| `tier=3, unregistered agent (999999)` rejected at base layer | PASS |
| `tier=4, unregistered agent (999999)` rejected at base layer | PASS |

### CRE Workflow Simulation Tests (`cre workflow simulate`)

| Scenario | Agent | Resource | Result | Tier | TX Hash |
|----------|-------|----------|--------|------|---------|
| Registered, not human-verified | #1 | image (tier 2) | DENIED | 1 | `0x3bd7f5f4...` |
| Unregistered | #999999 | image (tier 2) | DENIED | 0 | `0x02736da3...` |
| No KYC | #1 | video (tier 3) | DENIED | 1 | `0x54a965d5...` |
| No credit | #1 | premium (tier 4) | DENIED | 1 | `0x3f7803c7...` |

All reports delivered on-chain via CRE Forwarder to WhitewallConsumer.

---

## CRE Workflows

### Access Workflow (`workflows/access-workflow/`)
- **Trigger**: HTTP
- **Target**: WhitewallConsumer
- **Report format**: `abi.encode(uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason)`
- **Flow**: HTTP request -> evaluate agent state -> DON consensus -> writeReport -> Forwarder -> WhitewallConsumer.onReport() -> PolicyEngine -> TieredPolicy

### KYC Workflow (`workflows/kyc-workflow/`)
- **Trigger**: EVM log (ValidationRegistry.ValidationRequest)
- **Target**: StripeKYCValidator
- **Flow**: ValidationRequest event -> Confidential HTTP to Stripe Identity -> writeReport -> Forwarder -> StripeKYCValidator.onReport()

### Credit Workflow (`workflows/credit-workflow/`)
- **Trigger**: EVM log (ValidationRegistry.ValidationRequest)
- **Target**: PlaidCreditValidator
- **Flow**: ValidationRequest event -> Confidential HTTP to Plaid -> compute credit score -> writeReport -> Forwarder -> PlaidCreditValidator.onReport()

---

## SDK (`sdk/src/`)

Updated to read all policy config from the unified TieredPolicy contract.

| File | Change |
|------|--------|
| `addresses.ts` | New contract addresses. Removed deprecated `humanVerifiedPolicy` field. |
| `abis.ts` | Replaced `humanVerifiedPolicyAbi`, `kycPolicyAbi`, `creditPolicyAbi` with unified `tieredPolicyAbi` (5 view functions). |
| `client.ts` | `loadPolicyConfig()` reads all 5 config values from TieredPolicy in a single batch. Removed old multi-policy loading. |
| `index.ts` | Updated exports to match new ABIs. |

### SDK Usage
```typescript
import { WhitewallOS } from "@whitewall-os/sdk";

const wos = await WhitewallOS.connect({ chain: "baseSepolia" });

// Quick checks
const registered = await wos.isRegistered(1n);
const human = await wos.isHumanVerified(1n);
const kyc = await wos.isKYCVerified(1n);
const credit = await wos.getCreditScore(1n);

// Full status with computed effectiveTier (0-4)
const status = await wos.getFullStatus(1n);
console.log(status.effectiveTier); // 0=unreg, 1=reg, 2=human, 3=kyc, 4=credit
```

---

## MCP Server (`mcp/`)

Updated to reflect TieredPolicy architecture.

| Tool | Description |
|------|-------------|
| `whitewall_os_check_agent` | Quick check: is agent registered + human-verified? |
| `whitewall_os_get_status` | Full status: registration, verification, tier, owner, wallet |
| `whitewall_os_get_policy` | Protocol config from TieredPolicy: all validators, minCreditScore |

Config: `.mcp.json` at repo root, uses relative path `mcp/dist/index.js`.

---

## Architecture Flow

```
Gateway (HTTP)
    |
    v
CRE Access Workflow (DON nodes)
    |  1. Read agent state (off-chain)
    |  2. Evaluate tier & approval
    |  3. DON consensus + sign report
    |
    v
Forwarder (0x8230...)
    |  Verify DON signatures
    |
    v
WhitewallConsumer.onReport(metadata, report)
    |  runPolicy modifier
    |
    v
PolicyEngine.run()
    |  1. WhitewallExtractor.extract() -> params
    |  2. TieredPolicy.run(params)
    |     - Base layer: checks 1-5 (always)
    |     - KYC layer: check 6 (if tier >= 3)
    |     - Credit layer: checks 7-8 (if tier >= 4)
    |
    v (if policy allows)
Consumer body
    -> emit AccessGranted(agentId, human, tier)
    or emit AccessDenied(agentId, reason)
```

---

## Redeployment

```bash
# Full stack deploy + wiring + verification
npx hardhat run scripts/deploy-all.ts --network baseSepolia

# If wiring fails separately
npx hardhat run scripts/wire-fresh.ts --network baseSepolia
```

### Test Commands
```bash
# ACE condition tests
npx hardhat run scripts/test-ace.ts --network baseSepolia

# CRE workflow simulation (4 scenarios)
cre workflow simulate workflows/access-workflow \
  --target local-simulation --trigger-index 0 --non-interactive \
  --http-payload '{"agentId": 1, "requestedResource": "image"}' --broadcast

cre workflow simulate workflows/access-workflow \
  --target local-simulation --trigger-index 0 --non-interactive \
  --http-payload '{"agentId": 999999, "requestedResource": "image"}' --broadcast

cre workflow simulate workflows/access-workflow \
  --target local-simulation --trigger-index 0 --non-interactive \
  --http-payload '{"agentId": 1, "requestedResource": "video"}' --broadcast

cre workflow simulate workflows/access-workflow \
  --target local-simulation --trigger-index 0 --non-interactive \
  --http-payload '{"agentId": 1, "requestedResource": "premium"}' --broadcast
```

Environment variables required (`.env`):
```
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_SEPOLIA_PRIVATE_KEY=<deployer private key>
ETHERSCAN_API_KEY=<basescan api key>
```
