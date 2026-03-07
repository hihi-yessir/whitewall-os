# SGX TEE Credit Validator — 통합 가이드

TEE 서비스를 호출하여 SGX 증명이 포함된 신용 점수를 온체인에 기록하는 CRE 워크플로우 구현자를 위한 가이드입니다.

---

## 배포된 컨트랙트 (Base Sepolia)

| 컨트랙트 | 주소 |
|----------|------|
| PlaidCreditValidator (프록시) | `0x07e8653b55a3cd703106c9726a140755204c1ad5` |
| V2 구현체 | `0x453d99a48902fe021cc88b1f5d77b1ace9c8f449` |
| Automata DCAP Verifier | `0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F` |
| KeystoneForwarder | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

**MRENCLAVE (승인된 TEE 바이너리 해시):**
```
0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c
```

---

## 전체 플로우

```
ValidationRequest 이벤트 (ERC 8004 ValidationRegistry)
  → CRE 워크플로우가 로그 트리거로 수신
    → Confidential HTTP로 SGX TEE 서비스 호출
      → TEE: Plaid 데이터 조회, 점수 계산 (0-100)
      → TEE: 결과를 agent + score에 바인딩하는 DCAP 견적(quote) 생성
      → { score, quote }를 CRE에 반환
    → CRE가 V2 리포트 인코딩: abi.encode(agentId, score, requestHash, dataHash, sgxQuote)
    → DON이 리포트 서명 → writeReport
      → KeystoneForwarder → PlaidCreditValidator.onReport(metadata, report)
        → (1) msg.sender == forwarder 확인
        → (2) IdentityRegistry에 에이전트 존재 여부 확인
        → (3) Automata verifyAndAttestOnChain(sgxQuote) 호출
        → (4) 검증된 출력에서 MRENCLAVE 추출, 승인된 해시와 일치하는지 확인
        → (5) reportData 추출, sha256이 제출된 (agentId, requestHash, score)와 일치하는지 확인
        → (6) 점수를 온체인에 저장
        → (7) ValidationRegistry에 validationResponse() 기록 (ERC 8004)
```

---

## 컨트랙트 구조

### PlaidCreditValidator.sol (V2, UUPS 업그레이드 가능)

**스토리지 (ERC7201 네임스페이스):**
```solidity
struct PlaidCreditValidatorStorage {
    // V1 필드
    address forwarderAddress;           // KeystoneForwarder — onReport 호출이 허용된 유일한 caller
    address identityRegistry;           // ERC 8004 IdentityRegistry — 에이전트 존재 확인
    address validationRegistry;         // ERC 8004 ValidationRegistry — 응답 기록
    mapping(uint256 => uint8) creditScores;
    mapping(uint256 => CreditVerification) verifications;
    // V2 필드 (SGX)
    address sgxDcapVerifier;            // Automata DCAP verifier 주소
    bytes32 expectedMrEnclave;          // 승인된 TEE 바이너리 해시
}
```

**핵심 함수 — `onReport(bytes metadata, bytes report)`:**

`report` 바이트는 ABI 디코딩됩니다. V2 형식:
```
abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash, bytes sgxQuote)
```

V1 형식 (하위 호환, SGX 없음):
```
abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)
```

컨트랙트는 `report.length > 128`을 기준으로 자동 감지합니다.

**SGX 검증 (`sgxDcapVerifier != address(0)` AND `sgxQuote.length > 0`인 경우에만 실행):**

1. `IAutomataDcapV3Attestation(sgxDcapVerifier).verifyAndAttestOnChain(sgxQuote)` 호출
2. Automata가 `(bool success, bytes output)`을 반환하며, output은 `abi.encodePacked` 형식:
   - 11바이트 헤더: `uint16 quoteVersion + uint16 bodyType + uint8 tcbStatus + bytes6 fmspc`
   - 384바이트 SGX Enclave Report Body
3. 컨트랙트가 어셈블리로 추출:
   - `mrEnclave`: output 오프셋 **75** (헤더 11 + 리포트 바디 내 64)
   - `reportData`: output 오프셋 **331** (헤더 11 + 리포트 바디 내 320)
4. `mrEnclave == expectedMrEnclave` 확인
5. `reportData == sha256("agent:{agentId}|hash:{requestHash}|score:{score}")` 확인

**조회 함수:**
```solidity
getCreditScore(uint256 agentId) → uint8
hasCreditScore(uint256 agentId) → bool
getCreditData(uint256 agentId) → (uint8 score, bytes32 dataHash, uint256 verifiedAt, bool hasScore)
getConfig() → (address forwarder, address identityRegistry, address validationRegistry)
getSgxConfig() → (address verifier, bytes32 mrEnclave)
getVersion() → string  // "2.0.0"
```

