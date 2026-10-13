// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import type { DbQuery } from "./db.js";
import { defaultSignalBotFollowthroughPolicy } from "./services/signal-bot-followthrough-policy.js";
import {
  buildFollowthroughPageQuery,
  loadFollowthroughPage,
} from "./services/signal-bot-followthrough-scan.js";
import { loadHolderDeliveryActivity } from "./services/holder-research-delivery-report.js";

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
    create temporary table signal_bot_messages (
      id uuid primary key, chat_id text, note_id uuid, thread_root_note_id uuid,
      message_kind text, telegram_message_id bigint, baseline_at timestamptz, sent_at timestamptz, metrics jsonb);
    create index on signal_bot_messages(message_kind,sent_at desc);
    create unique index on signal_bot_messages(chat_id,note_id,message_kind);
    create index on signal_bot_messages(note_id,sent_at desc);
    create index on signal_bot_messages(chat_id,thread_root_note_id,sent_at desc);
    create temporary table ai_notes (id uuid primary key,title text,direction text,metrics jsonb);
    create temporary table ai_note_targets (note_id uuid,target_kind text,is_primary boolean,target_id text,target_meta jsonb,target_rank int);
    create index on ai_note_targets(note_id,is_primary desc);
    create temporary table wallets (id uuid primary key,address text,chain text);
    create temporary table unified_events (id text primary key,title text,description text,metadata jsonb,status text,end_date timestamptz);
    create temporary table unified_markets (id text primary key,event_id text,title text,slug text,description text,outcomes text,venue text,
      best_bid numeric,best_ask numeric,last_price numeric,resolved_outcome text,resolved_outcome_pct numeric,
      metadata jsonb,status text,close_time timestamptz,expiration_time timestamptz);
    insert into ai_notes select ('00000000-0000-4000-8000-' || lpad(sample_id::text,12,'0'))::uuid,'Test','up','{}'
      from generate_series(1,107) sample_id;
    insert into unified_markets(id,venue,status,resolved_outcome) select 'm' || sample_id,'polymarket','CLOSED',
      case when sample_id < 101 then 'NO' else 'YES' end from generate_series(1,107) sample_id;
    insert into ai_note_targets select id,'market',true,'m' || right(id::text,12)::int,'{"side":"YES"}',0 from ai_notes;
    insert into signal_bot_messages select id,'chat',id,id,'initial',1,'2026-01-01',
      '2026-01-01'::timestamptz + right(id::text,12)::int * interval '1 microsecond','{"status":"sent"}' from ai_notes;
  `);
  const db: DbQuery = { query: client.query.bind(client) as DbQuery["query"] };
  const base = {
    lane: "terminal" as const,
    chatIds: ["chat"],
    policy: defaultSignalBotFollowthroughPolicy({}),
    cursor: null,
    now: new Date("2026-01-02"),
    preview: false,
    retryCooldownMs: 900000,
    editorialProfile: "x_editorial",
  };
  const first = await loadFollowthroughPage(db, base);
  assert.equal(first.length, 100);
  assert.equal(
    first.every((row) => row.resolved_outcome === "NO"),
    true,
  );
  assert.match(first[0].initial_sent_at, /000001/);
  const cursor = {
    sentAt: first[99].initial_sent_at,
    id: first[99].initial_id,
  };
  const second = await loadFollowthroughPage(db, { ...base, cursor });
  assert.equal(second.length, 7);
  assert.equal(second[0].market_id, "m101");
  assert.equal(
    second.every((row) => row.eligible),
    true,
  );
  assert.equal(
    (
      await loadFollowthroughPage(db, {
        ...base,
        cursor: {
          sentAt: second[6].initial_sent_at,
          id: second[6].initial_id,
        },
      })
    ).length,
    0,
  );

  // Equal timestamps, detached targets, non-deliveries and already-sent results
  // must retain their source cursor and cannot inflate the source-page limit.
  await client.query("update signal_bot_messages set sent_at='2026-01-01'");
  await client.query("delete from ai_note_targets where target_id='m1'");
  await client.query(
    'update signal_bot_messages set telegram_message_id=null,metrics=\'{"status":"skipped"}\' where id=$1',
    [first[1].initial_id],
  );
  await client.query(
    `insert into signal_bot_messages select 'ffffffff-0000-4000-8000-000000000001',chat_id,note_id,thread_root_note_id,
    'resolved_win',2,baseline_at,'2026-01-01','{"status":"sent"}' from signal_bot_messages where id=$1`,
    [first[2].initial_id],
  );
  const equal = await loadFollowthroughPage(db, base);
  assert.equal(equal.length, 100);
  assert.deepEqual(
    equal.slice(0, 3).map((row) => row.eligible),
    [false, false, false],
  );
  assert.equal(
    (
      await loadFollowthroughPage(db, {
        ...base,
        cursor: { sentAt: equal[99].initial_sent_at, id: equal[99].initial_id },
      })
    )[0].market_id,
    "m101",
  );
  assert.equal(
    (
      await loadFollowthroughPage(db, {
        ...base,
        policy: {
          ...base.policy,
          terminalInitialCutoff: "2026-01-01T01:00:00Z",
        },
      })
    ).length,
    0,
  );

  // Delivery target can be a different market from the source note.
  await client.query(
    `update signal_bot_messages set metrics='{"status":"sent","delivery":{"view":{"target":{"marketId":"m107","side":"NO","price":0.56}}}}' where id=$1`,
    [first[3].initial_id],
  );
  const alternate = await loadFollowthroughPage(db, base);
  assert.equal(alternate[3].market_id, "m107");
  await client.query(
    "update unified_markets set status='ACTIVE',resolved_outcome=null where id='m105'",
  );
  const stats = await loadFollowthroughPage(db, {
    ...base,
    lane: "stats",
    cursor: { sentAt: equal[99].initial_sent_at, id: equal[99].initial_id },
  });
  assert.deepEqual(
    stats.filter((row) => row.eligible).map((row) => row.market_id),
    ["m105"],
  );
  await client.query(
    "update unified_markets set status='CLOSED',resolved_outcome='YES' where id='m105'",
  );
  assert.equal(
    (
      await loadFollowthroughPage(db, {
        ...base,
        cursor: { sentAt: equal[99].initial_sent_at, id: equal[99].initial_id },
      })
    ).find((row) => row.market_id === "m105")?.eligible,
    true,
  );

  await client.query(
    `insert into signal_bot_messages select 'ffffffff-0000-4000-8000-000000000002',chat_id,
    'eeeeeeee-0000-4000-8000-000000000001',thread_root_note_id,
    'research_update',3,baseline_at,'2026-01-01','{"status":"sent"}' from signal_bot_messages where id=$1`,
    [first[2].initial_id],
  );
  const activity = await loadHolderDeliveryActivity(db, {
    noteIds: [
      ...first.map((row) => row.thread_root_note_id),
      "eeeeeeee-0000-4000-8000-000000000001",
    ],
    from: new Date("2025-12-01"),
    to: base.now,
  });
  assert.equal(
    activity.rows.find((row) => row.kind === "initial" && row.status === "sent")
      ?.deliveries,
    99,
  );
  assert.equal(
    activity.rows.find((row) => row.kind === "resolved_win")?.deliveries,
    1,
  );
  assert.equal(
    activity.rows.find((row) => row.kind === "research_update")?.deliveries,
    1,
  );
  const query = buildFollowthroughPageQuery(base);
  const plan = await client.query(
    `explain (analyze,buffers,format json) ${query.sql}`,
    query.params,
  );
  assert.ok(plan.rows[0]["QUERY PLAN"][0]["Execution Time"] >= 0);
  console.log(
    "[signal-bot-followthrough-integration-tests] passed: bounded pages, cursor precision/ties, cutoff, skipped roots, alternate target, late resolution, delivery activity",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
