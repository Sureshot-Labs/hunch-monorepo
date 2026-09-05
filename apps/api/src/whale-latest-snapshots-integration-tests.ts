// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "./test-database-target.js";

// Execute the actual production CTE, so edits to its SQL are covered here.
const source = readFileSync(
  new URL("./routes/wallet-intel.ts", import.meta.url),
  "utf8",
);
const route = source.slice(
  source.indexOf("async function loadWhaleTopMarkets("),
);
const cte = route
  .slice(
    route.indexOf("latest_snapshots as materialized ("),
    route.indexOf("latest_position_rows as materialized ("),
  )
  .trim()
  .replace(/,$/, "");
const original = `latest_snapshots as materialized (
  select s.wallet_id, s.venue, max(s.snapshot_at) as snapshot_at
  from wallet_position_snapshots s
  join wallet_set w on w.wallet_id = s.wallet_id
  group by s.wallet_id, s.venue
)`;
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query(`create temporary table wallet_position_snapshots (
    wallet_id uuid not null, venue text not null, snapshot_at timestamptz not null,
    shares numeric not null
  ) on commit drop`);
  await client.query(`create index on wallet_position_snapshots
    (wallet_id, venue, snapshot_at desc)`);
  const wallets = [1, 2, 3].map(
    (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  );
  await client.query(
    `insert into wallet_position_snapshots
    select $1::uuid, venue_name, '2026-01-01'::timestamptz + n * interval '1 minute', 1
    from unnest(array['polymarket','limitless','future-venue','']) venue_name
    cross join generate_series(1, 5000) n`,
    [wallets[0]],
  );
  // Latest zero positions must not resurrect older positive holdings; ties are valid.
  await client.query(
    `insert into wallet_position_snapshots values
    ($1, 'polymarket', '2026-02-01', 0),
    ($1, 'polymarket', '2026-02-01', 0),
    ($2, 'kalshi', '2026-01-05', 2)`,
    wallets.slice(0, 2),
  );
  for (const ids of [
    [],
    [wallets[2]],
    [wallets[0]],
    wallets,
    [wallets[0], wallets[0], wallets[1]],
  ]) {
    const run = async (sql: string) =>
      (
        await client.query(
          `
      with wallet_set as (select unnest($1::uuid[]) wallet_id), ${sql}
      select wallet_id,venue,snapshot_at::text from latest_snapshots
      order by wallet_id,venue`,
          [ids],
        )
      ).rows;
    assert.deepEqual(await run(cte), await run(original));
  }
  const positive = await client.query(
    `with wallet_set as (select unnest($1::uuid[]) wallet_id), ${cte}
    select s.* from latest_snapshots l join wallet_position_snapshots s
      using(wallet_id,venue,snapshot_at)
    where s.venue='polymarket' and s.shares>0`,
    [[wallets[0]]],
  );
  assert.equal(positive.rowCount, 0);
  console.log(
    "ok - whale latest snapshots: empty, missing, duplicate wallets, arbitrary venues, history, ties and zero latest holdings",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