**관리자 함수 (onlyOwner):**
```solidity
setSgxDcapVerifier(address verifier)
setExpectedMrEnclave(bytes32 mrEnclave)
setForwarder(address newForwarder)
```

---

## TEE 서비스가 해야 할 일

SGX 엔클레이브 서비스는 요청을 받아 점수 + DCAP 견적을 반환해야 합니다.

### 요청 (CRE 워크플로우에서)
```json
{
  "clientId": "{{.PLAID_CLIENT_ID}}",
  "secret": "{{.PLAID_SECRET}}",
  "publicToken": "{{.PLAID_ACCESS_TOKEN}}",
  "agentId": "1",
  "requestHash": "0xabc123..."
}
```

### 응답 (CRE 워크플로우로)
```json
{
  "success": true,
  "score": 72,
  "quote": "03000200..."
}
```

- `score`: uint8 (0-100), 계산된 신용 점수
- `quote`: hex 인코딩된 원시 SGX DCAP 견적 (`0x` 접두사 없음 — CRE가 추가)

### ReportData 바인딩

**이것이 가장 중요한 부분입니다.** SGX 엔클레이브는 DCAP 견적의 `reportData` 필드(처음 32바이트)에 정확히 다음을 기록해야 합니다:

```
sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
```

**예시:** agentId=1, requestHash=0xabc...123, score=72인 경우:
```
sha256("agent:1|hash:0xabc...123|score:72")
```

- `agentId`는 10진수 문자열 (예: `"1"`, `"42"`)
- `requestHash`는 `0x` 접두사가 붙은 소문자 hex, 총 66자 (예: `"0xabc...123"`)
- `score`는 10진수 문자열 (예: `"72"`, `"100"`, `"0"`)
- 해시는 SGX 엔클레이브 리포트의 `reportData[0:32]`에 들어갑니다

컨트랙트는 제출된 파라미터로 이 해시를 재계산하고 검증된 견적에서 추출한 값과 비교합니다. 일치하지 않으면 → `"Data manipulated in transit"`으로 revert됩니다.

### MRENCLAVE

컴파일된 SGX 엔클레이브 바이너리는 결정론적 `MRENCLAVE` 측정값을 생성합니다. 이 해시는 온체인에 `expectedMrEnclave`로 저장됩니다. 견적의 `MRENCLAVE`가 일치하지 않으면 → `"Untrusted TEE Code (MRENCLAVE mismatch)"`로 revert됩니다.

엔클레이브 바이너리를 다시 빌드할 때 컨트랙트에서 `setExpectedMrEnclave(newHash)`를 호출해야 합니다.

현재 승인된 MRENCLAVE: `0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c`

---

## CRE 워크플로우 통합

참조 구현: `workflows/credit-workflow/main.ts`

### 설정
```typescript
const configSchema = z.object({
  validationRegistryAddress: z.string(),
  plaidCreditValidatorAddress: z.string(),
  chainSelectorName: z.string(),
  gasLimit: z.string(),
  teeServiceUrl: z.string(),  // SGX TEE 서비스 엔드포인트
});
```

### TEE 호출 (ConfidentialHTTP 사용)
```typescript
const teeResp = confidentialHttpClient.sendRequest(runtime, {
  vaultDonSecrets: [
    { key: "PLAID_CLIENT_ID", namespace: "" },
    { key: "PLAID_SECRET", namespace: "" },
    { key: "PLAID_ACCESS_TOKEN", namespace: "" },
  ],
  request: {
    url: runtime.config.teeServiceUrl,
    method: "POST",
    bodyString: JSON.stringify({
      clientId: "{{.PLAID_CLIENT_ID}}",
      secret: "{{.PLAID_SECRET}}",
      publicToken: "{{.PLAID_ACCESS_TOKEN}}",
      agentId: agentId.toString(),
      requestHash: requestHash,
    }),
    multiHeaders: { "Content-Type": { values: ["application/json"] } },
    encryptOutput: true,
  },
}).result();
```

### V2 리포트 인코딩
```typescript
import { encodeAbiParameters, parseAbiParameters, keccak256, toHex } from "viem";

const reportData = encodeAbiParameters(
  parseAbiParameters(
    "uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash, bytes sgxQuote"
  ),
  [agentId, score, requestHash, dataHash, sgxQuoteBytes]
);
```

