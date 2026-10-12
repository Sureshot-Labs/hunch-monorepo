// Deterministic, offline companion to hip4-openapi.ts; contains no private data.
import { readFileSync } from "node:fs";
import {
  DEFAULT_HIP4_READ_POLICY,
  hip4ReadResponseSchema,
  hip4TradeSchema,
  hip4RawUnits,
} from "@hunch/shared";
import {
  ageHip4Market,
  applyHip4Book,
  mapHip4Market,
} from "./services/hip4-mapping.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const main = fixture.observations[0];
// collectedAt marks the start of the recorded multi-request capture.
const captureEnd = Math.max(
  Date.parse(fixture.collectedAt),
  main.book?.time ?? 0,
);
const markets = [11117, 8775, 11116, 95].map((outcome) => {
  let { market } = mapHip4Market({
    ...main,
    outcome,
    settlement: outcome === 95 ? main.settlement : null,
    fetchedAt: fixture.collectedAt,
    generation: "00000000-0000-0000-0000-000000000001",
  });
  for (const book of main.book ? [main.book] : []) {
    const side = market.sides.find((side) => side.coin === book.coin);
    if (side)
      market = applyHip4Book(
        market,
        side.sideIndex,
        book,
        captureEnd,
        DEFAULT_HIP4_READ_POLICY.bookMaxAgeMs,
      );
  }
  return ageHip4Market(market, captureEnd, DEFAULT_HIP4_READ_POLICY);
});
if (process.argv.includes("--history")) {
  const rows = hip4TradeSchema
    .array()
    .parse(main.trades)
    .sort((a, b) => a.time - b.time || a.tid - b.tid);
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const bucket = Math.floor(row.time / 60000) * 60000;
    groups.set(bucket, [...(groups.get(bucket) ?? []), row]);
  }
  const candles = [...groups]
    .map(([time, entries]) => {
      const decimals = Math.max(
        ...entries.map((row) => row.sz.split(".")[1]?.length ?? 0),
      );
      const sum = entries
        .reduce((total, row) => total + hip4RawUnits(row.sz, decimals), 0n)
        .toString()
        .padStart(decimals + 1, "0");
      return {
        time,
        open: entries[0].px,
        close: entries[entries.length - 1].px,
        high: entries.reduce(
          (best, row) => (Number(row.px) > Number(best) ? row.px : best),
          "0",
        ),
        low: entries.reduce(
          (best, row) => (Number(row.px) < Number(best) ? row.px : best),
          "1",
        ),
        volume: decimals
          ? `${sum.slice(0, -decimals)}.${sum.slice(-decimals)}`
          : sum,
        trades: entries.length,
        complete: false,
      };
    })
    .reverse();
  const common = {
    policyRevision: "public-read-fixture-20261011",
    environment: "mainnet",
    marketId: "hyperliquid:mainnet:outcome:11117",
  };
  console.log(
    JSON.stringify({
      trades: {
        ...common,
        source: "canonical_primary_trades",
        trades: [...rows].reverse(),
        nextCursor: null,
      },
      candles: {
        ...common,
        intervalMs: 60000,
        candles,
        coverage: {
          source: "canonical_primary_trades",
          complete: false,
          intervals: [],
          truncated: false,
        },
        nextBefore: null,
      },
    }),
  );
} else
  console.log(
    JSON.stringify(
      hip4ReadResponseSchema.parse({
        version: 1,
        refreshAfterMs: 30000,
        environment: "mainnet",
        policyRevision: "public-read-fixture-20261011",
        markets,
        nextOutcome: null,
      }),
      null,
      2,
    ),
  );
