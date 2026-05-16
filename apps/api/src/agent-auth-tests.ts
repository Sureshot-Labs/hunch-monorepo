import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { AuthService, type User, type UserWallet } from "./auth.js";
import { env } from "./env.js";
import {
  agentApproveBodySchema,
  agentDeviceStartBodySchema,
  agentOrdersQuerySchema,
} from "./schemas/agent.js";
import {
  agentFundingPlanBodySchema,
  agentIntentRequestSchema,
} from "./schemas/agent-intents.js";
import { positionsQuerySchema } from "./schemas/positions.js";
import {
  AgentAuthService,
  summarizeAgentGrant,
  AgentAuthError,
  type AgentGrant,
} from "./services/agent-auth.js";
import {
  buildAgentFundingPlan,
  createAgentIntent,
  getAgentIntentById,
  previewAgentIntent,
} from "./services/agent-intents.js";
import {
  buildAgentDepositTargets,
  buildDepositPageUrl,
  filterDepositAssets,
} from "./services/agent-deposit-targets.js";
import { mapUnifiedOrder } from "./services/unified-order-presenter.js";
import type { UnifiedOrderRow } from "./repos/unified-orders.js";

if (!env.agentTokenHashSecret) {
  env.agentTokenHashSecret = "test-agent-token-hash-secret-32-bytes";
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[agent-auth-tests] ok ${name}`);
}

type FakePool = Pool & {
  calls: Array<{ text: string; values?: unknown[] }>;
};

function fakePool(responses: Array<{ rows: unknown[] }> = []): FakePool {
  const calls: FakePool["calls"] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return responses.shift() ?? { rows: [] };
    },
  } as unknown as FakePool;
}

const testUser: User = {
  id: "user-1",
  isAdmin: false,
  kalshiProofBypass: false,
  isActive: true,
  isVerified: true,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const testWallet: UserWallet = {
  id: "wallet-1",
  userId: testUser.id,
  walletAddress: "solana-wallet-1",
  walletType: "solana",
  name: null,
  isPrimary: true,
  isVerified: true,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const testEvmWallet: UserWallet = {
  id: "wallet-evm-1",
  userId: testUser.id,
  walletAddress: "0x0000000000000000000000000000000000000001",
  walletType: "ethereum",
  name: null,
  isPrimary: false,
  isVerified: true,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const intentGrant: AgentGrant = {
  id: "grant-1",
  userId: testUser.id,
  name: "Intent Agent",
  clientName: "Codex",
  clientVersion: "0.1.0",
  clientKind: "mcp",
  tokenPrefix: "ha_test",
  scopes: ["read:account", "read:wallets", "read:funding", "prepare:intents"],
  walletAddresses: [testWallet.walletAddress],
  venues: ["kalshi"],
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

const polymarketIntentGrant: AgentGrant = {
  ...intentGrant,
  id: "grant-polymarket-1",
  walletAddresses: [testEvmWallet.walletAddress],
  venues: ["polymarket"],
};

function makeIntentRow(
  overrides: Partial<{
    request: Record<string, unknown>;
    resolved: Record<string, unknown>;
  }> = {},
) {
  const request =
    overrides.request ??
    ({
      kind: "cancel_order",
      idempotencyKey: "cancel-123",
      orderId: "order-1",
    } satisfies Record<string, unknown>);
  const resolved =
    overrides.resolved ??
    ({
      kind: "cancel_order",
      market: null,
      wallet: null,
      quote: null,
      readiness: null,
      fundingPlan: null,
      policy: {
        decision: "blocked",
        reasons: ["persisted"],
        limitsChecked: {},
      },
      blockers: ["persisted"],
      warnings: [],
    } satisfies Record<string, unknown>);
  return {
    id: "intent-1",
    user_id: testUser.id,
    grant_id: intentGrant.id,
    kind: "cancel_order",
    status: "blocked",
    idempotency_key: "cancel-123",
    venue: null,
    wallet_address: testWallet.walletAddress,
    market_id: null,
    event_id: null,
    order_id: "order-1",
    token_id: null,
    request_payload: request,
    resolved_payload: resolved,
    funding_plan: {},
    policy_result: {},
    blockers: ["persisted"],
    warnings: [],
    expires_at: new Date("2026-05-15T01:00:00.000Z"),
    created_at: new Date("2026-05-15T00:00:00.000Z"),
    updated_at: new Date("2026-05-15T00:00:00.000Z"),
  };
}

function makeMarketRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "polymarket:event-1",
    event_title: "Test event",
    event_category: "politics",
    market_id: "polymarket:market-1",
    venue: "polymarket",
    venue_market_id: "market-1",
    market_title: "Test market",
    market_status: "ACTIVE",
    close_time: null,
    expiration_time: null,
    best_bid: 0.4,
    best_ask: 0.41,
    best_bid_yes: 0.4,
    best_ask_yes: 0.41,
    best_bid_no: 0.58,
    best_ask_no: 0.59,
    last_price: 0.4,
    token_yes: "yes-token",
    token_no: "no-token",
    pm_accepting_orders: true,
    market_category: "politics",
    ...overrides,
  };
}

async function withAgentIntentStubs<T>(
  wallets: UserWallet[],
  fn: () => Promise<T>,
): Promise<T> {
  const originalGetUserWallets = AuthService.getUserWallets;
  const originalRecordAuditEvent = AgentAuthService.recordAuditEvent;
  try {
    AuthService.getUserWallets = async () => wallets;
    AgentAuthService.recordAuditEvent = async () => undefined;
    return await fn();
  } finally {
    AuthService.getUserWallets = originalGetUserWallets;
    AgentAuthService.recordAuditEvent = originalRecordAuditEvent;
  }
}

await test("allows read scopes plus prepare-only intent scope", () => {
  assert.deepEqual(AgentAuthService.allowedReadScopes(), [
    "read:account",
    "read:wallets",
    "read:orders",
    "read:positions",
    "read:funding",
    "read:notifications",
  ]);

  assert.deepEqual(AgentAuthService.allowedScopes(), [
    "read:account",
    "read:wallets",
    "read:orders",
    "read:positions",
    "read:funding",
    "read:notifications",
    "prepare:intents",
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

  const prepareScopes = agentDeviceStartBodySchema.parse({
    requestedScopes: ["read:account", "prepare:intents"],
  });
  assert.deepEqual(prepareScopes.requestedScopes, [
    "read:account",
    "prepare:intents",
  ]);
});

await test("intent schemas require explicit non-executing request shape", () => {
  const trade = agentIntentRequestSchema.parse({
    kind: "trade",
    idempotencyKey: "trade-123",
    marketId: "polymarket:1",
    side: "BUY",
    amountType: "usd",
    amount: "25",
  });
  assert.equal(trade.kind, "trade");
  if (trade.kind !== "trade") throw new Error("expected trade intent");
  assert.equal(trade.orderType, "market");
  assert.equal(trade.amount, 25);

  const bridge = agentIntentRequestSchema.parse({
    kind: "bridge",
    idempotencyKey: "bridge-123",
    venue: "polymarket",
    srcChainId: "8453",
    dstChainId: "137",
    srcToken: "usdc",
    dstToken: "pusd",
    amountIn: "25",
  });
  assert.equal(bridge.kind, "bridge");

  const limitWithoutPrice = agentIntentRequestSchema.safeParse({
    kind: "trade",
    idempotencyKey: "trade-456",
    marketId: "polymarket:1",
    side: "BUY",
    amountType: "usd",
    amount: 25,
    orderType: "limit",
  });
  assert.equal(limitWithoutPrice.success, false);

  const funding = agentFundingPlanBodySchema.parse({
    venue: "kalshi",
    wallets: ["wallet-1"],
    asset: "USDC",
    amount: "10",
  });
  assert.equal(funding.amount, 10);

  for (const kind of ["funding", "venue_setup"]) {
    assert.equal(
      agentIntentRequestSchema.safeParse({
        kind,
        idempotencyKey: `${kind}-123`,
        venue: "kalshi",
      }).success,
      false,
    );
  }
});

await test("trade intent previews expose resolved outcome side", async () => {
  const originalGetVenueCredentialsInfo = AuthService.getVenueCredentialsInfo;
  try {
    AuthService.getVenueCredentialsInfo = async () => null;
    await withAgentIntentStubs([testEvmWallet], async () => {
      const market = makeMarketRow();
      const defaultYes = await previewAgentIntent({
        db: fakePool([{ rows: [market] }, { rows: [market] }]),
        user: testUser,
        grant: polymarketIntentGrant,
        request: {
          kind: "trade",
          idempotencyKey: "trade-default-yes",
          marketId: "polymarket:market-1",
          side: "BUY",
          amountType: "usd",
          amount: 1,
          orderType: "market",
        },
      });
      assert.equal(defaultYes.quote?.outcome, "YES");
      assert.equal(defaultYes.quote?.tokenId, "yes-token");
      assert.equal(defaultYes.quote?.estimatedPrice, 0.41);

      const explicitNoToken = await previewAgentIntent({
        db: fakePool([{ rows: [market] }, { rows: [market] }]),
        user: testUser,
        grant: polymarketIntentGrant,
        request: {
          kind: "trade",
          idempotencyKey: "trade-token-no",
          marketId: "polymarket:market-1",
          side: "BUY",
          tokenId: "no-token",
          amountType: "usd",
          amount: 1,
          orderType: "market",
        },
      });
      assert.equal(explicitNoToken.quote?.outcome, "NO");
      assert.equal(explicitNoToken.quote?.tokenId, "no-token");
      assert.equal(explicitNoToken.quote?.estimatedPrice, 0.59);
    });
  } finally {
    AuthService.getVenueCredentialsInfo = originalGetVenueCredentialsInfo;
  }
});

await test("funding plan reports missing approved wallets", async () => {
  await withAgentIntentStubs([], async () => {
    const fundingPlan = await buildAgentFundingPlan({
      db: fakePool(),
      user: testUser,
      grant: intentGrant,
      request: { venue: "kalshi", asset: "USDC" },
    });
    assert.deepEqual(fundingPlan.blockers, ["missing_wallet"]);
    assert.deepEqual(fundingPlan.depositTargets, []);
    assert.deepEqual(fundingPlan.warnings, [
      "No approved wallet is available for this funding plan.",
    ]);
  });
});

await test("shared deposit target helpers support asset aliases and links", () => {
  const usdce = filterDepositAssets("polymarket", "USDC.e");
  assert.equal(usdce.length, 1);
  const asset = usdce[0];
  assert.ok(asset);
  assert.equal(asset.id, "polygon-usdce");

  const url = new URL(
    buildDepositPageUrl({
      venue: "polymarket",
      targetAddress: "0x0000000000000000000000000000000000000001",
      asset,
    }),
  );
  assert.equal(url.searchParams.get("deposit"), "manual");
  assert.equal(url.searchParams.get("depositAsset"), "polygon-usdce");
  assert.equal(url.searchParams.get("depositChainId"), "137");
});

await test("deposit target builder reports precise blockers and caches funder lookup", async () => {
  const originalGetVenueCredentialsInfo = AuthService.getVenueCredentialsInfo;
  let credentialCalls = 0;
  try {
    AuthService.getVenueCredentialsInfo = async () => {
      credentialCalls += 1;
      return {
        funderAddress: "0x00000000000000000000000000000000000000f1",
      } as Awaited<ReturnType<typeof AuthService.getVenueCredentialsInfo>>;
    };

    const mismatch = await buildAgentDepositTargets({
      userId: testUser.id,
      wallets: [testWallet],
      venue: "polymarket",
      asset: "USDC",
    });
    assert.deepEqual(mismatch.items, []);
    assert.deepEqual(mismatch.blockers, ["wallet_type_mismatch"]);
    assert.equal(
      mismatch.warnings[0],
      "No approved wallet can fund venue 'polymarket'.",
    );

    const unsupported = await buildAgentDepositTargets({
      userId: testUser.id,
      wallets: [testEvmWallet],
      venue: "polymarket",
      asset: "not-a-token",
    });
    assert.deepEqual(unsupported.items, []);
    assert.deepEqual(unsupported.blockers, ["unsupported_asset"]);
    assert.equal(
      unsupported.warnings[0],
      "No deposit target supports asset 'not-a-token'.",
    );

    const missingWallet = await buildAgentDepositTargets({
      userId: testUser.id,
      wallets: [],
      venue: "polymarket",
    });
    assert.deepEqual(missingWallet.items, []);
    assert.deepEqual(missingWallet.blockers, ["missing_wallet"]);

    const polymarketTargets = await buildAgentDepositTargets({
      userId: testUser.id,
      wallets: [testEvmWallet],
      venue: "polymarket",
    });
    assert.equal(polymarketTargets.items.length, 4);
    assert.equal(credentialCalls, 1);
    assert.equal(
      polymarketTargets.items.every(
        (item) =>
          item.targetKind === "venue_funder" &&
          item.targetAddress === "0x00000000000000000000000000000000000000f1",
      ),
      true,
    );
  } finally {
    AuthService.getVenueCredentialsInfo = originalGetVenueCredentialsInfo;
  }
});

await test("intent idempotency returns persisted preview before recomputing", async () => {
  const originalGetUserWallets = AuthService.getUserWallets;
  try {
    AuthService.getUserWallets = async () => {
      throw new Error("preview should not run for an idempotent retry");
    };
    const request = {
      kind: "cancel_order",
      idempotencyKey: "cancel-123",
      orderId: "order-1",
    } as const;
    const row = { ...makeIntentRow({ request }), request_matches: true };
    const db = fakePool([{ rows: [row] }]);
    const result = await createAgentIntent({
      db,
      user: testUser,
      grant: intentGrant,
      request,
    });
    assert.equal(result.created, false);
    assert.deepEqual(result.preview.blockers, ["persisted"]);
    assert.deepEqual(result.intent.preview, row.resolved_payload);
    assert.match(result.intent.reviewUrl ?? "", /\/agent\/intents\/air_/);
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0]?.text ?? "", /request_payload = \$3::jsonb/);
    assert.deepEqual(db.calls[0]?.values?.[2], request);
  } finally {
    AuthService.getUserWallets = originalGetUserWallets;
  }
});

await test("intent idempotency handles insert races with persisted preview", async () => {
  await withAgentIntentStubs([testWallet], async () => {
    const request = {
      kind: "cancel_order",
      idempotencyKey: "cancel-123",
      orderId: "order-1",
    } as const;
    const row = { ...makeIntentRow({ request }), request_matches: true };
    const db = fakePool([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [row] },
    ]);
    const result = await createAgentIntent({
      db,
      user: testUser,
      grant: intentGrant,
      request,
    });
    assert.equal(result.created, false);
    assert.deepEqual(result.preview.blockers, ["persisted"]);
    assert.deepEqual(result.intent.preview, row.resolved_payload);
    assert.match(result.intent.reviewUrl ?? "", /\/agent\/intents\/air_/);
    assert.match(db.calls[3]?.text ?? "", /request_payload = \$3::jsonb/);
    assert.deepEqual(db.calls[3]?.values?.[2], request);
  });
});

await test("intent idempotency rejects mismatched retry payloads", async () => {
  const originalGetUserWallets = AuthService.getUserWallets;
  try {
    AuthService.getUserWallets = async () => {
      throw new Error("preview should not run for idempotency mismatch");
    };
    const db = fakePool([
      { rows: [{ ...makeIntentRow(), request_matches: false }] },
    ]);
    await assert.rejects(
      () =>
        createAgentIntent({
          db,
          user: testUser,
          grant: intentGrant,
          request: {
            kind: "cancel_order",
            idempotencyKey: "cancel-123",
            orderId: "order-2",
          },
        }),
      (error: unknown) =>
        error instanceof AgentAuthError &&
        error.code === "idempotency_key_reused" &&
        error.statusCode === 409,
    );
    assert.equal(db.calls.length, 1);
  } finally {
    AuthService.getUserWallets = originalGetUserWallets;
  }
});

await test("agent intent reads include recoverable review URLs", async () => {
  const row = makeIntentRow();
  const intent = await getAgentIntentById({
    db: fakePool([{ rows: [row] }]),
    user: testUser,
    grant: intentGrant,
    id: row.id,
  });
  assert.match(intent?.reviewUrl ?? "", /\/agent\/intents\/air_/);
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
