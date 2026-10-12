import type { Pool } from "pg";
import { z } from "zod";
import { hip4TradeSchema, type Hip4ReadMarket } from "@hunch/shared";

export type Hip4Interval = {
  start: number;
  end: number;
  kind: "observed" | "gap";
  reason: string;
};
export async function insertHip4Trades(
  db: Pick<Pool, "query">,
  market: Hip4ReadMarket,
  inputs: z.infer<typeof hip4TradeSchema>[],
) {
  const trades = inputs.map((input) => {
    const row = hip4TradeSchema.parse(input);
    if (row.coin !== market.sides[0].coin)
      throw new Error("trade_identity_mismatch");
    return { ...row, time_ms: row.time };
  });
  // Only INSERT RETURNING contributes to aggregates: REST/WS overlap and replay
  // never add volume twice. Time + tid determines open/close even for late fills.
  await db.query(
    `with inserted_trades as (
    insert into hip4_public_trades(environment,coin,time_ms,tid,market_id,side,price,size,transaction_hash)
    select $1, trade_row.coin,trade_row.time_ms,trade_row.tid,$2,trade_row.side,trade_row.px::numeric,trade_row.sz::numeric,trade_row.hash
    from jsonb_to_recordset($3::jsonb) as trade_row(coin text,time_ms bigint,tid bigint,side text,px text,sz text,hash text)
    on conflict(environment,coin,time_ms,tid) do nothing returning *
  ), grouped_trades as (
    select market_id,(time_ms/60000)*60000 as bucket_ms,
      (array_agg(price order by time_ms,tid))[1] as open_price,
      max(price) as high_price,min(price) as low_price,
      (array_agg(price order by time_ms desc,tid desc))[1] as close_price,
      sum(size) as volume,count(*) as trade_count,
      (array_agg(time_ms order by time_ms,tid))[1] as first_time_ms,
      (array_agg(tid order by time_ms,tid))[1] as first_tid,
      (array_agg(time_ms order by time_ms desc,tid desc))[1] as last_time_ms,
      (array_agg(tid order by time_ms desc,tid desc))[1] as last_tid
    from inserted_trades group by market_id,(time_ms/60000)*60000
  ) insert into hip4_candles select * from grouped_trades
  on conflict(market_id,bucket_ms) do update set
    open_price=case when (excluded.first_time_ms,excluded.first_tid)<(hip4_candles.first_time_ms,hip4_candles.first_tid) then excluded.open_price else hip4_candles.open_price end,
    close_price=case when (excluded.last_time_ms,excluded.last_tid)>(hip4_candles.last_time_ms,hip4_candles.last_tid) then excluded.close_price else hip4_candles.close_price end,
    high_price=greatest(hip4_candles.high_price,excluded.high_price),low_price=least(hip4_candles.low_price,excluded.low_price),
    volume=hip4_candles.volume+excluded.volume,trade_count=hip4_candles.trade_count+excluded.trade_count,
    first_tid=case when (excluded.first_time_ms,excluded.first_tid)<(hip4_candles.first_time_ms,hip4_candles.first_tid) then excluded.first_tid else hip4_candles.first_tid end,
    first_time_ms=least(hip4_candles.first_time_ms,excluded.first_time_ms),
    last_tid=case when (excluded.last_time_ms,excluded.last_tid)>(hip4_candles.last_time_ms,hip4_candles.last_tid) then excluded.last_tid else hip4_candles.last_tid end,
    last_time_ms=greatest(hip4_candles.last_time_ms,excluded.last_time_ms)`,
    [market.environment, market.marketId, JSON.stringify(trades)],
  );
}

export async function insertHip4Intervals(
  db: Pick<Pool, "query">,
  marketId: string,
  intervals: Hip4Interval[],
) {
  const pieces: Hip4Interval[] = [];
  for (const interval of intervals) {
    if (
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 0 ||
      interval.end < interval.start ||
      interval.end - interval.start > 86_400_000
    )
      throw new Error("invalid_observation_interval");
    for (let start = interval.start; start <= interval.end; ) {
      const end = Math.min(
        interval.end,
        (Math.floor(start / 60000) + 1) * 60000,
      );
      pieces.push({ ...interval, start, end });
      if (end === interval.end) break;
      start = end;
    }
  }
  if (!pieces.length) return;
  await db.query(
    `insert into hip4_observation_intervals(market_id,bucket_ms,start_ms,end_ms,kind,reason)
    select $1,(piece.start_ms/60000)*60000,min(piece.start_ms),max(piece.end_ms),piece.kind,piece.reason from jsonb_to_recordset($2::jsonb) as piece(start_ms bigint,end_ms bigint,kind text,reason text)
    group by (piece.start_ms/60000)*60000,piece.kind,piece.reason
    on conflict(market_id,bucket_ms,kind,reason) do update set start_ms=least(hip4_observation_intervals.start_ms,excluded.start_ms),end_ms=greatest(hip4_observation_intervals.end_ms,excluded.end_ms)`,
    [
      marketId,
      JSON.stringify(
        pieces.map((piece) => ({
          start_ms: piece.start,
          end_ms: piece.end,
          kind: piece.kind,
          reason: piece.reason,
        })),
      ),
    ],
  );
}

