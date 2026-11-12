import {
  assetKey,
  type LocalActivity,
  type TraderRepository,
} from "../repos/trader-collections.js";
import {
  emptyLedgerState,
  replayWalletPositionLedgerRows,
  type WalletPositionLedgerState,
} from "./wallet-position-ledger.js";
import {
  DAY,
  exposureKey,
  UNIT,
  type Ledger,
  type Increase,
} from "./trader-collection-ledger.js";
import type { Owner, Evidence } from "./trader-collection-ranking.js";

// Only public inventory observations. In-app fills are not added to the same
// quantity change, and private account data is not a discovery signal.
const publicSources = new Set([
  "polymarket",
  "auto_tracked_wallet",
  "alchemy",
  "followed_wallet",
]);
const u = (value: number) => BigInt(Math.round(value * 1e6));
const decimal = (s: string | null) =>
  s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : NaN;
type Leg = {
  marketId: string;
  token: string;
  index: number;
  contract: string;
  first: number;
  last: number;
  price: number;
  state: WalletPositionLedgerState;
  stake: number;
  bought: number;
  episodeNet: number;
  known: boolean;
  closes: [number, number, number, number][];
  moves: [number, number, number, number][];
  balances: [number, number][];
  net30: number;
  net24: number;
  unknown: number;
  lostObservation?: boolean;
  reobservedAt?: number;
  unknownCloseFirst?: number;
  observedBasis?: boolean;
};
export type LocalCalc = {
  profileOnly?: true;
  end: number;
  stamp: string;
  id: string;
  first: number;
  legs: Record<string, Leg>;
  unmapped: string[];
};
export const startLocalCalc = (end: number): LocalCalc => ({
  end,
  stamp: new Date((end - 30 * DAY) * 1000).toISOString(),
  id: "00000000-0000-0000-0000-000000000000",
  first: end,
  legs: {},
  unmapped: [],
});
function reset(l: Leg, held: number, at: number) {
  l.state = emptyLedgerState();
  l.state.remainingShares = held;
  l.stake = 0;
  l.bought = 0;
  l.episodeNet = 0;
  l.known = held === 0;
  l.unknown = at;
  l.moves = [];
}
// Keep the balance just before the day plus changes during it (paired exposure).
function balance(l: Leg, at: number, shares: number, day: number) {
  const tail = l.balances.at(-1);
  if (tail && (at <= day || tail[0] === at)) {
    tail[0] = at;
    tail[1] = shares;
  } else l.balances.push([at, shares]);
}
export function advanceLocalCalc(s: LocalCalc, rows: LocalActivity[]) {
  const day = s.profileOnly ? Infinity : s.end - DAY;
  for (const r of rows) {
    s.stamp = r.stamp;
    s.id = r.id;
    if (
      r.venue !== "polymarket" ||
      r.source !== "snapshot_delta" ||
      r.activity_type !== "delta" ||
      !publicSources.has(r.observation_source ?? "")
    )
      continue;
    const at = r.observed_seconds,
      token = r.token,
      idx = r.side === "YES" ? 0 : r.side === "NO" ? 1 : -1;
    if ((!s.profileOnly && at <= s.end - 30 * DAY) || at > s.end) continue;
    s.first = Math.min(s.first, at);
    if (!token || !/^\d{1,78}$/.test(token) || idx < 0) {
      if (s.profileOnly) {
        if (!s.unmapped.length) s.unmapped.push(r.market_id);
      } else if (!s.unmapped.includes(r.market_id))
        s.unmapped.push(r.market_id);
      continue;
    }
    const k = assetKey({ condition: r.market_id, token, index: idx });
    const before = decimal(r.previous_shares),
      after = decimal(r.current_shares),
      price = decimal(r.price);
    const initial = !s.legs[k];
    const l = (s.legs[k] ??= {
      marketId: r.market_id,
      token,
      index: idx,
      contract: r.contract,
      first: at,
      last: at,
      price: 0,
      state: emptyLedgerState(),
      stake: 0,
      bought: 0,
      episodeNet: 0,
      known: true,
      closes: [],
      moves: [],
      balances: [],
      net30: 0,
      net24: 0,
      unknown: 0,
    });
    if (r.contract && l.contract && r.contract !== l.contract) {
      l.contract = "conflict";
      continue;
    }
    if (r.contract) l.contract = r.contract;
    const qty = Math.abs(after - before),
      tol = 1e-6;
    if (
      !(
        r.observed_balance === true &&
        before >= 0 &&
        after >= 0 &&
        price >= 0 &&
        price <= 1 &&
        qty > 0 &&
        Math.abs(decimal(r.shares) - qty) <= tol &&
        (after > before ? r.action === "BUY" : r.action === "SELL")
      )
    ) {
      reset(l, Number.isFinite(after) && after > 0 ? after : 0, at);
      l.lostObservation = true;
      l.last = at;
      balance(l, at, l.state.remainingShares, day);
      continue;
    }
    if (initial && !r.has_prior_snapshot && before === 0 && after > 0) {
      // First sight in a bounded holder sample is a mark, never an increase.
      l.state.remainingShares = after;
      l.state.remainingBasisUsd = l.stake = after * price;
      l.bought = after;
      l.known = true;
      l.observedBasis = true;
      l.price = price;
      l.last = at;
      balance(l, at, after, day);
      continue;
    }
    if (!r.has_prior_snapshot || !r.comparable_before || l.lostObservation) {
      // A sampling gap/generation change -> new observed level, not a buy/sale.
      reset(l, after, at);
      l.lostObservation = false;
      l.reobservedAt = at;
      l.last = at;
      l.price = price;
      balance(l, at, after, day);
      continue;
    }
    if (Math.abs(l.state.remainingShares - before) > tol) {
      reset(l, before, at);
      // Keep the observed opening inventory for paired exposure as well as for
      // costing. Its later sale cannot recast a formerly hedged move as directional.
      if (initial && before > 0) {
        const priorAt = r.previous_seconds;
        if (priorAt != null && priorAt < at) balance(l, priorAt, before, day);
        l.reobservedAt = priorAt != null && priorAt < at ? priorAt : at;
      }
      const priorMark = decimal(r.previous_mark);
      if (initial && before > 0 && priorMark >= 0 && priorMark <= 1) {
        // Same approximation as wallet profiles: start at a comparable local
        // snapshot mark, never substitute sale proceeds as the entry price.
        l.state.remainingBasisUsd = l.stake = before * priorMark;
        l.bought = before;
        l.known = true;
        l.unknown = 0;
        l.observedBasis = true;
      }
    }
    const realized = l.state.realizedPnlUsd;
    replayWalletPositionLedgerRows(
      [
        {
          walletId: "",
          marketId: r.market_id,
          outcomeSide: r.side,
          action: r.action,
          deltaShares: String(qty),
          price: String(price),
          sizeUsd: null,
          occurredAt: new Date(at * 1000),
          createdAt: null,
          id: r.id,
          source: r.source,
        },
      ],
      l.state,
    );
    // lastActivityAt is not an input to accounting or chronology here; keep the
    // checkpoint JSON-native across worker restarts.
    delete l.state.lastActivityAt;
    if (after > before) {
      l.stake += qty * price;
      l.bought += qty;
      if (!s.profileOnly && at > day && r.has_prior_snapshot)
        l.moves.push([at, before, after, price]);
    } else {
      if (l.known) {
        const pnl = l.state.realizedPnlUsd - realized;
        l.net30 += pnl;
        if (at > day) l.net24 += pnl;
        l.episodeNet += pnl;
        if (after === 0) {
          l.closes.push([at, l.episodeNet, l.stake, l.bought]);
          // Each instrument contributes at most ten entries to a profile.
          if (s.profileOnly && l.closes.length > 10) l.closes.shift();
        }
      } else {
        l.unknown = at;
        if (after === 0) {
          l.unknownCloseFirst ??= at;
        }
      }
      if (after === 0) {
        l.moves = [];
        l.known = true;
        l.stake = 0;
        l.bought = 0;
        l.episodeNet = 0;
      }
    }
    if (!s.profileOnly) balance(l, at, after, day);
    l.last = at;
    l.price = price;
  }
}
export async function localEvidence(
  s: LocalCalc,
  owner: Owner,
  repo: Pick<TraderRepository, "markets">,
  signal?: AbortSignal,
): Promise<Evidence> {
  const day = s.end - DAY,
    assets = Object.values(s.legs).map((l) => ({
      condition: l.marketId,
      token: l.token,
      index: l.index,
      label: l.index === 0 ? "YES" : "NO",
    }));
  const markets = await repo.markets(assets, s.end, signal, true);
  const evidence: Evidence &
    Required<Pick<Evidence, "supplemental" | "uncertainExposureConditions">> = {
    observedWindow: true,
    exposureUncertainThrough: new Map(),
    owner,
    ledgers: [],
    gaps: new Set(),
    supplemental: [],
    uncertainExposureConditions: new Set(),
    historyStart: s.first,
    completeLifetime: false,
  };
  const missingMarkets = new Set(s.unmapped);
  for (const [k, l] of Object.entries(s.legs)) {
    const m = markets.get(k);
    if (
      !m ||
      (l.contract && l.contract !== m.instrument.generation.split(":")[1])
    ) {
      missingMarkets.add(l.marketId);
      continue;
    }
    const shares = l.state.remainingShares;
    const edge = exposureKey(m);
    if (l.lostObservation || l.reobservedAt != null) {
      const fence = l.lostObservation ? s.end : (l.reobservedAt ?? 0);
      evidence.exposureUncertainThrough?.set(
        edge,
        Math.max(fence, evidence.exposureUncertainThrough?.get(edge) ?? 0),
      );
    }
    if (l.observedBasis) evidence.observedBasis = true;
    const closed: Ledger["closes"] = l.closes.map(
      ([at, net, stake, amount]) => ({
        at,
        net: u(net),
        stake: u(stake),
        shares: u(amount),
        instrument: m.instrument,
        basis: "observed_exit",
      }),
    );
    let net30 = l.net30,
      net24 = l.net24,
      held = shares;
    const resolved =
      m.winner &&
      m.resolvedAt != null &&
      m.resolvedAt <= s.end &&
      m.resolvedAt >= l.last
        ? m.resolvedAt
        : null;
    let unknown = l.unknown;
    if (resolved != null && held > 0) {
      if (l.known) {
        const pnl =
          held * (m.winner === m.instrument.side ? 1 : 0) -
          l.state.remainingBasisUsd;
        net30 += pnl;
        if (resolved > day) net24 += pnl;
        closed.push({
          basis: "inferred_settlement",
          at: resolved,
          net: u(l.episodeNet + pnl),
          stake: u(l.stake),
          shares: u(l.bought),
          instrument: m.instrument,
        });
      } else unknown = Math.max(unknown, resolved);
      held = 0;
    }
    const moves: Increase[] = [];
    let low = held;
    for (let i = l.moves.length - 1; i >= 0; i--) {
      const [at, b, a, p] = l.moves[i];
      if (low > b)
        moves.push({
          at,
          before: u(b),
          after: u(a),
          shares: u(a - b),
          cash: u((a - b) * p),
          retained: u(Math.min(low - b, a - b)),
          tx: "",
        });
      low = Math.min(low, b);
    }
    const marked =
      m.markBid != null &&
      m.markBid >= 0n &&
      m.markBid <= UNIT &&
      m.quoteAt != null &&
      m.quoteAt >= s.end - 300 &&
      m.quoteAt <= s.end + 300;
    const mark = marked
      ? Number(m.markBid) / 1e6
      : l.last >= s.end - 300
        ? l.price
        : null;
    const ledger: Ledger & Required<Pick<Ledger, "exposure">> = {
      positionAsOf: l.last,
      unmarkedBasis:
        held > 0 && l.known && mark == null ? u(l.state.remainingBasisUsd) : 0n,
      first: l.first,
      current: u(held),
      closes: closed,
      income: [
        { at: day, net: u(net30 - net24) },
        { at: s.end, net: u(net24) },
      ],
      moves: moves.reverse(),
      exposure: l.balances.map(([at, q]) => ({ at, shares: u(q) })),
      openLoss:
        held > 0 && l.known && mark != null
          ? u(Math.max(0, l.state.remainingBasisUsd - held * mark))
          : 0n,
    };
    if (resolved != null && shares > 0)
      ledger.exposure.push({ at: resolved, shares: 0n });
    evidence.ledgers.push({ market: m, ledger });
    if (unknown) {
      // Do not manufacture an entry price or a winning result for an episode
      // which started before our observations. A later complete episode is usable.
      evidence.estimatedIncomplete = true;
      evidence.supplemental.push({
        category: m.category,
        net30: 0n,
        net24: 0n,
        referenceCloses:
          l.unknownCloseFirst != null ||
          (resolved != null && shares > 0 && !l.known)
            ? null
            : [],
        openLoss: 0n,
        uncertainClose: unknown,
        earliestPossibleClose: l.unknownCloseFirst ?? unknown,
      });
    }
  }
  if (missingMarkets.size) evidence.gaps.add("outside_catalog");
  for (const m of markets.values())
    if (missingMarkets.has(m.instrument.marketId)) {
      evidence.gaps.add(m.category);
      evidence.uncertainExposureConditions.add(m.condition);
    }
  return evidence;
}
