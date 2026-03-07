# Whitewall OS — Deployment Report (Base Sepolia)

Last deployed: 2026-03-07

---

## Deployed Contracts

### ACE Stack (UUPS Proxies)

| Contract | Proxy | Implementation |
|----------|-------|----------------|
| PolicyEngine | `0xc7afccc4b97786e34c07e4444496256d2f2b0b9a` | `0xadfdaffa65ac8b1d79fb8cb75b86e49934cb563a` |
| WhitewallExtractor | `0xa1c721059cbdc04a7bc6ea0026b82bb0d620979d` | (not proxied — stateless) |
| TieredPolicy | `0xdb20a5d22cc7eb2a43628527667021121e80e30d` | `0x8a99a5db2d0487e29d760e132908af40f28e99ee` |
| WhitewallConsumer | `0x9670cc85a97c07a1bb6353fb968c6a2c153db99f` | `0x6d27f83a4bf69ad757b26637c689e6e2e9772083` |
| StripeKYCValidator | `0xebba79075ad00a22c5ff9a1f36a379f577265936` | `0x2ce72e8931963e739779ad28801444db985da2f2` |
| PlaidCreditValidator | `0x07e8653b55a3cd703106c9726a140755204c1ad5` | `0x453d99a48902fe021cc88b1f5d77b1ace9c8f449` |
| WorldIDValidator | `0xcadd809084debc999ce93384806da8ea90318e11` | `0x7b01612a436288f5e40f947be972526650b59e21` |

### ERC-8004 Singletons (unchanged)

| Contract | Address |
|----------|---------|
| IdentityRegistryUpgradeable | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

### Infrastructure

| Component | Address |
|-----------|---------|
| CRE Forwarder (Base Sepolia) | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |

All implementations verified on [Basescan](https://sepolia.basescan.org).

---

## PolicyEngine Wiring

```
PolicyEngine (0xc7af...)
  ├── Extractor: WhitewallExtractor (0xa1c7...) for onReport selector 0x805f2132
  │     Extracts: agentId, approved, tier, accountableHuman, reason
  │
  └── Policy: TieredPolicy (0xdb20...) for WhitewallConsumer (0x9670...) + onReport
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
