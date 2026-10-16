import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue } from "../../funding/domain/types.js";
import { sameAccountAddress } from "../../funding/domain/asset-identity.js";
import { upsertFundingProviderRequestInTransaction } from "../../funding/persistence/funding-evidence-repository.js";
import { wakeFundingReconciliationInTransaction } from "../../funding/persistence/funding-operation-repository.js";
import { RelayClient } from "./client.js";
import type {
  RelayDepositAddressCodec,
  RelayReferenceCodec,
} from "./reference-codec.js";
import type { RelayRequestListItem, RelayStatusResponse } from "./schemas.js";
import { classifyRelayStatus } from "./status.js";
import { relayDestinationReferenceIdentity } from "./destination-reference.js";
import type { VerifiedRelayWebhook } from "./webhook.js";
import type { FundingEvidenceWorkContext } from "../../funding/reconciliation/funding-reducer.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

type StoredRelaySegment = {
  id: string;
  operation_id: string;
  deposit_address_ciphertext: string | null;
  source_network_id: string | null;
};

type StoredRelayRequest = {
  segment_id: string;
  request_kind: "initial" | "child";
  request_ref_ciphertext: string | null;
  request_ref_lookup_hmac: string;
  lookup_key_version: number;
  discovery_source: string;
};

// Status, receipt and reducer writers share the operation-first lock order.
// Do not hold a request/segment lock while waiting for this row: a receipt
// writer can already own the operation and need those child rows next.
export const RELAY_STATUS_OPERATION_LOCK_SQL = `
  select operation_row.id
    from funding_operations operation_row
    join funding_operation_segments segment
      on segment.operation_id = operation_row.id
   where operation_row.id = $1::uuid
     and segment.id = $2::uuid
     and segment.provider_id = 'relay'
   for update of operation_row
`;

async function lockRelayStatusOperation(
  client: Pick<PoolClient, "query">,
  operationId: string,
  segmentId: string,
): Promise<void> {
  const result = await client.query(RELAY_STATUS_OPERATION_LOCK_SQL, [
    operationId,
    segmentId,
  ]);
  if (result.rowCount !== 1) {
    throw new Error("Relay status operation/segment is no longer available");
  }
}

export const RELAY_WEBHOOK_REQUEST_LOOKUP_SQL = `
  select request.id, segment.operation_id, request.segment_id,
         request.support_metadata
    from funding_provider_requests request
    join funding_operation_segments segment on segment.id = request.segment_id
   where request.request_ref_lookup_hmac = $1
     and request.lookup_key_version = $2
     and segment.provider_id = 'relay'
   limit 2
`;

type StoredWebhookRequest = {
  id: string;
  operation_id: string;
  segment_id: string;
  support_metadata: JsonRecord;
};

function singleWebhookRequest(
  rows: StoredWebhookRequest[],
): StoredWebhookRequest {
  const row = rows[0];
  if (!row) throw new Error("Relay webhook request is not registered");
  if (rows.length !== 1) {
    throw new Error("Relay webhook request correlation is ambiguous");
  }
  return row;
}

