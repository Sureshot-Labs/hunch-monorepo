import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue } from "../domain/types.js";
import { canonicalJsonEqual } from "./canonical.js";
import {
  consumeFundingReservationInTransaction,
  FundingPersistenceError,
} from "./funding-operation-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingWithdrawalDestination = Readonly<{
  id: string;
  userId: string;
  networkId: string;
  assetId: string;
  assetDecimals: number;
  addressCiphertext: string | null;
  addressLookupHmac: string;
  lookupKeyVersion: number;
  validationEvidence: JsonRecord;
  policyVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
}>;

type FundingWithdrawalDestinationDbRow = {
  id: string;
  user_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  address_ciphertext: string | null;
  address_lookup_hmac: string;
  lookup_key_version: number;
  validation_evidence: JsonRecord;
  policy_version: string | number;
  expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
};

const destinationColumns = `
  id,
  user_id,
  network_id,
  asset_id,
  asset_decimals,
  address_ciphertext,
  address_lookup_hmac,
  lookup_key_version,
  validation_evidence,
  policy_version,
  expires_at,
  revoked_at,
  revocation_reason
`;

function mapDestination(
  row: FundingWithdrawalDestinationDbRow,
): FundingWithdrawalDestination {
  return {
    id: row.id,
    userId: row.user_id,
    networkId: row.network_id,
    assetId: row.asset_id,
    assetDecimals: row.asset_decimals,
    addressCiphertext: row.address_ciphertext,
    addressLookupHmac: row.address_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    validationEvidence: row.validation_evidence,
    policyVersion: Number(row.policy_version),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  };
}

export async function registerFundingWithdrawalDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    networkId: string;
    assetId: string;
    assetDecimals: number;
    addressCiphertext: string;
    addressLookupHmac: string;
    lookupKeyVersion: number;
    validationEvidence: JsonRecord;
    policyVersion: number;
    expiresAt: Date;
  }>,
): Promise<
  Readonly<{ destination: FundingWithdrawalDestination; replayed: boolean }>
> {
  const existingResult = await client.query<FundingWithdrawalDestinationDbRow>(
    `
        select ${destinationColumns}
        from funding_withdrawal_destinations
        where user_id = $1
          and network_id = $2
          and asset_id = $3
          and address_lookup_hmac = $4
          and lookup_key_version = $5
          and revoked_at is null
        for update
      `,
    [
      input.userId,
      input.networkId,
      input.assetId,
      input.addressLookupHmac,
      input.lookupKeyVersion,
    ],
  );
  const existingRow = existingResult.rows[0];
  if (existingRow) {
    const existing = mapDestination(existingRow);
    const exactReplay =
      existing.assetDecimals === input.assetDecimals &&
      existing.addressCiphertext === input.addressCiphertext &&
      existing.policyVersion === input.policyVersion &&
      existing.expiresAt.getTime() === input.expiresAt.getTime() &&
      canonicalJsonEqual(existing.validationEvidence, input.validationEvidence);
    if (!exactReplay) {
      throw new FundingPersistenceError(
        "idempotency_conflict",
        "withdrawal destination fingerprint was reused with different evidence",
      );
    }
    return { destination: existing, replayed: true };
  }

  const { rows } = await client.query<FundingWithdrawalDestinationDbRow>(
    `
      insert into funding_withdrawal_destinations (
        user_id,
        network_id,
        asset_id,
        asset_decimals,
        address_ciphertext,
        address_lookup_hmac,
        lookup_key_version,
        validation_evidence,
        policy_version,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      returning ${destinationColumns}
    `,
    [
      input.userId,
      input.networkId,
      input.assetId,
      input.assetDecimals,
      input.addressCiphertext,
      input.addressLookupHmac,
      input.lookupKeyVersion,
      input.validationEvidence,
      input.policyVersion,
      input.expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("withdrawal destination insert returned no row");
  return { destination: mapDestination(row), replayed: false };
}

export async function registerFundingWithdrawalDestination(
  pool: Pool,
  input: Parameters<
    typeof registerFundingWithdrawalDestinationInTransaction
  >[1],
): Promise<
  Readonly<{ destination: FundingWithdrawalDestination; replayed: boolean }>
> {
  return tx(pool, (client) =>
    registerFundingWithdrawalDestinationInTransaction(client, input),
  );
}

export async function fetchFundingWithdrawalDestinationForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; destinationId: string }>,
): Promise<FundingWithdrawalDestination | null> {
  const { rows } = await db.query<FundingWithdrawalDestinationDbRow>(
    `
      select ${destinationColumns}
      from funding_withdrawal_destinations
      where user_id = $1 and id = $2
    `,
    [input.userId, input.destinationId],
  );
  return rows[0] ? mapDestination(rows[0]) : null;
}

export async function revokeFundingWithdrawalDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    destinationId: string;
    reason: string;
    cryptoShred: boolean;
    now?: Date;
  }>,
): Promise<FundingWithdrawalDestination> {
  const { rows } = await client.query<FundingWithdrawalDestinationDbRow>(
    `
      update funding_withdrawal_destinations
      set revoked_at = $4,
          revocation_reason = $3,
          address_ciphertext = case when $5 then null else address_ciphertext end
      where user_id = $1
        and id = $2
        and revoked_at is null
      returning ${destinationColumns}
    `,
    [
      input.userId,
      input.destinationId,
      input.reason,
      input.now ?? new Date(),
      input.cryptoShred,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "active withdrawal destination was not found for authenticated user",
    );
  }
  return mapDestination(row);
}

export type FundingStepAttemptOutcome =
  | "submitted"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "cancelled";

export type FundingStepAttempt = Readonly<{
  id: string;
  stepId: string;
  attemptNumber: number;
  canonicalActionFingerprint: string;
  executorId: string;
  outcome: "started" | FundingStepAttemptOutcome;
  broadcastMayHaveOccurred: boolean;
  referenceKind:
    | "transaction"
    | "signature"
    | "provider_receipt"
    | "external_handoff"
    | null;
  receiptRefCiphertext: string | null;
  receiptRefLookupHmac: string | null;
  lookupKeyVersion: number | null;
  actualCosts: JsonRecord;
  startedAt: Date;
  finishedAt: Date | null;
}>;

type FundingStepAttemptDbRow = {
  id: string;
  step_id: string;
  attempt_number: number;
  canonical_action_fingerprint: string;
  executor_id: string;
  outcome: FundingStepAttempt["outcome"];
  broadcast_may_have_occurred: boolean;
  reference_kind: FundingStepAttempt["referenceKind"];
  receipt_ref_ciphertext: string | null;
  receipt_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
  actual_costs: JsonRecord;
  started_at: Date;
  finished_at: Date | null;
};

const attemptColumns = `
  id,
  step_id,
  attempt_number,
  canonical_action_fingerprint,
  executor_id,
  outcome,
  broadcast_may_have_occurred,
  reference_kind,
  receipt_ref_ciphertext,
  receipt_ref_lookup_hmac,
  lookup_key_version,
  actual_costs,
  started_at,
  finished_at
`;

