# SGX TEE Credit Validator — Integration Guide

Guide for the CRE workflow implementer who will call the TEE service and write SGX-attested credit scores on-chain.

---

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| PlaidCreditValidator (proxy) | `0x07e8653b55a3cd703106c9726a140755204c1ad5` |
| V2 Implementation | `0x453d99a48902fe021cc88b1f5d77b1ace9c8f449` |
| Automata DCAP Verifier | `0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F` |
| KeystoneForwarder | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

**MRENCLAVE (approved TEE binary hash):**
```
0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c
```

---

## How It Works End-to-End

```
ValidationRequest event (ERC 8004 ValidationRegistry)
  → CRE workflow picks it up via log trigger
    → Confidential HTTP to your SGX TEE service
      → TEE: fetches Plaid data, computes score (0-100)
      → TEE: generates DCAP quote binding the result to agent + score
      → Returns { score, quote } to CRE
    → CRE encodes V2 report: abi.encode(agentId, score, requestHash, dataHash, sgxQuote)
    → DON signs report → writeReport
      → KeystoneForwarder → PlaidCreditValidator.onReport(metadata, report)
        → (1) Checks msg.sender == forwarder
        → (2) Checks agent exists in IdentityRegistry
        → (3) Calls Automata verifyAndAttestOnChain(sgxQuote)
        → (4) Extracts MRENCLAVE from verified output, checks it matches approved hash
        → (5) Extracts reportData, checks sha256 matches submitted (agentId, requestHash, score)
        → (6) Stores score on-chain
        → (7) Writes validationResponse() to ValidationRegistry (ERC 8004)
```

---

## Contract Structure

### PlaidCreditValidator.sol (V2, UUPS upgradeable)

**Storage (ERC7201 namespaced):**
```solidity
struct PlaidCreditValidatorStorage {
    // V1 fields
    address forwarderAddress;           // KeystoneForwarder — only caller allowed for onReport
    address identityRegistry;           // ERC 8004 IdentityRegistry — agent existence check
    address validationRegistry;         // ERC 8004 ValidationRegistry — writes responses
    mapping(uint256 => uint8) creditScores;
    mapping(uint256 => CreditVerification) verifications;
    // V2 fields (SGX)
    address sgxDcapVerifier;            // Automata DCAP verifier address
    bytes32 expectedMrEnclave;          // Approved TEE binary hash
}
```

**Key function — `onReport(bytes metadata, bytes report)`:**

The `report` bytes are ABI-decoded. V2 format:
```
abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash, bytes sgxQuote)
```

V1 format (backwards compatible, no SGX):
```
abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)
```

The contract auto-detects based on `report.length > 128`.

**SGX verification (only runs if `sgxDcapVerifier != address(0)` AND `sgxQuote.length > 0`):**

1. Calls `IAutomataDcapV3Attestation(sgxDcapVerifier).verifyAndAttestOnChain(sgxQuote)`
2. Automata returns `(bool success, bytes output)` where output is `abi.encodePacked`:
   - 11-byte header: `uint16 quoteVersion + uint16 bodyType + uint8 tcbStatus + bytes6 fmspc`
   - 384-byte SGX Enclave Report Body
3. Contract extracts via assembly:
   - `mrEnclave` at output offset **75** (11 header + 64 into report body)
   - `reportData` at output offset **331** (11 header + 320 into report body)
4. Checks `mrEnclave == expectedMrEnclave`
5. Checks `reportData == sha256("agent:{agentId}|hash:{requestHash}|score:{score}")`

**View functions:**
```solidity
getCreditScore(uint256 agentId) → uint8
hasCreditScore(uint256 agentId) → bool
getCreditData(uint256 agentId) → (uint8 score, bytes32 dataHash, uint256 verifiedAt, bool hasScore)
getConfig() → (address forwarder, address identityRegistry, address validationRegistry)
getSgxConfig() → (address verifier, bytes32 mrEnclave)
getVersion() → string  // "2.0.0"
```

**Admin functions (onlyOwner):**
```solidity
setSgxDcapVerifier(address verifier)
setExpectedMrEnclave(bytes32 mrEnclave)
setForwarder(address newForwarder)
```

---

## What the TEE Service Must Do

Your SGX enclave service receives a request and must return a score + DCAP quote.

### Request (from CRE workflow)
```json
{
  "clientId": "{{.PLAID_CLIENT_ID}}",
  "secret": "{{.PLAID_SECRET}}",
  "publicToken": "{{.PLAID_ACCESS_TOKEN}}",
  "agentId": "1",
  "requestHash": "0xabc123..."
}
```

### Response (back to CRE workflow)
```json
{
  "success": true,
  "score": 72,
  "quote": "03000200..."
}
```