function statusSupportMetadata(
  status: RelayStatusResponse,
  source: "polling" | "deposit_address_poll" | "webhook",
  providerUpdatedAt = status.updatedAt,
  referenceFingerprint?: (reference: string) => string,
): JsonRecord {
  const decision = classifyRelayStatus(status.status);
  const safeProviderCode = (value: string | null | undefined) => {
    if (!value) return null;
    return /^[A-Z0-9_:-]{1,128}$/u.test(value) ? value : "UNCLASSIFIED";
  };
  return {
    relayStatusCategory: decision.category,
    relayRequiredEvidence: decision.requiredEvidence,
    relayStatusSource: source,
    ...(providerUpdatedAt !== undefined ? { providerUpdatedAt } : {}),
    originTransactionReferenceCount: status.inTxHashes?.length ?? 0,
    destinationTransactionReferenceCount: status.txHashes?.length ?? 0,
    // Keep the destination role separate from the legacy mixed HMAC array.
    // These are positive associations only; sparse polling cannot erase them.
    relaySuccessfulDestinationReferenceHashesV1:
      decision.category === "provider_success"
        ? (status.txHashes ?? []).map(relayDestinationReferenceIdentity)
        : [],
    ...(referenceFingerprint
      ? {
          relayTransactionReferenceFingerprints: [
            ...(status.inTxHashes ?? []),
            ...(status.txHashes ?? []),
          ].map(referenceFingerprint),
        }
      : {}),
    providerFailurePresent: Boolean(status.failReason),
    providerRefundFailurePresent: Boolean(status.refundFailReason),
    providerFailureCode: safeProviderCode(status.failReason),
    providerRefundFailureCode: safeProviderCode(status.refundFailReason),
  };
}

export const RELAY_SEGMENT_STATUS_UPDATE_SQL = `
      update funding_operation_segments
      set raw_status = case when $5::boolean and (
            support_metadata->>'providerUpdatedAt' is null or
            ($4::numeric is not null and (support_metadata->>'providerUpdatedAt')::numeric <= $4::numeric)
          ) then $2 else raw_status end,
          support_metadata = (support_metadata || case when $5::boolean and (
            support_metadata->>'providerUpdatedAt' is null or
            ($4::numeric is not null and (support_metadata->>'providerUpdatedAt')::numeric <= $4::numeric)
          ) then $3::jsonb else '{}'::jsonb end) ||
            jsonb_build_object(
              'relayTransactionReferenceFingerprints',
              (
                select coalesce(
                         jsonb_agg(fingerprint order by fingerprint),
                         '[]'::jsonb
                       )
                  from (
                    select distinct fingerprint
                      from (
                        select jsonb_array_elements_text(
                                 coalesce(
                                   support_metadata ->
                                     'relayTransactionReferenceFingerprints',
                                   '[]'::jsonb
                                 )
                               ) as fingerprint
                        union all
                        select jsonb_array_elements_text(
                                 coalesce(
                                   case when $5::boolean and (
                                     support_metadata->>'providerUpdatedAt' is null or
                                     ($4::numeric is not null and (support_metadata->>'providerUpdatedAt')::numeric <= $4::numeric)
                                   ) then $3::jsonb -> 'relayTransactionReferenceFingerprints' end,
                                   '[]'::jsonb
                                 )
                               ) as fingerprint
                      ) accumulated
                     where fingerprint ~ '^[a-f0-9]{64}$'
                  ) unique_fingerprints
              )
            ) || jsonb_build_object(
              'relaySuccessfulDestinationReferenceHashesV1',
              (select coalesce(jsonb_agg(reference_hash order by reference_hash), '[]'::jsonb)
                 from (
                   select distinct reference_hash
                     from jsonb_array_elements_text(
                       case when jsonb_typeof(support_metadata->'relaySuccessfulDestinationReferenceHashesV1')='array'
                         then support_metadata->'relaySuccessfulDestinationReferenceHashesV1' else '[]'::jsonb end
                       || coalesce($3::jsonb->'relaySuccessfulDestinationReferenceHashesV1','[]'::jsonb)
                     ) destination_reference(reference_hash)
                    where reference_hash ~ '^[a-f0-9]{64}$'
                 ) unique_destination_references)
            )
      where id = $1 and provider_id = 'relay'
    `;

async function updateSegmentStatusInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    segmentId: string;
    rawStatus: string;
    supportMetadata: JsonRecord;
    providerUpdatedAt: number | undefined;
    advanceStatus?: boolean;
  }>,
): Promise<void> {
  await client.query(RELAY_SEGMENT_STATUS_UPDATE_SQL, [
    input.segmentId,
    input.rawStatus,
    input.supportMetadata,
    input.providerUpdatedAt ?? null,
    input.advanceStatus ?? true,
  ]);
}

