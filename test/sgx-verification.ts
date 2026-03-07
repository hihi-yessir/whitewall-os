import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  keccak256,
  toHex,
  type Hex,
} from "viem";

/**
 * Tests for standalone SGX DCAP quote verification:
 *   - SgxVerifiedCreditValidator with MockSgxDcapVerifier (Automata V3 format)
 *   - ReportData format: sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
 */
describe("SGX DCAP Verification (Standalone)", async function () {
  const { viem } = await network.connect();

  async function setup() {
    const agentId = "agent-42";
    const score = 85;
    const requestHash = keccak256(toHex("test-request-1"));
    const expectedMrEnclave =
      "0xaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd" as Hex;

    const mockVerifier = await viem.deployContract("MockSgxDcapVerifier");

    const validator = await viem.deployContract("SgxVerifiedCreditValidator", [
      mockVerifier.address,
      expectedMrEnclave,
    ]);

    return { mockVerifier, validator, agentId, score, requestHash, expectedMrEnclave };
  }

  it("Valid quote → score recorded, CreditScoreVerified emitted", async () => {
    const { mockVerifier, validator, agentId, score, requestHash, expectedMrEnclave } =
      await setup();

    const publicClient = await viem.getPublicClient();
    const crypto = await import("node:crypto");

    // TEE format: sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
    const preimage = `agent:${agentId}|hash:${requestHash}|score:${score}`;
    const hashBuffer = crypto.createHash("sha256").update(preimage).digest();
    const expectedHash = ("0x" + hashBuffer.toString("hex")) as Hex;

    await mockVerifier.write.setMockMrEnclave([expectedMrEnclave]);
    await mockVerifier.write.setMockReportData([expectedHash]);
    await mockVerifier.write.setMockSuccess([true]);

    const dummyQuote = "0xdeadbeef" as Hex;
    const txHash = await validator.write.onReport([dummyQuote, agentId, requestHash, score]);

    const storedScore = await validator.read.creditScores([agentId]);
    assert.equal(storedScore, score, "Credit score should be stored");

    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    assert.ok(receipt.logs.length > 0, "Should emit CreditScoreVerified event");
  });

  it("Tampered score → revert 'Data manipulated in transit'", async () => {
    const { mockVerifier, validator, agentId, requestHash, expectedMrEnclave } =
      await setup();

    const crypto = await import("node:crypto");
    const preimage = `agent:${agentId}|hash:${requestHash}|score:85`;
    const hashBuffer = crypto.createHash("sha256").update(preimage).digest();
    const hashForScore85 = ("0x" + hashBuffer.toString("hex")) as Hex;

    await mockVerifier.write.setMockMrEnclave([expectedMrEnclave]);
    await mockVerifier.write.setMockReportData([hashForScore85]);
    await mockVerifier.write.setMockSuccess([true]);

    const dummyQuote = "0xdeadbeef" as Hex;

    await assert.rejects(
      validator.write.onReport([dummyQuote, agentId, requestHash, 99]),
      /Data manipulated in transit/,
    );
  });

  it("Wrong MRENCLAVE → revert 'Untrusted TEE Code (MRENCLAVE mismatch)'", async () => {
    const { mockVerifier, validator, agentId, score, requestHash } = await setup();

    const wrongMrEnclave =
      "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

    const crypto = await import("node:crypto");
    const preimage = `agent:${agentId}|hash:${requestHash}|score:${score}`;
    const hashBuffer = crypto.createHash("sha256").update(preimage).digest();
    const expectedHash = ("0x" + hashBuffer.toString("hex")) as Hex;

    await mockVerifier.write.setMockMrEnclave([wrongMrEnclave]);
    await mockVerifier.write.setMockReportData([expectedHash]);
    await mockVerifier.write.setMockSuccess([true]);

    const dummyQuote = "0xdeadbeef" as Hex;

    await assert.rejects(
      validator.write.onReport([dummyQuote, agentId, requestHash, score]),
      /Untrusted TEE Code \(MRENCLAVE mismatch\)/,
    );
  });
});
