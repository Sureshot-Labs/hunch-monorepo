// @requires-db — disposable PostgreSQL 16, mocked /info only, no signatures/actions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  hip4BackgroundRepairWeightLimit,
  hip4BackgroundRequestWeightLimit,
  hip4ReadPolicySchema,
} from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { createHip4OwnedAccountService } from "./services/hip4-account-service.js";
import { readHip4OrderCapacity } from "./services/hip4-financial-observation.js";
import { readHip4OrderFeeObservation } from "./services/hip4-order-fees.js";
import {
  prepareHip4OrderWithCurrentContext,
  quoteHip4MarketOrderWithCurrentContext,
} from "./services/hip4-order-runtime.js";
import { createHip4OrderSpotMetadataRead } from "./services/hip4-order-spot-metadata.js";
import { admitHip4Request } from "./services/hip4-repository.js";

// A single session keeps every mutable relation below connection-local. Real
// runtime SQL executes against copied PG16 schemas, never shared fixture rows.
const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
let fixture: Awaited<ReturnType<typeof hip4OrderTestFixture>>;
let cash = "10";
const calls: string[] = [];
const fetcher: typeof fetch = async (url, init) => {
  assert.equal(url, "https://api.hyperliquid.xyz/info");
  assert.equal(init?.method, "POST");
  const request = JSON.parse(String(init?.body));
  if (request.user) assert.equal(request.user, fixture.profile.address);
  calls.push(request.type);
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
        { coin: "USDC", token: 0, total: cash, hold: "0", entryNtl: "0" },
      ],
    },
    outcomeMeta: {
      feeScale: "1",
      outcomes: [
        {
          outcome: Number(fixture.request.marketId.split(":").at(-1)),
          name: "Synthetic interactive budget contract",
          description: "Synthetic interactive budget contract",
          quoteToken: "USDC",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
          deployerFeeScale: "1",
        },
      ],
    },
    l2Book: {
      coin: request.coin,
      time: Date.now(),
      levels: [
        [{ px: "0.49", sz: "100", n: 1 }],
        [{ px: "0.5", sz: "100", n: 1 }],
      ],
    },
  };
  assert.ok(
    Object.hasOwn(responses, request.type),
    `unexpected mocked info request: ${request.type}`,
  );
  return Response.json(responses[request.type]);
};

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
const resetBudget = () =>
  pool.query("update pg_temp.hip4_request_budget set admissions='[]'::jsonb");

