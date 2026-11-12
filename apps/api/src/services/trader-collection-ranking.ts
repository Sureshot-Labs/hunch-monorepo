import {
  collections,
  type Collection,
  type CollectionResponse,
  type TraderItem,
} from "../schemas/trader-collections.js";
import {
  DAY,
  UNIT,
  fmt,
  ratio,
  exposureKey,
  indexPairedExposure,
  type Close,
  type Market,
  type Ledger,
} from "./trader-collection-ledger.js";
export const DEFAULT_TRADER_POLICY = {
  minDays: 14,
  minCloses: 20,
  dust: 10n * UNIT,
  minMove: 500n * UNIT,
  minRelative: UNIT,
  moveSeconds: DAY,
  quoteSeconds: 300,
  maxDrift: 50000n,
};
export type TraderPolicy = typeof DEFAULT_TRADER_POLICY;
export type Owner = {
  id: string;
  family: string;
  name: string | null;
  address: string;
};
export type Supplemental = {
  referenceCloses?: { at: number; stake: bigint }[] | null;
  earliestPossibleClose?: number;
  nativeClosedInWindow?: boolean;
  category: string;
  net30: bigint | null;
  net24: bigint | null;
  openLoss: bigint;
  uncertainClose: number;
};
export type Evidence = {
  uncertainExposureConditions?: Set<string>;
  distinctClosed?: number;
  positionWindowFallback?: boolean;
  owner: Owner;
  ledgers: { market: Market; ledger: Ledger }[];
  supplemental?: Supplemental[];
  gaps: Set<string>;
  historyStart: number;
  completeLifetime: boolean;
};
export const iso = (s: number) => new Date(s * 1000).toISOString();
const sum = (s: bigint[]) => s.reduce((a, b) => a + b, 0n);
const cmp = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);
export function priorityOrder(a: bigint[], b: bigint[]) {
  for (let i = 0; i < a.length; i++) {
    const n = cmp(a[i], b[i]);
    if (n) return n;
  }
  return 0;
}

/** Exact median of stakes closed strictly before a fill, shared by all moves
 * in a category. Compress stakes into an order-statistic count tree; look up
 * the chronological prefix in logarithmic time, including equal-time closes
 * together and never leaking future closes into a trader's typical stake. */