function mapAttempt(row: FundingStepAttemptDbRow): FundingStepAttempt {
  return {
    id: row.id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    canonicalActionFingerprint: row.canonical_action_fingerprint,
    executorId: row.executor_id,
    outcome: row.outcome,
    broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
    referenceKind: row.reference_kind,
    receiptRefCiphertext: row.receipt_ref_ciphertext,
    receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    actualCosts: row.actual_costs,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function startFundingStepAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    stepId: string;
    canonicalActionFingerprint: string;
    executorId: string;
    now?: Date;
  }>,
): Promise<FundingStepAttempt> {
  const stepResult = await client.query<{
    action_fingerprint: string;
    executor_id: string;
  }>(
    `
      select action_fingerprint, executor_id
      from funding_operation_steps
      where id = $1 and operation_id = $2
      for update
    `,
    [input.stepId, input.operationId],
  );
  const step = stepResult.rows[0];
  if (!step) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step was not found",
    );
  }
  if (
    step.action_fingerprint !== input.canonicalActionFingerprint ||
    step.executor_id !== input.executorId
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "attempt does not match the immutable committed action",
    );
  }

  const previousResult = await client.query<{
    attempt_number: number;
    broadcast_may_have_occurred: boolean;
    outcome: FundingStepAttempt["outcome"];
  }>(
    `
      select attempt_number, outcome, broadcast_may_have_occurred
      from funding_operation_step_attempts
      where step_id = $1
      order by attempt_number desc
      limit 1
      for update
    `,
    [input.stepId],
  );
  const previous = previousResult.rows[0];
  if (
    previous &&
    (previous.outcome === "started" ||
      previous.outcome === "submitted" ||
      previous.outcome === "succeeded" ||
      previous.outcome === "ambiguous" ||
      previous.broadcast_may_have_occurred)
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "previous attempt may have broadcast; reconciliation is required before retry",
    );
  }
  const attemptNumber = (previous?.attempt_number ?? 0) + 1;
  const { rows } = await client.query<FundingStepAttemptDbRow>(
    `
      insert into funding_operation_step_attempts (
        step_id,
        attempt_number,
        canonical_action_fingerprint,
        executor_id,
        started_at
      )
      values ($1, $2, $3, $4, $5)
      returning ${attemptColumns}
    `,
    [
      input.stepId,
      attemptNumber,
      input.canonicalActionFingerprint,
      input.executorId,
      input.now ?? new Date(),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("funding attempt insert returned no row");
  return mapAttempt(row);
}

export async function finishFundingStepAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attemptId: string;
    outcome: FundingStepAttemptOutcome;
    broadcastMayHaveOccurred: boolean;
    referenceKind: FundingStepAttempt["referenceKind"];
    receiptRefCiphertext: string | null;
    receiptRefLookupHmac: string | null;
    lookupKeyVersion: number | null;
    actualCosts: JsonRecord;
    now?: Date;
  }>,
): Promise<FundingStepAttempt> {
  const requiresAmbiguousBroadcastEvidence =
    input.outcome === "submitted" || input.outcome === "ambiguous";
  if (input.broadcastMayHaveOccurred !== requiresAmbiguousBroadcastEvidence) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "broadcast uncertainty is valid only for submitted or ambiguous attempts",
    );
  }
  const hasReference =
    input.referenceKind !== null ||
    input.receiptRefCiphertext !== null ||
    input.receiptRefLookupHmac !== null ||
    input.lookupKeyVersion !== null;
  if (
    hasReference &&
    (input.referenceKind === null ||
      input.receiptRefCiphertext === null ||
      input.receiptRefLookupHmac === null ||
      input.lookupKeyVersion === null)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "attempt receipt reference must be supplied as an encrypted/HMAC tuple",
    );
  }
  const { rows } = await client.query<FundingStepAttemptDbRow>(
    `
      update funding_operation_step_attempts
      set outcome = $2,
          broadcast_may_have_occurred = $3,
          reference_kind = $4,
          receipt_ref_ciphertext = $5,
          receipt_ref_lookup_hmac = $6,
          lookup_key_version = $7,
          actual_costs = $8::jsonb,
          finished_at = $9
      where id = $1 and outcome = 'started'
      returning ${attemptColumns}
    `,
    [
      input.attemptId,
      input.outcome,
      input.broadcastMayHaveOccurred,
      input.referenceKind,
      input.receiptRefCiphertext,
      input.receiptRefLookupHmac,
      input.lookupKeyVersion,
      input.actualCosts,
      input.now ?? new Date(),
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding attempt is already finalized",
    );
  }
  return mapAttempt(row);
}

export type FundingReservationConsumer =
  | Readonly<{ kind: "web_order"; orderId: string }>
  | Readonly<{ kind: "execution"; executionId: string }>
  | Readonly<{ kind: "telegram_trade_intent"; intentId: string }>;

export async function consumeFundingReservationForLinkedConsumerInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    reservationId: string;
    consumer: FundingReservationConsumer;
    outcomeReason: string;
    now?: Date;
  }>,
) {
  const reservationResult = await client.query<{ operation_id: string }>(
    `
      select operation_id
      from balance_reservations
      where id = $1 and user_id = $2 and state = 'active'
      for update
    `,
    [input.reservationId, input.userId],
  );
  const operationId = reservationResult.rows[0]?.operation_id;
  if (!operationId) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation is not active for authenticated user",
    );
  }

  let consumerKind: string;
  let consumerRef: string;
  let linked = false;
  if (input.consumer.kind === "web_order") {
    consumerKind = "web_order";
    consumerRef = input.consumer.orderId;
    const result = await client.query(
      "select 1 from orders where id = $1 and user_id = $2",
      [consumerRef, input.userId],
    );
    linked = result.rowCount === 1;
  } else if (input.consumer.kind === "execution") {
    consumerKind = "execution";
    consumerRef = input.consumer.executionId;
    const result = await client.query(
      "select 1 from executions where id = $1 and user_id = $2",
      [consumerRef, input.userId],
    );
    linked = result.rowCount === 1;
  } else {
    consumerKind = "telegram_trade_intent";
    consumerRef = input.consumer.intentId;
    const result = await client.query(
      `
        select 1
        from telegram_trade_intents
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
      `,
      [consumerRef, input.userId, operationId],
    );
    linked = result.rowCount === 1;
  }
  if (!linked) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "reservation consumer is not linked to authenticated user and operation",
    );
  }

  return consumeFundingReservationInTransaction(client, {
    userId: input.userId,
    reservationId: input.reservationId,
    consumerKind,
    consumerRef,
    outcomeReason: input.outcomeReason,
    now: input.now,
  });
}

export type FundingRouteOutcome =
  | "succeeded"
  | "refunded"
  | "failed"
  | "reconcile_required"
  | "recovery_required"
  | "cancelled";

