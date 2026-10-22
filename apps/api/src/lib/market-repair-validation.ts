export type RepairValidationState = "verified" | "deferred" | "error";

export function kalshiRepairPayloadError(
  market: Record<string, unknown>,
  expectedTicker: string,
): string | null {
  const ticker = market.ticker ?? market.marketTicker ?? market.market_ticker;
  if (
    typeof ticker !== "string" ||
    ticker.trim().toLowerCase() !== expectedTicker.trim().toLowerCase()
  )
    return "kalshi_public_identity_mismatch";
  const status =
    typeof market.status === "string" ? market.status.trim().toLowerCase() : "";
  if (
    ![
      "active",
      "open",
      "initialized",
      "unopened",
      "archived",
      "finalized",
      "finalised",
      "determined",
      "settled",
      "resolved",
      "closed",
      "expired",
      "halted",
      "suspended",
      "inactive",
      "paused",
      "cancelled",
      "canceled",
      "void",
    ].includes(status)
  )
    return "kalshi_public_invalid_status";
  return null;
}

/** Missing upstream records are not proof of closure. Keep them unchanged and
 * revisit on the next sweep, without starving later pages. Unknown failures
 * remain errors; only explicit not-found results are deferred. */
export function repairValidationState(
  targetStatus: string | null,
  reason: string,
): RepairValidationState {
  if (
    targetStatus !== null ||
    ["gamma_active", "limitless_active", "dflow_active"].includes(reason)
  )
    return "verified";
  if (["gamma_not_found", "limitless_not_found"].includes(reason))
    return "deferred";
  return "error";
}

export function summarizeRepairValidations(
  rows: Array<{ validation_state: RepairValidationState }>,
) {
  const counts = { verified: 0, deferred: 0, errors: 0 };
  for (const row of rows) {
    if (row.validation_state === "error") counts.errors += 1;
    else counts[row.validation_state] += 1;
  }
  return counts;
}

/** Retry a stale slug by its stable venue ID, once and only after a 404.
 * Rate-limit retries remain owned by the existing shared request wrapper. */
export async function lookupLimitlessRepairMarket(
  candidate: { slug: string | null; venue_market_id: string },
  request: (
    reference: string,
  ) => Promise<{ ok: boolean; status?: number; payload: unknown }>,
  unwrap: (payload: unknown) => Record<string, unknown> | null,
): Promise<
  | { kind: "found"; market: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "error"; reason: string }
> {
  const references = [
    ...new Set(
      [candidate.slug, candidate.venue_market_id].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  for (const reference of references) {
    const response = await request(reference);
    if (!response.ok && response.status === 404) continue;
    if (!response.ok)
      return {
        kind: "error",
        reason: `limitless_error:${response.status ?? "unknown"}`,
      };
    const market = unwrap(response.payload);
    if (!market) return { kind: "error", reason: "limitless_invalid_payload" };
    // Do not apply another market's status/outcome if a slug has been reused.
    if (String(market.id ?? "") !== candidate.venue_market_id)
      return { kind: "error", reason: "limitless_identity_mismatch" };
    return { kind: "found", market };
  }
  return references.length
    ? { kind: "not_found" }
    : { kind: "error", reason: "limitless_missing_market_ref" };
}
