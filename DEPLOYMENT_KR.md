# Whitewall OS — 배포 리포트 (Base Sepolia)

최종 배포일: 2026-03-07

---

## 배포된 컨트랙트

### ACE 스택 (UUPS 프록시)

| 컨트랙트 | 프록시 | 구현체 |
|----------|-------|--------|
| PolicyEngine | `0xc7afccc4b97786e34c07e4444496256d2f2b0b9a` | `0xadfdaffa65ac8b1d79fb8cb75b86e49934cb563a` |
| WhitewallExtractor | `0xa1c721059cbdc04a7bc6ea0026b82bb0d620979d` | (프록시 없음 — stateless) |
| TieredPolicy | `0xdb20a5d22cc7eb2a43628527667021121e80e30d` | `0x8a99a5db2d0487e29d760e132908af40f28e99ee` |
| WhitewallConsumer | `0x9670cc85a97c07a1bb6353fb968c6a2c153db99f` | `0x6d27f83a4bf69ad757b26637c689e6e2e9772083` |
| StripeKYCValidator | `0xebba79075ad00a22c5ff9a1f36a379f577265936` | `0x2ce72e8931963e739779ad28801444db985da2f2` |
| PlaidCreditValidator | `0x07e8653b55a3cd703106c9726a140755204c1ad5` | `0x453d99a48902fe021cc88b1f5d77b1ace9c8f449` |
| WorldIDValidator | `0xcadd809084debc999ce93384806da8ea90318e11` | `0x7b01612a436288f5e40f947be972526650b59e21` |

### ERC-8004 싱글톤 (변경 없음)

| 컨트랙트 | 주소 |
|----------|------|
| IdentityRegistryUpgradeable | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

### 인프라

| 구성 요소 | 주소 |
|-----------|------|
| CRE Forwarder (Base Sepolia) | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |

