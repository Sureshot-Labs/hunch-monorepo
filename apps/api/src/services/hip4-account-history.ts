import { z } from "zod";
import {
  hip4FillRepairSchema,
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
export function planHip4FillRepair(
  previous: unknown,
  lookbackMs: number,
  now: number,
  maxGapDetails: number,
): Hip4FillRepair {
  const parsed = hip4FillRepairSchema.safeParse(previous);
  const saved = parsed.success ? parsed.data : null;
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
      : saved.endTime
    : Math.max(0, now - lookbackMs);
  return {
    version: 1,
    source: "hyperliquid_user_fills_by_time",
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
  };
}

/** Only call after every selected HIP fill has passed its full wire projection.
 * Count/validate the entire provider page before filtering to HIP: spot/perp
 * fills consume the same provider cap and determine the pagination boundary.
 */
export function advanceHip4FillRepair(
  state: Hip4FillRepair,
  rows: Record<string, unknown>[],
  observedAt: string,
  maxGapDetails: number,
): Hip4FillRepair {
  if (state.nextTime == null) throw new Error("history_range_exhausted");
  let lastTime = state.nextTime;
  for (const row of rows) {
    if (
      typeof row.coin !== "string" ||
      !row.coin ||
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
  const saturated =
    rows.length === HIP4_FILL_PAGE_MAX && lastTime === state.nextTime;
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
      rows.length < HIP4_FILL_PAGE_MAX
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
  };
}