각 필드:
- `agentId`: ValidationRequest 이벤트에서 가져온 `bigint`
- `score`: TEE 응답의 `number` (0-100)
- `requestHash`: ValidationRequest 이벤트에서 가져온 `bytes32`
- `dataHash`: `keccak256(toHex(teeResponseBody))` — 추적성을 위한 전체 TEE 응답의 해시
- `sgxQuoteBytes`: `0x${teeResult.quote}` — hex 바이트로 된 원시 DCAP 견적

### 리포트 제출
```typescript
// DON이 리포트 서명
const reportResponse = runtime.report({
  encodedPayload: hexToBase64(reportData),
  encoderName: "evm",
  signingAlgo: "ecdsa",
  hashingAlgo: "keccak256",
}).result();

// KeystoneForwarder를 통해 기록 → PlaidCreditValidator.onReport()
evmClient.writeReport(runtime, {
  receiver: runtime.config.plaidCreditValidatorAddress,
  report: reportResponse,
  gasConfig: { gasLimit: runtime.config.gasLimit },
}).result();
```

---

## 배포된 컨트랙트와 상호작용

모든 예시는 `cast` (Foundry)와 Base Sepolia RPC를 사용합니다. 편의를 위해 다음을 설정하세요:

```bash
export RPC=https://sepolia.base.org
export CREDIT_VALIDATOR=0x07e8653b55a3cd703106c9726a140755204c1ad5
export IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
export VALIDATION_REGISTRY=0x8004Cb1BF31DAf7788923b405b754f57acEB4272
export DCAP_VERIFIER=0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F
export FORWARDER=0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5
```

### PlaidCreditValidator — 조회 작업

**컨트랙트 버전 확인:**
```bash
cast call $CREDIT_VALIDATOR "getVersion()(string)" --rpc-url $RPC
# → "2.0.0"
```

**SGX 설정 조회:**
```bash
cast call $CREDIT_VALIDATOR "getSgxConfig()(address,bytes32)" --rpc-url $RPC
# → (0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F, 0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c)
```

**Forwarder + 레지스트리 주소 조회:**
```bash
cast call $CREDIT_VALIDATOR "getConfig()(address,address,address)" --rpc-url $RPC
# → (forwarderAddress, identityRegistry, validationRegistry)
```

**에이전트의 신용 점수 조회:**
```bash
# 1을 agentId (uint256)로 교체
cast call $CREDIT_VALIDATOR "getCreditScore(uint256)(uint8)" 1 --rpc-url $RPC
```

**에이전트에 신용 점수가 있는지 확인:**
```bash
cast call $CREDIT_VALIDATOR "hasCreditScore(uint256)(bool)" 1 --rpc-url $RPC
```

**에이전트의 전체 신용 검증 데이터 조회:**
```bash
cast call $CREDIT_VALIDATOR "getCreditData(uint256)(uint8,bytes32,uint256,bool)" 1 --rpc-url $RPC
# → (score, dataHash, verifiedAt_타임스탬프, hasScore)
```

### PlaidCreditValidator — 쓰기 작업 (관리자, owner 키 필요)

**SGX DCAP verifier 주소 업데이트:**
```bash
cast send $CREDIT_VALIDATOR \
  "setSgxDcapVerifier(address)" \
  0x<새_verifier_주소> \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

**승인된 MRENCLAVE 업데이트:**
```bash
cast send $CREDIT_VALIDATOR \
  "setExpectedMrEnclave(bytes32)" \
  0x<새_mrenclave_해시> \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

**Forwarder 주소 업데이트:**
```bash
cast send $CREDIT_VALIDATOR \
  "setForwarder(address)" \
  0x<새_forwarder_주소> \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

**프록시를 새 구현체로 업그레이드 (owner만 가능):**
```bash
# 먼저 새 구현체를 배포한 후:
cast send $CREDIT_VALIDATOR \
  "upgradeToAndCall(address,bytes)" \
  0x<새_구현체_주소> 0x \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

### PlaidCreditValidator — onReport (KeystoneForwarder만 호출 가능)

`onReport`는 직접 호출되지 않습니다 — CRE DON이 KeystoneForwarder의 `writeReport`를 호출하고, 이것이 PlaidCreditValidator의 `onReport(bytes metadata, bytes report)`를 호출합니다. Forwarder 확인 (`msg.sender == forwarderAddress`)이 직접 호출을 차단합니다.

