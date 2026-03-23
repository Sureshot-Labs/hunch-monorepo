export const POLYMARKET_UNCONFIRMED_STATUS = "unconfirmed" as const;

export type PolymarketUnconfirmedResolution =
  | "matched"
  | "unmatched"
  | typeof POLYMARKET_UNCONFIRMED_STATUS;

export type PolymarketOnchainOrderExecutionSummary = {
  makerAmount: bigint;
  remaining: bigint;
  makerFilled: bigint;
  isFilledOrCancelled: boolean;
  hasExecution: boolean;
};

export function summarizePolymarketOnchainOrderExecution(inputs: {
  makerAmount: bigint;
  remaining: bigint;
  isFilledOrCancelled: boolean;
}): PolymarketOnchainOrderExecutionSummary {
  const makerAmount = inputs.makerAmount >= 0n ? inputs.makerAmount : 0n;
  const remainingRaw = inputs.remaining >= 0n ? inputs.remaining : 0n;
  const remaining =
    remainingRaw > makerAmount ? makerAmount : remainingRaw;
  const makerFilled = makerAmount > remaining ? makerAmount - remaining : 0n;

  return {
    makerAmount,
    remaining,
    makerFilled,
    isFilledOrCancelled: inputs.isFilledOrCancelled,
    hasExecution: makerFilled > 0n,
  };
}

export function resolvePolymarketUnconfirmedStatus(
  summary: Pick<
    PolymarketOnchainOrderExecutionSummary,
    "hasExecution" | "isFilledOrCancelled"
  >,
): PolymarketUnconfirmedResolution {
  if (summary.hasExecution) return "matched";
  if (summary.isFilledOrCancelled) return "unmatched";
  return POLYMARKET_UNCONFIRMED_STATUS;
}

export function isPolymarketUnconfirmedStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return status.trim().toLowerCase() === POLYMARKET_UNCONFIRMED_STATUS;
}
