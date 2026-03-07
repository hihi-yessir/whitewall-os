import { describe, it, expect, vi } from "vitest";
import { WhitewallOS } from "../src/client.js";
import { addresses } from "../src/addresses.js";
import { zeroAddress, type PublicClient } from "viem";

const MOCK_POLICY_CONFIG = {
  identityRegistry: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as const,
  worldIdValidator: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as const,
  stripeKYCValidator: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" as const,
  plaidCreditValidator: "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE" as const,
  minCreditScore: 50,
};

function createMockClient() {
  const mock = {
    readContract: vi.fn(),
    watchEvent: vi.fn(() => vi.fn()),
  } as unknown as PublicClient<any, any>;

  (mock.readContract as any).mockImplementation(({ functionName }: any) => {
    switch (functionName) {
      case "getIdentityRegistry": return MOCK_POLICY_CONFIG.identityRegistry;
      case "getWorldIdValidator": return MOCK_POLICY_CONFIG.worldIdValidator;
      case "getStripeKYCValidator": return MOCK_POLICY_CONFIG.stripeKYCValidator;
      case "getPlaidCreditValidator": return MOCK_POLICY_CONFIG.plaidCreditValidator;
      case "getMinCreditScore": return MOCK_POLICY_CONFIG.minCreditScore;
      default: throw new Error(`unexpected call during connect: ${functionName}`);
    }
  });

  return mock;
}

