# Whitewall OS Architecture (Current State)

> Last updated: 2026-02-22
> Chain: Base Sepolia (84532)

---

## 1. What is Whitewall OS?

AI agent accountability protocol. Any service (on-chain dApp, backend API, AI agent) can verify:
**"Is there a real, unique human behind this agent?"**

```
Any Service              Whitewall OS Protocol                  Verification
┌──────────┐      ┌──────────────────────────┐      ┌──────────────────┐
│ DeFi     │      │                          │      │ World ID         │
│ OpenRouter│─────▶│  On-chain Registries     │◀─────│ Stripe Identity  │
│ API GW   │      │  ACE Policy Engine       │      │ Plaid            │
│ AI Agent │      │  SDK / MCP               │      │ (KYC + Credit)   │
└──────────┘      └──────────────────────────┘      └──────────────────┘
```

Three integration levels:
| Level | How | Target |
|-------|-----|--------|
| 1. Solidity SDK | `contract X is WhitewallOSGuard` | On-chain dApps |
| 2. TypeScript SDK | `wos.getFullStatus(addr)` | Backend/frontend apps (OpenRouter, etc.) |
| 3. MCP Server | `auth_os_check_agent` tool | AI agents verifying other agents |

---

## 2. Smart Contracts

### 2.1 Data Layer (Registries)

**IdentityRegistryUpgradeable** — "Who is an agent?"
- ERC-721 NFT. `register()` mints token, returns `agentId`
- `ownerOf(agentId)` — who owns this agent
- `getAgentWallet(agentId)` — agent's operating wallet (EOA or CA)
- Stores arbitrary metadata via ERC-8004

