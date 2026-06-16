import type { DbQuery } from "../db.js";
import {
  getTradeCartDetail,
  patchTradeCartItem,
  type TradeCart,
  type TradeCartItem,
} from "../repos/trade-carts-repo.js";

export type TradeCartAllocationMode =
  | "manual"
  | "equal_notional"
  | "weighted_notional";

export type TradeCartAllocationSnapshot = {
  mode: TradeCartAllocationMode;
  totalAmountRaw: string | null;
  items: Array<{
    cartItemId: string;
    amountRaw: string;
    allocationWeight: string | null;
  }>;
};

export class TradeCartAllocationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "TradeCartAllocationError";
  }
}

function parseUnsignedRaw(value: string | null | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function parseWeight(value: string | number | null | undefined): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return parseWeight(value.toString());
  }
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const normalizedFraction = fraction.slice(0, 9).padEnd(9, "0");
  const scaled = BigInt(whole) * 1_000_000_000n + BigInt(normalizedFraction);
  return scaled > 0n ? scaled : null;
}

function ensureExecutableItems(items: TradeCartItem[]): TradeCartItem[] {
  return items.filter((item) => item.status !== "removed" && item.status !== "skipped");
}

function allocateRemainderByOrder(
  allocations: bigint[],
  remainder: bigint,
): bigint[] {
  const next = [...allocations];
  for (let index = 0; index < next.length && remainder > 0n; index += 1) {
    next[index] += 1n;
    remainder -= 1n;
  }
  return next;
}

export function buildTradeCartAllocationSnapshot(input: {
  mode: TradeCartAllocationMode;
  items: TradeCartItem[];
  totalAmountRaw?: string | null;
  itemAmounts?: Record<string, string>;
  itemWeights?: Record<string, number>;
}): TradeCartAllocationSnapshot {
  const executableItems = ensureExecutableItems(input.items);

  if (input.mode === "manual") {
    const snapshotItems = executableItems.map((item) => {
      const amountRaw = input.itemAmounts?.[item.id] ?? item.amountRaw;
      const parsedAmount = parseUnsignedRaw(amountRaw);
      if (parsedAmount == null || parsedAmount <= 0n) {
        throw new TradeCartAllocationError(
          `Missing manual amount for cart item ${item.id}`,
        );
      }
      return {
        cartItemId: item.id,
        amountRaw: parsedAmount.toString(),
        allocationWeight: item.allocationWeight,
      };
    });

    return {
      mode: input.mode,
      totalAmountRaw: snapshotItems
        .reduce((sum, item) => sum + BigInt(item.amountRaw), 0n)
        .toString(),
      items: snapshotItems,
    };
  }

  const totalAmountRaw = parseUnsignedRaw(input.totalAmountRaw);
  if (totalAmountRaw == null || totalAmountRaw <= 0n) {
    throw new TradeCartAllocationError("totalAmountRaw is required");
  }
  if (executableItems.length === 0) {
    return {
      mode: input.mode,
      totalAmountRaw: totalAmountRaw.toString(),
      items: [],
    };
  }

  if (input.mode === "equal_notional") {
    const count = BigInt(executableItems.length);
    const baseAmount = totalAmountRaw / count;
    const remainder = totalAmountRaw % count;
    const allocations = allocateRemainderByOrder(
      executableItems.map(() => baseAmount),
      remainder,
    );

    return {
      mode: input.mode,
      totalAmountRaw: totalAmountRaw.toString(),
      items: executableItems.map((item, index) => ({
        cartItemId: item.id,
        amountRaw: allocations[index].toString(),
        allocationWeight: item.allocationWeight,
      })),
    };
  }

  const weights = executableItems.map((item) => {
    const rawWeight = input.itemWeights?.[item.id] ?? item.allocationWeight;
    const weight = parseWeight(rawWeight);
    if (weight == null) {
      throw new TradeCartAllocationError(
        `Missing allocation weight for cart item ${item.id}`,
      );
    }
    return weight;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight <= 0n) {
    throw new TradeCartAllocationError("At least one positive weight is required");
  }

  const baseAllocations = weights.map(
    (weight) => (totalAmountRaw * weight) / totalWeight,
  );
  const allocated = baseAllocations.reduce((sum, amount) => sum + amount, 0n);
  const allocations = allocateRemainderByOrder(
    baseAllocations,
    totalAmountRaw - allocated,
  );

  return {
    mode: input.mode,
    totalAmountRaw: totalAmountRaw.toString(),
    items: executableItems.map((item, index) => ({
      cartItemId: item.id,
      amountRaw: allocations[index].toString(),
      allocationWeight: (
        input.itemWeights?.[item.id] ?? item.allocationWeight
      )?.toString() ?? null,
    })),
  };
}

export async function allocateTradeCart(
  db: DbQuery,
  input: {
    userId: string;
    cartId: string;
    mode: TradeCartAllocationMode;
    totalAmountRaw?: string | null;
    itemAmounts?: Record<string, string>;
    itemWeights?: Record<string, number>;
  },
): Promise<{
  cart: TradeCart;
  items: TradeCartItem[];
  allocationSnapshot: TradeCartAllocationSnapshot;
} | null> {
  const detail = await getTradeCartDetail(db, {
    userId: input.userId,
    cartId: input.cartId,
  });
  if (!detail) return null;

  const allocationSnapshot = buildTradeCartAllocationSnapshot({
    mode: input.mode,
    items: detail.items,
    totalAmountRaw: input.totalAmountRaw,
    itemAmounts: input.itemAmounts,
    itemWeights: input.itemWeights,
  });

  for (const item of allocationSnapshot.items) {
    const patch =
      input.mode === "weighted_notional"
        ? {
            amountRaw: item.amountRaw,
            allocationWeight: item.allocationWeight,
          }
        : { amountRaw: item.amountRaw };
    await patchTradeCartItem(db, {
      userId: input.userId,
      cartId: input.cartId,
      itemId: item.cartItemId,
      patch,
    });
  }

  const updatedDetail = await getTradeCartDetail(db, {
    userId: input.userId,
    cartId: input.cartId,
  });

  return {
    cart: updatedDetail?.cart ?? detail.cart,
    items: updatedDetail?.items ?? detail.items,
    allocationSnapshot,
  };
}