describe("WhitewallOS — unit tests", () => {
  const chain = "baseSepolia" as const;
  const addrs = addresses[chain];

  describe("connect", () => {
    it("reads policy config from on-chain TieredPolicy", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      const config = wos.getPolicyConfig();
      expect(config.identityRegistry).toBe(MOCK_POLICY_CONFIG.identityRegistry);
      expect(config.worldIdValidator).toBe(MOCK_POLICY_CONFIG.worldIdValidator);
      expect(config.stripeKYCValidator).toBe(MOCK_POLICY_CONFIG.stripeKYCValidator);
      expect(config.plaidCreditValidator).toBe(MOCK_POLICY_CONFIG.plaidCreditValidator);
      expect(config.minCreditScore).toBe(50);
      expect(mock.readContract).toHaveBeenCalledTimes(5);
      for (const call of (mock.readContract as any).mock.calls) {
        expect(call[0].address).toBe(addrs.tieredPolicy);
      }
    });
  });

  describe("isRegistered", () => {
    it("returns true when ownerOf succeeds", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");
      expect(await wos.isRegistered(1n)).toBe(true);
    });

    it("returns false when ownerOf returns zero address", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(zeroAddress);
      expect(await wos.isRegistered(1n)).toBe(false);
    });

    it("returns false when ownerOf reverts", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockRejectedValue(new Error("ERC721: invalid token ID"));
      expect(await wos.isRegistered(999n)).toBe(false);
    });
  });

  describe("isHumanVerified", () => {
    it("returns true when WorldIDValidator says verified", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(true);
      expect(await wos.isHumanVerified(1n)).toBe(true);
    });

    it("returns false when not verified", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(false);
      expect(await wos.isHumanVerified(1n)).toBe(false);
    });
  });

  describe("getAgentStatus", () => {
    it("returns full status for registered + verified agent", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      const owner = "0x1111111111111111111111111111111111111111";
      const wallet = "0x2222222222222222222222222222222222222222";
      (mock.readContract as any).mockImplementation(({ functionName }: any) => {
        switch (functionName) {
          case "ownerOf": return owner;
          case "getAgentWallet": return wallet;
          case "isHumanVerified": return true;
          default: throw new Error(`unexpected: ${functionName}`);
        }
      });
      const status = await wos.getAgentStatus(42n);
      expect(status.isRegistered).toBe(true);
      expect(status.isHumanVerified).toBe(true);
      expect(status.tier).toBe(2);
      expect(status.owner).toBe(owner);
      expect(status.agentWallet).toBe(wallet);
    });

    it("returns empty status for non-existent agent", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockRejectedValue(new Error("ERC721: invalid token ID"));
      const status = await wos.getAgentStatus(999n);
      expect(status.isRegistered).toBe(false);
      expect(status.tier).toBe(0);
      expect(status.owner).toBe(zeroAddress);
    });

    it("returns tier 1 for registered but unverified agent", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockImplementation(({ functionName }: any) => {
        switch (functionName) {
          case "ownerOf": return "0x1111111111111111111111111111111111111111";
          case "getAgentWallet": return zeroAddress;
          case "isHumanVerified": return false;
          default: throw new Error(`unexpected: ${functionName}`);
        }
      });
      const status = await wos.getAgentStatus(1n);
      expect(status.isRegistered).toBe(true);
      expect(status.isHumanVerified).toBe(false);
      expect(status.tier).toBe(1);
    });
  });

  describe("getFullStatus", () => {
    it("returns tier 4 for fully verified agent", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockImplementation(({ functionName }: any) => {
        switch (functionName) {
          case "ownerOf": return "0x1111111111111111111111111111111111111111";
          case "getAgentWallet": return "0x2222222222222222222222222222222222222222";
          case "isHumanVerified": return true;
          case "isKYCVerified": return true;
          case "getCreditScore": return 85;
          default: throw new Error(`unexpected: ${functionName}`);
        }
      });
      const status = await wos.getFullStatus(42n);
      expect(status.effectiveTier).toBe(4);
      expect(status.isKYCVerified).toBe(true);
      expect(status.creditScore).toBe(85);
    });

    it("returns tier 3 for human+kyc but low credit", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockImplementation(({ functionName }: any) => {
        switch (functionName) {
          case "ownerOf": return "0x1111111111111111111111111111111111111111";
          case "getAgentWallet": return zeroAddress;
          case "isHumanVerified": return true;
          case "isKYCVerified": return true;
          case "getCreditScore": return 10;
          default: throw new Error(`unexpected: ${functionName}`);
        }
      });
      const status = await wos.getFullStatus(1n);
      expect(status.effectiveTier).toBe(3);
    });

    it("returns tier 0 for non-existent agent", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockRejectedValue(new Error("not found"));
      const status = await wos.getFullStatus(999n);
      expect(status.effectiveTier).toBe(0);
      expect(status.isKYCVerified).toBe(false);
      expect(status.creditScore).toBe(0);
    });
  });

  describe("KYC data", () => {
    it("getKYCData returns rich data", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      const sessionHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as const;
      (mock.readContract as any).mockResolvedValue([true, sessionHash, 1700000000n]);
      const data = await wos.getKYCData(1n);
      expect(data.verified).toBe(true);
      expect(data.sessionHash).toBe(sessionHash);
      expect(data.verifiedAt).toBe(1700000000n);
    });

    it("getKYCData returns defaults on error", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockRejectedValue(new Error("revert"));
      const data = await wos.getKYCData(999n);
      expect(data.verified).toBe(false);
      expect(data.verifiedAt).toBe(0n);
    });
  });

  describe("Credit data", () => {
    it("getCreditData returns rich data", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      const dataHash = "0xdeadbeef00000000000000000000000000000000000000000000000000000000" as const;
      (mock.readContract as any).mockResolvedValue([75, dataHash, 1700000000n, true]);
      const data = await wos.getCreditData(1n);
      expect(data.score).toBe(75);
      expect(data.dataHash).toBe(dataHash);
      expect(data.hasScore).toBe(true);
    });

    it("hasCreditScore returns boolean", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(true);
      expect(await wos.hasCreditScore(1n)).toBe(true);
    });

    it("hasCreditScore returns false on error", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockRejectedValue(new Error("revert"));
      expect(await wos.hasCreditScore(999n)).toBe(false);
    });
  });

  describe("TEE / SGX", () => {
    it("getSgxConfig returns verifier and mrEnclave", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      const verifier = "0x3333333333333333333333333333333333333333" as const;
      const mrEnclave = "0x1234000000000000000000000000000000000000000000000000000000000000" as const;
      (mock.readContract as any).mockResolvedValue([verifier, mrEnclave]);
      const config = await wos.getSgxConfig();
      expect(config.verifier).toBe(verifier);
      expect(config.mrEnclave).toBe(mrEnclave);
    });

    it("isTeeEnabled returns true when verifier is non-zero", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(["0x3333333333333333333333333333333333333333", "0x1234000000000000000000000000000000000000000000000000000000000000"]);
      expect(await wos.isTeeEnabled()).toBe(true);
    });

    it("isTeeEnabled returns false when verifier is zero", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue([zeroAddress, "0x0000000000000000000000000000000000000000000000000000000000000000"]);
      expect(await wos.isTeeEnabled()).toBe(false);
    });
  });

  describe("ValidationRegistry", () => {
    it("getValidationSummary calls correct address", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue([3n, 85]);
      const summary = await wos.getValidationSummary(42n);
      expect(summary.count).toBe(3n);
      expect(summary.avgResponse).toBe(85);
      const call = (mock.readContract as any).mock.calls.find((c: any) => c[0].functionName === "getSummary");
      expect(call).toBeDefined();
      expect(call[0].address).toBe(addrs.validationRegistry);
    });

    it("getAgentValidations returns hashes", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      const hashes = ["0xaaaa000000000000000000000000000000000000000000000000000000000000", "0xbbbb000000000000000000000000000000000000000000000000000000000000"] as const;
      (mock.readContract as any).mockResolvedValue(hashes);
      const result = await wos.getAgentValidations(1n);
      expect(result).toEqual(hashes);
    });

    it("getValidationStatus returns parsed struct", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(["0x5555555555555555555555555555555555555555", 42n, 100, "0xbbbb000000000000000000000000000000000000000000000000000000000000", "HUMAN_VERIFIED", 1700000000n]);
      const status = await wos.getValidationStatus("0xaaaa000000000000000000000000000000000000000000000000000000000000");
      expect(status.validatorAddress).toBe("0x5555555555555555555555555555555555555555");
      expect(status.agentId).toBe(42n);
      expect(status.response).toBe(100);
      expect(status.tag).toBe("HUMAN_VERIFIED");
    });
  });

  describe("balanceOf", () => {
    it("returns agent count for owner", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      (mock.readContract as any).mockResolvedValue(3n);
      expect(await wos.balanceOf("0x1111111111111111111111111111111111111111")).toBe(3n);
    });
  });

  describe("event watchers", () => {
    it("onAccessGranted watches consumer address", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      wos.onAccessGranted(() => {});
      expect(mock.watchEvent).toHaveBeenCalledWith(expect.objectContaining({ address: addrs.whitewallConsumer }));
    });

    it("onAccessDenied watches consumer address", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      wos.onAccessDenied(() => {});
      expect(mock.watchEvent).toHaveBeenCalledWith(expect.objectContaining({ address: addrs.whitewallConsumer }));
    });

    it("onRegistered watches identity registry", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      wos.onRegistered(() => {});
      expect(mock.watchEvent).toHaveBeenCalledWith(expect.objectContaining({ address: MOCK_POLICY_CONFIG.identityRegistry }));
    });

    it("onValidationRequest watches validation registry", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      wos.onValidationRequest(() => {});
      expect(mock.watchEvent).toHaveBeenCalledWith(expect.objectContaining({ address: addrs.validationRegistry }));
    });

    it("onValidationResponse watches validation registry", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      wos.onValidationResponse(() => {});
      expect(mock.watchEvent).toHaveBeenCalledWith(expect.objectContaining({ address: addrs.validationRegistry }));
    });

    it("onCreditScoreSet watches plaid credit validator", async () => {
      const mock = createMockClient();
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      wos.onCreditScoreSet(() => {});
      expect(mock.watchEvent).toHaveBeenCalledWith(expect.objectContaining({ address: MOCK_POLICY_CONFIG.plaidCreditValidator }));
    });

    it("returns unwatch function", async () => {
      const unwatch = vi.fn();
      const mock = createMockClient();
      (mock.watchEvent as any).mockReturnValue(unwatch);
      const wos = await WhitewallOS.connect({ chain, publicClient: mock });
      expect(wos.onAccessGranted(() => {})).toBe(unwatch);
    });
  });
});
