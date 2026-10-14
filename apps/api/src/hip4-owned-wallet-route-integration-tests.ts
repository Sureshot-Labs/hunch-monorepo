// @requires-db
// Ordinary wallet auth -> real account service -> PG16 -> shared positions.
// All provider responses are synthetic; no network/financial calls are allowed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";

const target = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000",
});
assert.equal(
  Math.floor(
    Number(
      (await target.query("show server_version_num")).rows[0]
        .server_version_num,
    ) / 10000,
  ),
  16,
);
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.JWT_SECRET = "hip4-disposable-owned-wallet-test";
process.env.PRIVY_APP_ID = "hip4-disposable-test";
process.env.PRIVY_APP_SECRET = "hip4-disposable-test";
process.env.ADMIN_AUTH_LEGACY_FALLBACK = "true";

const originalFetch = globalThis.fetch;
const address = `0x${randomUUID().replaceAll("-", "")}00000001`;
const foreignAddress = `0x${randomUUID().replaceAll("-", "")}00000002`;
const userId = randomUUID();
const now = Date.now();
const requests: { type: string; user?: string }[] = [];
let failRole = false;
let failOrders = false;
let openItems = [
  {
    coin: "#87751",
    oid: 70,
    side: "B",
    limitPx: "0.4",
    sz: "3",
    origSz: "5",
    timestamp: now - 3000,
    orderType: "Limit",
    isTrigger: false,
    reduceOnly: false,
  },
];
let onSpot: (() => Promise<void>) | undefined;
const fill = {
  coin: "#87751",
  px: "0.4",
  sz: "3",
  side: "B",
  time: now - 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  crossed: true,
  fee: "0.0012",
  tid: 1,
  feeToken: "USDC",
};
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), "https://api.hyperliquid.xyz/info");
  const request = JSON.parse(String(options?.body));
  if (request.user) assert.equal(request.user, address);
  requests.push(request);
  if (request.type === "userRole" && failRole)
    return new Response("unavailable", { status: 503 });
  if (request.type === "frontendOpenOrders" && failOrders)
    return new Response("unavailable", { status: 503 });
  if (request.type === "spotClearinghouseState") await onSpot?.();
  const responses: Record<string, unknown> = {
    userRole: { role: "user" },
    userAbstraction: "disabled",
    spotMeta: {
      tokens: [
        {
          name: "USDC",
          tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
          index: 0,
          weiDecimals: 8,
          szDecimals: 8,
        },
      ],
    },
    spotClearinghouseState: {
      balances: [
        { coin: "USDC", token: 0, total: "123.45", hold: "2", entryNtl: "0" },
        { coin: "+87751", total: "3", hold: "0", entryNtl: "1.2" },
      ],
    },
    userFills: [fill, { ...fill, tid: 2, time: now - 2000 }],
    userFillsByTime: [],
    frontendOpenOrders: openItems,
    userNonFundingLedgerUpdates: [],
  };
  assert.ok(
    request.type in responses,
    `unexpected provider request: ${request.type}`,
  );
  return Response.json(responses[request.type]);
};
const [
  { AuthService },
  { pool },
  { hip4AccountRoutes },
  { positionsRoutes },
  { ordersRoutes },
  { closeAcquiredRuntimeResources },
] = await Promise.all([
  import("./auth.js"),
  import("./db.js"),
  import("./routes/hip4-account.js"),
  import("./routes/positions.js"),
  import("./routes/orders.js"),
  import("./runtime-resource-cleanup.js"),
]);
assert.equal(
  (await pool.query("select current_database() as database_name")).rows[0]
    .database_name,
  process.env.HUNCH_TEST_EXPECT_DATABASE,
);
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
const policyIds = [randomUUID(), randomUUID()];
const lifecycle = await installHip4TestLifecycle(target);
try {
  // Synthetic requests only, isolated disposable DB. Previous integration
  // suites must not spend this fixture's provider-admission allowance.
  await target.query(
    "delete from hip4_request_budget where scope='public-info'",
  );
  await target.query(
    "insert into users(id,is_active,is_admin) values($1,true,false)",
    [userId],
  );
  await target.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified,is_primary) values($1,$2,'ethereum',true,true)",
    [userId, address],
  );
  await target.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [
      ...policyIds,
      { enabled: true, catalogMode: "all", requestWeightPerMinute: 1200 },
      { enabled: true, pageSize: 1, historyRepairPagesPerRefresh: 0 },
    ],
  );
  const token = AuthService.generateToken(userId);
  await AuthService.createSession(userId, address, token);
  await app.register(hip4AccountRoutes);
  await app.register(positionsRoutes);
  await app.register(ordersRoutes);
  await app.ready();
  const base = "/wallets/hyperliquid/account";
  const headers = {
    authorization: `Bearer ${token}`,
    "x-hunch-wallet": address,
  };
  const get = (url: string) => app.inject({ url, headers });
  assert.equal((await app.inject(base)).statusCode, 401);
  assert.equal(
    (await get("/markets/hyperliquid/canary/account")).statusCode,
    403,
  );
  assert.ok(
    [401, 403].includes(
      (
        await app.inject({
          url: base,
          headers: { ...headers, "x-hunch-wallet": foreignAddress },
        })
      ).statusCode,
    ),
  );
  assert.equal(requests.length, 0);

  const first = await get(base);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers["cache-control"], "private, no-store");
  const account = first.json();
  assert.equal(account.state, "fresh");
  assert.equal(account.observation.cash.total, "123.45");
  assert.equal(account.observation.cash.held, "2");
  assert.equal(account.observation.cash.spendable, null);
  assert.equal(account.observation.positions[0].sideIndex, 1);
  assert.equal(account.observation.positions[0].quantity, "3");
  const afterFirst = requests.length;
  assert.equal((await get(base)).statusCode, 200);
  assert.equal(
    requests.length,
    afterFirst,
    "fresh ordinary reads must not refresh again",
  );

  const journal = (await get(`${base}/executions`)).json();
  assert.equal(journal.items.length, 1);
  assert.equal(journal.items[0].fee, "0.0012");
  assert.equal(journal.items[0].grossNotional, "1.2");
  assert.ok(journal.nextCursor);
  assert.equal(journal.allTimeComplete, false);
  const secondPage = (
    await get(
      `${base}/executions?cursor=${encodeURIComponent(journal.nextCursor)}`,
    )
  ).json();
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].id, journal.items[0].id);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(
    (await get(`${base}/executions?cursor=invalid`)).statusCode,
    400,
  );
  assert.equal(
    (await get(`${base}/executions?marketId=hyperliquid:testnet:outcome:8775`))
      .statusCode,
    404,
  );
  assert.equal(
    requests.length,
    afterFirst,
    "journal/positions read locally, not from provider",
  );
  const positions = (await get("/positions?venue=hyperliquid")).json();
  assert.equal(positions.positions[0].sizeRaw, "3");
  assert.equal(positions.positions[0].averagePrice, null);
  assert.equal(positions.positions[0].instrument.sideIndex, 1);

  const history = await get("/orders?venue=hyperliquid&limit=1");
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.headers["cache-control"], "private, no-store");
  const observed = history.json();
  assert.equal(observed.coverage.hyperliquid, "limited");
  assert.equal(observed.orders.length, 1);
  assert.equal(observed.pagination.total, 2);
  assert.equal(observed.orders[0].kind, "execution");
  assert.equal(observed.orders[0].size, null);
  assert.equal(observed.orders[0].status, "observed");
  assert.equal(observed.orders[0].outcome, "NO");
  assert.equal(observed.orders[0].tokenId, "hyperliquid:mainnet:87751");
  assert.equal(observed.orders[0].execution.fee, "0.0012");
  assert.equal(observed.orders[0].actionRef, null);
  assert.equal(
    (await get("/orders?type=execution&limit=1&offset=1")).json().orders.length,
    1,
  );
  assert.equal(
    (await get("/orders?type=execution&offset=2")).json().orders.length,
    0,
  );
  assert.equal(
    (await get("/orders?status=filled&venue=hyperliquid")).json().orders.length,
    0,
  );
  assert.equal(
    (await get("/orders?status=observed&venue=hyperliquid")).json().orders
      .length,
    2,
  );
  assert.equal(
    (await get("/orders?tokenId=hyperliquid:mainnet:87750")).json().orders
      .length,
    0,
  );
  assert.equal(
    (await get("/orders?tokenId=hyperliquid:mainnet:87751")).json().orders
      .length,
    2,
  );
  assert.equal(
    (await get("/orders?marketId=hyperliquid:testnet:outcome:8775")).json()
      .orders.length,
    0,
  );
  assert.equal(
    (await get("/orders?venue=hyperliquid&q=NoMatchingMarket")).json().orders
      .length,
    0,
  );
  const openPage = await get("/orders/open?venue=hyperliquid");
  assert.equal(openPage.statusCode, 200, openPage.body);
  const open = openPage.json();
  assert.equal(open.orders.length, 1);
  assert.equal(open.openOrderCoverage.hyperliquid.state, "fresh");
  assert.equal(open.orders[0].kind, "observed_order");
  assert.equal(open.orders[0].filledSize, 2);
  assert.equal(open.orders[0].averageFillPrice, null);
  assert.equal(open.orders[0].observedOrder.remainingQuantity, "3");
  assert.equal(open.orders[0].actionRef, null);
  assert.equal(
    (await get(`/orders/${encodeURIComponent(open.orders[0].id)}`)).statusCode,
    200,
  );
  assert.equal(
    (await get("/orders/open?venue=hyperliquid&offset=1")).json().orders.length,
    0,
  );
  assert.equal(
    (await get("/orders/open?tokenId=hyperliquid:mainnet:87750")).json().orders
      .length,
    0,
  );
  assert.equal(
    (await get(`/orders/${observed.orders[0].id}`)).json().order.execution.id,
    observed.orders[0].execution.id,
  );
  assert.equal(
    requests.length,
    afterFirst,
    "shared History never calls a provider",
  );
  await target.query(
    `update hip4_account_snapshots set history=jsonb_set(history,'{openOrders,observedAt}',to_jsonb($2::text)) where account_address=$1`,
    [address, new Date(now + 3_600_000).toISOString()],
  );
  const futureOpen = (await get("/orders/open?venue=hyperliquid")).json();
  assert.equal(futureOpen.orders.length, 0);
  assert.equal(futureOpen.openOrderCoverage.hyperliquid.state, "unavailable");
  await target.query(
    `update hip4_account_snapshots set history=jsonb_set(history,'{openOrders,observedAt}',to_jsonb($2::text)) where account_address=$1`,
    [address, open.orders[0].observedOrder.observedAt],
  );

  failRole = true;
  const failure = (await get(`${base}?refresh=1`)).json();
  assert.equal(failure.refreshState, "failed");
  assert.equal(failure.observation.observedAt, account.observation.observedAt);
  assert.equal(failure.observation.cash.total, "123.45");
  failRole = false;

  failOrders = true;
  await get(`${base}?refresh=1`);
  assert.equal(
    (await get("/orders/open?venue=hyperliquid")).json().openOrderCoverage
      .hyperliquid.state,
    "unavailable",
  );
  assert.equal(
    (await get("/orders/open?venue=hyperliquid")).json().orders.length,
    1,
    "last valid list remains visible within its original freshness window",
  );
  await target.query(
    `update hip4_account_snapshots set history=jsonb_set(history,'{openOrders,observedAt}',to_jsonb($2::text)) where account_address=$1`,
    [address, new Date(now - 120000).toISOString()],
  );
  assert.equal(
    (await get("/orders/open?venue=hyperliquid")).json().orders.length,
    0,
    "expired open orders are not current orders",
  );
  failOrders = false;
  openItems = [];

  let releaseSpot!: () => void;
  let reachedSpot!: () => void;
  const spotGate = new Promise<void>((resolve) => {
    releaseSpot = resolve;
  });
  const spotStarted = new Promise<void>((resolve) => {
    reachedSpot = resolve;
  });
  onSpot = async () => {
    reachedSpot();
    await spotGate;
  };
  const refreshing = get(`${base}?refresh=1`);
  try {
    await Promise.race([
      spotStarted,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("refresh_did_not_reach_spot")),
          5000,
        ).unref(),
      ),
    ]);
    const beforeConcurrent = requests.length;
    const concurrent = (await get(`${base}?refresh=1`)).json();
    assert.equal(concurrent.refreshState, "refreshing");
    assert.equal(requests.length, beforeConcurrent);
  } finally {
    releaseSpot();
    onSpot = undefined;
  }
  const recovered = (await refreshing).json();
  assert.equal(recovered.refreshState, "idle");
  assert.equal(recovered.observation.cash.total, "123.45");
  const emptyOpen = (await get("/orders/open?venue=hyperliquid")).json();
  assert.equal(emptyOpen.orders.length, 0);
  assert.equal(
    emptyOpen.openOrderCoverage.hyperliquid.state,
    "fresh",
    "an authoritative empty snapshot replaces prior orders",
  );
  assert.equal(
    (
      await target.query(
        "select count(*)::int as count from hip4_account_executions where account_address=$1",
        [address],
      )
    ).rows[0].count,
    2,
  );

  const setMode = (mode: "unreleased" | "exit-only") =>
    target.query("update runtime_policies set payload=$2 where id=$1", [
      lifecycle.id,
      {
        ...DEFAULT_VENUE_LIFECYCLE_POLICY,
        venues: {
          ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
          hyperliquid: { lifecycle: mode, indexerMode: "off" },
        },
      },
    ]);
  await setMode("unreleased");
  const beforeDisabled = requests.length;
  assert.equal((await get(`${base}?refresh=1`)).statusCode, 404);
  assert.equal((await get(`${base}/executions`)).statusCode, 404);
  assert.equal(
    (await get("/orders?venue=hyperliquid")).json().orders.length,
    0,
  );
  assert.equal((await get(`/orders/${observed.orders[0].id}`)).statusCode, 404);
  assert.equal(requests.length, beforeDisabled);
  await setMode("exit-only");
  const exitRead = await get(base);
  assert.equal(exitRead.statusCode, 200);
  assert.notEqual(exitRead.json().policyRevision, account.policyRevision);
  assert.equal(requests.length, beforeDisabled);
  await target.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[1],
    { enabled: true, pageSize: 0 },
  ]);
  assert.equal((await get(base)).statusCode, 503);
  assert.equal(requests.length, beforeDisabled);
  await target.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[1],
    { enabled: true },
  ]);
  assert.equal((await get(base)).statusCode, 200);
  await target.query(
    "update user_wallets set is_verified=false where user_id=$1",
    [userId],
  );
  assert.equal((await get(base)).statusCode, 403);
  assert.equal((await get(`${base}/executions`)).statusCode, 403);
  assert.equal(
    (await get("/orders?venue=hyperliquid")).json().orders.length,
    0,
  );
  assert.equal((await get(`/orders/${observed.orders[0].id}`)).statusCode, 404);
  assert.equal(requests.length, beforeDisabled);
  console.log(
    "HIP ordinary wallet PG16 auth, ownership, refresh/replay, lease, recovery, lifecycle and shared Portfolio PASS",
  );
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
  await target.query(
    "delete from hip4_account_snapshots where account_address=$1",
    [address],
  );
  await target.query(
    "delete from hip4_account_executions where account_address=$1",
    [address],
  );
  await target.query(
    "delete from hip4_account_ledger where account_address=$1",
    [address],
  );
  await target.query("delete from users where id=$1", [userId]);
  await target.query("delete from runtime_policies where id=any($1::uuid[])", [
    policyIds,
  ]);
  await lifecycle.close();
  await target.end();
  await closeAcquiredRuntimeResources();
}
