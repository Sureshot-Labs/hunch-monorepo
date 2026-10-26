import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDiscoveryEstimate } from "./services/discovery-estimate.js";
import { discoveryTestItem } from "./discovery-test-fixtures.js";

type Sample = [
  string,
  string,
  string,
  "YES" | "NO",
  number,
  string,
  number,
  number,
  number,
  string,
  string,
  number,
  number,
  number,
];
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/discovery-odds-20261026.json", import.meta.url),
    "utf8",
  ),
) as { rows: Sample[]; limitations: string };
const logit = (x: number) => Math.log(x) - Math.log1p(-x),
  logistic = (x: number) => 1 / (1 + Math.exp(-x));
const events = new Map<
  string,
  {
    at: string;
    rows: { market: number; model: number; naive: number; y: number }[];
  }
>();
const sensitivities = new Map<string, { squared: number; count: number }>();
for (const r of fixture.rows) {
  const [
      market,
      event,
      at,
      side,
      p,
      quoteAt,
      w,
      b,
      n,
      statsAt,
      statsCreated,
      yes,
      no,
      y,
    ] = r,
    time = Date.parse(at);
  assert.ok(
    Date.parse(statsAt) <= time && Date.parse(statsCreated) <= time,
    "no future historical metrics",
  );
  assert.ok(Date.parse(quoteAt) <= time + 5000, "no future publication quote");
  const item = discoveryTestItem(market, {
    side,
    best_bid: String(p),
    best_ask: String(p),
    quote_at: at,
  });
  item.quote = {
    status: "fresh",
    bid: String(p),
    ask: String(p),
    midpoint: String(p),
    asOf: at,
  };
  item.reason = {
    kind: "hidden-gems",
    strength: "good",
    basis: "public_approved_research_not_proven_mispricing",
  };
  item.research = {
    noteId: "10000000-0000-4000-8000-000000000001",
    createdAt: at,
    headline: "Fixture",
    summary: "Numeric evaluation",
    side,
    strength: "good",
    researchedPrice: String(p),
    researchedAt: quoteAt,
    sources: [],
    caveats: [],
    instrument: item.selection.instrument,
  };
  const result = applyDiscoveryEstimate(
    item,
    {
      walletId: "00000000-0000-4000-8000-000000000001",
      side,
      actualWinRate: String(w),
      expectedWinRate: String(b),
      sampleSize: n,
      metricsAsOf: statsAt,
      // This experiment evaluates the transform, NOT historical position availability or live trading.
      positionAsOf: at,
      positionShares: "1",
      selectedSupportUsd: String(side === "YES" ? yes : no),
      oppositeSupportUsd: String(side === "YES" ? no : yes),
    },
    time,
  );
  assert.ok(
    result.estimate?.probability !== null &&
      result.estimate?.probability !== undefined,
    `${market}: ${result.estimate?.reason}`,
  );
  const model = Number(result.estimate.probability),
    bucket = events.get(event) ?? { at, rows: [] };
  bucket.rows.push({
    market: p,
    model,
    naive: Math.max(0.001, Math.min(0.999, p + w - b)),
    y,
  });
  events.set(event, bucket);
  const selected = side === "YES" ? yes : no,
    opposite = side === "YES" ? no : yes;
  const balance =
    selected + opposite === 0
      ? 0
      : (Math.sqrt(selected) - Math.sqrt(opposite)) /
        (Math.sqrt(selected) + Math.sqrt(opposite));
  for (const prior of [25, 50, 100])
    for (const cap of [1.5, 2, 3]) {
      const adjusted = (n * w + prior * b) / (n + prior),
        delta = Math.max(
          0,
          Math.min(Math.log(cap), logit(adjusted) - logit(b)),
        );
      const estimate = logistic(logit(p) + delta * balance),
        key = `prior${prior}:cap${cap}`;
      const total = sensitivities.get(key) ?? { squared: 0, count: 0 };
      total.squared += (estimate - y) ** 2;
      total.count++;
      sensitivities.set(key, total);
    }
}
const ordered = [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
const score = (rows: typeof ordered, key: "market" | "model" | "naive") => ({
  brier:
    rows.reduce(
      (sum, g) =>
        sum +
        g.rows.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / g.rows.length,
      0,
    ) / rows.length,
  logLoss:
    rows.reduce(
      (sum, g) =>
        sum +
        g.rows.reduce(
          (s, r) =>
            s -
            r.y * Math.log(Math.max(0.001, r[key])) -
            (1 - r.y) * Math.log(Math.max(0.001, 1 - r[key])),
          0,
        ) /
          g.rows.length,
      0,
    ) / rows.length,
});
const reliability = Array.from({ length: 10 }, (_, i) => {
  const rows = ordered
    .flatMap((g) =>
      g.rows.map((r) => ({ p: r.model, y: r.y, weight: 1 / g.rows.length })),
    )
    .filter((r) => Math.min(9, Math.floor(r.p * 10)) === i);
  const weight = rows.reduce((sum, r) => sum + r.weight, 0);
  return {
    bin: i,
    marketCount: rows.length,
    eventNormalizedWeight: weight,
    meanEstimate: weight
      ? rows.reduce((s, r) => s + r.p * r.weight, 0) / weight
      : null,
    observedPayout: weight
      ? rows.reduce((s, r) => s + r.y * r.weight, 0) / weight
      : null,
  };
});
assert.equal(fixture.rows.length, 67);
assert.equal(events.size, 50);
// Arithmetic reproducibility, NOT a requirement to beat the market or tune inputs until it does.
assert.ok(Math.abs(score(ordered, "model").brier - 0.20668808510834652) < 1e-9);
console.log(
  JSON.stringify(
    {
      sampleMarkets: fixture.rows.length,
      events: events.size,
      limitations: fixture.limitations,
      eventWeighted: Object.fromEntries(
        (["market", "model", "naive"] as const).map((k) => [
          k,
          score(ordered, k),
        ]),
      ),
      last17Events: Object.fromEntries(
        (["market", "model", "naive"] as const).map((k) => [
          k,
          score(ordered.slice(-17), k),
        ]),
      ),
      reliability,
      sensitivityMarketWeighted: Object.fromEntries(
        [...sensitivities].map(([k, v]) => [k, v.squared / v.count]),
      ),
    },
    null,
    2,
  ),
);
