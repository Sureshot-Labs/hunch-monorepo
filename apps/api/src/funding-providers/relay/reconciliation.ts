import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue } from "../../funding/domain/types.js";
import { upsertFundingProviderRequestInTransaction } from "../../funding/persistence/funding-evidence-repository.js";
import { wakeFundingReconciliationInTransaction } from "../../funding/persistence/funding-operation-repository.js";
import { RelayClient } from "./client.js";
import type {
  RelayDepositAddressCodec,
  RelayReferenceCodec,
} from "./reference-codec.js";
import type { RelayRequestListItem, RelayStatusResponse } from "./schemas.js";
import { classifyRelayStatus } from "./status.js";
import type { VerifiedRelayWebhook } from "./webhook.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

type StoredRelaySegment = {
  id: string;
  operation_id: string;
  deposit_address_ciphertext: string | null;
};

type StoredRelayRequest = {
  segment_id: string;
  request_kind: "initial" | "child";
  request_ref_ciphertext: string | null;
  discovery_source: string;
};

function statusSupportMetadata(
  status: RelayStatusResponse,
  source: "polling" | "deposit_address_poll" | "webhook",
  providerUpdatedAt = status.updatedAt,
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
    providerFailurePresent: Boolean(status.failReason),
    providerRefundFailurePresent: Boolean(status.refundFailReason),
    providerFailureCode: safeProviderCode(status.failReason),
    providerRefundFailureCode: safeProviderCode(status.refundFailReason),
  };
}

async function updateSegmentStatusInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    segmentId: string;
    rawStatus: string;
    supportMetadata: JsonRecord;
    providerUpdatedAt: number | undefined;
  }>,
): Promise<void> {
  await client.query(
    `
      update funding_operation_segments
      set raw_status = $2,
          support_metadata = support_metadata || $3::jsonb
      where id = $1 and provider_id = 'relay'
        and (
          support_metadata->>'providerUpdatedAt' is null
          or (
            $4::numeric is not null
            and (support_metadata->>'providerUpdatedAt')::numeric <= $4::numeric
          )
        )
    `,
    [
      input.segmentId,
      input.rawStatus,
      input.supportMetadata,
      input.providerUpdatedAt ?? null,
    ],
  );
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
    requestId: string;
    requestCiphertext: string;
    requestDiscoverySource: string;
    status: RelayStatusResponse;
    statusSource: "polling" | "deposit_address_poll";
    referenceCodec: RelayReferenceCodec;
    now: Date;
  }>,
): Promise<void> {
  const metadata = statusSupportMetadata(input.status, input.statusSource);
  await tx(pool, async (client) => {
    const requestHmac = input.referenceCodec.fingerprint(input.requestId);
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
      lookupKeyVersion: input.referenceCodec.keyVersion,
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
      operationId: input.operationId,
      dueAt: input.now,
      priority: 10,
    });
  });
}

export class RelayReconciliationDriver {
  constructor(
    readonly client: RelayClient,
    readonly referenceCodec: RelayReferenceCodec,
    readonly depositAddressCodec: RelayDepositAddressCodec,
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
  ): Promise<Readonly<{ requestsPolled: number; childrenDiscovered: number }>> {
    const segmentResult = await pool.query<StoredRelaySegment>(
      `
        select id, operation_id, deposit_address_ciphertext
        from funding_operation_segments
        where operation_id = $1 and provider_id = 'relay'
        order by ordinal
      `,
      [operationId],
    );
    if (segmentResult.rows.length === 0) {
      return { requestsPolled: 0, childrenDiscovered: 0 };
    }
    if (segmentResult.rows.length !== 1) {
      throw new Error("Relay funding operation must contain one segment");
    }
    const segment = segmentResult.rows[0];
    if (!segment) throw new Error("Relay segment query returned no row");

    const initialRequestResult = await pool.query<StoredRelayRequest>(
      `
        select
          request.segment_id,
          request.request_kind,
          request.request_ref_ciphertext,
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
    if (
      segment.deposit_address_ciphertext &&
      ![...existingByRequestId.values()].some(
        ({ request_kind }) => request_kind === "initial",
      )
    ) {
      throw new Error(
        "Relay Deposit Address segment is missing its committed initial request",
      );
    }

    let childrenDiscovered = 0;
    if (segment.deposit_address_ciphertext) {
      const depositAddress = this.depositAddressCodec.decrypt(
        segment.deposit_address_ciphertext,
      );
      const requests =
        await this.client.requestsByDepositAddress(depositAddress);
      const discoveredRequestIds = new Set<string>();
      for (const request of requests) {
        if (discoveredRequestIds.has(request.requestId)) {
          throw new Error("Relay child request discovery returned duplicates");
        }
        discoveredRequestIds.add(request.requestId);
        if (
          request.depositAddress &&
          request.depositAddress.address.toLowerCase() !==
            depositAddress.toLowerCase()
        ) {
          throw new Error(
            "Relay child request deposit address does not match the operation",
          );
        }
        const existing = existingByRequestId.get(request.requestId);
        const requestCiphertext =
          existing?.ciphertext ??
          this.referenceCodec.encrypt(request.requestId);
        await persistStatus(pool, {
          operationId,
          segmentId: segment.id,
          requestKind: existing?.request_kind ?? "child",
          requestId: request.requestId,
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
            discovery_source: "relay_deposit_address_poll",
            ciphertext: requestCiphertext,
          });
        }
      }
    }

    let requestsPolled = 0;
    for (const [requestId, request] of existingByRequestId) {
      const status = await this.client.status(requestId);
      if (status.requestId !== undefined && status.requestId !== requestId) {
        throw new Error("Relay Status v3 request ID does not match lookup");
      }
      await persistStatus(pool, {
        operationId,
        segmentId: request.segment_id,
        requestKind: request.request_kind,
        requestId,
        requestCiphertext: request.ciphertext,
        requestDiscoverySource: request.discovery_source,
        status,
        statusSource: "polling",
        referenceCodec: this.referenceCodec,
        now,
      });
      requestsPolled += 1;
    }
    return { requestsPolled, childrenDiscovered };
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
    const { rows } = await client.query<{
      id: string;
      operation_id: string;
      segment_id: string;
      support_metadata: JsonRecord;
    }>(
      `
        select
          request.id,
          segment.operation_id,
          request.segment_id,
          request.support_metadata
        from funding_provider_requests request
        join funding_operation_segments segment
          on segment.id = request.segment_id
        where request.request_ref_lookup_hmac = $1
          and request.lookup_key_version = $2
          and segment.provider_id = 'relay'
        for update of request
      `,
      [requestHmac, input.referenceCodec.keyVersion],
    );
    const row = rows[0];
    if (!row) throw new Error("Relay webhook request is not registered");
    if (rows.length !== 1) {
      throw new Error("Relay webhook request correlation is ambiguous");
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
    const metadata: JsonRecord = {
      ...(applyStatus
        ? statusSupportMetadata(
            input.webhook.payload.data,
            "webhook",
            providerUpdatedAt,
          )
        : {}),
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
    if (applyStatus) {
      await updateSegmentStatusInTransaction(client, {
        segmentId: row.segment_id,
        rawStatus: input.webhook.payload.data.status,
        supportMetadata: metadata,
        providerUpdatedAt,
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
