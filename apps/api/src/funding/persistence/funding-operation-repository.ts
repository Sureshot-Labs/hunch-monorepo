import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { FundingPurpose, JsonValue } from "../domain/types.js";
import {
  assertFundingOperationTransition,
  canTransitionSegment,
  isValidFundingOperationState,
  type FundingOperationState,
  type FundingOperationStatus,
  type FundingProgressStage,
  type SegmentStatus,
} from "../domain/transitions.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
  hashOpaqueToken,
} from "./canonical.js";

export type FundingPersistenceErrorCode =
  | "actual_amount_conflict"
  | "ambiguous_duplicate_observation"
  | "idempotency_conflict"
  | "invalid_operation_state"
  | "invalid_segment_transition"
  | "invalid_state_transition"
  | "lease_lost"
  | "operation_not_found"
  | "operation_version_conflict"
  | "quote_consumed"
  | "quote_expired"
  | "quote_invalidated"
  | "quote_mismatch"
  | "quote_not_found";

export class FundingPersistenceError extends Error {
  constructor(
    readonly code: FundingPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FundingPersistenceError";
  }
}

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingQuoteInsert = Readonly<{
  userId: string;
  discoveryProjectionId: string;
  selectedSourceOptionSnapshot: JsonRecord;
  marketContextSnapshot: JsonRecord | null;
  destinationOptionSnapshot: JsonRecord;
  venueBindingSnapshot: JsonRecord | null;
  planSnapshot: FundingCommitPlan;
  policyVersion: number;
  policyRevision: string;
  canonicalRequest: JsonValue;
  consentToken: string;
  expiresAt: Date;
}>;

export type StoredFundingQuote = Readonly<{
  id: string;
  userId: string;
  discoveryProjectionId: string;
  selectedSourceOptionSnapshot: JsonRecord;
  marketContextSnapshot: JsonRecord | null;
  destinationOptionSnapshot: JsonRecord;
  venueBindingSnapshot: JsonRecord | null;
  planSnapshot: FundingCommitPlan;
  policyVersion: number;
  policyRevision: string;
  canonicalRequestHash: string;
  planHash: string;
  consentTokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
}>;

export type FundingCommitSegment = Readonly<{
  providerId: string;
  adapterId: string;
  adapterVersion: number;
  segmentKind:
    | "same_network_swap"
    | "cross_network_transfer"
    | "cross_network_swap"
    | "deposit_address";
  status: SegmentStatus;
  sourceSnapshot: JsonRecord;
  destinationTargetSnapshot: JsonRecord;
  quotedInput: JsonRecord;
  quotedExpectedOutput: JsonRecord;
  quotedMinOutput: JsonRecord;
  providerQuoteRefCiphertext: string | null;
  providerQuoteRefLookupHmac: string | null;
  depositAddressCiphertext: string | null;
  depositAddressLookupHmac: string | null;
  lookupKeyVersion: number;
  refundLocationSnapshot: JsonRecord | null;
  quoteExpiresAt: string;
  supportMetadata?: JsonRecord;
}>;

export type FundingCommitStep = Readonly<{
  ordinal: number;
  segmentOrdinal: number | null;
  stepKind:
    | "approval"
    | "transaction"
    | "signature"
    | "external_handoff"
    | "server_action"
    | "venue_preparation";
  state:
    | "planned"
    | "action_required"
    | "submitted"
    | "succeeded"
    | "reconcile_required"
    | "recovery_required"
    | "failed"
    | "cancelled";
  actionFingerprint: string;
  executorId: string;
  payerRequirement:
    | "none"
    | "user"
    | "provider"
    | "privy_sponsor"
    | "hunch_sponsor";
  dependsOnOrdinal: number | null;
  normalizedAction: JsonRecord;
  actionValidationResult: JsonRecord;
}>;

export type FundingCommitReservation = Readonly<{
  segmentOrdinal: number | null;
  componentId: string;
  locationId: string;
  networkId: string;
  assetId: string;
  assetDecimals: number;
  rawAmount: string;
  mode: "subtract_available" | "advisory_destination" | "settled_for_consumer";
  expiresAt: string;
}>;

export type FundingCommitPlan = Readonly<{
  operation: Readonly<{
    purpose: FundingPurpose;
    initialState: FundingOperationState;
    experienceMode: "instant" | "inline" | "prepare_first";
    planKind:
      | "wallet_route"
      | "relay_deposit_address"
      | "direct_external_handoff"
      | "already_available"
      | "venue_preparation"
      | "composite_route";
    sourceSnapshot: JsonRecord | null;
    destinationTargetSnapshot: JsonRecord;
    externalRecipientId: string | null;
    venueId: string | null;
    marketId: string | null;
    marketContextSnapshot: JsonRecord | null;
    venueBindingSnapshot: JsonRecord | null;
    walletExecutionSnapshot: JsonRecord | null;
    placementSnapshot: JsonRecord;
    requestedSourceAmount: JsonRecord | null;
    requestedDestinationAmount: JsonRecord | null;
    supportMetadata?: JsonRecord;
  }>;
  segments: readonly FundingCommitSegment[];
  steps: readonly FundingCommitStep[];
  reservations: readonly FundingCommitReservation[];
}>;

export type FundingCommitInput = Readonly<{
  userId: string;
  quoteId: string;
  consentToken: string;
  idempotencyKey: string;
  plan: FundingCommitPlan;
  subjectLookupHmac: string;
  subjectLookupKeyVersion: number;
  now?: Date;
  reconciliationDueAt?: Date;
  verifyCurrentFacts?: (
    client: PoolClient,
    quote: StoredFundingQuote,
  ) => Promise<void>;
}>;

export type FundingOperationRow = Readonly<{
  id: string;
  userId: string;
  quoteId: string;
  purpose: FundingPurpose;
  status: FundingOperationStatus;
  progressStage: FundingProgressStage;
  experienceMode: "instant" | "inline" | "prepare_first";
  planKind:
    | "wallet_route"
    | "relay_deposit_address"
    | "direct_external_handoff"
    | "already_available"
    | "venue_preparation"
    | "composite_route";
  idempotencyKey: string;
  commitRequestHash: string;
  planHash: string;
  policyVersion: number;
  policyRevision: string;
  sourceSnapshot: JsonRecord | null;
  destinationTargetSnapshot: JsonRecord;
  externalRecipientId: string | null;
  venueId: string | null;
  marketId: string | null;
  requestedSourceAmount: JsonRecord | null;
  requestedDestinationAmount: JsonRecord | null;
  actualSourceAmount: JsonRecord | null;
  actualDestinationAmount: JsonRecord | null;
  errorCode: string | null;
  supportMetadata: JsonRecord;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}>;

