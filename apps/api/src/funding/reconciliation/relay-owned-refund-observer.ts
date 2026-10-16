import type { Pool, PoolClient } from "@hunch/infra";

import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { allocateFundingObservationInTransaction } from "../persistence/funding-operation-repository.js";
import {
  scanFundingReceiveCanonicalEvents,
  type FundingReceiveCanonicalEvent,
  type FundingReceiveEventRpc,
} from "../receive/evm-receive-event-scanner.js";
import type { DirectIngressObservationVariant } from "./direct-ingress-observer.js";
import { relayEvmFundingProfileSpec } from "../execution/relay-evm-profile-specs.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  FundingClassificationChangedError,
  commitFundingClassificationTransaction,
  lockFundingClassificationOperations,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  recordedOwnedRefundEvent,
  prelockOwnedRefundEvents,
  suppressRecordedOwnedRefund,
  claimArbitratedOwnedRefundEvent,
  readProtectedRecordedRefundRoleProof,
  type OwnedRefundPrelock,
} from "./relay-owned-refund-ownership.js";
import type { ReceiveEventClassification } from "../receive/receive-event-classification.js";
import type { FundingEvidenceWorkContext } from "./funding-reducer.js";
import {
  fundingEvidenceBudgetClient,
  FundingEvidenceBudgetExpiredError,
  setFundingEvidenceQueryBudget,
} from "./funding-evidence-budget.js";
import {
  fundingPhysicalEventIsBusy,
  canonicalFundingPhysicalTransactionHash,
} from "../persistence/funding-physical-event-gate.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
} from "./relay-exact-refund-classification.js";
import { verifiedFirstRelayRefundRoleEvidence } from "./relay-exact-refund-proposal.js";
import {
  readSessionlessRolePublicationPhase,
  checkpointSessionlessRolePublicationPhase,
} from "../receive/receive-role-publication-phase.js";
import { lockSessionlessFundingRoleMembershipForPublication } from "../receive/receive-refund-scan.js";
import { prepareReceiveAnchors } from "../receive/prepare-receive-anchors.js";
import type { inspectEvmFundingReceiveAnchor } from "../receive/evm-receive-anchor-proof.js";

// Terminal refund evidence is watched for 15 minutes. Re-scan a bounded Base
// reorg horizon behind the old refund block so a replacement re-mined at a
// lower height remains reachable. The source-debit fence below is authoritative
// and prevents the lookback from admitting a pre-deposit transfer.
const TERMINAL_REFUND_SCAN_BLOCKS = 2_000n;

type RefundTarget = Readonly<{
  userId: string;
  publicationSnapshot: string;
  refundSnapshot: string | null;
  facts: FundingClassificationRevision;
  operationId: string;
  segmentId: string;
  reservationId: string;
  walletAddress: string;
  expectedRaw: string;
  sourceBlock: string;
  sourceEventIndex: string;
  cursorBlock: string;
  refundObservationId: string | null;
  refundBlock: string | null;
  refundBlockHash: string | null;
  refundEventIndex: string | null;
  refundFinalityStatus: string | null;
  refundCanonical: boolean | null;
  refundReorgedAt: string | null;
  refundTransactionHash: string | null;
  transactionReferenceFingerprints: readonly string[];
  networkId: string;
  assetId: string;
  assetDecimals: number;
  profileId: string;
}>;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