export async function startFundingRouteObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    routeKeyHmac: string;
    routeKeyVersion: number;
    providerId: string;
    adapterVersion: number;
    amountBand: string;
    policyRevision: string;
    startedAt?: Date;
    supportMetadata?: JsonRecord;
  }>,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
      insert into funding_route_observations (
        user_id,
        operation_id,
        route_key_hmac,
        route_key_version,
        provider_id,
        adapter_version,
        amount_band,
        started_at,
        outcome,
        policy_revision,
        support_metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', $9, $10::jsonb
      )
      returning id
    `,
    [
      input.userId,
      input.operationId,
      input.routeKeyHmac,
      input.routeKeyVersion,
      input.providerId,
      input.adapterVersion,
      input.amountBand,
      input.startedAt ?? new Date(),
      input.policyRevision,
      input.supportMetadata ?? {},
    ],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding route observation ownership was rejected",
    );
  }
  return id;
}

export async function finishFundingRouteObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    routeObservationId: string;
    outcome: FundingRouteOutcome;
    latencyStages: JsonRecord;
    refundObserved: boolean;
    recoveryRequired: boolean;
    reasonCodes?: readonly string[];
    supportMetadata?: JsonRecord;
    finishedAt?: Date;
  }>,
): Promise<void> {
  const result = await client.query(
    `
      update funding_route_observations
      set finished_at = $4,
          latency_stages = $5::jsonb,
          outcome = $3,
          refund_observed = $6,
          recovery_required = $7,
          reason_codes = $8::text[],
          support_metadata = support_metadata || $9::jsonb
      where id = $1
        and user_id = $2
        and outcome = 'in_progress'
        and finished_at is null
    `,
    [
      input.routeObservationId,
      input.userId,
      input.outcome,
      input.finishedAt ?? new Date(),
      input.latencyStages,
      input.refundObserved,
      input.recoveryRequired,
      input.reasonCodes ?? [],
      input.supportMetadata ?? {},
    ],
  );
  if (result.rowCount !== 1) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding route observation is already terminal or out of scope",
    );
  }
}

export async function upsertFundingProviderRequestInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    segmentId: string;
    requestKind: "initial" | "child";
    requestRefCiphertext: string | null;
    requestRefLookupHmac: string;
    rawStatus: string | null;
    discoverySource: string;
    lookupKeyVersion: number;
    observedAt?: Date;
    supportMetadata?: JsonRecord;
  }>,
): Promise<Readonly<{ id: string; replayed: boolean }>> {
  const observedAt = input.observedAt ?? new Date();
  const { rows } = await client.query<{
    id: string;
    inserted: boolean;
    request_kind: "initial" | "child";
    request_ref_ciphertext: string | null;
    lookup_key_version: number;
    discovery_source: string;
  }>(
    `
      with owned_segment as (
        select segment.id
        from funding_operation_segments segment
        where segment.id = $1 and segment.operation_id = $2
      ),
      written as (
        insert into funding_provider_requests (
          segment_id,
          request_kind,
          request_ref_ciphertext,
          request_ref_lookup_hmac,
          raw_status,
          discovery_source,
          lookup_key_version,
          first_seen_at,
          last_seen_at,
          support_metadata
        )
        select
          owned_segment.id,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $9,
          $10::jsonb
        from owned_segment
        on conflict (segment_id, request_ref_lookup_hmac) do update set
          raw_status = excluded.raw_status,
          last_seen_at = greatest(
            funding_provider_requests.last_seen_at,
            excluded.last_seen_at
          ),
          support_metadata =
            funding_provider_requests.support_metadata
            || excluded.support_metadata
        returning
          id,
          request_kind,
          request_ref_ciphertext,
          lookup_key_version,
          discovery_source,
          (xmax = 0) as inserted
      )
      select * from written
    `,
    [
      input.segmentId,
      input.operationId,
      input.requestKind,
      input.requestRefCiphertext,
      input.requestRefLookupHmac,
      input.rawStatus,
      input.discoverySource,
      input.lookupKeyVersion,
      observedAt,
      input.supportMetadata ?? {},
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding segment was not found for operation",
    );
  }
  if (
    row.request_kind !== input.requestKind ||
    row.request_ref_ciphertext !== input.requestRefCiphertext ||
    row.lookup_key_version !== input.lookupKeyVersion ||
    row.discovery_source !== input.discoverySource
  ) {
    throw new FundingPersistenceError(
      "idempotency_conflict",
      "provider request fingerprint was reused with different identity",
    );
  }
  return { id: row.id, replayed: !row.inserted };
}
