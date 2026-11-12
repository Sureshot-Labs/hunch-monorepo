import type { Instrument } from "../schemas/trader-collections.js";

// Shares and USDC have six decimals. No binary-float accumulation of costs or P&L.
export const UNIT = 1_000_000n,
  DAY = 86400;
export function units(v: unknown): bigint {
  if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 0.000001)
    v = v.toFixed(6);
  if (
    (typeof v !== "string" && typeof v !== "number") ||
    !/^-?\d+(?:\.\d+)?$/.test(String(v)) ||
    String(v).length > 45
  )
    throw Error("invalid_decimal");
  const [w, f = ""] = String(v).replace(/^-/, "").split(".");
  return (
    (String(v).startsWith("-") ? -1n : 1n) *
    (BigInt(w) * UNIT +
      BigInt((f + "000000").slice(0, 6)) +
      (Number(f[6] || 0) >= 5 ? 1n : 0n))
  );
}
export const fmt = (n: bigint) => {
  const a = n < 0n ? -n : n;
  return (
    (n < 0n ? "-" : "") +
    (a / UNIT).toString() +
    (a % UNIT
      ? "." + (a % UNIT).toString().padStart(6, "0").replace(/0+$/, "")
      : "")
  );
};
export const ratio = (a: bigint, b: bigint) =>
  b > 0n ? (a * UNIT + b / 2n) / b : 0n;
const abs = (v: bigint) => (v < 0n ? -v : v);
export type Action = {
  kind: string;
  time: number;
  condition: string;
  token: string;
  side: string;
  shares: bigint;
  cash: bigint;
  tx: string;
  index: number | null;
  label: string;
};
export type Position = {
  condition: string;
  token: string;
  index: number;
  label: string;
  shares: bigint;
  pnl: bigint;
  unrealized: bigint;
  /** Native CLOSED projection's lifetime bought shares, not current balance. */
  closedBoughtShares?: bigint;
  remainingCost?: { total: bigint; entry: bigint; fees: bigint };
  first: number;
  last: number;
  redeemable?: boolean;
};
export type Market = {
  oppositeToken?: string;
  instrument: Instrument;
  category: string;
  condition: string;
  index: number;
  active: boolean;
  terminal?: boolean;
  winner?: "YES" | "NO" | null;
  resolvedAt?: number | null;
  markBid?: bigint | null;
  tradableUntil?: number | null;
  ask: bigint | null;
  quoteAt: number | null;
};
export type Resolution = { at: number; payout: readonly [bigint, bigint] };
export type Close = {
  at: number;
  net: bigint;
  stake: bigint;
  shares: bigint;
  instrument: Instrument;
};
export type Increase = {
  at: number;
  before: bigint;
  after: bigint;
  cash: bigint;
  shares: bigint;
  tx: string;
  retained?: bigint;
};
export type Ledger = {
  positionAsOf?: number;
  unmarkedBasis?: bigint;
  closes: Close[];
  income: { at: number; net: bigint }[];
  moves: Increase[];
  current: bigint;
  openLoss: bigint;
  first: number;
  exposure?: { at: number; shares: bigint }[];
};

// Between adjacent purchases the balance can only fall. The next purchase's
// before-balance and the final balance therefore include every possible low.
// A later top-up cannot resurrect an increase that had already been unwound.
function retainedIncreases(moves: Increase[], current: bigint): Increase[] {
  let low = current;
  const kept: Increase[] = [];
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i];
    if (low > move.before)
      kept.push({
        ...move,
        retained:
          low - move.before < move.shares ? low - move.before : move.shares,
      });
    if (move.before < low) low = move.before;
  }
  return kept.reverse();
}

export const exposureKey = (m: Market) =>
  m.condition + ":" + m.instrument.generation;

/** A YES/NO pair pays one dollar in either outcome: gross shares are not
 * directional exposure. Build a single post-second inventory and suffix-low
 * index for each observed binary pair. A leg sold before the buy is irrelevant.
 * Do not pair across conditions, generations or accounts. */
