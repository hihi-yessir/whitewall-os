# 예슬 핸드오프 문서

> 재욱이 완료한 작업 + 예슬이 연동해야 할 인터페이스 전체 정리
> Chain: Base Sepolia (84532)

---

## 1. 예슬이 해야 할 일 (요약)

| # | 작업 | 설명 |
|---|------|------|
| 1 | **CRE Bonding Workflow** | World ID 증명 검증 → ValidationRegistry에 직접 기록 |
| 2 | **CRE Access Workflow** | 레지스트리 읽기 → 리포트 생성 → DON 서명 → WhitewallConsumer에 전송 |
| 3 | **`setForwarder()` 호출** | CRE 배포 후 실제 Forwarder 주소를 Consumer에 등록 |
| 4 | **ResourceGateway** | 데모 dApp (검증된 에이전트에 토큰 배포) |
| 5 | **Dashboard** | 파이프라인 시각화 + 데모 UI |

---

## 2. 배포된 컨트랙트 주소

### 레지스트리 (데이터 레이어)
| 컨트랙트 | 주소 | 용도 |
|----------|------|------|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ERC-721 에이전트 등록 |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | 검증 기록 (HUMAN_VERIFIED 등) |
| WorldIDValidator | `0x1258f013d1ba690dc73ea89fd48f86e86ad0f124` | World ID ZK 증명 검증자 |

### ACE 스택 (접근 제어)
| 컨트랙트 | 주소 | 용도 |
|----------|------|------|
| PolicyEngine (proxy) | `0x4c09ed510603e9034928849c81365b6f1396edc7` | ACE 오케스트레이터 |
| WhitewallExtractor | `0x14f6ac8c514dca76e437fe9add8bc676df146243` | 리포트 파서 (stateless) |
| HumanVerifiedPolicy (proxy) | `0x8f66f55f4ade4e64b105820972d444a56449e8b3` | 온체인 이중 보호 정책 |
| WhitewallConsumer (proxy) | `0xec3114ea6bb29f77b63cd1223533870b663120bb` | ACE 컨슈머 (ACCESS 전용) |

### 와이어링 (이미 완료)
- PolicyEngine → `0x805f2132` (onReport selector) → WhitewallExtractor
- PolicyEngine → Consumer의 onReport → HumanVerifiedPolicy
- **Forwarder: `0x0000000000000000000000000000000000000001` (플레이스홀더 — 예슬가 CRE 배포 후 업데이트)**

---

## 3. 인터페이스 정의

### 3.1 Bonding (인간 검증) — ACE 안 거침

본딩은 **ValidationRegistry에 직접 기록**. ACE/Consumer를 거치지 않음.

```
ValidationRegistry 주소: 0x8004Cb1BF31DAf7788923b405b754f57acEB4272
```

**CRE Bonding Workflow 흐름:**
```
1. 유저가 World ID 증명을 제출
       ↓
2. ValidationRegistry.validationRequest(worldIdValidator, agentId, requestURI)
   - worldIdValidator = 0x1258f013d1ba690dc73ea89fd48f86e86ad0f124
   - agentId = 에이전트의 NFT 토큰 ID
       ↓ (ValidationRequested 이벤트 발생)
3. CRE Bonding Workflow가 이벤트 감지
       ↓
4. CRE: Confidential HTTP → World ID API → 증명 검증
       ↓
5. CRE: 시빌 체크 (nullifier 확인)
       ↓
6. ValidationRegistry.validationResponse(requestHash, score, responseURI, responseHash, "HUMAN_VERIFIED")
   - score: 1 이상 (검증 성공 시)
   - tag: 반드시 "HUMAN_VERIFIED" (정확히 이 문자열)
       ↓
7. 본딩 완료 — 온체인에 기록됨
```

**핵심 함수 시그니처:**
```solidity
// 1단계: 검증 요청 (프론트엔드 또는 CRE가 호출)
function validationRequest(
    address validatorAddress,  // 0x1258f013d1ba690dc73ea89fd48f86e86ad0f124
    uint256 agentId,           // 에이전트 NFT ID
    string calldata requestURI // 증명 데이터 URI
) external returns (bytes32 requestHash);

// 2단계: 검증 응답 (CRE가 호출)
function validationResponse(
    bytes32 requestHash,       // 1단계에서 받은 해시
    uint8 score,               // 검증 점수 (1 이상 = 성공)
    string calldata responseURI,
    bytes32 responseHash,
    string calldata tag        // 반드시 "HUMAN_VERIFIED"
) external;
```

