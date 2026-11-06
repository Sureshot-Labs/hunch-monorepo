import { isRecord } from "../lib/type-guards.js";
import {
  limitlessClobSubmittedOrder,
  limitlessClobSubmittedPayloads,
  buildLimitlessClobSubmissionContext,
  resolveLimitlessClobEvidenceIdentity,
} from "./limitless-clob-evidence-identity.js";
import { parseLimitlessOrderResult } from "./limitless-order-result.js";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};
type Fallback =
  | {
      ready: true;
      providerOrderId: string;
      txHash: string;
      exchangeAddress: string;
      orderHash: string;
    }
  | { ready: false; reason: string };

/** A stored transaction reference is only a locator. No history amount/status is proof. */
export function resolveLimitlessReceiptFallback(input: {
  payload: Record<string, unknown>;
  providerOrderId: string | null;
  clientOrderId: string | null;
  owner: string;
  tokenId: string;
  marketMetadata: unknown;
  legacyExchangeAddress: string;
}): Fallback {
  const providerOrderId = text(input.providerOrderId);
  if (!providerOrderId || providerOrderId.startsWith("client:"))
    return { ready: false, reason: "provider_order_identity_conflict" };
  const submitted = limitlessClobSubmittedPayloads(input.payload);
  const localOrder = limitlessClobSubmittedOrder(input.payload);
  const identity = resolveLimitlessClobEvidenceIdentity({
    orderPayload: input.payload,
    marketMetadata: input.marketMetadata,
    legacyExchangeAddress: input.legacyExchangeAddress,
    providerOrder: {},
  });
  if (
    !identity ||
    !localOrder ||
    String(localOrder.maker).toLowerCase() !== input.owner.toLowerCase() ||
    String(localOrder.tokenId) !== input.tokenId ||
    String(localOrder.side) !== "0"
  )
    return { ready: false, reason: "signed_order_identity_missing" };
  const history = record(input.payload.history);
  const providerRefs = new Set<string>();
  const clientRefs = new Set<string>();
  const hashes = new Set<string>();
  let malformedReference = false;
  const addRefs = (
    source: Record<string, unknown>,
    fields: string[],
    refs: Set<string>,
  ) => {
    for (const field of fields) {
      const value = source[field];
      if (value == null || value === "") continue;
      const ref =
        typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : text(value);
      if (ref) refs.add(ref);
      else malformedReference = true;
    }
  };
  const addHash = (value: unknown) => {
    const hash = text(value);
    if (hash && /^0x[0-9a-f]{64}$/i.test(hash)) hashes.add(hash.toLowerCase());
  };
  const addHashes = (source: Record<string, unknown>) => {
    for (const field of ["transactionHash", "txHash", "tx_hash"])
      addHash(source[field]);
  };
  addRefs(
    history,
    ["orderId", "order_id", "venueOrderId", "venue_order_id"],
    providerRefs,
  );
  addRefs(record(history.order), ["id", "orderId", "order_id"], providerRefs);
  addRefs(history, ["clientOrderId", "client_order_id"], clientRefs);
  addRefs(
    record(history.order),
    ["clientOrderId", "client_order_id"],
    clientRefs,
  );
  addHashes(history);
  for (const snapshot of submitted) {
    addRefs(snapshot, ["clientOrderId", "client_order_id"], clientRefs);
    const upstream = record(snapshot._hunchUpstream);
    const parsed = parseLimitlessOrderResult(upstream);
    // Compare every known supplied signed field against the complete local
    // order. Null/missing provider fields cannot disable checks on other fields.
    const suppliedOrder = record(parsed.order);
    let signedFieldsAgree = false;
    try {
      const suppliedFields = Object.fromEntries(
        Object.entries(suppliedOrder).filter(([, value]) => value != null),
      );
      signedFieldsAgree =
        buildLimitlessClobSubmissionContext(identity.exchangeAddress, {
          ...localOrder,
          ...suppliedFields,
        }).orderHash.toLowerCase() === identity.orderHash.toLowerCase();
    } catch {
      /* malformed supplied field */
    }
    if (
      !signedFieldsAgree ||
      ["orderHash", "hash"].some((field) => {
        const value = suppliedOrder[field];
        return (
          value != null &&
          (typeof value !== "string" ||
            value.toLowerCase() !== identity.orderHash.toLowerCase())
        );
      })
    )
      return { ready: false, reason: "signed_order_identity_missing" };
    if (parsed.venueOrderId) {
      providerRefs.add(parsed.venueOrderId);
      addHash(parsed.txHash);
    }
    addRefs(record(parsed.order), ["id", "orderId", "order_id"], providerRefs);
    addRefs(
      record(parsed.order),
      ["clientOrderId", "client_order_id"],
      clientRefs,
    );
    const data = record(upstream.data);
    const wrapper = record(data.order);
    for (const envelope of [upstream, data, wrapper, suppliedOrder]) {
      addRefs(
        envelope,
        ["orderId", "order_id", "venueOrderId", "venue_order_id"],
        providerRefs,
      );
      addRefs(envelope, ["clientOrderId", "client_order_id"], clientRefs);
    }
    for (const candidate of [
      upstream.execution,
      record(upstream.order).execution,
      data.execution,
      wrapper.execution,
    ]) {
      const execution = record(candidate);
      addRefs(execution, ["orderId", "order_id"], providerRefs);
      addRefs(execution, ["clientOrderId", "client_order_id"], clientRefs);
      addHashes(execution);
    }
  }
  // A canonical purchase key must remain tied to the provider identity, not
  // merely to an arbitrary local UUID pointing at somebody's valid receipt.
  if (
    malformedReference ||
    providerRefs.size !== 1 ||
    !providerRefs.has(providerOrderId) ||
    clientRefs.size > 1 ||
    (input.clientOrderId && !clientRefs.has(input.clientOrderId))
  )
    return { ready: false, reason: "provider_order_identity_conflict" };
  if (hashes.size !== 1)
    return {
      ready: false,
      reason: hashes.size
        ? "evidence_identity_conflict"
        : "fill_transaction_identity_missing",
    };
  const txHash = [...hashes][0];
  if (!txHash)
    return { ready: false, reason: "fill_transaction_identity_missing" };
  return { ready: true, providerOrderId, txHash, ...identity };
}
