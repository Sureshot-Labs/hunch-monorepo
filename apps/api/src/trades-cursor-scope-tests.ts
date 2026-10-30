// @isolated-process
import assert from "node:assert/strict";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

// Exercise the real HTTP route without .env, database connections or providers.
Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/trades_scope_test",
  REDIS_URL: "",
  JWT_SECRET: "trades-scope-test",
  PRIVY_APP_ID: "trades-scope-test",
  PRIVY_APP_SECRET: "trades-scope-test",
});
const { pool } = await import("./db.js");
const { tradesRoutes, RECENT_TRADES_BY_TOKEN_SQL, COUNT_TRADES_BY_TOKEN_SQL } =
  await import("./routes/trades.js");
const { closeAcquiredRuntimeResources } =
  await import("./runtime-resource-cleanup.js");
const originalFetch = globalThis.fetch;
const originalQuery = pool.query;
const originalConnect = pool.connect;
const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
const upstreamCalls: URL[] = [];
const condition = `0x${"a".repeat(64)}`;
const marketId = "polymarket:6383772";
let upstreamStatus = 200;
let nextCursor: string | null = "opaque+/=";
let invalidEnvelope = false;
let releases = 0;
const localTrade = {
  token_id: "123",
  venue: "polymarket",
  ts: new Date("2026-10-30T10:00:00.000Z"),
  price: "0.4",
  size: "2",
  side: "BUY",
  tx_hash: "0xsynthetic",
};
const query = async (sql: string, values: unknown[] = []) => {
  sqlCalls.push({ sql, values });
  if (sql.includes("select condition_id")) {
    assert.match(sql, /where id = \$1/);
    return {
      rows: values[0] === marketId ? [{ condition_id: condition }] : [],
    };
  }
  if (sql.includes("select venue_event_id")) {
    return {
      rows: values[0] === "polymarket:legacy" ? [{ venue_event_id: 123 }] : [],
    };
  }
  if (
    sql.includes("from unified_tokens") &&
    sql.includes("where market_id = $1")
  ) {
    assert.equal(values[0], marketId);
    return { rows: [{ token_id: "123" }] };
  }
  if (sql === RECENT_TRADES_BY_TOKEN_SQL) {
    assert.deepEqual(values[0], ["123"]);
    return { rows: [localTrade] };
  }
  if (sql === COUNT_TRADES_BY_TOKEN_SQL) return { rows: [{ total: "1" }] };
  if (
    sql === "begin read only" ||
    sql === "commit" ||
    sql === "rollback" ||
    sql.startsWith("select set_config")
  ) {
    return { rows: [] };
  }
  throw Error(`unexpected SQL in trades scope test: ${sql}`);
};
pool.query = query as typeof pool.query;
pool.connect = (async () => ({
  query,
  release: () => releases++,
})) as unknown as typeof pool.connect;
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  upstreamCalls.push(url);
  assert.equal(url.pathname, "/v2/trades");
  assert.equal(url.searchParams.has("offset"), false);
  assert.equal(url.searchParams.get("taker_only"), "true");
  // Reproduce the observed provider rejection instead of allowing a false-green mock.
  if (url.searchParams.has("condition") && url.searchParams.has("event_id")) {
    return Response.json(
      { code: "invalid_request", retryable: false },
      { status: 400 },
    );
  }
  if (upstreamStatus !== 200) {
    return Response.json(
      { code: "temporary", retryable: true },
      { status: upstreamStatus },
    );
  }
  if (invalidEnvelope) return Response.json({ data: [] });
  return Response.json({
    data: [
      {
        token_id: "123",
        side: "BUY",
        timestamp: 1793354400,
        price: 0.4,
        size: 2,
        transaction_hash: "0xsynthetic",
      },
    ],
    pagination: { next_cursor: nextCursor },
  });
}) as typeof fetch;
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Trades scope", version: "1" } },
  transform: jsonSchemaTransform,
});
await app.register(tradesRoutes);
const both = `marketId=${marketId}&eventId=polymarket:1277210`;
const request = (filters: string) =>
  app.inject(`/trades?paginationMode=cursor&limit=2&${filters}`);
