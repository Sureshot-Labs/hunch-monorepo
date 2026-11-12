import type {
  Balance,
  Delta,
  GlobalMoveRepository,
  PublicOwner,
} from "../repos/trader-global-moves.js";
import {
  assetKey,
  type TraderRepository,
} from "../repos/trader-collections.js";
import {
  rejectionCodes,
  type CollectionResponse,
  type RejectionCode,
  type TraderItem,
} from "../schemas/trader-collections.js";
import {
  DAY,
  UNIT,
  fmt,
  units,
  type Market,
} from "./trader-collection-ledger.js";
import {
  DEFAULT_TRADER_POLICY as policy,
  iso,
} from "./trader-collection-ranking.js";

const key = (r: { wallet: string; market: string }) =>
  r.wallet + ":" + r.market;
const asset = (d: Delta) => ({
  condition: d.market,
  token: d.token,
  index: d.side === "YES" ? 0 : 1,
  label: d.side,
});
const abs = (n: bigint) => (n < 0n ? -n : n);
const positive = (n: bigint) => (n > 0n ? n : 0n);
const decimal = (s: unknown) =>
  typeof s === "string" && /^\d{1,25}(?:\.\d{1,18})?$/.test(s)
    ? units(s)
    : null;
const batches = <T>(arr: T[], n: number) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, (i + 1) * n),
  );

/** Validate the immediate baseline and both balances at the observation. A
 * later re-entry or hedge unwind cannot resurrect a previously removed move. */