function providerTimestampFromMetadata(metadata: JsonRecord): number | null {
  const value = metadata.providerUpdatedAt;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function isStaleProviderStatus(
  existingMetadata: JsonRecord,
  incomingUpdatedAt: number | undefined,
): boolean {
  const existingUpdatedAt = providerTimestampFromMetadata(existingMetadata);
  return (
    existingUpdatedAt !== null &&
    (incomingUpdatedAt === undefined || incomingUpdatedAt < existingUpdatedAt)
  );
}

function webhookFingerprintHistory(metadata: JsonRecord): string[] {
  const value = metadata.relayWebhookFingerprints;
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry),
    );
  }
  const legacyFingerprint = metadata.lastRelayWebhookFingerprint;
  return typeof legacyFingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(legacyFingerprint)
    ? [legacyFingerprint]
    : [];
}

async function persistStatus(
  pool: Pool,
  input: Readonly<{
    operationId: string;
    segmentId: string;
    requestKind: "initial" | "child";
    requestRefLookupHmac: string;
    lookupKeyVersion: number;
    requestCiphertext: string;
    requestDiscoverySource: string;
    status: RelayStatusResponse;
    statusSource: "polling" | "deposit_address_poll";
    referenceCodec: RelayReferenceCodec;
    now: Date;
  }>,
): Promise<void> {
  const metadata = statusSupportMetadata(
    input.status,
    input.statusSource,
    input.status.updatedAt,
    (reference) => input.referenceCodec.fingerprint(reference),
  );
  await tx(pool, async (client) => {
    await lockRelayStatusOperation(client, input.operationId, input.segmentId);
    // Authenticated decryption already established the known request identity.
    // Keep its immutable lookup binding across HMAC-key rotations; otherwise a
    // status poll inserts a duplicate request and the next poll cannot recover.
    const requestHmac = input.requestRefLookupHmac;
    const existingResult = await client.query<{
      support_metadata: JsonRecord;
    }>(
      `
        select support_metadata
        from funding_provider_requests
        where segment_id = $1
          and request_ref_lookup_hmac = $2
        for update
      `,
      [input.segmentId, requestHmac],
    );
    const existing = existingResult.rows[0];
    if (
      existing &&
      isStaleProviderStatus(existing.support_metadata, input.status.updatedAt)
    ) {
      // A historical success may contain a previously unseen destination. It
      // cannot roll back lifecycle status, but its positive association still
      // needs canonical transfer proof and must survive out-of-order delivery.
      await updateSegmentStatusInTransaction(client, {
        segmentId: input.segmentId,
        rawStatus: input.status.status,
        supportMetadata: {
          relaySuccessfulDestinationReferenceHashesV1:
            metadata.relaySuccessfulDestinationReferenceHashesV1 ?? [],
        },
        providerUpdatedAt: input.status.updatedAt,
        advanceStatus: false,
      });
      return;
    }
    await upsertFundingProviderRequestInTransaction(client, {
      operationId: input.operationId,
      segmentId: input.segmentId,
      requestKind: input.requestKind,
      requestRefCiphertext: input.requestCiphertext,
      requestRefLookupHmac: requestHmac,
      rawStatus: input.status.status,
      discoverySource: input.requestDiscoverySource,
      lookupKeyVersion: input.lookupKeyVersion,
      observedAt: input.now,
      supportMetadata: metadata,
    });
    await updateSegmentStatusInTransaction(client, {
      segmentId: input.segmentId,
      rawStatus: input.status.status,
      supportMetadata: metadata,
      providerUpdatedAt: input.status.updatedAt,
    });
    await wakeFundingReconciliationInTransaction(client, {
      wakeDuringLease: false,
      operationId: input.operationId,
      dueAt: input.now,
      priority: 10,
    });
  });
}