type FundingQuoteDbRow = {
  id: string;
  user_id: string;
  discovery_projection_id: string;
  selected_source_option_snapshot: JsonRecord;
  market_context_snapshot: JsonRecord | null;
  destination_option_snapshot: JsonRecord;
  venue_binding_snapshot: JsonRecord | null;
  plan_snapshot: FundingCommitPlan;
  policy_version: string | number;
  policy_revision: string;
  canonical_request_hash: string;
  plan_hash: string;
  consent_token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
};

type FundingOperationDbRow = {
  id: string;
  user_id: string;
  quote_id: string;
  purpose: FundingPurpose;
  status: FundingOperationStatus;
  progress_stage: FundingProgressStage;
  experience_mode: FundingOperationRow["experienceMode"];
  plan_kind: FundingOperationRow["planKind"];
  idempotency_key: string;
  commit_request_hash: string;
  plan_hash: string;
  policy_version: string | number;
  policy_revision: string;
  source_snapshot: JsonRecord | null;
  destination_target_snapshot: JsonRecord;
  external_recipient_id: string | null;
  venue_id: string | null;
  market_id: string | null;
  requested_source_amount: JsonRecord | null;
  requested_destination_amount: JsonRecord | null;
  actual_source_amount: JsonRecord | null;
  actual_destination_amount: JsonRecord | null;
  error_code: string | null;
  support_metadata: JsonRecord;
  version: string | number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

function mapQuote(row: FundingQuoteDbRow): StoredFundingQuote {
  return {
    id: row.id,
    userId: row.user_id,
    discoveryProjectionId: row.discovery_projection_id,
    selectedSourceOptionSnapshot: row.selected_source_option_snapshot,
    marketContextSnapshot: row.market_context_snapshot,
    destinationOptionSnapshot: row.destination_option_snapshot,
    venueBindingSnapshot: row.venue_binding_snapshot,
    planSnapshot: row.plan_snapshot,
    policyVersion: Number(row.policy_version),
    policyRevision: row.policy_revision,
    canonicalRequestHash: row.canonical_request_hash,
    planHash: row.plan_hash,
    consentTokenHash: row.consent_token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    invalidatedAt: row.invalidated_at,
  };
}

function mapOperation(row: FundingOperationDbRow): FundingOperationRow {
  return {
    id: row.id,
    userId: row.user_id,
    quoteId: row.quote_id,
    purpose: row.purpose,
    status: row.status,
    progressStage: row.progress_stage,
    experienceMode: row.experience_mode,
    planKind: row.plan_kind,
    idempotencyKey: row.idempotency_key,
    commitRequestHash: row.commit_request_hash,
    planHash: row.plan_hash,
    policyVersion: Number(row.policy_version),
    policyRevision: row.policy_revision,
    sourceSnapshot: row.source_snapshot,
    destinationTargetSnapshot: row.destination_target_snapshot,
    externalRecipientId: row.external_recipient_id,
    venueId: row.venue_id,
    marketId: row.market_id,
    requestedSourceAmount: row.requested_source_amount,
    requestedDestinationAmount: row.requested_destination_amount,
    actualSourceAmount: row.actual_source_amount,
    actualDestinationAmount: row.actual_destination_amount,
    errorCode: row.error_code,
    supportMetadata: row.support_metadata,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const quoteColumns = `
  id,
  user_id,
  discovery_projection_id,
  selected_source_option_snapshot,
  market_context_snapshot,
  destination_option_snapshot,
  venue_binding_snapshot,
  plan_snapshot,
  policy_version,
  policy_revision,
  canonical_request_hash,
  plan_hash,
  consent_token_hash,
  expires_at,
  consumed_at,
  invalidated_at
`;

const operationColumns = `
  id,
  user_id,
  quote_id,
  purpose,
  status,
  progress_stage,
  experience_mode,
  plan_kind,
  idempotency_key,
  commit_request_hash,
  plan_hash,
  policy_version,
  policy_revision,
  source_snapshot,
  destination_target_snapshot,
  external_recipient_id,
  venue_id,
  market_id,
  requested_source_amount,
  requested_destination_amount,
  actual_source_amount,
  actual_destination_amount,
  error_code,
  support_metadata,
  version,
  created_at,
  updated_at,
  completed_at
`;

export async function createFundingQuoteInTransaction(
  client: Pick<PoolClient, "query">,
  input: FundingQuoteInsert,
): Promise<StoredFundingQuote> {
  const canonicalRequestHash = canonicalJsonHash(input.canonicalRequest);
  const planHash = canonicalJsonHash(input.planSnapshot);
  const consentTokenHash = hashOpaqueToken(input.consentToken);
  const { rows } = await client.query<FundingQuoteDbRow>(
    `
      insert into funding_quotes (
        user_id,
        discovery_projection_id,
        selected_source_option_snapshot,
        market_context_snapshot,
        destination_option_snapshot,
        venue_binding_snapshot,
        plan_snapshot,
        policy_version,
        policy_revision,
        canonical_request_hash,
        plan_hash,
        consent_token_hash,
        expires_at
      )
      values (
        $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
        $8, $9, $10, $11, $12, $13
      )
      returning ${quoteColumns}
    `,
    [
      input.userId,
      input.discoveryProjectionId,
      input.selectedSourceOptionSnapshot,
      input.marketContextSnapshot,
      input.destinationOptionSnapshot,
      input.venueBindingSnapshot,
      input.planSnapshot,
      input.policyVersion,
      input.policyRevision,
      canonicalRequestHash,
      planHash,
      consentTokenHash,
      input.expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("funding quote insert returned no row");
  return mapQuote(row);
}

export async function createFundingQuote(
  pool: Pool,
  input: FundingQuoteInsert,
): Promise<StoredFundingQuote> {
  return tx(pool, (client) => createFundingQuoteInTransaction(client, input));
}

export async function fetchFundingQuoteForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; quoteId: string }>,
): Promise<StoredFundingQuote | null> {
  const { rows } = await db.query<FundingQuoteDbRow>(
    `
      select ${quoteColumns}
      from funding_quotes
      where user_id = $1 and id = $2
    `,
    [input.userId, input.quoteId],
  );
  return rows[0] ? mapQuote(rows[0]) : null;
}

function assertQuoteMatchesCommit(
  quote: StoredFundingQuote,
  input: FundingCommitInput,
  now: Date,
): string {
  if (quote.invalidatedAt) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "funding quote is invalidated",
    );
  }
  if (quote.consumedAt) {
    throw new FundingPersistenceError(
      "quote_consumed",
      "funding quote is already consumed",
    );
  }
  if (quote.expiresAt.getTime() <= now.getTime()) {
    throw new FundingPersistenceError("quote_expired", "funding quote expired");
  }

  const consentTokenHash = hashOpaqueToken(input.consentToken);
  const inputPlanHash = canonicalJsonHash(input.plan);
  const storedPlanHash = canonicalJsonHash(quote.planSnapshot);
  if (
    consentTokenHash !== quote.consentTokenHash ||
    inputPlanHash !== quote.planHash ||
    storedPlanHash !== quote.planHash
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "consent or committed funding plan does not match the quote",
    );
  }

  const operation = input.plan.operation;
  if (
    !canonicalJsonEqual(
      operation.sourceSnapshot,
      quote.selectedSourceOptionSnapshot,
    ) ||
    !canonicalJsonEqual(
      operation.destinationTargetSnapshot,
      quote.destinationOptionSnapshot,
    ) ||
    !canonicalJsonEqual(
      operation.marketContextSnapshot,
      quote.marketContextSnapshot,
    ) ||
    !canonicalJsonEqual(
      operation.venueBindingSnapshot,
      quote.venueBindingSnapshot,
    )
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "source, destination, market, or binding snapshot differs from quote",
    );
  }
  return consentTokenHash;
}

