import type { PoolClient } from "@hunch/infra";
import type { AssetLocation, JsonObject } from "../domain/types.js";
import { assetLocationSchema, moneySchema } from "../domain/schemas.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  fundingRefundReceiptSetComplete,
  EXACT_REFUND_OBSERVER_ID,
  readFundingRefundContract,
  readFundingRefundReceiptIdentity,
  type FundingRefundContract,
  type FundingRefundReceiptIdentity,
} from "../domain/refund-settlement.js";
import {
  allocateFundingObservationInTransaction,
  appendFundingRefundCompletionProof,
  hasFundingRefundOutsideProof,
  listFundingRefundManifestReceipts,
  wakeFundingReconciliationInTransaction,
  type FundingObservationRow,
} from "../persistence/funding-operation-repository.js";
import {
  compareFundingReceiveCanonicalEvents,
  lockFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
} from "../persistence/funding-receive-session-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { hasFundingEvmReceiveClaim } from "../persistence/funding-physical-claims.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import type { RelayRequestEvidence } from "../../funding-providers/relay/request-evidence.js";
import type { RelayStatusResponse } from "../../funding-providers/relay/schemas.js";
import {
  selectRelayRefundReceiptPlan,
  verifyRelayRefundReceipts,
  type RelayRefundExpectation,
  type RelayRefundReceiptPlan,
} from "../../funding-providers/relay/refund-evidence.js";
import { relayHypercoreTransactionSchema } from "../../funding-providers/relay/hypercore-transfer-evidence.js";
import { parseHip4LedgerObservation } from "../../services/hip4-account-contract.js";
import type { OwnedRouteCanonicalDestinationEvent } from "./owned-route-destination-observer.js";
import { classifyOwnedRouteCanonicalDestinationEvents } from "./owned-route-destination-observer.js";
import { loadCanonicalPolymarketHandoffClassifications } from "../receive/receive-handoff-classification.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { readCommittedFundingIdentity } from "../domain/committed-economic-identity.js";
import {
  FundingClassificationChangedError,
  readFundingClassificationPage,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";

export { EXACT_REFUND_OBSERVER_ID } from "../domain/refund-settlement.js";
/** Must escape the transaction: keeping its prelocks and retrying in-place
 * would invert the canonical-event -> operation lock order. */
export class RelayExactRefundSnapshotChanged extends Error {
  readonly reason = "refund_evidence_changed_retry";

  constructor() {
    super("Exact refund evidence changed while acquiring locks");
    this.name = "RelayExactRefundSnapshotChanged";
  }
}
type Database = Pick<PoolClient, "query">;
export type RelayExactRefundLookup = Readonly<{
  operationId: string;
  segmentId: string;
  requestId: string;
  referenceCodec: Pick<
    RelayReferenceCodec,
    "fingerprint" | "keyVersion" | "decrypt"
  >;
  transactionReferenceCodec?: Pick<
    FundingTransactionReferenceCodec,
    "fingerprint" | "keyVersion" | "decrypt"
  >;
}>;
type Pending = Readonly<{ kind: "pending"; reason: string }>;
const pending = (reason: string): Pending => ({ kind: "pending", reason });
export type RelayExactRefundContext = Readonly<{
  kind: "ready";
  currentOwnerUserId: string;
  facts: FundingClassificationRevision;
  contract: FundingRefundContract;
  expected: RelayRefundExpectation;
  identity: Omit<FundingRefundReceiptIdentity, "refundLocationId">;
  ledgerAfterSecond?: number;
}>;

export const RELAY_EXACT_REFUND_CONTEXT_SQL = `select operation_row.user_id,
  coalesce(revision_row.revision,0)::text as classification_revision,
  operation_row.source_snapshot as operation_source_snapshot,segment_row.source_snapshot,
  segment_row.quoted_input,segment_row.refund_location_snapshot,
  segment_row.provider_quote_ref_ciphertext,segment_row.provider_quote_ref_lookup_hmac,
  segment_row.lookup_key_version,segment_row.support_metadata
  from funding_operations operation_row
  join funding_operation_segments segment_row on segment_row.operation_id=operation_row.id
    and segment_row.id=$2::uuid and segment_row.provider_id='relay'
  left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
  where operation_row.id=$1::uuid and operation_row.plan_kind in ('wallet_route','composite_route')`;

/** Read-only, exact operation/segment lookup. No provider IO, policy activation
 * or wallet-history scan. The writer repeats it after acquiring the row lock. */
export async function loadRelayExactRefundContext(
  db: Database,
  input: RelayExactRefundLookup,
): Promise<RelayExactRefundContext | Pending | Readonly<{ kind: "ignored" }>> {
  const { rows } = await db.query<{
    user_id: string;
    classification_revision: string;
    operation_source_snapshot: unknown;
    source_snapshot: unknown;
    quoted_input: unknown;
    refund_location_snapshot: unknown;
    provider_quote_ref_ciphertext: string | null;
    provider_quote_ref_lookup_hmac: string | null;
    lookup_key_version: number | null;
    support_metadata: unknown;
  }>(RELAY_EXACT_REFUND_CONTEXT_SQL, [input.operationId, input.segmentId]);
  const row = rows[0];
  if (!row) return { kind: "ignored" };
  const snapshot = row.refund_location_snapshot;
  const contract = readFundingRefundContract(snapshot, {
    requestFingerprint: row.provider_quote_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
  });
  if (!contract) return { kind: "ignored" };
  if (!contract.supported || !contract.requestBinding || !isRecord(snapshot))
    return pending("refund_committed_contract_invalid");
  const binding = contract.requestBinding;
  // A lookup-HMAC rotation must not strand an already committed transfer.
  // The immutable, authenticated encrypted request is authoritative; receipts
  // retain the ORIGINAL fingerprint/version rather than rewriting the plan.
  let committedRequest: string;
  try {
    if (!row.provider_quote_ref_ciphertext)
      return pending("refund_committed_request_unavailable");
    committedRequest = input.referenceCodec.decrypt(
      row.provider_quote_ref_ciphertext,
    );
  } catch {
    return pending("refund_committed_request_unavailable");
  }
  if (
    committedRequest !== input.requestId ||
    (binding.lookupKeyVersion === input.referenceCodec.keyVersion &&
      binding.requestFingerprint !==
        input.referenceCodec.fingerprint(input.requestId))
  )
    return pending("refund_committed_request_mismatch");
  const sourceSnapshot = row.source_snapshot;
  if (!isRecord(sourceSnapshot) || sourceSnapshot.kind !== "owned_location")
    return pending("refund_committed_source_invalid");
  const source = assetLocationSchema.safeParse(sourceSnapshot.location);
  const sourceAmount = moneySchema.safeParse(row.quoted_input);
  // Only these extra snapshot envelope fields are ignored, not asset identity.
  const primary = assetLocationSchema.strip().safeParse(snapshot);
  const alternatives = isRecord(snapshot.alternativeRefundLocations)
    ? snapshot.alternativeRefundLocations.locations
    : [];
  if (
    !source.success ||
    !sourceAmount.success ||
    !primary.success ||
    !Array.isArray(alternatives)
  )
    return pending("refund_committed_source_invalid");
  const refunds = alternatives.map((location) =>
    assetLocationSchema.safeParse(location),
  );
  if (refunds.some((location) => !location.success))
    return pending("refund_committed_target_invalid");
  const refundLocations = [
    primary.data,
    ...refunds.flatMap((location) => (location.success ? [location.data] : [])),
  ];
  if (
    !readCommittedFundingIdentity({
      currentOwnerUserId: row.user_id,
      operationSourceSnapshot: row.operation_source_snapshot,
      accountIds: [
        source.data.accountId,
        ...refundLocations.map((location) => location.accountId),
      ],
    })
  )
    return pending("refund_committed_owner_mismatch");
  const prior =
    isRecord(row.support_metadata) &&
    isRecord(row.support_metadata.exactRefundReceipts)
      ? row.support_metadata.exactRefundReceipts
      : null;
  const ledgerAfterSecond =
    prior?.requestFingerprint === binding.requestFingerprint &&
    prior?.lookupKeyVersion === binding.lookupKeyVersion &&
    typeof prior.ledgerAfterSecond === "number" &&
    Number.isSafeInteger(prior.ledgerAfterSecond) &&
    prior.ledgerAfterSecond >= 0
      ? prior.ledgerAfterSecond
      : undefined;
  return {
    kind: "ready",
    currentOwnerUserId: row.user_id,
    facts: {
      operationId: input.operationId,
      userId: row.user_id,
      revision: row.classification_revision,
    },
    contract,
    identity: { version: 1, ...binding },
    ...(ledgerAfterSecond === undefined ? {} : { ledgerAfterSecond }),
    expected: {
      requestId: input.requestId,
      protocolOrderId: binding.protocolOrderId,
      // These envelopes originate from PostgreSQL jsonb, not arbitrary JS
      // values. The schema validates identity; jsonb guarantees JSON details.
      source: source.data as AssetLocation,
      sourceAmount: sourceAmount.data,
      refundLocations: refundLocations as AssetLocation[],
    },
  };
}

export type RecordRelayExactRefundInput = RelayExactRefundLookup &
  Readonly<{
    request: RelayRequestEvidence;
    status: RelayStatusResponse;
    evmEvents?: readonly OwnedRouteCanonicalDestinationEvent[];
    nativeLedger?: readonly unknown[];
    now: Date;
  }>;
export type RecordRelayExactRefundResult =
  | Pending
  | Readonly<{ kind: "ignored" }>
  | Readonly<{
      kind: "partial" | "complete";
      inserted: number;
      reason: string | null;
    }>;

function canonicalReceipts(
  rows: readonly FundingObservationRow[],
  segmentId: string,
) {
  return rows.filter(
    (row) =>
      row.segmentId === segmentId &&
      row.kind === "refund_credit" &&
      row.canonical &&
      row.finalityStatus === "finalized",
  );
}

/** Retain only the validated native ledger fields needed to re-prove a receipt
 * in a later bounded poll. Never retain an entire provider/account payload. */
function storedNativeLedger(input: unknown): JsonObject | null {
  try {
    const parsed = parseHip4LedgerObservation(input);
    if (!parsed.supported || parsed.entry.delta.type !== "send") return null;
    const { hash, time, delta } = parsed.entry;
    if (delta.type !== "send") return null;
    return {
      hash,
      time,
      delta: {
        type: delta.type,
        user: delta.user,
        destination: delta.destination,
        sourceDex: delta.sourceDex,
        destinationDex: delta.destinationDex,
        token: delta.token,
        amount: delta.amount,
        usdcValue: delta.usdcValue,
        fee: delta.fee,
        nativeTokenFee: delta.nativeTokenFee,
        nonce: delta.nonce,
        feeToken: delta.feeToken,
      },
    };
  } catch {
    return null;
  }
}

function verifiedFromCurrentAndStored(
  context: RelayExactRefundContext,
  input: RecordRelayExactRefundInput,
  rows: readonly FundingObservationRow[],
  plan: RelayRefundReceiptPlan,
) {
  // The manifest lookup retains two physical witnesses BEFORE identity filters.
  // A provider reference binds a transaction, not an arbitrary log within it.
  const hashes = new Set<string>();
  for (const row of rows) {
    const hash = row.networkId.startsWith("evm:")
      ? row.txHash.toLowerCase()
      : row.txHash;
    if (hashes.has(hash))
      return pending("refund_shared_transaction_requires_attribution");
    hashes.add(hash);
  }
  const identity: FundingRefundReceiptIdentity = {
    ...context.identity,
    refundLocationId: plan.target.locationId,
  };
  const prior = canonicalReceipts(rows, input.segmentId).filter(
    (row) =>
      row.metadata.observerId === EXACT_REFUND_OBSERVER_ID &&
      canonicalJsonHash(
        readFundingRefundReceiptIdentity(row.metadata.relayRefundReceipt),
      ) === canonicalJsonHash(identity),
  );
  const nativeLedger = [
    ...(input.nativeLedger ?? []),
    ...prior.flatMap((row) => {
      const ledger = storedNativeLedger(row.metadata.relayRefundNativeLedger);
      return ledger ? [ledger] : [];
    }),
  ];
  const evmEvents = [
    ...(input.evmEvents ?? []),
    ...prior.flatMap((row) =>
      row.networkId.startsWith("evm:") &&
      row.ledgerHeight !== null &&
      row.blockHash !== null
        ? [
            {
              networkId: row.networkId,
              asset: {
                networkId: row.networkId,
                assetId: row.assetId,
                decimals: row.assetDecimals,
              },
              destinationAddress: row.toAddress,
              sourceAddress: row.fromAddress,
              rawAmount: row.rawAmount,
              transactionHash: row.txHash,
              eventIndex: row.eventIndex,
              ledgerHeight: row.ledgerHeight,
              blockHash: row.blockHash,
              observedAt: row.observedAt,
            },
          ]
        : [],
    ),
  ];
  const verified = verifyRelayRefundReceipts({
    plan,
    now: input.now,
    nativeLedger,
    evmEvents,
  });
  if (verified.kind === "unverified") return pending(verified.reason);
  return { kind: "ready" as const, verified, identity, nativeLedger };
}

function refundEventSnapshot(
  events: readonly OwnedRouteCanonicalDestinationEvent[],
) {
  return canonicalJsonHash(
    [...events].sort(compareFundingReceiveCanonicalEvents).map((event) => ({
      networkId: event.networkId,
      asset: event.asset,
      transactionHash: event.transactionHash,
      eventIndex: event.eventIndex,
      sourceAddress: event.sourceAddress,
      destinationAddress: event.destinationAddress,
      rawAmount: event.rawAmount,
      ledgerHeight: event.ledgerHeight,
      blockHash: event.blockHash,
      nativeEvidence: event.nativeEvidence ?? null,
    })),
  );
}

type VerifiedRefundReceipts = Extract<
  ReturnType<typeof verifiedFromCurrentAndStored>,
  { kind: "ready" }
>;
export type PreparedRelayExactRefundReceipts = Readonly<{
  kind: "prepared";
  /** Original proposal revision. Revalidation never replaces this authority
   * with a newer revision read after acquiring O. */
  facts: FundingClassificationRevision;
  input: RecordRelayExactRefundInput;
  context: RelayExactRefundContext;
  plan: RelayRefundReceiptPlan;
  verification: VerifiedRefundReceipts;
}>;
export type RevalidatedRelayExactRefundReceipts = Omit<
  PreparedRelayExactRefundReceipts,
  "kind"
> &
  Readonly<{ kind: "revalidated" }>;

/** DB-only proposal before E/O. Context and revision share one statement;
 * the existing revision reader brackets the exact manifest read. This neither
 * allocates nor authorizes a role. No fresh facts revision is attached later.
 */
export async function prepareRelayExactRefundReceipts(
  db: Database,
  input: RecordRelayExactRefundInput,
): Promise<
  PreparedRelayExactRefundReceipts | Pending | Readonly<{ kind: "ignored" }>
> {
  const before = await loadRelayExactRefundContext(db, input);
  if (before.kind !== "ready") return before;
  const selected = selectRelayRefundReceiptPlan({
    expected: before.expected,
    request: input.request,
    status: input.status,
  });
  if (selected.kind !== "selected") return pending(selected.reason);
  const manifest = {
    operationId: input.operationId,
    segmentId: input.segmentId,
    networkId: selected.plan.target.asset.networkId,
    transactionHashes: selected.plan.transactionHashes,
  };
  const initial = await readRefundPreparationPage(db, before.facts, async () =>
    verifiedFromCurrentAndStored(
      before,
      input,
      await listFundingRefundManifestReceipts(db, manifest),
      selected.plan,
    ),
  );
  if (initial.kind !== "ready") return initial;
  return {
    kind: "prepared",
    facts: before.facts,
    input,
    context: before,
    plan: selected.plan,
    verification: initial,
  };
}

async function readRefundPreparationPage<T>(
  db: Database,
  facts: FundingClassificationRevision,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await readFundingClassificationPage(db, facts, read);
  } catch (error) {
    if (error instanceof FundingClassificationChangedError)
      throw new RelayExactRefundSnapshotChanged();
    throw error;
  }
}

