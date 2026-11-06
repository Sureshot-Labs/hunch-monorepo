import { isRecord } from "../lib/type-guards.js";

export type LimitlessOrderStatusItem = Readonly<{
  clientOrderId?: string | null;
  orderId: string;
  providerOrderId?: string | null;
  payload: Record<string, unknown>;
}>;

export type LimitlessExactClientOrderStatus =
  | Readonly<{
      kind: "found";
      item: LimitlessOrderStatusItem & {
        clientOrderId: string;
        providerOrderId: string;
      };
    }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "unknown"; reason: "malformed" | "unrecognized" }>;

export function isLimitlessExactStatusAbsenceMature(input: {
  ambiguousAt: Date | null;
  minimumAgeMs: number;
  now: Date;
}): boolean {
  return (
    input.ambiguousAt !== null &&
    Number.isSafeInteger(input.minimumAgeMs) &&
    input.minimumAgeMs > 0 &&
    input.now.getTime() - input.ambiguousAt.getTime() >= input.minimumAgeMs
  );
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function limitlessStatusResults(
  payload: unknown,
): Record<string, unknown>[] {
  return isRecord(payload) && Array.isArray(payload.results)
    ? payload.results.filter(isRecord)
    : [];
}

/** Preserve explicit absence for evidence reads, not for trade resubmission. */
export function interpretLimitlessVerifiedBuyOrderStatus(
  payload: unknown,
  lookup: { orderId?: string | null; clientOrderId?: string | null },
): Record<string, unknown> | null {
  const orderId = textOrNull(lookup.orderId);
  const clientOrderId = textOrNull(lookup.clientOrderId);
  const items = [
    ...(orderId ? [{ orderId }] : []),
    ...(clientOrderId ? [{ clientOrderId }] : []),
  ];
  const rawResults = isRecord(payload) ? payload.results : null;
  if (!items.length || !Array.isArray(rawResults)) return null;
  // Keep the former map's positive-evidence semantics: an exact found lookup
  // remains usable if another item is missing/unknown. Only absence requires
  // a complete, unambiguous response for every requested identity.
  let selected: Record<string, unknown> | null = null;
  for (const result of rawResults) {
    if (!isRecord(result) || result.status !== "found") continue;
    if (
      clientOrderId
        ? textOrNull(result.clientOrderId) === clientOrderId
        : textOrNull(result.orderId) === orderId
    )
      selected = result;
  }
  if (selected) return selected;
  if (rawResults.length !== items.length || !rawResults.every(isRecord))
    return null;
  const results = rawResults as Record<string, unknown>[];
  const hasIndices = results.some((result) => result.index !== undefined);
  const ordered = hasIndices
    ? items.map((_, index) =>
        results.filter((result) => result.index === index),
      )
    : results.map((result) => [result]);
  const checked: Record<string, unknown>[] = [];
  for (const matches of ordered) {
    const result = matches[0];
    if (matches.length !== 1 || !result) return null;
    checked.push(result);
  }
  if (
    checked.some((result, index) => {
      const item = items[index];
      if (!item) return true;
      return "orderId" in item
        ? textOrNull(result.orderId) !== item.orderId
        : textOrNull(result.clientOrderId) !== item.clientOrderId;
    })
  )
    return null;
  // Neither a conflict nor an unknown/error response becomes absence.
  if (!checked.every((result) => result.status === "not_found")) return null;
  if (
    checked.some((result) => {
      for (const field of ["orderId", "clientOrderId"]) {
        if (result[field] != null && !textOrNull(result[field])) return true;
      }
      const echoedOrderId = textOrNull(result.orderId);
      const echoedClientId = textOrNull(result.clientOrderId);
      return (
        (echoedOrderId && echoedOrderId !== orderId) ||
        (echoedClientId && echoedClientId !== clientOrderId)
      );
    })
  )
    return null;
  return { status: "not_found", orderId, clientOrderId };
}

export function interpretLimitlessExactClientOrderStatus(
  payload: unknown,
  clientOrderId: string,
): LimitlessExactClientOrderStatus {
  const expected = clientOrderId.trim();
  const results = limitlessStatusResults(payload);
  if (!expected || results.length !== 1) {
    return { kind: "unknown", reason: "malformed" };
  }
  const result = results[0];
  if (!result) return { kind: "unknown", reason: "malformed" };
  const echoedClientOrderId = textOrNull(result.clientOrderId);
  if (echoedClientOrderId !== expected) {
    return { kind: "unknown", reason: "malformed" };
  }
  if (result.status === "not_found") return { kind: "not_found" };
  if (result.status !== "found") {
    return { kind: "unknown", reason: "unrecognized" };
  }
  const providerOrderId = textOrNull(result.orderId);
  if (!providerOrderId) return { kind: "unknown", reason: "malformed" };
  return {
    kind: "found",
    item: {
      clientOrderId: echoedClientOrderId,
      orderId: providerOrderId,
      providerOrderId,
      payload: result,
    },
  };
}

export function interpretLimitlessExactClientOrderStatuses(
  payload: unknown,
  clientOrderIds: readonly string[],
): Map<string, LimitlessExactClientOrderStatus> {
  const results = limitlessStatusResults(payload);
  return new Map(
    clientOrderIds.map((clientOrderId) => {
      const normalized = clientOrderId.trim();
      const matching = results.filter(
        (result) => textOrNull(result.clientOrderId) === normalized,
      );
      return [
        normalized,
        interpretLimitlessExactClientOrderStatus(
          { results: matching },
          normalized,
        ),
      ];
    }),
  );
}
