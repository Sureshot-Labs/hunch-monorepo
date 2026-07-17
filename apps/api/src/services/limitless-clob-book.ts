import { normalizeLimitlessRawTokenId } from "../lib/limitless-token.js";
import { isRecord } from "../lib/type-guards.js";

export type LimitlessClobSide = "BUY" | "SELL";

export type LimitlessClobBookLevel = {
  price: number;
  size: number;
};

export type LimitlessClobBook = {
  asks: LimitlessClobBookLevel[];
  bids: LimitlessClobBookLevel[];
  minOrderNotionalUsd: number;
  tokenId: string;
};

export type LimitlessClobDepthQuote =
  | {
      status: "ready";
      availableShares: number;
      averagePrice: number;
      executableShares: number;
      minOrderNotionalUsd: number;
      totalNotional: number;
      worstPrice: number;
    }
  | {
      status: "insufficient_depth" | "no_liquidity" | "unavailable";
      availableShares: number;
      minOrderNotionalUsd: number | null;
    };

const LIMITLESS_AMOUNT_SCALE = 1_000_000;

function positiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveRawAmount(value: unknown): number | null {
  const raw = positiveNumber(value);
  return raw == null ? null : raw / LIMITLESS_AMOUNT_SCALE;
}

function parseLevels(value: unknown): LimitlessClobBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const price = positiveNumber(entry.price);
      const size = positiveRawAmount(entry.size);
      return price != null && price < 1 && size != null
        ? { price, size }
        : null;
    })
    .filter((entry): entry is LimitlessClobBookLevel => entry != null);
}

export function parseLimitlessClobBook(
  payload: unknown,
): LimitlessClobBook | null {
  const data =
    isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const nested =
    isRecord(data) && isRecord(data.orderbook) ? data.orderbook : data;
  if (!isRecord(nested)) return null;

  const rawTokenId =
    typeof nested.tokenId === "string" ||
    typeof nested.tokenId === "number" ||
    typeof nested.tokenId === "bigint"
      ? nested.tokenId
      : typeof nested.token_id === "string" ||
          typeof nested.token_id === "number" ||
          typeof nested.token_id === "bigint"
        ? nested.token_id
        : null;
  const tokenId = normalizeLimitlessRawTokenId(rawTokenId);
  const minOrderNotionalUsd = positiveRawAmount(
    nested.minSize ?? nested.min_size ?? nested.minOrderSize,
  );
  if (!tokenId || minOrderNotionalUsd == null) return null;

  return {
    asks: parseLevels(nested.asks),
    bids: parseLevels(nested.bids),
    minOrderNotionalUsd,
    tokenId,
  };
}

export function limitlessClobLevelsForToken(input: {
  book: LimitlessClobBook;
  side: LimitlessClobSide;
  tokenId: string;
}): LimitlessClobBookLevel[] | null {
  const directTokenId = normalizeLimitlessRawTokenId(input.book.tokenId);
  const targetTokenId = normalizeLimitlessRawTokenId(input.tokenId);
  if (!directTokenId || !targetTokenId) return null;

  const direct = directTokenId === targetTokenId;
  if (input.side === "BUY") {
    return (
      direct
        ? input.book.asks
        : input.book.bids.map((level) => ({
            price: 1 - level.price,
            size: level.size,
          }))
    )
      .filter((level) => level.price > 0 && level.price < 1)
      .sort((left, right) => left.price - right.price);
  }

  return (
    direct
      ? input.book.bids
      : input.book.asks.map((level) => ({
          price: 1 - level.price,
          size: level.size,
        }))
  )
    .filter((level) => level.price > 0 && level.price < 1)
    .sort((left, right) => right.price - left.price);
}

export function quoteLimitlessClobDepth(input: {
  amountShares?: number | null;
  amountUsd?: number | null;
  book: LimitlessClobBook;
  limitPrice?: number | null;
  side: LimitlessClobSide;
  tokenId: string;
}): LimitlessClobDepthQuote {
  const amountShares = positiveNumber(input.amountShares);
  const amountUsd = positiveNumber(input.amountUsd);
  if ((amountShares == null) === (amountUsd == null)) {
    return {
      status: "unavailable",
      availableShares: 0,
      minOrderNotionalUsd: input.book.minOrderNotionalUsd,
    };
  }

  const limitPrice = positiveNumber(input.limitPrice);
  if (limitPrice != null && limitPrice >= 1) {
    return {
      status: "unavailable",
      availableShares: 0,
      minOrderNotionalUsd: input.book.minOrderNotionalUsd,
    };
  }

  const oriented = limitlessClobLevelsForToken(input);
  if (!oriented) {
    return {
      status: "unavailable",
      availableShares: 0,
      minOrderNotionalUsd: input.book.minOrderNotionalUsd,
    };
  }
  const levels = oriented.filter((level) => {
    if (limitPrice == null) return true;
    return input.side === "BUY"
      ? level.price <= limitPrice + 1e-9
      : level.price + 1e-9 >= limitPrice;
  });
  const availableShares = levels.reduce((sum, level) => sum + level.size, 0);
  if (availableShares <= 1e-9) {
    return {
      status: "no_liquidity",
      availableShares: 0,
      minOrderNotionalUsd: input.book.minOrderNotionalUsd,
    };
  }

  let remainingShares = amountShares;
  let remainingUsd = amountUsd;
  let executableShares = 0;
  let totalNotional = 0;
  let worstPrice = 0;

  for (const level of levels) {
    let takenShares: number;
    if (remainingShares != null) {
      takenShares = Math.min(level.size, remainingShares);
      remainingShares -= takenShares;
    } else {
      const remaining = remainingUsd ?? 0;
      takenShares = Math.min(level.size, remaining / level.price);
      remainingUsd = Math.max(0, remaining - takenShares * level.price);
    }
    if (takenShares <= 0) continue;
    executableShares += takenShares;
    totalNotional += takenShares * level.price;
    worstPrice = level.price;
    if (
      (remainingShares != null && remainingShares <= 1e-9) ||
      (remainingUsd != null && remainingUsd <= 1e-9)
    ) {
      break;
    }
  }

  if (
    (remainingShares != null && remainingShares > 1e-9) ||
    (remainingUsd != null && remainingUsd > 1e-9)
  ) {
    return {
      status: "insufficient_depth",
      availableShares,
      minOrderNotionalUsd: input.book.minOrderNotionalUsd,
    };
  }

  return {
    status: "ready",
    availableShares,
    averagePrice: totalNotional / executableShares,
    executableShares,
    minOrderNotionalUsd: input.book.minOrderNotionalUsd,
    totalNotional,
    worstPrice,
  };
}