export function indexPairedExposure(
  rows: { market: Market; ledger: Ledger }[],
) {
  type Check = (
    index: number,
    move: Increase,
    price: bigint,
    dust: bigint,
  ) => boolean;
  const legs = new Map<string, [Ledger[], Ledger[]]>(),
    checks = new Map<string, Check>();
  for (const { market, ledger } of rows) {
    if (
      !(market.index === 0 || market.index === 1) ||
      (!ledger.exposure?.length && !ledger.current)
    )
      continue;
    const key = exposureKey(market);
    const pair = legs.get(key) ?? [[], []];
    pair[market.index].push(ledger);
    legs.set(key, pair);
  }
  for (const [key, [zero, one]] of legs) {
    if (!zero.length || !one.length) continue;
    const z = zero[0].exposure,
      o = one[0].exposure;
    if (zero.length !== 1 || one.length !== 1 || !z?.length || !o?.length) {
      checks.set(key, () => true); // known counterparty inventory; no comparable history
      continue;
    }
    const times: number[] = [],
      balances: [bigint, bigint][] = [],
      lows: [bigint, bigint][] = [];
    let i = 0,
      j = 0,
      x = 0n,
      y = 0n;
    while (i < z.length || j < o.length) {
      const at = Math.min(z[i]?.at ?? Infinity, o[j]?.at ?? Infinity);
      while (i < z.length && z[i].at === at) x = z[i++].shares;
      while (j < o.length && o[j].at === at) y = o[j++].shares;
      times.push(at);
      balances.push([x, y]);
      lows.push([x > y ? x - y : 0n, y > x ? y - x : 0n]);
    }
    for (let k = times.length - 2; k >= 0; k--)
      for (const side of [0, 1] as const)
        if (lows[k + 1][side] < lows[k][side])
          lows[k][side] = lows[k + 1][side];
    checks.set(key, (side, move, price, dust) => {
      let lo = 0,
        hi = times.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (times[mid] <= move.at) lo = mid + 1;
        else hi = mid;
      }
      if (!lo) return true; // fill predates the attested paired timeline
      const t = lo - 1,
        opposite = balances[t][1 - side],
        beforeOpposite =
          times[t] === move.at ? (balances[t - 1]?.[1 - side] ?? 0n) : opposite,
        baseline =
          move.before > beforeOpposite ? move.before - beforeOpposite : 0n,
        afterFill = move.after - opposite - baseline,
        available = lows[t][side] - baseline,
        retained = move.retained ?? move.shares;
      // Use the candidate side's actual fill price, not the opposite ask. If
      // the fill or what remains was ever neutral, a later hedge unwind is
      // not a new BUY. Ignore sub-dust offsets for a genuinely directional buy.
      return (
        afterFill <= 0n ||
        available <= 0n ||
        (move.shares - afterFill) * price >= dust * UNIT ||
        (retained - available) * price >= dust * UNIT
      );
    });
  }
  return (m: Market, move: Increase, price: bigint, dust: bigint) =>
    checks.get(exposureKey(m))?.(m.index, move, price, dust) === true;
}

/** Caller supplies one exact instrument, a complete ordered account-activity slice,
 * the venue position for reconciliation, and only a final condition payout.
 * Incomparable evidence is a gap, never a zero, win or synthetic sale. */
