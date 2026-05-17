export type ClobBookEntry = {
  price?: string | number | null;
  size?: string | number | null;
  side?: string | null;
};

type BookLevel = {
  price: number;
  size: number;
};

type BookSide = Map<string, BookLevel>;

export type ClobBookState = {
  bids: BookSide;
  asks: BookSide;
};

export type ClobBookTop = {
  bestBid: number | null;
  bestAsk: number | null;
};

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function priceKey(price: number): string {
  return String(price);
}

export function createClobBookState(): ClobBookState {
  return {
    bids: new Map(),
    asks: new Map(),
  };
}

function applyLevels(
  side: BookSide,
  levels: ClobBookEntry[] | undefined,
): void {
  for (const level of levels ?? []) {
    const price = parseFiniteNumber(level.price);
    const size = parseFiniteNumber(level.size);
    if (price == null || size == null) continue;

    const key = priceKey(price);
    if (size <= 0) {
      side.delete(key);
      continue;
    }

    side.set(key, { price, size });
  }
}

export function applyClobBookUpdate(
  state: ClobBookState,
  update: {
    bids?: ClobBookEntry[];
    asks?: ClobBookEntry[];
  },
): ClobBookTop {
  applyLevels(state.bids, update.bids);
  applyLevels(state.asks, update.asks);
  return getClobBookTop(state);
}

export function getClobBookTop(state: ClobBookState): ClobBookTop {
  let bestBid: number | null = null;
  for (const level of state.bids.values()) {
    if (bestBid == null || level.price > bestBid) bestBid = level.price;
  }

  let bestAsk: number | null = null;
  for (const level of state.asks.values()) {
    if (bestAsk == null || level.price < bestAsk) bestAsk = level.price;
  }

  return { bestBid, bestAsk };
}

function sortedLevels(
  side: BookSide,
  order: "asc" | "desc",
  depth: number,
): Array<{ price: number; size: number; side: "BUY" | "SELL" }> {
  return Array.from(side.values())
    .sort((left, right) =>
      order === "asc" ? left.price - right.price : right.price - left.price,
    )
    .slice(0, depth)
    .map((level) => ({
      price: level.price,
      size: level.size,
      side: order === "desc" ? "BUY" : "SELL",
    }));
}

export function buildClobBookSnapshot(
  tokenId: string,
  state: ClobBookState,
  timestamp: string,
  depth = 20,
) {
  const resolvedDepth = Math.max(1, Math.trunc(depth));
  return {
    token_id: tokenId,
    bids: sortedLevels(state.bids, "desc", resolvedDepth),
    asks: sortedLevels(state.asks, "asc", resolvedDepth),
    timestamp,
  };
}
