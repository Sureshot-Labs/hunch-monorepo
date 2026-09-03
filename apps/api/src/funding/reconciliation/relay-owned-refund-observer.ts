import { tx, type Pool, type PoolClient } from "@hunch/infra";

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

// Terminal refund evidence is watched for 15 minutes. Re-scan a bounded Base
// reorg horizon behind the old refund block so a replacement re-mined at a
// lower height remains reachable. The source-debit fence below is authoritative
// and prevents the lookback from admitting a pre-deposit transfer.
const TERMINAL_REFUND_SCAN_BLOCKS = 2_000n;

type RefundTarget = Readonly<{
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
  refundReorgedAt: Date | null;
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
    cursor_block: string | null;
    expected_raw: string;
    operation_id: string;
    refund_canonical: boolean | null;
    refund_block: string | null;
    refund_block_hash: string | null;
    refund_event_index: string | null;
    refund_finality_status: string | null;
    refund_observation_id: string | null;
    refund_reorged_at: Date | null;
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
    `select operation.id as operation_id,
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
            refund.reorged_at as refund_reorged_at,
            segment.support_metadata -> 'relayTransactionReferenceFingerprints'
              as reference_fingerprints,
            funding_authorization.wallet_address
            ,source_debit.network_id
            ,source_debit.asset_id
            ,source_debit.asset_decimals
            ,funding_authorization.profile_id
       from funding_operations operation
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
         on funding_authorization.id::text =
              operation.support_metadata ->> 'fundingAuthorizationId'
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
    input.transactionReferenceFingerprints.includes(
      input.fingerprint(input.event.transactionHash),
    )
  );
}

async function persistScan(
  client: PoolClient,
  input: Readonly<{
    target: RefundTarget;
    nextCursor: string;
    matches: readonly FundingReceiveCanonicalEvent[];
    now: Date;
  }>,
): Promise<boolean> {
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
    return false;
  const terminalRefundWatch =
    input.target.refundFinalityStatus === "finalized" &&
    input.target.refundCanonical === true &&
    ["cleaned", "refunded"].includes(lockedStatus);
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
      return false;
    }
    const event = input.matches[0];
    if (!event) return false;
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
    if (observation.rowCount !== 1) return false;
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
  if (terminalRefundWatch) {
    if (
      !input.target.refundObservationId ||
      !input.target.refundBlock ||
      !input.target.refundBlockHash ||
      !input.target.refundEventIndex ||
      !input.target.refundTransactionHash
    ) {
      return false;
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
    if (observation.rowCount !== 1) return false;
    const exactMatch =
      input.matches.length === 1 &&
      input.matches[0]?.blockNumber === input.target.refundBlock &&
      input.matches[0]?.blockHash.toLowerCase() ===
        input.target.refundBlockHash.toLowerCase() &&
      input.matches[0]?.eventIndex === input.target.refundEventIndex &&
      input.matches[0]?.transactionHash.toLowerCase() ===
        input.target.refundTransactionHash.toLowerCase();
    if (exactMatch) return true;
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
  if (!event) return false;
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
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
  ): Promise<Readonly<{ refundsPolled: number; refundSatisfied: boolean }>> {
    const target = await loadRefundTarget(pool, operationId, now);
    if (!target) return { refundsPolled: 0, refundSatisfied: false };
    const durableRefundFingerprint = target.refundTransactionHash
      ? this.referenceCodec.fingerprint(target.refundTransactionHash)
      : null;
    const scanTarget = durableRefundFingerprint
      ? {
          ...target,
          transactionReferenceFingerprints: [
            ...new Set([
              ...target.transactionReferenceFingerprints,
              durableRefundFingerprint,
            ]),
          ],
        }
      : target;
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
    const refundSatisfied = await tx(pool, (client) =>
      persistScan(client, { target: scanTarget, nextCursor, matches, now }),
    );
    return { refundsPolled: 1, refundSatisfied };
  }
}
