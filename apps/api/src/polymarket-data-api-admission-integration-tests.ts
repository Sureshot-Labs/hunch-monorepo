// @requires-db @requires-redis
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { createIntegrationTestPool } from "./test-database-target.js";
import { RedisDataApiAdmissionBackend } from "./services/polymarket-data-api-admission-redis.js";
import { PolymarketDataApiAdmission } from "./services/polymarket-data-api-admission.js";
import { RuntimeDataApiAdmissionBackend } from "./services/polymarket-data-api-admission-runtime.js";
import { exerciseAdmissionRaces } from "./polymarket-data-api-admission-test-fixtures.js";
import {
  discoverBackgroundPolymarketPositions as discover,
  type PositionDiscoveryStore,
} from "./services/polymarket-background-positions.js";

const pool = await createIntegrationTestPool({ max: 1 });
assert.match(
  String((await pool.query("select version()")).rows[0].version),
  /PostgreSQL 16/,
);
await pool.end();
const url =
  process.env.HUNCH_WALLET_INTEL_TEST_REDIS_URL ?? "redis://127.0.0.1:6380";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname));
const a = createClient({
    url,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  }),
  b = a.duplicate();
a.on("error", () => {});
b.on("error", () => {});
await a.connect();
await b.connect();
const prefix = `data-api-admission-test:${randomUUID()}:`,
  keys = new Set<string>();
const scoped = (key: string) => {
  const result = prefix + "checkpoint:" + key;
  keys.add(result);
  return result;
};
const wrap = (client: typeof a) => ({
  eval: async (
    script: string,
    input: { keys: string[]; arguments: string[] },
  ) => {
    for (const key of input.keys) {
      assert.ok(key.startsWith(prefix));
      keys.add(key);
    }
    return client.eval(script, input);
  },
});
try {
  await exerciseAdmissionRaces(
    (clock) => new RedisDataApiAdmissionBackend(wrap(a), prefix, clock),
  );
  let clock = 1000000;
  const readerA = new PolymarketDataApiAdmission(
    new RedisDataApiAdmissionBackend(wrap(a), prefix, () => clock),
    () => clock,
    async (ms) => {
      clock += ms;
    },
    () => 0,
  );
  let online = true;
  const runtimeB = new RuntimeDataApiAdmissionBackend(
    async () =>
      online
        ? new RedisDataApiAdmissionBackend(wrap(b), prefix, () => clock)
        : null,
    () => true,
    () => clock,
  );
  const readerB = new PolymarketDataApiAdmission(
    runtimeB,
    () => clock,
    async (ms) => {
      clock += ms;
    },
    () => 0,
  );
  const store: PositionDiscoveryStore = {
    get: (key) => b.get(scoped(key)),
    set: (key, value, options) => b.set(scoped(key), value, options),
    del: (key) => b.del(scoped(key)),
  };
  const owner = "0x1111111111111111111111111111111111111111",
    other = "0x2222222222222222222222222222222222222222";
  const row = (id: string) => ({
    token_id: id,
    proxy_wallet: owner,
    condition_id: `0x${"11".repeat(32)}`,
    current_size: 1,
    avg_price: 0.4,
    outcome_index: 0,
    redeemable: false,
  });
  const page = (rows: unknown[], cursor: string | null) =>
    Response.json({ data: rows, pagination: { next_cursor: cursor } });
  let calls = 0;
  const first = await discover({
    owner,
    baseUrl: "https://shared.example.invalid",
    store,
    admission: readerA,
    now: () => clock,
    config: { maxAttempts: 1 },
    fetchImpl: (async () =>
      ++calls === 1
        ? page([row("1")], "resume-me")
        : new Response(null, {
            status: 429,
            headers: { "retry-after": "60", "cf-ray": "test-ARN" },
          })) as typeof fetch,
  });
  assert.equal(first.status, "deferred");
  assert.equal(first.discoveredTokens, 1);
  assert.deepEqual(first.tokens, []);
  const denied = await discover({
    owner: other,
    baseUrl: "https://shared.example.invalid",
    store,
    admission: readerB,
    now: () => clock,
    fetchImpl: (async () => {
      calls++;
      throw Error("must not fetch during another process's cooldown");
    }) as typeof fetch,
  });
  assert.equal(denied.rateLimitSource, "shared_limiter");
  assert.equal(calls, 2);
  online = false;
  await assert.rejects(
    () =>
      readerB.acquire(
        new URL("https://shared.example.invalid/v2/positions"),
        AbortSignal.timeout(1000),
        "interactive",
        1000,
      ),
    /shared_cooldown/,
  );
  online = true;
  clock += 60001;
  const recovered = await discover({
    owner,
    baseUrl: "https://shared.example.invalid",
    store,
    admission: readerB,
    now: () => clock,
    fetchImpl: (async (input) => {
      assert.equal(
        new URL(String(input)).searchParams.get("cursor"),
        "resume-me",
      );
      return page([row("2")], null);
    }) as typeof fetch,
  });
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.tokens.length, 2);
  const stateKeys = [...keys].filter((k) => !k.includes(":checkpoint:"));
  for (const key of stateKeys) {
    const value = await b.get(key);
    assert.ok(value);
    assert.ok(!value.includes(owner));
    assert.ok(!value.includes("resume-me"));
    assert.ok((await b.pTTL(key)) > 0);
  }
  // A dead connection does not poison the shared state for another process.
  a.destroy();
  const healthy = await readerB.acquire(
    new URL("https://shared.example.invalid/v2/trades"),
    AbortSignal.timeout(1000),
    "interactive",
    1000,
  );
  await readerB.finish(healthy, { kind: "success", retryAfterMs: 0 });
  console.log(
    "[data-api admission integration] real Redis Lua, concurrent Retry-After races, independent-process cooldown/probe and cursor recovery passed",
  );
} finally {
  for (const key of keys) {
    assert.ok(key.startsWith(prefix));
    await b.del(key);
  }
  if (a.isOpen) await a.quit();
  if (b.isOpen) await b.quit();
}
