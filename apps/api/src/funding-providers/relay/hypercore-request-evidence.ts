import { hip4RawUnits } from "@hunch/shared";
import { sameAccountAddress } from "../../funding/domain/asset-identity.js";
import {
  isHypercoreMainnetUsdc,
  RELAY_HYPERCORE_PERPS_CURRENCY,
} from "../../funding/domain/hypercore-identity.js";
import type { AssetRef } from "../../funding/domain/types.js";
import { isRecord } from "../../lib/type-guards.js";
import type { RelayStatusResponse } from "./schemas.js";
import type { RelayRequestEvidence } from "./request-evidence.js";
import {
  verifyRelayHypercoreTransfer,
  relayHypercoreTransactionSchema,
  type HypercoreTransferEvidence,
  hypercoreTransactionFingerprint,
} from "./hypercore-transfer-evidence.js";

/** The zero currency is Relay's perps-balance selector, never a native token.
 * It is admitted only when an operation explicitly selected the perps DEX. */

export function verifyRelayHypercoreRequest(input: {
  expected: Readonly<{
    requestId: string;
    asset: AssetRef;
    owner: string;
    dex: "spot" | "";
    direction: "credit" | "debit";
  }>;
  request: RelayRequestEvidence;
  status: RelayStatusResponse;
  ledger: readonly unknown[];
}):
  | Readonly<{
      kind: "verified";
      transfers: readonly HypercoreTransferEvidence[];
    }>
  | Readonly<{
      kind: "partial";
      transfers: readonly HypercoreTransferEvidence[];
      reason: string;
    }>
  | Readonly<{ kind: "unverified"; reason: string }> {
  const { expected, request, status } = input;
  const fail = (reason: string) => ({ kind: "unverified" as const, reason });
  if (!isHypercoreMainnetUsdc(expected.asset))
    return fail("unsupported_native_asset");
  if (
    request.id !== expected.requestId ||
    (status.requestId !== undefined && status.requestId !== expected.requestId)
  )
    return fail("native_request_identity_mismatch");
  const credit = expected.direction === "credit";
  const statusChain = credit ? status.destinationChainId : status.originChainId;
  if (statusChain !== undefined && statusChain !== 1337)
    return fail("native_status_chain_mismatch");
  const owner = credit ? request.recipient : (request.sender ?? request.user);
  if (
    !owner ||
    !sameAccountAddress(expected.asset.networkId, owner, expected.owner)
  )
    return fail("native_request_owner_mismatch");
  const actual = credit
    ? request.data.route?.actual?.destination?.outputCurrency
    : request.data.route?.actual?.origin.inputCurrency;
  if (!actual) return fail("native_route_actual_pending");
  const relayCurrency =
    expected.dex === "spot"
      ? expected.asset.assetId.toLowerCase()
      : RELAY_HYPERCORE_PERPS_CURRENCY;
  if (
    actual.currency.chainId !== 1337 ||
    actual.currency.decimals !== expected.asset.decimals ||
    actual.currency.address.toLowerCase() !== relayCurrency
  )
    return fail("native_route_currency_mismatch");
  const hashes = (credit ? status.txHashes : status.inTxHashes) ?? [];
  const references = new Set(hashes.map((value) => value.toLowerCase()));
  const transactions =
    (credit ? request.data.outTxs : request.data.inTxs) ?? [];
  const native = transactions.filter((value) => value.chainId === 1337);
  if (native.length === 0) return fail("native_transaction_pending");

  const distinct = new Map<
    string,
    { transaction: (typeof native)[number]; raw: string; identity: string }
  >();
  for (const transaction of native) {
    if (!references.has(transaction.txHash.toLowerCase()))
      return fail("native_status_reference_pending");
    if (
      !isRecord(transaction.data) ||
      !isRecord(transaction.data.action) ||
      typeof transaction.data.action.amount !== "string"
    )
      return fail("native_action_invalid");
    let raw: string;
    try {
      raw = hip4RawUnits(
        transaction.data.action.amount,
        expected.asset.decimals,
      ).toString();
    } catch {
      return fail("native_amount_mismatch");
    }
    const parsed = relayHypercoreTransactionSchema.safeParse(transaction);
    if (!parsed.success) return fail("provider_native_evidence_invalid");
    const identity = hypercoreTransactionFingerprint(parsed.data, raw);
    const key = transaction.txHash.toLowerCase();
    const prior = distinct.get(key);
    if (prior && prior.identity !== identity)
      return fail("native_transaction_conflict");
    if (!prior) distinct.set(key, { transaction, raw, identity });
  }
  // Reconcile the request's distinct transfers before ledger inspection. This
  // catches inconsistent provider totals without losing an already-proven leg
  // merely because another leg's native ledger is still catching up.
  const total = [...distinct.values()].reduce(
    (sum, row) => sum + BigInt(row.raw),
    0n,
  );
  if (total !== BigInt(actual.amount))
    return fail("native_route_amount_mismatch");
  const transfers: HypercoreTransferEvidence[] = [];
  let pendingReason: string | null = null;
  for (const { transaction, raw } of distinct.values()) {
    const result = verifyRelayHypercoreTransfer({
      expected: {
        ...expected,
        transactionHash: transaction.txHash,
        actualRaw: raw,
      },
      nativeTransaction: transaction,
      ledger: input.ledger,
    });
    if (result.kind === "verified") transfers.push(result.evidence);
    else pendingReason ??= result.reason;
  }
  if (pendingReason)
    return transfers.length
      ? { kind: "partial", transfers, reason: pendingReason }
      : fail(pendingReason);
  return { kind: "verified", transfers };
}
