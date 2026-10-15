// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  getVenueLifecycleCapabilities,
  type VenueLifecyclePolicyEntry,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import {
  readHip4Policy,
  persistHip4Market,
  readHip4Markets,
} from "./services/hip4-repository.js";
import { runHip4ReadCycle } from "./services/hip4-indexer.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { createHip4LiveBuffer, flushHip4Live } from "./services/hip4-live.js";
import { createHip4OwnedAccountService } from "./services/hip4-account-service.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { registerHip4ReadRoutes } from "./routes/hip4-read.js";
import { registerHip4AccountRoutes } from "./routes/hip4-account.js";
import { readHip4AccountExecutions } from "./services/hip4-account-repository.js";
import { readHip4Candles, readHip4Trades } from "./services/hip4-history.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000",
});
const ids = [randomUUID(), randomUUID()];
const lifecycleFixture = await installHip4TestLifecycle(pool);
const source = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
const address = `0x${randomUUID().replaceAll("-", "")}00000001`;
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
const setLifecycle = (entry: VenueLifecyclePolicyEntry) =>
  pool.query("update runtime_policies set payload=$2 where id=$1", [
    lifecycleFixture.id,
    JSON.stringify({
      ...DEFAULT_VENUE_LIFECYCLE_POLICY,
      venues: { ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues, hyperliquid: entry },
    }),
  ]);
