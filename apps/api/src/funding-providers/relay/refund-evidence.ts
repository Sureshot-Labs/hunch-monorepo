import { hip4RawUnits } from "@hunch/shared";
import type { AssetLocation, Money } from "../../funding/domain/types.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../../funding/domain/asset-identity.js";
import {
  hypercoreLocationDex,
  isHypercoreMainnetUsdc,
  RELAY_HYPERCORE_PERPS_CURRENCY,
} from "../../funding/domain/hypercore-identity.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../funding/reconciliation/owned-route-destination-observer.js";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import { receiveRoleEventFingerprint } from "../../funding/receive/receive-role-progress.js";
import { RELAY_HYPERCORE_EVM_STABLE_SOURCE_ASSETS } from "./mappings.js";
import {
  RELAY_REQUEST_TRANSACTION_LIMIT,
  type RelayRequestEvidence,
} from "./request-evidence.js";
import type { RelayStatusResponse } from "./schemas.js";
import {
  hypercoreDestinationEvent,
  relayHypercoreTransactionSchema,
  verifyRelayHypercoreTransfer,
  hypercoreTransactionFingerprint,
} from "./hypercore-transfer-evidence.js";

type RefundTransaction = NonNullable<
  RelayRequestEvidence["data"]["outTxs"]
>[number];
export type RelayRefundExpectation = Readonly<{
  requestId: string;
  protocolOrderId: string;
  source: AssetLocation;
  sourceAmount: Money;
  /** Only committed refund_location_snapshot locations, never provider targets. */
  refundLocations: readonly AssetLocation[];
}>;
export type RelayRefundReceiptPlan = Readonly<{
  target: AssetLocation;
  expectedReturned: Money;
  transactions: readonly RefundTransaction[];
  transactionHashes: readonly string[];
  ledgerSeconds: readonly number[];
  providerTerminal: boolean;
  /** Corroboration fingerprint, not a new economic event identity. */
  fingerprint: string;
}>;
type Pending = Readonly<{ kind: "unverified"; reason: string }>;
const pending = (reason: string): Pending => ({ kind: "unverified", reason });
const txHash = /^0x[\da-f]{64}$/iu;
const ownerAddress = /^0x[\da-f]{40}$/iu;

function currency(location: AssetLocation) {
  if (isHypercoreMainnetUsdc(location.asset)) {
    const dex = hypercoreLocationDex(location);
    if (dex === null) return null;
    return {
      chainId: 1337,
      address:
        dex === "spot"
          ? location.asset.assetId
          : RELAY_HYPERCORE_PERPS_CURRENCY,
      decimals: 8,
    };
  }
  if (
    RELAY_HYPERCORE_EVM_STABLE_SOURCE_ASSETS.some((asset) =>
      sameAsset(location.asset, asset),
    )
  ) {
    return {
      chainId: Number(location.asset.networkId.slice(4)),
      address: location.asset.assetId,
      decimals: 6,
    };
  }
  return null;
}
function currencyMatches(
  left: NonNullable<ReturnType<typeof currency>>,
  right: { chainId: number; address: string; decimals: number },
) {
  return (
    left.chainId === right.chainId &&
    left.decimals === right.decimals &&
    left.address.toLowerCase() === right.address.toLowerCase()
  );
}

/** Provider refund status/amount is a request to inspect exact receipts, never
 * a credit. A partial receipt is retained separately from full settlement.
 * Scope: registered stablecoin EVM/Core routes; legacy paths are untouched.
 * Wire fields: https://docs.relay.link/references/api/get-requests */