export function relayExactRefundCanonicalEvents(
  prepared:
    | PreparedRelayExactRefundReceipts
    | RevalidatedRelayExactRefundReceipts,
) {
  return prepared.verification.verified.events.flatMap((event) => {
    if (!event.networkId.startsWith("evm:")) return [];
    if (event.ledgerHeight === null || event.blockHash === null)
      throw new Error("refund canonical EVM proof missing");
    return [
      {
        ...event,
        transactionHash: event.transactionHash.toLowerCase(),
        ledgerHeight: event.ledgerHeight,
        blockHash: event.blockHash,
        now: prepared.input.now,
      },
    ];
  });
}

/** AFTER the complete sorted O union, before any effects. A newly visible
 * partial receipt must force a fresh transaction, not a new E acquisition under
 * O. Original prepared facts remain the final fence's expected revision. */
export async function revalidateRelayExactRefundReceipts(
  db: Database,
  prepared: PreparedRelayExactRefundReceipts,
): Promise<RevalidatedRelayExactRefundReceipts> {
  const { input, context: before, plan } = prepared;
  const context = await loadRelayExactRefundContext(db, input);
  if (
    context.kind !== "ready" ||
    canonicalJsonHash([
      context.contract,
      context.expected,
      context.identity,
      context.currentOwnerUserId,
    ]) !==
      canonicalJsonHash([
        before.contract,
        before.expected,
        before.identity,
        before.currentOwnerUserId,
      ])
  )
    throw new RelayExactRefundSnapshotChanged();
  const latest = await readRefundPreparationPage(db, context.facts, async () =>
    verifiedFromCurrentAndStored(
      context,
      input,
      await listFundingRefundManifestReceipts(db, {
        operationId: input.operationId,
        segmentId: input.segmentId,
        networkId: plan.target.asset.networkId,
        transactionHashes: plan.transactionHashes,
      }),
      plan,
    ),
  );
  if (
    latest.kind !== "ready" ||
    refundEventSnapshot(prepared.verification.verified.events) !==
      refundEventSnapshot(latest.verified.events)
  )
    throw new RelayExactRefundSnapshotChanged();
  return { ...prepared, kind: "revalidated", context, verification: latest };
}

