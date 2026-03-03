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
  version: "0.2.0",
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
      "registry addresses, accepted validators, and required verification tier.",
    inputSchema: z.object({}),
  },
  async () => {
    const config = wos.getPolicyConfig();
    const text = [
      "Whitewall OS Policy Config (read from on-chain TieredPolicy):",
      `  Identity Registry:      ${config.identityRegistry}`,
      `  World ID Validator:     ${config.worldIdValidator}`,
      `  Stripe KYC Validator:   ${config.stripeKYCValidator}`,
      `  Plaid Credit Validator: ${config.plaidCreditValidator}`,
      `  Min Credit Score:       ${config.minCreditScore}`,
      `  Chain:                  Base Sepolia (84532)`,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
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