try {
  const version = (await pool.query("show server_version_num")).rows[0]
    .server_version_num;
  assert.equal(Math.floor(Number(version) / 10000), 16);
  // Fixed developer-owned names; no user input, public rows or financial
  // submission tables are modified. LIKE copies generated wallet identity.
  for (const table of [
    "runtime_policies",
    "users",
    "user_wallets",
    "unified_events",
    "unified_markets",
    "unified_tokens",
    "orders",
    "hip4_order_actions",
    "hyperliquid_nonce_claims",
    "hip4_account_snapshots",
    "hip4_account_positions",
    "hip4_account_executions",
    "hip4_account_ledger",
    "hip4_request_budget",
  ])
    await pool.query(
      `create temp table ${table}(like public.${table} including all)`,
    );
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = {
    lifecycle: "active",
    indexerMode: "off",
  };
  for (const [key, payload] of [
    // Disable preview reuse to prove the complete cold path fits. Omitted
    // budget fields MUST use the shared defaults, not a test-only higher cap.
    ["hip4_read", { quotePreviewCacheEntries: 0 }],
    ["hip4_account", {}],
    ["hip4_trading", {}],
    ["venue_lifecycle", lifecycle],
  ] as const)
    await pool.query(
      "insert into pg_temp.runtime_policies(policy_key,effective_at,payload) values($1,clock_timestamp()-interval '1 second',$2)",
      [key, payload],
    );
  const setup = await pool.connect();
  try {
    fixture = await hip4OrderTestFixture(setup);
  } finally {
    setup.release();
  }
  const owner = fixture;
  const accountService = createHip4OwnedAccountService(pool, fetcher);
  const { readPolicy, accountPolicy, revision } = await accountService.policy();
  assert.equal(readPolicy.requestWeightPerMinute, 1200);
  assert.equal(hip4BackgroundRequestWeightLimit(readPolicy), 300);
  assert.equal(hip4BackgroundRepairWeightLimit(readPolicy), 220);
  for (const [scope, weight] of [
    ["background_repair", 220],
    ["background_catalog", 80],
  ] as const)
    assert.equal(
      await admitHip4Request(
        pool,
        "mainnet",
        weight,
        readPolicy.requestWeightPerMinute,
        {
          scope,
          maximum:
            scope === "background_repair"
              ? hip4BackgroundRepairWeightLimit(readPolicy)
              : hip4BackgroundRequestWeightLimit(readPolicy),
          backgroundMaximum: hip4BackgroundRequestWeightLimit(readPolicy),
        },
      ),
      true,
    );
  assert.equal(await usedWeight(), 300);
  assert.equal(
    await admitHip4Request(
      pool,
      "mainnet",
      1,
      readPolicy.requestWeightPerMinute,
      {
        scope: "background_catalog",
        maximum: hip4BackgroundRequestWeightLimit(readPolicy),
        backgroundMaximum: hip4BackgroundRequestWeightLimit(readPolicy),
      },
    ),
    false,
    "the higher total must not add any background allowance",
  );

  // Explicit account refresh pays182; optional history is deferred under its
  // already-full background quota, without discarding valid fresh cash.
  const account = await accountService.load(
    owner.profile.address,
    readPolicy,
    accountPolicy,
    revision,
    true,
  );
  assert.equal(account.state, "fresh");
  assert.equal(account.observation?.mode, "default");
  assert.equal(await usedWeight(), 300 + 182);
  assert.equal(calls.includes("userFills"), false);
  const quoted = await quoteHip4MarketOrderWithCurrentContext(
    pool,
    {
      userId: owner.userId,
      actor: "web_app",
      request: {
        requestKey: randomUUID(),
        marketId: owner.request.marketId,
        controllerWalletRef: owner.request.controllerWalletRef,
        side: "BUY",
        outcomeSide: "YES",
        consentedDebitCapRaw: "300000000",
        slippageBps: 30,
      },
    },
    { fetcher },
  );
  assert.equal(quoted.capacity.availableRaw, "1000000000");
  assert.equal(await usedWeight(), 300 + 182 + 204);

  cash = "9";
  const prepared = await prepareHip4OrderWithCurrentContext(
    pool,
    {
      userId: owner.userId,
      actor: "web_app",
      request: quoted.preparationRequest,
    },
    { fetcher },
  );
  assert.equal(prepared.state, "prepared");
  assert.notEqual(
    prepared.snapshot.accountRevision,
    quoted.capacity.accountRevision,
    "preparation must not reuse the earlier quote's account facts",
  );
  assert.equal(await usedWeight(), 300 + 182 + 204 + 202);

  // Exercise the exact fresh helper bundle used at submission, without
  // signing, admitting or sending the unsigned preparation to /exchange.
  cash = "7";
  const spotMetadataRead = createHip4OrderSpotMetadataRead(pool, fetcher);
  const scope = {
    address: owner.profile.address,
    marketId: owner.request.marketId,
    side: "BUY" as const,
  };
  const [fee, capacity] = await Promise.all([
    readHip4OrderFeeObservation(pool, scope, fetcher, spotMetadataRead),
    readHip4OrderCapacity(
      pool,
      { ...scope, outcomeSide: "YES" },
      fetcher,
      spotMetadataRead,
    ),
  ]);
  assert.equal(fee.side, "BUY");
  assert.equal(capacity.availableRaw, "700000000");
  assert.equal(await usedWeight(), 1090);
  assert.equal(calls.filter((type) => type === "userRole").length, 4);
  assert.equal(calls.filter((type) => type === "spotMeta").length, 4);
  assert.equal(calls.filter((type) => type === "outcomeMeta").length, 3);
  assert.equal(calls.filter((type) => type === "l2Book").length, 1);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as order_count from pg_temp.orders",
      )
    ).rows[0].order_count,
    1,
    "only an unsigned preparation was persisted",
  );

  // The higher default is still one strict shared rolling ceiling, including
  // concurrent callers and testnet. It is not a per-route/environment budget.
  await resetBudget();
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () =>
      admitHip4Request(pool, "mainnet", 100, readPolicy.requestWeightPerMinute),
    ),
  );
  assert.equal(concurrent.filter(Boolean).length, 12);
  assert.equal(await usedWeight(), 1200);
  assert.equal(await admitHip4Request(pool, "testnet", 1, 1200), false);
  await pool.query(`update pg_temp.hip4_request_budget set admissions=jsonb_build_array(
    jsonb_build_object('at',extract(epoch from clock_timestamp())-61,'weight',1200))`);
  assert.equal(await admitHip4Request(pool, "mainnet", 20, 1200), true);
  assert.equal(await usedWeight(), 20);

  // Explicit operator limits remain authoritative, with the same practical
  // rolling-window recovery instead of silently replacing a configured600.
  const limited = hip4ReadPolicySchema.parse({ requestWeightPerMinute: 600 });
  assert.equal(limited.requestWeightPerMinute, 600);
  assert.equal(hip4BackgroundRequestWeightLimit(limited), 300);
  await resetBudget();
  assert.equal(
    await admitHip4Request(
      pool,
      "mainnet",
      600,
      limited.requestWeightPerMinute,
    ),
    true,
  );
  assert.equal(
    await admitHip4Request(pool, "mainnet", 1, limited.requestWeightPerMinute),
    false,
  );
  console.log(
    "HIP4 interactive budget PG16: background300 + account182 + cold quote204 + strict prepare202 + fresh submission context202 =1090; concurrent cap, rolling recovery and explicit600 PASS",
  );
} finally {
  await pool.end();
}