try {
  const first = await request(both);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().pagination.nextCursor, "opaque+/=");
  assert.equal(first.json().pagination.total, null);
  assert.equal(first.json().pagination.totalIsExact, false);
  assert.equal(first.json().pagination.hasMore, true);
  assert.equal(first.json().trades[0].tokenId, "123");
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0]?.searchParams.get("condition"), condition);
  assert.equal(upstreamCalls[0]?.searchParams.has("event_id"), false);
  assert.equal(sqlCalls.length, 1, "only the selected market needs resolving");

  nextCursor = null;
  const second = await request(`${both}&cursor=opaque%2B%2F%3D`);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().pagination.hasMore, false);
  assert.equal(upstreamCalls.at(-1)?.searchParams.get("cursor"), "opaque+/=");
  assert.equal(upstreamCalls.at(-1)?.searchParams.get("condition"), condition);
  assert.equal(upstreamCalls.at(-1)?.searchParams.has("event_id"), false);

  for (const filters of [
    `marketId=${marketId}`,
    `${both.replace("1277210", "unknown")}`,
  ]) {
    assert.equal((await request(filters)).statusCode, 200);
    assert.equal(
      upstreamCalls.at(-1)?.searchParams.get("condition"),
      condition,
    );
    assert.equal(upstreamCalls.at(-1)?.searchParams.has("event_id"), false);
  }
  assert.ok(
    sqlCalls.every((c) => !c.sql.includes("from unified_events")),
    "ignored event never resolves or widens the market scope",
  );
  for (const eventId of ["polymarket:123", "polymarket:legacy"]) {
    assert.equal((await request(`eventId=${eventId}`)).statusCode, 200);
    assert.equal(upstreamCalls.at(-1)?.searchParams.get("event_id"), "123");
    assert.equal(upstreamCalls.at(-1)?.searchParams.has("condition"), false);
  }
  for (const filters of [
    "marketId=polymarket:missing&eventId=polymarket:123",
    "eventId=polymarket:missing",
  ]) {
    const before: number = upstreamCalls.length;
    assert.equal((await request(filters)).statusCode, 404);
    assert.equal(
      upstreamCalls.length,
      before,
      "unknown market must not fall back to its event",
    );
  }
  for (const filters of [
    "eventId=limitless:123",
    `${both}&offset=2`,
    `${both}&tokenIds=123`,
  ]) {
    const before: number = upstreamCalls.length;
    assert.equal((await request(filters)).statusCode, 400);
    assert.equal(upstreamCalls.length, before);
  }
  for (const status of [429, 503]) {
    upstreamStatus = status;
    const before: number = upstreamCalls.length;
    const failed = await request(both);
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().code, "polymarket_trades_unavailable");
    assert.equal(
      upstreamCalls.length,
      before + 1,
      "one request, no retries or wider fallback",
    );
    upstreamStatus = 200;
    assert.equal(
      (await request(both)).statusCode,
      200,
      "ordinary retry recovers",
    );
  }
  invalidEnvelope = true;
  assert.equal((await request(both)).statusCode, 503);
  invalidEnvelope = false;
  assert.equal((await request(both)).statusCode, 200);

  const beforeOffset = upstreamCalls.length;
  const offset = await app.inject(`/trades?${both}&limit=2`);
  assert.equal(offset.statusCode, 200, offset.body);
  assert.deepEqual(offset.json().pagination, {
    total: 1,
    limit: 2,
    offset: 0,
    hasMore: false,
  });
  assert.equal(
    upstreamCalls.length,
    beforeOffset,
    "offset stays on the local index",
  );
  assert.equal(releases, 1);
  assert.ok(sqlCalls.every((c) => !/\b(insert|update|delete)\s/i.test(c.sql)));
  await app.ready();
  const operation = app.swagger().paths?.["/trades"]?.get;
  assert.ok(operation, "real route OpenAPI remains valid");
  assert.match(
    JSON.stringify(operation.parameters),
    /takes precedence over eventId/,
  );
  console.log(
    "Trades scope: combined/individual filters, opaque cursors, 404/400, upstream failure/recovery and offset compatibility passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  pool.query = originalQuery;
  pool.connect = originalConnect;
  await app.close();
  await closeAcquiredRuntimeResources();
}