export function retainedMove(
  d: Delta,
  timeline: Balance[],
  m: Market,
  oppositeToken: string | undefined,
  end: number,
): { qty: bigint; asOf: number } | RejectionCode {
  const floor = end - DAY,
    before = decimal(d.prev_qty),
    after = decimal(d.curr_qty),
    delta = decimal(d.shares),
    price = decimal(d.price);
  if (
    before === null ||
    after === null ||
    delta === null ||
    price === null ||
    delta <= 0n ||
    after <= before ||
    abs(after - before - delta) > 1n ||
    d.observed_sec <= floor ||
    d.observed_sec > end
  )
    return "balance_not_comparable";
  const contract = m.instrument.generation.split(":")[1];
  if (!contract || (d.contract && d.contract !== contract))
    return "balance_not_comparable";
  let ours: bigint | null = null,
    opposite: bigint | null = 0n,
    last = 0,
    seen = false,
    baselineNet = 0n,
    low = after;
  const rows = timeline;
  for (let i = 0; i < rows.length; ) {
    const at = rows[i].observed_sec,
      priorQty = ours as bigint | null,
      priorOther = opposite as bigint | null,
      priorAt = last;
    let ourUpdate = false;
    while (i < rows.length && rows[i].observed_sec === at) {
      const r = rows[i++],
        own = r.side === d.side,
        token = own ? d.token : oppositeToken;
      const q =
        r.observed &&
        !!token &&
        r.token === token &&
        (!r.contract || r.contract === contract)
          ? decimal(r.shares)
          : null;
      if (own) {
        ours = q;
        last = at;
        ourUpdate = true;
      } else opposite = q;
    }
    if (at < d.observed_sec) continue;
    if (at === d.observed_sec) {
      if (
        !ourUpdate ||
        priorAt < floor ||
        priorQty === null ||
        abs(priorQty - before) > 1n ||
        ours === null ||
        abs(ours - after) > 1n
      )
        return "balance_not_comparable";
      if (priorOther === null) return "exposure_uncertain";
      baselineNet = positive(before - priorOther);
      seen = true;
    }
    if (!seen || ours === null) return "balance_not_comparable";
    if (opposite === null) return "exposure_uncertain";
    if (ours <= before) return "increase_not_retained";
    if (ours < low) low = ours;
    const directional = positive(ours - opposite) - baselineNet;
    if (
      directional <= 0n ||
      (low - before - directional) * price >= policy.dust * UNIT
    )
      return "paired_exposure";
  }
  return seen && ours !== null
    ? { qty: ours, asOf: last }
    : "balance_not_comparable";
}
export async function buildGlobalMoves(
  repo: Pick<GlobalMoveRepository, "deltas" | "owners" | "balances">,
  markets: Pick<TraderRepository, "markets">,
  end: number,
  id: string,
  whale: number,
  signal: AbortSignal,
  clock = () => Math.floor(Date.now() / 1000),
): Promise<CollectionResponse> {
  const lo = end - DAY,
    deltas: Delta[] = [];
  for (let t = lo; t < end; t += 10800) {
    signal.throwIfAborted();
    deltas.push(...(await repo.deltas(t, t + 10800, end)));
  }
  const ids = [...new Set(deltas.map((d) => d.wallet))],
    owners = new Map<string, PublicOwner>();
  for (const batch of batches(ids, 250)) {
    signal.throwIfAborted();
    for (const o of await repo.owners(batch, whale)) owners.set(o.wallet, o);
  }
  const publicMove = (d: Delta) =>
    owners.has(d.wallet) &&
    (owners.get(d.wallet)?.system_tracked ||
      d.provenance === "polymarket" ||
      d.provenance === "alchemy" ||
      d.provenance === "auto_tracked_wallet");
  const visible = deltas.filter(
    (d) => publicMove(d) && /^\d{1,78}$/.test(d.token ?? ""),
  );
  const catalog = await markets.markets(visible.map(asset), end, signal, true);
  const reasons = new Map<string, RejectionCode>(),
    accepted = new Set<string>(),
    cats = new Set(["sports", "crypto", "politics"]);
  const note = (w: string, why: RejectionCode) => {
    const p = reasons.get(w);
    if (!p || rejectionCodes.indexOf(why) > rejectionCodes.indexOf(p))
      reasons.set(w, why);
  };
  for (const d of deltas) {
    if (!publicMove(d)) note(d.wallet, "wallet_not_public_trader");
    else if (!/^\d{1,78}$/.test(d.token ?? ""))
      note(d.wallet, "balance_not_comparable");
  }
  // Fetch only identities in active, potentially servable markets. No limit
  // on wallets or candidates: rank and family dedup happen after validation.
  const eligible: { d: Delta; m: Market; cash: bigint; price: bigint }[] = [];
  for (const d of visible) {
    const m = catalog.get(assetKey(asset(d)));
    if (m) cats.add(m.category);
    const price = decimal(d.price),
      cash = decimal(d.cash);
    if (
      !m?.active ||
      !m.ask ||
      m.ask >= UNIT ||
      !m.quoteAt ||
      m.quoteAt < clock() - policy.quoteSeconds ||
      m.quoteAt > clock() + 60 ||
      (m.tradableUntil ?? Infinity) <= clock()
    ) {
      note(d.wallet, "market_or_quote_unavailable");
      continue;
    }
    if (price === null || cash === null || cash < policy.minMove) {
      note(d.wallet, "balance_not_comparable");
      continue;
    }
    const drift = abs(m.ask - price);
    if (
      price <= 0n ||
      price >= UNIT ||
      drift > policy.maxDrift ||
      drift * 10n > price
    ) {
      note(d.wallet, "price_not_comparable");
      continue;
    }
    eligible.push({ d, m, cash, price });
  }
  const grouped = new Map<string, typeof eligible>();
  for (const v of eligible) {
    const k = key(v.d);
    const list = grouped.get(k);
    if (list) list.push(v);
    else grouped.set(k, [v]);
  }
  const choices: {
    category: string;
    family: string;
    cash: bigint;
    at: number;
    item: TraderItem;
  }[] = [];
  for (const batch of batches([...grouped.values()], 64)) {
    signal.throwIfAborted();
    const timeline = new Map<string, Balance[]>();
    for (const r of await repo.balances(
      batch.map(([v]) => ({ w: v.d.wallet, m: v.d.market })),
      lo,
      end,
    )) {
      const k = key(r);
      const list = timeline.get(k);
      if (list) list.push(r);
      else timeline.set(k, [r]);
    }
    for (const group of batch)
      for (const { d, m, cash, price } of group) {
        const held = retainedMove(
          d,
          timeline.get(key(d)) ?? [],
          m,
          m.oppositeToken,
          end,
        );
        if (typeof held === "string") {
          note(d.wallet, held);
          continue;
        }
        const ask = m.ask,
          asOf = m.quoteAt,
          o = owners.get(d.wallet);
        if (ask == null || asOf == null || !o)
          throw Error("invalid_move_candidate");
        const until = Math.min(
          asOf + policy.quoteSeconds,
          m.tradableUntil ?? Infinity,
        );
        if (held.qty * ask < policy.dust * UNIT) {
          note(d.wallet, "remaining_position_dust");
          continue;
        }
        const quote = {
          ask: fmt(ask),
          asOf: iso(asOf),
          validUntil: iso(until),
          status: "fresh" as const,
          basis: "top_of_book_not_execution_quote" as const,
        };
        choices.push({
          category: m.category,
          family: o.family,
          cash,
          at: d.observed_sec,
          item: {
            trader: {
              traderId: o.wallet,
              username: o.name,
              displayName: o.name,
            },
            rank: 1,
            historyDays: null,
            completedPositions: null,
            estimatedClosedPnl30dUsd: null,
            estimatedCategoryClosedPnl30dUsd: null,
            achievement: {
              kind: "big_move",
              eventType:
                units(d.prev_qty) === 0n
                  ? "new_position"
                  : "position_increased",
              instrument: m.instrument,
              estimatedIncreaseUsd: fmt(cash),
              observationPrice: fmt(price),
              observedAt: iso(d.observed_sec),
              positionAsOf: iso(held.asOf),
              sharesBefore: fmt(units(d.prev_qty)),
              sharesAfter: fmt(units(d.curr_qty)),
              openAtLastObservation: true,
              quote,
              liquidityUsd: null,
              relativeToTypical: null,
            },
            latestOpenPosition: null,
            summary: `Position grew by approximately $${fmt(cash)}.`,
            evidenceAsOf: iso(end),
            flags: [
              "catalog_scoped",
              "wallet_intel_estimate",
              "depth_not_verified",
            ],
          },
        });
      }
  }
  const now = clock();
  const move = (i: TraderItem) => {
    if (i.achievement.kind !== "big_move") throw Error("wrong_achievement");
    return i.achievement;
  };
  choices.sort((a, b) =>
    a.cash > b.cash
      ? -1
      : a.cash < b.cash
        ? 1
        : b.at - a.at ||
          a.item.trader.traderId.localeCompare(b.item.trader.traderId) ||
          move(a.item).instrument.tokenId.localeCompare(
            move(b.item).instrument.tokenId,
          ),
  );
  const groups: CollectionResponse["groups"] = [...cats]
    .sort()
    .map((category) => {
      const families = new Set<string>(),
        items: TraderItem[] = [];
      for (const x of choices) {
        if (x.category !== category) continue;
        if (Date.parse(move(x.item).quote.validUntil) <= now * 1000) {
          note(x.item.trader.traderId, "quote_expired_before_publication");
          continue;
        }
        accepted.add(x.item.trader.traderId);
        if (families.has(x.family)) continue;
        families.add(x.family);
        if (items.length < 3) items.push({ ...x.item, rank: items.length + 1 });
      }
      return {
        category,
        status: items.length ? "ready" : "insufficient_evidence",
        sourceAsOf: iso(end),
        coverage: {
          venues: ["polymarket"],
          universe: "all_public_wallet_intel",
          resultScope: "servable_hunch_catalog_positions",
          basis: "observed_position_deltas",
          selectedWallets: ids.length,
          observedWallets: ids.length,
          eligibleWallets: families.size,
        },
        items,
      };
    });
  const counts = new Map<RejectionCode, number>();
  for (const [w, reason] of reasons)
    if (!accepted.has(w)) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return {
    collection: "big-moves",
    snapshotId: id,
    windowStart: iso(lo),
    windowEnd: iso(end),
    generatedAt: iso(now),
    freshness: "fresh",
    availability: "ranked",
    policyVersion: 2,
    methodologyVersion: 2,
    groups,
    diagnostics: {
      scope: "all_public_position_increases",
      selectedWallets: ids.length,
      observedWallets: ids.length,
      attemptedWallets: ids.length,
      pendingWallets: 0,
      qualifiedWallets: accepted.size,
      sourceFailures: [],
      exclusions: [...counts].map(([code, wallets]) => ({ code, wallets })),
    },
  };
}
