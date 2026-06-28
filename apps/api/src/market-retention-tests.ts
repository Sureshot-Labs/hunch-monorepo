#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { pool } from "./db.js";

const execFileAsync = promisify(execFile);
const monorepoRoot = path.resolve(import.meta.dirname, "../../..");

type JsonRecord = Record<string, unknown>;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function randomEmail(): string {
  return `market-retention-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

function numericTokenId(): string {
  return `${crypto.randomInt(100_000_000, 999_999_999)}${crypto.randomInt(
    100_000_000,
    999_999_999,
  )}`;
}

async function createTestUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [randomEmail()],
  );
  const userId = rows[0]?.id;
  assert.ok(userId);
  return userId;
}

async function runApiScriptJson(
  scriptName: string,
  args: string[],
): Promise<JsonRecord> {
  const { stdout } = await execFileAsync(
    "pnpm",
    [
      "-C",
      monorepoRoot,
      "-F",
      "api",
      "exec",
      "tsx",
      `src/${scriptName}`,
      "--",
      ...args,
    ],
    {
      cwd: monorepoRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, stdout);
  return JSON.parse(stdout.slice(start, end + 1)) as JsonRecord;
}

function summaryRows(report: JsonRecord, key: string): JsonRecord[] {
  const rows = report[key];
  assert.ok(Array.isArray(rows), `expected ${key} to be an array`);
  return rows as JsonRecord[];
}

function countFor(rows: JsonRecord[], input: Partial<JsonRecord>): number {
  const row = rows.find((candidate) =>
    Object.entries(input).every(([key, value]) => candidate[key] === value),
  );
  return Number(row?.markets ?? row?.rows ?? 0);
}

async function insertUnifiedLimitlessMarket(params: {
  marketId: string;
  rawTokenId: string;
}): Promise<void> {
  const eventId = `event-${params.marketId}`;
  await pool.query(
    `
      insert into unified_events (
        id,
        venue,
        venue_event_id,
        title,
        status,
        start_date,
        end_date,
        volume_total,
        volume_24h,
        liquidity,
        slug,
        created_at,
        updated_at
      )
      values (
        $1,
        'limitless',
        $1,
        'Retention test event',
        'SETTLED',
        now() - interval '120 days',
        now() - interval '100 days',
        0,
        0,
        0,
        $2,
        now(),
        now()
      )
    `,
    [eventId, `slug-${eventId}`],
  );

  await pool.query(
    `
      insert into unified_markets (
        id,
        venue,
        venue_market_id,
        event_id,
        title,
        status,
        market_type,
        open_time,
        close_time,
        expiration_time,
        best_bid,
        best_ask,
        last_price,
        volume_total,
        volume_24h,
        liquidity,
        open_interest,
        outcomes,
        token_yes,
        token_no,
        slug,
        resolved_outcome,
        created_at,
        updated_at
      )
      values (
        $1,
        'limitless',
        $1,
        $2,
        'Retention test market',
        'SETTLED',
        'binary',
        now() - interval '120 days',
        now() - interval '100 days',
        now() - interval '100 days',
        0,
        0,
        null,
        0,
        0,
        0,
        0,
        '["Yes","No"]',
        $3,
        $4,
        $5,
        'YES',
        now(),
        now()
      )
    `,
    [
      params.marketId,
      eventId,
      params.rawTokenId,
      `other-${params.rawTokenId}`,
      `slug-${params.marketId}`,
    ],
  );
}

async function cleanupUnifiedRetentionTest(
  userId: string,
  marketId: string,
  tokenIds: string[],
): Promise<void> {
  await pool.query("delete from orders where user_id = $1", [userId]);
  await pool.query("delete from positions where user_id = $1", [userId]);
  await pool.query(
    "delete from unified_market_tokens where token_id = any($1::text[])",
    [tokenIds],
  );
  await pool.query(
    "delete from unified_tokens where token_id = any($1::text[])",
    [tokenIds],
  );
  await pool.query("delete from unified_markets where id = $1", [marketId]);
  await pool.query("delete from unified_events where id = $1", [
    `event-${marketId}`,
  ]);
  await pool.query("delete from users where id = $1", [userId]);
}

async function insertLimitlessSourceMarket(params: {
  eventId: string;
  marketId: string;
  rawTokenId: string;
}): Promise<void> {
  const expirationMs = Date.now() - 100 * 24 * 60 * 60 * 1000;
  await pool.query(
    `
      insert into limitless_events (
        id,
        title,
        status,
        market_type,
        expiration_timestamp,
        outcome_tokens,
        raw
      )
      values ($1, 'Retention source event', 'SETTLED', 'single', $2, $3, '{}'::jsonb)
      on conflict (id) do nothing
    `,
    [
      params.eventId,
      expirationMs,
      [params.rawTokenId, `other-${params.rawTokenId}`],
    ],
  );

  await pool.query(
    `
      insert into limitless_markets (
        id,
        event_id,
        title,
        status,
        market_type,
        expiration_timestamp,
        tokens_yes,
        tokens_no,
        raw
      )
      values ($1, $2, 'Retention source market', 'SETTLED', 'single', $3, $4, $5, '{}'::jsonb)
    `,
    [
      params.marketId,
      params.eventId,
      expirationMs,
      params.rawTokenId,
      `other-${params.rawTokenId}`,
    ],
  );
}

async function cleanupSourceRetentionTest(
  userId: string,
  eventIds: string[],
  marketIds: string[],
): Promise<void> {
  await pool.query("delete from orders where user_id = $1", [userId]);
  await pool.query("delete from positions where user_id = $1", [userId]);
  await pool.query("delete from limitless_markets where id = any($1::text[])", [
    marketIds,
  ]);
  await pool.query("delete from limitless_events where id = any($1::text[])", [
    eventIds,
  ]);
  await pool.query("delete from users where id = $1", [userId]);
}

await test("unified retention protects Limitless token_yes/token_no position variants", async () => {
  const rawTokenId = numericTokenId();
  const scopedTokenId = `limitless:${rawTokenId}`;
  const marketId = `retention-limitless:${crypto.randomUUID()}`;
  const walletAddress = randomEvmAddress();
  const userId = await createTestUser();

  try {
    await insertUnifiedLimitlessMarket({ marketId, rawTokenId });
    await pool.query(
      `
          insert into positions (
            user_id,
            wallet_address,
            venue,
            position_scope,
            token_id,
            side,
            size,
            average_price,
            unrealized_pnl,
            realized_pnl,
            last_updated_at,
            created_at,
            updated_at
          )
          values ($1, $2, 'limitless', 'own', $3, 'LONG', 1, 0.5, 0, 0, now(), now(), now())
        `,
      [userId, walletAddress, scopedTokenId],
    );

    const report = await runApiScriptJson("market-retention-selector.ts", [
      "--venue=limitless",
      "--cutoff-days=30",
      "--limit=50000",
      "--sample=200",
      "--json",
    ]);
    const rows = summaryRows(report, "batchSummary");
    assert.ok(
      countFor(rows, {
        section: "protected_by_reason",
        label: "positions",
      }) >= 1,
    );
    const samples = summaryRows(report, "removableSamples");
    assert.equal(
      samples.some((row) => row.marketId === marketId),
      false,
    );
  } finally {
    await cleanupUnifiedRetentionTest(userId, marketId, [
      rawTokenId,
      scopedTokenId,
      `other-${rawTokenId}`,
    ]);
  }
});

await test("source retention protects Limitless source markets referenced by positions and orders", async () => {
  const positionRawTokenId = numericTokenId();
  const orderRawTokenId = numericTokenId();
  const positionMarketId = `ret-src-pos-${crypto.randomUUID()}`;
  const orderMarketId = `ret-src-order-${crypto.randomUUID()}`;
  const eventId = `ret-src-event-${crypto.randomUUID()}`;
  const walletAddress = randomEvmAddress();
  const userId = await createTestUser();

  try {
    await insertLimitlessSourceMarket({
      eventId,
      marketId: positionMarketId,
      rawTokenId: positionRawTokenId,
    });
    await insertLimitlessSourceMarket({
      eventId,
      marketId: orderMarketId,
      rawTokenId: orderRawTokenId,
    });
    await pool.query(
      `
          insert into positions (
            user_id,
            wallet_address,
            venue,
            position_scope,
            token_id,
            side,
            size,
            average_price,
            unrealized_pnl,
            realized_pnl,
            last_updated_at,
            created_at,
            updated_at
          )
          values ($1, $2, 'limitless', 'own', $3, 'LONG', 1, 0.5, 0, 0, now(), now(), now())
        `,
      [userId, walletAddress, `limitless:${positionRawTokenId}`],
    );
    await pool.query(
      `
          insert into orders (
            user_id,
            wallet_address,
            venue,
            venue_order_id,
            token_id,
            side,
            order_type,
            price,
            size,
            status,
            posted_at,
            last_update
          )
          values ($1, $2, 'limitless', $3, $4, 'BUY', 'GTC', 0.5, 1, 'filled', now(), now())
        `,
      [
        userId,
        walletAddress,
        `retention-order-${crypto.randomUUID()}`,
        `limitless:${orderRawTokenId}`,
      ],
    );

    const report = await runApiScriptJson("market-source-retention.ts", [
      "--venue=limitless",
      "--cutoff-days=30",
      "--limit=50000",
      "--sample=200",
      "--json",
    ]);
    const rows = summaryRows(report, "summary");
    assert.ok(
      countFor(rows, {
        section: "source_market_protected_by_reason",
        venue: "limitless",
        label: "positions",
      }) >= 1,
    );
    assert.ok(
      countFor(rows, {
        section: "source_market_protected_by_reason",
        venue: "limitless",
        label: "orders",
      }) >= 1,
    );
    const samples = summaryRows(report, "samples");
    assert.equal(
      samples.some((row) =>
        [positionMarketId, orderMarketId].includes(String(row.sourceMarketId)),
      ),
      false,
    );
  } finally {
    await cleanupSourceRetentionTest(
      userId,
      [eventId],
      [positionMarketId, orderMarketId],
    );
  }
});