function priorStakeMedian(closes: Pick<Close, "at" | "stake">[], dust: bigint) {
  const history = closes
    .filter((c) => c.stake >= dust)
    .sort((a, b) => a.at - b.at);
  const stakes = [...new Set(history.map((c) => c.stake))].sort((a, b) =>
    cmp(b, a),
  );
  const coordinates = new Map(stakes.map((s, i) => [s, i + 1]));
  const tree = new Int32Array(stakes.length + 1);
  let step = 1;
  while (step * 2 <= stakes.length) step *= 2;
  function kth(rank: number) {
    let index = 0;
    for (let bit = step; bit; bit >>= 1) {
      const next = index + bit;
      if (next < tree.length && tree[next] < rank) {
        rank -= tree[next];
        index = next;
      }
    }
    return stakes[index];
  }
  const times: number[] = [],
    medians: bigint[] = [];
  for (let i = 0; i < history.length; ) {
    const at = history[i].at;
    do {
      const coordinate = coordinates.get(history[i].stake);
      if (coordinate === undefined) throw Error("missing_stake_coordinate");
      for (let j = coordinate; j < tree.length; j += j & -j) tree[j]++;
      i++;
    } while (i < history.length && history[i].at === at);
    times.push(at);
    medians.push(
      (kth(Math.floor((i + 1) / 2)) + kth(Math.floor(i / 2) + 1)) / 2n,
    );
  }
  return (at: number) => {
    let lo = 0,
      hi = times.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (times[mid] < at) lo = mid + 1;
      else hi = mid;
    }
    return lo ? medians[lo - 1] : 0n;
  };
}
export function winningRun(
  closes: Close[],
  policy: TraderPolicy,
  full: boolean,
) {
  const eligible = closes
    .filter(
      (c) =>
        c.stake >= policy.dust &&
        c.stake * UNIT <= 900000n * c.shares &&
        c.net !== 0n,
    )
    .sort((a, b) => b.at - a.at);
  let n = 0,
    profit = 0n,
    boundary = full;
  for (let i = 0; i < eligible.length; ) {
    let j = i;
    while (j < eligible.length && eligible[j].at === eligible[i].at) j++;
    const cohort = eligible.slice(i, j);
    if (cohort.some((c) => c.net < 0n)) {
      if (cohort.some((c) => c.net > 0n)) return null;
      boundary = true;
      break;
    }
    n += cohort.length;
    profit += sum(cohort.map((c) => c.net));
    i = j;
  }
  return boundary && n >= 5
    ? { n, profit, latest: eligible[0].at, count: eligible.length }
    : null;
}
type Choice = {
  category: string;
  family: string;
  item: TraderItem;
  priority: bigint[];
};
export type CandidateMap = Record<Collection, Choice[]>;
export const emptyChoices = (): CandidateMap => ({
  "big-moves": [],
  "winning-streaks": [],
  "top-earners-today": [],
});
export function candidates(
  e: Evidence,
  end: number,
  policy = DEFAULT_TRADER_POLICY,
  quoteClock = end,
): CandidateMap {
  const out = emptyChoices(),
    floor = end - 30 * DAY,
    day = end - DAY;
  const historyDays = Math.floor((end - e.historyStart) / DAY);
  const extra = e.supplemental ?? [];
  const global =
    e.gaps.size || extra.some((v) => v.net30 === null)
      ? null
      : sum(
          e.ledgers.flatMap((l) =>
            l.ledger.income.filter((r) => r.at > floor).map((r) => r.net),
          ),
        ) + sum(extra.map((v) => v.net30 ?? 0n));
  // An unclassified economic gap could belong to any segment.
  if (
    e.gaps.has("*") ||
    historyDays < policy.minDays ||
    (global !== null && global <= 0n)
  )
    return out;
  const allClosed = e.ledgers.flatMap((x) => x.ledger.closes);
  const completed = Math.max(allClosed.length, e.distinctClosed ?? 0);
  if (completed < policy.minCloses) return out;
  const paired = indexPairedExposure(e.ledgers);
  for (const category of new Set([
    ...e.ledgers.map((x) => x.market.category),
    ...extra.map((x) => x.category),
  ])) {
    if (e.gaps.has(category)) continue;
    const ls = e.ledgers.filter((x) => x.market.category === category),
      closes = ls.flatMap((x) => x.ledger.closes);
    const past = closes.filter((c) => c.at > floor),
      today = past.filter((c) => c.at > day);
    const others = extra.filter((v) => v.category === category);
    if (others.some((v) => v.net30 === null)) continue;
    const inc = ls.flatMap((x) => x.ledger.income),
      p30 =
        sum(inc.filter((r) => r.at > floor).map((r) => r.net)) +
        sum(others.map((v) => v.net30 ?? 0n)),
      p24 =
        sum(inc.filter((r) => r.at > day).map((r) => r.net)) +
        sum(others.map((v) => v.net24 ?? 0n));
    if (
      p30 <= 0n ||
      sum(ls.map((x) => x.ledger.openLoss)) +
        sum(others.map((v) => v.openLoss)) >=
        p30 ||
      (!past.length && !others.some((v) => v.nativeClosedInWindow))
    )
      continue;
    let median: ReturnType<typeof priorStakeMedian> | undefined;
    // A native accounting fallback may prove a completed stake even without
    // a fee-complete episode. An unknown qualifying stake anywhere in the
    // common prefix prevents an exact median; it need not hide a known fill.
    const references = others.flatMap((v) =>
      (v.referenceCloses ?? []).filter((c) => c.at > floor && c.at <= end),
    );
    const unknownAfter = others.reduce(
      (earliest, v) =>
        v.referenceCloses == null && v.uncertainClose > floor
          ? Math.min(earliest, v.earliestPossibleClose ?? floor)
          : earliest,
      Infinity,
    );
    const suitable = ls
      .flatMap(({ market: m, ledger: l }) => {
        if (
          !m.active ||
          e.uncertainExposureConditions?.has(m.condition) ||
          e.uncertainExposureConditions?.has(exposureKey(m)) ||
          (m.tradableUntil != null && m.tradableUntil <= quoteClock) ||
          !m.ask ||
          m.ask >= UNIT ||
          !m.quoteAt ||
          m.quoteAt < quoteClock - policy.quoteSeconds ||
          m.quoteAt > quoteClock + 60 ||
          l.current <= 0n
        )
          return [];
        const ask = m.ask;
        if (l.current * ask < policy.dust * UNIT) return [];
        const quote = {
          ask: fmt(ask),
          asOf: iso(m.quoteAt),
          validUntil: iso(
            Math.min(
              m.tradableUntil ?? Infinity,
              m.quoteAt + policy.quoteSeconds,
            ),
          ),
          status: "fresh" as const,
          basis: "top_of_book_not_execution_quote" as const,
        };
        // Most recent first also preserves the observed ordering of two
        // increases in the same instrument/second after the stable time sort.
        return [...l.moves].reverse().flatMap((latest) => {
          if (
            latest.at <= end - policy.moveSeconds ||
            latest.at > end ||
            l.current <= latest.before ||
            (latest.cash < policy.dust && latest.cash < policy.minMove)
          )
            return [];
          const price = ratio(latest.cash, latest.shares);
          const drift = ask > price ? ask - price : price - ask;
          if (
            price <= 0n ||
            price >= UNIT ||
            drift > policy.maxDrift ||
            drift * 10n > price ||
            paired(m, latest, price, policy.dust)
          )
            return [];
          // Small suitable entries may be the latest opportunity but need no
          // typical-stake calculation when they cannot qualify as a Big Move.
          const typical =
            latest.cash >= policy.minMove && latest.at <= unknownAfter
              ? (median ??= priorStakeMedian(
                  [...past, ...references],
                  policy.dust,
                ))(latest.at)
              : 0n;
          return [
            {
              l,
              m,
              latest,
              price,
              relative: ratio(latest.cash, typical),
              quote,
            },
          ];
        });
      })
      .sort(
        (a, b) =>
          b.latest.at - a.latest.at ||
          a.m.instrument.tokenId.localeCompare(b.m.instrument.tokenId),
      );
    const current = suitable.find((x) => x.latest.cash >= policy.dust);
    const latestOpenPosition: TraderItem["latestOpenPosition"] = current
      ? {
          instrument: current.m.instrument,
          shares: fmt(current.l.current),
          entryPrice: fmt(current.price),
          quote: current.quote,
          positionAsOf: iso(end),
          lastConfirmedIncreaseAt: iso(current.latest.at),
          liquidityUsd: null,
          priceDrift: "within_policy",
        }
      : null;
    const add = (
      key: Collection,
      achievement: TraderItem["achievement"],
      summary: string,
      priority: bigint[],
    ) =>
      out[key].push({
        category,
        family: e.owner.family,
        priority,
        item: {
          trader: {
            traderId: e.owner.id,
            username: e.owner.name,
            displayName: e.owner.name,
          },
          rank: 1,
          realized30dUsd: global === null ? null : fmt(global),
          categoryRealized30dUsd: fmt(p30),
          completedPositions: completed,
          historyDays,
          latestOpenPosition,
          summary,
          evidenceAsOf: iso(end),
          flags: [
            "catalog_scoped",
            ...(e.positionWindowFallback ? ["position_window_reconciled"] : []),
            ...(global === null ? ["wallet_total_incomplete"] : []),
            ...(current ? ["depth_not_verified"] : []),
          ],
          achievement,
        },
      });
    const fence = others.reduce((t, v) => Math.max(t, v.uncertainClose), 0);
    const run = winningRun(
      // Condition-scoped carry-in provides cost, not full cross-market
      // chronology before the common account window.
      past.filter((c) => c.at > fence),
      policy,
      e.completeLifetime && !fence,
    );
    if (run)
      add(
        "winning-streaks",
        {
          kind: "winning_streak",
          currentLength: run.n,
          streakNetRealizedUsd: fmt(run.profit),
          qualifyingCompletedPositions: run.count,
          latestWinAt: iso(run.latest),
        },
        `${run.n} qualifying wins, +$${fmt(run.profit)} realized.`,
        [BigInt(run.n), run.profit, BigInt(closes.length), p30],
      );
    if (p24 > 0n && others.every((v) => v.net24 !== null)) {
      const closeDetailsComplete = fence <= day;
      const best = today
        .filter((c) => c.net > 0n)
        .sort((a, b) => cmp(a.net, b.net) || b.at - a.at)[0];
      add(
        "top-earners-today",
        {
          kind: "top_earner_24h",
          netRealized24hUsd: fmt(p24),
          closeDetailsComplete,
          completedPositionCount24h: closeDetailsComplete ? today.length : null,
          largestProfitableClose:
            closeDetailsComplete && best
              ? {
                  instrument: best.instrument,
                  episodeNetRealizedUsd: fmt(best.net),
                  completedAt: iso(best.at),
                }
              : null,
          roi30d: null,
        },
        `+$${fmt(p24)} realized in the past 24 hours.`,
        [p24, BigInt(closes.length), p30],
      );
    }
    // Only one card from this trader can win a category. Pick a retained move
    // on its own merits, independently of the latest suitable opportunity.
    const significant = suitable.filter(
      (x) =>
        x.latest.cash >= policy.minMove && x.relative >= policy.minRelative,
    );
    const movePriority = (x: (typeof suitable)[number]) => [
      p30,
      x.relative,
      x.latest.cash,
      BigInt(x.latest.at),
    ];
    const x = significant.reduce<(typeof suitable)[number] | undefined>(
      (best, candidate) =>
        !best || priorityOrder(movePriority(candidate), movePriority(best)) < 0
          ? candidate
          : best,
      undefined,
    );
    if (x) {
      add(
        "big-moves",
        {
          kind: "big_move",
          eventType:
            x.latest.before === 0n ? "new_position" : "position_increased",
          instrument: x.m.instrument,
          committedUsd: fmt(x.latest.cash),
          sharesBefore: fmt(x.latest.before),
          sharesAfter: fmt(x.latest.after),
          fillVwap: fmt(x.price),
          transactionAt: iso(x.latest.at),
          positionAsOf: iso(end),
          stillOpen: true,
          quote: x.quote,
          liquidityUsd: null,
          relativeToTypical: fmt(x.relative),
        },
        `Bought $${fmt(x.latest.cash)} at ${fmt(x.price * 100n)}¢; still holding.`,
        movePriority(x),
      );
    }
  }
  return out;
}
export function assemble(
  sets: CandidateMap[],
  end: number,
  id: string,
  selected: number,
  segments: Iterable<string>,
  generatedAt = end,
) {
  const cats = [
    ...new Set(["sports", "crypto", "politics", ...segments]),
  ].sort();
  return Object.fromEntries(
    collections.map((collection) => {
      const choices = sets.flatMap((s) => s[collection]);
      const groups = cats.map((category) => {
        const rows = choices
          .filter((v) => v.category === category)
          .sort(
            (a, b) =>
              priorityOrder(a.priority, b.priority) ||
              a.item.trader.traderId.localeCompare(b.item.trader.traderId),
          );
        const families = new Set<string>(),
          items: TraderItem[] = [];
        for (const r of rows) {
          if (families.has(r.family)) continue;
          families.add(r.family);
          if (items.length < 3)
            items.push({ ...r.item, rank: items.length + 1 });
        }
        return {
          category,
          status: items.length
            ? ("ready" as const)
            : ("insufficient_evidence" as const),
          coverage: {
            venues: ["polymarket" as const],
            universe: "recent_active_tracked_shortlist" as const,
            resultScope: "servable_hunch_catalog_positions" as const,
            selectedWallets: selected,
            observedWallets: sets.length,
            eligibleWallets: families.size,
            basis:
              collection === "big-moves"
                ? ("verified_fills" as const)
                : collection === "winning-streaks"
                  ? ("verified_episodes" as const)
                  : ("verified_realizations" as const),
          },
          sourceAsOf: iso(end),
          items,
        };
      });
      const result: CollectionResponse = {
        collection,
        snapshotId: id,
        generatedAt: iso(generatedAt),
        windowStart: collection === "winning-streaks" ? null : iso(end - DAY),
        windowEnd: iso(end),
        policyVersion: 1,
        methodologyVersion: 1,
        freshness: "fresh",
        groups,
      };
      return [collection, result];
    }),
  ) as Record<Collection, CollectionResponse>;
}
