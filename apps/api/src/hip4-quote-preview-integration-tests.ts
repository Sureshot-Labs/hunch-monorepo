// @requires-db — disposable PostgreSQL 16, mocked provider, no signatures/actions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { registerHip4TradingRoutes } from "./routes/hip4-trading.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import type { Hip4MarketOrderQuoteRequest } from "./services/hip4-market-order.js";
import { admitHip4Request } from "./services/hip4-repository.js";
import { quoteHip4MarketOrderWithCurrentContext } from "./services/hip4-order-runtime.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
} from "./services/hip4-account-repository.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
const policyIds = {
  read: randomUUID(),
  account: randomUUID(),
  trading: randomUUID(),
  lifecycle: randomUUID(),
};
let fixture: Awaited<ReturnType<typeof hip4OrderTestFixture>> | undefined;
let secondMarket: Awaited<ReturnType<typeof hip4OrderTestFixture>> | undefined;
let mode = "disabled";
let cash = "10";
let failFacts = false;
let failureArrivals = 0;
let releaseFailures: (() => void) | undefined;
let failureGate = Promise.resolve();
const calls: string[] = [];
const fetcher: typeof fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  calls.push(request.type);
  if (request.type === "l2Book")
    return Response.json({
      coin: request.coin,
      time: now,
      levels: [
        [{ px: "0.49", sz: "100", n: 1 }],
        [{ px: "0.5", sz: "100", n: 1 }],
      ],
    });
  if (failFacts) {
    // Both Promise.all branches fail before allowing the retry. A rejected
    // branch must not leave the other mocked read running after fixture reset.
    failureArrivals++;
    if (failureArrivals === 2) releaseFailures?.();
    await failureGate;
    return new Response("unavailable", { status: 503 });
  }
  if (request.type === "outcomeMeta")
    return Response.json({
      feeScale: "1",
      outcomes: [fixture, secondMarket].flatMap((value) =>
        value
          ? [
              {
                outcome: Number(value.request.marketId.split(":").at(-1)),
                name: "Synthetic",
                description: "Synthetic",
                quoteToken: "USDC",
                sideSpecs: [{ name: "Yes" }, { name: "No" }],
                deployerFeeScale: "1",
              },
            ]
          : [],
      ),
    });
  if (request.type === "spotMeta")
    return Response.json({
      tokens: [
        {
          name: "USDC",
          index: 0,
          tokenId: HYPERCORE_MAINNET_USDC.assetId,
          weiDecimals: 8,
          szDecimals: 8,
        },
      ],
    });
  if (request.type === "userRole") return Response.json({ role: "user" });
  if (request.type === "userAbstraction") return Response.json(mode);
  if (request.type === "spotClearinghouseState")
    return Response.json({
      balances: [
        { coin: "USDC", token: 0, total: cash, hold: "0", entryNtl: "0" },
      ],
    });
  if (request.type === "userFees")
    return Response.json({
      userSpotCrossRate: "0.0007",
      userSpotAddRate: "0.0004",
      activeReferralDiscount: "0",
    });
  throw new Error(`unexpected_mock_request_${request.type}`);
};
const lifecyclePolicy = (active = true) => {
  const value = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  value.venues.hyperliquid = {
    lifecycle: active ? "active" : "unreleased",
    indexerMode: "off",
  };
  return value;
};
const resetBudget = () =>
  pool.query("update pg_temp.hip4_request_budget set admissions='[]'::jsonb");
const setReadPolicy = (patch: Record<string, unknown> = {}) =>
  pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds.read,
    { requestWeightPerMinute: 600, ...patch },
  ]);
const usedWeight = async () =>
  Number(
    (
      await pool.query(
        "select coalesce(sum((admission_row->>'weight')::int),0)::int as used_weight from pg_temp.hip4_request_budget budget_row cross join lateral jsonb_array_elements(budget_row.admissions) admission_row",
      )
    ).rows[0].used_weight,
  );
