// @requires-db
// Real shared /positions routes, ordinary auth and PG16. No provider requests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { projectHip4Account } from "./services/hip4-account-projection.js";

const target = await createIntegrationTestPool({
  max: 2,
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
process.env.JWT_SECRET = "hip4-disposable-portfolio-test-only";
process.env.PRIVY_APP_ID = "hip4-disposable-test";
process.env.PRIVY_APP_SECRET = "hip4-disposable-test";
// These routes must read local facts, never synchronously fetch provider history.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("unexpected_provider_request");
};
const [
  { AuthService },
  { pool },
  { positionsRoutes },
  { closeAcquiredRuntimeResources },
] = await Promise.all([
  import("./auth.js"),
  import("./db.js"),
  import("./routes/positions.js"),
  import("./runtime-resource-cleanup.js"),
]);
assert.equal(
  (await pool.query("select current_database() as target")).rows[0].target,
  process.env.HUNCH_TEST_EXPECT_DATABASE,
);
const ownerId = randomUUID(),
  strangerId = randomUUID();
const address = `0x${randomUUID().replaceAll("-", "")}00000001`;
const foreignAddress = `0x${randomUUID().replaceAll("-", "")}00000002`;
const policyIds = [randomUUID(), randomUUID()];
const lifecycle = await installHip4TestLifecycle(target);
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Portfolio read test", version: "1" } },
  transform: jsonSchemaTransform,
});
try {
  await target.query(
    "insert into users(id,is_active,is_admin) values($1,true,false),($2,true,false)",
    [ownerId, strangerId],
  );
  await target.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified,is_primary) values($1,$3,'ethereum',true,true),($2,$4,'ethereum',true,true)",
    [ownerId, strangerId, address, foreignAddress],
  );
  await target.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [...policyIds, { enabled: true, catalogMode: "all" }, { enabled: true }],
  );
  const observation = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date().toISOString(),
    role: "user",
    mode: "disabled",
    quote: { tokenId: "USDC", index: 0, weiDecimals: 8 },
    state: {
      balances: [
        { coin: "+87750", total: "2.12345", hold: "0", entryNtl: "9" },
        { coin: "+87751", total: "5", hold: "1", entryNtl: "9" },
      ],
    },
  });
  await target.query(
    "insert into hip4_account_snapshots(environment,account_address,observation,observed_at) values('mainnet',$1,$2,now())",
    [address, observation],
  );
  const token = AuthService.generateToken(ownerId);
  await AuthService.createSession(ownerId, address, token);
  const strangerToken = AuthService.generateToken(strangerId);
  await AuthService.createSession(strangerId, foreignAddress, strangerToken);
  await app.register(positionsRoutes);
  await app.ready();
  const headers = {
    authorization: `Bearer ${token}`,
    "x-hunch-wallet": address,
  };
  const get = (url: string) => app.inject({ url, headers });
  assert.equal(
    (await app.inject("/positions?venue=hyperliquid")).statusCode,
    401,
  );
  const list = await get("/positions?venue=hyperliquid&includeMarkets=true");
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.headers["cache-control"], "private, no-store");
  const data = list.json();
  assert.equal(data.positions.length, 2);
  assert.equal(data.positions[0].sizeRaw, "2.12345");
  assert.equal(data.positions[0].averagePrice, null);
  assert.equal(data.positions[0].unrealizedPnl, null);
  assert.equal(data.positions[0].marketSummary, null);
  assert.equal(data.coverage.hyperliquid.unpricedPositions, 2);
  assert.equal(
    (await get("/positions?venues=hyperliquid,limitless")).json().positions
      .length,
    2,
  );
  assert.equal(
    (await get("/positions?venue=limitless")).json().coverage,
    undefined,
  );
  assert.equal((await get("/positions")).json().positions.length, 2);
  const byToken = await get(
    "/positions/by-token?venue=hyperliquid&tokenIds=hyperliquid:mainnet:87751",
  );
  assert.equal(byToken.statusCode, 200, byToken.body);
  assert.equal(byToken.json().positions.length, 1);
  assert.equal(byToken.json().positions[0].instrument.sideIndex, 1);
  assert.equal(
    (await get("/positions?venue=hyperliquid&minSize=3")).json().positions
      .length,
    1,
  );
  assert.equal(
    (await get("/positions?venue=hyperliquid&minSize=1e-7")).json().positions
      .length,
    2,
  );
  assert.equal(
    (await get("/positions?venue=hyperliquid&minSize=1e-100")).json().positions
      .length,
    2,
  );
  assert.equal(
    (await get("/positions?venue=hyperliquid&minSize=1e100")).json().positions
      .length,
    0,
  );
  const summary = await get("/positions/pnl?venue=hyperliquid");
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().summary.positionsCount, 2);
  assert.equal(summary.json().summary.realizedPnlAllTime, null);
  assert.equal(summary.json().summary.unrealizedPnlCurrent, null);
  const foreign = await app.inject({
    url: "/positions?venue=hyperliquid",
    headers: {
      authorization: `Bearer ${strangerToken}`,
      "x-hunch-wallet": foreignAddress,
    },
  });
  assert.equal(foreign.statusCode, 200);
  assert.equal(foreign.json().positions.length, 0);
  assert.equal(foreign.json().coverage.hyperliquid.missingAccounts, 1);
  assert.equal(
    (await get(`/positions?venue=hyperliquid&wallets=${foreignAddress}`))
      .statusCode,
    400,
  );
  await target.query(
    "update user_wallets set is_verified=false where user_id=$1",
    [ownerId],
  );
  assert.equal(
    (await get("/positions?venue=hyperliquid")).json().positions.length,
    0,
  );
  await target.query(
    "update user_wallets set is_verified=true where user_id=$1",
    [ownerId],
  );
  await target.query("update runtime_policies set payload=$2 where id=$1", [
    lifecycle.id,
    DEFAULT_VENUE_LIFECYCLE_POLICY,
  ]);
  assert.equal(
    (await get("/positions?venue=hyperliquid")).json().coverage.hyperliquid
      .state,
    "disabled",
  );
  await target.query("update runtime_policies set payload=$2 where id=$1", [
    lifecycle.id,
    {
      ...DEFAULT_VENUE_LIFECYCLE_POLICY,
      venues: {
        ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
        hyperliquid: { lifecycle: "exit-only", indexerMode: "off" },
      },
    },
  ]);
  assert.equal(
    (await get("/positions?venue=hyperliquid")).json().positions.length,
    2,
  );
  await target.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[1],
    { enabled: "invalid" },
  ]);
  const unavailable = await get("/positions?venues=hyperliquid,limitless");
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.json().coverage.hyperliquid.state, "unavailable");
  assert.equal(
    (await get("/positions/pnl?venue=hyperliquid")).json().summary
      .unrealizedPnlCurrent,
    null,
  );
  const spec = app.swagger();
  assert.ok(
    JSON.stringify(spec.paths?.["/positions"]?.get).includes("hyperliquid"),
  );
  assert.ok(
    !JSON.stringify(spec.paths?.["/positions/sync"]?.post).includes(
      "hyperliquid",
    ),
  );
  console.log(
    "Shared Portfolio PG16 routes, ordinary auth, ownership, lifecycle, null PnL, compatibility and OpenAPI PASS",
  );
} finally {
  await app.close();
  await target.query(
    "delete from hip4_account_snapshots where account_address=$1",
    [address],
  );
  await target.query("delete from runtime_policies where id=any($1::uuid[])", [
    policyIds,
  ]);
  await lifecycle.close();
  await target.query("delete from users where id=any($1::uuid[])", [
    [ownerId, strangerId],
  ]);
  await target.end();
  await closeAcquiredRuntimeResources();
  globalThis.fetch = fetchBefore;
}
