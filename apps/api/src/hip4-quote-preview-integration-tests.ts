// @requires-db — disposable PostgreSQL 16, mocked provider, no signatures/actions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_VENUE_LIFECYCLE_POLICY, hip4Identity } from "@hunch/shared";
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
let legacyDexAbstraction: unknown = null;
let cash = "10";
let positionQuantity = "12";
let failFacts = false;
let failFeeOnly = false;
let failCapacityOnly = false;
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
  if (
    (failFeeOnly && request.type === "outcomeMeta") ||
    (failCapacityOnly && request.type === "spotClearinghouseState")
  )
    return new Response("unavailable", { status: 503 });
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
  if (request.type === "userDexAbstraction")
    return Response.json(legacyDexAbstraction);
  if (request.type === "borrowLendUserState")
    return Response.json({
      tokenToState: [],
      health: "healthy",
      healthFactor: null,
    });
  if (request.type === "spotClearinghouseState")
    return Response.json({
      balances: [
        { coin: "USDC", token: 0, total: cash, hold: "0", entryNtl: "0" },
        ...[fixture, secondMarket].flatMap((value) => {
          if (!value) return [];
          const identity = hip4Identity(
            "mainnet",
            Number(value.request.marketId.split(":").at(-1)),
          );
          return [
            {
              coin: identity.sides[0].tokenName,
              token: identity.outcome * 10,
              total: positionQuantity,
              hold: "0",
              entryNtl: "0",
            },
          ];
        }),
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

  // The exact reported workload: existing background212 + three full144
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
  assert.equal(await usedWeight(), 212 + 144 + 2 + 2);
  assert.equal(
    calls.filter((type) => type === "spotMeta").length,
    1,
    "fees and cash share one freshly admitted spot metadata request per bundle",
  );
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
  assert.equal(await usedWeight(), 144 + 2 + 2);
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

  // BUY USDC capacity is independent of market/outcome, but fee metadata
  // remains market-bound and SELL stock still requires its own exact read.
  await resetBudget();
  let before = calls.filter((type) => type === "userRole").length;
  const beforeCrossMarket = calls.length;
  await ok({ outcomeSide: "NO" });
  await ok({ marketId: secondMarket.request.marketId });
  assert.equal(calls.filter((type) => type === "userRole").length, before);
  assert.equal(await usedWeight(), 2 + 42);
  assert.equal(
    calls.slice(beforeCrossMarket).filter((type) => type === "outcomeMeta")
      .length,
    1,
    "public fee metadata never crosses market/economic-generation scopes",
  );
  await ok({ side: "SELL", consentedDebitCapRaw: "300000" });
  assert.equal(calls.filter((type) => type === "userRole").length, before + 1);

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
  const beforeChangedTerms = calls.filter(
    (type) => type === "outcomeMeta",
  ).length;
  await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, before);
  assert.equal(
    calls.filter((type) => type === "outcomeMeta").length,
    beforeChangedTerms + 1,
    "changed instrument terms reread market fees, never reinterpret old fees",
  );

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

  const savePreviewObservation = async (
    value: ReturnType<typeof projectHip4Account>,
  ) => {
    const nextLease = await claimHip4AccountRefresh(
      pool,
      "mainnet",
      owner.profile.address,
      120000,
      new Date(now),
    );
    assert.ok(nextLease);
    assert.equal(
      await persistHip4AccountRefresh(pool, {
        environment: "mainnet",
        address: owner.profile.address,
        lease: nextLease,
        observation: value,
        executions: [],
        ledger: [],
        history: {},
        error: null,
      }),
      true,
    );
  };
  const disabledObservation = () =>
    projectHip4Account({
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
  // A known authoritative account refresh invalidates preview cash immediately,
  // but cannot extend or discard independently bounded fee terms.
  await resetBudget();
  cash = "20";
  const observation = disabledObservation();
  await savePreviewObservation(observation);
  const beforeFundingRefresh = calls.length;
  const postFunding = await ok();
  assert.equal(postFunding.providerCapacity.availableRaw, "2000000000");
  assert.equal(postFunding.fees.observedAt, afterExpiry.fees.observedAt);
  assert.equal(postFunding.fees.expiresAt, afterExpiry.fees.expiresAt);
  assert.equal(
    calls.slice(beforeFundingRefresh).includes("outcomeMeta"),
    false,
    "account refresh must not discard already bounded BUY fee metadata",
  );

  // SELL refreshes exact owned-token capacity after each account generation.
  // The new stock observation cannot trigger another user-fee/public-fee read,
  // nor slide the original fee deadline as account snapshots keep arriving.
  await resetBudget();
  const sellRequest = { side: "SELL", consentedDebitCapRaw: "300000" } as const;
  const beforeSellWarm = calls.length;
  const sellWarm = await ok(sellRequest);
  assert.equal(sellWarm.providerCapacity.availableRaw, "1200000");
  assert.equal(
    calls.slice(beforeSellWarm).filter((type) => type === "userFees").length,
    1,
  );
  assert.equal(
    calls.slice(beforeSellWarm).filter((type) => type === "outcomeMeta").length,
    1,
  );
  for (const quantity of ["11", "10"]) {
    now += 1000;
    positionQuantity = quantity;
    cash = String(Number(cash) + 1);
    await savePreviewObservation(disabledObservation());
    await resetBudget();
    const beforeSnapshotChurn = calls.length;
    const changedStock = await ok(sellRequest);
    assert.equal(
      changedStock.providerCapacity.availableRaw,
      `${quantity}00000`,
    );
    assert.equal(changedStock.fees.observedAt, sellWarm.fees.observedAt);
    assert.equal(changedStock.fees.expiresAt, sellWarm.fees.expiresAt);
    assert.equal(
      changedStock.fees.observationRevision,
      sellWarm.fees.observationRevision,
    );
    assert.equal(
      Date.parse(changedStock.expiresAt) <= Date.parse(sellWarm.fees.expiresAt),
      true,
    );
    const refreshed = calls.slice(beforeSnapshotChurn);
    assert.equal(refreshed.filter((type) => type === "userRole").length, 1);
    assert.equal(
      refreshed.filter((type) => type === "spotClearinghouseState").length,
      1,
    );
    assert.equal(refreshed.filter((type) => type === "userFees").length, 0);
    assert.equal(refreshed.filter((type) => type === "outcomeMeta").length, 0);
    assert.equal(
      await usedWeight(),
      124,
      "fresh book2 plus exact capacity122; unchanged fee60 remains bounded",
    );
  }
  now = Date.parse(sellWarm.fees.expiresAt) + 1;
  await resetBudget();
  const beforeFeeExpiry = calls.length;
  const expiredSell = await ok(sellRequest);
  assert.equal(
    calls.slice(beforeFeeExpiry).filter((type) => type === "userFees").length,
    1,
  );
  assert.equal(
    calls.slice(beforeFeeExpiry).filter((type) => type === "outcomeMeta")
      .length,
    1,
  );
  assert.ok(
    Date.parse(expiredSell.fees.observedAt) >
      Date.parse(sellWarm.fees.observedAt),
  );

  // Unobserved mode changes may remain bounded preview facts, but strict
  // preparation MUST bypass them and use new role/mode provider reads.
  await ok();
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

  // A preparation/worker already observed qualified default cash. Under the
  // same unchanged600 rolling window, background220 + prior interactive182
  // leaves too little for another full204 BUY quote, but fresh public terms42
  // fit. Keep all those admissions while exercising the actual HTTP route.
  const qualifiedDefault = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date(now - 1000).toISOString(),
    role: "user",
    mode: "default",
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
    defaultSpotCashEvidence: {
      legacyDexAbstraction: null,
      borrowLendState: {
        tokenToState: [],
        health: "healthy",
        healthFactor: null,
      },
    },
  });
  mode = "default";
  // Isolate this cold-fee scenario from the prior BUY preview; an account
  // observation alone intentionally no longer invalidates fee facts.
  await setReadPolicy({ quotePreviewCacheEntries: 59 });
  await savePreviewObservation(qualifiedDefault);
  await resetBudget();
  assert.equal(
    await admitHip4Request(pool, "mainnet", 220, 600, {
      scope: "background_repair",
      maximum: 220,
      backgroundMaximum: 300,
    }),
    true,
  );
  assert.equal(await admitHip4Request(pool, "mainnet", 182, 600), true);
  calls.length = 0;
  const boundedDefault = await ok();
  assert.equal(await usedWeight(), 220 + 182 + 42);
  assert.deepEqual(calls, ["l2Book", "outcomeMeta", "spotMeta"]);
  assert.equal(
    boundedDefault.providerCapacity.observedAt,
    qualifiedDefault.observedAt,
  );
  assert.equal(
    Date.parse(boundedDefault.providerCapacity.expiresAt),
    now - 1000 + 30000,
  );
  await ok();
  assert.equal(await usedWeight(), 220 + 182 + 42 + 2);
  assert.equal(calls.filter((type) => type === "l2Book").length, 2);
  assert.equal(calls.includes("userRole"), false);

  // Stored preview cash is never strict preparation authority. Even a valid
  // current preview must re-observe and reject a changed legacy selector.
  await resetBudget();
  legacyDexAbstraction = true;
  const beforeDefaultPrepare = calls.length;
  const strictDefault = await app.inject({
    method: "POST",
    url: "/orders/prepare",
    payload: boundedDefault.preparationRequest,
  });
  assert.equal(strictDefault.statusCode, 503, strictDefault.body);
  assert.equal(
    calls.slice(beforeDefaultPrepare).includes("userDexAbstraction"),
    true,
  );
  assert.equal(
    calls.slice(beforeDefaultPrepare).includes("borrowLendUserState"),
    true,
  );
  legacyDexAbstraction = null;

  for (const cachedObservation of [
    {
      ...qualifiedDefault,
      cash: { ...qualifiedDefault.cash, ownedCash: null },
    },
    { ...qualifiedDefault, observedAt: new Date(now - 30001).toISOString() },
  ]) {
    await savePreviewObservation(cachedObservation);
    await resetBudget();
    calls.length = 0;
    await ok();
    assert.equal(await usedWeight(), 184);
    assert.equal(
      calls.includes("userRole"),
      true,
      "old/unqualified or stale default snapshots fall back to fresh provider facts",
    );
    assert.equal(calls.includes("borrowLendUserState"), true);
  }
  mode = "disabled";
  await savePreviewObservation(observation);

  // Zero disables reuse. Failures never become reusable, and malformed optional
  // local snapshots bypass optimization rather than blocking fresh provider IO.
  await setReadPolicy({ quotePreviewCacheEntries: 0 });
  await resetBudget();
  await ok();
  await ok();
  assert.equal(await usedWeight(), 288);
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

  // A failed public-fee read must not discard independently successful cash,
  // and a failed cash read must not discard successful exact-market fees.
  await setReadPolicy({ quotePreviewCacheEntries: 61 });
  await resetBudget();
  calls.length = 0;
  failFeeOnly = true;
  assert.equal((await quote()).statusCode, 503);
  const cashDeadline = performance.now() + 3000;
  while (calls.filter((type) => type === "userAbstraction").length < 2) {
    assert.ok(
      performance.now() < cashDeadline,
      "independent cash read stalled",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  failFeeOnly = false;
  await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, 1);
  assert.equal(calls.filter((type) => type === "outcomeMeta").length, 2);
  await setReadPolicy({ quotePreviewCacheEntries: 60 });
  await resetBudget();
  calls.length = 0;
  failCapacityOnly = true;
  assert.equal((await quote()).statusCode, 503);
  await new Promise<void>((resolve) => setImmediate(resolve));
  failCapacityOnly = false;
  await ok();
  assert.equal(calls.filter((type) => type === "userRole").length, 2);
  assert.equal(calls.filter((type) => type === "outcomeMeta").length, 1);
  await pool.query(
    "update hip4_account_snapshots set observation='{}'::jsonb where environment='mainnet' and account_address=$1",
    [owner.profile.address],
  );
  await resetBudget();
  await ok();
  await ok();
  assert.equal(await usedWeight(), 288);

  // Budget exhaustion remains real, not permission to raise600 or repeat a
  // financial mutation. An unsigned quote makes no provider call when full;
  // the next ordinary request recovers after the existing rolling window.
  await resetBudget();
  assert.equal(await admitHip4Request(pool, "mainnet", 600, 600), true);
  const beforeDeniedQuote = calls.length;
  const deniedQuote = await quote();
  assert.equal(deniedQuote.statusCode, 503);
  assert.equal(deniedQuote.json().error, "hip4_quote_rate_limited");
  assert.equal(calls.length, beforeDeniedQuote);
  await pool.query(`update pg_temp.hip4_request_budget set admissions=jsonb_build_array(
    jsonb_build_object('at',extract(epoch from clock_timestamp())-61,'weight',600))`);
  await ok();
  assert.equal(await usedWeight(), 144);
  assert.equal(calls.length > beforeDeniedQuote, true);

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
