// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import type { DbQuery } from "./db.js";
import { auditHolderResearchSignalPerformance } from "./services/holder-research-performance.js";
import { buildSignalBotStatsReport } from "./services/signal-bot-stats-report.js";
import { loadEventPublications } from "./services/holder-research-event-publications.js";
import { buildSignalPublicationSnapshot } from "./services/signal-publication-snapshot.js";
import { loadHolderResearchObservationCalibration } from "./services/holder-research-observations.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await client.query("begin");
  await client.query(`
    create temporary table unified_events (id text primary key,title text,category text,status text,end_date timestamptz);
    create temporary table unified_markets (id text primary key,event_id text,venue text,status text,title text,category text,
      close_time timestamptz,expiration_time timestamptz,best_bid numeric,best_ask numeric,last_price numeric,
      resolved_outcome text,resolved_outcome_pct numeric,token_yes text,token_no text,clob_token_ids text,metadata jsonb);
    create temporary table unified_market_tokens (market_id text,token_id text,outcome_side text);
    create temporary table ai_notes (id uuid primary key,note_type text,producer_type text,status text,direction text,confidence numeric,
      created_at timestamptz,metrics jsonb,model_meta jsonb,lineage jsonb,source_id text,title text,description text);
    create temporary table ai_note_targets (note_id uuid,target_kind text,is_primary boolean,target_id text,target_meta jsonb,created_at timestamptz);
    create temporary table signal_bot_messages (id uuid primary key,note_id uuid,message_kind text,sent_at timestamptz,metrics jsonb);
    create temporary table holder_research_candidate_observations (id int,thesis_key text,observed_at timestamptz,source_market_id text,
      side text,candidate_bucket text,feature_version smallint,decision_features jsonb);
    create index on signal_bot_messages(message_kind,sent_at);
    create index on signal_bot_messages(note_id,sent_at);
    create index on ai_note_targets(target_kind,target_id,created_at desc);
    create index on ai_note_targets(note_id,is_primary desc);
    insert into unified_events values ('event','Test',null,'ACTIVE',null);
    insert into unified_markets(id,event_id,venue,status,title,best_bid,best_ask,last_price,resolved_outcome,resolved_outcome_pct) values
      ('win','event','polymarket','RESOLVED','Win',0,0,0,'YES',null),
      ('loss','event','polymarket','RESOLVED','Loss',1,1,1,'NO',null),
      ('fraction','event','polymarket','RESOLVED','Fraction',1,1,1,null,2500),
      ('open','event','polymarket','ACTIVE','Open',0.5,0.5,0.5,null,null),
      ('zero','event','polymarket','ACTIVE','Zero',0,0,0,null,null),
      ('pending','event','polymarket','PROPOSED','Proposed',1,1,1,null,null);
  `);
  const db: DbQuery = { query: client.query.bind(client) as DbQuery["query"] };
  const asOf = new Date("2026-10-07T15:00:00Z");
  const sentAt = new Date("2026-10-07T14:00:00Z");
  async function note(
    marketId: string,
    side = "YES",
    createdAt: Date = sentAt,
    status = "active",
  ) {
    const id = randomUUID();
    await client.query(
      `insert into ai_notes values ($1,'signal','holder_research',$5,$3,0.8,$4,
      '{"sideCopy":{"winCondition":"Exact official payout condition"}}','{}','{}',$2,'Publication','Published summary')`,
      [id, marketId, side === "YES" ? "up" : "down", createdAt, status],
    );
    await client.query(
      `insert into ai_note_targets values ($1,'market',true,$2,$3,$4),($1,'event',false,'event','{}',$4),($1,'wallet',false,'holder','{}',$4)`,
      [id, marketId, JSON.stringify({ side }), createdAt],
    );
    return id;
  }
  async function delivery(
    id: string,
    marketId: string,
    side = "YES",
    at: Date = sentAt,
    price: number | null = 0.5,
    extra: object = {},
  ) {
    await client.query(
      `insert into signal_bot_messages values ($1,$2,'initial',$3,$4)`,
      [
        randomUUID(),
        id,
        at,
        JSON.stringify({
          status: "sent",
          delivery: { view: { target: { marketId, side, price } } },
          ...extra,
        }),
      ],
    );
  }
  const outside = await note("win");
  await delivery(outside, "win", "YES", new Date("2026-10-05T14:00:00Z"));
  await delivery(outside, "win"); // new recipient never moves the cohort
  const oldNote = await note("win", "YES", new Date("2026-09-01T14:00:00Z"));
  await delivery(oldNote, "win"); // old creation, genuinely new publication
  const multi = await note("win");
  await delivery(multi, "win");
  await delivery(multi, "win", "YES", new Date(sentAt.getTime() + 1000), 0.9);
  await delivery(multi, "loss", "NO"); // same note, independently delivered target
  // Future target deliveries must not consume the pre-window LIMIT in a replay.
  await delivery(multi, "fraction", "YES", new Date("2026-10-08T14:00:00Z"));
  await delivery(multi, "pending", "YES", new Date("2026-10-08T15:00:00Z"));
  const stale = await note("win");
  const staleSnapshot = buildSignalPublicationSnapshot({
    marketId: "win",
    venue: "polymarket",
    side: "YES",
    priceSnapshot: null,
    nativeQuote: {
      ask: 0.5,
      bid: 0.5,
      asOf: new Date(sentAt.getTime() - 11 * 60_000).toISOString(),
    },
    displayPrice: 0.5,
    now: sentAt,
  });
  await delivery(stale, "win", "YES", sentAt, 0.5, {
    publicationSnapshotV1: staleSnapshot,
  });
  await delivery(stale, "win", "YES", new Date(sentAt.getTime() + 2000), 0.9);
  const noEntry = await note("loss");
  await delivery(noEntry, "loss", "YES", sentAt, null);
  for (const [marketId, side] of [
    ["fraction", "YES"],
    ["fraction", "NO"],
    ["open", "YES"],
    ["zero", "YES"],
    ["pending", "YES"],
  ]) {
    await delivery(await note(marketId, side), marketId, side);
  }
  const updateOnly = await note("win");
  await client.query(
    "insert into signal_bot_messages values ($1,$2,'research_update',$3,'{}')",
    [randomUUID(), updateOnly, sentAt],
  );
  const updateWithInitialDelivery = await note("win");
  await client.query(
    'update ai_notes set lineage=\'{"revision_kind":"research_update"}\' where id=$1',
    [updateWithInitialDelivery],
  );
  await delivery(updateWithInitialDelivery, "win");
  const result = await auditHolderResearchSignalPerformance(db, {
    asOf,
    lookbackHours: 24,
    limit: 500,
    deliveredInitialOnly: true,
    persist: false,
  });
  assert.equal(result.items.length, 10);
  assert.equal(new Set(result.items.map((item) => item.tradeKey)).size, 10);
  assert.equal(
    result.items.some(
      (item) => item.noteId === outside || item.noteId === updateOnly,
    ),
    false,
  );
  assert.equal(
    result.items.some((item) => item.noteId === updateWithInitialDelivery),
    false,
  );
  const one = await auditHolderResearchSignalPerformance(db, {
    asOf,
    lookbackHours: 24,
    limit: 1,
    deliveredInitialOnly: true,
    persist: false,
  });
  assert.equal(one.items.length, 1);
  assert.equal(one.truncated, true);
  assert.equal(
    result.items.find((item) => item.noteId === oldNote)?.createdAt,
    "2026-09-01T14:00:00.000Z",
  );
  assert.equal(
    result.items.find(
      (item) => item.noteId === multi && item.marketId === "win",
    )?.entryPrice,
    0.5,
  );
  assert.equal(
    result.items.find((item) => item.noteId === stale)?.entryPrice,
    null,
  );
  assert.equal(
    result.items.find((item) => item.noteId === noEntry)?.outcome,
    "wrong",
  );
  assert.equal(
    result.items.find((item) => item.noteId === noEntry)?.pnlPerDollar,
    null,
  );
  assert.equal(
    result.items
      .filter((item) => item.marketId === "fraction")
      .every((item) => item.outcome === "unknown" && item.pnlPerDollar != null),
    true,
  );
  assert.equal(
    result.items.find((item) => item.marketId === "zero")?.state,
    "open",
  );
  assert.equal(
    result.items.find((item) => item.marketId === "zero")?.pnlPerDollar,
    -1,
  );
  assert.equal(
    result.items.find((item) => item.marketId === "pending")?.state,
    "unknown",
  );
  assert.equal(
    result.items.find((item) => item.marketId === "pending")?.pnlPerDollar,
    null,
  );
  const returns = result.items.flatMap((item) =>
    item.pnlPerDollar == null ? [] : [item.pnlPerDollar],
  );
  await client.query(`insert into holder_research_candidate_observations values
    (1,'fraction:YES',now(),'fraction','YES','sharp_side',2,'{"gates":{"publishEligible":true},"market":{"entryPrice":0.5,"hoursToClose":24,"priceCheckedAt":"2026-10-07"}}'),
    (2,'fraction:NO',now(),'fraction','NO','sharp_side',2,'{"gates":{"publishEligible":true},"market":{"entryPrice":0.5,"hoursToClose":24,"priceCheckedAt":"2026-10-07"}}'),
    (3,'zero:YES',now(),'zero','YES','sharp_side',2,'{"gates":{"publishEligible":true},"market":{"entryPrice":0.5,"hoursToClose":24,"priceCheckedAt":"2026-10-07"}}')`);
  const calibration = await loadHolderResearchObservationCalibration(client);
  assert.equal(calibration.samples, 2);
  assert.equal(calibration.overall.fractionalSamples, 2);
  assert.equal(calibration.overall.actualWins, 0);
  assert.equal(calibration.overall.meanRoi, 0);
  assert.equal(returns.length, 7);
  assert.equal(
    result.aggregates.overall.averageRoi,
    returns.reduce((sum, value) => sum + value, 0) / returns.length,
  );
  const report = buildSignalBotStatsReport({
    buyAmountUsd: 10,
    period: "24h",
    detail: true,
    result,
  });
  assert.match(report, /Coverage: 7\/10/);
  assert.match(report, /Sensitivity: buying 1 unpriced confirmed losing/);
  assert.match(report, /Settled PnL/);
  assert.match(report, /Events: 1/);
  const gap = {
    ...result,
    aggregates: {
      ...result.aggregates,
      overall: {
        ...result.aggregates.overall,
        positive: 0,
        negative: 0,
        flat: 0,
        totalPnlPerDollar: 0,
      },
    },
  };
  assert.match(
    buildSignalBotStatsReport({ buyAmountUsd: 10, period: "24h", result: gap }),
    /waiting for price data/,
  );
  const flat = {
    ...result,
    aggregates: {
      ...result.aggregates,
      overall: {
        ...result.aggregates.overall,
        positive: 0,
        negative: 0,
        flat: 1,
        totalPnlPerDollar: 0,
      },
    },
  };
  assert.match(
    buildSignalBotStatsReport({
      buyAmountUsd: 10,
      period: "24h",
      result: flat,
    }),
    /\$0\.00 \(0\.0%\)/,
  );
  await client.query(
    "update unified_markets set resolved_outcome='YES' where id='pending'",
  );
  const confirmed = await auditHolderResearchSignalPerformance(db, {
    asOf,
    lookbackHours: 24,
    limit: 500,
    deliveredInitialOnly: true,
    persist: false,
  });
  assert.equal(
    confirmed.items.find((item) => item.marketId === "pending")?.outcome,
    "correct",
  );
  assert.equal(
    confirmed.items.find((item) => item.marketId === "pending")?.pnlPerDollar,
    1,
  );
  const history = await loadEventPublications(db, ["event", "empty"], asOf);
  assert.ok(history.length <= 7);
  assert.equal(
    history.every(
      (row) => row.win_condition && row.holder_ids.includes("holder"),
    ),
    true,
  );
  assert.equal(
    history.filter((row) => row.market_id === "win" && row.side === "YES")
      .length,
    1,
  );
  // Force indexed source pagination and a visible 501st result without real data.
  for (let i = 0; i < 505; i++) {
    const id = await note("open");
    await delivery(id, "open");
    if (i < 250)
      await delivery(id, "open", "YES", new Date(sentAt.getTime() + 1000));
  }
  await client.query(
    "analyze signal_bot_messages; analyze ai_notes; analyze ai_note_targets",
  );
  const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const traced: DbQuery = {
    query: (async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return client.query(sql, params);
    }) as DbQuery["query"],
  };
  const capped = await auditHolderResearchSignalPerformance(traced, {
    asOf,
    lookbackHours: 24,
    limit: 500,
    deliveredInitialOnly: true,
    persist: false,
  });
  assert.equal(capped.items.length, 500);
  assert.equal(capped.truncated, true);
  const sourcePages = queries.filter((query) =>
    query.sql.includes("as cursor_at"),
  );
  assert.ok(sourcePages.length >= 2);
  for (const query of sourcePages) {
    const plan = await client.query(
      `explain (analyze,buffers,format json) ${query.sql}`,
      query.params as unknown[],
    );
    assert.ok(plan.rows[0]["QUERY PLAN"][0].Plan);
  }
  const last = sourcePages[sourcePages.length - 1];
  const tailParams = [...(last.params ?? [])];
  tailParams[2] = "2026-10-06T15:00:00Z";
  tailParams[3] = randomUUID();
  await client.query(`explain (analyze,buffers) ${last.sql}`, tailParams);
  console.log(
    "[holder-research-accounting-integration-tests] PG16 cohort, frozen entry, canonical/fractional payouts, coverage, 500+sentinel, resumed/empty page plans passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