export type RelayReceiptObservationTarget = Readonly<{
  operationId: string;
  segmentId: string;
  transactionHashes: readonly string[];
  requestId: string;
  status: RelayStatusResponse;
  now: Date;
  work?: FundingEvidenceWorkContext;
}>;
type RelayReceiptObserver = (
  pool: Pool,
  input: RelayReceiptObservationTarget,
) => Promise<void>;

export class RelayReconciliationDriver {
  constructor(
    readonly client: RelayClient,
    readonly referenceCodec: RelayReferenceCodec,
    readonly depositAddressCodec: RelayDepositAddressCodec,
    private readonly observeDestinationReceipts?: RelayReceiptObserver,
    private readonly observeRefundReceipts?: RelayReceiptObserver,
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
    work?: FundingEvidenceWorkContext,
  ): Promise<Readonly<{ requestsPolled: number; childrenDiscovered: number }>> {
    const segmentResult = await pool.query<StoredRelaySegment>(
      `
        select
          id,
          operation_id,
          deposit_address_ciphertext,
          quoted_input #>> '{asset,networkId}' as source_network_id
        from funding_operation_segments
        where operation_id = $1 and provider_id = 'relay'
        order by ordinal
      `,
      [operationId],
    );
    if (segmentResult.rows.length === 0) {
      return { requestsPolled: 0, childrenDiscovered: 0 };
    }
    const segmentsById = new Map(
      segmentResult.rows.map((segment) => [segment.id, segment] as const),
    );

    const initialRequestResult = await pool.query<StoredRelayRequest>(
      `
        select
          request.segment_id,
          request.request_kind,
          request.request_ref_ciphertext,
          request.request_ref_lookup_hmac,
          request.lookup_key_version,
          request.discovery_source
        from funding_provider_requests request
        join funding_operation_segments segment
          on segment.id = request.segment_id
        where segment.operation_id = $1
          and segment.provider_id = 'relay'
        order by request.first_seen_at, request.id
      `,
      [operationId],
    );
    const existingByRequestId = new Map<
      string,
      StoredRelayRequest & { ciphertext: string }
    >();
    for (const request of initialRequestResult.rows) {
      if (!request.request_ref_ciphertext) {
        throw new Error("Relay provider request is not decryptable");
      }
      const requestId = this.referenceCodec.decrypt(
        request.request_ref_ciphertext,
      );
      if (existingByRequestId.has(requestId)) {
        throw new Error("Relay provider request identity is duplicated");
      }
      existingByRequestId.set(requestId, {
        ...request,
        ciphertext: request.request_ref_ciphertext,
      });
    }
    const depositTargets: Array<{
      segment: StoredRelaySegment;
      depositAddress: string;
      sourceNetworkId: string;
    }> = [];
    for (const segment of segmentResult.rows) {
      if (!segment.deposit_address_ciphertext) continue;
      const sourceNetworkId = segment.source_network_id;
      if (!sourceNetworkId) {
        throw new Error("Relay Deposit Address segment has no source network");
      }
      if (
        ![...existingByRequestId.values()].some(
          (request) =>
            request.segment_id === segment.id &&
            request.request_kind === "initial",
        )
      ) {
        throw new Error(
          "Relay Deposit Address segment is missing its committed initial request",
        );
      }
      const depositAddress = this.depositAddressCodec.decrypt(
        segment.deposit_address_ciphertext,
      );
      depositTargets.push({ segment, depositAddress, sourceNetworkId });
    }
    const knownRequests = [...existingByRequestId.entries()].map(
      ([requestId, request]) => {
        if (!segmentsById.has(request.segment_id)) {
          throw new Error(
            "Relay provider request references another operation",
          );
        }
        return { requestId, request };
      },
    );

    const [depositResults, statusResults] = await Promise.all([
      Promise.all(
        depositTargets.map(
          async ({ segment, depositAddress, sourceNetworkId }) => ({
            segment,
            depositAddress,
            sourceNetworkId,
            requests:
              await this.client.requestsByDepositAddress(depositAddress),
          }),
        ),
      ),
      Promise.all(
        knownRequests.map(async ({ requestId, request }) => ({
          requestId,
          request,
          status: await this.client.status(requestId),
        })),
      ),
    ]);

    let childrenDiscovered = 0;
    for (const {
      segment,
      depositAddress,
      sourceNetworkId,
      requests,
    } of depositResults) {
      const discoveredRequestIds = new Set<string>();
      for (const request of requests) {
        if (discoveredRequestIds.has(request.requestId)) {
          throw new Error("Relay child request discovery returned duplicates");
        }
        discoveredRequestIds.add(request.requestId);
        if (
          request.depositAddress &&
          !sameAccountAddress(
            sourceNetworkId,
            request.depositAddress.address,
            depositAddress,
          )
        ) {
          throw new Error(
            "Relay child request deposit address does not match the operation",
          );
        }
        const existing = existingByRequestId.get(request.requestId);
        if (existing && existing.segment_id !== segment.id) {
          throw new Error(
            "Relay child request is already bound to another segment",
          );
        }
        const requestCiphertext =
          existing?.ciphertext ??
          this.referenceCodec.encrypt(request.requestId);
        const requestHmac =
          existing?.request_ref_lookup_hmac ??
          this.referenceCodec.fingerprint(request.requestId);
        const lookupKeyVersion =
          existing?.lookup_key_version ?? this.referenceCodec.keyVersion;
        await persistStatus(pool, {
          operationId,
          segmentId: segment.id,
          requestKind: existing?.request_kind ?? "child",
          requestRefLookupHmac: requestHmac,
          lookupKeyVersion,
          requestCiphertext,
          requestDiscoverySource:
            existing?.discovery_source ?? "relay_deposit_address_poll",
          status: request,
          statusSource: "deposit_address_poll",
          referenceCodec: this.referenceCodec,
          now,
        });
        if (!existing) {
          childrenDiscovered += 1;
          existingByRequestId.set(request.requestId, {
            segment_id: segment.id,
            request_kind: "child",
            request_ref_ciphertext: requestCiphertext,
            request_ref_lookup_hmac: requestHmac,
            lookup_key_version: lookupKeyVersion,
            discovery_source: "relay_deposit_address_poll",
            ciphertext: requestCiphertext,
          });
        }
      }
    }

    const receiptTargets: RelayReceiptObservationTarget[] = [];
    for (const { requestId, request, status } of statusResults) {
      if (status.requestId !== undefined && status.requestId !== requestId) {
        throw new Error("Relay Status v3 request ID does not match lookup");
      }
      await persistStatus(pool, {
        operationId,
        segmentId: request.segment_id,
        requestKind: request.request_kind,
        requestRefLookupHmac: request.request_ref_lookup_hmac,
        lookupKeyVersion: request.lookup_key_version,
        requestCiphertext: request.ciphertext,
        requestDiscoverySource: request.discovery_source,
        status,
        statusSource: "polling",
        referenceCodec: this.referenceCodec,
        now,
      });
      if (["success", "refund", "refund_in_progress"].includes(status.status)) {
        receiptTargets.push({
          operationId,
          segmentId: request.segment_id,
          transactionHashes: status.txHashes ?? [],
          requestId,
          status,
          now,
          ...(work ? { work } : {}),
        });
      }
    }
    // Persist every provider response first: an RPC outage on one destination
    // must not prevent a sibling leg's status/references from being recorded.
    await Promise.all(
      receiptTargets.map((target) =>
        target.status.status === "success"
          ? this.observeDestinationReceipts?.(pool, target)
          : this.observeRefundReceipts?.(pool, target),
      ),
    );
    return {
      requestsPolled: statusResults.length,
      childrenDiscovered,
    };
  }
}

