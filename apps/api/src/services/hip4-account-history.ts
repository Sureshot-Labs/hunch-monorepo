import { z } from "zod";
import {
  hip4HistoryRepairSchema,
  type Hip4HistoryRepair,
  type Hip4FillRepair,
} from "../schemas/hip4-account.js";

// Provider response/retention contracts, not configurable product limits.
export const HIP4_FILL_PAGE_MAX = 2000;
export const hip4FillPageSchema = z
  .array(z.record(z.string(), z.unknown()))
  .max(HIP4_FILL_PAGE_MAX);

/** Resume a fixed interval: moving the end on every refresh can starve repair.
 * Once exhausted, overlap its end with the next interval. A larger/smaller
 * policy lookback starts a new scan, without deleting any captured executions.
 */
function planHip4HistoryRepair(
  previous: unknown,
  lookbackMs: number,
  now: number,
  maxGapDetails: number,
  source: Hip4HistoryRepair["source"],
): Hip4HistoryRepair {
  const parsed = hip4HistoryRepairSchema.safeParse(previous);
  const saved =
    parsed.success && parsed.data.source === source ? parsed.data : null;
  const validCursor =
    saved != null &&
    saved.startTime <= saved.endTime &&
    saved.endTime <= now &&
    (saved.nextTime == null ||
      (saved.nextTime >= saved.startTime && saved.nextTime <= saved.endTime));
  // A damaged derived cursor is not a financial fact: replay the bounded
  // window and diagnose the reset instead of requiring manual cache surgery.
  // Persisted execution identities still deduplicate the replay.
  const continuing = validCursor && saved.lookbackMs === lookbackMs;
  const nextTime = continuing && saved.nextTime != null ? saved.nextTime : null;
  const startTime = continuing
    ? nextTime != null
      ? saved.startTime
      : saved.coveredFrom == null
        ? Math.max(0, now - lookbackMs)
        : saved.endTime
    : Math.max(0, now - lookbackMs);
  return {
    version: 1,
    source,
    providerRetentionLimited: true,
    lookbackMs,
    startTime,
    endTime: nextTime != null && saved ? saved.endTime : now,
    nextTime: nextTime ?? startTime,
    pagesRead: continuing && nextTime != null ? saved.pagesRead : 0,
    lastAttemptAt: saved?.lastAttemptAt ?? null,
    lastSuccessAt: saved?.lastSuccessAt ?? null,
    lastError: null,
    gaps: (saved?.gaps ?? []).slice(-maxGapDetails),
    gapCount: saved?.gapCount ?? 0,
    gapDetailsTruncated:
      (saved?.gapDetailsTruncated ?? false) ||
      (saved?.gaps.length ?? 0) > maxGapDetails,
    cursorResetCount:
      (saved?.cursorResetCount ?? 0) +
      (previous != null && !validCursor ? 1 : 0),
    // Old cursors have no coverage proof; only a new exhausted scan establishes
    // one. Continuing adjacent scans extend it without claiming all-time data.
    coveredFrom: continuing ? saved.coveredFrom : null,
    coveredThrough: continuing ? saved.coveredThrough : null,
  };
}

/** Only call after every selected HIP fill has passed its full wire projection.
 * Count/validate the entire provider page before filtering to HIP: spot/perp
 * fills consume the same provider cap and determine the pagination boundary.
 */
function advanceHip4HistoryRepair(
  state: Hip4HistoryRepair,
  rows: Record<string, unknown>[],
  observedAt: string,
  maxGapDetails: number,
): Hip4HistoryRepair {
  const isFill = state.source === "hyperliquid_user_fills_by_time";
  const cap = isFill ? HIP4_FILL_PAGE_MAX : 500;
  if (state.nextTime == null) throw new Error("history_range_exhausted");
  let lastTime = state.nextTime;
  for (const row of rows) {
    if (
      (isFill && (typeof row.coin !== "string" || !row.coin)) ||
      !Number.isSafeInteger(row.time) ||
      typeof row.time !== "number" ||
      row.time < lastTime ||
      row.time > state.endTime
    )
      throw new Error("invalid_history_page_order");
    lastTime = row.time;
  }
  if (rows.length > HIP4_FILL_PAGE_MAX)
    throw new Error("invalid_history_page_size");
  const saturated = rows.length >= cap && lastTime === state.nextTime;
  const exhausted = rows.length < cap;
  const priorAdjacent =
    state.coveredThrough != null && state.coveredThrough >= state.startTime;
  const gaps =
    saturated && !state.gaps.some((gap) => gap.time === lastTime)
      ? [
          ...state.gaps,
          { time: lastTime, reason: "timestamp_saturated" as const },
        ]
      : state.gaps;
  return {
    ...state,
    // Never silently +1 past a capped tied timestamp. Record the unpageable
    // millisecond first, then continue later history instead of looping forever.
    nextTime:
      rows.length < cap
        ? null
        : saturated
          ? lastTime === state.endTime
            ? null
            : lastTime + 1
          : lastTime,
    pagesRead: state.pagesRead + 1,
    lastAttemptAt: observedAt,
    lastSuccessAt: observedAt,
    lastError: null,
    gaps: gaps.slice(-maxGapDetails),
    gapCount: state.gapCount + (gaps.length > state.gaps.length ? 1 : 0),
    gapDetailsTruncated:
      state.gapDetailsTruncated || gaps.length > maxGapDetails,
    coveredFrom: exhausted
      ? priorAdjacent
        ? (state.coveredFrom ?? state.startTime)
        : state.startTime
      : state.coveredFrom,
    coveredThrough: exhausted ? state.endTime : state.coveredThrough,
  };
}

export function planHip4FillRepair(
  previous: unknown,
  lookbackMs: number,
  now: number,
  maxGapDetails: number,
): Hip4FillRepair {
  return {
    ...planHip4HistoryRepair(
      previous,
      lookbackMs,
      now,
      maxGapDetails,
      "hyperliquid_user_fills_by_time",
    ),
    source: "hyperliquid_user_fills_by_time",
  };
}
export function advanceHip4FillRepair(
  state: Hip4FillRepair,
  rows: Record<string, unknown>[],
  observedAt: string,
  maxGapDetails: number,
): Hip4FillRepair {
  return {
    ...advanceHip4HistoryRepair(state, rows, observedAt, maxGapDetails),
    source: "hyperliquid_user_fills_by_time",
  };
}
export function planHip4LedgerRepair(
  previous: unknown,
  lookbackMs: number,
  now: number,
  maxGapDetails: number,
) {
  return {
    ...planHip4HistoryRepair(
      previous,
      lookbackMs,
      now,
      maxGapDetails,
      "hyperliquid_non_funding_ledger",
    ),
    source: "hyperliquid_non_funding_ledger" as const,
  };
}
export function advanceHip4LedgerRepair(
  state: ReturnType<typeof planHip4LedgerRepair>,
  rows: Record<string, unknown>[],
  observedAt: string,
  maxGapDetails: number,
) {
  return {
    ...advanceHip4HistoryRepair(state, rows, observedAt, maxGapDetails),
    source: "hyperliquid_non_funding_ledger" as const,
  };
}