async function loadRefundTarget(
  db: Pick<Pool, "query">,
  operationId: string,
  now: Date,
): Promise<RefundTarget | null> {
  const { rows } = await db.query<{
    user_id: string;
    publication_snapshot: string;
    refund_snapshot: string | null;
    classification_revision: string;
    cursor_block: string | null;
    expected_raw: string;
    operation_id: string;
    refund_canonical: boolean | null;
    refund_block: string | null;
    refund_block_hash: string | null;
    refund_event_index: string | null;
    refund_finality_status: string | null;
    refund_observation_id: string | null;
    refund_reorged_at: string | null;
    refund_transaction_hash: string | null;
    reference_fingerprints: unknown;
    reservation_id: string;
    segment_id: string;
    source_block: string;
    source_event_index: string;
    wallet_address: string;
    network_id: string;
    asset_id: string;
    asset_decimals: number;
    profile_id: string;
  }>(
    `select operation.id as operation_id,operation.user_id,
            coalesce(facts_revision.revision,0)::text as classification_revision,
            jsonb_build_object(
              'source',to_jsonb(source_debit),'refund',to_jsonb(refund),
              'reservation',jsonb_build_array(reservation.id,reservation.status,
                reservation.authorization_id,reservation.source_raw,reservation.refund_cursor_block),
              'authority',jsonb_build_array(funding_authorization.id,funding_authorization.wallet_address,funding_authorization.profile_id),
              'userId',operation.user_id,'segmentId',segment.id,
              'references',segment.support_metadata->'relayTransactionReferenceFingerprints',
              'relayStatusCategory',segment.support_metadata->'relayStatusCategory'
            )::text as publication_snapshot,
            case when refund.id is null then null else to_jsonb(refund)::text end as refund_snapshot,
            segment.id as segment_id,
            reservation.id as reservation_id,
            reservation.source_raw::text as expected_raw,
            source_debit.ledger_height as source_block,
            source_debit.event_index as source_event_index,
            reservation.refund_cursor_block::text as cursor_block,
            refund.id::text as refund_observation_id,
            refund.ledger_height as refund_block,
            refund.block_hash as refund_block_hash,
            refund.event_index as refund_event_index,
            refund.tx_hash as refund_transaction_hash,
            refund.finality_status as refund_finality_status,
            refund.canonical as refund_canonical,
            refund.finalized_at as refund_finalized_at,
            to_char(refund.reorged_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as refund_reorged_at,
            segment.support_metadata -> 'relayTransactionReferenceFingerprints'
              as reference_fingerprints,
            funding_authorization.wallet_address
            ,source_debit.network_id
            ,source_debit.asset_id
            ,source_debit.asset_decimals
            ,funding_authorization.profile_id
       from funding_operations operation
       left join funding_classification_revisions facts_revision
         on facts_revision.operation_id = operation.id
       join funding_operation_segments segment
         on segment.operation_id = operation.id
        and segment.ordinal = 0
        and segment.provider_id = 'relay'
       join funding_observations source_debit
         on source_debit.operation_id = operation.id
        and source_debit.segment_id = segment.id
        and source_debit.kind = 'source_debit'
        and source_debit.canonical
        and source_debit.finality_status = 'finalized'
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = case
           when operation.support_metadata ->> 'fundingAuthorizationId'
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then (operation.support_metadata ->> 'fundingAuthorizationId')::uuid
         end
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status in (
              'reserved', 'cleanup_required', 'cleaned', 'refunded'
            )
       left join lateral (
         select candidate.*
           from funding_observations candidate
          where candidate.operation_id = operation.id
            and candidate.kind = 'refund_credit'
          order by coalesce(
                     candidate.reorged_at,
                     candidate.finalized_at,
                     candidate.observed_at
                   ) desc,
                   candidate.created_at desc,
                   candidate.id desc
          limit 1
       ) refund on true
       where operation.id = $1::uuid
         and reservation.status in (
           'reserved', 'cleanup_required', 'cleaned', 'refunded'
         )
         and (
           refund.id is not null
           or (
             segment.support_metadata ->> 'relayStatusCategory' =
                   'refund_in_progress'
             and jsonb_array_length(
                   coalesce(
                     segment.support_metadata ->
                       'relayTransactionReferenceFingerprints',
                     '[]'::jsonb
                   )
                 ) > 0
           )
         )
       limit 1`,
    [operationId],
  );
  const row = rows[0];
  if (!row || !/^[0-9]+$/u.test(row.source_block)) return null;
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
    operationId,
    now,
  });
  if (!facts) return null;
  const lifecycle = deriveFundingLifecycle(facts);
  if (lifecycle.safety.terminal && lifecycle.status !== "refunded") {
    return null;
  }
  const profile = relayEvmFundingProfileSpec(row.profile_id);
  if (
    !profile ||
    profile.sourceAsset.networkId !== row.network_id ||
    profile.sourceAsset.assetId.toLowerCase() !== row.asset_id.toLowerCase() ||
    profile.sourceAsset.decimals !== row.asset_decimals
  ) {
    return null;
  }
  const fingerprints = stringArray(row.reference_fingerprints);
  if (fingerprints.length === 0 && !row.refund_transaction_hash) return null;
  const initialCursor =
    BigInt(row.source_block) > 0n ? BigInt(row.source_block) - 1n : 0n;
  const refundReorgCursor =
    row.refund_block && /^[0-9]+$/u.test(row.refund_block)
      ? BigInt(row.refund_block) > TERMINAL_REFUND_SCAN_BLOCKS
        ? BigInt(row.refund_block) - TERMINAL_REFUND_SCAN_BLOCKS
        : 0n
      : null;
  return {
    userId: row.user_id,
    publicationSnapshot: row.publication_snapshot,
    refundSnapshot: row.refund_snapshot,
    facts: {
      operationId: row.operation_id,
      userId: row.user_id,
      revision: row.classification_revision,
    },
    operationId: row.operation_id,
    segmentId: row.segment_id,
    reservationId: row.reservation_id,
    walletAddress: row.wallet_address,
    expectedRaw: row.expected_raw,
    sourceBlock: row.source_block,
    sourceEventIndex: row.source_event_index,
    cursorBlock:
      refundReorgCursor !== null
        ? (refundReorgCursor > initialCursor
            ? refundReorgCursor
            : initialCursor
          ).toString()
        : row.cursor_block && /^[0-9]+$/u.test(row.cursor_block)
          ? row.cursor_block
          : initialCursor.toString(),
    refundObservationId: row.refund_observation_id,
    refundBlock: row.refund_block,
    refundBlockHash: row.refund_block_hash,
    refundEventIndex: row.refund_event_index,
    refundFinalityStatus: row.refund_finality_status,
    refundCanonical: row.refund_canonical,
    refundReorgedAt: row.refund_reorged_at,
    refundTransactionHash: row.refund_transaction_hash,
    transactionReferenceFingerprints: fingerprints,
    networkId: row.network_id,
    assetId: row.asset_id,
    assetDecimals: row.asset_decimals,
    profileId: row.profile_id,
  };
}

