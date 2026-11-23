import type { DbQuery } from "../db.js";
import type { HolderResearchSignalPerformance } from "./holder-research-performance.js";

type Item = HolderResearchSignalPerformance;
function hasQuotedAsk(item: Item): item is Item & { entryPrice: number } {
  return (
    item.entryQuality === "quoted_ask" &&
    item.entryPrice != null &&
    item.entryPrice > 0 &&
    item.entryPrice < 1
  );
}
const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

export function summarizeHolderScorecard(items: Item[]) {
  const decided = items.filter(
    (item) => item.outcome === "correct" || item.outcome === "wrong",
  );
  const measured = decided.filter(hasQuotedAsk);
  const wins = decided.filter((item) => item.outcome === "correct").length;
  const byEvent = new Map<string, number[]>();
  const byHolder = new Map<string, number>();
  const rois = measured.map((item) => {
    const roi = Number(item.outcome === "correct") / item.entryPrice - 1;
    const key = item.eventId ?? `market:${item.venue}:${item.marketId}`;
    const group = byEvent.get(key) ?? [];
    group.push(roi);
    byEvent.set(key, group);
    if (item.primaryHolderWalletId) {
      const id = item.primaryHolderWalletId;
      byHolder.set(id, (byHolder.get(id) ?? 0) + 1);
    }
    return roi;
  });
  const eventRois = [...byEvent.values()].flatMap(
    (group) => average(group) ?? [],
  );
  eventRois.sort((a, b) => a - b);
  return {
    initialSignals: items.length,
    wins,
    losses: decided.length - wins,
    unknownOrOpen: items.length - decided.length,
    hitRate: decided.length ? wins / decided.length : null,
    measuredAtAsk: measured.length,
    meanAsk: average(measured.map((item) => item.entryPrice)),
    excessPerShare: average(
      measured.map(
        (item) => Number(item.outcome === "correct") - item.entryPrice,
      ),
    ),
    grossRoi: average(rois),
    grossRoiAtAskPlusOneCent: average(
      measured.map(
        (item) =>
          Number(item.outcome === "correct") /
            Math.min(1, item.entryPrice + 0.01) -
          1,
      ),
    ),
    eventWeightedRoi: average(eventRois),
    eventWeightedRoiWithoutBestEvent: average(eventRois.slice(0, -1)),
    measuredEvents: byEvent.size,
    missingEventIds: measured.filter((item) => !item.eventId).length,
    largestEvent: Math.max(
      0,
      ...[...byEvent.values()].map((group) => group.length),
    ),
    largestHolder: Math.max(0, ...byHolder.values()),
    missingHolderIds: measured.filter((item) => !item.primaryHolderWalletId)
      .length,
  };
}

export const HOLDER_SCORECARD_MARKOUT_SQL = `
  select requested.request_id, quote_row.avg_best_bid::text as exit_bid,
    coalesce(market_row.resolution_observed_at <= requested.probe_at, false) as settled
  from jsonb_to_recordset($1::jsonb) as requested(
    request_id int, market_id text, outcome_side text, probe_at timestamptz
  )
  left join unified_markets market_row on market_row.id = requested.market_id and market_row.venue = 'polymarket'
  left join lateral (
    select min(binding.token_id) as token_id from unified_market_tokens binding
    where binding.market_id = market_row.id and binding.outcome_side = requested.outcome_side
    having count(distinct binding.token_id) = 1
  ) instrument on true
  left join lateral (
    select quote_bucket.avg_best_bid from unified_book_top_1m quote_bucket
    where quote_bucket.venue = 'polymarket' and quote_bucket.token_id = instrument.token_id
      and (market_row.resolution_observed_at is null or market_row.resolution_observed_at > requested.probe_at)
      and quote_bucket.bucket >= $2::timestamptz and quote_bucket.bucket < $3::timestamptz
      and quote_bucket.bucket >= requested.probe_at - interval '10 minutes'
      and quote_bucket.bucket < date_trunc('minute', requested.probe_at)
      and quote_bucket.avg_best_bid > 0 and quote_bucket.avg_best_ask < 1
      and quote_bucket.avg_best_bid <= quote_bucket.avg_best_ask
    order by quote_bucket.bucket desc limit 1
  ) quote_row on true
`;

export async function loadHolderScorecardMarkouts(
  db: DbQuery,
  items: Item[],
  asOf: Date,
) {
  return await Promise.all(
    [4, 24].map(async (hours) => {
      const due = items
        .flatMap((item) => {
          const probe = Date.parse(item.publishedAt ?? "") + hours * 3_600_000;
          return item.venue === "polymarket" &&
            item.signalSide &&
            probe <= asOf.getTime()
            ? [{ item, probe }]
            : [];
        })
        .sort((a, b) => b.probe - a.probe);
      const eligible = due.flatMap(({ item, probe }) =>
        hasQuotedAsk(item) ? [{ item, probe, ask: item.entryPrice }] : [],
      );
      const capped = eligible.slice(0, 1000);
      const moves: number[] = [];
      let settledByHorizon = 0;
      for (let start = 0; start < capped.length; start += 64) {
        const batch = capped.slice(start, start + 64);
        const first = batch[0];
        const last = batch.at(-1);
        if (!first || !last) break;
        const { rows } = await db.query<{
          request_id: number;
          exit_bid: string | null;
          settled: boolean;
        }>(HOLDER_SCORECARD_MARKOUT_SQL, [
          JSON.stringify(
            batch.map(({ item, probe }, request_id) => ({
              request_id,
              market_id: item.marketId,
              outcome_side: item.signalSide,
              probe_at: new Date(probe).toISOString(),
            })),
          ),
          new Date(last.probe - 600_000).toISOString(),
          new Date(first.probe).toISOString(),
        ]);
        for (const row of rows) {
          if (row.settled) settledByHorizon += 1;
          else if (row.exit_bid != null) {
            const request = batch[row.request_id];
            if (request) moves.push(Number(row.exit_bid) / request.ask - 1);
          }
        }
      }
      return {
        hours,
        due: due.length,
        quotedEntry: eligible.length,
        probed: capped.length,
        settledByHorizon,
        measured: moves.length,
        meanBidOverEntryAskMinusOne: average(moves),
        up: moves.filter((x) => x > 0).length,
        down: moves.filter((x) => x < 0).length,
      };
    }),
  );
}
