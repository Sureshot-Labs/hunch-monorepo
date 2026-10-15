// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { POLYMARKET_PROTOCOL_CONTRACTS as contracts } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { fetchPositionResolutionCandidates } from "./repos/position-resolution-candidates.js";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await db.connect();
const userId = randomUUID();
const secondUserId = randomUUID();
const prefix = `resolution-${userId}`;
const cutoff = "2026-10-01T00:00:00.000Z";
const afterCutoff = "2026-10-02T00:00:00.000Z";
const ctf = contracts.conditionalTokens.toLowerCase();
const pm = contracts.positionManager.toLowerCase();
let tokenCounter = BigInt(`0x${userId.replaceAll("-", "")}`);
const nextToken = () => (++tokenCounter).toString();
type Venue = "polymarket" | "kalshi" | "limitless";

async function market(
  name: string,
  venue: Venue = "polymarket",
  outcome: string | null = "YES",
  observedAt: string | null = afterCutoff,
  scalar: number | null = null,
) {
  const id = `${venue}:${prefix}-${name}`;
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,
      resolved_outcome,resolved_outcome_pct,resolution_observed_at)
    values($1,$2,$1,$3,$1,'CLOSED','binary',$4,$5,$6)`,
    [id, venue, prefix, outcome, scalar, observedAt],
  );
  return id;
}

async function projection(
  token: string,
  marketId: string,
  venue: Venue,
  side: string,
) {
  await client.query(
    "insert into unified_tokens(token_id,market_id,venue,side) values($1,$2,$3,$4)",
    [token, marketId, venue, side],
  );
}

async function binding(
  token: string,
  marketId: string,
  contract: string,
  side: number,
) {
  const v2 = contract === pm;
  await client.query(
    `insert into polymarket_asset_bindings(chain_id,position_contract,asset_id,market_id,
      protocol_version,asset_kind,condition_id,outcome_index,neg_risk,exchange_address,
      order_domain_version,conditional_asset_type)
    values(137,$1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10)`,
    [
      contract,
      token,
      marketId,
      v2 ? "v2" : "v1",
      v2 ? "position_manager" : "ctf",
      `0x${"1".repeat(64)}`,
      side,
      contracts.exchangeV3.toLowerCase(),
      v2 ? "3" : "2",
      v2 ? "CONDITIONAL-V2" : "CONDITIONAL",
    ],
  );
}

async function position(
  token: string,
  options: {
    venue?: Venue;
    contract?: string;
    scope?: string;
    size?: number;
    hidden?: boolean;
    lastUpdatedAt?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into positions(id,user_id,wallet_address,venue,token_id,position_contract,
      position_scope,side,size,is_hidden,last_updated_at)
    values($1::uuid,$2,($1::uuid)::text,$3,$4,$5,$6,'LONG',$7,$8,$9)`,
    [
      id,
      userId,
      options.venue ?? "polymarket",
      token,
      options.contract ?? "",
      options.scope ?? "own",
      options.size ?? 5,
      options.hidden ?? false,
      options.lastUpdatedAt === undefined ? cutoff : options.lastUpdatedAt,
    ],
  );
  return id;
}

async function notified(positionId: string, owner = userId) {
  await client.query(
    "insert into notifications(user_id,type,title,body,dedupe_key) values($1,'position_resolved','fixture','fixture',$2)",
    [owner, `position_resolved:${positionId}`],
  );
}