function refundVariant(target: RefundTarget): DirectIngressObservationVariant {
  return {
    variantId: `relay-refund:${target.operationId}`,
    networkId: target.networkId,
    asset: {
      networkId: target.networkId,
      assetId: target.assetId,
      decimals: target.assetDecimals,
    },
    destinationAddress: target.walletAddress,
    destinationLocationId: `relay-refund:${target.walletAddress.toLowerCase()}`,
    baselineRaw: "0",
    baselineRevision: `source-debit:${target.sourceBlock}:${target.sourceEventIndex}`,
    observation: {
      adapterId: "relay_owned_refund_observation_v1",
      payload: { eventCursorBlock: target.cursorBlock },
    },
    completion: { kind: "child_funding_operation" },
  };
}

function afterSourceDebit(
  event: FundingReceiveCanonicalEvent,
  target: Pick<RefundTarget, "sourceBlock" | "sourceEventIndex">,
) {
  const block = BigInt(event.blockNumber);
  const sourceBlock = BigInt(target.sourceBlock);
  return (
    block > sourceBlock ||
    (block === sourceBlock &&
      BigInt(event.eventIndex) > BigInt(target.sourceEventIndex))
  );
}

export function relayOwnedRefundEventMatches(
  input: Readonly<{
    event: FundingReceiveCanonicalEvent;
    expectedRaw: string;
    sourceBlock: string;
    sourceEventIndex: string;
    transactionReferenceFingerprints: readonly string[];
    walletAddress: string;
    networkId?: string;
    fingerprint: (reference: string) => string;
  }>,
): boolean {
  const canonicalReference = canonicalFundingPhysicalTransactionHash({
    networkId: input.networkId ?? "evm:8453",
    transactionHash: input.event.transactionHash,
  });
  const references = new Set([
    input.event.transactionHash,
    ...(canonicalReference ? [canonicalReference] : []),
  ]);
  return (
    input.event.rawAmount === input.expectedRaw &&
    sameAccountAddress(
      input.networkId ?? "evm:8453",
      input.event.destinationAddress,
      input.walletAddress,
    ) &&
    afterSourceDebit(input.event, {
      sourceBlock: input.sourceBlock,
      sourceEventIndex: input.sourceEventIndex,
    }) &&
    [...references].some((reference) =>
      input.transactionReferenceFingerprints.includes(
        input.fingerprint(reference),
      ),
    )
  );
}

