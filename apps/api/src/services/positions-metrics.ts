import type { Pool } from "@hunch/infra";
import type { PgParams } from "../server-types.js";
import { updatePositionMetrics } from "../repos/positions-repo.js";

const USDC_DECIMALS = 6;
const RAW_DECIMALS = 1_000_000;
const EXECUTED_STATUSES = new Set([
  "matched",
  "filled",
  "partially_filled",
]);

type PositionSnapshot = {
  tokenId: string;
  size: number;
};

type TradeFill = {
  tokenId: string;
  side: "BUY" | "SELL";
  shares: number;
  usdc: number;
  timestamp: Date;
};

function computeBuyAveragePrice(fills: TradeFill[]): number | null {
  let shares = 0;
  let usdc = 0;

  for (const fill of fills) {
    if (fill.side !== "BUY") continue;
    shares += fill.shares;
    usdc += fill.usdc;
  }

  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(usdc) || usdc <= 0) return null;

  const average = usdc / shares;
  return Number.isFinite(average) && average > 0 ? average : null;
}

type MarkRow = {
  token_id: string;
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  outcome_side: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBigInt(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function parseRawAmount(value: unknown, decimals = USDC_DECIMALS): number | null {
  const raw = parseBigInt(value);
  if (raw == null) return null;
  const scale = Math.pow(10, decimals);
  return Number(raw) / scale;
}

function parseLimitlessAmount(value: unknown): number | null {
  const parsed = parseNumber(value);
  if (parsed == null) return null;
  return parsed > RAW_DECIMALS ? parsed / RAW_DECIMALS : parsed;
}

function normalizeLimitlessPrice(value: unknown): number | null {
  const parsed = parseNumber(value);
  if (parsed == null) return null;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function normalizeSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if (upper === "BUY" || upper === "SELL") return upper;
  }
  if (typeof value === "number") {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function resolveResolvedMark(row: MarkRow): number | null {
  const side = row.outcome_side?.toUpperCase();
  if (side !== "YES" && side !== "NO") return null;

  const resolvedOutcome = row.resolved_outcome?.toUpperCase();
  if (resolvedOutcome === "YES" || resolvedOutcome === "NO") {
    return resolvedOutcome === side ? 1 : 0;
  }

  const resolvedPctRaw = parseNumber(row.resolved_outcome_pct);
  if (resolvedPctRaw != null) {
    const yesPrice = clamp01(resolvedPctRaw / 10000);
    return side === "YES" ? yesPrice : 1 - yesPrice;
  }

  return null;
}

function normalizePayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(payload) ? payload : null;
}

function extractPayloadAmounts(
  payload: unknown,
): { makerAmount: bigint; takerAmount: bigint } | null {
  const record = normalizePayload(payload);
  if (!record) return null;
  const makerAmount = parseBigInt(record.makerAmount);
  const takerAmount = parseBigInt(record.takerAmount);
  if (makerAmount == null || takerAmount == null) return null;
  return { makerAmount, takerAmount };
}

function buildPolymarketFill(row: {
  token_id: string | null;
  side: string | null;
  status: string | null;
  price: string | number | null;
  size: string | number | null;
  filled_size: string | number | null;
  average_fill_price: string | number | null;
  order_payload: unknown;
  filled_at: Date | null;
  posted_at: Date | null;
  last_update: Date | null;
}): TradeFill | null {
  if (!row.token_id) return null;
  const payload = normalizePayload(row.order_payload);
  const side = normalizeSide(row.side ?? payload?.side);
  if (!side) return null;

  const status = row.status?.toLowerCase() ?? "";
  const hasFill =
    (parseNumber(row.filled_size) ?? 0) > 0 ||
    (parseNumber(row.average_fill_price) ?? 0) > 0;
  if (!hasFill && !EXECUTED_STATUSES.has(status)) return null;

  let shares = 0;
  let usdc = 0;

  const filledSize = parseNumber(row.filled_size);
  const avgFillPrice = parseNumber(row.average_fill_price);
  if (filledSize != null && filledSize > 0 && avgFillPrice != null) {
    shares = filledSize;
    usdc = filledSize * avgFillPrice;
  } else {
    const price = parseNumber(row.price);
    const size = parseNumber(row.size);
    if (price != null && size != null && size > 0) {
      shares = size;
      usdc = price * size;
    } else {
      const payloadAmounts = extractPayloadAmounts(payload);
      if (!payloadAmounts) return null;
      const maker = payloadAmounts.makerAmount;
      const taker = payloadAmounts.takerAmount;
      if (side === "BUY") {
        usdc = Number(maker) / RAW_DECIMALS;
        shares = Number(taker) / RAW_DECIMALS;
      } else {
        shares = Number(maker) / RAW_DECIMALS;
        usdc = Number(taker) / RAW_DECIMALS;
      }
    }
  }

  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(usdc) || usdc <= 0) return null;

  const timestamp =
    row.filled_at ?? row.posted_at ?? row.last_update ?? new Date(0);

  return {
    tokenId: row.token_id,
    side,
    shares,
    usdc,
    timestamp,
  };
}

function buildDflowFill(row: {
  side: string | null;
  input_mint: string | null;
  output_mint: string | null;
  amount_in: string | null;
  amount_out: string | null;
  input_decimals: number | null;
  output_decimals: number | null;
  created_at: Date;
}): TradeFill | null {
  const side = normalizeSide(row.side);
  if (!side) return null;

  let tokenId: string | null = null;
  let sharesRaw: number | null = null;
  let usdcRaw: number | null = null;
  const inputDecimals = row.input_decimals ?? USDC_DECIMALS;
  const outputDecimals = row.output_decimals ?? USDC_DECIMALS;

  if (side === "BUY") {
    if (!row.output_mint) return null;
    tokenId = `sol:${row.output_mint}`;
    sharesRaw = parseRawAmount(row.amount_out, outputDecimals);
    usdcRaw = parseRawAmount(row.amount_in, inputDecimals);
  } else {
    if (!row.input_mint) return null;
    tokenId = `sol:${row.input_mint}`;
    sharesRaw = parseRawAmount(row.amount_in, inputDecimals);
    usdcRaw = parseRawAmount(row.amount_out, outputDecimals);
  }

  if (tokenId == null || sharesRaw == null || usdcRaw == null) return null;
  if (!Number.isFinite(sharesRaw) || sharesRaw <= 0) return null;
  if (!Number.isFinite(usdcRaw) || usdcRaw <= 0) return null;

  return {
    tokenId,
    side,
    shares: sharesRaw,
    usdc: usdcRaw,
    timestamp: row.created_at ?? new Date(0),
  };
}

export function buildLimitlessFill(row: {
  token_id: string | null;
  side: string | null;
  status: string | null;
  price: string | number | null;
  size: string | number | null;
  order_payload: unknown;
  filled_at: Date | null;
  posted_at: Date | null;
  last_update: Date | null;
}): TradeFill | null {
  if (!row.token_id) return null;
  const payload = normalizePayload(row.order_payload);
  const side = normalizeSide(row.side ?? payload?.side);
  if (!side) return null;

  const status = row.status?.toLowerCase() ?? "";
  const isExecuted =
    row.filled_at != null || EXECUTED_STATUSES.has(status) || status === "filled";
  if (!isExecuted) {
    return null;
  }

  let shares: number | null = null;
  let usdc: number | null = null;

  const size = parseNumber(row.size);
  const price = normalizeLimitlessPrice(row.price);
  if (size != null && size > 0 && price != null) {
    shares = size;
    usdc = size * price;
  } else {
    const outcomeAmount = parseLimitlessAmount(
      payload?.outcomeTokenAmount ?? payload?.outcome_token_amount,
    );
    const outcomePrice = normalizeLimitlessPrice(
      payload?.outcomeTokenPrice ?? payload?.outcome_token_price,
    );
    if (outcomeAmount != null && outcomeAmount > 0 && outcomePrice != null) {
      shares = outcomeAmount;
      usdc = outcomeAmount * outcomePrice;
    } else {
      const collateral = parseLimitlessAmount(
        payload?.collateralAmount ?? payload?.collateral_amount,
      );
      if (collateral != null && collateral > 0 && price != null) {
        shares = collateral / price;
        usdc = collateral;
      }
    }
  }

  if (!Number.isFinite(shares) || shares == null || shares <= 0) return null;
  if (!Number.isFinite(usdc) || usdc == null || usdc <= 0) return null;

  const timestamp =
    row.filled_at ?? row.posted_at ?? row.last_update ?? new Date(0);

  return {
    tokenId: row.token_id,
    side,
    shares,
    usdc,
    timestamp,
  };
}

function computeMetrics(
  fills: TradeFill[],
  currentSize: number,
  markPrice: number | null,
): {
  averagePrice: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  computedSize: number;
  hasUnmatchedSells: boolean;
} {
  const ordered = [...fills].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  let size = 0;
  let costBasis = 0;
  let realizedPnl = 0;
  let hasUnmatchedSells = false;

  for (const fill of ordered) {
    if (fill.side === "BUY") {
      size += fill.shares;
      costBasis += fill.usdc;
      continue;
    }

    if (size <= 0) {
      hasUnmatchedSells = true;
      continue;
    }

    const sellSize = Math.min(fill.shares, size);
    const avg = costBasis / size;
    const sellFraction = sellSize / fill.shares;
    const proceeds = fill.usdc * sellFraction;

    realizedPnl += proceeds - avg * sellSize;
    costBasis -= avg * sellSize;
    size -= sellSize;

    if (fill.shares > sellSize) {
      hasUnmatchedSells = true;
    }
  }

  let averagePrice: number | null = null;
  if (size > 0) {
    averagePrice = costBasis / size;
  }

  if (!Number.isFinite(currentSize) || currentSize <= 0) {
    return {
      averagePrice: null,
      realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0,
      unrealizedPnl: 0,
      computedSize: size,
      hasUnmatchedSells,
    };
  }

  if (averagePrice == null || !Number.isFinite(averagePrice)) {
    return {
      averagePrice: null,
      realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0,
      unrealizedPnl: 0,
      computedSize: size,
      hasUnmatchedSells,
    };
  }

  const unrealizedPnl =
    markPrice != null && Number.isFinite(markPrice)
      ? (markPrice - averagePrice) * currentSize
      : 0;

  return {
    averagePrice,
    realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0,
    unrealizedPnl: Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0,
    computedSize: size,
    hasUnmatchedSells,
  };
}

async function fetchPositionSnapshots(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; venue: string },
): Promise<PositionSnapshot[]> {
  const { rows } = await pool.query<{ token_id: string; size: string }>(
    `
      select token_id, size
      from positions
      where user_id = $1
        and (wallet_address is null or wallet_address = $2)
        and venue = $3
        and position_scope = 'own'
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue],
  );

  return rows.map((row) => ({
    tokenId: row.token_id,
    size: parseNumber(row.size) ?? 0,
  }));
}

async function fetchMarksByToken(
  pool: Pool,
  tokenIds: string[],
): Promise<Map<string, number | null>> {
  if (tokenIds.length === 0) return new Map();

  const { rows } = await pool.query<MarkRow>(
    `
      select
        mt.token_id,
        top.best_bid,
        top.best_ask,
        top.mid,
        mt.outcome_side,
        m.resolved_outcome,
        m.resolved_outcome_pct::text as resolved_outcome_pct
      from unified_market_tokens mt
      left join lateral (
        select
          ubt.best_bid,
          ubt.best_ask,
          ubt.mid
        from unified_book_top ubt
        where ubt.token_id = mt.token_id
        order by ubt.ts desc
        limit 1
      ) top on true
      left join unified_markets m
        on m.id = mt.market_id
      where mt.token_id = any($1::text[])
    `,
    [tokenIds],
  );

  const map = new Map<string, number | null>();
  for (const row of rows) {
    const resolvedMark = resolveResolvedMark(row);
    if (resolvedMark != null) {
      map.set(row.token_id, resolvedMark);
      continue;
    }
    const bid = parseNumber(row.best_bid);
    const ask = parseNumber(row.best_ask);
    const mid = parseNumber(row.mid);
    map.set(row.token_id, bid ?? mid ?? ask ?? null);
  }
  return map;
}

async function fetchPolymarketFills(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; tokenIds: string[] },
): Promise<TradeFill[]> {
  if (inputs.tokenIds.length === 0) return [];

  const params: PgParams = [
    inputs.userId,
    inputs.walletAddress,
    inputs.tokenIds,
  ];

  const { rows } = await pool.query<{
    token_id: string | null;
    side: string | null;
    status: string | null;
    price: string | null;
    size: string | null;
    filled_size: string | null;
    average_fill_price: string | null;
    order_payload: unknown;
    filled_at: Date | null;
    posted_at: Date | null;
    last_update: Date | null;
  }>(
    `
      select
        token_id,
        side,
        status,
        price,
        size,
        filled_size,
        average_fill_price,
        order_payload,
        filled_at,
        posted_at,
        last_update
      from orders
      where user_id = $1
        and (wallet_address is null or wallet_address = $2)
        and venue = 'polymarket'
        and token_id = any($3::text[])
    `,
    params,
  );

  return rows
    .map((row) => buildPolymarketFill(row))
    .filter((fill): fill is TradeFill => Boolean(fill));
}

async function fetchDflowFills(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; tokenIds: string[] },
): Promise<TradeFill[]> {
  const mintIds = inputs.tokenIds
    .filter((tokenId) => tokenId.startsWith("sol:"))
    .map((tokenId) => tokenId.replace(/^sol:/, ""));
  if (mintIds.length === 0) return [];

  const { rows } = await pool.query<{
    side: string | null;
    input_mint: string | null;
    output_mint: string | null;
    amount_in: string | null;
    amount_out: string | null;
    input_decimals: number | null;
    output_decimals: number | null;
    created_at: Date;
  }>(
    `
      select
        side,
        input_mint,
        output_mint,
        amount_in,
        amount_out,
        input_decimals,
        output_decimals,
        created_at
      from executions
      where user_id = $1
        and (wallet_address is null or wallet_address = $2)
        and venue = 'kalshi'
        and (
          input_mint = any($3::text[])
          or output_mint = any($3::text[])
        )
    `,
    [inputs.userId, inputs.walletAddress, mintIds],
  );

  return rows
    .map((row) => buildDflowFill(row))
    .filter((fill): fill is TradeFill => Boolean(fill));
}

async function fetchLimitlessFills(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; tokenIds: string[] },
): Promise<TradeFill[]> {
  if (inputs.tokenIds.length === 0) return [];

  const { rows } = await pool.query<{
    token_id: string | null;
    side: string | null;
    status: string | null;
    price: string | null;
    size: string | null;
    order_payload: unknown;
    filled_at: Date | null;
    posted_at: Date | null;
    last_update: Date | null;
  }>(
    `
      select
        token_id,
        side,
        status,
        price,
        size,
        order_payload,
        filled_at,
        posted_at,
        last_update
      from orders
      where user_id = $1
        and (wallet_address is null or wallet_address = $2)
        and venue = 'limitless'
        and token_id = any($3::text[])
    `,
    [inputs.userId, inputs.walletAddress, inputs.tokenIds],
  );

  return rows
    .map((row) => buildLimitlessFill(row))
    .filter((fill): fill is TradeFill => Boolean(fill));
}

export async function recomputePositionMetricsForWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: "polymarket" | "kalshi" | "limitless";
  },
): Promise<void> {
  const positions = await fetchPositionSnapshots(pool, inputs);
  if (positions.length === 0) return;

  const tokenIds = positions.map((pos) => pos.tokenId);
  const [marks, fills] = await Promise.all([
    fetchMarksByToken(pool, tokenIds),
    inputs.venue === "polymarket"
      ? fetchPolymarketFills(pool, {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          tokenIds,
        })
      : inputs.venue === "limitless"
        ? fetchLimitlessFills(pool, {
            userId: inputs.userId,
            walletAddress: inputs.walletAddress,
            tokenIds,
          })
      : fetchDflowFills(pool, {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          tokenIds,
        }),
  ]);

  const fillsByToken = new Map<string, TradeFill[]>();
  for (const fill of fills) {
    const list = fillsByToken.get(fill.tokenId) ?? [];
    list.push(fill);
    fillsByToken.set(fill.tokenId, list);
  }

  const metrics = positions.map((position) => {
    const tokenFills = fillsByToken.get(position.tokenId) ?? [];
    const markPrice = marks.get(position.tokenId) ?? null;
    const {
      averagePrice,
      realizedPnl,
      unrealizedPnl,
      computedSize,
      hasUnmatchedSells,
    } = computeMetrics(tokenFills, position.size, markPrice);
    const sizeDelta = Math.abs(position.size - computedSize);
    const tolerance = Math.max(0.01, Math.abs(position.size) * 0.05);
    const reliable = !hasUnmatchedSells && sizeDelta <= tolerance;
    const fallbackAveragePrice =
      !reliable &&
      (inputs.venue === "polymarket" || inputs.venue === "limitless")
        ? computeBuyAveragePrice(tokenFills)
        : null;
    const averagePriceValue = reliable ? averagePrice : fallbackAveragePrice;

    return {
      tokenId: position.tokenId,
      averagePrice: averagePriceValue,
      realizedPnl: reliable ? realizedPnl : 0,
      unrealizedPnl: reliable ? unrealizedPnl : 0,
    };
  });

  await updatePositionMetrics(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: inputs.venue,
    metrics,
  });
}
