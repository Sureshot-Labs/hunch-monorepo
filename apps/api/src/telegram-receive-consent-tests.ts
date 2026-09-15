import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  classifyUnconsentedTelegramReceipts,
  finalizeFundingReceiveCanonicalEventAllocation,
} from "./funding/persistence/funding-receive-session-repository.js";
import { classifyTelegramFundingOpenReceipts } from "./services/telegram-funding-sessions.js";
import {
  buildTelegramFundingActiveElsewhereMessage,
  buildTelegramFundingReceiptStatusMessage,
} from "./services/telegram-funding-presentation.js";

const connectionString = process.env.BOT17_TEST_DATABASE_URL;
assert.ok(connectionString, "Explicit disposable database required");
const target = new URL(connectionString);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/bot17_disposable_20260915");
const db = new pg.Pool({ connectionString, max: 2, statement_timeout: 5000 });
const client = await db.connect();
const fixtureSchema = `bot17_fixture_${randomUUID().replaceAll("-", "")}`;
try {
  assert.match(
    (await client.query("show server_version")).rows[0].server_version,
    /^16\./,
  );
  await client.query(`
    begin;
    create schema ${fixtureSchema};
    set search_path to ${fixtureSchema}, public;
    create table funding_receive_sessions (
      id uuid primary key, user_id uuid, owner_channel text, status text,
      destination_option_id text, venue_binding_option_id text,
      venue_id text default 'polymarket', destination_target_snapshot jsonb default '{}',
      closed_at timestamptz, version int default 1, updated_at timestamptz,
      created_at timestamptz default now()
    );
    create table telegram_funding_sessions (
      id uuid primary key, receive_session_id uuid, user_id uuid,
      telegram_user_id text default 'tester', chat_id text default 'chat', telegram_account_id uuid,
      latest_terminal_projection jsonb default '{"terminal":true}'
    );
    create table funding_receive_receipts (
      id uuid primary key, receive_session_id uuid, user_id uuid,
      status text, handling text, child_funding_operation_id uuid,
      ledger_height numeric, variant_id text, raw_amount numeric,
      network_id text, asset_id text, asset_decimals int,
      routing_disposition text, routing_last_error_code text,
      evidence jsonb default '{}', updated_at timestamptz
    );
    create table funding_receive_canonical_events (
      id uuid default gen_random_uuid(), allocated_at timestamptz, last_observed_at timestamptz,
      allocated_receipt_id uuid, allocated_receive_session_id uuid,
      allocation_status text, first_observed_at timestamptz
    );
    create table telegram_funding_consents (
      telegram_funding_session_id uuid, consented_at timestamptz,
      automation_enabled boolean, consented_variant_ids text[],
      automation_policy_snapshot jsonb, max_auto_execute_source_raw numeric
    );
    create function ${fixtureSchema}.funding_account_identifier_equal(text,text,text)
    returns boolean language sql immutable as 'select lower($2) = lower($3)';
  `);
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const userId = "20000000-0000-4000-8000-000000000001";
  const contextId = "30000000-0000-4000-8000-000000000001";
  const now = new Date();
  await client.query(
    `insert into funding_receive_sessions
    (id,user_id,owner_channel,status,destination_option_id,venue_binding_option_id)
    values ($1,$2,'telegram','processing','destination','binding');
    `,
    [sessionId, userId],
  );
  await client.query(
    "insert into telegram_funding_sessions (id,receive_session_id,user_id,telegram_account_id) values ($1,$2,$3,$3)",
    [contextId, sessionId, userId],
  );
  await client.query(
    `insert into telegram_funding_consents values
    ($1, now()-interval '1 hour', false, array['solana'], '{}', null)`,
    [contextId],
  );
  for (const [index, raw] of ["1", "251914"].entries()) {
    const receiptId = `40000000-0000-4000-8000-00000000000${index + 1}`;
    await client.query(
      `insert into funding_receive_receipts
      (id,receive_session_id,user_id,status,handling,ledger_height,variant_id,raw_amount,network_id,asset_id,asset_decimals)
      values ($1,$2,$3,'observed','automatic_conversion',100,'base',$4,'evm:8453','usdc',6)`,
      [receiptId, sessionId, userId, raw],
    );
    await client.query(
      "insert into funding_receive_canonical_events (allocated_receipt_id, allocated_receive_session_id, allocation_status, first_observed_at) values ($1,$2,'allocated',now())",
      [receiptId, sessionId],
    );
  }
  // Without canonical allocation this is unknown, not a negative consent proof.
  await client.query(
    "update funding_receive_canonical_events set allocation_status='pending'",
  );
  assert.equal(
    await classifyUnconsentedTelegramReceipts(client, {
      receiveSessionId: sessionId,
      now,
    }),
    0,
  );
  await client.query(
    "update funding_receive_canonical_events set allocation_status='allocated'",
  );
  await client.query(
    `update telegram_funding_consents set automation_enabled=true,
    consented_variant_ids=array['base'], max_auto_execute_source_raw=1000000,
    automation_policy_snapshot=$1::jsonb`,
    [
      JSON.stringify({
        version: 3,
        fullReceipt: false,
        presentation: {},
        sourceAsset: { networkId: "evm:8453", assetId: "usdc", decimals: 6 },
        variantCursors: [
          {
            variantId: "base",
            networkId: "evm:8453",
            ledgerHeightExclusive: "99",
          },
        ],
      }),
    ],
  );
  assert.equal(
    await classifyUnconsentedTelegramReceipts(client, {
      receiveSessionId: sessionId,
      now,
    }),
    0,
    "applicable consent is preserved even if runtime routing is paused",
  );
  // An enabled but malformed matching consent must remain blocked.
  await client.query(
    "update telegram_funding_consents set automation_policy_snapshot='{}'",
  );
  assert.equal(
    await classifyUnconsentedTelegramReceipts(client, {
      receiveSessionId: sessionId,
      now,
    }),
    0,
  );
  await client.query(
    "update telegram_funding_consents set automation_enabled=false",
  );
  const openScope = {
    userId,
    telegramAccountId: userId,
    telegramUserId: "tester",
    chatId: "chat",
    venueId: "polymarket",
    destinationOptionId: "destination",
    venueBindingOptionId: "binding",
    now,
  };
  await classifyTelegramFundingOpenReceipts(client, {
    ...openScope,
    chatId: "another-chat",
  });
  assert.equal(
    (
      await client.query(
        "select count(*)::int as n from funding_receive_receipts where status='observed'",
      )
    ).rows[0].n,
    2,
  );
  await classifyTelegramFundingOpenReceipts(client, openScope);
  assert.equal(
    await classifyUnconsentedTelegramReceipts(client, {
      receiveSessionId: sessionId,
      now,
    }),
    0,
  );
  const receipts = (
    await client.query(
      "select * from funding_receive_receipts order by raw_amount",
    )
  ).rows;
  assert.deepEqual(
    receipts.map((r) => String(r.raw_amount)),
    ["1", "251914"],
  );
  assert.ok(
    receipts.every(
      (r) =>
        r.status === "recovery_required" &&
        r.child_funding_operation_id === null,
    ),
  );
  assert.equal(
    (await client.query("select status from funding_receive_sessions")).rows[0]
      .status,
    "recovery_required",
  );
  await client.query(
    "update funding_receive_receipts set status='observed', child_funding_operation_id=gen_random_uuid()",
  );
  assert.equal(
    await classifyUnconsentedTelegramReceipts(client, {
      receiveSessionId: sessionId,
      now,
    }),
    0,
  );
  const message = buildTelegramFundingActiveElsewhereMessage({ contextId });
  const button = message.reply_markup?.inline_keyboard[0]?.[0];
  assert.ok(button && "callback_data" in button);
  assert.equal(button.callback_data, `hm:v1:fund:refresh:${contextId}`);
  const summary = buildTelegramFundingReceiptStatusMessage({
    contextId,
    venue: "polymarket",
    receipts: [
      {
        receiptId: "receipt",
        receiveSessionId: sessionId,
        variantId: "base",
        asset: { networkId: "evm:8453", assetId: "USDC", decimals: 6 },
        destinationAddress: "must-not-disclose",
        rawAmount: "251914",
        observationRevision: "test",
        observedAt: now.toISOString(),
        status: "recovery_required",
        handling: "automatic_conversion",
        childFundingOperationId: null,
        automationReason: "receive_automation_not_consented",
      },
    ],
  });
  assert.ok(summary.text.includes("Base"));
  assert.ok(summary.text.includes("Automatic conversion was not started"));
  assert.ok(!JSON.stringify(summary).includes("must-not-disclose"));
  // Canonical ingestion must leave the observer's expected version unchanged.
  await client.query(
    "update funding_receive_receipts set status='observed', child_funding_operation_id=null",
  );
  await client.query(
    "update funding_receive_canonical_events set allocation_status='pending'",
  );
  const canonical = (
    await client.query(
      "select id,allocated_receipt_id from funding_receive_canonical_events limit 1",
    )
  ).rows[0];
  const versionBefore = (
    await client.query("select version from funding_receive_sessions")
  ).rows[0].version;
  assert.equal(
    await finalizeFundingReceiveCanonicalEventAllocation(client, {
      eventId: canonical.id,
      receiptId: canonical.allocated_receipt_id,
      receiveSessionId: sessionId,
      now,
    }),
    true,
  );
  assert.equal(
    (await client.query("select version from funding_receive_sessions")).rows[0]
      .version,
    versionBefore,
  );
  assert.equal(
    (
      await client.query(
        "select status from funding_receive_receipts where id=$1",
        [canonical.allocated_receipt_id],
      )
    ).rows[0].status,
    "recovery_required",
  );
  await client.query(
    "update funding_receive_canonical_events set allocation_status='allocated'",
  );
  // Exercise a real competing receipt lock, not just sequential CAS checks.
  await client.query(
    "update funding_receive_receipts set status='observed', child_funding_operation_id=null",
  );
  await client.query("commit");
  const competing = await db.connect();
  try {
    await competing.query(`set search_path to ${fixtureSchema}, public`);
    await client.query("begin");
    await client.query("select id from funding_receive_receipts for update");
    await competing.query("begin");
    assert.equal(
      await classifyUnconsentedTelegramReceipts(competing, {
        receiveSessionId: sessionId,
        now,
      }),
      0,
      "a concurrent claimant keeps the receive lease",
    );
    await competing.query("rollback");
    await client.query(
      "update funding_receive_receipts set child_funding_operation_id=gen_random_uuid(), status='routing'",
    );
    await client.query("commit");
    await competing.query("begin");
    assert.equal(
      await classifyUnconsentedTelegramReceipts(competing, {
        receiveSessionId: sessionId,
        now,
      }),
      0,
      "committed child operations cannot be classified away",
    );
    await competing.query("rollback");
  } finally {
    await competing.query("rollback");
    competing.release();
  }
  console.log(
    "BOT17 consent SQL, concurrent receipt claim and status tests passed",
  );
} finally {
  await client.query("rollback");
  await client.query(`drop schema if exists ${fixtureSchema} cascade`);
  client.release();
  await db.end();
}
