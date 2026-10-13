// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import type { DbQuery } from "./db.js";
import {
  loadHolderPublicHistory,
  publicHistoryBaselineMatches,
} from "./services/holder-research-publication-history.js";
import { loadSignalBotLatestPublicThesis } from "./services/signal-bot-opposing-context.js";
import { loadSignalBotNotes } from "./services/signal-bot.js";
import {
  publicSnapshotPositions,
  loadHolderComparisonPositions,
} from "./services/holder-research-publication-history.js";
import { HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON } from "./services/signal-publication-contract.js";
import { loadHolderSideChronologyReport } from "./services/holder-side-chronology-report.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
    create temporary table ai_notes(id uuid primary key,source_id text,note_type text,producer_type text,status text,direction text,title text,description text,metrics jsonb,lineage jsonb,model_meta jsonb);
    create temporary table ai_note_targets(note_id uuid,target_id text,target_kind text,is_primary boolean);
    create index on ai_note_targets(target_kind,target_id);
    create temporary table signal_bot_messages(id uuid primary key,note_id uuid,chat_id text,message_kind text,telegram_message_id bigint,sent_at timestamptz,metrics jsonb);
    create index on signal_bot_messages(note_id,sent_at desc);
  `);
  for (let n = 1; n <= 8; n++) {
    await client.query(
      `insert into ai_notes values($1,'polymarket:colts','signal','holder_research',$2,$3,$4,'Thesis','{}','{}','{}')`,
      [
        id(n),
        n === 1 ? "superseded" : "active",
        n % 2 === 1 ? "up" : "down",
        `Note ${n}`,
      ],
    );
    await client.query(
      `insert into ai_note_targets values($1,'polymarket:colts','market',true)`,
      [id(n)],
    );
    if (n === 6) continue; // saved, never delivered
    await client.query(
      `insert into signal_bot_messages values($1,$2,'chat-a',$3,$4,$5,$6)`,
      [
        id(100 + n),
        id(n),
        n === 1 ? "initial" : "research_update",
        n === 7 ? null : n,
        `2026-10-0${n}T12:00:00Z`,
        JSON.stringify(
          n === 7
            ? { status: "sending" }
            : n === 8
              ? { contentProfile: "x_editorial_draft_v1" }
              : { status: "sent" },
        ),
      ],
    );
  }
  // Delayed second recipient must NOT reorder the public note chronology.
  await client.query(
    `insert into signal_bot_messages values($1,$2,'chat-b','initial',201,'2026-10-09','{}')`,
    [id(201), id(1)],
  );
  // Public source thesis survives a redirected CTA; its sibling quote must not.
  await client.query(
    `insert into signal_bot_messages values($1,$2,'redirected','initial',301,'2026-10-05T10:00:00Z','{"publicationSnapshotV1":{"marketId":"sibling","side":"NO"},"delivery":{"view":{"target":{"marketId":"sibling","side":"NO"}}}}')`,
    [id(301), id(5)],
  );
  const db: DbQuery = { query: client.query.bind(client) as DbQuery["query"] };
  const asOf = new Date("2026-10-10");
  const histories = await loadHolderPublicHistory(
    db,
    ["polymarket:colts", "missing", "polymarket:colts"],
    asOf,
  );
  assert.equal(histories.size, 2);
  assert.deepEqual(
    histories.get("polymarket:colts")?.items.map((note) => note.noteId),
    [5, 4, 3, 2].map(id),
  );
  assert.equal(histories.get("missing")?.items.length, 0);
  const history = histories.get("polymarket:colts");
  assert.ok(history);
  const last = await loadSignalBotLatestPublicThesis({
    db,
    chatId: "chat-a",
    marketId: "polymarket:colts",
    noteId: id(6),
  });
  assert.equal(last?.noteId, id(5));
  assert.equal(last?.side, "YES");
  assert.equal(last?.messageId, 5);
  assert.equal(
    (
      await loadSignalBotLatestPublicThesis({
        db,
        chatId: "chat-b",
        marketId: "polymarket:colts",
        noteId: id(6),
      })
    )?.noteId,
    id(1),
  );
  assert.equal(
    await loadSignalBotLatestPublicThesis({
      db,
      chatId: "unseen",
      marketId: "polymarket:colts",
      noteId: id(6),
    }),
    null,
  );
  const redirected = await loadSignalBotLatestPublicThesis({
    db,
    chatId: "redirected",
    marketId: "polymarket:colts",
    noteId: id(6),
  });
  assert.equal(redirected?.side, "YES");
  assert.equal(redirected?.priceSnapshot, null);
  assert.equal(history.items[0]?.priceSnapshot, null);
  // Event siblings, future deliveries, and unsent rows cannot become baseline.
  assert.deepEqual(
    (
      await loadHolderPublicHistory(
        db,
        ["polymarket:colts"],
        new Date("2026-10-03T23:00:00Z"),
      )
    )
      .get("polymarket:colts")
      ?.items.map((n) => n.noteId),
    [3, 2, 1].map(id),
  );
  assert.equal(
    (await loadHolderPublicHistory(db, ["polymarket:colts"], asOf, id(5))).get(
      "polymarket:colts",
    )?.items[0].noteId,
    id(4),
  );
  await client.query(
    `insert into signal_bot_messages values($1,$2,'chat-a','research_update',6,'2026-10-09T12:00:00Z','{"status":"sent"}')`,
    [id(206), id(6)],
  );
  const refreshed = (
    await loadHolderPublicHistory(db, ["polymarket:colts"], asOf)
  ).get("polymarket:colts");
  assert.ok(refreshed);
  assert.equal(publicHistoryBaselineMatches(history, refreshed), false);
  assert.equal(refreshed.items[0].noteId, id(6));
  // Execute the real pending-note reader: merely testing a hand-built note
  // would miss a forgotten decision_snapshot projection in production SQL.
  await client.query(`
    alter table ai_notes add column note_key text, add column rationale text, add column producer_run_id text, add column confidence numeric, add column created_at timestamptz default '2026-10-01';
    alter table ai_note_targets add column target_meta jsonb, add column target_rank int;
    create temporary table unified_markets(id text primary key,event_id text,venue text,title text,slug text,description text,metadata jsonb,category text,close_time timestamptz,expiration_time timestamptz,outcomes text,best_bid numeric,best_ask numeric,last_price numeric);
    create temporary table unified_events(id text primary key,title text,description text,category text,series_key text,series_title text,metadata jsonb);
    create temporary table wallets(id uuid primary key,address text,chain text);
    insert into unified_markets(id,venue,title,category) values('polymarket:colts','polymarket','NFL Colts vs Commanders','Sports');
  `);
  await client.query(
    `update ai_notes set metrics=$2::jsonb,lineage=$3::jsonb where id=$1`,
    [
      id(6),
      HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON,
      JSON.stringify({
        decision_snapshot: {
          publicComparisonPositions: [
            {
              walletId: "holder",
              side: "NO",
              positionShares: 40000,
              observedAt: "2026-10-01T00:00:00Z",
              currentPrice: 0.5,
              strong: true,
            },
          ],
        },
      }),
    ],
  );
  const loaded = await loadSignalBotNotes(db, {
    noteId: id(6),
    afterCreatedAt: "2026-01-01",
    afterId: id(0),
    limit: 1,
  });
  assert.equal(loaded.length, 1);
  assert.equal(
    publicSnapshotPositions(loaded[0].decisionSnapshot)[0]?.positionShares,
    40000,
  );
  await client.query(
    `create temporary table wallet_position_snapshots(wallet_id uuid,venue text,market_id text,outcome_side text,shares numeric,price numeric,snapshot_at timestamptz,unique(wallet_id,venue,market_id,outcome_side,snapshot_at));`,
  );
  await client.query(
    `insert into wallet_position_snapshots values($1,'polymarket','polymarket:colts','YES',100000,.5,'2026-10-01'),($1,'polymarket','polymarket:colts','YES',0,.6,'2026-10-03'),($1,'polymarket','other','YES',100000,.9,'2026-10-04')`,
    [id(900)],
  );
  const key = {
    walletId: id(900),
    venue: "polymarket",
    marketId: "polymarket:colts",
    side: "YES" as const,
  };
  const quantities = await loadHolderComparisonPositions(
    db,
    [key, key, { ...key, side: "NO" }],
    new Date("2026-10-05"),
  );
  assert.equal(quantities.size, 1);
  assert.equal([...quantities.values()][0].positionShares, 0);
  assert.equal(
    [
      ...(
        await loadHolderComparisonPositions(db, [key], new Date("2026-10-02"))
      ).values(),
    ][0].positionShares,
    100000,
  );
  await client.query(`alter table signal_bot_messages add column thread_root_note_id uuid;
    update signal_bot_messages set thread_root_note_id=note_id;
    alter table unified_markets add column resolved_outcome text;
    update unified_markets set resolved_outcome='YES';`);
  const chronologyReport = await loadHolderSideChronologyReport(db, {
    noteIds: [1, 2, 3, 4, 5, 6, 7, 8].map(id),
    from: new Date("2026-10-01"),
    to: asOf,
  });
  assert.equal(chronologyReport.notes, 6);
  assert.equal(chronologyReport.sideChanges, 5);
  assert.equal(chronologyReport.returns, 4);
  assert.equal(chronologyReport.groups[0].averageRoi, null);
  const redirectedRow = chronologyReport.timeline.find(
    (row) => row.noteId === id(5),
  );
  assert.equal(redirectedRow?.marketId, "polymarket:colts");
  assert.equal(redirectedRow?.deliveryMarketId, "sibling");
  assert.equal(redirectedRow?.side, "YES");
  assert.equal(redirectedRow?.roi, null);
  console.log(
    "[holder-publication-history-integration-tests] PostgreSQL 16 passed",
  );
} finally {
  await client.query("rollback").catch(() => undefined);
  client.release();
  await pool.end();
}
