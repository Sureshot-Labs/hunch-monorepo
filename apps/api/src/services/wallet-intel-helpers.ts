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

function normalizeOutcomeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function coerceOutcomeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const outcomes = value.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  return outcomes.some((entry) => entry.length > 0) ? outcomes : null;
}

export function parseMarketOutcomes(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return coerceOutcomeList(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return coerceOutcomeList(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

export function outcomeLabelForSide(
  outcomes: unknown,
  side: "YES" | "NO",
): string | null {
  const parsed = parseMarketOutcomes(outcomes);
  if (!parsed) return null;
  const raw = parsed[side === "YES" ? 0 : 1];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = normalizeOutcomeLabel(trimmed);
  if (normalized === "yes" || normalized === "no") return null;
  return trimmed;
}

export function outcomeLabelOrSide(
  outcomes: unknown,
  side: "YES" | "NO",
): string {
  return outcomeLabelForSide(outcomes, side) ?? side;
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