**ValidationRegistryUpgradeable** — "Is this agent verified?" (async validators)
- Request/response pattern: `validationRequest()` → `validationResponse()`
- `getSummary(agentId, validators, tag)` — count + avg score for a tag
- Used by async validators: KYC (Stripe), credit (Plaid), reputation, TEE attestation
- NOT used for World ID human verification (sync on-chain ZK proof doesn't fit async pattern)

**WorldIDValidator** (v1.2.0) — "Prove human ownership via World ID"
- Verifies ZK proofs on-chain via `IWorldID.verifyProof()`
- Writes `"humanVerified"` metadata to IdentityRegistry (dual-write for tamper resistance)
- Tracks nullifiers internally (`verifications[agentId].isVerified` — tamper-proof source of truth)
- Per-agent external nullifiers: `initializeV2(appId, actionPrefix)` — one human can verify multiple agents
- Self-contained: no CRE, no ValidationRegistry dependency

**StripeKYCValidator** (v1.0.0) — "Verify agent owner's identity via Stripe"
- Receives CRE Confidential HTTP reports from Stripe Identity verification
- Called by CRE Forwarder via `onReport(metadata, report)` — not directly by users
- Maintains tamper-proof KYC state: `kycVerified[agentId]` can only be set via CRE
- Writes responses to ValidationRegistry (`validationResponse()` with tag "KYC_VERIFIED")
- `isKYCVerified(agentId)` — tamper-proof read by KYCPolicy and CreditPolicy

**PlaidCreditValidator** (v1.0.0) — "Assess agent owner's financial credibility via Plaid"
- Receives CRE Confidential HTTP reports from Plaid balance data
- Called by CRE Forwarder via `onReport(metadata, report)` — not directly by users
- Maintains tamper-proof credit scores: `creditScores[agentId]` (0-100)
- Writes responses to ValidationRegistry (`validationResponse()` with tag "CREDIT_SCORE")
- `getCreditScore(agentId)` / `hasCreditScore(agentId)` — tamper-proof reads by CreditPolicy

### 2.2 ACE Layer (Access Control Engine) — ACCESS only

> Human verification does NOT go through ACE. WorldIDValidator handles it directly on-chain.
> CRE is used for ACCESS workflows and KYC/credit async validators.

**WhitewallConsumer** — Entry point for ACCESS requests
- Inherits `PolicyProtected` (Chainlink ACE)
- `onReport(metadata, report)` — called by CRE Forwarder
- `runPolicy` modifier runs PolicyEngine BEFORE function body executes
- If policy approves → emits `AccessGranted(agentId, human, tier)`
- If policy rejects → entire tx reverts (body never runs)

**WhitewallExtractor** — Report parser
- Stateless (no proxy needed)
- Input: `onReport` calldata bytes
- Output: 5 structured parameters:

```
[0] agentId          (uint256)  — keccak256("agentId")
[1] approved         (bool)     — keccak256("approved")
[2] tier             (uint8)    — keccak256("tier")
[3] accountableHuman (address)  — keccak256("accountableHuman")
[4] reason           (bytes32)  — keccak256("reason")
```

**HumanVerifiedPolicy** — On-chain safety net for Tier 2 (5-check protection)
- Minimum bar: identity + human verification
- `configure(identityRegistry, worldIdValidator, requiredTier=2)`
- 5 sequential checks:

```
Check 1: approved == true?                              (CRE report value)
Check 2: tier >= requiredTier (2)?                      (CRE report value)
Check 3: IdentityRegistry.ownerOf(agentId)              (ON-CHAIN — registered?)
Check 4: IdentityRegistry.getMetadata("humanVerified")  (ON-CHAIN — metadata exists?)
Check 5: WorldIDValidator.isHumanVerified(agentId)      (ON-CHAIN — tamper-proof confirm)
```

**KYCPolicy** — On-chain safety net for Tier 3 (6-check protection)
- Superset of HumanVerifiedPolicy + KYC check
- `configure(identityRegistry, worldIdValidator, kycValidator, requiredTier=3)`
- Checks 1-5: same as HumanVerifiedPolicy
- Check 6: `StripeKYCValidator.isKYCVerified(agentId)` — tamper-proof KYC confirmation

**CreditPolicy** — On-chain safety net for Tier 4 (8-check protection)
- Superset of KYCPolicy + credit score checks
- `configure(identityRegistry, worldIdValidator, kycValidator, creditValidator, requiredTier=4, minCreditScore=50)`
- Checks 1-6: same as KYCPolicy
- Check 7: `PlaidCreditValidator.hasCreditScore(agentId)` — credit score exists
- Check 8: `PlaidCreditValidator.getCreditScore(agentId) >= minCreditScore` — meets threshold

**PolicyEngine** (vendored from chainlink-ace)
- Orchestrator: extract → map → policy → allow/reject
- `setExtractor(selector, extractor)` — which extractor for which function
- `addPolicy(target, selector, policy, paramNames)` — which policy for which contract+function

### 2.3 SDK Layer

**IWhitewallOS** — Public read interface
- `isRegistered(agentId)`, `isHumanVerified(agentId)`, `getTier(agentId)`
- `getAgentStatus(agentId)` — full status struct

**WhitewallOSGuard** — Abstract contract for dApp integration
- `modifier requireHumanVerified(agentId)`
- `modifier requireRegistered(agentId)`
- `modifier requireTier(agentId, minTier)`

---

## 3. Access Control Flow

### 3.1 Bonding (Human Verification) — WorldIDValidator (sync, on-chain)

```
1. Agent owner calls IdentityRegistry.approve(worldIdValidator, agentId)
    ↓
2. Frontend: IDKit generates World ID ZK proof (per-agent action: "verify-owner-{agentId}")
    ↓
3. Agent owner calls WorldIDValidator.verifyAndSetHumanTag(agentId, root, nullifierHash, proof)
    ↓
4. WorldIDValidator:
   → checks agent approved + caller is owner
   → checks nullifier not reused
   → computes per-agent external nullifier: hashToField(appIdHash + actionPrefix + agentId)
   → IWorldID.verifyProof() — on-chain ZK verification (reverts if invalid)
   → nullifierUsed[hash] = true (sybil protection)
   → verifications[agentId].isVerified = true (tamper-proof record)
   → IdentityRegistry.setMetadata(agentId, "humanVerified", encodedData)
   → emit HumanVerified(agentId, owner, nullifier, timestamp)
```

**No CRE involved.** Atomic, single-tx, trustless on-chain verification.

### 3.2 Access Request — ACE Pipeline (4-gate)

```
Agent requests resource access
    ↓
CRE Access Workflow: reads registries, builds report
    ↓
  Gate 1: Identity — IdentityRegistry.ownerOf(agentId) != 0x0
  Gate 2: Human — WorldIDValidator.isHumanVerified(agentId)
  Gate 3: KYC — StripeKYCValidator.isKYCVerified(agentId) [if tier >= 3]
  Gate 4: Credit — PlaidCreditValidator.getCreditScore(agentId) >= min [if tier >= 4]
    ↓
DON signs report → Forwarder sends to WhitewallConsumer
    ↓
WhitewallConsumer.onReport(metadata, report)
    ↓ [runPolicy modifier fires]
PolicyEngine.run()
    ↓
WhitewallExtractor.extract()
  → parse report → (agentId, approved, tier, accountableHuman, reason)
    ↓
Policy.run() — varies by tier:
  Tier 2: HumanVerifiedPolicy (5 checks)
  Tier 3: KYCPolicy (6 checks)
  Tier 4: CreditPolicy (8 checks)
    ↓
All pass → PolicyResult.Allowed → emit AccessGranted(agentId, human, tier)
```

### 3.3 KYC Verification Flow (Stripe Identity via Confidential HTTP)

```
1. User completes Stripe Identity verification in browser
   → Backend creates verification session, stores session ID in DON vault
    ↓
2. On-chain: validationRequest(StripeKYCValidator, agentId, "stripe:<hash>", requestHash)
    ↓
3. CRE KYC Workflow triggers on ValidationRequest event:
   → ConfidentialHTTP: GET api.stripe.com/v1/identity/verification_sessions/{sessionId}
   → API key loaded from DON vault (TEE enclave — never exposed to individual nodes)
    ↓
4. Parse response: status == "verified" → score=100, else score=0
    ↓
5. Build report: abi.encode(agentId, verified, requestHash, sessionHash)
    ↓
6. writeReport → Forwarder → StripeKYCValidator.onReport()
   → sets kycVerified[agentId] = true
   → calls ValidationRegistry.validationResponse() with tag "KYC_VERIFIED"
```

### 3.4 Credit Score Flow (Plaid via Confidential HTTP)

```
1. User completes Plaid Link → backend exchanges token → stores in DON vault
    ↓
2. On-chain: validationRequest(PlaidCreditValidator, agentId, "plaid:<agentId>", requestHash)
    ↓
3. CRE Credit Workflow triggers on ValidationRequest event:
   → ConfidentialHTTP: POST sandbox.plaid.com/accounts/balance/get
   → client_id, secret, access_token loaded from DON vault
    ↓
4. Compute credit score (0-100):
   → Balance weight: 40% | Account count: 10% | No negatives: 30% | Diversity: 20%
    ↓
5. Build report: abi.encode(agentId, score, requestHash, dataHash)
    ↓
6. writeReport → Forwarder → PlaidCreditValidator.onReport()
   → sets creditScores[agentId] = score
   → calls ValidationRegistry.validationResponse() with tag "CREDIT_SCORE"
```

---

## 4. Report Format

```
abi.encode(
    uint256 agentId,          // agent's NFT token ID
    bool    approved,         // CRE's off-chain decision
    uint8   tier,             // verification tier (2-4)
    address accountableHuman, // human bonded to this agent
    bytes32 reason            // rejection reason (0x00...00 if approved)
)
```

onReport selector: `0x805f2132` = `bytes4(keccak256("onReport(bytes,bytes)"))`

---

## 5. Deployed Addresses (Base Sepolia)

### Registries (Phase 1)
| Contract | Address |
|----------|---------|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| WorldIDValidator | `0x1258f013d1ba690dc73ea89fd48f86e86ad0f124` |

### ACE Stack (Phase 1b)
| Contract | Address |
|----------|---------|
| PolicyEngine (proxy) | `0x4c09ed510603e9034928849c81365b6f1396edc7` |
| WhitewallExtractor | `0x14f6ac8c514dca76e437fe9add8bc676df146243` |
| HumanVerifiedPolicy (proxy) | `0x8f66f55f4ade4e64b105820972d444a56449e8b3` |
| WhitewallConsumer (proxy) | `0xec3114ea6bb29f77b63cd1223533870b663120bb` |

### KYC + Credit Stack (Phase 2 — pending deployment)
| Contract | Address |
|----------|---------|
| StripeKYCValidator (proxy) | TBD |
| PlaidCreditValidator (proxy) | TBD |
| KYCPolicy (proxy) | TBD |
| CreditPolicy (proxy) | TBD |

### Wiring
- PolicyEngine: extractor for `0x805f2132` → WhitewallExtractor
- PolicyEngine: policy for Consumer's `onReport` → HumanVerifiedPolicy
- Forwarder: `0x0000000000000000000000000000000000000001` (placeholder — update after CRE deploy)

---

## 6. Project Structure (Actual)

```
~/github/whitewall-os/
├── contracts/
│   ├── IdentityRegistryUpgradeable.sol    # ERC-721 agent registration
│   ├── ValidationRegistryUpgradeable.sol  # Verification records
│   ├── ReputationRegistryUpgradeable.sol  # Agent reputation/feedback
│   ├── WorldIDValidator.sol               # World ID ZK proof verifier
│   ├── StripeKYCValidator.sol             # Stripe Identity KYC (CRE target)
│   ├── PlaidCreditValidator.sol           # Plaid credit score (CRE target)
│   ├── ace/
│   │   ├── WhitewallConsumer.sol          # ACE consumer (ACCESS only)
│   │   ├── WhitewallExtractor.sol         # Report → parameters parser
│   │   ├── HumanVerifiedPolicy.sol        # Tier 2: 5-check protection
│   │   ├── KYCPolicy.sol                  # Tier 3: 6-check protection
│   │   ├── CreditPolicy.sol              # Tier 4: 8-check protection
│   │   └── vendor/
│   │       ├── core/
│   │       │   ├── PolicyEngine.sol       # Chainlink ACE orchestrator
│   │       │   ├── PolicyProtected.sol    # Base with runPolicy modifier
│   │       │   └── Policy.sol             # Base for policy contracts
│   │       └── interfaces/
│   │           ├── IPolicyEngine.sol
│   │           ├── IPolicyProtected.sol
│   │           ├── IExtractor.sol
│   │           ├── IPolicy.sol
│   │           └── IMapper.sol
│   ├── interfaces/
│   │   └── IWhitewallOS.sol               # Public read interface
│   └── sdk/
│       └── WhitewallOSGuard.sol           # Abstract contract for dApps
├── workflows/
│   ├── kyc-workflow/
│   │   └── main.ts                        # CRE: Stripe Identity KYC
│   └── credit-workflow/
│       └── main.ts                        # CRE: Plaid credit score
├── scripts/
│   ├── deploy-ace.ts                      # Deploys ACE stack
│   └── deploy-kyc-credit.ts              # Deploys KYC+Credit stack
├── sdk/
│   └── src/
│       ├── client.ts                      # WhitewallOS class
│       ├── types.ts                       # AgentStatus, FullAgentStatus
│       ├── abis.ts                        # All contract ABIs
│       ├── addresses.ts                   # Deployed addresses by chain
│       └── index.ts                       # Public exports
├── test/
│   ├── ace.ts                             # ACE pipeline tests
│   ├── core.ts                            # Registry unit tests
│   └── upgradeable.ts                     # Proxy/upgrade tests
├── hardhat.config.ts
└── package.json
```

---

## 7. Person A / Person B Split

### Person A (done)
- All smart contracts (registries + ACE + KYC/Credit validators + policies)
- Tests (ACE, upgradeable)
- Base Sepolia deployment + wiring
- TypeScript SDK
- **Next**: Deploy KYC+Credit stack, MCP Server

### Person B (in progress)
- CRE Access Workflow (read registries → sign report → Forwarder → WhitewallConsumer)
- CRE KYC Workflow (ValidationRequest → Confidential HTTP → Stripe → StripeKYCValidator)
- CRE Credit Workflow (ValidationRequest → Confidential HTTP → Plaid → PlaidCreditValidator)
- ResourceGateway (demo dApp)
- Dashboard
- After CRE deploy: call `setForwarder(realForwarderAddress)` on Consumer + validators

### Interface for Person B

```
Consumer address: 0xec3114ea6bb29f77b63cd1223533870b663120bb
onReport selector: 0x805f2132
Chain: Base Sepolia (84532)

Report format:
  abi.encode(uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason)

KYC Validator report format:
  abi.encode(uint256 agentId, bool verified, bytes32 requestHash, bytes32 sessionHash)

Credit Validator report format:
  abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)

Sensitive data handling:
  - Stripe session IDs: stored in DON vault, never on-chain
  - Plaid access tokens: pre-exchanged by backend, stored in DON vault
  - On-chain requestURI contains only hash references
```

---

## 8. Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Human verification is sync on-chain | WorldIDValidator verifies ZK proofs directly, writes to IdentityRegistry metadata | CRE async pattern doesn't fit sync ZK verification. No oracle trust assumption needed. Nullifier tracking must be atomic. |
| Dual-write tamper resistance | WorldIDValidator writes BOTH internal state + IdentityRegistry metadata | Policy checks both: metadata could be spoofed by owner, but internal state can only be set via valid ZK proof |
| ValidationRegistry for async only | KYC, reputation, credit go through CRE → ValidationRegistry | ERC-8004 async request/response pattern fits off-chain validators |
| 5/6/8-check protection | Policies read registries + validators independently | Even if CRE is compromised, on-chain checks catch fake reports |
| Report format | No actionType field | Only ACCESS goes through ACE, so no need to distinguish |
| Proxy pattern | ERC1967Proxy + UUPS | Upgradeable for all stateful contracts |
| Extractor is stateless | No proxy for WhitewallExtractor | Pure function, no storage needed |
| defaultAllow = false | PolicyEngine rejects by default | Fail-safe: if no policy matches, reject |
| Validator contracts as CRE targets | Dedicated validator contracts receive CRE reports | `validationResponse()` enforces `msg.sender == validatorAddress`. CRE writes via Forwarder → Consumer, not from EOA. Validator contracts bridge the gap. |
| Confidential HTTP for secrets | API keys in TEE enclaves | Stripe/Plaid secrets never exposed to individual DON nodes |
| Sensitive tokens never on-chain | Session IDs, access tokens in DON vault | On-chain requestURI contains only hash references for traceability |

---

## 9. Tiered Access Model

| Tier | Verification | Resource Unlocked | Policy |
|:---:|---|---|---|
| 0 | None | DENIED | — |
| 1 | Registered (ERC-8004 NFT) | Basic API access | — |
| 2 | + World ID | Image generation | HumanVerifiedPolicy (5 checks) |
| 3 | + KYC (Stripe Identity) | Video generation | KYCPolicy (6 checks) |
| 4 | + Credit Score (Plaid) | Premium/unrestricted | CreditPolicy (8 checks) |

Each tier is cumulative — tier 3 requires tier 2 + KYC. Tier 4 requires tier 3 + credit score.

---

## 10. What's Next

| Priority | Task | Owner | Status |
|----------|------|-------|--------|
| 1 | Deploy KYC+Credit stack to Base Sepolia | Person A | Pending |
| 2 | CRE KYC Workflow (Stripe Confidential HTTP) | Person B | Pending |
| 3 | CRE Credit Workflow (Plaid Confidential HTTP) | Person B | Pending |
| 4 | MCP Server (`@whitewall-os/mcp`) | Person A | Pending |
| 5 | ResourceGateway (tier-gated demo dApp) | Person B | Pending |
| 6 | Dashboard | Person B | Pending |
| 7 | CCIP Cross-chain | Both | Future |
