import assert from "node:assert/strict";
import "./integration-test-database-guard.js";
import type { Pool } from "@hunch/infra";
import { pool } from "./db.js";
import { setPositionHidden } from "./repos/positions-repo.js";

// Exercise the real mutation SQL on temporary relations only. No real user
// rows or persistent schema changes, even in the disposable database.
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query(`create temporary table positions (
    id uuid primary key, user_id uuid, venue text, token_id text,
    wallet_address text, position_scope text, is_hidden boolean default false,
    hidden_reason text, hidden_at timestamptz, updated_at timestamptz
  ) on commit drop`);
  await client.query(`create temporary table notifications (
    user_id uuid, type text, dedupe_key text, read_at timestamptz, updated_at timestamptz
  ) on commit drop`);
  const userId = crypto.randomUUID();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const walletAddress = "0x1111111111111111111111111111111111111111";
  await client.query(
    `insert into positions (id,user_id,venue,token_id,wallet_address,position_scope)
    values ($1,$3,'limitless','token',$4,'own'),($2,$3,'limitless','token',$4,'own')`,
    [first, second, userId, walletAddress],
  );
  const query = async (sql: string, params?: unknown[]) =>
    /^(begin|commit|rollback)$/i.test(sql.trim())
      ? { rows: [], rowCount: 0 }
      : client.query(sql, params);
  const scopedPool = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as Pool;
  const target = {
    userId,
    walletAddress,
    venue: "limitless" as const,
    tokenId: "token",
    positionId: first,
    hidden: true,
  };
  assert.equal(
    await setPositionHidden(scopedPool, {
      ...target,
      userId: crypto.randomUUID(),
    }),
    0,
  );
  assert.equal(
    await setPositionHidden(scopedPool, {
      ...target,
      positionId: crypto.randomUUID(),
    }),
    0,
  );
  assert.equal(await setPositionHidden(scopedPool, target), 1);
  assert.equal(await setPositionHidden(scopedPool, target), 1);
  assert.deepEqual(
    (await client.query("select id,is_hidden from positions order by id")).rows,
    [
      { id: first, is_hidden: true },
      { id: second, is_hidden: false },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(
    await setPositionHidden(scopedPool, { ...target, hidden: false }),
    1,
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as hidden_count from positions where is_hidden",
      )
    ).rows[0].hidden_count,
    0,
  );
  // Preserve the pre-existing API behavior when no exact position is requested.
  assert.equal(
    await setPositionHidden(scopedPool, { ...target, positionId: undefined }),
    2,
  );
  console.log(
    "ok - PostgreSQL exact position hide, foreign identity, retry, undo and legacy scope",
  );
} finally {
  await client.query("rollback");
  client.release();
}