export function selectRelayRefundReceiptPlan(input: {
  expected: RelayRefundExpectation;
  request: RelayRequestEvidence;
  status: RelayStatusResponse;
}): Readonly<{ kind: "selected"; plan: RelayRefundReceiptPlan }> | Pending {
  const { expected, request, status } = input;
  if (request.refundProjectionInvalid)
    return pending("refund_request_fields_invalid");
  if (
    request.id !== expected.requestId ||
    (status.requestId !== undefined &&
      status.requestId !== expected.requestId) ||
    !txHash.test(expected.protocolOrderId) ||
    request.protocol?.orderId?.toLowerCase() !==
      expected.protocolOrderId.toLowerCase()
  )
    return pending("refund_request_identity_mismatch");
  if (
    request.supersededByRequestId ||
    request.duplicateDeposits?.parentRequestId ||
    request.duplicateDeposits?.refundRequestIds?.length
  )
    return pending("refund_request_lineage_requires_observation");
  if (
    !["refund", "refund_in_progress"].includes(status.status) ||
    !["refund", "pending"].includes(request.status)
  )
    return pending("refund_status_pending");
  const sourceCurrency = currency(expected.source);
  const sourceAddress = expected.source.details.address;
  const sender = request.sender ?? request.user;
  const actualSource = request.data.route?.actual?.origin.inputCurrency;
  if (
    !sourceCurrency ||
    !sameAsset(expected.source.asset, expected.sourceAmount.asset) ||
    !/^[1-9]\d*$/u.test(expected.sourceAmount.raw) ||
    typeof sourceAddress !== "string" ||
    !ownerAddress.test(sourceAddress) ||
    !sender ||
    !sameAccountAddress(
      expected.source.asset.networkId,
      sourceAddress,
      sender,
    ) ||
    !actualSource ||
    !currencyMatches(sourceCurrency, actualSource.currency) ||
    actualSource.amount !== expected.sourceAmount.raw
  )
    return pending("refund_source_binding_mismatch");
  const returned = request.data.refundCurrencyData;
  if (!returned || !/^[1-9]\d*$/u.test(returned.amount))
    return pending("refund_amount_pending");
  const matches = expected.refundLocations.filter((location) => {
    const wire = currency(location);
    return (
      location.accountId === expected.source.accountId &&
      typeof location.details.address === "string" &&
      ownerAddress.test(location.details.address) &&
      wire !== null &&
      currencyMatches(wire, returned.currency) &&
      (!isHypercoreMainnetUsdc(location.asset) ||
        hypercoreLocationDex(location) === "")
    );
  });
  if (matches.length !== 1)
    return pending("refund_target_missing_or_ambiguous");
  const target = matches[0];
  // refundTo names the requested source-side refund address. It must agree
  // for EVM returns. A committed HyperCore fallback may instead credit a
  // different owned native recipient; its action + ledger bind that recipient.
  if (
    !isHypercoreMainnetUsdc(target.asset) &&
    request.refundTo != null &&
    !sameAccountAddress(
      target.asset.networkId,
      String(target.details.address),
      request.refundTo,
    )
  )
    return pending("refund_explicit_recipient_mismatch");
  // Admitted currencies are pinned USD stablecoins. Fees reduce the return, never
  // justify treating the original nominal source amount as received.
  if (
    BigInt(returned.amount) *
      10n ** BigInt(expected.sourceAmount.asset.decimals) >
    BigInt(expected.sourceAmount.raw) * 10n ** BigInt(target.asset.decimals)
  )
    return pending("refund_exceeds_source");
  const references = request.protocol?.settlement?.destination?.refunds;
  if (!references?.length) return pending("refund_references_pending");
  if (references.length > RELAY_REQUEST_TRANSACTION_LIMIT)
    return pending("refund_reference_manifest_too_large");
  const hashes = new Set<string>();
  for (const reference of references) {
    if (
      reference.chainId !== returned.currency.chainId ||
      !txHash.test(reference.transactionId)
    )
      return pending("refund_reference_identity_mismatch");
    hashes.add(reference.transactionId.toLowerCase());
  }
  const transactions = new Map<string, RefundTransaction>();
  const identities = new Map<string, string>();
  const ledgerSeconds = new Set<number>();
  for (const transaction of request.data.outTxs ?? []) {
    const hash = transaction.txHash.toLowerCase();
    if (!hashes.has(hash)) continue;
    if (transaction.chainId !== returned.currency.chainId)
      return pending("refund_transaction_chain_mismatch");
    if (transaction.status !== "success") continue;
    if (transaction.chainId === 1337) {
      const native = relayHypercoreTransactionSchema.safeParse(transaction);
      if (!native.success) return pending("refund_native_action_invalid");
      let raw: string;
      try {
        raw = hip4RawUnits(native.data.data.action.amount, 8).toString();
      } catch {
        return pending("refund_native_amount_invalid");
      }
      const identity = hypercoreTransactionFingerprint(native.data, raw);
      const prior = identities.get(hash);
      if (prior && prior !== identity)
        return pending("refund_transaction_conflict");
      identities.set(hash, identity);
      ledgerSeconds.add(transaction.timestamp);
    }
    transactions.set(hash, transaction);
  }
  const expectedReturned = { asset: target.asset, raw: returned.amount };
  return {
    kind: "selected",
    plan: {
      target: structuredClone(target),
      expectedReturned,
      transactions: [...transactions.values()],
      transactionHashes: [...hashes].sort(),
      ledgerSeconds: [...ledgerSeconds].sort((left, right) => left - right),
      providerTerminal:
        status.status === "refund" && request.status === "refund",
      fingerprint: canonicalJsonHash({
        requestId: expected.requestId,
        protocolOrderId: expected.protocolOrderId.toLowerCase(),
        target,
        expectedReturned,
        hashes: [...hashes].sort(),
      }),
    },
  };
}

export type RelayRefundReceiptResult =
  | Pending
  | Readonly<{
      kind: "verified" | "partial";
      events: readonly OwnedRouteCanonicalDestinationEvent[];
      expectedReturned: Money;
      receivedRaw: string;
      fingerprint: string;
      reason: string | null;
    }>;