**중요: `tag`는 반드시 `"HUMAN_VERIFIED"`여야 함.** HumanVerifiedPolicy가 이 태그로 ValidationRegistry.getSummary를 조회함. 다른 태그를 쓰면 정책 체크에서 탈락.

---

### 3.2 Access Request (접근 요청) — ACE 파이프라인

접근 요청은 **WhitewallConsumer를 통해 ACE 파이프라인**을 거침.

```
Consumer 주소: 0xec3114ea6bb29f77b63cd1223533870b663120bb
onReport selector: 0x805f2132
```

**CRE Access Workflow 흐름:**
```
1. 에이전트가 리소스 접근 요청
       ↓
2. CRE Access Workflow 트리거
       ↓
3. CRE가 온체인 레지스트리 읽기:
   - IdentityRegistry.ownerOf(agentId) → 등록 여부
   - ValidationRegistry.getSummary(agentId, [worldIdValidator], "HUMAN_VERIFIED") → 검증 여부
       ↓
4. CRE가 리포트 생성 (아래 포맷)
       ↓
5. DON 서명 → Forwarder → WhitewallConsumer.onReport(metadata, report)
       ↓ [runPolicy modifier 자동 실행]
6. PolicyEngine → WhitewallExtractor → HumanVerifiedPolicy
   - Check 1: approved == true?
   - Check 2: tier >= 2?
   - Check 3: IdentityRegistry.ownerOf(agentId) — 온체인 직접 확인
   - Check 4: ValidationRegistry.getSummary(...) — 온체인 직접 확인
       ↓
7a. 모두 통과 → AccessGranted(agentId, accountableHuman, tier) 이벤트 발생
7b. 하나라도 실패 → 전체 tx revert
```

**리포트 포맷 (CRE가 생성해야 하는 형식):**
```solidity
abi.encode(
    uint256 agentId,          // 에이전트 NFT 토큰 ID
    bool    approved,         // CRE의 오프체인 판단 (true = 승인)
    uint8   tier,             // 검증 등급 (2 = HUMAN_VERIFIED)
    address accountableHuman, // 이 에이전트에 본딩된 인간의 주소
    bytes32 reason            // 거부 사유 (승인 시 0x00...00)
)
```

**이중 보호 (Double Protection):**
CRE가 `approved: true, tier: 2`로 리포트를 보내더라도, 온체인 HumanVerifiedPolicy가 독립적으로 레지스트리를 확인함. CRE가 해킹당해서 가짜 승인 리포트를 보내도, 실제 온체인 상태가 검증되지 않은 에이전트라면 거부됨.

---

### 3.3 Forwarder 설정

CRE 배포 후, 실제 Forwarder 주소를 Consumer에 등록해야 함:

```solidity
WhitewallConsumer(0xec3114ea6bb29f77b63cd1223533870b663120bb)
    .setForwarder(realForwarderAddress)
```

**주의:** `setForwarder`는 owner만 호출 가능. 현재 owner는 배포자 주소 `0x21fdEd74C901129977B8e28C2588595163E1e235`.

---

## 4. 재욱 완료 항목

### 4.1 스마트 컨트랙트

| 컨트랙트 | 파일 | 테스트 |
|----------|------|--------|
| IdentityRegistryUpgradeable | `contracts/IdentityRegistryUpgradeable.sol` | core.ts, upgradeable.ts |
| ValidationRegistryUpgradeable | `contracts/ValidationRegistryUpgradeable.sol` | core.ts, upgradeable.ts |
| ReputationRegistryUpgradeable | `contracts/ReputationRegistryUpgradeable.sol` | core.ts, upgradeable.ts |
| WorldIDValidator | `contracts/WorldIDValidator.sol` | core.ts |
| WhitewallConsumer | `contracts/ace/WhitewallConsumer.sol` | ace.ts (8/8) |
| WhitewallExtractor | `contracts/ace/WhitewallExtractor.sol` | ace.ts |
| HumanVerifiedPolicy | `contracts/ace/HumanVerifiedPolicy.sol` | ace.ts |
| PolicyEngine (vendored) | `contracts/ace/vendor/core/PolicyEngine.sol` | ace.ts |