function commitRequestHash(input: FundingCommitInput): string {
  return canonicalJsonHash({
    consentTokenHash: hashOpaqueToken(input.consentToken),
    planHash: canonicalJsonHash(input.plan),
    quoteId: input.quoteId,
  });
}

function assertReplayMatches(
  existing: FundingOperationRow,
  input: FundingCommitInput,
  expectedCommitRequestHash: string,
): void {
  if (
    existing.quoteId !== input.quoteId ||
    existing.planHash !== canonicalJsonHash(input.plan) ||
    existing.commitRequestHash !== expectedCommitRequestHash
  ) {
    throw new FundingPersistenceError(
      "idempotency_conflict",
      "idempotency key was reused with a different canonical request",
    );
  }
}

async function insertCommitSegments(
  client: Pick<PoolClient, "query">,
  operationId: string,
  segments: readonly FundingCommitSegment[],
  now: Date,
): Promise<ReadonlyMap<number, string>> {
  const segmentIdByOrdinal = new Map<number, string>();
  for (const [ordinal, segment] of segments.entries()) {
    if (
      Boolean(segment.providerQuoteRefCiphertext) !==
      Boolean(segment.providerQuoteRefLookupHmac)
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "provider quote reference must be one protected ciphertext/HMAC tuple",
      );
    }
    const { rows } = await client.query<{ id: string }>(
      `
        insert into funding_operation_segments (
          operation_id,
          ordinal,
          provider_id,
          adapter_id,
          adapter_version,
          segment_kind,
          status,
          source_snapshot,
          destination_target_snapshot,
          quoted_input,
          quoted_expected_output,
          quoted_min_output,
          provider_quote_ref_ciphertext,
          provider_quote_ref_lookup_hmac,
          deposit_address_ciphertext,
          deposit_address_lookup_hmac,
          lookup_key_version,
          refund_location_snapshot,
          quote_expires_at,
          support_metadata
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
          $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18::jsonb,
          $19, $20::jsonb
        )
        returning id
      `,
      [
        operationId,
        ordinal,
        segment.providerId,
        segment.adapterId,
        segment.adapterVersion,
        segment.segmentKind,
        segment.status,
        segment.sourceSnapshot,
        segment.destinationTargetSnapshot,
        segment.quotedInput,
        segment.quotedExpectedOutput,
        segment.quotedMinOutput,
        segment.providerQuoteRefCiphertext,
        segment.providerQuoteRefLookupHmac,
        segment.depositAddressCiphertext,
        segment.depositAddressLookupHmac,
        segment.lookupKeyVersion,
        segment.refundLocationSnapshot,
        segment.quoteExpiresAt,
        segment.supportMetadata ?? {},
      ],
    );
    const segmentId = rows[0]?.id;
    if (!segmentId) throw new Error("funding segment insert returned no row");
    segmentIdByOrdinal.set(ordinal, segmentId);
    if (
      segment.providerQuoteRefCiphertext &&
      segment.providerQuoteRefLookupHmac
    ) {
      await client.query(
        `
          insert into funding_provider_requests (
            segment_id,
            request_kind,
            request_ref_ciphertext,
            request_ref_lookup_hmac,
            discovery_source,
            lookup_key_version,
            first_seen_at,
            last_seen_at,
            support_metadata
          )
          values (
            $1, 'initial', $2, $3, 'committed_quote', $4, $5, $5,
            '{"committed":true}'::jsonb
          )
        `,
        [
          segmentId,
          segment.providerQuoteRefCiphertext,
          segment.providerQuoteRefLookupHmac,
          segment.lookupKeyVersion,
          now,
        ],
      );
    }
  }
  return segmentIdByOrdinal;
}

async function insertCommitSteps(
  client: Pick<PoolClient, "query">,
  operationId: string,
  steps: readonly FundingCommitStep[],
  segmentIdByOrdinal: ReadonlyMap<number, string>,
): Promise<void> {
  const stepIdByOrdinal = new Map<number, string>();
  for (const step of [...steps].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const dependsOnStepId =
      step.dependsOnOrdinal == null
        ? null
        : stepIdByOrdinal.get(step.dependsOnOrdinal);
    if (step.dependsOnOrdinal != null && !dependsOnStepId) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        `step ${step.ordinal} depends on an unavailable prior ordinal`,
      );
    }
    const segmentId =
      step.segmentOrdinal == null
        ? null
        : segmentIdByOrdinal.get(step.segmentOrdinal);
    if (step.segmentOrdinal != null && !segmentId) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        `step ${step.ordinal} references an unavailable segment ordinal`,
      );
    }
    const { rows } = await client.query<{ id: string }>(
      `
        insert into funding_operation_steps (
          operation_id,
          segment_id,
          ordinal,
          step_kind,
          state,
          action_fingerprint,
          executor_id,
          payer_requirement,
          depends_on_step_id,
          normalized_action,
          action_validation_result
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb
        )
        returning id
      `,
      [
        operationId,
        segmentId,
        step.ordinal,
        step.stepKind,
        step.state,
        step.actionFingerprint,
        step.executorId,
        step.payerRequirement,
        dependsOnStepId,
        step.normalizedAction,
        step.actionValidationResult,
      ],
    );
    const insertedId = rows[0]?.id;
    if (!insertedId) throw new Error("funding step insert returned no row");
    stepIdByOrdinal.set(step.ordinal, insertedId);
  }
}

