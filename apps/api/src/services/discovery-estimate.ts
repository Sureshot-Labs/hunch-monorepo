import type {
  DiscoveryEstimate,
  DiscoveryItem,
  DiscoveryResearch,
} from "../schemas/discovery.js";
import { discoveryEvidenceMetricSchema } from "../schemas/discovery.js";
import {
  decimal,
  iso,
  record,
  sameInstrument,
  type RawDiscoveryRow,
} from "./discovery-domain.js";
import {
  compareSocialDecimal as cmp,
  divideSocialDecimal as div,
  subtractSocialDecimal as sub,
  multiplySocialDecimal as mul,
} from "./social-primitives.js";

/** Derived, private cache inputs; never return this object or raw note metadata. */
export type DiscoveryEstimateInputs = {
  walletId: string | null;
  side: string | null;
  actualWinRate: string | null;
  expectedWinRate: string | null;
  sampleSize: number | null;
  metricsAsOf: string | null;
  positionAsOf: string | null;
  positionShares: string | null;
  selectedSupportUsd: string | null;
  oppositeSupportUsd: string | null;
};
export const RESEARCH_ODDS_PARAMETERS = Object.freeze({
  priorObservations: 50,
  maximumOddsMultiplier: 2,
  halfLifeDays: 7,
});
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const probability = (v: string | null): number | null => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};
const recent = (at: string | null, now: number) =>
  at !== null && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= DAY;
const fixed = (n: number) => n.toFixed(12).replace(/\.?0+$/, "") || "0";

export function estimateInputsFromRow(
  row: RawDiscoveryRow,
): DiscoveryEstimateInputs {
  return {
    walletId:
      typeof row.wallet_id === "string" && UUID.test(row.wallet_id)
        ? row.wallet_id
        : null,
    side: typeof row.holder_side === "string" ? row.holder_side : null,
    actualWinRate: decimal(row.actual_win_rate),
    expectedWinRate: decimal(row.expected_win_rate),
    sampleSize: integer(row.sample_size),
    metricsAsOf: iso(row.metrics_as_of),
    positionAsOf: iso(row.position_as_of),
    positionShares: decimal(row.position_shares),
    selectedSupportUsd: decimal(row.selected_support_usd),
    oppositeSupportUsd: decimal(row.opposite_support_usd),
  };
}

/** Whitelist existing public evidence; no private ids, model prose, credentials or arbitrary URLs. */
export function enrichDiscoveryResearch(
  research: DiscoveryResearch,
  row: RawDiscoveryRow,
  now: number,
): DiscoveryResearch {
  const raw = record(row.metrics).signalEvidence;
  const evidenceMetrics: NonNullable<DiscoveryResearch["evidenceMetrics"]> = [];
  for (const value of Array.isArray(raw) ? raw.slice(0, 30) : []) {
    const metric = record(value),
      measurement = record(metric.measurement),
      source = record(metric.source);
    let normalizedUrl: string | null = null;
    try {
      if (typeof source.url === "string")
        normalizedUrl = new URL(source.url).href;
    } catch {
      /* not a public source */
    }
    const publicSource = research.sources.find((s) => s.url === normalizedUrl);
    if (metric.scope === "external_market" && !publicSource) continue;
    const asOf = iso(metric.asOf);
    if (!asOf || Date.parse(asOf) > now + 5000) continue;
    const parsed = discoveryEvidenceMetricSchema.safeParse({
      kind: metric.kind,
      scope: metric.scope,
      measurement:
        measurement.kind === "scalar"
          ? {
              kind: "scalar",
              value: decimal(measurement.value),
              unit: measurement.unit,
            }
          : {
              kind: measurement.kind,
              min: decimal(measurement.min),
              max: decimal(measurement.max),
              unit: measurement.unit,
            },
      horizonDays: integer(metric.horizonDays),
      sampleSize: integer(metric.sampleSize),
      asOf,
      basis: "saved_research_evidence_not_current_probability",
      sourceId: publicSource?.id ?? null,
    });
    if (!parsed.success) continue;
    const m = parsed.data.measurement;
    const numbers = m.kind === "scalar" ? [m.value] : [m.min, m.max];
    if (numbers.some((n) => !Number.isFinite(Number(n)))) continue;
    if (m.kind === "range" && cmp(m.min, m.max) > 0) continue;
    if (
      m.unit === "probability" &&
      numbers.some((n) => cmp(n, "-1") < 0 || cmp(n, "1") > 0)
    )
      continue;
    evidenceMetrics.push(parsed.data);
  }
  const source = [...research.sources]
    .filter((s) => !s.publishedAt || Date.parse(s.publishedAt) <= now)
    .sort(
      (a, b) =>
        Date.parse(b.publishedAt ?? "1970-01-01") -
          Date.parse(a.publishedAt ?? "1970-01-01") || a.id.localeCompare(b.id),
    )[0];
  return {
    ...research,
    sourceCount: research.sources.length,
    evidenceMetrics,
    contextHighlight: source
      ? {
          kind: "news",
          sourceId: source.id,
          headline: source.headline,
          url: source.url,
          publishedAt: source.publishedAt,
        }
      : null,
  };
}

/** Fixed heuristic, not a calibrated forecast. Floating point only for the bounded log-odds transform;
 * all quote comparisons and monetary ratios use the existing decimal arithmetic. */
