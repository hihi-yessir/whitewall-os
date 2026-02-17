# Whitewall OS Architecture (Current State)

> Last updated: 2026-02-18
> Chain: Base Sepolia (84532)

---

## 1. What is Whitewall OS?

AI agent accountability protocol. Any service (on-chain dApp, backend API, AI agent) can verify:
**"Is there a real, unique human behind this agent?"**

```
Any Service              Whitewall OS Protocol                  Verification
┌──────────┐      ┌──────────────────────────┐      ┌──────────────────┐
│ DeFi     │      │                          │      │                  │
│ OpenRouter│─────▶│  On-chain Registries     │◀─────│  World ID        │
│ API GW   │      │  ACE Policy Engine       │      │  (Human proof)   │
│ AI Agent │      │  SDK / MCP               │      │                  │
└──────────┘      └──────────────────────────┘      └──────────────────┘
```

Three integration levels:
| Level | How | Target |
|-------|-----|--------|
| 1. Solidity SDK | `contract X is WhitewallOSGuard` | On-chain dApps |
| 2. TypeScript SDK | `wos.getAgentStatus(addr)` | Backend/frontend apps (OpenRouter, etc.) |
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
- Reserved for future async validators: KYC, reputation, TEE attestation
- NOT used for World ID human verification (sync on-chain ZK proof doesn't fit async pattern)

**WorldIDValidator** (v1.2.0) — "Prove human ownership via World ID"
- Verifies ZK proofs on-chain via `IWorldID.verifyProof()`
- Writes `"humanVerified"` metadata to IdentityRegistry (dual-write for tamper resistance)
- Tracks nullifiers internally (`verifications[agentId].isVerified` — tamper-proof source of truth)
- Per-agent external nullifiers: `initializeV2(appId, actionPrefix)` — one human can verify multiple agents
- Self-contained: no CRE, no ValidationRegistry dependency

### 2.2 ACE Layer (Access Control Engine) — ACCESS only

> Human verification does NOT go through ACE. WorldIDValidator handles it directly on-chain.
> CRE is used for ACCESS workflows and future async validators.

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

**HumanVerifiedPolicy** — On-chain safety net (5-check protection)
- Called by PolicyEngine with mapped parameters
- `configure(identityRegistry, worldIdValidator, requiredTier)`
- 5 sequential checks:

```
Check 1: approved == true?                              (CRE report value)
Check 2: tier >= requiredTier (2)?                      (CRE report value)
Check 3: IdentityRegistry.ownerOf(agentId)              (ON-CHAIN — registered?)
Check 4: IdentityRegistry.getMetadata("humanVerified")  (ON-CHAIN — metadata exists?)
Check 5: WorldIDValidator.isHumanVerified(agentId)      (ON-CHAIN — tamper-proof confirm)
```

- Checks 3-5 are independent of CRE — even if CRE is compromised, on-chain state is verified directly
- Check 5 prevents metadata spoofing: owner could `approve(self)` then `setMetadata("humanVerified", fake)` to bypass ZK proof. WorldIDValidator's internal state can only be set via `verifyAndSetHumanTag()` which requires a valid ZK proof.

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
CRE is reserved for future async validators (KYC, reputation).

### 3.2 Access Request — Person A (ACE Pipeline)

```
Agent requests resource access
    ↓
CRE Access Workflow: reads registries, builds report
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
HumanVerifiedPolicy.run()
  → Check 1: CRE approved?                          ✅/❌
  → Check 2: tier >= 2?                             ✅/❌
  → Check 3: IdentityRegistry.ownerOf()              ✅/❌  ← on-chain
  → Check 4: IdentityRegistry.getMetadata("humanVerified") ✅/❌  ← on-chain
  → Check 5: WorldIDValidator.isHumanVerified()      ✅/❌  ← on-chain (tamper-proof)
    ↓
All pass → PolicyResult.Allowed
    ↓
WhitewallConsumer body executes
  → emit AccessGranted(agentId, human, tier)
```

---

## 4. Report Format

```
abi.encode(
    uint256 agentId,          // agent's NFT token ID
    bool    approved,         // CRE's off-chain decision
    uint8   tier,             // verification tier (2 = HUMAN_VERIFIED)
    address accountableHuman, // human bonded to this agent
    bytes32 reason            // rejection reason (0x00...00 if approved)
)
```

onReport selector: `0x805f2132` = `bytes4(keccak256("onReport(bytes,bytes)"))`

---

## 5. Deployed Addresses (Base Sepolia)

### Registries (Phase 1 — previously deployed)
| Contract | Address |
|----------|---------|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| WorldIDValidator | `0x1258f013d1ba690dc73ea89fd48f86e86ad0f124` |

### ACE Stack (Phase 1b — just deployed)
| Contract | Address |
|----------|---------|
| PolicyEngine (proxy) | `0x4c09ed510603e9034928849c81365b6f1396edc7` |
| WhitewallExtractor | `0x14f6ac8c514dca76e437fe9add8bc676df146243` |
| HumanVerifiedPolicy (proxy) | `0x8f66f55f4ade4e64b105820972d444a56449e8b3` |
| WhitewallConsumer (proxy) | `0xec3114ea6bb29f77b63cd1223533870b663120bb` |

### Wiring
- PolicyEngine: extractor for `0x805f2132` → WhitewallExtractor
- PolicyEngine: policy for Consumer's `onReport` → HumanVerifiedPolicy
- Forwarder: `0x0000000000000000000000000000000000000001` (placeholder — Person B updates after CRE deploy)

---

## 6. Project Structure (Actual)

```
~/github/whitewall-os/
├── contracts/
│   ├── IdentityRegistryUpgradeable.sol    # ERC-721 agent registration
│   ├── ValidationRegistryUpgradeable.sol  # Verification records
│   ├── ReputationRegistryUpgradeable.sol  # Agent reputation/feedback
│   ├── WorldIDValidator.sol               # World ID ZK proof verifier
│   ├── ace/
│   │   ├── WhitewallConsumer.sol             # ACE consumer (ACCESS only)
│   │   ├── WhitewallExtractor.sol            # Report → parameters parser
│   │   ├── HumanVerifiedPolicy.sol        # On-chain double protection
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
│   │   └── IWhitewallOS.sol                    # Public read interface
│   └── sdk/
│       └── WhitewallOSGuard.sol                # Abstract contract for dApps
├── scripts/
│   └── deploy-ace.ts                      # Deploys full ACE stack
├── test/
│   ├── ace.ts                             # ACE pipeline tests (8/8 pass)
│   ├── core.ts                            # Registry unit tests
│   └── upgradeable.ts                     # Proxy/upgrade tests (18/18 pass)
├── hardhat.config.ts
└── package.json
```

---

## 7. Person A / Person B Split

### Person A (done)
- All smart contracts (registries + ACE + SDK)
- Tests (8/8 ACE, 18/18 upgradeable)
- Base Sepolia deployment + wiring
- **Next**: TypeScript SDK, MCP Server

### Person B (in progress)
- CRE Access Workflow (read registries → sign report → Forwarder → WhitewallConsumer)
- CRE workflows for future async validators (KYC, reputation → ValidationRegistry)
- ResourceGateway (demo dApp)
- Dashboard
- After CRE deploy: call `WhitewallConsumer.setForwarder(realForwarderAddress)`

### Interface for Person B

```
Consumer address: 0xec3114ea6bb29f77b63cd1223533870b663120bb
onReport selector: 0x805f2132
Chain: Base Sepolia (84532)

Report format:
  abi.encode(uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason)

Human verification (already handled — no CRE needed):
  WorldIDValidator (0x1258F013d1BA690Dc73EA89Fd48F86E86AD0f124) handles this directly.
  Frontend → verifyAndSetHumanTag() → IdentityRegistry metadata + internal state.

Future async validators (CRE → ValidationRegistry):
  ValidationRegistry (0x8004Cb1BF31DAf7788923b405b754f57acEB4272)
  validationRequest() → CRE picks up → off-chain processing → validationResponse()
```

---

## 8. Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Human verification is sync on-chain | WorldIDValidator verifies ZK proofs directly, writes to IdentityRegistry metadata | CRE async pattern doesn't fit sync ZK verification. No oracle trust assumption needed. Nullifier tracking must be atomic. |
| Dual-write tamper resistance | WorldIDValidator writes BOTH internal state + IdentityRegistry metadata | Policy checks both: metadata could be spoofed by owner, but internal state can only be set via valid ZK proof |
| ValidationRegistry for async only | KYC, reputation, TEE attestation go through CRE → ValidationRegistry | ERC-8004 async request/response pattern fits off-chain validators, not on-chain ZK proofs |
| 5-check protection | Policy reads IdentityRegistry + WorldIDValidator independently | Even if CRE is compromised, on-chain checks catch fake reports. Even if metadata is spoofed, Check 5 catches it. |
| Report format | No actionType field | Only ACCESS goes through ACE, so no need to distinguish |
| Proxy pattern | ERC1967Proxy + UUPS | Upgradeable for all stateful contracts |
| Extractor is stateless | No proxy for WhitewallExtractor | Pure function, no storage needed |
| defaultAllow = false | PolicyEngine rejects by default | Fail-safe: if no policy matches, reject |

---

## 9. What's Next

| Priority | Task | Owner | Status |
|----------|------|-------|--------|
| 1 | TypeScript SDK (`@whitewall-os/sdk`) | Person A | Pending |
| 2 | MCP Server (`@whitewall-os/mcp`) | Person A | Pending |
| 3 | CRE Bonding Workflow | Person B | In progress |
| 4 | CRE Access Workflow | Person B | In progress |
| 5 | ResourceGateway | Person B | Pending |
| 6 | Dashboard | Person B | Pending |
| 7 | CCIP Cross-chain | Both | Future |
