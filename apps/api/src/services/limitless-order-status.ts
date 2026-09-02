import {
  interpretLimitlessExactClientOrderStatus,
  limitlessStatusResults,
  type LimitlessExactClientOrderStatus,
  type LimitlessOrderStatusItem,
} from "./limitless-order-status-parser.js";

export {
  interpretLimitlessExactClientOrderStatus,
  interpretLimitlessExactClientOrderStatuses,
  isLimitlessExactStatusAbsenceMature,
  type LimitlessExactClientOrderStatus,
  type LimitlessOrderStatusItem,
} from "./limitless-order-status-parser.js";

const LIMITLESS_STATUS_BATCH_MAX_ITEMS = 50;

export type LimitlessOrderStatusLookup = Readonly<{
  clientOrderId?: string | null;
  orderId?: string | null;
}>;

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function fetchLimitlessExactClientOrderStatus(
  clientOrderId: string,
): Promise<LimitlessExactClientOrderStatus> {
  const { extractLimitlessMessage, limitlessRequest } =
    await import("./limitless-client.js");
  const normalized = clientOrderId.trim();
  if (!normalized) return { kind: "unknown", reason: "malformed" };
  const upstream = await limitlessRequest({
    auth: "partner_hmac",
    body: { items: [{ clientOrderId: normalized }] },
    method: "POST",
    requestPath: "/orders/status/batch",
  });
  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless exact order status failed (${upstream.status}): ${message}`
        : `Limitless exact order status failed (${upstream.status}).`,
    );
  }
  return interpretLimitlessExactClientOrderStatus(upstream.payload, normalized);
}

/**
 * Resolves the exact provider identity recorded before a CLOB submission.
 * Portfolio history is deliberately not a recovery source: it only sees
 * fills, whereas this endpoint also reports accepted open and no-fill orders.
 */
export async function fetchLimitlessOrderStatusBatch(
  lookups: readonly LimitlessOrderStatusLookup[],
): Promise<Map<string, LimitlessOrderStatusItem>> {
  const { extractLimitlessMessage, limitlessRequest } =
    await import("./limitless-client.js");
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
    for (const result of limitlessStatusResults(upstream.payload)) {
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