/** Compatibility transaction adapter for existing native/legacy callers.
 * Supported joint publication uses prepare/revalidate/apply, NEVER this wrapper
 * under an outer O. Provider reads finish before opening the transaction. */
export async function recordRelayExactRefundReceiptsInTransaction(
  db: Database,
  input: RecordRelayExactRefundInput,
): Promise<RecordRelayExactRefundResult> {
  const prepared = await prepareRelayExactRefundReceipts(db, input);
  if (prepared.kind !== "prepared") return prepared;
  // Receive uses canonical-event -> operation locks. Respect that same order
  // so an overlapping external-deposit scan cannot deadlock or double credit.
  await lockFundingReceiveCanonicalEvents(
    db,
    relayExactRefundCanonicalEvents(prepared),
  );
  await db.query(
    "select id from funding_operations where id=$1::uuid for update",
    [input.operationId],
  );
  const latest = await revalidateRelayExactRefundReceipts(db, prepared);
  const {
    context,
    verification: { verified },
  } = latest;
  // The exact refund proof is a positive role, not permission to steal an
  // already known handoff/destination. Use the SAME readers as receive, after
  // acquiring the full physical footprint and revalidating the refund snapshot.
  // Pending/competing roles cause no receipt, proof, suppression or wake: the
  // ordinary provider reconciliation retries once current facts are repaired.
  const handoffs = await loadCanonicalPolymarketHandoffClassifications(db, {
    userId: context.currentOwnerUserId,
    now: input.now,
    transactionReferenceCodec: input.transactionReferenceCodec,
    events: verified.events.flatMap((event) => {
      if (!event.networkId.startsWith("evm:")) return [];
      if (event.sourceAddress === null)
        throw new Error("refund canonical EVM source proof missing");
      return [
        {
          ...event,
          sourceAddress: event.sourceAddress,
          variant: { networkId: event.networkId, asset: event.asset },
        },
      ];
    }),
  });
  const destinations = await classifyOwnedRouteCanonicalDestinationEvents(db, {
    userId: context.currentOwnerUserId,
    events: verified.events,
    referenceCodec: input.referenceCodec,
  });
  for (const event of verified.events) {
    const identity = [
      event.networkId,
      event.transactionHash,
      event.eventIndex,
    ].join(":");
    if (
      (event.networkId.startsWith("evm:") &&
        handoffs.get(identity)?.kind !== "external") ||
      destinations.get(identity)?.kind !== "external"
    )
      return pending("internal_event_classification_conflict");
  }
  return applyRelayExactRefundReceiptsInTransaction(db, latest);
}