const cursorSchema = z.object({
  v: z.literal(1),
  market: z.string(),
  time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  coin: z.string(),
  tid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

// Shared with representative-scale SQL plan tests. Qualify ordering columns:
// unqualified ORDER BY would resolve the text-cast output labels, not bigint.
export function hip4TradesReadSql(hasCursor: boolean) {
  return `select coin,side,price::text as px,size::text as sz,time_ms::text,tid::text,transaction_hash as hash
    from hip4_public_trades as trade_row where market_id=$1 ${hasCursor ? "and (trade_row.time_ms,trade_row.coin,trade_row.tid)<($3::bigint,$4::text,$5::bigint)" : ""}
    order by trade_row.time_ms desc,trade_row.coin desc,trade_row.tid desc limit $2`;
}
export const HIP4_CANDLES_READ_SQL = `select bucket_ms::text,open_price::text,high_price::text,low_price::text,close_price::text,volume::text,trade_count::text
  from hip4_candles as candle_row where market_id=$1 and bucket_ms >= $2 and bucket_ms < $3 order by candle_row.bucket_ms desc limit $4`;
export const HIP4_OLDER_CANDLE_SQL = `select bucket_ms::text from hip4_candles as candle_row
  where market_id=$1 and bucket_ms < $2 order by candle_row.bucket_ms desc limit 1`;
export const HIP4_COVERAGE_READ_SQL = `select start_ms::text,end_ms::text,kind,reason from hip4_observation_intervals as interval_row
  where market_id=$1 and bucket_ms >= ($2::bigint/60000)*60000 and bucket_ms < $3 and end_ms >= $2
  order by interval_row.bucket_ms desc,interval_row.kind desc,interval_row.reason desc limit $4`;
export function parseHip4TradeCursor(
  cursor: string | undefined,
  marketId: string,
) {
  if (!cursor) return null;
  try {
    const value = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
    if (value.market !== marketId) throw new Error();
    return value;
  } catch {
    throw new Error("invalid_cursor");
  }
}
export async function readHip4Trades(
  db: Pick<Pool, "query">,
  marketId: string,
  cursor: string | undefined,
  limit: number,
) {
  const after = parseHip4TradeCursor(cursor, marketId);
  const rows = await db.query(
    hip4TradesReadSql(Boolean(after)),
    after
      ? [marketId, limit + 1, after.time, after.coin, after.tid]
      : [marketId, limit + 1],
  );
  const selected = rows.rows.slice(0, limit).map((row) =>
    hip4TradeSchema.parse({
      ...row,
      time: Number(row.time_ms),
      tid: Number(row.tid),
    }),
  );
  const last = selected.at(-1);
  return {
    source: "canonical_primary_trades" as const,
    trades: selected,
    nextCursor:
      rows.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              market: marketId,
              time: last.time,
              coin: last.coin,
              tid: last.tid,
            }),
          ).toString("base64url")
        : null,
  };
}
export async function readHip4Candles(
  db: Pick<Pool, "query">,
  marketId: string,
  from: number,
  before: number,
  limit: number,
) {
  const [candles, intervals] = await Promise.all([
    db.query(HIP4_CANDLES_READ_SQL, [marketId, from, before, limit + 1]),
    db.query(HIP4_COVERAGE_READ_SQL, [marketId, from, before, limit + 1]),
  ]);
  const selected = candles.rows.slice(0, limit);
  // A sparse/settled market may have no candles in the latest range. Jump to
  // the nearest older recorded bucket through the market/time index, rather
  // than stranding its history or walking arbitrary empty calendar windows.
  const older =
    candles.rows.length <= limit
      ? await db.query(HIP4_OLDER_CANDLE_SQL, [marketId, from])
      : null;
  return {
    intervalMs: 60000 as const,
    candles: selected.map((row) => ({
      time: Number(row.bucket_ms),
      open: row.open_price,
      high: row.high_price,
      low: row.low_price,
      close: row.close_price,
      volume: row.volume,
      trades: Number(row.trade_count),
      complete: false as const,
    })),
    coverage: {
      source: "canonical_primary_trades" as const,
      complete: false as const,
      truncated: intervals.rows.length > limit,
      intervals: intervals.rows.slice(0, limit).map((row) => ({
        start: Number(row.start_ms),
        end: Number(row.end_ms),
        kind: row.kind as "observed" | "gap",
        reason: row.reason,
      })),
    },
    nextBefore:
      candles.rows.length > limit
        ? Number(selected.at(-1)?.bucket_ms)
        : older?.rows[0]
          ? Math.min(from, Number(older.rows[0].bucket_ms) + 60000)
          : null,
  };
}
