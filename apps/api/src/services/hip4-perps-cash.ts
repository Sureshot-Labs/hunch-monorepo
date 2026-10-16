import { z } from "zod";
import { hip4RawUnits } from "@hunch/shared";
import type { Hip4PerpsCashObservation } from "../schemas/hip4-account.js";

const decimal = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
const summary = z
  .object({
    accountValue: decimal,
    totalRawUsd: decimal,
    totalMarginUsed: decimal,
    totalNtlPos: decimal,
  })
  .passthrough();
/** Official clearinghouseState, first/native perp DEX only. Do not infer free
 * cash from equity, withdrawable alone, positions, or a receipt's old amount. */
export const hip4PerpsCashStateSchema = z
  .object({
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: decimal,
    withdrawable: decimal,
    assetPositions: z.array(z.unknown()),
    time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .passthrough();

export function projectHip4PerpsCash(input: {
  state: unknown;
  mode: string;
  role: string;
  observedAt: string;
  now: number;
}): Hip4PerpsCashObservation {
  const unavailable = (
    state: "unavailable" | "unsupported",
    reason: Hip4PerpsCashObservation["reason"],
  ): Hip4PerpsCashObservation => ({
    observedAt: input.observedAt,
    state,
    totalRaw: null,
    availableRaw: null,
    reason,
  });
  if (input.mode !== "disabled" || input.role !== "user")
    return unavailable("unsupported", "unsupported_cash_mode");
  try {
    const state = hip4PerpsCashStateSchema.parse(input.state);
    if (
      state.time > input.now ||
      !Number.isFinite(Date.parse(input.observedAt))
    )
      return unavailable("unavailable", "invalid_cash");
    if (
      state.assetPositions.length ||
      [
        state.marginSummary.totalMarginUsed,
        state.marginSummary.totalNtlPos,
        state.crossMarginSummary.totalMarginUsed,
        state.crossMarginSummary.totalNtlPos,
        state.crossMaintenanceMarginUsed,
      ].some((value) => hip4RawUnits(value, 8) !== 0n)
    )
      return unavailable("unsupported", "margin_inventory");
    const total = hip4RawUnits(state.marginSummary.totalRawUsd, 8);
    const available = hip4RawUnits(state.withdrawable, 8);
    if (
      total < 0n ||
      available < 0n ||
      available > total ||
      [
        state.marginSummary.accountValue,
        state.crossMarginSummary.accountValue,
        state.crossMarginSummary.totalRawUsd,
      ].some((value) => hip4RawUnits(value, 8) !== total)
    )
      return unavailable("unavailable", "invalid_cash");
    return {
      observedAt: new Date(
        Math.min(Date.parse(input.observedAt), state.time),
      ).toISOString(),
      state: "verified",
      totalRaw: total.toString(),
      availableRaw: available.toString(),
      reason: "cash_only",
    };
  } catch {
    return unavailable("unavailable", "invalid_cash");
  }
}