**리포트 인코딩 (V2 형식):**
```
report = abi.encode(
    uint256 agentId,       // IdentityRegistry에서의 에이전트 토큰 ID
    uint8   score,         // 신용 점수 0-100
    bytes32 requestHash,   // ValidationRequest 이벤트에서 가져옴
    bytes32 dataHash,      // 원시 TEE 응답 본문의 keccak256
    bytes   sgxQuote       // TEE 서비스의 원시 DCAP 견적
)
```

**리포트 인코딩 (V1 형식, 하위 호환 — SGX 검사 없음):**
```
report = abi.encode(
    uint256 agentId,
    uint8   score,
    bytes32 requestHash,
    bytes32 dataHash
)
```

컨트랙트는 `report.length > 128`을 확인하여 V1과 V2를 구분합니다.

### Automata DCAP Verifier — 견적 검증

**원시 SGX 견적의 온체인 검증 시뮬레이션:**
```bash
cast call $DCAP_VERIFIER \
  "verifyAndAttestOnChain(bytes)(bool,bytes)" \
  0x<원시_견적_hex> \
  --rpc-url $RPC
```

성공 시 `(true, <packed_output>)` 반환, 실패 시 `(false, "TCBR")` 반환.

**특정 tcbEvalDataNumber 사용 (고급):**
```bash
cast call $DCAP_VERIFIER \
  "verifyAndAttestOnChain(bytes,uint32)(bool,bytes)" \
  0x<원시_견적_hex> 18 \
  --rpc-url $RPC
```

### IdentityRegistry — 에이전트 존재 확인

**에이전트가 등록되어 있는지 확인 (onReport 성공 전 필수):**
```bash
cast call $IDENTITY_REGISTRY "ownerOf(uint256)(address)" 1 --rpc-url $RPC
# → 에이전트 소유자 주소 (등록되지 않은 경우 revert)
```

### ValidationRegistry — 검증 상태 조회

**CRE 워크플로우가 신용 검사를 트리거하기 위해 수신하는 이벤트:**
```
event ValidationRequest(
    address indexed validatorAddress,
    uint256 indexed agentId,
    string requestURI,
    bytes32 indexed requestHash
)
```

**onReport 성공 후 다음을 통해 응답 기록:**
```solidity
validationResponse(
    bytes32 requestHash,    // 요청의 동일한 requestHash
    uint8   response,       // 신용 점수
    string  responseURI,    // "" (빈 문자열)
    bytes32 responseHash,   // dataHash (TEE 응답의 keccak256)
    string  tag             // "CREDIT_SCORE"
)
```

### 발행되는 이벤트

**신용 점수 기록 성공 시:**
```
event CreditScoreSet(
    uint256 indexed agentId,
    uint8 score,
    bytes32 dataHash,
    uint256 timestamp
)
```

**과거 이벤트 조회:**
```bash
# 모든 CreditScoreSet 이벤트 조회
cast logs --from-block 0 --address $CREDIT_VALIDATOR \
  "CreditScoreSet(uint256 indexed,uint8,bytes32,uint256)" \
  --rpc-url $RPC

# 특정 agentId로 필터링 (topic1 = uint256으로 된 agentId)
cast logs --from-block 0 --address $CREDIT_VALIDATOR \
  "CreditScoreSet(uint256 indexed,uint8,bytes32,uint256)" \
  --topic1 0x0000000000000000000000000000000000000000000000000000000000000001 \
  --rpc-url $RPC
```

### viem 사용 (TypeScript/JS)

```typescript
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { plaidCreditValidatorAbi } from "@whitewall-os/sdk";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});

const CREDIT_VALIDATOR = "0x07e8653b55a3cd703106c9726a140755204c1ad5";

// 신용 점수 조회
const score = await client.readContract({
  address: CREDIT_VALIDATOR,
  abi: plaidCreditValidatorAbi,
  functionName: "getCreditScore",
  args: [1n],  // agentId
});

// 전체 검증 데이터 조회
const [score, dataHash, verifiedAt, hasScore] = await client.readContract({
  address: CREDIT_VALIDATOR,
  abi: plaidCreditValidatorAbi,
  functionName: "getCreditData",
  args: [1n],
});

// SGX 설정 조회
const [verifier, mrEnclave] = await client.readContract({
  address: CREDIT_VALIDATOR,
  abi: plaidCreditValidatorAbi,
  functionName: "getSgxConfig",
});

// CreditScoreSet 이벤트 감시
client.watchContractEvent({
  address: CREDIT_VALIDATOR,
  abi: [
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
  ],
  eventName: "CreditScoreSet",
  onLogs: (logs) => {
    for (const log of logs) {
      console.log(`에이전트 ${log.args.agentId} 점수: ${log.args.score}`);
    }
  },
});
```

