// @requires-db — disposable PG16 only, offline ephemeral key, mocked providers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { tx } from "@hunch/infra";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  hip4Identity,
  hip4BackgroundRepairWeightLimit,
  hip4BackgroundRequestWeightLimit,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  hip4OrderTestFixture,
  hip4OrderTestMarket,
} from "./hip4-order-test-fixture.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { persistHip4OrderPreparationInTransaction } from "./repos/hip4-order-preparation.js";
import { admitHip4OrderActionInTransaction } from "./repos/hip4-order-admission.js";
import { readHip4OrderController } from "./repos/hip4-order-controller.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import {
  prepareHip4OrderWithCurrentContext,
  quoteHip4MarketOrderWithCurrentContext,
  submitHip4OrderWithCurrentContext,
} from "./services/hip4-order-runtime.js";
import { createHip4OwnedAccountService } from "./services/hip4-account-service.js";
import { runHip4OrderObservationPass } from "./services/hip4-order-observer.js";
import { planHip4OrderFillRepair } from "./services/hip4-order-fill-repair.js";
import { admitHip4OrderEvidenceRequest } from "./services/hip4-order-evidence-budget.js";
import {
  createHip4AccountClient,
  createHip4ReadClient,
} from "./services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Markets,
  readHip4Policy,
} from "./services/hip4-repository.js";
import { readHip4Trades, readHip4Candles } from "./services/hip4-history.js";
import { registerHip4ReadRoutes } from "./routes/hip4-read.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000 -c lock_timeout=2000",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("external IO forbidden in SELL budget test");
};
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
const fixtureTables = [
  "runtime_policies",
  "users",
  "user_wallets",
  "unified_events",
  "unified_markets",
  "unified_tokens",
  "orders",
  "hip4_order_actions",
  "hip4_order_submissions",
  "hyperliquid_nonce_claims",
  "hip4_account_snapshots",
  "hip4_account_positions",
  "hip4_account_executions",
  "hip4_account_ledger",
  "hip4_request_budget",
  "hip4_read_markets",
  "hip4_public_trades",
  "hip4_candles",
  "hip4_observation_intervals",
  "funding_quotes",
  "funding_operations",
  "funding_operation_segments",
  "funding_operation_steps",
  "funding_operation_step_attempts",
  "funding_provider_requests",
  "funding_observations",
  "funding_step_receipt_observations",
  "funding_reconciliation_jobs",
  "funding_trade_attempts",
  "funding_receive_sessions",
  "funding_receive_receipts",
  "balance_reservations",
  "telegram_trade_intents",
  "telegram_funding_authorization_reservations",
] as const;
const usedWeight = async () =>
  Number(
    (
      await pool.query(
        `select coalesce(sum((admission_row->>'weight')::int),0)::int as used_weight
         from pg_temp.hip4_request_budget budget_row
         cross join lateral jsonb_array_elements(budget_row.admissions) admission_row`,
      )
    ).rows[0].used_weight,
  );
const expireBudgetWindow = () =>
  pool.query(`update pg_temp.hip4_request_budget set admissions=(
    select jsonb_agg(admission_row || jsonb_build_object('at',extract(epoch from statement_timestamp())-61))
    from jsonb_array_elements(admissions) admission_row)`);