모든 구현체는 [Basescan](https://sepolia.basescan.org)에서 검증 완료.

---

## PolicyEngine 연결 구조

```
PolicyEngine (0xc7af...)
  ├── Extractor: WhitewallExtractor (0xa1c7...) — onReport 셀렉터 0x805f2132
  │     추출: agentId, approved, tier, accountableHuman, reason
  │
  └── Policy: TieredPolicy (0xdb20...) — WhitewallConsumer (0x9670...) + onReport
        기본 계층 (항상 실행):
          체크 1: approved == true
          체크 2: tier >= 2
          체크 3: IdentityRegistry.ownerOf(agentId) — 등록 여부
          체크 4: IdentityRegistry 메타데이터 "humanVerified" — 존재 여부
          체크 5: WorldIDValidator.isHumanVerified(agentId) — 위변조 방지
        KYC 계층 (tier >= 3일 때):
          체크 6: StripeKYCValidator.isKYCVerified(agentId)
        신용 계층 (tier >= 4일 때):
          체크 7: PlaidCreditValidator.hasCreditScore(agentId)
          체크 8: PlaidCreditValidator.getCreditScore(agentId) >= 50
```

---

## 티어별 접근 모델

| 티어 | 검증 | 접근 가능 리소스 |
|:---:|---|---|
| 0 | 없음 | 거부 |
| 1 | 등록 (ERC-8004 NFT) | 거부 (최소 기준 미달) |
| 2 | + World ID | 이미지 생성 |
| 3 | + KYC (Stripe Identity) | 비디오 생성 |
| 4 | + 신용 점수 (Plaid) | 프리미엄/무제한 |

각 티어는 누적 방식. TieredPolicy는 상위 티어 게이트를 평가하기 전에 모든 하위 티어 체크를 먼저 실행.

---

## 테스트 결과

### ACE 조건 테스트 (`test-ace.ts`)

| 테스트 | 결과 |
|--------|------|
| PolicyEngine 연결 (extractor + policy 매칭) | PASS |
| TieredPolicy 설정 (identityRegistry, worldIdValidator, kycValidator, creditValidator, minCreditScore=50) | PASS |
| Consumer의 forwarder가 CRE Forwarder로 설정됨 | PASS |
| `approved=false, tier=2` 거부: "CRE: agent not approved" | PASS |
| `approved=true, tier=1` 거부: "Insufficient verification tier" | PASS |
| `tier=2, 미등록 에이전트 (999999)` 거부: "Agent not registered" | PASS |
| `tier=3, 미등록 에이전트 (999999)` 기본 계층에서 거부 | PASS |
| `tier=4, 미등록 에이전트 (999999)` 기본 계층에서 거부 | PASS |

### CRE 워크플로우 시뮬레이션 테스트 (`cre workflow simulate`)

| 시나리오 | 에이전트 | 리소스 | 결과 | 티어 | TX 해시 |
|----------|---------|--------|------|------|---------|
| 등록됨, 인간 인증 없음 | #1 | image (티어 2) | 거부 | 1 | `0x3bd7f5f4...` |
| 미등록 | #999999 | image (티어 2) | 거부 | 0 | `0x02736da3...` |
| KYC 없음 | #1 | video (티어 3) | 거부 | 1 | `0x54a965d5...` |
| 신용 점수 없음 | #1 | premium (티어 4) | 거부 | 1 | `0x3f7803c7...` |

모든 리포트가 CRE Forwarder를 통해 WhitewallConsumer에 온체인으로 전달됨.

---

## CRE 워크플로우

### 접근 워크플로우 (`workflows/access-workflow/`)
트리거: HTTP. 대상: WhitewallConsumer.
리포트 형식: `abi.encode(uint256 agentId, bool approved, uint8 tier, address accountableHuman, bytes32 reason)`
흐름: HTTP 요청 -> 에이전트 상태 평가 -> DON 합의 -> writeReport -> Forwarder -> WhitewallConsumer.onReport() -> PolicyEngine -> TieredPolicy

### KYC 워크플로우 (`workflows/kyc-workflow/`)
트리거: EVM 로그 (ValidationRegistry.ValidationRequest). 대상: StripeKYCValidator.
흐름: ValidationRequest 이벤트 -> Confidential HTTP로 Stripe Identity 호출 -> writeReport -> Forwarder -> StripeKYCValidator.onReport()

### 신용 워크플로우 (`workflows/credit-workflow/`)
트리거: EVM 로그 (ValidationRegistry.ValidationRequest). 대상: PlaidCreditValidator.
흐름: ValidationRequest 이벤트 -> Confidential HTTP로 Plaid 호출 -> 신용 점수 계산 -> writeReport -> Forwarder -> PlaidCreditValidator.onReport()

---

## SDK (`sdk/src/`)

통합 TieredPolicy 컨트랙트에서 모든 정책 설정을 읽도록 업데이트.

| 파일 | 변경 사항 |
|------|-----------|
| `addresses.ts` | 새 컨트랙트 주소. 더 이상 사용하지 않는 `humanVerifiedPolicy` 필드 제거. |
| `abis.ts` | `humanVerifiedPolicyAbi`, `kycPolicyAbi`, `creditPolicyAbi`를 통합 `tieredPolicyAbi`로 대체 (뷰 함수 5개). |
| `client.ts` | `loadPolicyConfig()`이 TieredPolicy에서 5개 설정값을 한 번에 읽음. 기존 다중 정책 로딩 제거. |
| `index.ts` | 새 ABI에 맞게 export 업데이트. |

### SDK 사용법
```typescript
import { WhitewallOS } from "@whitewall-os/sdk";

const wos = await WhitewallOS.connect({ chain: "baseSepolia" });

// 빠른 확인
const registered = await wos.isRegistered(1n);
const human = await wos.isHumanVerified(1n);
const kyc = await wos.isKYCVerified(1n);
const credit = await wos.getCreditScore(1n);

// effectiveTier (0-4) 포함 전체 상태
const status = await wos.getFullStatus(1n);
console.log(status.effectiveTier); // 0=미등록, 1=등록, 2=인간인증, 3=KYC, 4=신용
```

---

## MCP 서버 (`mcp/`)

TieredPolicy 아키텍처 반영하여 업데이트.

| 도구 | 설명 |
|------|------|
| `whitewall_os_check_agent` | 빠른 확인: 에이전트가 등록되고 인간 인증되었는지 |
| `whitewall_os_get_status` | 전체 상태: 등록, 인증, 티어, 소유자, 지갑 |
| `whitewall_os_get_policy` | TieredPolicy에서 프로토콜 설정: 모든 검증자, minCreditScore |

설정: 리포지토리 루트의 `.mcp.json`, 상대 경로 `mcp/dist/index.js` 사용.

---

## 아키텍처 흐름

```
Gateway (HTTP)
    |
    v
CRE 접근 워크플로우 (DON 노드들)
    |  1. 에이전트 상태 조회 (오프체인)
    |  2. 티어 및 승인 평가
    |  3. DON 합의 + 리포트 서명
    |
    v
Forwarder (0x8230...)
    |  DON 서명 검증
    |
    v
WhitewallConsumer.onReport(metadata, report)
    |  runPolicy 모디파이어
    |
    v
PolicyEngine.run()
    |  1. WhitewallExtractor.extract() -> 파라미터
    |  2. TieredPolicy.run(params)
    |     - 기본 계층: 체크 1-5 (항상)
    |     - KYC 계층: 체크 6 (tier >= 3일 때)
    |     - 신용 계층: 체크 7-8 (tier >= 4일 때)
    |
    v (정책 통과 시)
Consumer 본문
    -> emit AccessGranted(agentId, human, tier)
    또는 emit AccessDenied(agentId, reason)
```

---

## 재배포

```bash
# 전체 스택 배포 + 연결 + 검증
npx hardhat run scripts/deploy-all.ts --network baseSepolia

# 연결만 따로 실행할 때
npx hardhat run scripts/wire-fresh.ts --network baseSepolia
```

### 테스트 명령어
```bash
# ACE 조건 테스트
npx hardhat run scripts/test-ace.ts --network baseSepolia

# CRE 워크플로우 시뮬레이션 (4가지 시나리오)
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

필요한 환경 변수 (`.env`):
```
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_SEPOLIA_PRIVATE_KEY=<배포자 개인키>
ETHERSCAN_API_KEY=<basescan API 키>
```
