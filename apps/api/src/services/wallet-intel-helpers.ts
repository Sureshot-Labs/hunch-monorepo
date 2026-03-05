export const WALLET_INTEL_EMPTY_OUTCOME_SIDE = "";

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
