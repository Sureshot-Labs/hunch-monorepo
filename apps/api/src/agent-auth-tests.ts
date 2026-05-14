import assert from "node:assert/strict";
import {
  agentApproveBodySchema,
  agentDeviceStartBodySchema,
} from "./schemas/agent.js";
import {
  AgentAuthService,
  summarizeAgentGrant,
  type AgentGrant,
} from "./services/agent-auth.js";

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[agent-auth-tests] ok ${name}`);
}

await test("allows only Phase 2 read scopes", () => {
  assert.deepEqual(AgentAuthService.allowedReadScopes(), [
    "read:account",
    "read:wallets",
    "read:orders",
    "read:positions",
    "read:funding",
    "read:notifications",
  ]);

  const invalid = agentDeviceStartBodySchema.safeParse({
    requestedScopes: ["submit:trade"],
  });
  assert.equal(invalid.success, false);
});

await test("approval schema keeps bounded read-only grant expiries", () => {
  const valid = agentApproveBodySchema.parse({
    approvalToken: "a".repeat(32),
    scopes: ["read:account", "read:notifications"],
    expiresInDays: 30,
  });
  assert.equal(valid.expiresInDays, 30);

  const forever = agentApproveBodySchema.safeParse({
    approvalToken: "a".repeat(32),
    scopes: ["read:account"],
    expiresInDays: 3650,
  });
  assert.equal(forever.success, false);
});

await test("grant summary excludes raw token metadata", () => {
  const grant: AgentGrant = {
    id: "grant-1",
    userId: "user-1",
    name: "Research Agent",
    clientName: "Codex",
    clientVersion: "0.1.0",
    clientKind: "mcp",
    tokenPrefix: "ha_test_secret",
    scopes: ["read:account"],
    walletAddresses: [],
    venues: [],
    allowedChains: [],
    allowedAssets: [],
    confirmationMode: "always",
    limits: {},
    metadata: {},
    isActive: true,
    expiresAt: new Date("2026-06-01T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  };

  const summary = summarizeAgentGrant(grant);
  assert.equal("tokenPrefix" in summary, false);
  assert.deepEqual(summary, {
    id: "grant-1",
    name: "Research Agent",
    clientName: "Codex",
    clientVersion: "0.1.0",
    clientKind: "mcp",
    scopes: ["read:account"],
    walletAddresses: [],
    venues: [],
    limits: {},
    confirmationMode: "always",
    isActive: true,
    expiresAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
  });
});