let publicRequests = 0;
let accountRequests = 0;
let fixtureEventId: string | undefined;
const accountService = createHip4OwnedAccountService(pool, async () => {
  accountRequests++;
  throw new Error("not_expected_in_this_test");
});
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
  const defaults = await readHip4Policy(pool);
  assert.equal(defaults.policy.enabled, true);
  assert.equal(defaults.policy.catalogMode, "all");
  assert.equal((await accountService.policy()).accountPolicy.enabled, true);
  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [
      ...ids,
      JSON.stringify({
        enabled: false,
        catalogMode: "allowlist",
        outcomeAllowlist: [1],
        maxOutcomesPerCycle: 1,
      }),
      JSON.stringify({ enabled: false }),
    ],
  );
  const active = await readHip4Policy(pool);
  assert.equal(active.policy.enabled, true);
  assert.equal(
    active.policy.catalogMode,
    "all",
    "legacy test selection cannot truncate activated discovery",
  );
  assert.deepEqual(active.policy.outcomeAllowlist, []);
  assert.equal(
    (await accountService.policy()).accountPolicy.enabled,
    true,
    "legacy account flag is not a second product switch",
  );
  const activeCapabilities = getVenueLifecycleCapabilities(
    {
      ...DEFAULT_VENUE_LIFECYCLE_POLICY,
      venues: {
        ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
        hyperliquid: active.lifecycle,
      },
    },
    "hyperliquid",
  );
  assert.equal(activeCapabilities?.accountRead, true);
  assert.equal(activeCapabilities?.discovery, true);
  for (const capability of [
    "increaseExposure",
    "reduceExposure",
    "cancel",
    "redeem",
    "automation",
    "signalSource",
    "signalDelivery",
  ] as const)
    assert.equal(activeCapabilities?.[capability], false);
  const mapped = mapHip4Market({
    ...source,
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date().toISOString(),
    generation: randomUUID(),
  });
  fixtureEventId = mapped.market.eventId;
  await persistHip4Market(pool, { ...mapped, trades: [] });
  const observation = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date().toISOString(),
    role: "user",
    mode: "disabled",
    quote: {
      tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
      index: 0,
      weiDecimals: 8,
    },
    state: {
      balances: [{ coin: "+87750", total: "20", hold: "0", entryNtl: "0" }],
    },
  });
  await pool.query(
    "insert into hip4_account_snapshots(environment,account_address,observation,observed_at) values('mainnet',$1,$2,now())",
    [address, observation],
  );
  registerHip4ReadRoutes(app, {
    authorize: async () => {},
    policy: () => readHip4Policy(pool),
    markets: (...args) => readHip4Markets(pool, ...args),
    candles: (...args) => readHip4Candles(pool, ...args),
    trades: (...args) => readHip4Trades(pool, ...args),
  });
  registerHip4AccountRoutes(app, {
    surface: "owned",
    authorize: async (request) => {
      request.user = { id: "fixture" } as NonNullable<typeof request.user>;
      request.walletAddress = address;
    },
    owns: async () => true,
    service: accountService,
    executions: (...args) => readHip4AccountExecutions(pool, ...args),
  });
  const historyUrl = "/wallets/hyperliquid/account/executions";
  const marketUrl = `/wallets/hyperliquid/account/market?marketId=${encodeURIComponent(mapped.market.marketId)}`;
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary")).statusCode,
    200,
  );
  assert.equal((await app.inject(historyUrl)).statusCode, 200);
  const buffer = createHip4LiveBuffer(active.policy, () => {});
  buffer.select([8775]);
  buffer.data("trades", [
    { ...source.trades[0], coin: "#87750", tid: 7654321, time: Date.now() },
  ]);
  await setLifecycle({ lifecycle: "unreleased", indexerMode: "off" });
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary")).statusCode,
    404,
  );
  assert.equal((await app.inject(historyUrl)).statusCode, 404);
  assert.equal((await app.inject(marketUrl)).statusCode, 404);
  assert.equal(
    (await app.inject("/wallets/hyperliquid/account?refresh=1")).statusCode,
    404,
  );
  assert.equal(accountRequests, 0);
  let published = 0;
  await flushHip4Live(
    pool,
    active.policy,
    active.revision,
    buffer.take(),
    async () => {
      published++;
    },
  );
  assert.equal(published, 0);
  const disabled = await runHip4ReadCycle(pool, async () => {
    publicRequests++;
    return null;
  });
  assert.equal(publicRequests, 0);
  assert.equal(disabled.disabledReason, "venue_lifecycle");
  assert.notEqual((await readHip4Policy(pool)).revision, active.revision);

  await setLifecycle({ lifecycle: "exit-only", indexerMode: "maintenance" });
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary")).statusCode,
    404,
  );
  assert.equal((await app.inject(historyUrl)).statusCode, 200);
  assert.equal((await accountService.policy()).readPolicy.enabled, true);
  const ownedMarket = await app.inject(marketUrl);
  assert.equal(ownedMarket.statusCode, 200);
  assert.equal(ownedMarket.json().markets[0].marketId, mapped.market.marketId);
  assert.deepEqual(ownedMarket.json().streamTokenIds, []);
  assert.equal(
    (await app.inject("/wallets/hyperliquid/account/market")).statusCode,
    400,
  );
  assert.equal(
    (await app.inject(marketUrl.replace("8775", "8776"))).statusCode,
    404,
  );
  assert.equal(
    (await app.inject(marketUrl.replace("mainnet", "testnet"))).statusCode,
    404,
  );
  assert.equal(
    accountRequests,
    0,
    "review metadata must not refresh the provider",
  );
  const maintained = await runHip4ReadCycle(pool, async (request) => {
    publicRequests++;
    if (request.type === "outcomeMeta") return source.metadata;
    if (request.type === "spotMetaAndAssetCtxs")
      return [source.spotMetadata, []];
    return null;
  });
  assert.ok(publicRequests > 0);
  assert.equal(maintained.catalogPublished, 0);
  assert.equal(maintained.indexerMode, "maintenance");
  assert.equal(
    (await readHip4Markets(pool, "mainnet", null, -1, 100)).length,
    1,
    "maintenance updates existing markets; it must not import the provider catalog",
  );
  assert.equal(accountRequests, 0);

  await setLifecycle({ lifecycle: "active", indexerMode: "maintenance" });
  const maintenanceRevision = (await readHip4Policy(pool)).revision;
  assert.ok(
    maintenanceRevision.length <= 100,
    "revision fits the existing history contract",
  );
  assert.equal(
    (
      await app.inject(
        `/markets/hyperliquid/canary/${encodeURIComponent(mapped.market.marketId)}/candles?policyRevision=${maintenanceRevision}`,
      )
    ).statusCode,
    200,
  );

  await pool.query("update runtime_policies set payload='{}' where id=$1", [
    lifecycleFixture.id,
  ]);
  assert.equal(
    (await app.inject(historyUrl)).statusCode,
    503,
    "invalid master policy cannot enable reads",
  );
  await setLifecycle({ lifecycle: "active", indexerMode: "full" });
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary")).statusCode,
    200,
  );
  assert.equal(
    (await app.inject(historyUrl)).statusCode,
    200,
    "repair recovers without clearing caches or waiting for leases",
  );
  console.log(
    "HIP4 PG16 lifecycle: master disable, no provider requests/publication, exit-only owned history, bounded maintenance, invalid config and recovery PASS",
  );
} finally {
  await app.close();
  await pool.query(
    "delete from hip4_account_snapshots where environment='mainnet' and account_address=$1",
    [address],
  );
  await lifecycleFixture.close();
  await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
    ids,
  ]);
  if (fixtureEventId)
    await pool.query("delete from unified_events where id=$1", [
      fixtureEventId,
    ]);
  await pool.end();
}