try {
  assert.equal(
    Math.floor(
      Number(
        (await pool.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await pool.query(
    "create temp table hip4_request_budget(like public.hip4_request_budget including all)",
  );
  for (const [name, key, payload] of [
    ["read", "hip4_read", { requestWeightPerMinute: 600 }],
    ["account", "hip4_account", {}],
    ["trading", "hip4_trading", {}],
    ["lifecycle", "venue_lifecycle", lifecyclePolicy()],
  ] as const)
    await pool.query(
      "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,$2,clock_timestamp()-interval '1 second',$3)",
      [policyIds[name], key, payload],
    );
  const setup = await pool.connect();
  try {
    fixture = await hip4OrderTestFixture(setup);
    secondMarket = await hip4OrderTestFixture(setup, fixture.profile.address, {
      userId: fixture.userId,
      profile: fixture.profile,
    });
  } finally {
    setup.release();
  }
  const owner = fixture;
  registerHip4TradingRoutes(app, {
    pool,
    authorize: async (request) => {
      request.user = { id: owner.userId } as NonNullable<typeof request.user>;
    },
    runtime: { fetcher },
  });
  await app.ready();
  const body = (
    patch: Partial<Hip4MarketOrderQuoteRequest> = {},
  ): Hip4MarketOrderQuoteRequest => ({
    requestKey: randomUUID(),
    marketId: owner.request.marketId,
    controllerWalletRef: owner.request.controllerWalletRef,
    side: "BUY",
    outcomeSide: "YES",
    consentedDebitCapRaw: "300000000",
    slippageBps: 30,
    ...patch,
  });
  const quote = (patch: Partial<Hip4MarketOrderQuoteRequest> = {}) =>
    app.inject({
      method: "POST",
      url: "/orders/market-quote",
      payload: body(patch),
    });
  const ok = async (patch: Partial<Hip4MarketOrderQuoteRequest> = {}) => {
    const response = await quote(patch);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  // The exact reported workload: existing background212 + three full164
  // quotes would exceed600. Repeated previews now pay fresh L2 only (2 each).
  assert.equal(
    await admitHip4Request(pool, "mainnet", 212, 600, {
      scope: "background_repair",
      maximum: 220,
      backgroundMaximum: 300,
    }),
    true,
  );
  const first = await ok();
  const second = await ok();
  const third = await ok({ consentedDebitCapRaw: "400000000" });
  assert.equal(await usedWeight(), 212 + 164 + 2 + 2);
  assert.notEqual(
    first.preparationRequest.requestKey,
    second.preparationRequest.requestKey,
  );
  assert.equal(
    first.providerCapacity.observedAt,
    second.providerCapacity.observedAt,
  );
  assert.equal(
    first.providerCapacity.expiresAt,
    second.providerCapacity.expiresAt,
  );
  assert.equal(first.expiresAt, second.expiresAt);
  assert.ok(BigInt(third.amounts.quantity) > BigInt(first.amounts.quantity));
  assert.equal(third.preparationRequest.consentedDebitCapRaw, "400000000");
  assert.equal(calls.filter((type) => type === "userRole").length, 1);
  assert.equal(calls.filter((type) => type === "l2Book").length, 3);

  // Tests/custom transports and independent database pools must not share
  // observations even if their economic request strings happen to match.
  await resetBudget();
  const isolatedFetcher: typeof fetch = (url, init) => fetcher(url, init);
  let rolesBefore = calls.filter((type) => type === "userRole").length;
  await quoteHip4MarketOrderWithCurrentContext(
    pool,
    {
      userId: owner.userId,
      actor: "web_app",
      request: body(),
    },
    { fetcher: isolatedFetcher },
  );
  assert.equal(
    calls.filter((type) => type === "userRole").length,
    rolesBefore + 1,
  );
  const isolatedPool = await createIntegrationTestPool({ max: 1 });
  try {
    await isolatedPool.query(
      "create temp table hip4_request_budget(like public.hip4_request_budget including all)",
    );
    rolesBefore = calls.filter((type) => type === "userRole").length;
    await quoteHip4MarketOrderWithCurrentContext(
      isolatedPool,
      {
        userId: owner.userId,
        actor: "web_app",
        request: body(),
      },
      { fetcher },
    );
    assert.equal(
      calls.filter((type) => type === "userRole").length,
      rolesBefore + 1,
    );
  } finally {
    await isolatedPool.end();
  }
  const wrongUserCalls = calls.length;
  await assert.rejects(
    quoteHip4MarketOrderWithCurrentContext(
      pool,
      {
        userId: randomUUID(),
        actor: "web_app",
        request: body(),
      },
      { fetcher },
    ),
    /hip4_controller_unavailable/,
  );
  assert.equal(calls.length, wrongUserCalls);

  // Concurrent requests coalesce fact reads but retain their own fresh book
  // and request identity. Policy revision creates a clean cache scope.
  await setReadPolicy({ quotePreviewCacheEntries: 63 });
  await resetBudget();
  calls.length = 0;
  const concurrent = await Promise.all([ok(), ok(), ok()]);
  assert.equal(await usedWeight(), 164 + 2 + 2);
  assert.equal(calls.filter((type) => type === "userRole").length, 1);
  assert.equal(
    new Set(concurrent.map((value) => value.preparationRequest.requestKey))
      .size,
    3,
  );

  // Existing cache hits never skip current ownership or lifecycle checks.
  await pool.query("update user_wallets set is_verified=false where id=$1", [
    owner.request.controllerWalletRef,
  ]);
  const beforeOwnership = calls.length;
  assert.equal((await quote()).statusCode, 409);
  assert.equal(calls.length, beforeOwnership);
  await pool.query("update user_wallets set is_verified=true where id=$1", [
    owner.request.controllerWalletRef,
  ]);
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds.lifecycle,
    lifecyclePolicy(false),
  ]);
  assert.equal((await quote()).statusCode, 409);
  assert.equal(calls.length, beforeOwnership);
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds.lifecycle,
    lifecyclePolicy(),
  ]);

  // Outcome, market, and side are different observation scopes.
  await resetBudget();
  let before = calls.filter((type) => type === "userRole").length;
  await ok({ outcomeSide: "NO" });
  await ok({ marketId: secondMarket.request.marketId });
  await ok({ side: "SELL", consentedDebitCapRaw: "300000" });
  assert.equal(calls.filter((type) => type === "userRole").length, before + 3);

  // Replacing catalog generation metadata does not invalidate economic facts.
  await resetBudget();
  await ok();
  const metadata = (
    await pool.query("select metadata from unified_markets where id=$1", [
      owner.request.marketId,
    ])
  ).rows[0].metadata;
  metadata.hip4.generation = randomUUID();
  metadata.hip4.fetchedAt = new Date(now).toISOString();
  await pool.query("update unified_markets set metadata=$2 where id=$1", [
    owner.request.marketId,
    metadata,
  ]);
  before = calls.filter((type) => type === "userRole").length;
  await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, before);
  metadata.hip4.description += " — changed economic condition";
  await pool.query("update unified_markets set metadata=$2 where id=$1", [
    owner.request.marketId,
    metadata,
  ]);
  await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, before + 1);

  // Same-row policy edits invalidate reuse, including account TTL changes
  // whose existing revision is ID-based rather than payload-based.
  await resetBudget();
  before = calls.filter((type) => type === "userRole").length;
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds.account,
    { snapshotMaxAgeMs: 30000 },
  ]);
  const shortened = await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, before + 1);
  assert.equal(Date.parse(shortened.expiresAt), now + 30000);
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds.trading,
    { minimumBuyNotionalUsd: "1.01" },
  ]);
  await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, before + 2);
  await setReadPolicy({ environment: "testnet" });
  before = calls.length;
  assert.equal((await quote()).statusCode, 503);
  assert.equal(calls.length, before);
  await setReadPolicy();
  await resetBudget();
  const beforeExpiry = await ok();
  now += 30001;
  const afterExpiry = await ok();
  assert.ok(
    Date.parse(afterExpiry.providerCapacity.observedAt) >
      Date.parse(beforeExpiry.providerCapacity.observedAt),
  );

  // A known authoritative account refresh invalidates preview cash immediately.
  await resetBudget();
  const lease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    owner.profile.address,
    120000,
    new Date(now),
  );
  assert.ok(lease);
  cash = "20";
  const observation = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date(now).toISOString(),
    role: "user",
    mode: "disabled",
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: {
      balances: [
        { coin: "USDC", token: 0, total: cash, hold: "0", entryNtl: "0" },
      ],
    },
  });
  assert.equal(
    await persistHip4AccountRefresh(pool, {
      environment: "mainnet",
      address: owner.profile.address,
      lease,
      observation,
      executions: [],
      ledger: [],
      history: {},
      error: null,
    }),
    true,
  );
  const postFunding = await ok();
  assert.equal(postFunding.providerCapacity.availableRaw, "2000000000");

  // Unobserved mode changes may remain bounded preview facts, but strict
  // preparation MUST bypass them and use new role/mode provider reads.
  mode = "unifiedAccount";
  const preview = await ok();
  await resetBudget();
  const beforePrepare = calls.length;
  const strict = await app.inject({
    method: "POST",
    url: "/orders/prepare",
    payload: preview.preparationRequest,
  });
  assert.equal(strict.statusCode, 409, strict.body);
  assert.equal(strict.json().error, "native_cash_mode_unsupported");
  assert.ok(calls.slice(beforePrepare).includes("userRole"));
  assert.ok(calls.slice(beforePrepare).includes("userAbstraction"));
  mode = "disabled";

  // Zero disables reuse. Failures never become reusable, and malformed optional
  // local snapshots bypass optimization rather than blocking fresh provider IO.
  await setReadPolicy({ quotePreviewCacheEntries: 0 });
  await resetBudget();
  await ok();
  await ok();
  assert.equal(await usedWeight(), 328);
  await setReadPolicy({ quotePreviewCacheEntries: 62 });
  await resetBudget();
  failureArrivals = 0;
  failureGate = new Promise<void>((resolve) => {
    releaseFailures = resolve;
  });
  failFacts = true;
  assert.equal((await quote()).statusCode, 503);
  failFacts = false;
  await ok();
  await pool.query(
    "update hip4_account_snapshots set observation='{}'::jsonb where environment='mainnet' and account_address=$1",
    [owner.profile.address],
  );
  await resetBudget();
  await ok();
  await ok();
  assert.equal(await usedWeight(), 328);

  console.log(
    "HIP4 preview cache PG16: repeated/concurrent quotes, bounded source expiry, scope/policy/ownership, post-funding invalidation, strict fresh preparation, disabled/failure recovery PASS",
  );
} finally {
  Date.now = originalNow;
  await app.close();
  if (fixture) {
    await pool.query(
      "delete from hip4_account_snapshots where environment='mainnet' and account_address=$1",
      [fixture.profile.address],
    );
    const ids = [fixture, secondMarket].flatMap((value) =>
      value ? [value.request.marketId] : [],
    );
    await pool.query("delete from unified_markets where id=any($1::text[])", [
      ids,
    ]);
    await pool.query("delete from unified_events where id=any($1::text[])", [
      ids,
    ]);
    await pool.query("delete from users where id=$1", [fixture.userId]);
  }
  await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
    Object.values(policyIds),
  ]);
  await pool.end();
}