/** Native events reuse the same ledger proof as destination credits. EVM
 * events must come from the common canonical ERC20 receipt reader. Replay
 * keeps the shared network/tx/event identity, including native DEX evidence. */
export function verifyRelayRefundReceipts(input: {
  plan: RelayRefundReceiptPlan;
  evmEvents?: readonly OwnedRouteCanonicalDestinationEvent[];
  nativeLedger?: readonly unknown[];
  now: Date;
}): RelayRefundReceiptResult {
  const { plan } = input;
  const owner = String(plan.target.details.address);
  const references = new Set(plan.transactionHashes);
  const successful = new Set(
    plan.transactions.map((row) => row.txHash.toLowerCase()),
  );
  let candidates: readonly OwnedRouteCanonicalDestinationEvent[] =
    input.evmEvents ?? [];
  let missingReason: string | null = null;
  if (isHypercoreMainnetUsdc(plan.target.asset)) {
    const events: OwnedRouteCanonicalDestinationEvent[] = [];
    let declared = 0n;
    for (const transaction of plan.transactions) {
      const native = relayHypercoreTransactionSchema.safeParse(transaction);
      if (!native.success) return pending("refund_native_action_invalid");
      let raw: string;
      try {
        raw = hip4RawUnits(native.data.data.action.amount, 8).toString();
      } catch {
        return pending("refund_native_amount_invalid");
      }
      declared += BigInt(raw);
      const proof = verifyRelayHypercoreTransfer({
        expected: {
          asset: plan.target.asset,
          owner,
          dex: "",
          direction: "credit",
          transactionHash: transaction.txHash,
          actualRaw: raw,
        },
        nativeTransaction: transaction,
        ledger: input.nativeLedger ?? [],
      });
      if (proof.kind === "verified")
        events.push(hypercoreDestinationEvent(proof.evidence, input.now));
      else missingReason ??= proof.reason;
    }
    if (
      declared > BigInt(plan.expectedReturned.raw) ||
      (successful.size === references.size &&
        declared !== BigInt(plan.expectedReturned.raw))
    )
      return pending("refund_native_total_mismatch");
    candidates = events;
  }
  const distinct = new Map<string, OwnedRouteCanonicalDestinationEvent>();
  for (const event of candidates) {
    if (
      !references.has(event.transactionHash.toLowerCase()) ||
      !successful.has(event.transactionHash.toLowerCase()) ||
      !sameAsset(event.asset, plan.target.asset) ||
      event.networkId !== plan.target.asset.networkId ||
      !sameAccountAddress(event.networkId, event.destinationAddress, owner)
    )
      continue;
    if (!/^[1-9]\d*$/u.test(event.rawAmount))
      return pending("refund_receipt_amount_invalid");
    const key = `${event.transactionHash.toLowerCase()}:${event.eventIndex}`;
    const prior = distinct.get(key);
    if (
      prior &&
      receiveRoleEventFingerprint(prior) !== receiveRoleEventFingerprint(event)
    )
      return pending("refund_receipt_conflict");
    distinct.set(key, event);
  }
  if (!distinct.size) return pending(missingReason ?? "refund_receipt_pending");
  const events = [...distinct.values()];
  // A refund reference binds a transaction, not each Transfer log to an order.
  // Never complete A by summing A's partial return and B's return to the same
  // owner/token. Replay of the SAME log is already deduplicated above. Distinct
  // transactions remain eligible for incremental partial-return observation.
  // Even a single log still needs role arbitration before allocation: this is
  // not proof that an aggregated transfer has only one economic claimant.
  if (!isHypercoreMainnetUsdc(plan.target.asset)) {
    const transactions = new Set<string>();
    for (const event of events) {
      const transaction = event.transactionHash.toLowerCase();
      if (transactions.has(transaction))
        return pending("refund_shared_transaction_requires_attribution");
      transactions.add(transaction);
    }
  }
  const received = events.reduce(
    (total, row) => total + BigInt(row.rawAmount),
    0n,
  );
  const declared = BigInt(plan.expectedReturned.raw);
  if (received > declared)
    return pending("refund_receipt_exceeds_declared_amount");
  const complete =
    received === declared &&
    new Set(events.map((row) => row.transactionHash.toLowerCase())).size ===
      references.size &&
    plan.providerTerminal;
  return {
    kind: complete ? "verified" : "partial",
    events,
    expectedReturned: plan.expectedReturned,
    receivedRaw: received.toString(),
    fingerprint: plan.fingerprint,
    reason: complete
      ? null
      : (missingReason ??
        (!plan.providerTerminal
          ? "refund_provider_pending"
          : "refund_receipts_incomplete")),
  };
}