function commitReservations(
  plan: Pick<FundingCommitPlan, "reservations">,
): readonly FundingCommitReservation[] {
  const reservations = plan.reservations;
  if (reservations.length > 32) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "funding plan contains too many balance reservations",
    );
  }
  const keys = new Set<string>();
  for (const reservation of reservations) {
    const key = `${reservation.componentId}\u0000${reservation.mode}`;
    if (
      keys.has(key) ||
      !/^[1-9][0-9]*$/.test(reservation.rawAmount) ||
      (reservation.segmentOrdinal !== null &&
        (!Number.isInteger(reservation.segmentOrdinal) ||
          reservation.segmentOrdinal < 0)) ||
      !Number.isInteger(reservation.assetDecimals) ||
      reservation.assetDecimals < 0 ||
      reservation.assetDecimals > 36 ||
      !Number.isFinite(Date.parse(reservation.expiresAt))
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "funding plan contains an invalid or duplicate balance reservation",
      );
    }
    keys.add(key);
  }
  return reservations;
}

async function insertCommitReservations(
  client: Pick<PoolClient, "query">,
  userId: string,
  operationId: string,
  reservations: readonly FundingCommitReservation[],
  segmentIdByOrdinal: ReadonlyMap<number, string>,
): Promise<void> {
  for (const reservation of reservations) {
    const segmentId =
      reservation.segmentOrdinal == null
        ? null
        : segmentIdByOrdinal.get(reservation.segmentOrdinal);
    if (reservation.segmentOrdinal != null && !segmentId) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "balance reservation references an unavailable segment ordinal",
      );
    }
    await client.query(
      `
        insert into balance_reservations (
          user_id,
          operation_id,
          segment_id,
          component_id,
          location_id,
          network_id,
          asset_id,
          asset_decimals,
          raw_amount,
          mode,
          expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        userId,
        operationId,
        segmentId,
        reservation.componentId,
        reservation.locationId,
        reservation.networkId,
        reservation.assetId,
        reservation.assetDecimals,
        reservation.rawAmount,
        reservation.mode,
        reservation.expiresAt,
      ],
    );
  }
}

export async function commitFundingOperationInTransaction(
  client: PoolClient,
  input: FundingCommitInput,
): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 16 || idempotencyKey.length > 192) {
    throw new FundingPersistenceError(
      "idempotency_conflict",
      "invalid funding idempotency key length",
    );
  }
  if (!isValidFundingOperationState(input.plan.operation.initialState)) {
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "initial funding operation state is not declared by WP1",
    );
  }
  await client.query(
    `
      select pg_advisory_xact_lock(
        hashtextextended($1, 0)
      )
    `,
    [`funding-commit:${input.userId}:${idempotencyKey}`],
  );
  const expectedCommitRequestHash = commitRequestHash(input);
  const existingResult = await client.query<FundingOperationDbRow>(
    `
      select ${operationColumns}
      from funding_operations
      where user_id = $1 and idempotency_key = $2
      for update
    `,
    [input.userId, idempotencyKey],
  );
  const existingRow = existingResult.rows[0];
  if (existingRow) {
    const existing = mapOperation(existingRow);
    assertReplayMatches(existing, input, expectedCommitRequestHash);
    return { operation: existing, replayed: true };
  }

  const quoteResult = await client.query<FundingQuoteDbRow>(
    `
      select ${quoteColumns}
      from funding_quotes
      where user_id = $1 and id = $2
      for update
    `,
    [input.userId, input.quoteId],
  );
  const quoteRow = quoteResult.rows[0];
  if (!quoteRow) {
    throw new FundingPersistenceError(
      "quote_not_found",
      "funding quote was not found for authenticated user",
    );
  }
  const quote = mapQuote(quoteRow);
  const now = input.now ?? new Date();
  const consentTokenHash = assertQuoteMatchesCommit(quote, input, now);
  await input.verifyCurrentFacts?.(client, quote);

  const operationPlan = input.plan.operation;
  const { rows } = await client.query<FundingOperationDbRow>(
    `
      insert into funding_operations (
        user_id,
        quote_id,
        purpose,
        status,
        progress_stage,
        experience_mode,
        plan_kind,
        idempotency_key,
        commit_request_hash,
        plan_hash,
        policy_version,
        policy_revision,
        source_snapshot,
        destination_target_snapshot,
        external_recipient_id,
        venue_id,
        market_id,
        market_context_snapshot,
        venue_binding_snapshot,
        wallet_execution_snapshot,
        placement_snapshot,
        requested_source_amount,
        requested_destination_amount,
        quote_snapshot,
        consent_snapshot,
        support_metadata,
        original_subject_lookup_hmac,
        subject_lookup_key_version,
        created_at,
        updated_at,
        completed_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
        $14::jsonb, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb,
        $21::jsonb, $22::jsonb, $23::jsonb, $24::jsonb, $25::jsonb,
        $26::jsonb, $27, $28, $29, $29, $30
      )
      returning ${operationColumns}
    `,
    [
      input.userId,
      quote.id,
      operationPlan.purpose,
      operationPlan.initialState.status,
      operationPlan.initialState.stage,
      operationPlan.experienceMode,
      operationPlan.planKind,
      idempotencyKey,
      expectedCommitRequestHash,
      quote.planHash,
      quote.policyVersion,
      quote.policyRevision,
      operationPlan.sourceSnapshot,
      operationPlan.destinationTargetSnapshot,
      operationPlan.externalRecipientId,
      operationPlan.venueId,
      operationPlan.marketId,
      operationPlan.marketContextSnapshot,
      operationPlan.venueBindingSnapshot,
      operationPlan.walletExecutionSnapshot,
      operationPlan.placementSnapshot,
      operationPlan.requestedSourceAmount,
      operationPlan.requestedDestinationAmount,
      {
        canonicalRequestHash: quote.canonicalRequestHash,
        discoveryProjectionId: quote.discoveryProjectionId,
        expiresAt: quote.expiresAt.toISOString(),
        planHash: quote.planHash,
        quoteId: quote.id,
      },
      {
        canonicalRequestHash: quote.canonicalRequestHash,
        consentTokenHash,
        consentedAt: now.toISOString(),
      },
      operationPlan.supportMetadata ?? {},
      input.subjectLookupHmac,
      input.subjectLookupKeyVersion,
      now,
      ["completed", "refunded", "failed", "cancelled"].includes(
        operationPlan.initialState.status,
      )
        ? now
        : null,
    ],
  );
  const inserted = rows[0];
  if (!inserted) throw new Error("funding operation insert returned no row");
  const operation = mapOperation(inserted);

  const segmentIdByOrdinal = await insertCommitSegments(
    client,
    operation.id,
    input.plan.segments,
    now,
  );
  await insertCommitSteps(
    client,
    operation.id,
    input.plan.steps,
    segmentIdByOrdinal,
  );
  await insertCommitReservations(
    client,
    input.userId,
    operation.id,
    commitReservations(input.plan),
    segmentIdByOrdinal,
  );
  await client.query(
    `
      insert into funding_reconciliation_jobs (
        operation_id,
        due_at
      )
      values ($1, $2)
    `,
    [operation.id, input.reconciliationDueAt ?? now],
  );
  const consumed = await client.query(
    `
      update funding_quotes
      set consumed_at = $3
      where user_id = $1
        and id = $2
        and consumed_at is null
        and invalidated_at is null
    `,
    [input.userId, quote.id, now],
  );
  if (consumed.rowCount !== 1) {
    throw new FundingPersistenceError(
      "quote_consumed",
      "funding quote was consumed concurrently",
    );
  }

  return { operation, replayed: false };
}

export async function commitFundingOperation(
  pool: Pool,
  input: FundingCommitInput,
): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
  return tx(pool, (client) =>
    commitFundingOperationInTransaction(client, input),
  );
}

export async function fetchFundingOperationForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; operationId: string }>,
): Promise<FundingOperationRow | null> {
  const { rows } = await db.query<FundingOperationDbRow>(
    `
      select ${operationColumns}
      from funding_operations
      where user_id = $1 and id = $2
    `,
    [input.userId, input.operationId],
  );
  return rows[0] ? mapOperation(rows[0]) : null;
}

export async function listFundingOperationsForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    limit: number;
    beforeCreatedAt?: Date | null;
  }>,
): Promise<readonly FundingOperationRow[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("funding operation history limit is outside policy");
  }
  const { rows } = await db.query<FundingOperationDbRow>(
    `
      select ${operationColumns}
      from funding_operations
      where user_id = $1
        and ($2::timestamptz is null or created_at < $2)
      order by created_at desc, id desc
      limit $3
    `,
    [input.userId, input.beforeCreatedAt ?? null, input.limit],
  );
  return rows.map(mapOperation);
}

type FundingOperationScope =
  | Readonly<{ kind: "user"; userId: string }>
  | Readonly<{ kind: "worker" }>;

export type FundingOperationTransitionInput = Readonly<{
  operationId: string;
  scope: FundingOperationScope;
  expectedVersion: number;
  expectedState: FundingOperationState;
  nextState: FundingOperationState;
  actualSourceAmount?: JsonRecord | null;
  actualDestinationAmount?: JsonRecord | null;
  errorCode?: string | null;
  supportMetadataPatch?: JsonRecord;
  now?: Date;
}>;

function assertActualAmountUpdate(
  label: string,
  stored: JsonRecord | null,
  proposed: JsonRecord | null | undefined,
): void {
  if (
    stored != null &&
    proposed !== undefined &&
    proposed !== null &&
    !canonicalJsonEqual(stored, proposed)
  ) {
    throw new FundingPersistenceError(
      "actual_amount_conflict",
      `${label} actual amount cannot be rewritten`,
    );
  }
}

export async function transitionFundingOperationInTransaction(
  client: Pick<PoolClient, "query">,
  input: FundingOperationTransitionInput,
): Promise<FundingOperationRow> {
  const userPredicate = input.scope.kind === "user" ? "and user_id = $2" : "";
  const params =
    input.scope.kind === "user"
      ? [input.operationId, input.scope.userId]
      : [input.operationId];
  const { rows } = await client.query<FundingOperationDbRow>(
    `
      select ${operationColumns}
      from funding_operations
      where id = $1 ${userPredicate}
      for update
    `,
    params,
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation was not found in the requested scope",
    );
  }
  const current = mapOperation(row);
  if (current.version !== input.expectedVersion) {
    throw new FundingPersistenceError(
      "operation_version_conflict",
      "funding operation version changed",
    );
  }
  if (
    current.status !== input.expectedState.status ||
    current.progressStage !== input.expectedState.stage
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation state changed before transition",
    );
  }
  try {
    assertFundingOperationTransition(input.expectedState, input.nextState);
  } catch {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation transition is not declared by WP1",
    );
  }
  assertActualAmountUpdate(
    "source",
    current.actualSourceAmount,
    input.actualSourceAmount,
  );
  assertActualAmountUpdate(
    "destination",
    current.actualDestinationAmount,
    input.actualDestinationAmount,
  );

  const noStateChange =
    input.expectedState.status === input.nextState.status &&
    input.expectedState.stage === input.nextState.stage;
  const noDataChange =
    input.actualSourceAmount === undefined &&
    input.actualDestinationAmount === undefined &&
    input.errorCode === undefined &&
    input.supportMetadataPatch === undefined;
  if (noStateChange && noDataChange) return current;

  const now = input.now ?? new Date();
  const terminal = ["completed", "refunded", "failed", "cancelled"].includes(
    input.nextState.status,
  );
  const updated = await client.query<FundingOperationDbRow>(
    `
      update funding_operations
      set status = $2,
          progress_stage = $3,
          actual_source_amount = case
            when $4::jsonb is null then actual_source_amount
            else $4::jsonb
          end,
          actual_destination_amount = case
            when $5::jsonb is null then actual_destination_amount
            else $5::jsonb
          end,
          error_code = case
            when $6::boolean then $7::text
            else error_code
          end,
          support_metadata = support_metadata || $8::jsonb,
          completed_at = case
            when $9::boolean then $10::timestamptz
            else null
          end,
          version = version + 1
      where id = $1 and version = $11
      returning ${operationColumns}
    `,
    [
      input.operationId,
      input.nextState.status,
      input.nextState.stage,
      input.actualSourceAmount ?? null,
      input.actualDestinationAmount ?? null,
      input.errorCode !== undefined,
      input.errorCode ?? null,
      input.supportMetadataPatch ?? {},
      terminal,
      now,
      input.expectedVersion,
    ],
  );
  const updatedRow = updated.rows[0];
  if (!updatedRow) {
    throw new FundingPersistenceError(
      "operation_version_conflict",
      "funding operation version changed during transition",
    );
  }
  return mapOperation(updatedRow);
}

export async function transitionFundingOperation(
  pool: Pool,
  input: FundingOperationTransitionInput,
): Promise<FundingOperationRow> {
  return tx(pool, (client) =>
    transitionFundingOperationInTransaction(client, input),
  );
}

export type FundingSegmentTransitionInput = Readonly<{
  operationId: string;
  segmentId: string;
  expectedStatus: SegmentStatus;
  nextStatus: SegmentStatus;
  actualInput?: JsonRecord | null;
  actualOutput?: JsonRecord | null;
  rawStatus?: string | null;
  submittedAt?: Date | null;
  settledAt?: Date | null;
  supportMetadataPatch?: JsonRecord;
}>;

export async function transitionFundingSegmentInTransaction(
  client: Pick<PoolClient, "query">,
  input: FundingSegmentTransitionInput,
): Promise<void> {
  if (!canTransitionSegment(input.expectedStatus, input.nextStatus)) {
    throw new FundingPersistenceError(
      "invalid_segment_transition",
      "funding segment transition is not declared by WP1",
    );
  }
  const result = await client.query(
    `
      update funding_operation_segments
      set status = $3,
          actual_input = case
            when $4::jsonb is null then actual_input
            else coalesce(actual_input, $4::jsonb)
          end,
          actual_output = case
            when $5::jsonb is null then actual_output
            else coalesce(actual_output, $5::jsonb)
          end,
          raw_status = case when $6::boolean then $7::text else raw_status end,
          submitted_at = coalesce(submitted_at, $8),
          settled_at = coalesce(settled_at, $9),
          support_metadata = support_metadata || $10::jsonb
      where id = $1
        and operation_id = $2
        and status = $11
        and (
          $4::jsonb is null
          or actual_input is null
          or actual_input = $4::jsonb
        )
        and (
          $5::jsonb is null
          or actual_output is null
          or actual_output = $5::jsonb
        )
    `,
    [
      input.segmentId,
      input.operationId,
      input.nextStatus,
      input.actualInput ?? null,
      input.actualOutput ?? null,
      input.rawStatus !== undefined,
      input.rawStatus ?? null,
      input.submittedAt ?? null,
      input.settledAt ?? null,
      input.supportMetadataPatch ?? {},
      input.expectedStatus,
    ],
  );
  if (result.rowCount !== 1) {
    throw new FundingPersistenceError(
      "invalid_segment_transition",
      "funding segment state or actual amount changed before transition",
    );
  }
}

export type FundingObservationFinality =
  | "observed"
  | "confirmed"
  | "finalized"
  | "reorged";

export type FundingObservationInsert = Readonly<{
  operationId: string;
  segmentId: string | null;
  kind:
    | "source_debit"
    | "source_credit"
    | "intermediate_transfer"
    | "destination_credit"
    | "refund_credit"
    | "venue_readiness";
  networkId: string;
  assetId: string;
  txHash: string;
  eventIndex: string;
  fromAddress: string | null;
  toAddress: string;
  rawAmount: string;
  observedAt: Date;
  ledgerHeight: string | null;
  blockHash: string | null;
  finalityStatus: FundingObservationFinality;
  metadata?: JsonRecord;
  finalizedAt?: Date | null;
  reorgedAt?: Date | null;
}>;

export type FundingObservationRow = Readonly<{
  id: string;
  operationId: string;
  segmentId: string | null;
  kind: FundingObservationInsert["kind"];
  networkId: string;
  assetId: string;
  txHash: string;
  eventIndex: string;
  fromAddress: string | null;
  toAddress: string;
  rawAmount: string;
  observedAt: Date;
  ledgerHeight: string | null;
  blockHash: string | null;
  finalityStatus: FundingObservationFinality;
  canonical: boolean;
  reorgedAt: Date | null;
  finalizedAt: Date | null;
  metadata: JsonRecord;
}>;

type FundingObservationDbRow = {
  id: string;
  operation_id: string;
  segment_id: string | null;
  kind: FundingObservationRow["kind"];
  network_id: string;
  asset_id: string;
  tx_hash: string;
  event_index: string;
  from_address: string | null;
  to_address: string;
  raw_amount: string;
  observed_at: Date;
  ledger_height: string | null;
  block_hash: string | null;
  finality_status: FundingObservationFinality;
  canonical: boolean;
  reorged_at: Date | null;
  finalized_at: Date | null;
  metadata: JsonRecord;
};

const observationColumns = `
  id,
  operation_id,
  segment_id,
  kind,
  network_id,
  asset_id,
  tx_hash,
  event_index,
  from_address,
  to_address,
  raw_amount,
  observed_at,
  ledger_height,
  block_hash,
  finality_status,
  canonical,
  reorged_at,
  finalized_at,
  metadata
`;

function mapObservation(row: FundingObservationDbRow): FundingObservationRow {
  return {
    id: row.id,
    operationId: row.operation_id,
    segmentId: row.segment_id,
    kind: row.kind,
    networkId: row.network_id,
    assetId: row.asset_id,
    txHash: row.tx_hash,
    eventIndex: row.event_index,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    rawAmount: row.raw_amount,
    observedAt: row.observed_at,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash,
    finalityStatus: row.finality_status,
    canonical: row.canonical,
    reorgedAt: row.reorged_at,
    finalizedAt: row.finalized_at,
    metadata: row.metadata,
  };
}

export async function allocateFundingObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: FundingObservationInsert,
): Promise<
  Readonly<{ observation: FundingObservationRow; replayed: boolean }>
> {
  const canonical = input.finalityStatus !== "reorged";
  const { rows } = await client.query<FundingObservationDbRow>(
    `
      insert into funding_observations (
        operation_id,
        segment_id,
        kind,
        network_id,
        asset_id,
        tx_hash,
        event_index,
        from_address,
        to_address,
        raw_amount,
        observed_at,
        ledger_height,
        block_hash,
        finality_status,
        canonical,
        reorged_at,
        finalized_at,
        metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18::jsonb
      )
      on conflict (network_id, tx_hash, event_index, asset_id) do nothing
      returning ${observationColumns}
    `,
    [
      input.operationId,
      input.segmentId,
      input.kind,
      input.networkId,
      input.assetId,
      input.txHash,
      input.eventIndex,
      input.fromAddress,
      input.toAddress,
      input.rawAmount,
      input.observedAt,
      input.ledgerHeight,
      input.blockHash,
      input.finalityStatus,
      canonical,
      input.reorgedAt ?? null,
      input.finalizedAt ?? null,
      input.metadata ?? {},
    ],
  );
  if (rows[0]) {
    return { observation: mapObservation(rows[0]), replayed: false };
  }

  const existingResult = await client.query<FundingObservationDbRow>(
    `
      select ${observationColumns}
      from funding_observations
      where network_id = $1
        and tx_hash = $2
        and event_index = $3
        and asset_id = $4
      for update
    `,
    [input.networkId, input.txHash, input.eventIndex, input.assetId],
  );
  const existingRow = existingResult.rows[0];
  if (!existingRow) {
    throw new FundingPersistenceError(
      "ambiguous_duplicate_observation",
      "observation allocation conflict could not be resolved",
    );
  }
  const existing = mapObservation(existingRow);
  const sameAllocation =
    existing.operationId === input.operationId &&
    existing.segmentId === input.segmentId &&
    existing.kind === input.kind &&
    existing.rawAmount === input.rawAmount &&
    existing.toAddress === input.toAddress &&
    existing.fromAddress === input.fromAddress;
  if (!sameAllocation) {
    throw new FundingPersistenceError(
      "ambiguous_duplicate_observation",
      "transfer is already allocated to a different funding operation",
    );
  }
  return { observation: existing, replayed: true };
}

export async function advanceFundingObservationFinalityInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    observationId: string;
    expectedFinality: FundingObservationFinality;
    nextFinality: FundingObservationFinality;
    finalizedAt?: Date | null;
    reorgedAt?: Date | null;
    metadataPatch?: JsonRecord;
  }>,
): Promise<FundingObservationRow> {
  const reorged = input.nextFinality === "reorged";
  const { rows } = await client.query<FundingObservationDbRow>(
    `
      update funding_observations
      set finality_status = $2,
          canonical = not $3::boolean,
          finalized_at = case
            when $2 in ('finalized', 'reorged')
              then coalesce(finalized_at, $4::timestamptz)
            else finalized_at
          end,
          reorged_at = case
            when $3 then $5::timestamptz
            else null
          end,
          metadata = metadata || $6::jsonb
      where id = $1 and finality_status = $7
      returning ${observationColumns}
    `,
    [
      input.observationId,
      input.nextFinality,
      reorged,
      input.finalizedAt ?? null,
      input.reorgedAt ?? null,
      input.metadataPatch ?? {},
      input.expectedFinality,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding observation finality changed before transition",
    );
  }
  return mapObservation(row);
}

export type FundingReservationRow = Readonly<{
  id: string;
  userId: string;
  operationId: string;
  segmentId: string | null;
  componentId: string;
  locationId: string;
  networkId: string;
  assetId: string;
  assetDecimals: number;
  rawAmount: string;
  mode: FundingCommitReservation["mode"];
  state: "active" | "consumed" | "released";
  expiresAt: Date;
  consumerKind: string | null;
  consumerRef: string | null;
}>;

type FundingReservationDbRow = {
  id: string;
  user_id: string;
  operation_id: string;
  segment_id: string | null;
  component_id: string;
  location_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
  mode: FundingReservationRow["mode"];
  state: FundingReservationRow["state"];
  expires_at: Date;
  consumer_kind: string | null;
  consumer_ref: string | null;
};

function mapReservation(row: FundingReservationDbRow): FundingReservationRow {
  return {
    id: row.id,
    userId: row.user_id,
    operationId: row.operation_id,
    segmentId: row.segment_id,
    componentId: row.component_id,
    locationId: row.location_id,
    networkId: row.network_id,
    assetId: row.asset_id,
    assetDecimals: row.asset_decimals,
    rawAmount: row.raw_amount,
    mode: row.mode,
    state: row.state,
    expiresAt: row.expires_at,
    consumerKind: row.consumer_kind,
    consumerRef: row.consumer_ref,
  };
}

export async function consumeFundingReservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    reservationId: string;
    consumerKind: string;
    consumerRef: string;
    outcomeReason: string;
    now?: Date;
  }>,
): Promise<FundingReservationRow> {
  const currentResult = await client.query<FundingReservationDbRow>(
    `
      select
        id, user_id, operation_id, segment_id, component_id, location_id, network_id,
        asset_id, asset_decimals, raw_amount, mode, state, expires_at,
        consumer_kind, consumer_ref
      from balance_reservations
      where id = $1 and user_id = $2
      for update
    `,
    [input.reservationId, input.userId],
  );
  const current = currentResult.rows[0];
  if (
    current?.state === "consumed" &&
    current.consumer_kind === input.consumerKind &&
    current.consumer_ref === input.consumerRef
  ) {
    return mapReservation(current);
  }
  if (!current || current.state !== "active") {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation is not active for authenticated user",
    );
  }
  const { rows } = await client.query<FundingReservationDbRow>(
    `
      update balance_reservations
      set state = 'consumed',
          consumer_kind = $3,
          consumer_ref = $4,
          outcome_reason = $5,
          consumed_at = $6
      where id = $1 and user_id = $2 and state = 'active'
      returning
        id, user_id, operation_id, segment_id, component_id, location_id, network_id,
        asset_id, asset_decimals, raw_amount, mode, state, expires_at,
        consumer_kind, consumer_ref
    `,
    [
      input.reservationId,
      input.userId,
      input.consumerKind,
      input.consumerRef,
      input.outcomeReason,
      input.now ?? new Date(),
    ],
  );
  if (!rows[0]) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation is not active for authenticated user",
    );
  }
  return mapReservation(rows[0]);
}

export async function releaseFundingReservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    reservationId: string;
    outcomeReason: string;
    now?: Date;
  }>,
): Promise<FundingReservationRow> {
  const { rows } = await client.query<FundingReservationDbRow>(
    `
      update balance_reservations
      set state = 'released',
          outcome_reason = $2,
          released_at = $3
      where id = $1 and state = 'active'
      returning
        id, user_id, operation_id, segment_id, component_id, location_id, network_id,
        asset_id, asset_decimals, raw_amount, mode, state, expires_at,
        consumer_kind, consumer_ref
    `,
    [input.reservationId, input.outcomeReason, input.now ?? new Date()],
  );
  if (!rows[0]) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation is not active",
    );
  }
  return mapReservation(rows[0]);
}

export type FundingReconciliationLease = Readonly<{
  jobId: string;
  operationId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: Date;
  attemptCount: number;
}>;

type FundingReconciliationLeaseDbRow = {
  id: string;
  operation_id: string;
  lease_owner: string;
  lease_token: string;
  lease_until: Date;
  attempt_count: number;
};

function mapLease(
  row: FundingReconciliationLeaseDbRow,
): FundingReconciliationLease {
  return {
    jobId: row.id,
    operationId: row.operation_id,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    attemptCount: row.attempt_count,
  };
}

function boundedLeaseSeconds(leaseSeconds: number): number {
  if (!Number.isFinite(leaseSeconds)) return 30;
  return Math.max(5, Math.min(300, Math.trunc(leaseSeconds)));
}

export async function wakeFundingReconciliationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    dueAt?: Date;
    priority?: number;
  }>,
): Promise<void> {
  const dueAt = input.dueAt ?? new Date();
  await client.query(
    `
      insert into funding_reconciliation_jobs (
        operation_id,
        status,
        due_at,
        priority
      )
      values ($1, 'scheduled', $2, $3)
      on conflict (operation_id) do update set
        due_at = least(funding_reconciliation_jobs.due_at, excluded.due_at),
        priority = greatest(
          funding_reconciliation_jobs.priority,
          excluded.priority
        ),
        status = case
          when funding_reconciliation_jobs.status = 'leased'
            and funding_reconciliation_jobs.lease_until > now()
            then 'leased'
          else 'scheduled'
        end,
        lease_owner = case
          when funding_reconciliation_jobs.status = 'leased'
            and funding_reconciliation_jobs.lease_until > now()
            then funding_reconciliation_jobs.lease_owner
          else null
        end,
        lease_token = case
          when funding_reconciliation_jobs.status = 'leased'
            and funding_reconciliation_jobs.lease_until > now()
            then funding_reconciliation_jobs.lease_token
          else null
        end,
        lease_until = case
          when funding_reconciliation_jobs.status = 'leased'
            and funding_reconciliation_jobs.lease_until > now()
            then funding_reconciliation_jobs.lease_until
          else null
        end,
        completed_at = null
    `,
    [input.operationId, dueAt, input.priority ?? 0],
  );
}

export async function claimFundingReconciliationJobsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    leaseOwner: string;
    limit: number;
    leaseSeconds: number;
    now?: Date;
  }>,
): Promise<readonly FundingReconciliationLease[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  const leaseSeconds = boundedLeaseSeconds(input.leaseSeconds);
  const now = input.now ?? new Date();
  const { rows } = await client.query<FundingReconciliationLeaseDbRow>(
    `
      with candidates as (
        select id
        from funding_reconciliation_jobs
        where (
          status = 'scheduled' and due_at <= $1
        ) or (
          status = 'leased' and lease_until <= $1
        )
        order by priority desc, due_at asc, id asc
        for update skip locked
        limit $2
      )
      update funding_reconciliation_jobs job
      set status = 'leased',
          lease_owner = $3,
          lease_token = gen_random_uuid(),
          lease_until = $1 + make_interval(secs => $4),
          attempt_count = attempt_count + 1,
          completed_at = null
      from candidates
      where job.id = candidates.id
      returning
        job.id,
        job.operation_id,
        job.lease_owner,
        job.lease_token,
        job.lease_until,
        job.attempt_count
    `,
    [now, limit, input.leaseOwner, leaseSeconds],
  );
  return rows.map(mapLease);
}

export async function claimFundingReconciliationJobs(
  pool: Pool,
  input: Parameters<typeof claimFundingReconciliationJobsInTransaction>[1],
): Promise<readonly FundingReconciliationLease[]> {
  return tx(pool, (client) =>
    claimFundingReconciliationJobsInTransaction(client, input),
  );
}

export async function renewFundingReconciliationLease(
  db: Pick<Pool, "query">,
  input: Readonly<{
    jobId: string;
    leaseOwner: string;
    leaseToken: string;
    leaseSeconds: number;
    now?: Date;
  }>,
): Promise<FundingReconciliationLease> {
  const now = input.now ?? new Date();
  const { rows } = await db.query<FundingReconciliationLeaseDbRow>(
    `
      update funding_reconciliation_jobs
      set lease_until = $4 + make_interval(secs => $5)
      where id = $1
        and status = 'leased'
        and lease_owner = $2
        and lease_token = $3
        and lease_until > $4
      returning
        id, operation_id, lease_owner, lease_token, lease_until, attempt_count
    `,
    [
      input.jobId,
      input.leaseOwner,
      input.leaseToken,
      now,
      boundedLeaseSeconds(input.leaseSeconds),
    ],
  );
  if (!rows[0]) {
    throw new FundingPersistenceError(
      "lease_lost",
      "funding reconciliation lease is no longer owned",
    );
  }
  return mapLease(rows[0]);
}

export async function finishFundingReconciliationLease(
  db: Pick<Pool, "query">,
  input: Readonly<{
    jobId: string;
    leaseOwner: string;
    leaseToken: string;
    result:
      | Readonly<{ kind: "completed" }>
      | Readonly<{ kind: "requeue"; dueAt: Date }>
      | Readonly<{
          kind: "error";
          dueAt: Date;
          errorCode: string;
          errorSummary: string;
          deadLetter?: boolean;
        }>;
    now?: Date;
  }>,
): Promise<void> {
  const now = input.now ?? new Date();
  const completed =
    input.result.kind === "completed" ||
    (input.result.kind === "error" && input.result.deadLetter === true);
  const status =
    input.result.kind === "completed"
      ? "completed"
      : input.result.kind === "error" && input.result.deadLetter
        ? "dead_letter"
        : "scheduled";
  const dueAt = input.result.kind === "completed" ? now : input.result.dueAt;
  const errorCode =
    input.result.kind === "error" ? input.result.errorCode : null;
  const errorSummary =
    input.result.kind === "error"
      ? input.result.errorSummary.slice(0, 500)
      : null;
  const result = await db.query(
    `
      update funding_reconciliation_jobs
      set status = $4,
          due_at = $5,
          lease_owner = null,
          lease_token = null,
          lease_until = null,
          last_error_code = $6,
          last_error_summary = $7,
          completed_at = case
            when $8 then $9::timestamptz
            else null
          end
      where id = $1
        and status = 'leased'
        and lease_owner = $2
        and lease_token = $3
    `,
    [
      input.jobId,
      input.leaseOwner,
      input.leaseToken,
      status,
      dueAt,
      errorCode,
      errorSummary,
      completed,
      now,
    ],
  );
  if (result.rowCount !== 1) {
    throw new FundingPersistenceError(
      "lease_lost",
      "stale worker cannot finish funding reconciliation lease",
    );
  }
}

export async function listFundingObservationsForOperation(
  db: Pick<PoolClient, "query">,
  operationId: string,
): Promise<readonly FundingObservationRow[]> {
  const { rows } = await db.query<FundingObservationDbRow>(
    `
      select ${observationColumns}
      from funding_observations
      where operation_id = $1
      order by observed_at asc, id asc
    `,
    [operationId],
  );
  return rows.map(mapObservation);
}

export async function fetchFundingOperationForWorkerInTransaction(
  client: Pick<PoolClient, "query">,
  operationId: string,
): Promise<FundingOperationRow | null> {
  const { rows } = await client.query<FundingOperationDbRow>(
    `
      select ${operationColumns}
      from funding_operations
      where id = $1
      for update
    `,
    [operationId],
  );
  return rows[0] ? mapOperation(rows[0]) : null;
}
