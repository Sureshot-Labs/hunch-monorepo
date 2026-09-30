import { isRecord } from "../lib/type-guards.js";

function orderId(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/** Stats v1 returns { stringValue, bytesValue, ... } rows, not just strings.
 * Accept only unambiguous canonical IDs; arbitrary DTO fields are not IDs. */
export function extractDebridgeOrderIds(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !Array.isArray(payload.orderIds)) return [];
  const ids: string[] = [];
  for (const item of payload.orderIds) {
    const plain = orderId(item);
    if (plain) {
      ids.push(plain);
      continue;
    }
    if (!isRecord(item)) return [];
    const stringId = orderId(item.stringValue);
    const bytesId = orderId(item.bytesValue);
    if (stringId && bytesId && stringId !== bytesId) return [];
    const id = stringId ?? bytesId;
    if (!id) return [];
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** An existing (even well-formed) legacy ID may be a stale quote's ID.
 * Repair only a unique source-associated order, never the first of many. */
export function uniqueDebridgeSourceOrderId(payload: unknown): string | null {
  const ids = extractDebridgeOrderIds(payload);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}
