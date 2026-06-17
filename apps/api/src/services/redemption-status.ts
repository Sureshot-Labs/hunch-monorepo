export type NormalizedRedemptionStatusValue =
  | "market_open"
  | "closed"
  | "pending_resolution"
  | "settlement_pending"
  | "resolved_not_redeemable"
  | "redeemable"
  | "redeemed"
  | "failed_retryable";

export type NormalizedRedemptionStatus = {
  status: NormalizedRedemptionStatusValue;
  reasonCode: string;
  reason: string;
  redeemableAt: string | null;
  resolvedOutcome: "YES" | "NO" | null;
  resolvedOutcomePct: number | null;
  rawStatus: string | null;
};

export type NormalizeRedemptionStatusInput = {
  venue: string | null | undefined;
  marketStatus: string | null | undefined;
  closeTime?: unknown;
  expirationTime?: unknown;
  eventEndTime?: unknown;
  rawStatus?: string | null | undefined;
  resolvedOutcome?: string | null | undefined;
  resolvedOutcomePct?: unknown;
  outcomeSide?: string | null | undefined;
  positionSize?: number | null | undefined;
  now?: Date;
};

function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOutcome(value: string | null | undefined): "YES" | "NO" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "YES" || normalized === "NO" ? normalized : null;
}

function normalizeRaw(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function latestTerminalTime(
  input: Pick<
    NormalizeRedemptionStatusInput,
    "closeTime" | "expirationTime" | "eventEndTime"
  >,
): Date | null {
  const times = [input.closeTime, input.expirationTime, input.eventEndTime]
    .map(parseDate)
    .filter((date): date is Date => Boolean(date));
  if (times.length === 0) return null;
  return times.reduce((latest, candidate) =>
    candidate.getTime() > latest.getTime() ? candidate : latest,
  );
}

function buildStatus(
  input: NormalizeRedemptionStatusInput,
  status: NormalizedRedemptionStatusValue,
  reasonCode: string,
  reason: string,
  redeemableAt: Date | null,
): NormalizedRedemptionStatus {
  return {
    status,
    reasonCode,
    reason,
    redeemableAt: redeemableAt?.toISOString() ?? null,
    resolvedOutcome: normalizeOutcome(input.resolvedOutcome),
    resolvedOutcomePct: parseNumber(input.resolvedOutcomePct),
    rawStatus: normalizeRaw(input.rawStatus),
  };
}

function resolvedPayoutForOutcome(input: NormalizeRedemptionStatusInput): number | null {
  const outcomeSide = normalizeOutcome(input.outcomeSide);
  if (!outcomeSide) return null;

  const resolvedOutcome = normalizeOutcome(input.resolvedOutcome);
  if (resolvedOutcome) return resolvedOutcome === outcomeSide ? 1 : 0;

  const pctBps = parseNumber(input.resolvedOutcomePct);
  if (pctBps == null) return null;
  const yesPayout = Math.min(Math.max(pctBps / 10_000, 0), 1);
  return outcomeSide === "YES" ? yesPayout : 1 - yesPayout;
}

export function normalizeRedemptionStatus(
  input: NormalizeRedemptionStatusInput,
): NormalizedRedemptionStatus {
  const now = input.now ?? new Date();
  const marketStatus = input.marketStatus?.trim().toUpperCase() ?? null;
  const rawStatus = normalizeRaw(input.rawStatus);
  const rawLower = rawStatus?.toLowerCase() ?? "";
  const terminalTime = latestTerminalTime(input);
  const hasResolvedOutcome =
    normalizeOutcome(input.resolvedOutcome) != null ||
    parseNumber(input.resolvedOutcomePct) != null;
  const payoutForOutcome = resolvedPayoutForOutcome(input);
  const hasPositionSize =
    input.positionSize != null && Number.isFinite(input.positionSize);
  const positionSize = hasPositionSize ? Number(input.positionSize) : null;

  if (/(fail|error|retry)/i.test(rawLower)) {
    return buildStatus(
      input,
      "failed_retryable",
      "redemption_failed",
      "Redemption status could not be confirmed. Retry in a moment.",
      terminalTime,
    );
  }

  if (/(redeemed|claimed|no_redeemable_balance|no redeemable balance)/i.test(rawLower)) {
    return buildStatus(
      input,
      "redeemed",
      "no_redeemable_balance",
      "No redeemable balance remains for this position.",
      null,
    );
  }

  if (/pending[_\s-]?resolution/i.test(rawLower)) {
    return buildStatus(
      input,
      "pending_resolution",
      "pending_resolution",
      "Market is closed and waiting for resolution.",
      terminalTime,
    );
  }

  if (/(challenge|settlement|pending|processing|submitted|mined)/i.test(rawLower)) {
    return buildStatus(
      input,
      "settlement_pending",
      rawLower.includes("challenge") ? "challenge_window" : "settlement_pending",
      rawLower.includes("challenge")
        ? "Resolution is in the challenge window."
        : "Settlement is still pending.",
      terminalTime,
    );
  }

  if (!hasResolvedOutcome) {
    const isPastTerminal =
      terminalTime != null && terminalTime.getTime() <= now.getTime();
    if (marketStatus === "ACTIVE" && !isPastTerminal) {
      return buildStatus(
        input,
        "market_open",
        "market_open",
        "Market is still open.",
        terminalTime,
      );
    }
    if (marketStatus === "CLOSED") {
      return buildStatus(
        input,
        "pending_resolution",
        "pending_resolution",
        "Market is closed and waiting for resolution.",
        terminalTime,
      );
    }
    if (marketStatus === "SETTLED") {
      return buildStatus(
        input,
        "settlement_pending",
        "resolved_state_unavailable",
        "Market is settled but redemption details are not available yet.",
        terminalTime,
      );
    }
    return buildStatus(
      input,
      isPastTerminal ? "pending_resolution" : "closed",
      isPastTerminal ? "pending_resolution" : "market_closed",
      isPastTerminal
        ? "Market is waiting for resolution."
        : "Market is not currently accepting redemptions.",
      terminalTime,
    );
  }

  if (payoutForOutcome != null && payoutForOutcome <= 0) {
    return buildStatus(
      input,
      "resolved_not_redeemable",
      "resolved_zero_payout",
      "Outcome resolved against this position.",
      null,
    );
  }

  if (positionSize != null && positionSize <= 0) {
    return buildStatus(
      input,
      "redeemed",
      "no_redeemable_balance",
      "No redeemable balance remains for this position.",
      null,
    );
  }

  return buildStatus(
    input,
    "redeemable",
    rawLower.includes("ready") || rawLower.includes("redeem")
      ? "ready"
      : "resolved",
    "Position is resolved and redeemable.",
    null,
  );
}