// Refused positive effects roll back. Separately committed E/U checkpoints
// retain derived progress; unowned remine uses the canonical-proof adapter.
class OwnedRefundPublicationDeferred extends Error {}

async function persistScan(
  client: PoolClient,
  input: Readonly<{
    target: RefundTarget;
    nextCursor: string;
    matches: readonly FundingReceiveCanonicalEvent[];
    now: Date;
    protectionOnly?: true;
    publication?: Readonly<{
      physical: OwnedRefundPrelock;
      classification: Extract<
        ReceiveEventClassification,
        { kind: "internal_refund" }
      >;
    }>;
  }>,
): Promise<boolean | null> {
  const incoming = input.matches.length === 1 ? input.matches[0] : null;
  const finalizedRefundWatch =
    input.target.refundFinalityStatus === "finalized" &&
    input.target.refundCanonical === true;
  const exactMatch =
    incoming !== null &&
    incoming.blockNumber === input.target.refundBlock &&
    incoming.blockHash.toLowerCase() ===
      input.target.refundBlockHash?.toLowerCase() &&
    incoming.eventIndex === input.target.refundEventIndex &&
    incoming.transactionHash.toLowerCase() ===
      input.target.refundTransactionHash?.toLowerCase();
  // This pass only invalidates the old refund. Do not create ownership for a
  // replacement that will not be published until the next ordinary poll.
  // The full snapshot (including reservation status) is revalidated after O.
  // Receipt facts are authoritative even before the lifecycle projector has
  // marked the reservation refunded. Never publish two positive refunds in
  // that window: invalidate the old one first, exactly as for terminal replay.
  const invalidationOnly = finalizedRefundWatch && !exactMatch;
  const physical =
    input.publication?.physical ??
    (await prelockOwnedRefundEvents(
      client,
      recordedOwnedRefundEvent(input.target.refundSnapshot, input.now),
      incoming && !invalidationOnly && !input.protectionOnly
        ? {
            ...incoming,
            networkId: incoming.variant.networkId,
            asset: incoming.variant.asset,
            ledgerHeight: incoming.blockNumber,
            observedAt: input.now,
            now: input.now,
          }
        : null,
    ));
  const locked = await client.query<{
    reservation_status: string;
  }>(
    `select reservation.status as reservation_status
       from funding_operations operation
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where operation.id = $1::uuid
        and reservation.id = $2::uuid
      for update of operation, reservation`,
    [input.target.operationId, input.target.reservationId],
  );
  const lockedStatus = locked.rows[0]?.reservation_status ?? "";
  if (
    !["reserved", "cleanup_required", "cleaned", "refunded"].includes(
      lockedStatus,
    )
  )
    throw new FundingClassificationChangedError();
  const latest = await loadRefundTarget(
    client,
    input.target.operationId,
    input.now,
  );
  if (
    !latest ||
    latest.publicationSnapshot !== input.target.publicationSnapshot
  )
    throw new FundingClassificationChangedError();
  const previousSuppressed = await suppressRecordedOwnedRefund(
    client,
    physical,
  );
  if (input.protectionOnly && !finalizedRefundWatch) return null;
  const claimPositive = async () => {
    if (!input.publication) throw new OwnedRefundPublicationDeferred();
    const claimed = await claimArbitratedOwnedRefundEvent(client, {
      locked: physical,
      userId: input.target.userId,
      operationId: input.target.operationId,
      segmentId: input.target.segmentId,
      classification: input.publication.classification,
      previousObservationId: input.target.refundObservationId,
      previousReorged:
        input.target.refundFinalityStatus === "reorged" &&
        input.target.refundCanonical === false,
      previousSuppressed,
    });
    if (!claimed) throw new OwnedRefundPublicationDeferred();
  };
  if (
    input.target.refundFinalityStatus === "reorged" &&
    input.target.refundCanonical === false
  ) {
    if (
      !input.target.refundObservationId ||
      !input.target.refundBlock ||
      !input.target.refundBlockHash ||
      !input.target.refundEventIndex ||
      !input.target.refundTransactionHash ||
      !input.target.refundReorgedAt ||
      input.matches.length !== 1
    ) {
      throw new OwnedRefundPublicationDeferred();
    }
    const event = input.matches[0];
    if (!event) throw new OwnedRefundPublicationDeferred();
    const observation = await client.query(
      `select id
         from funding_observations
        where id = $1::uuid
          and operation_id = $2::uuid
          and kind = 'refund_credit'
          and network_id = $9
          and lower(asset_id) = lower($8)
          and metadata ->> 'observerId' =
                'relay_owned_refund_observation_v1'
          and finality_status = 'reorged'
          and not canonical
          and ledger_height = $3
          and lower(block_hash) = lower($4)
          and event_index = $5
          and lower(tx_hash) = lower($6)
          and reorged_at = $7::timestamptz
        for update`,
      [
        input.target.refundObservationId,
        input.target.operationId,
        input.target.refundBlock,
        input.target.refundBlockHash,
        input.target.refundEventIndex,
        input.target.refundTransactionHash,
        input.target.refundReorgedAt,
        input.target.assetId,
        input.target.networkId,
      ],
    );
    if (observation.rowCount !== 1)
      throw new FundingClassificationChangedError();
    await claimPositive();
    const samePhysicalEvent =
      event.eventIndex === input.target.refundEventIndex &&
      event.transactionHash.toLowerCase() ===
        input.target.refundTransactionHash.toLowerCase();
    if (samePhysicalEvent) {
      const restored = await client.query(
        `update funding_observations
            set finality_status = 'finalized',
                canonical = true,
                ledger_height = $2,
                block_hash = $3,
                finalized_at = $4,
                reorged_at = null,
                metadata = metadata || jsonb_build_object(
                  'relayRefundCanonicalityHistory',
                  coalesce(
                    metadata -> 'relayRefundCanonicalityHistory',
                    '[]'::jsonb
                  ) || jsonb_build_array(jsonb_build_object(
                    'previousBlock', ledger_height,
                    'previousBlockHash', block_hash,
                    'reorgedAt', reorged_at,
                    'recanonicalizedAt', $4::timestamptz
                  ))
                )
          where id = $1::uuid
            and finality_status = 'reorged'
            and not canonical
          returning id`,
        [
          input.target.refundObservationId,
          event.blockNumber,
          event.blockHash,
          input.now,
        ],
      );
      if (restored.rowCount !== 1)
        throw new Error("relay refund canonical evidence restore was rejected");
      return true;
    }
    await allocateFundingObservationInTransaction(client, {
      operationId: input.target.operationId,
      segmentId: input.target.segmentId,
      kind: "refund_credit",
      networkId: input.target.networkId,
      assetId: input.target.assetId,
      assetDecimals: input.target.assetDecimals,
      txHash: event.transactionHash,
      eventIndex: event.eventIndex,
      fromAddress: event.sourceAddress,
      toAddress: event.destinationAddress,
      rawAmount: event.rawAmount,
      observedAt: input.now,
      ledgerHeight: event.blockNumber,
      blockHash: event.blockHash,
      finalityStatus: "finalized",
      finalizedAt: input.now,
      metadata: {
        observerId: "relay_owned_refund_observation_v1",
        sourceDebitBlock: input.target.sourceBlock,
        sourceDebitEventIndex: input.target.sourceEventIndex,
        relayTransactionReferenceMatched: true,
        replacementForRefundObservationId: input.target.refundObservationId,
      },
    });
    return true;
  }
  if (finalizedRefundWatch) {
    if (
      !input.target.refundObservationId ||
      !input.target.refundBlock ||
      !input.target.refundBlockHash ||
      !input.target.refundEventIndex ||
      !input.target.refundTransactionHash
    ) {
      throw new OwnedRefundPublicationDeferred();
    }
    const observation = await client.query(
      `select id
         from funding_observations
        where id = $1::uuid
          and operation_id = $2::uuid
          and kind = 'refund_credit'
          and finality_status = 'finalized'
          and canonical
          and ledger_height = $3
          and lower(block_hash) = lower($4)
          and event_index = $5
          and lower(tx_hash) = lower($6)
        for update`,
      [
        input.target.refundObservationId,
        input.target.operationId,
        input.target.refundBlock,
        input.target.refundBlockHash,
        input.target.refundEventIndex,
        input.target.refundTransactionHash,
      ],
    );
    if (observation.rowCount !== 1)
      throw new FundingClassificationChangedError();
    if (exactMatch) {
      // Existing unchanged money: protection and exact snapshot/F suffice.
      // Exhaustive derived role coverage must not delay a truthful replay.
      if (!input.protectionOnly) await claimPositive();
      return true;
    }
    const reorged = await client.query(
      `update funding_observations
          set finality_status = 'reorged',
              canonical = false,
              reorged_at = $2,
              metadata = metadata || jsonb_build_object(
                'reorgReason', 'relay_refund_event_not_canonical'
              )
        where id = $1::uuid
          and finality_status = 'finalized'
          and canonical
        returning id`,
      [input.target.refundObservationId, input.now],
    );
    if (reorged.rowCount !== 1)
      throw new Error("relay refund reorg evidence update was rejected");
    return false;
  }
  // Relay may reveal the authoritative refund transaction hash after the
  // transfer is already canonical. Do not advance past unmatched events;
  // rescan them until the evolving provider reference set proves one exact
  // refund, otherwise a later status update could make evidence unreachable.
  if (input.matches.length !== 1) {
    if (input.target.refundObservationId) {
      await client.query(
        `update funding_observations
            set finality_status = 'reorged',
                canonical = false,
                reorged_at = $2,
                metadata = metadata || jsonb_build_object(
                  'reorgReason', 'relay_refund_event_not_canonical'
                )
          where id = $1::uuid
            and finality_status = 'finalized'
            and canonical`,
        [input.target.refundObservationId, input.now],
      );
    }
    return false;
  }
  const event = input.matches[0];
  if (!event) throw new OwnedRefundPublicationDeferred();
  await claimPositive();
  if (lockedStatus !== "cleaned" && lockedStatus !== "refunded") {
    const cursorUpdate = await client.query(
      `update telegram_funding_authorization_reservations
          set refund_cursor_block = greatest(
                coalesce(refund_cursor_block, 0),
                $2::numeric
              ),
              updated_at = $3
        where id = $1::uuid
          and status in ('reserved', 'cleanup_required')
        returning id`,
      [input.target.reservationId, input.nextCursor, input.now],
    );
    if (cursorUpdate.rowCount !== 1)
      throw new Error("relay refund cursor update was rejected");
  }
  await allocateFundingObservationInTransaction(client, {
    operationId: input.target.operationId,
    segmentId: input.target.segmentId,
    kind: "refund_credit",
    networkId: input.target.networkId,
    assetId: input.target.assetId,
    assetDecimals: input.target.assetDecimals,
    txHash: event.transactionHash,
    eventIndex: event.eventIndex,
    fromAddress: event.sourceAddress,
    toAddress: event.destinationAddress,
    rawAmount: event.rawAmount,
    observedAt: input.now,
    ledgerHeight: event.blockNumber,
    blockHash: event.blockHash,
    finalityStatus: "finalized",
    finalizedAt: input.now,
    metadata: {
      observerId: "relay_owned_refund_observation_v1",
      sourceDebitBlock: input.target.sourceBlock,
      sourceDebitEventIndex: input.target.sourceEventIndex,
      relayTransactionReferenceMatched: true,
    },
  });
  return true;
}

