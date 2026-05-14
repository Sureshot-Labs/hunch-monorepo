import assert from "node:assert/strict";
import {
  agentApproveBodySchema,
  agentDeviceStartBodySchema,
  agentOrdersQuerySchema,
} from "./schemas/agent.js";
import { positionsQuerySchema } from "./schemas/positions.js";
import {
  AgentAuthService,
  summarizeAgentGrant,
  type AgentGrant,
} from "./services/agent-auth.js";
import { mapUnifiedOrder } from "./services/unified-order-presenter.js";
import type { UnifiedOrderRow } from "./repos/unified-orders.js";

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

await test("account position and order schemas expose agent-friendly filters", () => {
  const positions = positionsQuerySchema.parse({
    view: "summary",
    includeHidden: "true",
    activeOnly: "true",
    hideAutoLost: "true",
    marketStatus: "ACTIVE",
    limit: "20",
  });
  assert.equal(positions.view, "summary");
  assert.equal(positions.includeHidden, true);
  assert.equal(positions.activeOnly, true);
  assert.equal(positions.hideAutoLost, true);
  assert.equal(positions.marketStatus, "ACTIVE");
  assert.equal(positions.limit, 20);

  const orders = agentOrdersQuerySchema.parse({
    mint: "sol:mint-yes",
    inputMint: "input-mint",
    outputMint: "output-mint",
    openOnly: "false",
  });
  assert.equal(orders.mint, "sol:mint-yes");
  assert.equal(orders.inputMint, "input-mint");
  assert.equal(orders.outputMint, "output-mint");
  assert.equal(orders.openOnly, false);
});

await test("unified order presenter normalizes Kalshi market IDs", () => {
  const mapped = mapUnifiedOrder({
    id: "order-1",
    kind: "swap",
    venue: "kalshi",
    wallet_address: "wallet",
    venue_order_id: null,
    token_id: null,
    side: "BUY",
    outcome: "YES",
    order_type: null,
    price: null,
    size: null,
    status: "fulfilled",
    filled_size: null,
    average_fill_price: null,
    expires_at: null,
    created_at: null,
    updated_at: null,
    filled_at: null,
    cancelled_at: null,
    unified_market_id: "KXTEST-26",
    input_mint: "usdc",
    output_mint: "mint-yes",
    amount_in: "1",
    amount_out: "2",
    input_decimals: "6",
    output_decimals: "6",
    tx_signature: "sig",
  } satisfies UnifiedOrderRow);

  assert.equal(mapped.unifiedMarketId, "kalshi:KXTEST-26");
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