- `score`: uint8 (0-100), the computed credit score
- `quote`: hex-encoded raw SGX DCAP quote (no `0x` prefix — CRE adds it)

### ReportData Binding

**This is the critical part.** The SGX enclave must write exactly this into the DCAP quote's `reportData` field (first 32 bytes):

```
sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
```

**Example:** for agentId=1, requestHash=0xabc...123, score=72:
```
sha256("agent:1|hash:0xabc...123|score:72")
```

- `agentId` is decimal string (e.g. `"1"`, `"42"`)
- `requestHash` is lowercase hex with `0x` prefix, 66 chars total (e.g. `"0xabc...123"`)
- `score` is decimal string (e.g. `"72"`, `"100"`, `"0"`)
- The hash goes into `reportData[0:32]` of the SGX enclave report

The contract recomputes this hash from the submitted parameters and compares it against the value extracted from the verified quote. If they don't match → revert `"Data manipulated in transit"`.

### MRENCLAVE

The compiled SGX enclave binary produces a deterministic `MRENCLAVE` measurement. This hash is stored on-chain as `expectedMrEnclave`. If the quote's `MRENCLAVE` doesn't match → revert `"Untrusted TEE Code (MRENCLAVE mismatch)"`.

When you rebuild the enclave binary, you need to call `setExpectedMrEnclave(newHash)` on the contract.

Current approved MRENCLAVE: `0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c`

---

## CRE Workflow Integration

Reference implementation: `workflows/credit-workflow/main.ts`

### Config
```typescript
const configSchema = z.object({
  validationRegistryAddress: z.string(),
  plaidCreditValidatorAddress: z.string(),
  chainSelectorName: z.string(),
  gasLimit: z.string(),
  teeServiceUrl: z.string(),  // your SGX TEE service endpoint
});
```

### TEE Call (via ConfidentialHTTP)
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

### V2 Report Encoding
```typescript
import { encodeAbiParameters, parseAbiParameters, keccak256, toHex } from "viem";

const reportData = encodeAbiParameters(
  parseAbiParameters(
    "uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash, bytes sgxQuote"
  ),
  [agentId, score, requestHash, dataHash, sgxQuoteBytes]
);
```

Where:
- `agentId`: `bigint` from the ValidationRequest event
- `score`: `number` (0-100) from TEE response
- `requestHash`: `bytes32` from the ValidationRequest event
- `dataHash`: `keccak256(toHex(teeResponseBody))` — hash of the full TEE response for traceability
- `sgxQuoteBytes`: `0x${teeResult.quote}` — the raw DCAP quote as hex bytes

### Report Submission
```typescript
// DON signs the report
const reportResponse = runtime.report({
  encodedPayload: hexToBase64(reportData),
  encoderName: "evm",
  signingAlgo: "ecdsa",
  hashingAlgo: "keccak256",
}).result();

// Write through KeystoneForwarder → PlaidCreditValidator.onReport()
evmClient.writeReport(runtime, {
  receiver: runtime.config.plaidCreditValidatorAddress,
  report: reportResponse,
  gasConfig: { gasLimit: runtime.config.gasLimit },
}).result();
```

---

## Interacting with Deployed Contracts

All examples use `cast` (Foundry) and Base Sepolia RPC. Set these for convenience:

```bash
export RPC=https://sepolia.base.org
export CREDIT_VALIDATOR=0x07e8653b55a3cd703106c9726a140755204c1ad5
export IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
export VALIDATION_REGISTRY=0x8004Cb1BF31DAf7788923b405b754f57acEB4272
export DCAP_VERIFIER=0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F
export FORWARDER=0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5
```

### PlaidCreditValidator — Read Operations

**Check contract version:**
```bash
cast call $CREDIT_VALIDATOR "getVersion()(string)" --rpc-url $RPC
# → "2.0.0"
```

**Read SGX configuration:**
```bash
cast call $CREDIT_VALIDATOR "getSgxConfig()(address,bytes32)" --rpc-url $RPC
# → (0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F, 0x13526955d1bdb877028dded02c8e975ab1967aa746aa174fa72e336793944d7c)
```

**Read forwarder + registry addresses:**
```bash
cast call $CREDIT_VALIDATOR "getConfig()(address,address,address)" --rpc-url $RPC
# → (forwarderAddress, identityRegistry, validationRegistry)
```

**Get an agent's credit score:**
```bash
# Replace 1 with the agentId (uint256)
cast call $CREDIT_VALIDATOR "getCreditScore(uint256)(uint8)" 1 --rpc-url $RPC
```

