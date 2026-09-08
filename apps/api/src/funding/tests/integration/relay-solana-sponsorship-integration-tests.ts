// @requires-infra
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import {
  relaySponsorCandidateSql,
  reserveRelaySponsorBudgetLua,
} from "../../execution/relay-solana-sponsorship.js";

const db = await createIntegrationTestPool({ max: 1 });
const client = await db.connect();
try {
  await client.query("begin");
  await client.query("set local statement_timeout = 5000");
  assert.equal(
    Number(
      (await client.query("show server_version_num")).rows[0]
        .server_version_num,
    ) >= 160000,
    true,
  );
  // Only transaction-local fixtures; do not mutate the real funding tables.
  await client.query(`
    create temporary table funding_operations (id uuid, user_id uuid, created_at timestamptz);
    create temporary table funding_operation_steps (id uuid, operation_id uuid, segment_id uuid, normalized_action jsonb, action_fingerprint text, action_expires_at timestamptz);
    create temporary table funding_operation_segments (id uuid, operation_id uuid, provider_id text);
    create temporary table funding_operation_step_attempts (step_id uuid, outcome text, broadcast_may_have_occurred boolean);
  `);
  const userId = randomUUID(),
    operationId = randomUUID(),
    stepId = randomUUID(),
    segmentId = randomUUID();
  await client.query("insert into funding_operations values ($1, $2, now())", [
    operationId,
    userId,
  ]);
  await client.query(
    "insert into funding_operation_steps values ($1,$2,$3,$4,'fingerprint',now() + interval '1 minute')",
    [
      stepId,
      operationId,
      segmentId,
      { kind: "svm_transaction", actionId: "action_integration" },
    ],
  );
  await client.query(
    "insert into funding_operation_segments values ($1,$2,'relay')",
    [segmentId, operationId],
  );
  const read = (owner = userId) =>
    client.query(relaySponsorCandidateSql, [owner, "action_integration"]);
  assert.equal(
    (await read()).rowCount,
    0,
    "no grant before a durable attempt exists",
  );
  await client.query(
    "insert into funding_operation_step_attempts values ($1,'started',false)",
    [stepId],
  );
  assert.equal((await read()).rowCount, 1);
  assert.equal(
    (await read(randomUUID())).rowCount,
    0,
    "foreign user's action cannot sponsor",
  );
  await client.query(
    "update funding_operation_step_attempts set broadcast_may_have_occurred = true",
  );
  assert.equal((await read()).rowCount, 0);
  await client.query(
    "update funding_operation_step_attempts set broadcast_may_have_occurred = false, outcome = 'ambiguous'",
  );
  assert.equal((await read()).rowCount, 0);
  await client.query(
    "update funding_operation_step_attempts set outcome = 'started'",
  );
  await client.query(
    "update funding_operation_segments set provider_id = 'not-relay'",
  );
  assert.equal((await read()).rowCount, 0);
  await client.query(
    "update funding_operation_segments set provider_id = 'relay'",
  );
  await client.query(
    "update funding_operation_steps set action_expires_at = now() - interval '1 second'",
  );
  assert.equal((await read()).rowCount, 0, "expired quote cannot sponsor");
} finally {
  await client.query("rollback");
  client.release();
  await db.end();
}

const redisUrl = new URL(
  process.env.HUNCH_TEST_REDIS_URL || "redis://127.0.0.1:6380",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(redisUrl.hostname),
  "only local test Redis is allowed",
);
const redis = createClient({ url: redisUrl.toString() });
await redis.connect();
const prefix = `test:relay-svm-sponsor:${randomUUID()}:`;
const keys = new Set<string>();
async function reserve(action: string, user: string) {
  const selected = [prefix + action, prefix + user, prefix + "app"];
  selected.forEach((key) => keys.add(key));
  return redis.eval(reserveRelaySponsorBudgetLua, {
    keys: selected,
    arguments: ["2", "4"],
  });
}
try {
  assert.equal(
    await redis.exists(prefix + "app"),
    0,
    "fresh isolated test namespace",
  );
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      reserve(`action-${index}`, "user-a"),
    ),
  );
  assert.equal(
    concurrent.filter((result) => result === 1).length,
    2,
    "atomic per-user cap under concurrency",
  );
  const accepted = concurrent.findIndex((result) => result === 1);
  assert.equal(
    await reserve(`action-${accepted}`, "user-a"),
    1,
    "same canonical action reuses its reservation",
  );
  assert.equal(await redis.get(prefix + "user-a"), "2");
  assert.equal(await reserve("b1", "user-b"), 1);
  assert.equal(await reserve("b2", "user-b"), 1);
  assert.equal(
    await reserve("c1", "user-c"),
    0,
    "global cap applies across users",
  );
  assert.equal(await redis.get(prefix + "app"), "4");
  assert.ok((await redis.ttl(prefix + "app")) > 0);
  console.log(
    "[relay-solana-sponsorship-integration-tests] PG16 ownership/provider/attempt/expiry and Redis concurrent/replay/global budget passed",
  );
} finally {
  // Exact keys produced by this test only, never FLUSHDB or wildcard deletion.
  const cleanup = [...keys];
  assert.ok(cleanup.every((key) => key.startsWith(prefix)));
  if (cleanup.length) await redis.unlink(cleanup);
  await redis.quit();
}
