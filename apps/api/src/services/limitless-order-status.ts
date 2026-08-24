import { isRecord } from "../lib/type-guards.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";

const LIMITLESS_STATUS_BATCH_MAX_ITEMS = 50;

export type LimitlessOrderStatusItem = Readonly<{
  clientOrderId?: string | null;
  /** Lookup key retained for existing status consumers. */
  orderId: string;
  /** Provider order id; null only when the provider returned a malformed hit. */
  providerOrderId?: string | null;
  payload: Record<string, unknown>;
}>;

export type LimitlessOrderStatusLookup = Readonly<{
  clientOrderId?: string | null;
  orderId?: string | null;
}>;

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusResults(payload: unknown): Record<string, unknown>[] {
  return isRecord(payload) && Array.isArray(payload.results)
    ? payload.results.filter(isRecord)
    : [];
}

/**
 * Resolves the exact provider identity recorded before a CLOB submission.
 * Portfolio history is deliberately not a recovery source: it only sees
 * fills, whereas this endpoint also reports accepted open and no-fill orders.
 */
export async function fetchLimitlessOrderStatusBatch(
  lookups: readonly LimitlessOrderStatusLookup[],
): Promise<Map<string, LimitlessOrderStatusItem>> {
  const items = lookups.flatMap((lookup) => {
    const orderId = lookup.orderId?.trim();
    const clientOrderId = lookup.clientOrderId?.trim();
    return [
      ...(orderId ? [{ orderId }] : []),
      ...(clientOrderId ? [{ clientOrderId }] : []),
    ];
  });
  const statuses = new Map<string, LimitlessOrderStatusItem>();
  for (
    let offset = 0;
    offset < items.length;
    offset += LIMITLESS_STATUS_BATCH_MAX_ITEMS
  ) {
    const batch = items.slice(
      offset,
      offset + LIMITLESS_STATUS_BATCH_MAX_ITEMS,
    );
    const upstream = await limitlessRequest({
      auth: "partner_hmac",
      body: { items: batch },
      method: "POST",
      requestPath: "/orders/status/batch",
    });
    if (!upstream.ok) {
      const message = extractLimitlessMessage(upstream.payload);
      throw new Error(
        message
          ? `Limitless order status batch failed (${upstream.status}): ${message}`
          : `Limitless order status batch failed (${upstream.status}).`,
      );
    }
    for (const result of statusResults(upstream.payload)) {
      if (result.status !== "found") continue;
      const clientOrderId = textOrNull(result.clientOrderId);
      const providerOrderId = textOrNull(result.orderId);
      const orderId = providerOrderId ?? clientOrderId;
      if (!orderId) continue;
      const item = {
        clientOrderId,
        orderId,
        providerOrderId,
        payload: result,
      } satisfies LimitlessOrderStatusItem;
      if (providerOrderId) statuses.set(providerOrderId, item);
      if (clientOrderId) statuses.set(`client:${clientOrderId}`, item);
    }
  }
  return statuses;
}

export async function fetchLimitlessOrderStatusByClientOrderIds(
  clientOrderIds: readonly string[],
): Promise<Map<string, LimitlessOrderStatusItem>> {
  const all = await fetchLimitlessOrderStatusBatch(
    clientOrderIds.map((clientOrderId) => ({ clientOrderId })),
  );
  const found = new Map<string, LimitlessOrderStatusItem>();
  for (const clientOrderId of clientOrderIds) {
    const item = all.get(`client:${clientOrderId.trim()}`);
    if (item) found.set(clientOrderId.trim(), item);
  }
  return found;
}