**Check if an agent has a credit score:**
```bash
cast call $CREDIT_VALIDATOR "hasCreditScore(uint256)(bool)" 1 --rpc-url $RPC
```

**Get full credit verification data for an agent:**
```bash
cast call $CREDIT_VALIDATOR "getCreditData(uint256)(uint8,bytes32,uint256,bool)" 1 --rpc-url $RPC
# → (score, dataHash, verifiedAt_timestamp, hasScore)
```

### PlaidCreditValidator — Write Operations (Admin, requires owner key)

**Update the SGX DCAP verifier address:**
```bash
cast send $CREDIT_VALIDATOR \
  "setSgxDcapVerifier(address)" \
  0x<new_verifier_address> \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

**Update the approved MRENCLAVE:**
```bash
cast send $CREDIT_VALIDATOR \
  "setExpectedMrEnclave(bytes32)" \
  0x<new_mrenclave_hash> \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

**Update the forwarder address:**
```bash
cast send $CREDIT_VALIDATOR \
  "setForwarder(address)" \
  0x<new_forwarder_address> \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

**Upgrade the proxy to a new implementation (owner only):**
```bash
# Deploy new implementation first, then:
cast send $CREDIT_VALIDATOR \
  "upgradeToAndCall(address,bytes)" \
  0x<new_impl_address> 0x \
  --rpc-url $RPC --private-key $PRIVATE_KEY
```

### PlaidCreditValidator — onReport (called by KeystoneForwarder only)

`onReport` is NOT called directly — the CRE DON calls `writeReport` on the KeystoneForwarder, which in turn calls `onReport(bytes metadata, bytes report)` on the PlaidCreditValidator. The forwarder check (`msg.sender == forwarderAddress`) prevents direct calls.

**Report encoding (V2 format):**
```
report = abi.encode(
    uint256 agentId,       // agent's token ID in IdentityRegistry
    uint8   score,         // credit score 0-100
    bytes32 requestHash,   // from the ValidationRequest event
    bytes32 dataHash,      // keccak256 of the raw TEE response body
    bytes   sgxQuote       // raw DCAP quote from the TEE service
)
```

**Report encoding (V1 format, backwards compatible — no SGX check):**
```
report = abi.encode(
    uint256 agentId,
    uint8   score,
    bytes32 requestHash,
    bytes32 dataHash
)
```

The contract detects V1 vs V2 by checking `report.length > 128`.

### Automata DCAP Verifier — Verify a Quote

**Simulate on-chain verification of a raw SGX quote:**
```bash
cast call $DCAP_VERIFIER \
  "verifyAndAttestOnChain(bytes)(bool,bytes)" \
  0x<raw_quote_hex> \
  --rpc-url $RPC
```

Returns `(true, <packed_output>)` on success, `(false, "TCBR")` on failure.

**With a specific tcbEvalDataNumber (advanced):**
```bash
cast call $DCAP_VERIFIER \
  "verifyAndAttestOnChain(bytes,uint32)(bool,bytes)" \
  0x<raw_quote_hex> 18 \
  --rpc-url $RPC
```

### IdentityRegistry — Check Agent Exists

**Check if an agent is registered (required before onReport can succeed):**
```bash
cast call $IDENTITY_REGISTRY "ownerOf(uint256)(address)" 1 --rpc-url $RPC
# → agent owner address (reverts if not registered)
```

### ValidationRegistry — Read Validation State

**The CRE workflow listens for this event to trigger credit checks:**
```
event ValidationRequest(
    address indexed validatorAddress,
    uint256 indexed agentId,
    string requestURI,
    bytes32 indexed requestHash
)
```

**After onReport succeeds, it writes back via:**
```solidity
validationResponse(
    bytes32 requestHash,    // same requestHash from the request
    uint8   response,       // the credit score
    string  responseURI,    // "" (empty)
    bytes32 responseHash,   // dataHash (keccak256 of TEE response)
    string  tag             // "CREDIT_SCORE"
)
```

### Events Emitted

**On successful credit score write:**
```
event CreditScoreSet(
    uint256 indexed agentId,
    uint8 score,
    bytes32 dataHash,
    uint256 timestamp
)
```

**Query past events:**
```bash
# Get all CreditScoreSet events
cast logs --from-block 0 --address $CREDIT_VALIDATOR \
  "CreditScoreSet(uint256 indexed,uint8,bytes32,uint256)" \
  --rpc-url $RPC

# Filter by specific agentId (topic1 = agentId as uint256)
cast logs --from-block 0 --address $CREDIT_VALIDATOR \
  "CreditScoreSet(uint256 indexed,uint8,bytes32,uint256)" \
  --topic1 0x0000000000000000000000000000000000000000000000000000000000000001 \
  --rpc-url $RPC