**테스트 결과:**
- `test/ace.ts` — 8/8 통과 (ACE 파이프라인 + 이중 보호)
- `test/upgradeable.ts` — 18/18 통과 (프록시/업그레이드)
- `test/core.ts` — 55/61 통과 (6개 실패는 test infra 이슈, 컨트랙트 문제 아님)

### 4.2 Base Sepolia 배포

- 모든 컨트랙트 배포 완료 (주소는 위 섹션 2 참고)
- PolicyEngine 와이어링 완료 (Extractor + Policy 연결)
- Forwarder만 플레이스홀더 상태

### 4.3 TypeScript SDK (`sdk/`)

```
sdk/
├── src/
│   ├── index.ts          # 모든 export
│   ├── client.ts         # WhitewallOS 클래스
│   ├── types.ts          # AgentStatus, ValidationSummary 등
│   ├── abis.ts           # 컨트랙트 ABI
│   └── addresses.ts      # 체인별 배포 주소
├── test/
│   ├── unit.test.ts      # 14 unit tests
│   └── integration.test.ts # 12 integration tests (Base Sepolia)
├── examples/
│   └── check-agent.ts    # 사용 예시
├── package.json
└── tsconfig.json
```

**사용법:**
```typescript
import { WhitewallOS } from "@whitewall-os/sdk";

// connect()가 온체인 HumanVerifiedPolicy에서 정책 설정을 읽어옴
const wos = await WhitewallOS.connect({ chain: "baseSepolia" });

// 에이전트 검증 상태 조회
const status = await wos.getAgentStatus(1n);
// → { isRegistered: true, isHumanVerified: false, tier: 1, owner: "0x21fd...", ... }

// 개별 체크
await wos.isRegistered(1n);      // true
await wos.isHumanVerified(1n);   // false (아직 World ID 본딩 안 됨)

// 이벤트 감시
wos.onAccessGranted((event) => {
  console.log(event.agentId, event.accountableHuman, event.tier);
});
```

**테스트:** 26/26 통과 (14 unit + 12 integration)

### 4.4 Go SDK (`sdk-go/`)

```
sdk-go/
├── addresses.go    # 체인별 배포 주소 + PolicyConfig
├── abi.go          # 컨트랙트 ABI JSON
├── types.go        # AgentStatus, ValidationSummary
├── client.go       # WhitewallOS 구조체 + 모든 메서드
├── client_test.go  # 17 integration tests
└── go.mod
```

**사용법:**
```go
import whitewallos "github.com/whitewall-os/sdk-go"

ctx := context.Background()
a, _ := whitewallos.Connect(ctx, whitewallos.Config{Chain: whitewallos.BaseSepolia})
defer a.Close()

status, _ := a.GetAgentStatus(ctx, big.NewInt(1))
// status.IsRegistered == true
// status.IsHumanVerified == false
// status.Owner == 0x21fdEd74C901129977B8e28C2588595163E1e235
```

**테스트:** 17/17 통과 (전부 Base Sepolia 실시간 테스트, TS SDK와 교차 검증 포함)

### 4.5 MCP Server (`mcp/`)

```
mcp/
├── src/
│   └── index.ts    # MCP 서버 (3개 도구)
├── test-mcp.ts     # stdio 테스트 스크립트
├── package.json
└── tsconfig.json
```

**제공 도구:**
| 도구 | 설명 |
|------|------|
| `auth_os_check_agent` | 에이전트 검증 여부 빠른 확인 |
| `auth_os_get_status` | 에이전트 전체 상태 (등록, 검증, 등급, 소유자 등) |
| `auth_os_get_policy` | 현재 온체인 정책 설정 조회 |

**MCP 클라이언트 설정:**
```json
{
  "mcpServers": {
    "whitewall-os": {
      "command": "node",
      "args": ["/path/to/whitewall-os/mcp/dist/index.js"]
    }
  }
}
```

---

## 5. SDK/MCP가 정책을 읽는 방식

SDK와 MCP는 하드코딩된 값을 쓰지 않음. `connect()` 시 온체인 `HumanVerifiedPolicy`에서 4개 설정을 직접 읽어옴:

