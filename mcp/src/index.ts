#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WhitewallOS, type FullAgentStatus } from "@whitewall-os/sdk";

const CHAIN = "baseSepolia" as const;

let wos: WhitewallOS;

function formatFullStatus(agentId: string, status: FullAgentStatus): string {
  if (!status.isRegistered) {
    return `Agent #${agentId}: NOT REGISTERED\nThis agent does not exist in the Whitewall OS protocol.`;
  }

  return [
    `Agent #${agentId}:`,
    `  Registered:       ${status.isRegistered}`,
    `  Human Verified:   ${status.isHumanVerified}`,
    `  KYC Verified:     ${status.isKYCVerified}`,
    `  Credit Score:     ${status.creditScore}`,
    `  Base Tier:        ${status.tier}`,
    `  Effective Tier:   ${status.effectiveTier}`,
    `  Owner:            ${status.owner}`,
    `  Agent Wallet:     ${status.agentWallet}`,
  ].join("\n");
}

const server = new McpServer({
  name: "whitewall-os",
  version: "0.3.0",
});

// ─── Tool: check agent ───
server.registerTool(
  "whitewall_os_check_agent",
  {
    title: "Check Whitewall OS Agent",
    description:
      "Quick check: is this agent registered and verified in Whitewall OS? " +
      "Returns human verification, KYC, credit score, and effective tier.",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe("The agent's numeric ID in the Whitewall OS IdentityRegistry"),
    }),
  },
  async ({ agentId }) => {
    const id = BigInt(agentId);
    const status = await wos.getFullStatus(id);

    let text: string;
    if (!status.isRegistered) {
      text = `Agent #${agentId} does NOT exist in Whitewall OS.`;
    } else {
      const parts = [`Agent #${agentId} is registered (Effective Tier ${status.effectiveTier}).`];
      parts.push(status.isHumanVerified
        ? "  Human Verified: YES — a real human is accountable for this agent."
        : "  Human Verified: NO — no accountability bond.");
      parts.push(status.isKYCVerified
        ? "  KYC: PASSED"
        : "  KYC: NOT VERIFIED");
      parts.push(`  Credit Score: ${status.creditScore}`);
      text = parts.join("\n");
    }

    return { content: [{ type: "text" as const, text }] };
  },
);

// ─── Tool: get full status ───
server.registerTool(
  "whitewall_os_get_status",
  {
    title: "Get Whitewall OS Agent Status",
    description:
      "Get full verification status for a Whitewall OS agent: registration, " +
      "human verification, KYC, credit score, effective tier, owner, and wallet.",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe("The agent's numeric ID in the Whitewall OS IdentityRegistry"),
    }),
  },
  async ({ agentId }) => {
    const status = await wos.getFullStatus(BigInt(agentId));
    return { content: [{ type: "text" as const, text: formatFullStatus(agentId, status) }] };
  },
);