export function applyDiscoveryEstimate(
  item: DiscoveryItem,
  input: DiscoveryEstimateInputs | undefined,
  now: number,
): DiscoveryItem {
  const research = item.research;
  if (item.reason.kind !== "hidden-gems" || !research) return item;
  // This estimates a published idea, not whether its author still holds it.
  // The saved representative/side and research instrument remain mandatory;
  // latest portfolio coverage is informational and must not erase the idea.
  const currentPositionStatus: DiscoveryEstimate["currentPositionStatus"] =
    !input?.positionAsOf
      ? "unavailable"
      : !recent(input.positionAsOf, now)
        ? "stale"
        : input.positionShares && cmp(input.positionShares, "0") > 0
          ? "confirmed"
          : "not_confirmed";
  const estimate: DiscoveryEstimate = {
    status: "unavailable",
    method: "research-odds-v1",
    version: 1,
    calibrated: false,
    side: item.selection.side,
    probability: null,
    marketProbability: null,
    representativeWalletId: input?.walletId ?? null,
    sampleSize: input?.sampleSize ?? null,
    researchAsOf: research.createdAt,
    metricsAsOf: input?.metricsAsOf ?? null,
    positionAsOf: input?.positionAsOf ?? null,
    positionBasis: "published_research",
    currentPositionStatus,
    quoteAsOf: item.quote.asOf,
    calculatedAt: new Date(now).toISOString(),
    reason: "inputs_unavailable",
    coverage: "representative_only",
    warnings: [
      "Experimental, uncalibrated heuristic; historical performance does not establish event probability.",
      "Excludes fees, depth and slippage; not a promised return.",
      "The estimate evaluates published research using its historical positioning evidence, not a claim that the trader still holds the position.",
    ],
  };
  if (currentPositionStatus !== "confirmed")
    estimate.warnings.push(
      "Current ownership is not confirmed by a recent matched snapshot; missing coverage does not establish a sale and does not suppress this estimate.",
    );
  const unavailable = (reason: DiscoveryEstimate["reason"]) => ({
    ...item,
    estimate: { ...estimate, reason },
    valuation: null,
  });
  if (!sameInstrument(research.instrument, item.selection.instrument))
    return unavailable("instrument_changed");
  const midpointText = item.quote.midpoint,
    askText = item.quote.ask,
    p = probability(midpointText),
    ask = probability(askText);
  if (
    item.quote.status !== "fresh" ||
    midpointText === null ||
    askText === null ||
    p === null ||
    p <= 0 ||
    p >= 1 ||
    ask === null ||
    ask <= 0 ||
    ask >= 1 ||
    !item.quote.asOf ||
    now - Date.parse(item.quote.asOf) > 300000 ||
    Date.parse(item.quote.asOf) > now + 5000
  )
    return unavailable("quote_unavailable");
  estimate.marketProbability = item.quote.midpoint;
  if (!input) return unavailable("inputs_unavailable");
  if (!input.walletId) return unavailable("representative_unavailable");
  if (
    input.side !== item.selection.side ||
    research.side !== item.selection.side
  )
    return unavailable("side_mismatch");
  const w = probability(input.actualWinRate),
    b = probability(input.expectedWinRate),
    n = input.sampleSize;
  if (w === null || b === null || b <= 0 || b >= 1 || n === null || n <= 0)
    return unavailable("metrics_unavailable");
  if (!recent(input.metricsAsOf, now)) return unavailable("metrics_stale");
  const ageDays = (now - Date.parse(research.createdAt)) / DAY;
  if (!Number.isFinite(ageDays) || ageDays < -5000 / DAY)
    return unavailable("invalid_research_time");
  let balance = 1;
  const s =
      input.selectedSupportUsd === null
        ? NaN
        : Number(input.selectedSupportUsd),
    o =
      input.oppositeSupportUsd === null
        ? NaN
        : Number(input.oppositeSupportUsd);
  if (Number.isFinite(s) && Number.isFinite(o) && s >= 0 && o >= 0) {
    balance =
      s + o === 0
        ? 0
        : (Math.sqrt(s) - Math.sqrt(o)) / (Math.sqrt(s) + Math.sqrt(o));
    estimate.coverage = "saved_two_sided_support";
    estimate.warnings.push(
      "Support balance is dated research evidence, not current market-wide consensus.",
    );
  } else
    estimate.warnings.push(
      "Only the representative trader is covered; opposing support is unknown.",
    );
  const { priorObservations, maximumOddsMultiplier, halfLifeDays } =
    RESEARCH_ODDS_PARAMETERS;
  const adjusted = (n * w + priorObservations * b) / (n + priorObservations);
  const logit = (x: number) => Math.log(x) - Math.log1p(-x);
  const delta = Math.max(
    0,
    Math.min(Math.log(maximumOddsMultiplier), logit(adjusted) - logit(b)),
  );
  const shift = delta * balance * 2 ** (-Math.max(0, ageDays) / halfLifeDays);
  const result = 1 / (1 + Math.exp(-(logit(p) + shift)));
  const estimatedProbability = shift === 0 ? midpointText : fixed(result);
  estimate.probability = estimatedProbability;
  estimate.status = shift === 0 ? "market_only" : "available";
  estimate.reason = shift === 0 ? "no_adjustment" : "adjusted";
  const ratio = div(estimatedProbability, askText);
  const payout = div("1", askText);
  return {
    ...item,
    estimate,
    valuation:
      ratio && payout
        ? {
            probabilityDifferencePp: mul(
              sub(estimatedProbability, midpointText),
              "100",
            ),
            modelUpsideRatio: sub(ratio, "1"),
            grossReturnIfWin: sub(payout, "1"),
            basis: "top_ask_excludes_depth_fees_slippage",
          }
        : null,
  };
}