```
HumanVerifiedPolicy.getIdentityRegistry()    → 어떤 레지스트리에서 에이전트 확인
HumanVerifiedPolicy.getValidationRegistry()  → 어떤 레지스트리에서 검증 확인
HumanVerifiedPolicy.getWorldIdValidator()    → 어떤 검증자 주소로 필터
HumanVerifiedPolicy.getRequiredTier()        → 몇 등급부터 "검증됨"인지
```

정책 컨트랙트가 업그레이드되면 SDK도 자동으로 따라감. **ACE 파이프라인과 SDK가 항상 동일한 기준으로 판단함.**

---

## 6. 주의사항

1. **`tag`는 정확히 `"HUMAN_VERIFIED"`** — 대소문자, 공백 모두 정확해야 함
2. **`score`는 1 이상** — 0이면 `getSummary`의 `count`에 포함되지만 `avgResponse`가 0이 되어 정책 체크 통과 불가
3. **Forwarder 업데이트 필수** — 현재 플레이스홀더(`0x01`)이므로, CRE 배포 후 `setForwarder()` 호출 필요
4. **Owner 권한** — `setForwarder`는 Consumer의 owner만 호출 가능 (`0x21fdEd74C901129977B8e28C2588595163E1e235`)
5. **이중 보호** — CRE 리포트에 `approved: true`를 넣어도, 실제 온체인 상태가 검증 안 되어 있으면 거부됨. 반드시 본딩을 먼저 완료한 후 접근 요청해야 함.

---

## 7. 테스트용 에이전트

현재 Base Sepolia에 등록된 에이전트:

| Agent ID | Owner | 상태 |
|----------|-------|------|
| 1 | `0x21fdEd74C901129977B8e28C2588595163E1e235` | 등록됨, 미검증 (World ID 본딩 필요) |

예슬가 본딩 워크플로우를 테스트할 때 이 에이전트를 사용할 수 있음.

**SDK로 확인:**
```bash
# TypeScript
cd sdk && npx tsx examples/check-agent.ts 1

# Go
cd sdk-go && go test -run TestCrossSDKConsistency -v
```

---

## 8. ⚠️ WorldIDValidator v1.2.0 — Per-Agent Nullifier 변경사항

> **날짜:** 2025-02-17
> **영향 범위:** WorldIDValidator 컨트랙트 + 프론트엔드 데모

### 변경 이유

기존 v1.1.0은 **글로벌 externalNullifier**를 사용 → 한 사람이 하나의 agent만 검증 가능했음.
Whitewall의 모델은 "한 인간이 여러 agent를 소유하고, 각각을 검증"이므로 이 제한을 해제해야 했음.

### 변경 내용

| 항목 | v1.1.0 (이전) | v1.2.0 (현재) |
|------|---------------|---------------|
| **externalNullifier** | 글로벌 (appId + actionId로 한 번 계산, 저장) | **per-agent** (appIdHash + actionPrefix + agentId로 매번 계산) |
| **nullifierHash** | 동일 인간 = 동일 해시 (모든 agent에 대해) | 동일 인간이라도 **agent마다 다른 해시** |
| **한 인간의 agent 검증 수** | 1개 (NullifierAlreadyUsed 에러) | **무제한** |
| **프론트 action 문자열** | `"verify-owner"` (고정) | `"verify-owner-{agentId}"` (동적) |

### 스토리지 변경 (WorldIDValidatorStorage)

기존 필드 뒤에 2개 추가 (UUPS 업그레이드 안전):
```solidity
uint256 appIdHash;     // hashToField(appId) — per-agent nullifier 계산용
string actionPrefix;   // "verify-owner-" — agentId와 합쳐서 action 생성
```

### 새 함수: `initializeV2`

```solidity
function initializeV2(
    string calldata appId_,        // "app_staging_dae27f9b14a30e0e0917797aceac795a"
    string calldata actionPrefix_  // "verify-owner-"
) public reinitializer(2)
```

**배포 후 반드시 호출해야 함.** `appIdHash`가 0이면 v1 fallback으로 글로벌 nullifier 사용.

### `verifyAndSetHumanTag` 변경 로직

