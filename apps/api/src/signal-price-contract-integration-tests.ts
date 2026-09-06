// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import type { DbQuery } from "./db.js";
import { loadHolderResearchPriceBaselines } from "./services/holder-research-price-movement.js";
import { buildSignalPublicationSnapshot } from "./services/signal-publication-snapshot.js";
import {
  reserveSignalBotMessageDelivery,
  beginSignalBotMessageDelivery,
  finishSignalBotMessageDelivery,
} from "./services/signal-bot-message-delivery-ledger.js";
import { enqueueXEditorialMediaJob } from "./services/signal-bot-editorial-media-jobs.js";
import { auditHolderResearchSignalPerformance } from "./services/holder-research-performance.js";

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
  // Session-local fixtures: no production tables, no full migration or history scan.
  await client.query(`
    create temporary table unified_market_tokens (market_id text, token_id text, outcome_side text, updated_at timestamptz);
    create temporary table unified_token_change_24h (token_id text primary key, avg_mid_24h numeric, bucket_24h timestamptz);
    create temporary table unified_events (id text primary key, title text, category text, status text, end_date timestamptz);
    create temporary table unified_markets (id text primary key, event_id text, venue text, status text, title text, category text,
      close_time timestamptz, expiration_time timestamptz, best_bid numeric, best_ask numeric, last_price numeric,
      resolved_outcome text, resolved_outcome_pct numeric, token_yes text, token_no text, clob_token_ids text, metadata jsonb);
    create temporary table ai_notes (id uuid primary key, note_type text, producer_type text, status text, direction text, confidence numeric,
      created_at timestamptz, metrics jsonb, model_meta jsonb, lineage jsonb, source_id text);
    create temporary table ai_note_targets (note_id uuid, target_kind text, is_primary boolean, target_id text, target_meta jsonb);
    create temporary table signal_bot_messages (id uuid primary key, chat_id text, note_id uuid, thread_root_note_id uuid, message_kind text,
      telegram_message_id bigint, reply_to_message_id bigint, baseline_at timestamptz, sent_at timestamptz, metrics jsonb,
      unique(chat_id, note_id, message_kind));
    create temporary table signal_bot_editorial_media_jobs (id uuid default gen_random_uuid(), signal_bot_message_id uuid unique,
      delivery_attempt_id uuid, chat_id text, status text, payload jsonb, max_attempts integer, available_at timestamptz, updated_at timestamptz,
      result jsonb, attempt_count integer default 0, lease_owner text, lease_expires_at timestamptz);
    insert into unified_market_tokens values ('m','old','YES','2026-01-01'), ('m','yes','YES','2026-09-01'), ('m','no','NO','2026-09-01');
    insert into unified_token_change_24h values ('old',0.9,'2026-09-05'), ('yes',0.2,'2026-09-05'), ('no',0.8,'2026-09-05');
    insert into unified_events values ('e','Event',null,'ACTIVE',null);
    insert into unified_markets (id,event_id,venue,status,title,resolved_outcome) values ('m','e','polymarket','RESOLVED','Market','YES'), ('alt','e','limitless','RESOLVED','Alternative','NO');
  `);
  const baselines = await loadHolderResearchPriceBaselines(client, [
    "m",
    "absent",
  ]);
  assert.equal(baselines.get("m")?.yes, 0.2);
  assert.equal(baselines.get("m")?.no, 0.8);
  assert.equal(baselines.get("absent")?.yes, null);
  const db: DbQuery = { query: client.query.bind(client) as DbQuery["query"] };
  const now = new Date();
  const snapshot = buildSignalPublicationSnapshot({
    marketId: "m",
    venue: "polymarket",
    side: "YES",
    priceSnapshot: null,
    nativeQuote: { ask: 0.6, bid: 0.58, asOf: now.toISOString() },
    displayPrice: 0.59,
    now,
  });
  const changed = { ...snapshot, ask: 0.9 };
  async function note() {
    const id = randomUUID();
    await client.query(
      "insert into ai_notes values ($1,'signal','holder_research','active','up',0.8,$2,'{}','{}','{}','m')",
      [id, now],
    );
    await client.query(
      "insert into ai_note_targets values ($1,'market',true,'m','{\"side\":\"YES\"}')",
      [id],
    );
    return id;
  }
  async function reserve(noteId: string, quote = snapshot) {
    const result = await reserveSignalBotMessageDelivery({
      db,
      noteId,
      threadRootNoteId: noteId,
      chatId: "test",
      messageKind: "initial",
      baselineAt: now.toISOString(),
      replyToMessageId: null,
      now,
      baseMetrics: { publicationSnapshotV1: quote },
    });
    assert.equal(result.status, "acquired");
    if (result.status !== "acquired") throw new Error("reservation failed");
    return result;
  }
  const retryId = await note();
  const first = await reserve(retryId);
  await beginSignalBotMessageDelivery({
    db,
    ...first,
    now,
    metrics: { publicationSnapshotV1: changed },
  });
  await finishSignalBotMessageDelivery({
    db,
    ...first,
    now,
    expectedStatus: "sending",
    status: "retry",
    nextAttemptAt: now,
    metrics: { publicationSnapshotV1: changed },
  });
  const retry = await reserve(retryId, changed);
  await beginSignalBotMessageDelivery({ db, ...retry, now });
  await finishSignalBotMessageDelivery({
    db,
    ...retry,
    now,
    expectedStatus: "sending",
    status: "sent",
    messageId: 1,
  });
  assert.equal(
    (
      await client.query(
        "select metrics from signal_bot_messages where id=$1",
        [retry.deliveryRef],
      )
    ).rows[0].metrics.publicationSnapshotV1.ask,
    0.6,
  );

  const mediaId = await note();
  const media = await reserve(mediaId);
  assert.equal(
    await enqueueXEditorialMediaJob({
      db,
      ...media,
      now,
      chatId: "test",
      captionMarkdownV2: "test",
      captureUrl: "https://example.com/preview",
      profiles: ["mobile"],
    }),
    true,
  );
  const delayed = new Date(now.getTime() + 11 * 60_000);
  await beginSignalBotMessageDelivery({
    db,
    ...media,
    now: delayed,
    expectedStatus: "queued",
  });
  await finishSignalBotMessageDelivery({
    db,
    ...media,
    now: delayed,
    expectedStatus: "sending",
    status: "sent",
    messageId: 2,
  });
  assert.equal(
    (
      await client.query(
        "select metrics from signal_bot_messages where id=$1",
        [media.deliveryRef],
      )
    ).rows[0].metrics.publicationSnapshotV1.ask,
    0.6,
  );

  async function delivered(metrics: unknown) {
    const id = await note();
    await client.query(
      "insert into signal_bot_messages values ($1,'test',$2,$2,'initial',99,null,$3,$3,$4)",
      [
        randomUUID(),
        id,
        now,
        JSON.stringify({ status: "sent", ...(metrics as object) }),
      ],
    );
    return id;
  }
  const editorialId = await delivered({
    contentProfile: "x_editorial_draft_v1",
    publicationSnapshotV1: snapshot,
  });
  const legacyId = await delivered({
    delivery: { view: { target: { marketId: "m", side: "YES", price: 0.59 } } },
  });
  const missingId = await delivered({});
  const malformedId = await delivered({
    delivery: {
      view: { target: { marketId: "m", side: "YES", price: "invalid" } },
    },
  });
  const alternateId = await delivered({
    publicationSnapshotV1: {
      ...snapshot,
      marketId: "alt",
      venue: "limitless",
      side: "NO",
      ask: 0.7,
    },
  });
  const result = await auditHolderResearchSignalPerformance(db, {
    lookbackHours: 24,
    limit: 100,
    deliveredInitialOnly: true,
    persist: false,
  });
  assert.equal(result.considered, 7);
  assert.equal(result.missingEntry, 3);
  assert.equal(
    result.items.find((item) => item.noteId === editorialId)?.entryPrice,
    0.6,
  );
  assert.equal(
    result.items.find((item) => item.noteId === legacyId)?.entryQuality,
    "legacy_display",
  );
  assert.equal(
    result.items.find((item) => item.noteId === missingId)?.entryPrice,
    null,
  );
  assert.equal(
    result.items.find((item) => item.noteId === malformedId)?.entryPrice,
    null,
  );
  assert.equal(
    result.items.find((item) => item.noteId === mediaId)?.entryPrice,
    null,
  );
  assert.equal(
    result.items.find((item) => item.noteId === alternateId)?.marketId,
    "alt",
  );
  assert.equal(
    result.items.find((item) => item.noteId === alternateId)?.signalSide,
    "NO",
  );
  console.log(
    "[signal-price-contract-integration-tests] PostgreSQL 16: baseline, retry, media, publication coverage and audit passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