export async function ingestVerifiedRelayWebhook(
  pool: Pool,
  input: Readonly<{
    webhook: VerifiedRelayWebhook;
    referenceCodec: Pick<RelayReferenceCodec, "fingerprint" | "keyVersion">;
  }>,
): Promise<
  Readonly<{ replayed: boolean; stale: boolean; operationId: string }>
> {
  const requestId = input.webhook.payload.data.requestId;
  const requestHmac = input.referenceCodec.fingerprint(requestId);
  return tx(pool, async (client) => {
    const lookup = [requestHmac, input.referenceCodec.keyVersion];
    // This first read discovers the lock target only. Its mutable status is
    // never used to decide whether the webhook is stale or a replay.
    const discovered = singleWebhookRequest(
      (
        await client.query<StoredWebhookRequest>(
          RELAY_WEBHOOK_REQUEST_LOOKUP_SQL,
          lookup,
        )
      ).rows,
    );
    await lockRelayStatusOperation(
      client,
      discovered.operation_id,
      discovered.segment_id,
    );
    const row = singleWebhookRequest(
      (
        await client.query<StoredWebhookRequest>(
          `${RELAY_WEBHOOK_REQUEST_LOOKUP_SQL} for update of request`,
          lookup,
        )
      ).rows,
    );
    if (
      row.id !== discovered.id ||
      row.operation_id !== discovered.operation_id ||
      row.segment_id !== discovered.segment_id
    ) {
      throw new Error("Relay webhook request identity changed during lookup");
    }
    const fingerprints = webhookFingerprintHistory(row.support_metadata);
    const replayed = fingerprints.includes(input.webhook.deliveryFingerprint);
    const providerUpdatedAt =
      input.webhook.payload.data.updatedAt ?? input.webhook.payload.timestamp;
    const stale = isStaleProviderStatus(
      row.support_metadata,
      providerUpdatedAt,
    );
    const nextFingerprints = replayed
      ? fingerprints
      : [...fingerprints, input.webhook.deliveryFingerprint].slice(-16);
    const applyStatus = !replayed && !stale;
    const incomingMetadata = statusSupportMetadata(
      input.webhook.payload.data,
      "webhook",
      providerUpdatedAt,
      (reference) => input.referenceCodec.fingerprint(reference),
    );
    const metadata: JsonRecord = {
      ...(applyStatus ? incomingMetadata : {}),
      lastRelayWebhookFingerprint: input.webhook.deliveryFingerprint,
      relayWebhookFingerprints: nextFingerprints,
      lastRelayWebhookReceivedAt: input.webhook.receivedAt.toISOString(),
    };
    await client.query(
      `
        update funding_provider_requests
        set raw_status = case when $5 then $2 else raw_status end,
            last_seen_at = greatest(last_seen_at, $3),
            support_metadata = support_metadata || $4::jsonb
        where id = $1
      `,
      [
        row.id,
        input.webhook.payload.data.status,
        input.webhook.receivedAt,
        metadata,
        applyStatus,
      ],
    );
    if (!replayed) {
      await updateSegmentStatusInTransaction(client, {
        segmentId: row.segment_id,
        rawStatus: input.webhook.payload.data.status,
        supportMetadata: applyStatus
          ? metadata
          : {
              relaySuccessfulDestinationReferenceHashesV1:
                incomingMetadata.relaySuccessfulDestinationReferenceHashesV1 ??
                [],
            },
        providerUpdatedAt,
        advanceStatus: applyStatus,
      });
    }
    await wakeFundingReconciliationInTransaction(client, {
      operationId: row.operation_id,
      dueAt: input.webhook.receivedAt,
      priority: 20,
    });
    return { replayed, stale, operationId: row.operation_id };
  });
}

export function requestStatusFromDepositDiscovery(
  request: RelayRequestListItem,
): RelayStatusResponse {
  return request;
}
