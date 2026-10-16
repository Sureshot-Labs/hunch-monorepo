// @requires-db
// Shared feed/favorites, real auth, PG16 and an isolated Redis database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import {
  validatorCompiler,
  serializerCompiler,
} from "fastify-type-provider-zod";
import {
  DEFAULT_HIP4_READ_POLICY,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  hip4Identity,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { persistHip4Market } from "./services/hip4-repository.js";
import { clearVenueLifecyclePolicyCache } from "./services/runtime-policies.js";

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
const [
  { env },
  { pool },
  { AuthService },
  { getRedis },
  { feedRoutes },
  { metaRoutes },
  { closeAcquiredRuntimeResources },
] = await Promise.all([
  import("./env.js"),
  import("./db.js"),
  import("./auth.js"),
  import("./redis.js"),
  import("./routes/feed.js"),
  import("./routes/meta.js"),
  import("./runtime-resource-cleanup.js"),
]);
assert.equal(
  (await pool.query("select current_database() as target")).rows[0].target,
  process.env.HUNCH_TEST_EXPECT_DATABASE,
);
// The runner may have loaded .env before importing this test. Pin runtime Redis
// explicitly too; never send fixture hot-demand or cache writes to another DB.
const previousRedis = env.redisUrl,
  previousTtl = env.feedTtlSec;
env.redisUrl = "redis://127.0.0.1:55437/13";
env.feedTtlSec = 60;
const originalFetch = globalThis.fetch,
  originalNow = Date.now;
globalThis.fetch = async () => {
  throw new Error("unexpected_provider_request");
};
const ids = [740001, 740002, 740003].map(
  (value) => hip4Identity("mainnet", value).marketId,
);
assert.equal(
  (
    await target.query(
      "select id from unified_markets where id=any($1::text[])",
      [ids],
    )
  ).rowCount,
  0,
);
const ownerId = randomUUID(),
  policyId = randomUUID();
const tag = `hipfeed${randomUUID().replaceAll("-", "")}`;
const address = `0x${randomUUID().replaceAll("-", "")}00000001`;
const source = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
const lifecycle = await installHip4TestLifecycle(target);
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
const setLifecycle = async (active: boolean) => {
  await target.query(
    "update runtime_policies set payload=$2,effective_at=clock_timestamp() where id=$1",
    [
      lifecycle.id,
      {
        ...DEFAULT_VENUE_LIFECYCLE_POLICY,
        venues: {
          ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
          hyperliquid: {
            lifecycle: active ? "active" : "unreleased",
            indexerMode: active ? "full" : "off",
          },
        },
      },
    ],
  );
  clearVenueLifecyclePolicyCache(pool);
};
try {
  const redis = await getRedis();
  assert.ok(redis, "isolated Redis must be running for cache acceptance");
  await target.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$2,clock_timestamp())",
    [policyId, { ...DEFAULT_HIP4_READ_POLICY, environment: "mainnet" }],
  );
  const observedAt = new Date().toISOString();
  for (const outcome of [740001, 740002, 740003]) {
    const mapped = mapHip4Market({
      ...source,
      outcome,
      settlement: null,
      fetchedAt: observedAt,
      generation: randomUUID(),
      metadata: {
        ...source.metadata,
        questions: [],
        outcomes: [
          {
            ...source.metadata.outcomes[0],
            outcome,
            name: `${tag} ${outcome}`,
            description: `participant:${tag} ${outcome}|resolutionDeadline:20990101-0000`,
          },
        ],
      },
    });
    mapped.market.volume24h = {
      usd: "123.45",
      source: "spotMetaAndAssetCtxs",
      basis: "primary_outcome",
      coin: `#${outcome}0`,
      observedAt,
      validUntil: new Date(
        originalNow() + DEFAULT_HIP4_READ_POLICY.volumeMaxAgeMs,
      ).toISOString(),
    };
    mapped.market.sides = mapped.market.sides.map((side) => ({
      ...side,
      bid: "0.4",
      ask: "0.6",
      bookAt: observedAt,
      bookState: "fresh",
    }));
    assert.equal(
      await persistHip4Market(target, { ...mapped, trades: [] }),
      true,
    );
  }
  await target.query(
    "insert into users(id,is_active,is_admin) values($1,true,false)",
    [ownerId],
  );
  const token = AuthService.generateToken(ownerId);
  await AuthService.createSession(ownerId, address, token);
  await target.query(
    "insert into user_watchlist(user_id,market_id) select $1,market_key from unnest($2::text[]) as selected_market(market_key)",
    [ownerId, ids],
  );
  await app.register(feedRoutes);
  await app.register(metaRoutes);
  await app.ready();
  const metadata = await app.inject("/meta/venues");
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.equal(
    metadata.json().policy.venues.hyperliquid.readEnvironment,
    "mainnet",
  );
  assert.equal(
    metadata.json().policy.venues.hyperliquid.capabilities.discovery,
    true,
  );
  assert.equal(
    metadata.json().policy.venues.hyperliquid.capabilities.increaseExposure,
    true,
  );
  const query = `venue=hyperliquid&q=${tag}&view=markets&sort=trending&limit=2&min_total_volume=0`;
  const first = await app.inject(`/feed?${query}`);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.length, 2);
  const market = first.json().data[0].markets[0];
  assert.equal(market.volume24h, 123.45);
  assert.equal(market.volumeTotal, null);
  assert.equal(market.volumeDisplayPeriod, "24h");
  assert.equal(market.openInterest, null);
  assert.equal(market.liquidity, null);
  assert.equal(market.acceptingOrders, true);
  assert.equal(market.top.yesAsk, 0.6);
  assert.ok(market.topValidUntil.YES);
  assert.equal(first.json().data[0].eventVolume, null);
  const second = await app.inject(`/feed?${query}&offset=2`);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.length, 1);
  assert.equal(
    new Set(
      [...first.json().data, ...second.json().data].map(
        (event) => event.markets[0].marketId,
      ),
    ).size,
    3,
  );
  assert.equal(
    (await app.inject(`/feed?${query}&offset=3`)).json().data.length,
    0,
  );
  const cached = await app.inject(`/feed?${query}`);
  assert.equal(cached.headers["x-cache"], "hit");
  assert.equal(cached.headers.etag, first.headers.etag);
  assert.equal(
    (
      await app.inject({
        url: `/feed?${query}`,
        headers: { "if-none-match": String(cached.headers.etag) },
      })
    ).statusCode,
    304,
  );
  Date.now = () =>
    originalNow() +
    Math.max(
      DEFAULT_HIP4_READ_POLICY.bookMaxAgeMs,
      DEFAULT_HIP4_READ_POLICY.volumeMaxAgeMs,
    ) +
    1000;
  const stale = await app.inject({
    url: `/feed?${query}`,
    headers: { "if-none-match": String(cached.headers.etag) },
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers["x-cache"], "hit");
  assert.equal(stale.json().data[0].markets[0].top.yesAsk, null);
  assert.equal(stale.json().data[0].markets[0].volumeDisplay, null);
  assert.equal(stale.json().data[0].markets[0].acceptingOrders, false);
  assert.notEqual(stale.headers.etag, cached.headers.etag);
  Date.now = originalNow;
  const favorites = await app.inject({
    url: `/feed/favorites?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(favorites.statusCode, 200, favorites.body);
  assert.equal(favorites.json().data.length, 2);
  assert.equal(favorites.json().data[0].markets[0].volumeDisplayPeriod, "24h");
  assert.equal(favorites.json().data[0].markets[0].acceptingOrders, true);
  await setLifecycle(false);
  const hiddenMetadata = await app.inject("/meta/venues");
  assert.equal(hiddenMetadata.statusCode, 200, hiddenMetadata.body);
  assert.equal(
    hiddenMetadata.json().policy.venues.hyperliquid.readEnvironment,
    null,
  );
  assert.equal(
    hiddenMetadata.json().policy.venues.hyperliquid.capabilities.discovery,
    false,
  );
  assert.notEqual(
    hiddenMetadata.json().policy.revision,
    metadata.json().policy.revision,
  );
  const disabled = await app.inject(`/feed?${query}`);
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(
    disabled.json().data.length,
    0,
    "policy off must not leak cached markets",
  );
  await setLifecycle(true);
  const restoredMetadata = await app.inject("/meta/venues");
  assert.equal(restoredMetadata.statusCode, 200, restoredMetadata.body);
  assert.equal(
    restoredMetadata.json().policy.venues.hyperliquid.readEnvironment,
    "mainnet",
  );
  assert.equal(
    restoredMetadata.json().policy.venues.hyperliquid.capabilities.discovery,
    true,
  );
  const restored = await app.inject(`/feed?${query}`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().data.length, 2);
  assert.equal(restored.json().data[0].markets[0].acceptingOrders, true);
  console.log(
    "HIP4 common feed PG16: anonymous + ordinary authenticated reads, first/next/empty pages, null metrics, cache ageing/ETag, policy off/recovery passed",
  );
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  await app.close();
  await target.query("delete from user_watchlist where user_id=$1", [ownerId]);
  await target.query("delete from user_sessions where user_id=$1", [ownerId]);
  await target.query("delete from users where id=$1", [ownerId]);
  await target.query("delete from unified_markets where id=any($1::text[])", [
    ids,
  ]);
  await target.query("delete from unified_events where id=any($1::text[])", [
    ids,
  ]);
  await target.query("delete from runtime_policies where id=$1", [policyId]);
  await lifecycle.close();
  clearVenueLifecyclePolicyCache(pool);
  await closeAcquiredRuntimeResources();
  env.redisUrl = previousRedis;
  env.feedTtlSec = previousTtl;
  await target.end();
}
