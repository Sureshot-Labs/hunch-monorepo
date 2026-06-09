#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { DbQuery } from "./db.js";
import { aggregateKalshiCandlesticks } from "./lib/candlesticks.js";
import {
  loadDbCandlestickSeries,
  selectDbOnlyCandlestickSeries,
  selectCandlestickSeries,
  shouldUseDbCandlestickFallback,
} from "./services/candlestick-history.js";

type FakeCall = { sql: string; params: unknown[] };

function fakeDb(rows: unknown[]) {
  const calls: FakeCall[] = [];
  const db = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as DbQuery;
  return { db, calls };
}

{
  const { db, calls } = fakeDb([
    {
      side: "YES",
      token_id: "limitless:yes",
      t: "120",
      open: "0.4",
      high: "0.6",
      low: "0.3",
      close: "0.5",
    },
    {
      side: "NO",
      token_id: "limitless:no",
      t: "120",
      open: "0.6",
      high: "0.7",
      low: "0.4",
      close: "0.5",
    },
  ]);

  const series = await loadDbCandlestickSeries(db, {
    venue: "limitless",
    tokens: { YES: "limitless:yes", NO: "limitless:no" },
    includeYes: true,
    includeNo: true,
    startTs: 0,
    endTs: 600,
    bucketMinutes: 5,
  });

  assert.match(calls[0]?.sql ?? "", /unified_book_top_1m/);
  assert.deepEqual(calls[0]?.params.slice(0, 3), [
    ["YES", "NO"],
    ["limitless:yes", "limitless:no"],
    "limitless",
  ]);
  assert.deepEqual(series.YES?.candles, [
    { t: 120, o: 0.4, h: 0.6, l: 0.3, c: 0.5 },
  ]);
  assert.equal(series.NO?.source, "db");
}

{
  const { db, calls } = fakeDb([]);
  await loadDbCandlestickSeries(db, {
    venue: "polymarket",
    tokens: { YES: "yes" },
    includeYes: true,
    includeNo: false,
    startTs: 0,
    endTs: 86_400,
    bucketMinutes: 1440,
  });
  assert.match(calls[0]?.sql ?? "", /unified_book_top_1h/);
}

{
  assert.equal(
    shouldUseDbCandlestickFallback({
      candles: [{ t: 60, o: 0.5, h: 0.5, l: 0.5, c: 0.5 }],
      startTs: 0,
      endTs: 86_400,
      bucketMinutes: 1440,
    }),
    false,
  );
  assert.equal(
    shouldUseDbCandlestickFallback({
      candles: [{ t: 60, o: 0.5, h: 0.5, l: 0.5, c: 0.5 }],
      startTs: 0,
      endTs: 172_800,
      bucketMinutes: 1440,
    }),
    true,
  );
}

{
  const selected = selectDbOnlyCandlestickSeries({
    tokenId: "hyperliquid:101:yes",
    dbCandles: [{ t: 60, o: 0.2, h: 0.4, l: 0.1, c: 0.3 }],
  });
  assert.equal(selected.source, "db");
  assert.equal(selected.fallbackReason, undefined);
  assert.equal(selected.candles[0]?.c, 0.3);
}

{
  const selected = selectCandlestickSeries({
    tokenId: "token",
    venueCandles: [],
    dbCandles: [{ t: 60, o: 0.2, h: 0.4, l: 0.1, c: 0.3 }],
    upstreamOk: false,
    startTs: 0,
    endTs: 600,
    bucketMinutes: 5,
  });
  assert.equal(selected.source, "db");
  assert.equal(selected.fallbackReason, "upstream_error");
  assert.equal(selected.candles[0]?.c, 0.3);
}

{
  const aggregated = aggregateKalshiCandlesticks(
    [
      { t: 80, o: 0.2, h: 0.3, l: 0.1, c: 0.25 },
      { t: 100, o: 0.25, h: 0.35, l: 0.2, c: 0.3 },
    ],
    5,
    0,
    100,
  );
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0]?.t, 100);
}