export class RelayOwnedRefundObserver {
  constructor(
    private readonly referenceCodec: Pick<RelayReferenceCodec, "fingerprint">,
    private readonly rpc?: FundingReceiveEventRpc,
    private readonly transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >,
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
    options?: Readonly<{
      work: FundingEvidenceWorkContext & { limit: number };
      inspectCanonicalAnchor?: typeof inspectEvmFundingReceiveAnchor;
    }>,
  ): Promise<
    Readonly<{
      refundsPolled: number;
      refundSatisfied: boolean;
      pendingReason?: string;
    }>
  > {
    const expired = () =>
      options &&
      (!Number.isFinite(options.work.deadlineMs) ||
        Date.now() >= options.work.deadlineMs);
    const noWork = () => ({
      refundsPolled: 0,
      refundSatisfied: false,
      pendingReason: "role_work_budget_exhausted",
    });
    if (expired()) return noWork();
    let target = await loadRefundTarget(pool, operationId, now);
    if (!target) return { refundsPolled: 0, refundSatisfied: false };
    const durableReferences = target.refundTransactionHash
      ? new Set([
          target.refundTransactionHash,
          canonicalFundingPhysicalTransactionHash({
            networkId: target.networkId,
            transactionHash: target.refundTransactionHash,
          }) ?? target.refundTransactionHash,
        ])
      : new Set<string>();
    const scanTarget = durableReferences.size
      ? {
          ...target,
          transactionReferenceFingerprints: [
            ...new Set([
              ...target.transactionReferenceFingerprints,
              ...[...durableReferences].map((reference) =>
                this.referenceCodec.fingerprint(reference),
              ),
            ]),
          ],
        }
      : target;
    if (expired()) return noWork();
    const scan = await scanFundingReceiveCanonicalEvents(
      [refundVariant(scanTarget)],
      now,
      this.rpc,
    );
    if (!scan) return { refundsPolled: 1, refundSatisfied: false };
    const nextCursor = String(
      scan.variants[0]?.observation.payload.eventCursorBlock ??
        scanTarget.cursorBlock,
    );
    const matches = scan.events.filter((event) =>
      relayOwnedRefundEventMatches({
        event,
        expectedRaw: scanTarget.expectedRaw,
        sourceBlock: scanTarget.sourceBlock,
        sourceEventIndex: scanTarget.sourceEventIndex,
        transactionReferenceFingerprints:
          scanTarget.transactionReferenceFingerprints,
        walletAddress: scanTarget.walletAddress,
        networkId: scanTarget.networkId,
        fingerprint: (reference) => this.referenceCodec.fingerprint(reference),
      }),
    );
    const pending = (pendingReason: string) => ({
      refundsPolled: 1,
      refundSatisfied: false,
      pendingReason,
    });
    try {
      // Recorded ownership protection/retraction is independently useful and
      // must commit even when no codec or exhaustive role checkpoint is ready.
      // This branch locks only OLD E -> target O; it never creates new money.
      if (target.refundSnapshot) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("set transaction isolation level read committed");
          const db = options
            ? fundingEvidenceBudgetClient(client, options.work.deadlineMs)
            : client;
          const result = await persistScan(db, {
            target,
            nextCursor,
            matches,
            now,
            protectionOnly: true,
          });
          if (options)
            await setFundingEvidenceQueryBudget(
              client,
              options.work.deadlineMs,
            );
          await commitFundingClassificationTransaction(client, [target.facts]);
          if (result !== null)
            return { refundsPolled: 1, refundSatisfied: result };
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
        const refreshed = await loadRefundTarget(pool, operationId, now);
        // The chain scan was for the frozen source/authority contract, not an
        // opportunity to adopt a concurrently edited amount, source or owner.
        const sourceContext = (snapshot: string) =>
          JSON.stringify({ ...JSON.parse(snapshot), refund: null });
        if (
          !refreshed ||
          sourceContext(refreshed.publicationSnapshot) !==
            sourceContext(target.publicationSnapshot)
        )
          throw new FundingClassificationChangedError();
        target = refreshed;
      }
      if (matches.length !== 1)
        return pending("owned_refund_exact_event_pending");
      if (!options) return pending("role_work_context_pending");
      const raw = matches[0];
      if (!raw) return pending("owned_refund_exact_event_pending");
      const event = {
        ...raw,
        networkId: raw.variant.networkId,
        transactionHash:
          canonicalFundingPhysicalTransactionHash({
            networkId: raw.variant.networkId,
            transactionHash: raw.transactionHash,
          }) ?? raw.transactionHash,
        asset: raw.variant.asset,
        ledgerHeight: raw.blockNumber,
        observedAt: now,
        now,
      };
      const previous = recordedOwnedRefundEvent(target.refundSnapshot, now);
      const samePhysical =
        previous?.networkId === event.networkId &&
        previous.transactionHash === event.transactionHash &&
        previous.eventIndex === event.eventIndex;
      // Owned A -> B has its own proof-scoped adapter. Never feed an owned
      // receipt to the unowned pending-anchor repair or ignore strict anchors.
      if (
        !samePhysical &&
        (await prepareReceiveAnchors(pool, {
          events: [event],
          deadlineMs: options.work.deadlineMs,
          inspect: options.inspectCanonicalAnchor,
        })) !== "ready"
      )
        return pending("role_canonical_anchor_pending");
      let progressPages = 0;
      for (;;) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("set transaction isolation level read committed");
          const db = fundingEvidenceBudgetClient(
            client,
            options.work.deadlineMs,
          );
          const physical = await prelockOwnedRefundEvents(db, previous, event);
          const proof =
            samePhysical && target.refundSnapshot
              ? await readProtectedRecordedRefundRoleProof(db, {
                  locked: physical,
                  receiptSnapshot: target.refundSnapshot,
                  operationId,
                  segmentId: target.segmentId,
                  facts: target.facts,
                })
              : null;
          if (samePhysical && !proof) {
            await client.query("commit");
            return pending("owned_refund_recorded_proof_pending");
          }
          const recorded = await readRecordedRelayRefundRoleEvidence(db, {
            userId: target.userId,
            events: [event],
          });
          const phase = await readSessionlessRolePublicationPhase(db, {
            operationId,
            userId: target.userId,
            events: [event],
            now,
            work: options.work,
            pageOrdinal: progressPages,
            referenceCodec: this.referenceCodec,
            transactionReferenceCodec: this.transactionReferenceCodec,
            refundEvidence: verifiedFirstRelayRefundRoleEvidence(
              {
                events: [event],
                operationId,
                segmentId: target.segmentId,
                facts: target.facts,
              },
              recorded,
            ),
            protectedRefundProofs: proof
              ? new Map([[refundCanonicalEventKey(event), proof]])
              : undefined,
          });
          if (phase.kind !== "ready") {
            if (
              phase.kind === "pending" ||
              progressPages >= options.work.limit
            ) {
              await client.query("commit");
              return pending(phase.reason);
            }
            await checkpointSessionlessRolePublicationPhase(db, phase);
            // Derived E -> U page owns this transaction. Never later acquire O.
            await client.query("commit");
            progressPages++;
            continue;
          }
          const classification = phase.decisions.get(
            refundCanonicalEventKey(event),
          );
          if (
            classification?.kind !== "internal_refund" ||
            classification.match.operationId !== operationId ||
            classification.match.segmentId !== target.segmentId
          ) {
            await client.query("commit");
            return pending("internal_event_classification_conflict");
          }
          const dependencies = [target.facts, ...phase.dependencies];
          await lockFundingClassificationOperations(db, dependencies);
          for (const scan of phase.scans)
            await lockSessionlessFundingRoleMembershipForPublication(db, scan);
          const refundSatisfied = await persistScan(db, {
            target,
            nextCursor,
            matches,
            now,
            publication: { physical, classification },
          });
          if (refundSatisfied === null)
            throw new OwnedRefundPublicationDeferred();
          await setFundingEvidenceQueryBudget(client, options.work.deadlineMs);
          await commitFundingClassificationTransaction(client, dependencies);
          return { refundsPolled: 1, refundSatisfied };
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }
    } catch (error) {
      if (error instanceof OwnedRefundPublicationDeferred)
        return pending("owned_refund_publication_pending");
      if (fundingPhysicalEventIsBusy(error))
        return pending("role_physical_evidence_busy");
      if (
        error instanceof FundingEvidenceBudgetExpiredError ||
        (options &&
          Date.now() >= options.work.deadlineMs &&
          isRecord(error) &&
          ["57014", "55P03"].includes(String(error.code)))
      )
        return pending("role_work_budget_exhausted");
      throw error;
    }
  }
}