try {
  await client.query("begin");
  const version = (
    await client.query(
      "select current_setting('server_version_num')::int as version",
    )
  ).rows[0]?.version;
  assert.ok(version >= 160000 && version < 170000, "run changed SQL on PG16");
  await client.query("insert into users(id,email) values($1,$2),($3,$4)", [
    userId,
    `${prefix}@example.com`,
    secondUserId,
    `${prefix}-other@example.com`,
  ]);
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'polymarket',$1,'fixture','ACTIVE')",
    [prefix],
  );

  // Same decimal token on two ledgers; the current projection is PM/NO, but
  // the old contextless CTF position must remain attached to its historical YES.
  const sharedToken = nextToken();
  const oldMarket = await market("historical", "polymarket", "NO");
  const newMarket = await market("current");
  await binding(sharedToken, oldMarket, ctf, 0);
  await binding(sharedToken, newMarket, pm, 1);
  await projection(sharedToken, newMarket, "polymarket", "NO");
  const legacyPosition = await position(sharedToken);
  const pmPosition = await position(sharedToken, { contract: pm });
  const explicitCtf = await position(sharedToken, {
    contract: ctf,
    lastUpdatedAt: null,
  });
  const explicitCtfUpdatedAt = (
    await client.query<{ updated_at: Date }>(
      "select updated_at from positions where id=$1",
      [explicitCtf],
    )
  ).rows[0]?.updated_at;
  assert.ok(explicitCtfUpdatedAt);

  const fallbackMarket = await market("fallback", "polymarket", "YES", cutoff);
  const fallbackToken = nextToken();
  await projection(fallbackToken, fallbackMarket, "polymarket", "YES");
  // A binding on the other ledger must not suppress projection fallback.
  await binding(fallbackToken, oldMarket, pm, 1);
  const fallbackPosition = await position(fallbackToken);
  await notified(fallbackPosition, secondUserId); // Another user's key is not ours.
  const hiddenPosition = await position(fallbackToken, { hidden: true });
  const zeroPosition = await position(fallbackToken, { size: 0 });
  const followedPosition = await position(fallbackToken, { scope: "followed" });
  const alreadyNotified = await position(fallbackToken);
  await notified(alreadyNotified);
  const missingPosition = await position(nextToken());

  const scalarMarket = await market("scalar", "kalshi", null, afterCutoff, 0);
  const scalarToken = nextToken();
  await projection(scalarToken, scalarMarket, "kalshi", "NO");
  const scalarPosition = await position(scalarToken, { venue: "kalshi" });
  const limitlessMarket = await market("limitless", "limitless");
  const limitlessToken = nextToken();
  await projection(limitlessToken, limitlessMarket, "limitless", "YES");
  const limitlessPosition = await position(limitlessToken, {
    venue: "limitless",
  });
  const wrongVenue = await position(limitlessToken);

  const bindingOnlyToken = nextToken();
  await binding(bindingOnlyToken, oldMarket, ctf, 1);
  const bindingOnlyPosition = await position(bindingOnlyToken);

  const excluded = [
    hiddenPosition,
    zeroPosition,
    followedPosition,
    alreadyNotified,
    missingPosition,
    wrongVenue,
  ];
  for (const [name, outcome, observedAt] of [
    ["old", "YES", "2026-09-30T23:59:59.999Z"],
    ["unknown", null, afterCutoff],
  ] as const) {
    const marketId = await market(name, "polymarket", outcome, observedAt);
    const token = nextToken();
    await projection(token, marketId, "polymarket", "YES");
    excluded.push(await position(token));

    // A newer projection cannot override an existing ledger binding, even
    // when only the projection's market would pass resolution/cutoff filters.
    const boundToken = nextToken();
    await binding(boundToken, marketId, ctf, 0);
    const replacedMarket = await market(`${name}-replacement`);
    await projection(boundToken, replacedMarket, "polymarket", "NO");
    excluded.push(await position(boundToken));
  }

  const expected = [
    legacyPosition,
    pmPosition,
    explicitCtf,
    fallbackPosition,
    scalarPosition,
    limitlessPosition,
    bindingOnlyPosition,
  ];
  const rows = await fetchPositionResolutionCandidates(client, cutoff, 1000);
  assert.deepEqual(rows.map((row) => row.id).sort(), [...expected].sort());
  assert.equal(
    new Set(rows.map((row) => row.id)).size,
    rows.length,
    "binding + projection never duplicate a position",
  );
  assert.ok(excluded.every((id) => !rows.some((row) => row.id === id)));
  assert.deepEqual(
    rows
      .filter((row) => [legacyPosition, explicitCtf].includes(row.id))
      .map((row) => [row.market_id, row.outcome_side, row.resolved_outcome]),
    [
      [oldMarket, "YES", "NO"],
      [oldMarket, "YES", "NO"],
    ],
  );
  assert.equal(rows.find((row) => row.id === pmPosition)?.outcome_side, "NO");
  assert.equal(rows.find((row) => row.id === pmPosition)?.market_id, newMarket);
  assert.equal(
    rows.find((row) => row.id === bindingOnlyPosition)?.market_id,
    oldMarket,
  );
  assert.equal(
    rows.find((row) => row.id === bindingOnlyPosition)?.outcome_side,
    "NO",
  );
  assert.equal(
    Number(rows.find((row) => row.id === scalarPosition)?.resolved_outcome_pct),
    0,
  );
  assert.equal(
    rows[0]?.id,
    fallbackPosition,
    "inclusive cutoff and chronological ordering",
  );
  assert.deepEqual(
    rows.slice(1).map((row) => row.id),
    rows
      .slice(1)
      .map((row) => row.id)
      .sort(),
    "stable UUID tie-break",
  );
  const snapshotAt = rows[0]?.position_snapshot_at;
  assert.ok(snapshotAt);
  assert.equal(new Date(snapshotAt).toISOString(), cutoff);
  const fallbackSnapshotAt = rows.find(
    (row) => row.id === explicitCtf,
  )?.position_snapshot_at;
  assert.ok(fallbackSnapshotAt);
  assert.equal(
    new Date(fallbackSnapshotAt).toISOString(),
    explicitCtfUpdatedAt.toISOString(),
  );

  const firstBatch = await fetchPositionResolutionCandidates(client, cutoff, 2);
  assert.deepEqual(
    firstBatch.map((row) => row.id),
    rows.slice(0, 2).map((row) => row.id),
  );
  for (const row of firstBatch) await notified(row.id);
  const secondBatch = await fetchPositionResolutionCandidates(
    client,
    cutoff,
    2,
  );
  assert.deepEqual(
    secondBatch.map((row) => row.id),
    rows.slice(2, 4).map((row) => row.id),
    "deduped rows cannot consume the next batch",
  );
  assert.equal(
    (
      await fetchPositionResolutionCandidates(
        client,
        "2100-01-01T00:00:00Z",
        1000,
      )
    ).length,
    0,
  );

  // Real SQL batch boundary, with already-notified rows preceding these.
  await client.query(
    `insert into positions(user_id,wallet_address,venue,token_id,side,size)
    select $1,$2 || fixture_row.ordinality,'limitless',$3,'LONG',5
    from generate_series(1,1050) fixture_row(ordinality)`,
    [userId, `${prefix}-batch-`, limitlessToken],
  );
  const fullBatch = await fetchPositionResolutionCandidates(
    client,
    cutoff,
    1000,
  );
  assert.equal(fullBatch.length, 1000);
  assert.equal(new Set(fullBatch.map((row) => row.id)).size, 1000);
  console.log(
    "[position-resolution-candidates] PG16 ledger precedence, V1/V2 collisions, venues, scalar zero, hidden/followed/empty, cutoff/order, dedupe/repeated batches and 1000 limit passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await db.end();
}
