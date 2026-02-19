export const NET_SHARES_EPSILON = 1e-9;

export type ApproxPnlLegInput = {
  outcomeSide: "YES" | "NO";
  netShares: number;
  netCost: number;
  resolvedOutcome?: string | null;
  markPrice?: number | null;
};

function isFiniteNumber(value: number | null | undefined): value is number {
  return Number.isFinite(value);
}

export function clampProbability(
  value: number | null | undefined,
): number | null {
  if (!isFiniteNumber(value)) return null;
  return Math.max(0, Math.min(1, value));
}

export function computeApproxLegMarkValueUsd(
  input: ApproxPnlLegInput,
): number | null {
  if (!isFiniteNumber(input.netShares)) return null;
  if (input.netShares < NET_SHARES_EPSILON) return null;

  const resolved = input.resolvedOutcome?.trim().toUpperCase() ?? null;
  if (resolved === "YES" || resolved === "NO") {
    return input.outcomeSide === resolved ? input.netShares : 0;
  }

  const mark = clampProbability(input.markPrice);
  if (mark == null) return null;
  if (input.outcomeSide === "YES") return mark * input.netShares;
  return (1 - mark) * input.netShares;
}

export function computeApproxLegPnlUsd(input: ApproxPnlLegInput): number | null {
  const markValue = computeApproxLegMarkValueUsd(input);
  if (markValue == null) return null;
  if (!isFiniteNumber(input.netCost)) return null;
  return markValue - input.netCost;
}