/** Effects only. Caller has validated the complete physical footprint and
 * ownership, locked its O union, revalidated, and will finish with its required
 * F/COMMIT. No explicit E/O acquisition, role reads or provider IO here. */
export async function applyRelayExactRefundReceiptsInTransaction(
  db: Database,
  prepared: RevalidatedRelayExactRefundReceipts,
): Promise<RecordRelayExactRefundResult> {
  const {
    input,
    context,
    plan,
    verification: { verified, identity: receiptIdentity, nativeLedger },
  } = prepared;
  // Check the ENTIRE verified footprint before any suppression, receipt,
  // completion proof or wake. Exact-cased E alone does not exclude a retained
  // legacy receive alias in another owner/status. Caller already holds full E.
  for (const event of verified.events)
    if (await hasFundingEvmReceiveClaim(db, event))
      return pending("refund_receive_claim_conflict");
  for (const event of [...verified.events].sort(
    compareFundingReceiveCanonicalEvents,
  )) {
    if (!event.networkId.startsWith("evm:")) continue;
    if (event.ledgerHeight === null || event.blockHash === null)
      throw new Error("refund canonical EVM proof missing");
    const quarantined = await quarantineFundingReceiveCanonicalInternalEvent(
      db,
      {
        ...event,
        transactionHash: event.transactionHash.toLowerCase(),
        ledgerHeight: event.ledgerHeight,
        blockHash: event.blockHash,
        reason: "internal_exact_refund_suppressed",
        now: input.now,
      },
    );
    if (!quarantined)
      throw new Error("refund already allocated outside this operation");
  }
  const allocatedIds: string[] = [];
  const allocatedRows: FundingObservationRow[] = [];
  let inserted = 0;
  for (const event of [...verified.events].sort(
    compareFundingReceiveCanonicalEvents,
  )) {
    const transaction = event.nativeEvidence
      ? plan.transactions.find(
          (row) =>
            row.txHash.toLowerCase() === event.transactionHash.toLowerCase(),
        )
      : null;
    const nativeTransaction = transaction
      ? relayHypercoreTransactionSchema.parse(transaction)
      : null;
    const allocation = await allocateFundingObservationInTransaction(
      db,
      {
        operationId: input.operationId,
        segmentId: input.segmentId,
        kind: "refund_credit",
        networkId: event.networkId,
        assetId: event.asset.assetId,
        assetDecimals: event.asset.decimals,
        txHash: event.transactionHash.toLowerCase(),
        eventIndex: event.eventIndex,
        fromAddress: event.sourceAddress,
        toAddress: event.destinationAddress,
        rawAmount: event.rawAmount,
        observedAt: event.observedAt,
        ledgerHeight: event.ledgerHeight,
        blockHash: event.blockHash,
        finalityStatus: "finalized",
        finalizedAt: input.now,
        metadata: {
          observerId: EXACT_REFUND_OBSERVER_ID,
          relayRefundReceipt: receiptIdentity,
          ...(event.nativeEvidence && nativeTransaction
            ? {
                nativeDestinationDex: event.nativeEvidence.destinationDex,
                nativeSourceDex: event.nativeEvidence.sourceDex,
                nativeLedgerTime: event.nativeEvidence.ledgerTime,
                ...(event.nativeEvidence.feeObservation
                  ? {
                      nativeFeeObservation: event.nativeEvidence.feeObservation,
                    }
                  : {}),
                // Whitelisted unsigned action fields only; lets canonical watch run
                // even if the original provider request later becomes unavailable.
                relayRefundNativeTransaction: nativeTransaction,
                relayRefundNativeLedger:
                  nativeLedger
                    .map(storedNativeLedger)
                    .find(
                      (row) =>
                        typeof row?.hash === "string" &&
                        row.hash.toLowerCase() ===
                          event.transactionHash.toLowerCase(),
                    ) ?? null,
              }
            : {}),
        } as JsonObject,
      },
      "refund_receipt",
    );
    if (!allocation.replayed) inserted += 1;
    allocatedIds.push(allocation.observation.id);
    allocatedRows.push(allocation.observation);
  }
  const receipts = canonicalReceipts(allocatedRows, input.segmentId);
  const proof = {
    ...receiptIdentity,
    expectedReturned: plan.expectedReturned,
    observationIds: [...new Set(allocatedIds)].sort(),
  };
  const anchor = receipts.find((row) => row.id === proof.observationIds[0]);
  let complete = false;
  let proofAppended = false;
  if (
    verified.kind === "verified" &&
    anchor &&
    !(await hasFundingRefundOutsideProof(db, {
      operationId: input.operationId,
      segmentId: input.segmentId,
      observationIds: proof.observationIds,
    }))
  ) {
    complete = fundingRefundReceiptSetComplete(
      context.contract,
      receipts.map((row) => ({
        observationId: row.id,
        money: {
          asset: {
            networkId: row.networkId,
            assetId: row.assetId,
            decimals: row.assetDecimals,
          },
          raw: row.rawAmount,
        },
        destinationAddress: row.toAddress,
        nativeDestinationDex:
          row.metadata.nativeDestinationDex === "spot" ||
          row.metadata.nativeDestinationDex === ""
            ? row.metadata.nativeDestinationDex
            : null,
        identity: readFundingRefundReceiptIdentity(
          row.metadata.relayRefundReceipt,
        ),
        completionProofs: row.id === anchor.id ? [proof] : [],
      })),
    );
    if (complete) {
      const appended = await appendFundingRefundCompletionProof(db, {
        operationId: input.operationId,
        segmentId: input.segmentId,
        observationId: anchor.id,
        observerId: EXACT_REFUND_OBSERVER_ID,
        proof: proof as JsonObject,
      });
      proofAppended = appended === "appended";
      complete = appended !== "conflict";
    }
  }
  // A successful replay is not new evidence. Do not turn the terminal watch
  // into an immediate provider-poll loop merely by reading the same receipt.
  if (inserted > 0 || proofAppended)
    await wakeFundingReconciliationInTransaction(db, {
      operationId: input.operationId,
      dueAt: input.now,
      priority: 10,
      wakeDuringLease: false,
    });
  return {
    kind: complete ? "complete" : "partial",
    inserted,
    reason: complete
      ? null
      : (verified.reason ?? "refund_canonical_set_pending"),
  };
}
