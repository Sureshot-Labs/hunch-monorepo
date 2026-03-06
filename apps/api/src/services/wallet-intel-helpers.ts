export const WALLET_INTEL_EMPTY_OUTCOME_SIDE = "";

type OutcomeSideLike = {
  outcome_side: string | null | undefined;
};

export function normalizeOutcomeSideForStorage(
  value: string | null | undefined,
): "" | "YES" | "NO" {
  if (!value) return WALLET_INTEL_EMPTY_OUTCOME_SIDE;
  const normalized = value.trim().toUpperCase();
  if (normalized === "YES" || normalized === "NO") return normalized;
  return WALLET_INTEL_EMPTY_OUTCOME_SIDE;
}

export function normalizeOutcomeSideForApi(
  value: string | null | undefined,
): "YES" | "NO" | null {
  const normalized = normalizeOutcomeSideForStorage(value);
  return normalized === WALLET_INTEL_EMPTY_OUTCOME_SIDE ? null : normalized;
}

export function shouldSuppressLegacySideTransitionDelta(inputs: {
  currentRows: OutcomeSideLike[];
  previousRows: OutcomeSideLike[];
}): boolean {
  if (inputs.currentRows.length === 0 || inputs.previousRows.length === 0) {
    return false;
  }

  const previousSides = new Set(
    inputs.previousRows.map((row) =>
      normalizeOutcomeSideForStorage(row.outcome_side),
    ),
  );
  if (
    previousSides.size !== 1 ||
    !previousSides.has(WALLET_INTEL_EMPTY_OUTCOME_SIDE)
  ) {
    return false;
  }

  return inputs.currentRows.some(
    (row) =>
      normalizeOutcomeSideForStorage(row.outcome_side) !==
      WALLET_INTEL_EMPTY_OUTCOME_SIDE,
  );
}