export function replay(
  actions: Action[],
  p: Position,
  m: Market,
  res: Resolution | undefined,
  floor: number,
  end: number,
): Ledger | null {
  if (
    !actions.length ||
    p.first < floor ||
    p.first <= 0 ||
    p.last < p.first ||
    p.last > end ||
    p.condition !== m.condition ||
    p.index !== m.index ||
    p.token !== m.instrument.tokenId
  )
    return null;
  // Descending source pages are reversed by the caller. Stable sort preserves venue
  // order within a second; no synthetic tx-hash/profit tie-break.
  const a = [...actions].sort((x, y) => x.time - y.time);
  if (a[0].time !== p.first) return null;
  let held = 0n,
    cost = 0n,
    stake = 0n,
    bought = 0n,
    net = 0n,
    reported = 0n,
    settled = false,
    unredeemed = 0n;
  const closes: Close[] = [],
    income: Ledger["income"] = [],
    moves: Increase[] = [];
  const exposure: NonNullable<Ledger["exposure"]> = [];
  const observeBalance = (at: number) => {
    const tail = exposure.at(-1);
    if (tail?.at === at) tail.shares = held;
    else exposure.push({ at, shares: held });
  };
  const close = (at: number) => {
    closes.push({
      at,
      net: abs(net) < 100n ? 0n : net,
      stake,
      shares: bought,
      instrument: m.instrument,
    });
    net = stake = bought = 0n;
    moves.length = 0;
  };
  const realize = (at: number, value: bigint) => {
    net += value;
    income.push({ at, net: value });
  };
  let settlementNet = 0n,
    basisConflict = false,
    settlementBasisDisclosed = false;
  // Native position totals cover the remaining shares (not the original order).
  // Use disclosed entry fees only when the native basis reconciles, never twice.
  const remainingBasis = () => {
    const native = p.remainingCost;
    if (!native) return cost;
    if (
      native.total < 0n ||
      native.entry < 0n ||
      native.fees < 0n ||
      abs(native.total - native.entry - native.fees) > 150n ||
      (abs(native.entry - cost) > 100n && abs(native.total - cost) > 100n)
    ) {
      basisConflict = true;
      return cost;
    }
    return native.total;
  };
  const settle = () => {
    settled = true;
    if (held === 0n || !res) return;
    unredeemed = held;
    const sameRemaining = p.shares > 0n && abs(held - p.shares) <= 100n;
    settlementBasisDisclosed = sameRemaining && p.remainingCost !== undefined;
    const basis = sameRemaining ? remainingBasis() : cost;
    settlementNet = (held * res.payout[p.index]) / UNIT - basis;
    realize(res.at, settlementNet);
    close(res.at);
    held = cost = 0n;
    observeBalance(res.at);
  };
  for (const x of a) {
    if (
      x.time > end ||
      x.time < floor ||
      x.condition !== p.condition ||
      x.token !== p.token ||
      x.index !== p.index ||
      x.cash < 0n ||
      x.shares <= 0n
    )
      return null;
    if (res && !settled && res.at <= x.time) settle();
    if (x.kind === "REDEEM") {
      // Activity and resolutions have separate clocks. The venue can timestamp
      // a real claim before publishing resolved_at. Only book the exact binary
      // payout once the official timestamp is inside this observation window.
      if (!settled && res && res.at <= end) settle();
      if (
        !settled ||
        !res ||
        abs(x.shares - unredeemed) > 100n ||
        abs(x.cash - (x.shares * res.payout[p.index]) / UNIT) > 100n
      )
        return null;
      unredeemed = 0n;
      reported += settlementNet;
      settlementNet = 0n;
      continue;
    }
    if (settled || x.kind !== "TRADE" || !x.tx) return null;
    if (x.side === "BUY") {
      if (x.cash <= 0n) return null;
      const last = moves.at(-1);
      if (
        last &&
        last.tx === x.tx &&
        last.at === x.time &&
        last.after === held
      ) {
        last.after += x.shares;
        last.cash += x.cash;
        last.shares += x.shares;
      } else
        moves.push({
          at: x.time,
          before: held,
          after: held + x.shares,
          cash: x.cash,
          shares: x.shares,
          tx: x.tx,
        });
      held += x.shares;
      cost += x.cash;
      stake += x.cash;
      bought += x.shares;
    } else if (x.side === "SELL") {
      if (x.shares > held || held === 0n) return null;
      const basis =
        x.shares === held ? cost : (cost * x.shares + held / 2n) / held;
      held -= x.shares;
      cost -= basis;
      const gross = x.cash - basis;
      // A complete lifetime with precisely one purchase and one final sale
      // needs no fee allocation. Require the CLOSED projection to agree on
      // quantity, flat basis, both clocks, and the entire gross-to-native
      // difference via disclosed BUY fees. Unknown sell fees, reopens and
      // settlement are intentionally left to the usual fallback.
      const native = p.remainingCost,
        buy = a[0];
      const soleSale =
        !res &&
        !m.terminal &&
        !p.redeemable &&
        a.length === 2 &&
        x === a[1] &&
        buy.side === "BUY" &&
        buy.time < x.time &&
        x.time === p.last &&
        buy.tx !== x.tx &&
        buy.cash <= buy.shares &&
        x.cash > 0n &&
        x.cash <= x.shares &&
        buy.shares === x.shares &&
        buy.shares === p.closedBoughtShares &&
        held === 0n &&
        p.shares === 0n &&
        p.unrealized === 0n &&
        native &&
        native.entry === 0n &&
        native.fees > 0n &&
        native.total === native.fees &&
        abs(gross - native.fees - p.pnl) <= 100n;
      const delta = soleSale ? p.pnl : gross;
      reported += delta;
      realize(x.time, delta);
      if (!held) close(x.time);
    } else return null;
    observeBalance(x.time);
  }
  if (res && !settled && res.at <= end) settle();
  // Public positions are rounded to four decimals. Larger discrepancies (fees,
  // transfers, missing fills, unknown basis) must not be distributed by guesswork.
  if ((p.redeemable || m.terminal) && held > 0n && !settled) return null;
  if (held > 0n) remainingBasis();
  // An outstanding claim's realized_pnl can still be the pre-resolution
  // total. In that case agreement with trade notional proves nothing about
  // acquisition fees. Require the disclosed remaining basis, or a separate
  // realized observation which distinguishes post- from pre-settlement P&L.
  if (
    unredeemed > 0n &&
    !settlementBasisDisclosed &&
    (abs(p.pnl - reported) <= 100n ||
      abs(p.pnl - reported - settlementNet) > 100n)
  )
    return null;
  if (
    basisConflict ||
    abs(p.shares - held - unredeemed) > 100n ||
    (abs(p.pnl - reported) > 100n &&
      !(
        settled &&
        unredeemed > 0n &&
        abs(p.pnl - reported - settlementNet) <= 100n
      ))
  )
    return null;
  return {
    closes,
    income,
    moves: held > 0n ? retainedIncreases(moves, held) : [],
    current: held,
    openLoss: held > 0n && p.unrealized < 0n ? -p.unrealized : 0n,
    first: p.first,
    exposure,
  };
}