```

### Using viem (TypeScript/JS)

```typescript
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { plaidCreditValidatorAbi } from "@whitewall-os/sdk";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});

const CREDIT_VALIDATOR = "0x07e8653b55a3cd703106c9726a140755204c1ad5";

// Read credit score
const score = await client.readContract({
  address: CREDIT_VALIDATOR,
  abi: plaidCreditValidatorAbi,
  functionName: "getCreditScore",
  args: [1n],  // agentId
});

// Read full verification data
const [score, dataHash, verifiedAt, hasScore] = await client.readContract({
  address: CREDIT_VALIDATOR,
  abi: plaidCreditValidatorAbi,
  functionName: "getCreditData",
  args: [1n],
});

// Read SGX config
const [verifier, mrEnclave] = await client.readContract({
  address: CREDIT_VALIDATOR,
  abi: plaidCreditValidatorAbi,
  functionName: "getSgxConfig",
});

// Watch for CreditScoreSet events
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
      console.log(`Agent ${log.args.agentId} scored ${log.args.score}`);
    }
  },
});
```

### SDK ABI Exports

The `@whitewall-os/sdk` package (`sdk/src/abis.ts`) exports:

```typescript
import { plaidCreditValidatorAbi } from "@whitewall-os/sdk";
```

Includes: `getCreditScore`, `hasCreditScore`, `getCreditData`, `getSgxConfig`.

Note: `onReport` is NOT in the SDK ABI — it's only callable by the KeystoneForwarder via CRE writeReport, not by external clients.

---

## Automata DCAP Collateral

SGX quotes require on-chain PCCS collateral to verify. We use Automata's managed DCAP Dashboard:

- **Dashboard**: https://dcap.ata.network
- **FMSPC registered**: `30606A000000`
- **Network**: Base Sepolia
- **Plan**: Free (2 testnets, 10 FMSPCs)

Automata auto-syncs Intel collateral (TCB info, QE identity, CRLs, certs) for registered FMSPCs. If the TEE platform changes (different CPU family), register its FMSPC on the dashboard.

The verifier returns `success=true` for TCB statuses including `OutOfDate` and `SWHardeningNeeded` — only `TCB_REVOKED` or no matching level returns `success=false`.

---

## Testing

### Local (Hardhat)

```bash
cd whitewall-os
npx hardhat test test/sgx-verification.ts   # standalone SGX tests (3)
npx hardhat test test/kyc-credit.ts          # full stack + V2 tests (20)
```

Tests use `MockSgxDcapVerifier` which returns the same `abi.encodePacked` format as the real Automata verifier.

### On-Chain Verification (Base Sepolia)

Verify a raw quote against the deployed Automata verifier:
```bash
cast call 0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F \
  "verifyAndAttestOnChain(bytes)(bool,bytes)" \
  0x<your_quote_hex> \
  --rpc-url https://sepolia.base.org
```

Expected success: `(true, 0x...)`

Read current SGX config:
```bash
cast call 0x07e8653b55a3cd703106c9726a140755204c1ad5 \
  "getSgxConfig()(address,bytes32)" \
  --rpc-url https://sepolia.base.org
```

---

## Error Reference

| Revert Message | Cause |
|----------------|-------|
| `SGX quote verification failed` | Automata verifier returned `success=false`. Likely missing PCCS collateral — check FMSPC is registered on dcap.ata.network |
| `Untrusted TEE Code (MRENCLAVE mismatch)` | The quote was generated by a different enclave binary than the approved one. Update `expectedMrEnclave` or rebuild with the approved binary |
| `Data manipulated in transit` | The reportData hash in the quote doesn't match `sha256("agent:{agentId}\|hash:{requestHash}\|score:{score}")`. Either the TEE is computing the hash wrong, or the parameters were tampered with between TEE and on-chain |
| `Score exceeds maximum` | Score > 100 |
| `NotForwarder()` | `msg.sender` is not the configured KeystoneForwarder |
| `AgentNotRegistered(agentId)` | Agent doesn't exist in IdentityRegistry |

---

## Updating the Approved Enclave

When the TEE binary is rebuilt:

1. Get the new MRENCLAVE hash from the enclave build output (or from a test quote)
2. Call on the contract owner:
   ```bash
   cast send 0x07e8653b55a3cd703106c9726a140755204c1ad5 \
     "setExpectedMrEnclave(bytes32)" \
     0x<new_mrenclave> \
     --rpc-url https://sepolia.base.org \
     --private-key $PRIVATE_KEY
   ```

If the TEE runs on a different SGX platform (different FMSPC), register the new FMSPC at https://dcap.ata.network.