// ─── Tool: get policy config ───
server.registerTool(
  "whitewall_os_get_policy",
  {
    title: "Get Whitewall OS Policy Config",
    description:
      "Read the current Whitewall OS protocol policy configuration from chain: " +
      "registry addresses, accepted validators, TEE status, and required verification tier.",
    inputSchema: z.object({}),
  },
  async () => {
    const config = wos.getPolicyConfig();
    const addrs = wos.getAddresses();

    let teeStatus = "unknown";
    try {
      const sgx = await wos.getSgxConfig();
      const enabled = await wos.isTeeEnabled();
      teeStatus = enabled
        ? `ENABLED (verifier: ${sgx.verifier}, mrEnclave: ${sgx.mrEnclave})`
        : "DISABLED";
    } catch {
      teeStatus = "error reading TEE config";
    }

    const text = [
      "Whitewall OS Policy Config (read from on-chain TieredPolicy):",
      `  Identity Registry:      ${config.identityRegistry}`,
      `  World ID Validator:     ${config.worldIdValidator}`,
      `  Stripe KYC Validator:   ${config.stripeKYCValidator}`,
      `  Plaid Credit Validator: ${config.plaidCreditValidator}`,
      `  Min Credit Score:       ${config.minCreditScore}`,
      `  TEE / SGX DCAP:         ${teeStatus}`,
      `  Validation Registry:    ${addrs.validationRegistry}`,
      `  Reputation Registry:    ${addrs.reputationRegistry}`,
      `  Chain:                  Base Sepolia (84532)`,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  },
);

// ─── Tool: get KYC data ───
server.registerTool(
  "whitewall_os_get_kyc_data",
  {
    title: "Get KYC Verification Data",
    description:
      "Get detailed KYC verification data for a Whitewall OS agent: " +
      "verification status, session hash, and timestamp.",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe("The agent's numeric ID in the Whitewall OS IdentityRegistry"),
    }),
  },
  async ({ agentId }) => {
    const id = BigInt(agentId);
    const data = await wos.getKYCData(id);
    const text = [
      `KYC Data for Agent #${agentId}:`,
      `  Verified:     ${data.verified}`,
      `  Session Hash: ${data.sessionHash}`,
      `  Verified At:  ${data.verifiedAt === 0n ? "never" : new Date(Number(data.verifiedAt) * 1000).toISOString()}`,
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

// ─── Tool: get credit data (with TEE status) ───
server.registerTool(
  "whitewall_os_get_credit_data",
  {
    title: "Get Credit Score Data with TEE Status",
    description:
      "Get detailed credit score data for a Whitewall OS agent including TEE/SGX " +
      "attestation status. Shows score, verification timestamp, and whether the " +
      "data was processed in a Trusted Execution Environment.",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe("The agent's numeric ID in the Whitewall OS IdentityRegistry"),
    }),
  },
  async ({ agentId }) => {
    const id = BigInt(agentId);
    const [creditData, teeEnabled, sgxConfig] = await Promise.all([
      wos.getCreditData(id),
      wos.isTeeEnabled(),
      wos.getSgxConfig(),
    ]);
    const text = [
      `Credit Data for Agent #${agentId}:`,
      `  Score:        ${creditData.score}`,
      `  Has Score:    ${creditData.hasScore}`,
      `  Data Hash:    ${creditData.dataHash}`,
      `  Verified At:  ${creditData.verifiedAt === 0n ? "never" : new Date(Number(creditData.verifiedAt) * 1000).toISOString()}`,
      `  TEE Enabled:  ${teeEnabled}`,
      teeEnabled ? `  SGX Verifier: ${sgxConfig.verifier}` : null,
      teeEnabled ? `  MRENCLAVE:    ${sgxConfig.mrEnclave}` : null,
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

// ─── Tool: get validations ───
server.registerTool(
  "whitewall_os_get_validations",
  {
    title: "Get Agent Validations",
    description:
      "Get validation history for a Whitewall OS agent from the ValidationRegistry. " +
      "Returns validation count, average response, and optionally detailed validation records.",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe("The agent's numeric ID in the Whitewall OS IdentityRegistry"),
      detailed: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, fetch and display each individual validation record"),
    }),
  },
  async ({ agentId, detailed }) => {
    const id = BigInt(agentId);
    const [summary, hashes] = await Promise.all([
      wos.getValidationSummary(id),
      wos.getAgentValidations(id),
    ]);

    const lines = [
      `Validations for Agent #${agentId}:`,
      `  Total Count:    ${summary.count}`,
      `  Avg Response:   ${summary.avgResponse}`,
      `  Request Hashes: ${hashes.length}`,
    ];

    if (detailed && hashes.length > 0) {
      lines.push("", "  Detailed Records:");
      for (const hash of hashes.slice(0, 10)) {
        const status = await wos.getValidationStatus(hash);
        lines.push(
          `    Hash:      ${hash}`,
          `    Validator: ${status.validatorAddress}`,
          `    Response:  ${status.response}`,
          `    Tag:       ${status.tag}`,
          `    ---`,
        );
      }
      if (hashes.length > 10) {
        lines.push(`    ... and ${hashes.length - 10} more`);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ─── Start ───
async function main() {
  wos = await WhitewallOS.connect({ chain: CHAIN });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start Whitewall OS MCP server:", err);
  process.exit(1);
});
