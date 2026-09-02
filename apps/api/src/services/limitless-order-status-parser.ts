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