```solidity
// V2: per-agent nullifier
if ($.appIdHash != 0) {
    string memory action = string(abi.encodePacked($.actionPrefix, agentId.toString()));
    extNullifier = uint256(keccak256(abi.encodePacked($.appIdHash, action))) >> 8;
} else {
    // V1 fallback: 기존 글로벌 nullifier
    extNullifier = $.externalNullifier;
}
```

### CRE/Gateway에 미치는 영향

| 항목 | 영향 |
|------|------|
| **CRE Bonding Workflow** | ❌ 영향 없음 — CRE는 `validationRequest`/`validationResponse`를 통해 ValidationRegistry에 기록하므로 WorldIDValidator와 직접 상호작용하지 않음 |
| **CRE Access Workflow** | ❌ 영향 없음 — `getSummary`는 ValidationRegistry에서 읽으므로 nullifier 방식과 무관 |
| **SDK (`getAgentStatus`, `isHumanVerified`)** | ❌ 영향 없음 — 검증 여부 조회는 `verifications[agentId].isVerified`를 읽는 것이므로 nullifier와 무관 |
| **프론트엔드 데모** | ✅ 변경됨 — IDKitWidget의 `action` prop이 `"verify-owner-{agentId}"`로 변경 |
| **온체인 human→agent 연결** | ⚠️ 변경됨 — nullifier 기반 연결 불가. `ownerOf(agentId)`로 연결해야 함 (아래 참조) |

### Human → Agent 관계 조회 방법 (변경 후)

```
// 이전 (v1.1.0): nullifier 매칭
getVerificationData(824).nullifierHash == getVerificationData(825).nullifierHash → 같은 인간

// 이후 (v1.2.0): 소유권 매칭
IdentityRegistry.ownerOf(824) == IdentityRegistry.ownerOf(825) → 같은 인간
```

SDK에서는 nullifier 기반 연결을 사용하지 않으므로 **SDK 변경 불필요**.

### 배포 순서

```
1. 새 implementation 컨트랙트 배포
2. proxy.upgradeTo(newImpl)
3. proxy.initializeV2(
       "app_staging_dae27f9b14a30e0e0917797aceac795a",
       "verify-owner-"
   )
4. getVersion() → "1.2.0" 확인
```

### 주의사항

