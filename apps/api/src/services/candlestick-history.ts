import type { DbQuery } from "../db.js";
import type { CandleValues } from "../lib/candlesticks.js";

export type CandlestickSide = "YES" | "NO";
export type CandlestickSource = "venue" | "db" | "empty";
export type CandlestickFallbackReason =
  | "upstream_error"
  | "empty_upstream"
  | "too_few_upstream_candles";

export type CandlestickSeriesEntry = {
  tokenId: string | null;
  candles: CandleValues[];
  source: CandlestickSource;
  fallbackReason?: CandlestickFallbackReason;
  derived?: boolean;
};

export type DbCandlestickSeries = Partial<
  Record<CandlestickSide, CandlestickSeriesEntry>
>;

type DbCandlestickRow = {
  side: CandlestickSide;
  token_id: string;
  t: string | number;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toCandle(row: DbCandlestickRow): CandleValues | null {
  const t = toFiniteNumber(row.t);
  const close = toFiniteNumber(row.close);
  if (t == null || close == null) return null;

  const open = toFiniteNumber(row.open) ?? close;
  const high = toFiniteNumber(row.high) ?? Math.max(open, close);
  const low = toFiniteNumber(row.low) ?? Math.min(open, close);

  return {
    t: Math.floor(t),
    o: open,
    h: high,
    l: low,
    c: close,
  };
}

function pushToken(
  sides: CandlestickSide[],
  tokenIds: string[],
  side: CandlestickSide,
  tokenId: string | null | undefined,
) {
  if (!tokenId) return;
  sides.push(side);
  tokenIds.push(tokenId);
}

export function shouldUseDbCandlestickFallback(inputs: {
  candles: CandleValues[];
  startTs: number;
  endTs: number;
  bucketMinutes: number;
}): boolean {
  if (inputs.candles.length === 0) return true;
  const bucketSeconds = Math.max(1, Math.floor(inputs.bucketMinutes)) * 60;
  const expectedBuckets = Math.ceil(
    Math.max(0, inputs.endTs - inputs.startTs) / bucketSeconds,
  );
  return expectedBuckets >= 2 && inputs.candles.length < 2;
}

export async function loadDbCandlestickSeries(
  db: DbQuery,
  inputs: {
    venue: string;
    tokens: { YES?: string | null; NO?: string | null };
    includeYes: boolean;
    includeNo: boolean;
    startTs: number;
    endTs: number;
    bucketMinutes: number;
  },
): Promise<DbCandlestickSeries> {
  const sides: CandlestickSide[] = [];
  const tokenIds: string[] = [];
  if (inputs.includeYes) pushToken(sides, tokenIds, "YES", inputs.tokens.YES);
  if (inputs.includeNo) pushToken(sides, tokenIds, "NO", inputs.tokens.NO);
  if (tokenIds.length === 0) return {};

  const bucketMinutes = Math.max(1, Math.floor(inputs.bucketMinutes));
  const table =
    bucketMinutes < 60 ? "unified_book_top_1m" : "unified_book_top_1h";
  const params = [
    sides,
    tokenIds,
    inputs.venue,
    Math.floor(inputs.startTs),
    Math.floor(inputs.endTs),
    bucketMinutes,
  ];

  const sql = `
    with token_set as (
      select *
      from unnest($1::text[], $2::text[]) as ts(side, token_id)
    ),
    source_rows as (
      select
        ts.side,
        ts.token_id,
        floor(extract(epoch from h.bucket) / ($6::int * 60))::bigint as bucket_index,
        h.bucket,
        coalesce(h.avg_mid, h.avg_best_bid, h.avg_best_ask)::double precision as value,
        coalesce(h.min_mid, h.avg_mid, h.avg_best_bid, h.avg_best_ask)::double precision as low_value,
        coalesce(h.max_mid, h.avg_mid, h.avg_best_bid, h.avg_best_ask)::double precision as high_value
      from ${table} h
      join token_set ts on ts.token_id = h.token_id
      where h.venue = $3
        and h.bucket >= to_timestamp($4::double precision)
        and h.bucket <= to_timestamp($5::double precision)
    ),
    grouped as (
      select
        side,
        token_id,
        least(((bucket_index + 1) * $6::int * 60)::bigint, $5::bigint) as t,
        (array_agg(value order by bucket asc))[1] as open,
        max(high_value) as high,
        min(low_value) as low,
        (array_agg(value order by bucket desc))[1] as close
      from source_rows
      where value is not null
      group by side, token_id, bucket_index
    )
    select
      side,
      token_id,
      t::text,
      open::text,
      high::text,
      low::text,
      close::text
    from grouped
    order by side, t
  `;

  const result = (await db.query(sql, params)) as {
    rows: DbCandlestickRow[];
  };
  const series: DbCandlestickSeries = {};

  for (const row of result.rows) {
    const candle = toCandle(row);
    if (!candle) continue;
    const side = row.side;
    if (!series[side]) {
      series[side] = {
        tokenId: row.token_id,
        candles: [],
        source: "db",
      };
    }
    series[side]?.candles.push(candle);
  }

  return series;
}

export function selectCandlestickSeries(inputs: {
  tokenId: string | null | undefined;
  venueCandles: CandleValues[];
  dbCandles?: CandleValues[];
  upstreamOk: boolean;
  startTs: number;
  endTs: number;
  bucketMinutes: number;
  derived?: boolean;
}): CandlestickSeriesEntry {
  let fallbackReason: CandlestickFallbackReason | undefined;
  if (!inputs.upstreamOk) {
    fallbackReason = "upstream_error";
  } else if (inputs.venueCandles.length === 0) {
    fallbackReason = "empty_upstream";
  } else if (
    shouldUseDbCandlestickFallback({
      candles: inputs.venueCandles,
      startTs: inputs.startTs,
      endTs: inputs.endTs,
      bucketMinutes: inputs.bucketMinutes,
    })
  ) {
    fallbackReason = "too_few_upstream_candles";
  }

  if (fallbackReason && inputs.dbCandles && inputs.dbCandles.length > 0) {
    return {
      tokenId: inputs.tokenId ?? null,
      candles: inputs.dbCandles,
      source: "db",
      fallbackReason,
    };
  }

  if (!inputs.upstreamOk || inputs.venueCandles.length === 0) {
    return {
      tokenId: inputs.tokenId ?? null,
      candles: [],
      source: "empty",
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }

  return {
    tokenId: inputs.tokenId ?? null,
    candles: inputs.venueCandles,
    source: "venue",
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(inputs.derived ? { derived: true } : {}),
  };
}

export function selectDbOnlyCandlestickSeries(inputs: {
  tokenId: string | null | undefined;
  dbCandles?: CandleValues[];
}): CandlestickSeriesEntry {
  const candles = inputs.dbCandles ?? [];
  return {
    tokenId: inputs.tokenId ?? null,
    candles,
    source: candles.length > 0 ? "db" : "empty",
  };
}

export function resolveCandlestickHistorySource(
  entries: Array<CandlestickSeriesEntry | undefined>,
): CandlestickSource {
  if (entries.some((entry) => entry?.source === "db")) return "db";
  if (entries.some((entry) => entry?.source === "venue")) return "venue";
  return "empty";
}