### SDK ABI 내보내기

`@whitewall-os/sdk` 패키지 (`sdk/src/abis.ts`)가 내보내는 것:

```typescript
import { plaidCreditValidatorAbi } from "@whitewall-os/sdk";
```

포함 함수: `getCreditScore`, `hasCreditScore`, `getCreditData`, `getSgxConfig`.

참고: `onReport`는 SDK ABI에 포함되어 있지 않습니다 — CRE writeReport를 통해 KeystoneForwarder만 호출할 수 있으며, 외부 클라이언트는 호출할 수 없습니다.

---

## Automata DCAP 담보 데이터(Collateral)

SGX 견적 검증에는 온체인 PCCS 담보 데이터가 필요합니다. Automata의 관리형 DCAP 대시보드를 사용합니다:

- **대시보드**: https://dcap.ata.network
- **등록된 FMSPC**: `30606A000000`
- **네트워크**: Base Sepolia
- **플랜**: 무료 (테스트넷 2개, FMSPC 10개)

Automata가 등록된 FMSPC에 대해 Intel 담보 데이터(TCB 정보, QE ID, CRL, 인증서)를 자동으로 동기화합니다. TEE 플랫폼이 변경되면 (다른 CPU 패밀리) 대시보드에서 해당 FMSPC를 등록하세요.

Verifier는 `OutOfDate`, `SWHardeningNeeded` 등의 TCB 상태에서도 `success=true`를 반환합니다 — `TCB_REVOKED`이거나 일치하는 레벨이 없는 경우에만 `success=false`를 반환합니다.

---

## 테스트

### 로컬 (Hardhat)

```bash
cd whitewall-os
npx hardhat test test/sgx-verification.ts   # 독립형 SGX 테스트 (3개)
npx hardhat test test/kyc-credit.ts          # 전체 스택 + V2 테스트 (20개)
```

테스트는 실제 Automata verifier와 동일한 `abi.encodePacked` 형식을 반환하는 `MockSgxDcapVerifier`를 사용합니다.

### 온체인 검증 (Base Sepolia)

배포된 Automata verifier로 원시 견적 검증:
```bash
cast call 0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F \
  "verifyAndAttestOnChain(bytes)(bool,bytes)" \
  0x<견적_hex> \
  --rpc-url https://sepolia.base.org
```

성공 시 예상 결과: `(true, 0x...)`

현재 SGX 설정 조회:
```bash
cast call 0x07e8653b55a3cd703106c9726a140755204c1ad5 \
  "getSgxConfig()(address,bytes32)" \
  --rpc-url https://sepolia.base.org
```

---

## 에러 참조

| Revert 메시지 | 원인 |
|---------------|------|
| `SGX quote verification failed` | Automata verifier가 `success=false`를 반환. PCCS 담보 데이터 누락 가능성 — dcap.ata.network에서 FMSPC 등록 여부 확인 |
| `Untrusted TEE Code (MRENCLAVE mismatch)` | 승인된 것과 다른 엔클레이브 바이너리로 견적이 생성됨. `expectedMrEnclave`를 업데이트하거나 승인된 바이너리로 다시 빌드 |
| `Data manipulated in transit` | 견적의 reportData 해시가 `sha256("agent:{agentId}\|hash:{requestHash}\|score:{score}")`와 일치하지 않음. TEE가 해시를 잘못 계산하거나 TEE와 온체인 사이에서 파라미터가 변조됨 |
| `Score exceeds maximum` | 점수 > 100 |
| `NotForwarder()` | `msg.sender`가 설정된 KeystoneForwarder가 아님 |
| `AgentNotRegistered(agentId)` | IdentityRegistry에 에이전트가 존재하지 않음 |

---

## 승인된 엔클레이브 업데이트

TEE 바이너리를 다시 빌드할 때:

1. 엔클레이브 빌드 출력(또는 테스트 견적)에서 새 MRENCLAVE 해시를 가져옵니다
2. 컨트랙트 owner로 호출:
   ```bash
   cast send 0x07e8653b55a3cd703106c9726a140755204c1ad5 \
     "setExpectedMrEnclave(bytes32)" \
     0x<새_mrenclave> \
     --rpc-url https://sepolia.base.org \
     --private-key $PRIVATE_KEY
   ```

TEE가 다른 SGX 플랫폼에서 실행되는 경우 (다른 FMSPC), https://dcap.ata.network 에서 새 FMSPC를 등록하세요.