- `initializeV2` 호출 전까지는 v1 방식(글로벌 nullifier)으로 동작
- **기존에 검증된 agent(#824 등)는 영향 없음** — 이미 `isVerified == true`이므로 재검증 필요 없음
- `revokeVerification` 후 재검증 시: nullifier가 여전히 `nullifierUsed`에 남아있으므로 같은 인간이 같은 agent를 재검증하려면 nullifier를 수동으로 풀어야 함 (별도 admin 함수 필요 — 현재 미구현)

---

## 9. KYC + Credit 검증 (Confidential HTTP) — 2026-02-22 추가

> **핵심:** Stripe Identity (KYC) + Plaid (Credit Score)를 Chainlink CRE **Confidential HTTP**로 구현 완료.
> API 키는 DON vault(TEE 엔클레이브)에 저장 — 개별 노드에 노출되지 않음.
> 응답은 AES-GCM으로 암호화되어 DON 네트워크를 통과.

### 9.1 새로 배포된 컨트랙트 (Base Sepolia)

| 컨트랙트 | 주소 | 용도 |
|----------|------|------|
| StripeKYCValidator | `0x4e66fe730ae5476e79e70769c379663df4c61a8b` | Stripe Identity KYC 결과 저장 |
| PlaidCreditValidator | `0xceb46c0f2704d2191570bd81b622200097af9ade` | Plaid 신용점수 저장 (0-100) |
| KYCPolicy | `0xcc2998899ef3d4a0695340a8e548fe6b4527f2f5` | Tier 3 정책 (6개 체크) |
| CreditPolicy | `0xc53951d8f16016d43b1153a6889cf69d444bb5e9` | Tier 4 정책 (8개 체크) |

### 9.2 티어 모델 (변경됨)

데모에서는 KYC + Credit을 **단일 Tier 3**으로 통합. Premium 리소스가 없으므로 Tier 4는 사용하지 않음.

| Tier | 검증 | 리소스 |
|:---:|------|--------|
| 0 | 없음 | DENIED |
| 1 | 등록 (ERC-8004 NFT) | 기본 API |
| 2 | + World ID | 이미지 생성 |
| 3 | + KYC (Stripe) + Credit (Plaid) | 비디오 생성 |

온체인 컨트랙트는 Tier 3/4 분리 배포되어 있으나, **데모에서는 두 검증을 하나의 단계로 표시**.

### 9.3 CRE KYC Bonding Workflow (Confidential HTTP)

**워크플로우 파일:** `workflows/kyc-workflow/main.ts`

```
ValidationRequest(stripeKYCValidator, agentId, "stripe:<sessionId>", requestHash)
    ↓ (ValidationRegistry에서 이벤트 발생)
CRE Log Trigger → kyc-workflow 실행
    ↓
Confidential HTTP: GET https://api.stripe.com/v1/identity/verification_sessions/{sessionId}
  - Authorization: Basic {{.STRIPE_SECRET_KEY_B64}}
  - 시크릿은 DON vault(TEE)에서 주입 — {{.SECRET_NAME}} 템플릿 구문
  - encryptOutput: true (AES-GCM 암호화 응답)
    ↓
파싱: status == "verified" → score=100, verified=true
      status != "verified" → score=0, verified=false
    ↓
리포트: abi.encode(uint256 agentId, bool verified, bytes32 requestHash, bytes32 sessionHash)
    ↓
writeReport → Forwarder → StripeKYCValidator.onReport()
    ↓
StripeKYCValidator:
  - isKYCVerified[agentId] = verified
  - ValidationRegistry.validationResponse(requestHash, score, ...)
```

**Stripe sessionId 흐름:**
1. 유저가 프론트에서 Stripe Identity 세션 완료
2. 백엔드가 sessionId를 받아서 `validationRequest`의 requestURI에 포함: `"stripe:vs_xxxx"`
3. CRE가 이벤트에서 sessionId를 추출하여 Stripe API 호출

### 9.4 CRE Credit Bonding Workflow (Confidential HTTP)

**워크플로우 파일:** `workflows/credit-workflow/main.ts`

```
ValidationRequest(plaidCreditValidator, agentId, "plaid:<agentId>", requestHash)
    ↓ (ValidationRegistry에서 이벤트 발생)
CRE Log Trigger → credit-workflow 실행
    ↓
Confidential HTTP: POST https://sandbox.plaid.com/accounts/balance/get
  - body: {"client_id":"{{.PLAID_CLIENT_ID}}","secret":"{{.PLAID_SECRET}}","access_token":"{{.PLAID_ACCESS_TOKEN}}"}
  - 시크릿 3개 모두 DON vault(TEE)에서 주입
  - encryptOutput: true (AES-GCM 암호화 응답)
    ↓
파싱 → 신용점수 계산 (0-100):
  - 총 잔액 가중치: 40점
  - 계좌 수 가중치: 10점
  - 마이너스 잔액 없음: 30점
  - 계좌 유형 다양성: 20점
    ↓
리포트: abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)
    ↓
writeReport → Forwarder → PlaidCreditValidator.onReport()
    ↓
PlaidCreditValidator:
  - creditScores[agentId] = score
  - ValidationRegistry.validationResponse(requestHash, score, ...)
```

### 9.5 시크릿 설정

**secrets.yaml** (프로젝트 루트):
```yaml
secretsNames:
  STRIPE_SECRET_KEY_B64:
    - STRIPE_SECRET_KEY_B64
  PLAID_CLIENT_ID:
    - PLAID_CLIENT_ID
  PLAID_SECRET:
    - PLAID_SECRET
  PLAID_ACCESS_TOKEN:
    - PLAID_ACCESS_TOKEN
```

**.env** (시뮬레이션용 — 실제 DON에서는 vault에 저장):
```
STRIPE_SECRET_KEY_B64=<base64 encoded stripe secret key>
PLAID_CLIENT_ID=<plaid client id>
PLAID_SECRET=<plaid secret>
PLAID_ACCESS_TOKEN=<plaid access token>
```

**매핑:** `.env` 변수 → `secrets.yaml` 키 이름 → 워크플로우에서 `{{.KEY_NAME}}`으로 참조

### 9.6 Access Workflow 변경사항

**예슬이 만드는 CRE Access Workflow**에서 기존 체크에 추가로 읽어야 하는 항목:

```
기존 (Tier 2):
  Gate 1: IdentityRegistry.ownerOf(agentId) → 등록 여부
  Gate 2: WorldIDValidator.isHumanVerified(agentId) → 인간 검증

추가 (Tier 3):
  Gate 3: StripeKYCValidator.isKYCVerified(agentId) → KYC 완료 여부
  Gate 4: PlaidCreditValidator.getCreditScore(agentId) → 신용점수 (>= 50이면 통과)
```

**Validator 인터페이스:**
```solidity
// StripeKYCValidator (0x4e66fe730ae5476e79e70769c379663df4c61a8b)
function isKYCVerified(uint256 agentId) external view returns (bool);
function getKYCData(uint256 agentId) external view returns (
    bool verified, bytes32 sessionHash, uint256 verifiedAt
);

// PlaidCreditValidator (0xceb46c0f2704d2191570bd81b622200097af9ade)
function getCreditScore(uint256 agentId) external view returns (uint8);
function hasCreditScore(uint256 agentId) external view returns (bool);
function getCreditData(uint256 agentId) external view returns (
    uint8 score, bytes32 dataHash, uint256 verifiedAt, bool hasScore
);
```

**리포트 포맷 (변경됨):**
```solidity
abi.encode(
    uint256 agentId,
    bool    approved,
    uint8   tier,             // 2 = Human, 3 = Human+KYC+Credit
    address accountableHuman,
    bytes32 reason
)
```

### 9.7 워크플로우 실행 방법

**주의: CRE CLI v1.1.0 이상 필수** (`cre update`로 업데이트). v1.0.9에서는 시크릿 템플릿이 해석되지 않음.

```bash
# 1. ValidationRequest 트랜잭션 발행
npx hardhat run scripts/fire-validation-request.ts --network baseSepolia

# 2. KYC 워크플로우 시뮬레이션 (출력된 tx hash 사용)
cre workflow simulate ./workflows/kyc-workflow \
  --target local-simulation \
  --trigger-index 0 \
  --evm-tx-hash <kyc_tx_hash> \
  --evm-event-index 0 \
  --non-interactive --broadcast

# 3. Credit 워크플로우 시뮬레이션
cre workflow simulate ./workflows/credit-workflow \
  --target local-simulation \
  --trigger-index 0 \
  --evm-tx-hash <credit_tx_hash> \
  --evm-event-index 0 \
  --non-interactive --broadcast

# 4. 온체인 결과 확인
npx hardhat run scripts/verify-onchain.ts --network baseSepolia
```

### 9.8 E2E 테스트 결과 (2026-02-22)

| 워크플로우 | Agent | API 결과 | 온체인 결과 |
|-----------|-------|---------|------------|
| KYC (Stripe) | #998 | `status=verified` | `isKYCVerified(998) = true` |
| Credit (Plaid) | #998 | 12 accounts, score=100 | `getCreditScore(998) = 100` |

두 워크플로우 모두 `confidential-http@1.0.0-alpha` 캐퍼빌리티를 사용하여 실제 API 호출 + 온체인 기록 성공.

### 9.9 예슬 작업 체크리스트 (KYC/Credit 관련)

| # | 작업 | 설명 |
|---|------|------|
| 1 | Access Workflow에 Gate 3/4 추가 | `isKYCVerified()`, `getCreditScore()` 읽기 추가 |
| 2 | 티어 계산 로직 | Gate 1+2 통과 → tier=2, Gate 1+2+3+4 통과 → tier=3 |
| 3 | Forwarder 설정 | KYC/Credit Validator 컨트랙트에도 실제 Forwarder 주소 등록 필요 |
| 4 | Gateway → CRE 연동 | 게이트웨이가 `ValidationRequest` tx를 발행하면 CRE 노드가 워크플로우 실행 |

**Forwarder 설정 대상 (3개 컨트랙트 모두):**
```solidity
WhitewallConsumer(0xec3114ea...).setForwarder(realForwarderAddress)
StripeKYCValidator(0x4e66fe73...).setForwarder(realForwarderAddress)  // 새로 추가
PlaidCreditValidator(0xceb46c0f...).setForwarder(realForwarderAddress) // 새로 추가
```
