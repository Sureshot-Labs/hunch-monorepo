import {
  formatUnsignedDecimal,
  parseUnsignedDecimal,
} from "../account-value/decimal.js";

export const COLLATERAL_SCALE = 1_000_000n;
const PRICE_SCALE = 10n ** 18n;
export const usd = (raw: bigint) => formatUnsignedDecimal(raw, 6);
const priceText = (raw: bigint) => formatUnsignedDecimal(raw, 18);

/** With zero price headroom, cents and 1e-4 shares must represent EXACTLY
 * the same tick price. Search this lattice instead of a non-monotone set of
 * rounded/unfillable quotes. Does not reduce explicitly entered amounts. */
export function exactBuyNotionalStep(price: string): bigint {
  const priceRaw = decimalRaw(price, 6);
  if (priceRaw <= 0n) throw new Error("invalid_price");
  const gcd = (a: bigint, b: bigint): bigint => {
    while (b) [a, b] = [b, a % b];
    return a;
  };
  const product = priceRaw * 100n;
  const makerStep = product / gcd(COLLATERAL_SCALE, product);
  return (10_000n * makerStep) / gcd(10_000n, makerStep);
}

export function decimalRaw(value: unknown, decimals: number): bigint {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("invalid_decimal");
  const text = String(value);
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw new Error("unsafe_numeric_decimal");
  const parsed = parseUnsignedDecimal(text);
  if (parsed.scale > 36 || text.length > 100)
    throw new Error("invalid_decimal");
  return parsed.scale <= decimals
    ? parsed.coefficient * 10n ** BigInt(decimals - parsed.scale)
    : parsed.coefficient / 10n ** BigInt(parsed.scale - decimals);
}

export type SpendLevel = { price: bigint; shares: bigint };
export type SpendDepth = {
  levels: SpendLevel[];
  bestAsk: string | null;
  priceLimit: string | null;
  capacityRaw: bigint;
};

/** Parse original decimal/raw strings, never round monetary levels through Number. */
export function readSpendLevels(
  payload: unknown,
  venue: "polymarket" | "limitless",
  complement = false,
): SpendLevel[] {
  if (!payload || typeof payload !== "object")
    throw new Error("invalid_orderbook");
  let raw = payload as Record<string, unknown>;
  if (raw.data && typeof raw.data === "object")
    raw = raw.data as Record<string, unknown>;
  if (raw.orderbook && typeof raw.orderbook === "object")
    raw = raw.orderbook as Record<string, unknown>;
  const rows = complement ? raw.bids : raw.asks;
  if (!Array.isArray(rows)) throw new Error("invalid_orderbook");
  const levels: SpendLevel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("invalid_orderbook");
    const price = decimalRaw(row.price, 18);
    const shares =
      venue === "limitless" ? decimalRaw(row.size, 0) : decimalRaw(row.size, 6);
    if (price <= 0n || price >= PRICE_SCALE || shares < 0n)
      throw new Error("invalid_orderbook");
    if (shares === 0n) continue;
    levels.push({ price: complement ? PRICE_SCALE - price : price, shares });
  }
  return levels.sort((a, b) =>
    a.price < b.price ? -1 : a.price > b.price ? 1 : 0,
  );
}

export function spendDepth(
  levels: SpendLevel[],
  tick: string,
  slippageBps: number,
): SpendDepth {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000)
    throw new Error("invalid_slippage");
  const tickRaw = decimalRaw(tick, 18);
  if (tickRaw <= 0n || tickRaw >= PRICE_SCALE) throw new Error("invalid_tick");
  const first = levels[0];
  if (!first)
    return { levels: [], bestAsk: null, priceLimit: null, capacityRaw: 0n };
  const best = first.price;
  let cap =
    ((best * BigInt(10_000 + slippageBps)) / 10_000n / tickRaw) * tickRaw;
  if (cap >= PRICE_SCALE) cap = ((PRICE_SCALE - 1n) / tickRaw) * tickRaw;
  const allowed = levels.filter((level) => level.price <= cap);
  const capacityRaw =
    allowed.reduce((sum, level) => sum + level.price * level.shares, 0n) /
    PRICE_SCALE;
  return {
    levels: allowed,
    bestAsk: priceText(best),
    priceLimit: priceText(cap),
    capacityRaw,
  };
}

export function walkSpend(depth: SpendDepth, amountRaw: bigint) {
  let remaining = amountRaw * PRICE_SCALE;
  let sharesRaw = 0n;
  let cost = 0n;
  let worst = 0n;
  for (const level of depth.levels) {
    const shares =
      remaining / level.price < level.shares
        ? remaining / level.price
        : level.shares;
    if (shares <= 0n) break;
    const paid = shares * level.price;
    sharesRaw += shares;
    cost += paid;
    remaining -= paid;
    worst = level.price;
    if (remaining < level.price) break;
  }
  return {
    expectedShares: usd(sharesRaw),
    averagePrice: sharesRaw > 0n ? priceText(cost / sharesRaw) : null,
    worstPrice: worst > 0n ? priceText(worst) : null,
  };
}

/** Search in cents using local fee arithmetic only; never call a provider here. */
export function capSpendByFunds(
  maxRaw: bigint,
  fundsRaw: bigint,
  required: (raw: bigint) => bigint | null,
  minimumRaw = 10_000n,
  amountStep = 10_000n,
): bigint | null {
  if (fundsRaw < minimumRaw || maxRaw < minimumRaw) return 0n;
  let low = (minimumRaw + amountStep - 1n) / amountStep;
  // Additional fees cannot make an order cheaper than its nominal. Avoid
  // querying the legacy fee calculator at huge amounts above available funds.
  let high = (maxRaw < fundsRaw ? maxRaw : fundsRaw) / amountStep;
  let best = 0n;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const debit = required(mid * amountStep);
    if (debit == null) return null;
    if (debit <= fundsRaw) {
      best = mid;
      low = mid + 1n;
    } else high = mid - 1n;
  }
  return best * amountStep;
}
