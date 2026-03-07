import { describe, it, expect, beforeAll } from "vitest";
import { WhitewallOS } from "../src/client.js";
import { zeroAddress } from "viem";

describe("WhitewallOS — Base Sepolia integration", () => {
  let wos: WhitewallOS;

  const EXISTING_AGENT = 1n;
  const NON_EXISTENT_AGENT = 999999n;

  beforeAll(async () => {
    wos = await WhitewallOS.connect({ chain: "baseSepolia" });
  }, 15_000);

  describe("connect — policy config from chain", () => {
    it("reads identity registry address", () => {
      const config = wos.getPolicyConfig();
      expect(config.identityRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(config.identityRegistry).not.toBe(zeroAddress);
    });

    it("reads world ID validator address", () => {
      expect(wos.getPolicyConfig().worldIdValidator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("reads stripe KYC validator address", () => {
      expect(wos.getPolicyConfig().stripeKYCValidator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("reads plaid credit validator address", () => {
      expect(wos.getPolicyConfig().plaidCreditValidator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("reads min credit score", () => {
      const score = wos.getPolicyConfig().minCreditScore;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("identity registry matches known deployed address", () => {
      expect(wos.getPolicyConfig().identityRegistry.toLowerCase()).toBe(
        "0x8004A818BFB912233c491871b3d84c89A494BD9e".toLowerCase(),
      );
    });
  });

  describe("agent queries", () => {
    it("isRegistered returns true for agent #1", async () => {
      expect(await wos.isRegistered(EXISTING_AGENT)).toBe(true);
    }, 15_000);

    it("isRegistered returns false for non-existent agent", async () => {
      expect(await wos.isRegistered(NON_EXISTENT_AGENT)).toBe(false);
    }, 15_000);

    it("getOwner returns non-zero address for agent #1", async () => {
      const owner = await wos.getOwner(EXISTING_AGENT);
      expect(owner).not.toBe(zeroAddress);
    }, 15_000);

    it("getOwner throws for non-existent agent", async () => {
      await expect(wos.getOwner(NON_EXISTENT_AGENT)).rejects.toThrow();
    }, 15_000);

    it("getAgentStatus returns full struct for agent #1", async () => {
      const status = await wos.getAgentStatus(EXISTING_AGENT);
      expect(status.isRegistered).toBe(true);
      expect(status.owner).not.toBe(zeroAddress);
      expect(status.tier).toBeGreaterThanOrEqual(1);
    }, 15_000);

    it("getAgentStatus returns empty for non-existent agent", async () => {
      const status = await wos.getAgentStatus(NON_EXISTENT_AGENT);
      expect(status.isRegistered).toBe(false);
      expect(status.tier).toBe(0);
      expect(status.owner).toBe(zeroAddress);
    }, 15_000);

    it("balanceOf returns count for known owner", async () => {
      const owner = await wos.getOwner(EXISTING_AGENT);
      expect(await wos.balanceOf(owner)).toBeGreaterThanOrEqual(1n);
    }, 15_000);
  });

  describe("full status with KYC + credit", () => {
    it("getFullStatus returns complete status for agent #1", async () => {
      const status = await wos.getFullStatus(EXISTING_AGENT);
      expect(status.isRegistered).toBe(true);
      expect(typeof status.isKYCVerified).toBe("boolean");
      expect(typeof status.creditScore).toBe("number");
      expect(status.effectiveTier).toBeGreaterThanOrEqual(1);
    }, 15_000);

    it("getFullStatus returns zero for non-existent agent", async () => {
      const status = await wos.getFullStatus(NON_EXISTENT_AGENT);
      expect(status.effectiveTier).toBe(0);
      expect(status.isKYCVerified).toBe(false);
      expect(status.creditScore).toBe(0);
    }, 15_000);
  });

  describe("KYC data", () => {
    it("getKYCData returns structured data", async () => {
      const data = await wos.getKYCData(EXISTING_AGENT);
      expect(typeof data.verified).toBe("boolean");
      expect(typeof data.verifiedAt).toBe("bigint");
      expect(data.sessionHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 15_000);
  });

  describe("Credit data", () => {
    it("getCreditData returns structured data", async () => {
      const data = await wos.getCreditData(EXISTING_AGENT);
      expect(typeof data.score).toBe("number");
      expect(typeof data.hasScore).toBe("boolean");
      expect(typeof data.verifiedAt).toBe("bigint");
    }, 15_000);

    it("hasCreditScore returns boolean", async () => {
      expect(typeof await wos.hasCreditScore(EXISTING_AGENT)).toBe("boolean");
    }, 15_000);
  });

  describe("TEE / SGX", () => {
    it("getSgxConfig returns verifier and mrEnclave", async () => {
      const config = await wos.getSgxConfig();
      expect(config.verifier).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(config.mrEnclave).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 15_000);

    it("isTeeEnabled returns boolean", async () => {
      expect(typeof await wos.isTeeEnabled()).toBe("boolean");
    }, 15_000);
  });

  describe("ValidationRegistry", () => {
    it("getValidationSummary returns count and avgResponse", async () => {
      const summary = await wos.getValidationSummary(EXISTING_AGENT);
      expect(typeof summary.count).toBe("bigint");
      expect(typeof summary.avgResponse).toBe("number");
    }, 15_000);

    it("getAgentValidations returns array of hashes", async () => {
      const hashes = await wos.getAgentValidations(EXISTING_AGENT);
      expect(Array.isArray(hashes)).toBe(true);
      for (const h of hashes) {
        expect(h).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }
    }, 15_000);

    it("getValidationStatus returns data for first hash", async () => {
      const hashes = await wos.getAgentValidations(EXISTING_AGENT);
      if (hashes.length === 0) return;
      const status = await wos.getValidationStatus(hashes[0]);
      expect(status.validatorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(status.agentId).toBe(EXISTING_AGENT);
    }, 15_000);
  });
});