try {
  assert.match(
    (await pool.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  // Fixed allowlist and schema preflight. Every mutable fixture, including
  // financial rows and admissions, is connection-local to this max=1 pool.
  const present = await pool.query(
    "select fixture_name,to_regclass('public.'||fixture_name) is not null as present from unnest($1::text[]) fixture_scope(fixture_name)",
    [fixtureTables],
  );
  assert.equal(present.rows.length, fixtureTables.length);
  assert.ok(present.rows.every((row) => row.present));
  for (const table of fixtureTables)
    await pool.query(
      `create temp table ${table}(like public.${table} including all)`,
    );
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "off" };
  for (const [key, payload] of [
    ["venue_lifecycle", lifecycle],
    // A complete cold quote, not a cached SELL or a test-only larger budget.
    ["hip4_read", { quotePreviewCacheEntries: 0 }],
    ["hip4_account", {}],
    ["hip4_trading", {}],
  ] as const)
    await pool.query(
      "insert into pg_temp.runtime_policies(policy_key,effective_at,payload) values($1,clock_timestamp()-interval '1 second',$2)",
      [key, payload],
    );

  const wallet = Wallet.createRandom();
  const fixture = await tx(pool, async (db) => {
    const value = await hip4OrderTestFixture(db, wallet.address);
    await db.query(
      `update user_wallets set wallet_source='embedded',is_internal_wallet=true,
       privy_wallet_id='synthetic-budget-controller' where id=$1`,
      [value.profile.controllerWalletRef],
    );
    await db.query(
      `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,
       wallet_source,is_internal_wallet,privy_wallet_id,privy_profile_updated_at)
       values($1,$2,'11111111111111111111111111111111','solana',true,
         'embedded',true,'synthetic-budget-solana',now())`,
      [randomUUID(), value.userId],
    );
    value.profile = await readHip4OrderController(db, {
      userId: value.userId,
      controllerWalletRef: value.request.controllerWalletRef,
    });
    return value;
  });
  const identity = hip4Identity(
    "mainnet",
    Number(fixture.request.marketId.split(":").at(-1)),
  );
  const prior = await tx(pool, async (db) => {
    const value = await hip4OrderTestFixture(db, wallet.address, fixture);
    value.nonce = Date.now() - 30000;
    const prepared = await persistHip4OrderPreparationInTransaction(db, value);
    const signable = prepareHip4TradeSigning(prepared.envelope);
    await admitHip4OrderActionInTransaction(
      db,
      {
        userId: fixture.userId,
        actionId: prepared.actionId,
        actor: "web_app",
        signature: await wallet.signTypedData(
          signable.typedData.domain,
          signable.typedData.types,
          signable.typedData.message,
        ),
        context: {
          profile: fixture.profile,
          feeCapRaw: value.feeCapRaw,
          capacity: {
            assetId: HYPERCORE_MAINNET_USDC.assetId,
            decimals: 8,
            availableRaw: "15000000000",
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
      },
      () => true,
    );
    assert.equal(signable.action.type, "order");
    if (signable.action.type !== "order") throw new Error("fixture action");
    const repair = {
      ...planHip4OrderFillRepair(null, value.nonce, Date.now(), 32),
      nextTime: value.nonce + 1,
      lastSuccessAt: new Date(value.nonce + 1).toISOString(),
      lastAttemptAt: new Date(value.nonce).toISOString(),
    };
    await db.query(
      `update hip4_order_submissions set fills_observation=jsonb_build_object('repair',$2::jsonb),
       reconcile_after='-infinity' where action_id=$1`,
      [prepared.actionId, repair],
    );
    return {
      prepared,
      wire: signable.action.orders[0],
      nonce: value.nonce,
      repair,
    };
  });
  const calls: string[] = [];
  let exchangeCalls = 0;
  let sellWire: typeof prior.wire | undefined;
  const status = (wire: typeof prior.wire, nonce: number, oid: number) => ({
    status: "order",
    order: {
      status: "open",
      statusTimestamp: nonce + 1,
      order: {
        coin: `#${wire.a - 100000000}`,
        oid,
        cloid: wire.c,
        side: wire.b ? "B" : "A",
        limitPx: wire.p,
        origSz: wire.s,
        sz: wire.s,
        timestamp: nonce + 1,
        reduceOnly: false,
        tif: "Ioc",
        orderType: "Limit",
      },
    },
  });
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.method, "POST");
    const request = JSON.parse(String(init?.body));
    if (url === "https://api.hyperliquid.xyz/exchange") {
      exchangeCalls++;
      calls.push("exchange");
      sellWire = request.action.orders[0];
      assert.equal(sellWire?.b, false);
      return Response.json({
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ resting: { oid: 67890 } }] },
        },
      });
    }
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    if (request.user) assert.equal(request.user, fixture.profile.address);
    calls.push(request.type);
    if (request.type === "orderStatus") {
      if (request.oid === prior.prepared.cloid)
        return Response.json(status(prior.wire, prior.nonce, 12345));
      assert.ok(sellWire);
      assert.equal(request.oid, sellWire.c);
      return Response.json(status(sellWire, Date.now() - 10, 67890));
    }
    const responses: Record<string, unknown> = {
      userRole: { role: "user" },
      userAbstraction: "default",
      userDexAbstraction: null,
      borrowLendUserState: {
        tokenToState: [],
        health: "healthy",
        healthFactor: null,
      },
      spotMeta: {
        tokens: [
          {
            name: "USDC",
            index: 0,
            tokenId: HYPERCORE_MAINNET_USDC.assetId,
            weiDecimals: 8,
            szDecimals: 8,
          },
        ],
      },
      spotClearinghouseState: {
        balances: [
          { coin: "USDC", token: 0, total: "10", hold: "0", entryNtl: "0" },
          {
            coin: identity.sides[1].tokenName,
            token: identity.outcome * 10 + 1,
            total: "12",
            hold: "0",
            entryNtl: "0",
          },
        ],
      },
      outcomeMeta: {
        feeScale: "1",
        outcomes: [
          {
            outcome: identity.outcome,
            name: "Synthetic SELL budget",
            description: "Synthetic SELL budget",
            quoteToken: "USDC",
            sideSpecs: [{ name: "Yes" }, { name: "No" }],
            deployerFeeScale: "1",
          },
        ],
      },
      userFees: {
        userSpotCrossRate: "0.0007",
        userSpotAddRate: "0.0004",
        activeReferralDiscount: "0",
      },
      l2Book: {
        coin: request.coin,
        time: Date.now(),
        levels: [
          [{ px: "0.49", sz: "100", n: 1 }],
          [{ px: "0.5", sz: "100", n: 1 }],
        ],
      },
      userFillsByTime: [],
    };
    assert.ok(Object.hasOwn(responses, request.type), request.type);
    return Response.json(responses[request.type]);
  };
  const accountService = createHip4OwnedAccountService(pool, fetcher);
  const { readPolicy, accountPolicy, revision } = await accountService.policy();
  assert.equal(readPolicy.requestWeightPerMinute, 1200);
  assert.equal(hip4BackgroundRequestWeightLimit(readPolicy), 300);
  assert.equal(hip4BackgroundRepairWeightLimit(readPolicy), 220);
  const exhaustBackground = async () => {
    for (const [scope, weight] of [
      ["background_repair", 220],
      ["background_catalog", 80],
    ] as const)
      assert.equal(
        await admitHip4Request(pool, "mainnet", weight, 1200, {
          scope,
          maximum: scope === "background_repair" ? 220 : 300,
          backgroundMaximum: 300,
        }),
        true,
      );
  };
  await exhaustBackground();
  // No prior observation: the initial load still has an interactive recovery
  // path even when all ordinary background work has already been admitted.
  const account = await accountService.load(
    fixture.profile.address,
    readPolicy,
    accountPolicy,
    revision,
    false,
  );
  assert.equal(account.state, "fresh");
  assert.equal(account.observation?.mode, "default");
  assert.equal(await usedWeight(), 482);
  const ageSnapshot = () =>
    pool.query(
      `update pg_temp.hip4_account_snapshots set observation=jsonb_set(
       observation,'{observedAt}',to_jsonb($2::text))
     where environment='mainnet' and account_address=$1`,
      [
        fixture.profile.address,
        new Date(Date.now() - accountPolicy.snapshotMaxAgeMs - 1).toISOString(),
      ],
    );
  await ageSnapshot();
  const beforeStalePoll = [...calls];
  const refreshed = await accountService.load(
    fixture.profile.address,
    readPolicy,
    accountPolicy,
    revision,
    false,
  );
  assert.equal(refreshed.state, "fresh");
  assert.equal(
    calls.length,
    beforeStalePoll.length + 8,
    "an authenticated foreground load can recover beyond optional background usage",
  );
  assert.equal(await usedWeight(), 664);
  const explicit = await accountService.load(
    fixture.profile.address,
    readPolicy,
    accountPolicy,
    revision,
    true,
  );
  assert.equal(explicit.state, "fresh");
  assert.equal(explicit.observation?.mode, "default");
  assert.equal(
    await usedWeight(),
    846,
    "explicit refresh recovers without a housekeeping wait or larger ceiling",
  );

  // Recover another stale foreground account without warming quote fee facts.
  // The following rolling window isolates the cold SELL's own bounded cost
  // from this preceding account refresh; fresh account polls then reuse facts.
  await ageSnapshot();
  await expireBudgetWindow();
  await exhaustBackground();
  assert.equal(await usedWeight(), 300);
  const beforeAccountRefresh = calls.length;
  const refreshedBeforeSell = await accountService.load(
    fixture.profile.address,
    readPolicy,
    accountPolicy,
    revision,
    false,
  );
  assert.equal(refreshedBeforeSell.state, "fresh");
  assert.equal(calls.length, beforeAccountRefresh + 8);
  assert.equal(await usedWeight(), 482);
  await expireBudgetWindow();
  await exhaustBackground();
  assert.equal(await usedWeight(), 300);
  const beforeSell = calls.length;

  await pool.query(
    `insert into hip4_read_markets(market_id,environment,outcome,fetched_at,generation,read_model,raw)
     values($1,'mainnet',$2,now(),$3,$4,'{}'::jsonb)`,
    [
      identity.marketId,
      identity.outcome,
      randomUUID(),
      hip4OrderTestMarket(identity),
    ],
  );
  registerHip4ReadRoutes(app, {
    surface: "public",
    authorize: async () => {},
    policy: () => readHip4Policy(pool),
    markets: (...args) => readHip4Markets(pool, ...args),
    trades: (...args) => readHip4Trades(pool, ...args),
    candles: (...args) => readHip4Candles(pool, ...args),
  });
  const quoted = await quoteHip4MarketOrderWithCurrentContext(
    pool,
    {
      userId: fixture.userId,
      actor: "web_app",
      request: {
        requestKey: randomUUID(),
        controllerWalletRef: fixture.request.controllerWalletRef,
        marketId: identity.marketId,
        outcomeSide: "NO",
        side: "SELL",
        consentedDebitCapRaw: "400000",
      },
    },
    { fetcher },
  );
  assert.equal(quoted.capacity.availableRaw, "1200000");
  assert.equal(await usedWeight(), 524);
  const prepared = await prepareHip4OrderWithCurrentContext(
    pool,
    {
      userId: fixture.userId,
      actor: "web_app",
      request: quoted.preparationRequest,
    },
    { fetcher },
  );
  assert.equal(await usedWeight(), 746);

  // Model the bounded cheap-status allowance while a single EVM owner keeps
  // the chart open. Aging only scheduling hints avoids wall-clock sleeps.
  // Denied periodic pages never hit the provider or advance a frozen cursor.
  for (let tick = 0; tick < 24; tick++) {
    const beforeReads = calls.length;
    for (const kind of ["trades", "candles"] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/markets/hyperliquid/${identity.marketId}/${kind}`,
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    await accountService.load(
      fixture.profile.address,
      readPolicy,
      accountPolicy,
      revision,
      false,
    );
    assert.equal(
      calls.length,
      beforeReads,
      "chart/account polls reuse DB facts",
    );
    await pool.query(
      `update hip4_order_submissions set reconcile_after='-infinity',
       fills_observation=jsonb_set(fills_observation,'{repair,lastAttemptAt}',to_jsonb($2::text))
       where action_id=$1`,
      [prior.prepared.actionId, new Date(prior.nonce).toISOString()],
    );
    const observed = await runHip4OrderObservationPass(pool, fetcher);
    assert.equal(observed.saved, 1);
    assert.equal(observed.budgetExhausted, 1);
    const saved = (
      await pool.query(
        "select fills_observation from hip4_order_submissions where action_id=$1",
        [prior.prepared.actionId],
      )
    ).rows[0].fills_observation;
    assert.equal(saved.repair.nextTime, prior.repair.nextTime);
    assert.equal(saved.repair.endTime, prior.repair.endTime);
    assert.equal(saved.repair.lastSuccessAt, prior.repair.lastSuccessAt);
    assert.equal(saved.repair.lastError, "budget_exhausted");
    assert.equal(saved.repairError, "budget_exhausted");
  }
  assert.equal(calls.filter((type) => type === "userFillsByTime").length, 0);
  assert.equal(await usedWeight(), 794);

  // A visible owner can still request one extra current book/status update.
  // Both requests use their real2 weight; no ceiling or transport charge is
  // relaxed to make this formerly near-cliff SELL succeed.
  const visibleBook = createHip4ReadClient(
    readPolicy,
    (weight) => admitHip4Request(pool, "mainnet", weight, 1200),
    fetcher,
  );
  const visibleStatus = createHip4AccountClient(
    readPolicy,
    (weight) =>
      admitHip4OrderEvidenceRequest(pool, {
        environment: "mainnet",
        weight,
        policy: readPolicy,
        periodic: true,
      }),
    fetcher,
  );
  await visibleBook({ type: "l2Book", coin: identity.sides[1].coin });
  await visibleStatus({
    type: "orderStatus",
    user: fixture.profile.address,
    oid: prior.prepared.cloid,
  });
  assert.equal(await usedWeight(), 798);

  // Verified-buy's periodic exact-fill lane uses this same admission helper.
  // It cannot spend the reserve merely because its own request-count budget
  // still has capacity; a denied request performs no provider IO.
  const periodicRead = createHip4AccountClient(
    readPolicy,
    (weight) =>
      admitHip4OrderEvidenceRequest(pool, {
        environment: "mainnet",
        weight,
        policy: readPolicy,
        periodic: true,
      }),
    fetcher,
  );
  await assert.rejects(
    periodicRead({
      type: "userFillsByTime",
      user: fixture.profile.address,
      startTime: prior.nonce,
      endTime: prior.nonce + 1,
      aggregateByTime: false,
    }),
    /budget_exhausted/u,
  );
  assert.equal(await usedWeight(), 798);
  const signing = prepareHip4TradeSigning(prepared.envelope).typedData;
  const input = {
    userId: fixture.userId,
    actionId: prepared.actionId,
    actor: "web_app" as const,
    signature: await wallet.signTypedData(
      signing.domain,
      signing.types,
      signing.message,
    ),
  };
  const submitted = await submitHip4OrderWithCurrentContext(pool, input, {
    fetcher,
  });
  assert.equal(submitted.replayed, false);
  assert.equal(exchangeCalls, 1);
  assert.equal(
    await usedWeight(),
    1043,
    "300 background +224 cold quote +222 fresh prepare +52 visible/status +245 fresh submit/exchange/status/empty-fill evidence",
  );
  assert.ok((await usedWeight()) <= 1200);
  assert.equal(
    calls.slice(beforeSell).filter((type) => type === "userRole").length,
    3,
  );
  assert.equal(
    calls.slice(beforeSell).filter((type) => type === "spotMeta").length,
    3,
  );
  assert.equal(
    calls.slice(beforeSell).filter((type) => type === "userFees").length,
    3,
  );
  assert.equal(
    calls.slice(beforeSell).filter((type) => type === "l2Book").length,
    2,
  );
  assert.equal(
    calls.slice(beforeSell).filter((type) => type === "orderStatus").length,
    26,
  );
  assert.equal(calls.filter((type) => type === "userFillsByTime").length, 1);
  const beforeReplay = [...calls];
  assert.equal(
    (await submitHip4OrderWithCurrentContext(pool, input, { fetcher }))
      .replayed,
    true,
  );
  assert.deepEqual(calls, beforeReplay);
  assert.equal(exchangeCalls, 1);
  assert.equal(
    await admitHip4Request(pool, "mainnet", 1199 - (await usedWeight()), 1200),
    true,
  );
  assert.equal(await admitHip4Request(pool, "testnet", 2, 1200), false);
  assert.equal(await admitHip4Request(pool, "testnet", 1, 1200), true);
  assert.equal(await admitHip4Request(pool, "mainnet", 1, 1200), false);

  // Expire this connection-local window, rather than clearing any history.
  // Normal admission prunes the expired entries and a periodic page recovers.
  await expireBudgetWindow();
  await periodicRead({
    type: "userFillsByTime",
    user: fixture.profile.address,
    startTime: prior.nonce,
    endTime: prior.nonce + 1,
    aggregateByTime: false,
  });
  assert.equal(await usedWeight(), 20);
  assert.equal(calls.filter((type) => type === "userFillsByTime").length, 2);
  assert.equal(
    await admitHip4Request(pool, "mainnet", 200, 1200, {
      scope: "background_repair",
      maximum: 220,
      backgroundMaximum: 300,
    }),
    true,
  );
  assert.equal(
    await admitHip4Request(pool, "mainnet", 80, 1200, {
      scope: "background_catalog",
      maximum: 300,
      backgroundMaximum: 300,
    }),
    true,
  );
  const explicitRead = createHip4AccountClient(
    readPolicy,
    (weight) =>
      admitHip4OrderEvidenceRequest(pool, {
        environment: "mainnet",
        weight,
        policy: readPolicy,
        periodic: false,
      }),
    fetcher,
  );
  await explicitRead({
    type: "userFillsByTime",
    user: fixture.profile.address,
    startTime: prior.nonce,
    endTime: prior.nonce + 1,
    aggregateByTime: false,
  });
  assert.equal(
    await usedWeight(),
    320,
    "explicit repair bypasses background quota, never the shared ceiling",
  );
  const concurrency = await Promise.all(
    Array.from({ length: 20 }, () =>
      admitHip4Request(pool, "mainnet", 100, 1200),
    ),
  );
  assert.equal(concurrency.filter(Boolean).length, 8);
  assert.equal(await admitHip4Request(pool, "mainnet", 80, 1200), true);
  assert.equal(await usedWeight(), 1200);
  assert.equal(await admitHip4Request(pool, "mainnet", 1, 1200), false);
  console.log(
    "[hip4-sell-budget] single EVM, chart/account polling, periodic deferral/cursors, fresh SELL submit, replay, explicit repair and rolling ceiling passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
  await pool.end();
}
