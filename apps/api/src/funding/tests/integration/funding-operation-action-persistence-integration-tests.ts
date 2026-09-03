#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { ethers } from "ethers";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS } from "../../execution/polymarket-deposit-wallet-handoff.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  fetchFundingOperationStepForUser,
  finishFundingStepAttemptForUserInTransaction,
  listFundingOperationStepsForUser,
  listPotentialPolymarketHandoffsForCanonicalEvents,
  startFundingStepAttemptForUserInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  fetchFundingOperationForUser,
  FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import { applyFundingStepReceiptEvidenceInTransaction } from "../../persistence/funding-step-receipt-repository.js";

const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
} as const;

function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function insertUser(
  client: Readonly<{ query: typeof pool.query }>,
  label: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`funding-action-${label}-${crypto.randomUUID()}@example.com`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("funding action test user insert failed");
  return id;
}

async function expectFundingError(
  promise: Promise<unknown>,
  code: FundingPersistenceError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FundingPersistenceError);
    assert.equal(error.code, code);
    return true;
  });
}

const client = await pool.connect();
try {
  await client.query("begin");
  const userId = await insertUser(client, "owner");
  const otherUserId = await insertUser(client, "other");
  const identityUserId = await insertUser(client, "identity-fence");
  const expiredIdentityUserId = await insertUser(
    client,
    "expired-identity-fence",
  );
  const sourceLocation = {
    kind: "wallet",
    locationId: opaque("location"),
    accountId: userId,
    asset: ASSET,
    details: {
      walletId: opaque("wallet"),
      address: "0x00000000000000000000000000000000000000a1",
    },
  } as const;
  const handoffToken = "0x1111111111111111111111111111111111111111";
  const handoffFunder = "0x2222222222222222222222222222222222222222";
  const handoffRecipient = "0x3333333333333333333333333333333333333333";
  const handoffAmount = "8736244";
  const handoffTransferData = new ethers.Interface([
    "function transfer(address recipient,uint256 amount)",
  ]).encodeFunctionData("transfer", [handoffRecipient, BigInt(handoffAmount)]);
  const action = {
    kind: "external_handoff",
    actionId: opaque("action"),
    networkId: ASSET.networkId,
    actorWalletId: sourceLocation.details.walletId,
    handoffKind: "polymarket_deposit_wallet_transfer",
    payload: {
      topology: "deposit_wallet",
      funder: handoffFunder,
      recipient: handoffRecipient,
      token: handoffToken,
      amountRaw: handoffAmount,
      calls: [
        {
          target: handoffToken,
          value: "0",
          data: handoffTransferData,
        },
      ],
    },
  } as const;
  const actionValidationResult = {
    executionEnvelope: "polymarket_deposit_wallet_to_controller_v1",
    funderAddress: handoffFunder,
    recipientAddress: handoffRecipient,
    tokenAddress: handoffToken,
    amountRaw: handoffAmount,
    transferData: handoffTransferData,
  } as const;
  const actionExecutorId = "polymarket_deposit_wallet_relayer_v1";
  const actionFingerprint = canonicalJsonHash(action);
  const secondSourceLocation = {
    ...sourceLocation,
    locationId: opaque("location"),
    details: {
      ...sourceLocation.details,
      walletId: opaque("wallet"),
      address: "0x00000000000000000000000000000000000000a2",
    },
  } as const;
  const secondAction = {
    kind: "evm_transaction",
    actionId: opaque("action"),
    networkId: ASSET.networkId,
    senderWalletId: secondSourceLocation.details.walletId,
    to: "0x00000000000000000000000000000000000000b1",
    data: "0x",
    valueRaw: "0",
    gasLimitRaw: "21000",
  } as const;
  const secondActionFingerprint = canonicalJsonHash(secondAction);
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "composite_route",
      sourceSnapshot: { kind: "composite", legCount: 2 },
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: {
          ...sourceLocation,
          locationId: opaque("destination"),
        },
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: {},
      requestedSourceAmount: null,
      requestedDestinationAmount: { asset: ASSET, raw: "1980000" },
      supportMetadata: { test: true },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "same_network_swap",
        status: "planned",
        sourceSnapshot: { kind: "owned_location", location: sourceLocation },
        destinationTargetSnapshot: {
          kind: "owned_location",
          location: {
            ...sourceLocation,
            locationId: opaque("segment-destination"),
          },
        },
        quotedInput: { asset: ASSET, raw: "1000000" },
        quotedExpectedOutput: { asset: ASSET, raw: "995000" },
        quotedMinOutput: { asset: ASSET, raw: "990000" },
        providerQuoteRefCiphertext: "ciphertext:request",
        providerQuoteRefLookupHmac: hash("request"),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: sourceLocation,
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "same_network_swap",
        status: "planned",
        sourceSnapshot: {
          kind: "owned_location",
          location: secondSourceLocation,
        },
        destinationTargetSnapshot: {
          kind: "owned_location",
          location: {
            ...sourceLocation,
            locationId: opaque("segment-destination"),
          },
        },
        quotedInput: { asset: ASSET, raw: "1000000" },
        quotedExpectedOutput: { asset: ASSET, raw: "995000" },
        quotedMinOutput: { asset: ASSET, raw: "990000" },
        providerQuoteRefCiphertext: "ciphertext:request-2",
        providerQuoteRefLookupHmac: hash("request-2"),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: secondSourceLocation,
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: 0,
        stepKind: "external_handoff",
        state: "action_required",
        actionFingerprint,
        executorId: actionExecutorId,
        payerRequirement: "provider",
        dependsOnOrdinal: null,
        normalizedAction: action,
        actionValidationResult,
      },
      {
        ordinal: 1,
        segmentOrdinal: 1,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint: secondActionFingerprint,
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "user",
        dependsOnOrdinal: null,
        normalizedAction: secondAction,
        actionValidationResult: { valid: true },
      },
    ],
    reservations: [
      {
        segmentOrdinal: 0,
        componentId: opaque("component"),
        locationId: sourceLocation.locationId,
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        rawAmount: "1000000",
        mode: "subtract_available",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        segmentOrdinal: 1,
        componentId: opaque("component"),
        locationId: secondSourceLocation.locationId,
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        rawAmount: "1000000",
        mode: "subtract_available",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
  const consentToken = opaque("consent");
  const quote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "policy_revision_wp6_action",
    canonicalRequest: { source: plan.operation.sourceSnapshot },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const committed = await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: opaque("idempotency"),
    plan,
    subjectLookupHmac: hash("user"),
    subjectLookupKeyVersion: 1,
  });
  const firstCommittedStep = await client.query<{ id: string }>(
    `select id
       from funding_operation_steps
      where operation_id = $1 and ordinal = 0`,
    [committed.operation.id],
  );
  const firstCommittedStepId = firstCommittedStep.rows[0]?.id;
  assert.ok(firstCommittedStepId);
  await client.query("savepoint projected_step_state_read");
  await client.query(
    `update funding_operation_steps
        set state = 'recovery_required'
      where id = $1`,
    [firstCommittedStepId],
  );
  const projectedStep = await fetchFundingOperationStepForUser(client, {
    userId,
    operationId: committed.operation.id,
    stepId: firstCommittedStepId,
  });
  assert.equal(projectedStep?.state, "action_required");
  const projectedSteps = await listFundingOperationStepsForUser(client, {
    userId,
    operationId: committed.operation.id,
  });
  assert.deepEqual(
    projectedSteps.map((step) => step.state),
    ["action_required", "action_required"],
  );
  await client.query("rollback to savepoint projected_step_state_read");

  const preRouteRelayAction = {
    ...secondAction,
    actionId: opaque("action"),
    senderWalletId: sourceLocation.details.walletId,
  } as const;
  const primarySegment = plan.segments[0];
  const handoffStep = plan.steps[0];
  const primaryReservation = plan.reservations[0];
  assert.ok(primarySegment);
  assert.ok(handoffStep);
  assert.ok(primaryReservation);
  const preRoutePlan: FundingCommitPlan = {
    operation: {
      ...plan.operation,
      planKind: "wallet_route",
      sourceSnapshot: { kind: "owned_location", location: sourceLocation },
      supportMetadata: { test: true, preRouteHandoff: true },
    },
    segments: [
      {
        ...primarySegment,
        providerQuoteRefCiphertext: "ciphertext:pre-route-request",
        providerQuoteRefLookupHmac: hash("pre-route-request"),
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    steps: [
      {
        ...handoffStep,
        segmentOrdinal: null,
      },
      {
        ordinal: 1,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint: canonicalJsonHash(preRouteRelayAction),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "user",
        dependsOnOrdinal: 0,
        normalizedAction: preRouteRelayAction,
        actionValidationResult: { valid: true },
      },
    ],
    reservations: [
      {
        ...primaryReservation,
        componentId: opaque("component"),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
  const preRouteConsentToken = opaque("consent");
  const preRouteQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot: preRoutePlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: preRoutePlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: preRoutePlan,
    policyVersion: 1,
    policyRevision: "policy_revision_pre_route_handoff",
    canonicalRequest: { source: preRoutePlan.operation.sourceSnapshot },
    consentToken: preRouteConsentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const preRouteCommitted = await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: preRouteQuote.id,
    consentToken: preRouteConsentToken,
    idempotencyKey: opaque("idempotency"),
    plan: preRoutePlan,
    subjectLookupHmac: hash("pre-route-user"),
    subjectLookupKeyVersion: 1,
  });
  await client.query("set constraints all immediate");
  const preRouteShape = await client.query<{
    action_expires_at: Date;
    depends_on_step_id: string | null;
    ordinal: number;
    quote_expires_at: Date | null;
    segment_id: string | null;
  }>(
    `
      select
        funding_step.action_expires_at,
        funding_step.depends_on_step_id,
        funding_step.ordinal,
        funding_segment.quote_expires_at,
        funding_step.segment_id
      from funding_operation_steps funding_step
      left join funding_operation_segments funding_segment
        on funding_segment.id = funding_step.segment_id
      where funding_step.operation_id = $1
      order by funding_step.ordinal
    `,
    [preRouteCommitted.operation.id],
  );
  assert.equal(preRouteShape.rows.length, 2);
  assert.equal(preRouteShape.rows[0]?.segment_id, null);
  assert.equal(preRouteShape.rows[0]?.depends_on_step_id, null);
  assert.ok(preRouteShape.rows[0]?.action_expires_at);
  assert.ok(preRouteShape.rows[1]?.segment_id);
  assert.ok(preRouteShape.rows[1]?.depends_on_step_id);
  assert.ok(preRouteShape.rows[1]?.quote_expires_at);
  const storedPreRouteStep = preRouteShape.rows[0];
  const storedRelayStep = preRouteShape.rows[1];
  assert.ok(storedPreRouteStep);
  assert.ok(storedRelayStep?.quote_expires_at);
  assert.ok(
    storedPreRouteStep.action_expires_at.getTime() >
      storedRelayStep.quote_expires_at.getTime(),
    "the user-authorized pre-route handoff must outlive the downstream Relay quote",
  );
  await client.query("set constraints all deferred");

  const secondPlanStep = plan.steps[1];
  assert.ok(secondPlanStep);
  const legacyCompositePlan: FundingCommitPlan = {
    ...plan,
    operation: {
      ...plan.operation,
      supportMetadata: { test: true, preRouteHandoff: true },
    },
    segments: plan.segments.map((segment, index) => ({
      ...segment,
      providerQuoteRefCiphertext: `ciphertext:legacy-composite:${index}`,
      providerQuoteRefLookupHmac: hash(`legacy-composite:${index}`),
    })),
    steps: [
      {
        ...handoffStep,
        ordinal: 0,
        segmentOrdinal: null,
        dependsOnOrdinal: null,
      },
      {
        ...handoffStep,
        ordinal: 1,
        segmentOrdinal: 0,
        dependsOnOrdinal: 0,
        normalizedAction: preRouteRelayAction,
        actionFingerprint: canonicalJsonHash(preRouteRelayAction),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "user",
        actionValidationResult: { valid: true },
      },
      {
        ...secondPlanStep,
        ordinal: 2,
        segmentOrdinal: 1,
        dependsOnOrdinal: null,
      },
    ],
    reservations: plan.reservations.map((reservation) => ({
      ...reservation,
      componentId: opaque("component"),
      locationId: opaque("location"),
    })),
  };
  const legacyCompositeConsentToken = opaque("consent");
  const legacyCompositeQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot:
      legacyCompositePlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot:
      legacyCompositePlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: legacyCompositePlan,
    policyVersion: 1,
    policyRevision: "policy_revision_legacy_composite_handoff",
    canonicalRequest: { source: legacyCompositePlan.operation.sourceSnapshot },
    consentToken: legacyCompositeConsentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: legacyCompositeQuote.id,
    consentToken: legacyCompositeConsentToken,
    idempotencyKey: opaque("idempotency"),
    plan: legacyCompositePlan,
    subjectLookupHmac: hash("legacy-composite-handoff-user"),
    subjectLookupKeyVersion: 1,
  });
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");

  await client.query("savepoint invalid_pre_route_shape");
  const storedHandoffStep = preRoutePlan.steps[0];
  const storedRelayActionStep = preRoutePlan.steps[1];
  const storedReservation = preRoutePlan.reservations[0];
  assert.ok(storedHandoffStep);
  assert.ok(storedRelayActionStep);
  assert.ok(storedReservation);
  const invalidPreRoutePlan: FundingCommitPlan = {
    ...preRoutePlan,
    steps: [
      {
        ...storedHandoffStep,
        executorId: "wallet_profile_evm_v1",
      },
      storedRelayActionStep,
    ],
    reservations: [
      {
        ...storedReservation,
        componentId: opaque("component"),
      },
    ],
  };
  const invalidConsentToken = opaque("consent");
  const invalidQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot:
      invalidPreRoutePlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot:
      invalidPreRoutePlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: invalidPreRoutePlan,
    policyVersion: 1,
    policyRevision: "policy_revision_invalid_pre_route_handoff",
    canonicalRequest: { source: invalidPreRoutePlan.operation.sourceSnapshot },
    consentToken: invalidConsentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: invalidQuote.id,
    consentToken: invalidConsentToken,
    idempotencyKey: opaque("idempotency"),
    plan: invalidPreRoutePlan,
    subjectLookupHmac: hash("invalid-pre-route-user"),
    subjectLookupKeyVersion: 1,
  });
  await assert.rejects(
    client.query("set constraints all immediate"),
    /unbound funding steps require a preparation-compatible plan kind/u,
  );
  await client.query("rollback to savepoint invalid_pre_route_shape");
  await client.query("set constraints all deferred");

  const routerApprovalAction = {
    ...secondAction,
    actionId: opaque("action"),
    senderWalletId: sourceLocation.details.walletId,
    to: handoffToken,
  } as const;
  const routerFundAction = {
    ...secondAction,
    actionId: opaque("action"),
    senderWalletId: sourceLocation.details.walletId,
    to: "0x4444444444444444444444444444444444444444",
  } as const;
  const controllerHandoffQuoteExpiresAt = new Date(Date.now() + 60_000);
  const durableReservationExpiresAt = new Date(
    controllerHandoffQuoteExpiresAt.getTime() +
      FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  ).toISOString();
  const depositSourceComponentId = opaque("component");
  const futureControllerComponentId = opaque("component");
  const controllerHandoffPlan: FundingCommitPlan = {
    operation: {
      ...preRoutePlan.operation,
      planKind: "venue_preparation",
      sourceSnapshot: {
        kind: "venue_preparation",
        inputCount: 2,
      },
      supportMetadata: {
        test: true,
        preparationKind: "polymarket_funding_router",
        adapterId: "polymarket_funding_router_v1",
        planValidation: {
          validatorId: "polymarket_funding_router_v1",
          version: 1,
        },
        preRouteHandoff: true,
      },
    },
    segments: [],
    steps: [
      {
        ...storedHandoffStep,
        segmentOrdinal: null,
      },
      {
        ordinal: 1,
        segmentOrdinal: null,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint: canonicalJsonHash(routerApprovalAction),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "user",
        dependsOnOrdinal: 0,
        normalizedAction: routerApprovalAction,
        actionValidationResult: {
          valid: true,
          validatorId: "polymarket_funding_router_v1",
          kind: "controller_usdce_router_approval",
          signerAddress: sourceLocation.details.address,
          routerAddress: routerFundAction.to,
          sponsorshipPolicyId: null,
          signingMode: "user_signature",
        },
      },
      {
        ordinal: 2,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "action_required",
        actionFingerprint: canonicalJsonHash(routerFundAction),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "user",
        dependsOnOrdinal: 1,
        normalizedAction: routerFundAction,
        actionValidationResult: {
          valid: true,
          validatorId: "polymarket_funding_router_v1",
        },
      },
    ],
    reservations: [
      {
        ...storedReservation,
        segmentOrdinal: null,
        componentId: depositSourceComponentId,
        expiresAt: durableReservationExpiresAt,
      },
      {
        ...storedReservation,
        segmentOrdinal: null,
        componentId: futureControllerComponentId,
        locationId: secondSourceLocation.locationId,
        economicRole: "future_credit_fence",
        expiresAt: durableReservationExpiresAt,
      },
    ],
  };
  const controllerHandoffConsentToken = opaque("consent");
  const controllerHandoffQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot:
      controllerHandoffPlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot:
      controllerHandoffPlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: controllerHandoffPlan,
    policyVersion: 1,
    policyRevision: "policy_revision_controller_handoff",
    canonicalRequest: {
      source: controllerHandoffPlan.operation.sourceSnapshot,
    },
    consentToken: controllerHandoffConsentToken,
    expiresAt: controllerHandoffQuoteExpiresAt,
  });
  const controllerHandoffCommitted = await commitFundingOperationInTransaction(
    client,
    {
      userId,
      quoteId: controllerHandoffQuote.id,
      consentToken: controllerHandoffConsentToken,
      idempotencyKey: opaque("idempotency"),
      plan: controllerHandoffPlan,
      subjectLookupHmac: hash("controller-handoff-user"),
      subjectLookupKeyVersion: 1,
    },
  );
  await client.query("set constraints all immediate");
  const controllerHandoffShape = await client.query<{
    action_expires_at: Date | null;
    executor_id: string;
    ordinal: number;
    step_kind: string;
  }>(
    `
      select ordinal, step_kind, executor_id, action_expires_at
      from funding_operation_steps
      where operation_id = $1
      order by ordinal
    `,
    [controllerHandoffCommitted.operation.id],
  );
  assert.deepEqual(controllerHandoffShape.rows, [
    {
      action_expires_at: controllerHandoffShape.rows[0]?.action_expires_at,
      executor_id: "polymarket_deposit_wallet_relayer_v1",
      ordinal: 0,
      step_kind: "external_handoff",
    },
    {
      action_expires_at: controllerHandoffShape.rows[1]?.action_expires_at,
      executor_id: "wallet_profile_evm_v1",
      ordinal: 1,
      step_kind: "transaction",
    },
    {
      action_expires_at: controllerHandoffShape.rows[2]?.action_expires_at,
      executor_id: "wallet_profile_evm_v1",
      ordinal: 2,
      step_kind: "venue_preparation",
    },
  ]);
  assert.ok(
    controllerHandoffShape.rows.every(
      (step) =>
        step.action_expires_at != null &&
        step.action_expires_at.getTime() > Date.now() + 14 * 60_000,
    ),
    "the committed handoff, approvals, and Router fund must all outlive the 45-second inspection",
  );
  const durableReservations = await client.query<{
    component_id: string;
    expires_at: Date;
    operation_expires_at: Date;
  }>(
    `
      select
        reservation_row.component_id,
        reservation_row.expires_at,
        operation_row.expires_at as operation_expires_at
      from balance_reservations reservation_row
      join funding_operations operation_row
        on operation_row.id = reservation_row.operation_id
      where reservation_row.operation_id = $1
      order by reservation_row.component_id
    `,
    [controllerHandoffCommitted.operation.id],
  );
  assert.deepEqual(
    durableReservations.rows.map((reservation) => reservation.component_id),
    [depositSourceComponentId, futureControllerComponentId].sort(),
  );
  assert.ok(
    durableReservations.rows.every(
      (reservation) =>
        reservation.expires_at.getTime() >=
        reservation.operation_expires_at.getTime(),
    ),
    "both sides of the Deposit Wallet handoff must stay fenced through the full operation lifetime",
  );
  await client.query("set constraints all deferred");

  const compositeRouterPlan: FundingCommitPlan = {
    operation: {
      ...controllerHandoffPlan.operation,
      planKind: "composite_route",
      sourceSnapshot: { kind: "composite", legCount: 2 },
      supportMetadata: {
        ...controllerHandoffPlan.operation.supportMetadata,
        composite: true,
        containsVenuePreparation: true,
      },
    },
    segments: [
      {
        ...primarySegment,
        providerQuoteRefCiphertext: "ciphertext:composite-router-request",
        providerQuoteRefLookupHmac: hash("composite-router-request"),
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    steps: [
      ...controllerHandoffPlan.steps,
      {
        ...storedRelayActionStep,
        ordinal: controllerHandoffPlan.steps.length,
        segmentOrdinal: 0,
        dependsOnOrdinal: null,
      },
    ],
    reservations: [
      ...controllerHandoffPlan.reservations.map((reservation) => ({
        ...reservation,
        componentId: opaque("component"),
      })),
      {
        ...storedReservation,
        segmentOrdinal: 0,
        componentId: opaque("component"),
        expiresAt: durableReservationExpiresAt,
      },
    ],
  };
  const compositeRouterConsentToken = opaque("consent");
  const compositeRouterQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot:
      compositeRouterPlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot:
      compositeRouterPlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: compositeRouterPlan,
    policyVersion: 1,
    policyRevision: "policy_revision_composite_router_handoff",
    canonicalRequest: {
      source: compositeRouterPlan.operation.sourceSnapshot,
    },
    consentToken: compositeRouterConsentToken,
    expiresAt: controllerHandoffQuoteExpiresAt,
  });
  const compositeRouterCommitted = await commitFundingOperationInTransaction(
    client,
    {
      userId,
      quoteId: compositeRouterQuote.id,
      consentToken: compositeRouterConsentToken,
      idempotencyKey: opaque("idempotency"),
      plan: compositeRouterPlan,
      subjectLookupHmac: hash("composite-router-handoff-user"),
      subjectLookupKeyVersion: 1,
    },
  );
  await client.query("set constraints all immediate");
  const compositeRouterShape = await client.query<{
    bound_steps: string;
    unbound_steps: string;
  }>(
    `select count(*) filter (where segment_id is not null)::text as bound_steps,
            count(*) filter (where segment_id is null)::text as unbound_steps
       from funding_operation_steps
      where operation_id = $1::uuid`,
    [compositeRouterCommitted.operation.id],
  );
  assert.deepEqual(compositeRouterShape.rows[0], {
    bound_steps: "1",
    unbound_steps: "3",
  });
  await client.query("set constraints all deferred");

  const compositeRouterActions = await client.query<{
    action_fingerprint: string;
    executor_id: string;
    id: string;
    ordinal: number;
  }>(
    `select id, ordinal, action_fingerprint, executor_id
       from funding_operation_steps
      where operation_id = $1::uuid
        and segment_id is null
      order by ordinal`,
    [compositeRouterCommitted.operation.id],
  );
  const compositeHandoffStep = compositeRouterActions.rows[0];
  const compositeApprovalStep = compositeRouterActions.rows[1];
  const compositeFundStep = compositeRouterActions.rows[2];
  assert.ok(compositeHandoffStep);
  assert.ok(compositeApprovalStep);
  assert.ok(compositeFundStep);
  const compositeHandoffAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: compositeRouterCommitted.operation.id,
      stepId: compositeHandoffStep.id,
      canonicalActionFingerprint: compositeHandoffStep.action_fingerprint,
      executorId: compositeHandoffStep.executor_id,
    });
  const compositeHandoffReport =
    await finishFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: compositeRouterCommitted.operation.id,
      stepId: compositeHandoffStep.id,
      attemptId: compositeHandoffAttempt.attempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "external_handoff",
      receiptRefCiphertext: "ciphertext:composite-router-handoff-report",
      receiptRefLookupHmac: hash("composite-router-handoff-report"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
  assert.equal(compositeHandoffReport.stepState, "submitted");
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    operationId: compositeRouterCommitted.operation.id,
    stepId: compositeHandoffStep.id,
    attemptId: compositeHandoffAttempt.attempt.id,
    networkId: ASSET.networkId,
    receipt: {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "1001",
      blockHash: `0x${"31".repeat(32)}`,
      canonical: true,
      failureCode: null,
      evidence: {
        transactionHash: `0x${"32".repeat(32)}`,
        transactionHashSource: "client_report",
        handoffEventIndex: "0",
      },
    },
  });
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");
  const afterCompositeHandoff = await client.query<{
    ordinal: number;
    state: string;
  }>(
    `select ordinal, state
       from funding_operation_steps
      where operation_id = $1::uuid
      order by ordinal`,
    [compositeRouterCommitted.operation.id],
  );
  assert.deepEqual(afterCompositeHandoff.rows, [
    { ordinal: 0, state: "succeeded" },
    { ordinal: 1, state: "action_required" },
    { ordinal: 2, state: "planned" },
    { ordinal: 3, state: "action_required" },
  ]);
  const compositeApprovalAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: compositeRouterCommitted.operation.id,
      stepId: compositeApprovalStep.id,
      canonicalActionFingerprint: compositeApprovalStep.action_fingerprint,
      executorId: compositeApprovalStep.executor_id,
    });
  const compositeApprovalReport =
    await finishFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: compositeRouterCommitted.operation.id,
      stepId: compositeApprovalStep.id,
      attemptId: compositeApprovalAttempt.attempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:composite-router-approval-report",
      receiptRefLookupHmac: hash("composite-router-approval-report"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
  assert.equal(compositeApprovalReport.stepState, "submitted");
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    operationId: compositeRouterCommitted.operation.id,
    stepId: compositeApprovalStep.id,
    attemptId: compositeApprovalAttempt.attempt.id,
    networkId: ASSET.networkId,
    receipt: {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "1002",
      blockHash: `0x${"33".repeat(32)}`,
      canonical: true,
      failureCode: null,
      evidence: {
        transactionHash: `0x${"34".repeat(32)}`,
        transactionHashSource: "client_report",
      },
    },
  });
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");
  const compositeFundAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: compositeRouterCommitted.operation.id,
      stepId: compositeFundStep.id,
      canonicalActionFingerprint: compositeFundStep.action_fingerprint,
      executorId: compositeFundStep.executor_id,
    });
  const compositeFundReport =
    await finishFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: compositeRouterCommitted.operation.id,
      stepId: compositeFundStep.id,
      attemptId: compositeFundAttempt.attempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:composite-router-fund-report",
      receiptRefLookupHmac: hash("composite-router-fund-report"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
  assert.equal(compositeFundReport.stepState, "submitted");
  await client.query("set constraints all immediate");
  await client.query("set constraints all deferred");

  await client.query("savepoint malformed_composite_router_chain");
  const malformedCompositeRouterPlan: FundingCommitPlan = {
    ...compositeRouterPlan,
    steps: compositeRouterPlan.steps.map((step) =>
      step.ordinal === 1 ? { ...step, dependsOnOrdinal: null } : step,
    ),
    reservations: compositeRouterPlan.reservations.map((reservation) => ({
      ...reservation,
      componentId: opaque("component"),
      locationId: opaque("location"),
    })),
  };
  const malformedCompositeRouterConsentToken = opaque("consent");
  const malformedCompositeRouterQuote = await createFundingQuoteInTransaction(
    client,
    {
      userId,
      discoveryProjectionId: opaque("projection"),
      selectedSourceOptionSnapshot:
        malformedCompositeRouterPlan.operation.sourceSnapshot ?? {},
      marketContextSnapshot: null,
      destinationOptionSnapshot:
        malformedCompositeRouterPlan.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: malformedCompositeRouterPlan,
      policyVersion: 1,
      policyRevision: "policy_revision_malformed_composite_router_handoff",
      canonicalRequest: {
        source: malformedCompositeRouterPlan.operation.sourceSnapshot,
      },
      consentToken: malformedCompositeRouterConsentToken,
      expiresAt: controllerHandoffQuoteExpiresAt,
    },
  );
  await expectFundingError(
    commitFundingOperationInTransaction(client, {
      userId,
      quoteId: malformedCompositeRouterQuote.id,
      consentToken: malformedCompositeRouterConsentToken,
      idempotencyKey: opaque("idempotency"),
      plan: malformedCompositeRouterPlan,
      subjectLookupHmac: hash("malformed-composite-router-handoff-user"),
      subjectLookupKeyVersion: 1,
    }),
    "quote_mismatch",
  );
  await client.query("rollback to savepoint malformed_composite_router_chain");
  await client.query("set constraints all deferred");

  const controllerRouterFundPlanStep = controllerHandoffPlan.steps[2];
  assert.ok(controllerRouterFundPlanStep);
  const invalidCompositeRouterValidationCases: readonly Readonly<{
    label: string;
    omitPlanValidation?: boolean;
    steps: FundingCommitPlan["steps"];
    planValidation?: Readonly<{ validatorId: string; version: number }>;
  }>[] = [
    {
      label: "untrusted_approval_validator",
      steps: compositeRouterPlan.steps.map((step) =>
        step.ordinal === 1
          ? {
              ...step,
              actionValidationResult: {
                ...step.actionValidationResult,
                validatorId: "untrusted_validator_v1",
              },
            }
          : step,
      ),
    },
    {
      label: "string_approval_validity",
      steps: compositeRouterPlan.steps.map((step) =>
        step.ordinal === 1
          ? {
              ...step,
              actionValidationResult: {
                ...step.actionValidationResult,
                valid: "true",
              },
            }
          : step,
      ),
    },
    {
      label: "rejected_router_fund",
      steps: compositeRouterPlan.steps.map((step) =>
        step.stepKind === "venue_preparation"
          ? {
              ...step,
              actionValidationResult: {
                ...step.actionValidationResult,
                valid: false,
              },
            }
          : step,
      ),
    },
    {
      label: "handoff_cannot_start_succeeded",
      steps: compositeRouterPlan.steps.map((step) =>
        step.ordinal === 0 ? { ...step, state: "succeeded" as const } : step,
      ),
    },
    {
      label: "client_fund_cannot_start_planned",
      steps: compositeRouterPlan.steps.map((step) =>
        step.stepKind === "venue_preparation"
          ? { ...step, state: "planned" as const }
          : step,
      ),
    },
    {
      label: "unknown_plan_validator",
      steps: compositeRouterPlan.steps,
      planValidation: {
        validatorId: "unknown_funding_adapter_v1",
        version: 1,
      },
    },
    {
      label: "unknown_plan_validator_version",
      steps: compositeRouterPlan.steps,
      planValidation: {
        validatorId: "polymarket_funding_router_v1",
        version: 2,
      },
    },
    {
      label: "missing_plan_validator_declaration",
      steps: [
        {
          ...controllerRouterFundPlanStep,
          ordinal: 0,
          dependsOnOrdinal: null,
        },
      ],
      omitPlanValidation: true,
    },
  ];
  for (const invalidCase of invalidCompositeRouterValidationCases) {
    await client.query("savepoint invalid_composite_router_validation");
    const {
      planValidation: _declaredPlanValidation,
      ...supportMetadataWithoutPlanValidation
    } = compositeRouterPlan.operation.supportMetadata ?? {};
    const invalidPlan: FundingCommitPlan = {
      ...compositeRouterPlan,
      operation:
        invalidCase.planValidation || invalidCase.omitPlanValidation
          ? {
              ...compositeRouterPlan.operation,
              planKind: invalidCase.omitPlanValidation
                ? "venue_preparation"
                : compositeRouterPlan.operation.planKind,
              supportMetadata: invalidCase.omitPlanValidation
                ? supportMetadataWithoutPlanValidation
                : {
                    ...compositeRouterPlan.operation.supportMetadata,
                    ...(invalidCase.planValidation
                      ? { planValidation: invalidCase.planValidation }
                      : {}),
                  },
            }
          : compositeRouterPlan.operation,
      steps: invalidCase.steps,
      reservations: compositeRouterPlan.reservations.map((reservation) => ({
        ...reservation,
        componentId: opaque("component"),
        locationId: opaque("location"),
      })),
    };
    const invalidConsentToken = opaque("consent");
    const invalidQuote = await createFundingQuoteInTransaction(client, {
      userId,
      discoveryProjectionId: opaque("projection"),
      selectedSourceOptionSnapshot: invalidPlan.operation.sourceSnapshot ?? {},
      marketContextSnapshot: null,
      destinationOptionSnapshot:
        invalidPlan.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: invalidPlan,
      policyVersion: 1,
      policyRevision: `policy_revision_${invalidCase.label}`,
      canonicalRequest: {
        source: invalidPlan.operation.sourceSnapshot,
      },
      consentToken: invalidConsentToken,
      expiresAt: controllerHandoffQuoteExpiresAt,
    });
    await expectFundingError(
      commitFundingOperationInTransaction(client, {
        userId,
        quoteId: invalidQuote.id,
        consentToken: invalidConsentToken,
        idempotencyKey: opaque("idempotency"),
        plan: invalidPlan,
        subjectLookupHmac: hash(`${invalidCase.label}-user`),
        subjectLookupKeyVersion: 1,
      }),
      "quote_mismatch",
    );
    await client.query(
      "rollback to savepoint invalid_composite_router_validation",
    );
    await client.query("set constraints all deferred");
  }

  await client.query("savepoint controller_future_credit_conflict");
  const controllerFundStep = controllerHandoffPlan.steps[2];
  const controllerFutureReservation = controllerHandoffPlan.reservations[1];
  assert.ok(controllerFundStep);
  assert.ok(controllerFutureReservation);
  const competingControllerPlan: FundingCommitPlan = {
    ...controllerHandoffPlan,
    operation: {
      ...controllerHandoffPlan.operation,
      sourceSnapshot: {
        kind: "venue_preparation",
        inputCount: 1,
      },
      supportMetadata: {
        test: true,
        preparationKind: "polymarket_funding_router",
        adapterId: "polymarket_funding_router_v1",
        planValidation: {
          validatorId: "polymarket_funding_router_v1",
          version: 1,
        },
      },
    },
    steps: [
      {
        ...controllerFundStep,
        ordinal: 0,
        dependsOnOrdinal: null,
      },
    ],
    reservations: [
      {
        ...controllerFutureReservation,
        componentId: futureControllerComponentId,
      },
    ],
  };
  const competingConsentToken = opaque("consent");
  const competingQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot:
      competingControllerPlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot:
      competingControllerPlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: competingControllerPlan,
    policyVersion: 1,
    policyRevision: "policy_revision_controller_future_credit_conflict",
    canonicalRequest: {
      source: competingControllerPlan.operation.sourceSnapshot,
    },
    consentToken: competingConsentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expectFundingError(
    commitFundingOperationInTransaction(client, {
      userId,
      quoteId: competingQuote.id,
      consentToken: competingConsentToken,
      idempotencyKey: opaque("idempotency"),
      plan: competingControllerPlan,
      subjectLookupHmac: hash("controller-future-credit-conflict-user"),
      subjectLookupKeyVersion: 1,
    }),
    "quote_invalidated",
  );
  await client.query("rollback to savepoint controller_future_credit_conflict");

  await client.query("savepoint unrelated_venue_router_shape");
  const unrelatedVenuePlan: FundingCommitPlan = {
    ...controllerHandoffPlan,
    operation: {
      ...controllerHandoffPlan.operation,
      venueId: "limitless",
    },
    reservations: controllerHandoffPlan.reservations.map((reservation) => ({
      ...reservation,
      componentId: opaque("component"),
      locationId: opaque("location"),
    })),
  };
  const unrelatedVenueConsentToken = opaque("consent");
  const unrelatedVenueQuote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot:
      unrelatedVenuePlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot:
      unrelatedVenuePlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: unrelatedVenuePlan,
    policyVersion: 1,
    policyRevision: "policy_revision_unrelated_venue_router_shape",
    canonicalRequest: {
      source: unrelatedVenuePlan.operation.sourceSnapshot,
    },
    consentToken: unrelatedVenueConsentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expectFundingError(
    commitFundingOperationInTransaction(client, {
      userId,
      quoteId: unrelatedVenueQuote.id,
      consentToken: unrelatedVenueConsentToken,
      idempotencyKey: opaque("idempotency"),
      plan: unrelatedVenuePlan,
      subjectLookupHmac: hash("unrelated-venue-router-shape-user"),
      subjectLookupKeyVersion: 1,
    }),
    "quote_mismatch",
  );
  await client.query("rollback to savepoint unrelated_venue_router_shape");
  await client.query("set constraints all deferred");

  const stepResult = await client.query<{
    id: string;
    ordinal: number;
  }>(
    `
      select id, ordinal
      from funding_operation_steps
      where operation_id = $1
      order by ordinal
    `,
    [committed.operation.id],
  );
  const stepId = stepResult.rows.find((row) => row.ordinal === 0)?.id;
  const independentStepId = stepResult.rows.find(
    (row) => row.ordinal === 1,
  )?.id;
  assert.ok(stepId);
  assert.ok(independentStepId);

  const incidentPlan = (label: string): FundingCommitPlan => {
    const firstIncidentAction = { ...action, actionId: opaque("action") };
    const secondIncidentAction = {
      ...secondAction,
      actionId: opaque("action"),
    };
    return {
      ...plan,
      operation: {
        ...plan.operation,
        supportMetadata: { test: true, incident: label },
      },
      segments: plan.segments.map((segment, index) => ({
        ...segment,
        providerQuoteRefCiphertext: `ciphertext:${label}:${index}`,
        providerQuoteRefLookupHmac: hash(`${label}:${index}`),
      })),
      steps: plan.steps.map((operationStep, index) => {
        const incidentAction =
          index === 0 ? firstIncidentAction : secondIncidentAction;
        return {
          ...operationStep,
          actionFingerprint: canonicalJsonHash(incidentAction),
          normalizedAction: incidentAction,
        };
      }),
      reservations: plan.reservations.map((reservation) => ({
        ...reservation,
        componentId: opaque("component"),
        locationId: opaque("location"),
      })),
    };
  };
  const commitIncidentPlan = async (
    label: string,
    operationUserId = userId,
  ) => {
    const incident = incidentPlan(label);
    const incidentConsent = opaque("consent");
    const incidentQuote = await createFundingQuoteInTransaction(client, {
      userId: operationUserId,
      discoveryProjectionId: opaque("projection"),
      selectedSourceOptionSnapshot: incident.operation.sourceSnapshot ?? {},
      marketContextSnapshot: null,
      destinationOptionSnapshot: incident.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: incident,
      policyVersion: 1,
      policyRevision: "policy_revision_wp6_action",
      canonicalRequest: { source: incident.operation.sourceSnapshot },
      consentToken: incidentConsent,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const incidentCommit = await commitFundingOperationInTransaction(client, {
      userId: operationUserId,
      quoteId: incidentQuote.id,
      consentToken: incidentConsent,
      idempotencyKey: opaque("idempotency"),
      plan: incident,
      subjectLookupHmac: hash(`${label}:user`),
      subjectLookupKeyVersion: 1,
    });
    const incidentSteps = await client.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
      ordinal: number;
    }>(
      `select id, ordinal, action_fingerprint, executor_id
         from funding_operation_steps
        where operation_id = $1
        order by ordinal`,
      [incidentCommit.operation.id],
    );
    const first = incidentSteps.rows[0];
    const second = incidentSteps.rows[1];
    assert.ok(first);
    assert.ok(second);
    return { operation: incidentCommit.operation, first, second };
  };

  const revertedHandoff = await commitIncidentPlan(
    "handoff-revert-progression",
  );
  const revertedHandoffAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: revertedHandoff.operation.id,
      stepId: revertedHandoff.first.id,
      canonicalActionFingerprint: revertedHandoff.first.action_fingerprint,
      executorId: revertedHandoff.first.executor_id,
    });
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: revertedHandoff.operation.id,
    stepId: revertedHandoff.first.id,
    attemptId: revertedHandoffAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:handoff-revert-progression",
    receiptRefLookupHmac: hash("handoff-revert-progression"),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const confirmedRevertedHandoff =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: revertedHandoff.operation.id,
      stepId: revertedHandoff.first.id,
      attemptId: revertedHandoffAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "confirmed",
        actionMatch: true,
        ledgerHeight: "995",
        blockHash: `0x${"21".repeat(32)}`,
        canonical: true,
        failureCode: "transaction_reverted",
        evidence: {
          confirmationPolicy: 12,
          confirmations: 1,
          failureFinalized: false,
          transactionHash: `0x${"20".repeat(32)}`,
          transactionHashSource: "provider",
        },
      },
    });
  assert.equal(
    confirmedRevertedHandoff.status,
    "confirmed",
    "a not-yet-final reverted handoff must remain under canonical failure watch",
  );
  const finalizedRevertedHandoff =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: revertedHandoff.operation.id,
      stepId: revertedHandoff.first.id,
      attemptId: revertedHandoffAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        ...confirmedRevertedHandoff,
        status: "failed",
        evidence: {
          ...confirmedRevertedHandoff.evidence,
          confirmations: 12,
          failureFinalized: true,
        },
      },
    });
  assert.equal(finalizedRevertedHandoff.status, "failed");
  const revertedHandoffStep = await client.query<{ state: string }>(
    `select state
       from funding_operation_steps
      where id = $1`,
    [revertedHandoff.first.id],
  );
  assert.equal(
    revertedHandoffStep.rows[0]?.state,
    "action_required",
    "only a 12-confirmation canonical failure may authorize another handoff attempt",
  );

  const expiredIdentityAttemptStartedAt = new Date(
    Date.now() - POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS - 5_000,
  );
  const freshIdentityAttemptStartedAt = new Date();
  const expiredIdentity = await commitIncidentPlan(
    "chain-identity-expired",
    expiredIdentityUserId,
  );
  const expiredAttempt = await startFundingStepAttemptForUserInTransaction(
    client,
    {
      userId: expiredIdentityUserId,
      operationId: expiredIdentity.operation.id,
      stepId: expiredIdentity.first.id,
      canonicalActionFingerprint: expiredIdentity.first.action_fingerprint,
      executorId: expiredIdentity.first.executor_id,
      now: expiredIdentityAttemptStartedAt,
    },
  );
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: expiredIdentityUserId,
    operationId: expiredIdentity.operation.id,
    stepId: expiredIdentity.first.id,
    attemptId: expiredAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:chain-identity-expired",
    receiptRefLookupHmac: hash("chain-identity-expired"),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const freshIdentity = await commitIncidentPlan(
    "chain-identity-fresh",
    expiredIdentityUserId,
  );
  const freshAttempt = await startFundingStepAttemptForUserInTransaction(
    client,
    {
      userId: expiredIdentityUserId,
      operationId: freshIdentity.operation.id,
      stepId: freshIdentity.first.id,
      canonicalActionFingerprint: freshIdentity.first.action_fingerprint,
      executorId: freshIdentity.first.executor_id,
      now: freshIdentityAttemptStartedAt,
    },
  );
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: expiredIdentityUserId,
    operationId: freshIdentity.operation.id,
    stepId: freshIdentity.first.id,
    attemptId: freshAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:chain-identity-fresh",
    receiptRefLookupHmac: hash("chain-identity-fresh"),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const freshPhysicalTransactionHash = `0x${"12".repeat(32)}`;
  const freshPhysicalReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: freshIdentity.operation.id,
      stepId: freshIdentity.first.id,
      attemptId: freshAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "1000",
        blockHash: `0x${"13".repeat(32)}`,
        canonical: true,
        failureCode: null,
        evidence: {
          transactionHash: freshPhysicalTransactionHash,
          transactionHashSource: "chain_scan",
          chainTransactionBlockTimestampMs:
            (Math.floor(freshIdentityAttemptStartedAt.getTime() / 1_000) + 2) *
            1_000,
          handoffEventIndex: "2",
        },
      },
    });
  assert.equal(
    freshPhysicalReceipt.status,
    "finalized",
    "an unresolved historical attempt outside the immutable attribution window must not fence a fresh chain-only transfer forever",
  );

  const chainIdentityFirst = await commitIncidentPlan(
    "chain-identity-first",
    identityUserId,
  );
  const chainIdentitySecond = await commitIncidentPlan(
    "chain-identity-second",
    identityUserId,
  );
  const identityStartedAt = new Date();
  const firstIdentityAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId: identityUserId,
      operationId: chainIdentityFirst.operation.id,
      stepId: chainIdentityFirst.first.id,
      canonicalActionFingerprint: chainIdentityFirst.first.action_fingerprint,
      executorId: chainIdentityFirst.first.executor_id,
      now: identityStartedAt,
    });
  const secondIdentityAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId: identityUserId,
      operationId: chainIdentitySecond.operation.id,
      stepId: chainIdentitySecond.first.id,
      canonicalActionFingerprint: chainIdentitySecond.first.action_fingerprint,
      executorId: chainIdentitySecond.first.executor_id,
      now: identityStartedAt,
    });
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: identityUserId,
    operationId: chainIdentitySecond.operation.id,
    stepId: chainIdentitySecond.first.id,
    attemptId: secondIdentityAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:chain-identity-second",
    receiptRefLookupHmac: hash("chain-identity-second"),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const physicalTransactionHash = `0x${"34".repeat(32)}`;
  const physicalEventIndex = "7";
  const physicalBlockTimestampMs =
    (Math.floor(identityStartedAt.getTime() / 1_000) + 2) * 1_000;
  const chainScannedReceipt = {
    status: "finalized" as const,
    actionMatch: true,
    ledgerHeight: "1001",
    blockHash: `0x${"56".repeat(32)}`,
    canonical: true,
    failureCode: null,
    evidence: {
      transactionHash: physicalTransactionHash,
      transactionHashSource: "chain_scan",
      chainTransactionBlockTimestampMs: physicalBlockTimestampMs,
      handoffEventIndex: physicalEventIndex,
    },
  };
  const secondAmbiguousReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentitySecond.operation.id,
      stepId: chainIdentitySecond.first.id,
      attemptId: secondIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: chainScannedReceipt,
    });
  assert.equal(secondAmbiguousReceipt.status, "pending");
  assert.equal(secondAmbiguousReceipt.failureCode, null);
  assert.equal(
    secondAmbiguousReceipt.evidence.externalHandoffCandidateAmbiguous,
    true,
  );
  assert.equal(
    secondAmbiguousReceipt.evidence.competingOperationId,
    chainIdentityFirst.operation.id,
    "an attempt still in the broadcast/report gap must fence an indistinguishable chain-only match",
  );

  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: identityUserId,
    operationId: chainIdentityFirst.operation.id,
    stepId: chainIdentityFirst.first.id,
    attemptId: firstIdentityAttempt.attempt.id,
    outcome: "ambiguous",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:chain-identity-first",
    receiptRefLookupHmac: hash("chain-identity-first"),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const firstAmbiguousReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFirst.operation.id,
      stepId: chainIdentityFirst.first.id,
      attemptId: firstIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: chainScannedReceipt,
    });
  assert.equal(firstAmbiguousReceipt.status, "pending");
  assert.equal(firstAmbiguousReceipt.failureCode, null);
  assert.equal(
    firstAmbiguousReceipt.evidence.externalHandoffCandidateAmbiguous,
    true,
  );

  const chainIdentityFailure = await commitIncidentPlan(
    "chain-identity-provider-failure",
    identityUserId,
  );
  const failureIdentityAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId: identityUserId,
      operationId: chainIdentityFailure.operation.id,
      stepId: chainIdentityFailure.first.id,
      canonicalActionFingerprint: chainIdentityFailure.first.action_fingerprint,
      executorId: chainIdentityFailure.first.executor_id,
      now: identityStartedAt,
    });
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: identityUserId,
    operationId: chainIdentityFailure.operation.id,
    stepId: chainIdentityFailure.first.id,
    attemptId: failureIdentityAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:chain-identity-provider-failure",
    receiptRefLookupHmac: hash("chain-identity-provider-failure"),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const provisionalFailureReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFailure.operation.id,
      stepId: chainIdentityFailure.first.id,
      attemptId: failureIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: chainScannedReceipt,
    });
  assert.equal(provisionalFailureReceipt.status, "pending");
  assert.equal(provisionalFailureReceipt.failureCode, null);
  const authoritativeProviderFailure =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFailure.operation.id,
      stepId: chainIdentityFailure.first.id,
      attemptId: failureIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "failed",
        actionMatch: true,
        ledgerHeight: null,
        blockHash: null,
        canonical: true,
        failureCode: "polymarket_relayer_transaction_failed",
        evidence: {
          failureFinalized: true,
          providerReferenceMatches: true,
          relayerState: "STATE_FAILED",
        },
      },
    });
  assert.equal(authoritativeProviderFailure.status, "failed");
  const retryableProviderFailureStep = await client.query<{ state: string }>(
    `select state
       from funding_operation_steps
      where id = $1`,
    [chainIdentityFailure.first.id],
  );
  assert.equal(
    retryableProviderFailureStep.rows[0]?.state,
    "action_required",
    "an authoritative provider failure must release a provisional chain-scan ambiguity",
  );
  const invalidatedProviderFailure =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFailure.operation.id,
      stepId: chainIdentityFailure.first.id,
      attemptId: failureIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: null,
        blockHash: null,
        canonical: false,
        failureCode: "polymarket_relayer_terminal_failure_invalidated",
        evidence: {
          transactionHash: `0x${"78".repeat(32)}`,
          transactionHashSource: "provider",
          previousFailureCode: "polymarket_relayer_transaction_failed",
        },
      },
    });
  assert.equal(invalidatedProviderFailure.status, "reorged");
  const invalidatedProviderFailureStep = await client.query<{
    state: string;
  }>(
    `select state
       from funding_operation_steps
      where id = $1`,
    [chainIdentityFailure.first.id],
  );
  assert.equal(
    invalidatedProviderFailureStep.rows[0]?.state,
    "recovery_required",
    "a late exact provider hash must revoke a prior retry authorization durably",
  );
  const repeatedInvalidatedProviderFailure =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFailure.operation.id,
      stepId: chainIdentityFailure.first.id,
      attemptId: failureIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        ...invalidatedProviderFailure,
        evidence: { ...invalidatedProviderFailure.evidence },
      },
    });
  assert.equal(
    repeatedInvalidatedProviderFailure.status,
    "reorged",
    "repeated reorg evidence must be an idempotent read",
  );

  const providerBoundReceipt = {
    ...chainScannedReceipt,
    evidence: {
      ...chainScannedReceipt.evidence,
      transactionHashSource: "provider",
    },
  };
  const providerResolvedFirst =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFirst.operation.id,
      stepId: chainIdentityFirst.first.id,
      attemptId: firstIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: providerBoundReceipt,
    });
  assert.equal(providerResolvedFirst.status, "finalized");
  const duplicateProviderReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentitySecond.operation.id,
      stepId: chainIdentitySecond.first.id,
      attemptId: secondIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: providerBoundReceipt,
    });
  assert.equal(duplicateProviderReceipt.status, "mismatch");
  assert.equal(
    duplicateProviderReceipt.failureCode,
    "external_handoff_transfer_already_allocated",
  );
  assert.equal(
    duplicateProviderReceipt.evidence.conflictingOperationId,
    chainIdentityFirst.operation.id,
    "one exact on-chain Transfer event must never finalize two funding operations",
  );
  const repeatedDuplicateProviderReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentitySecond.operation.id,
      stepId: chainIdentitySecond.first.id,
      attemptId: secondIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: providerBoundReceipt,
    });
  assert.equal(
    repeatedDuplicateProviderReceipt.status,
    "mismatch",
    "repeated physical-identity conflict polling must be an idempotent read",
  );
  const reboundFinalizedReceipt =
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: chainIdentityFirst.operation.id,
      stepId: chainIdentityFirst.first.id,
      attemptId: firstIdentityAttempt.attempt.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: providerResolvedFirst.ledgerHeight,
        blockHash: providerResolvedFirst.blockHash,
        canonical: false,
        failureCode: "polymarket_relayer_transaction_hash_changed",
        evidence: {
          previousTransactionHash: physicalTransactionHash,
          transactionHash: `0x${"79".repeat(32)}`,
          transactionHashSource: "provider",
        },
      },
    });
  assert.equal(reboundFinalizedReceipt.status, "reorged");
  assert.equal(reboundFinalizedReceipt.actionMatch, true);
  const reboundFinalizedStep = await client.query<{ state: string }>(
    `select state
       from funding_operation_steps
      where id = $1`,
    [chainIdentityFirst.first.id],
  );
  assert.equal(
    reboundFinalizedStep.rows[0]?.state,
    "recovery_required",
    "a provider replacement after finalized evidence must persist as recovery instead of violating receipt constraints",
  );

  const stoppedSiblingIncident = await commitIncidentPlan("stopped-sibling");
  const stoppedAttempt = await startFundingStepAttemptForUserInTransaction(
    client,
    {
      userId,
      operationId: stoppedSiblingIncident.operation.id,
      stepId: stoppedSiblingIncident.first.id,
      canonicalActionFingerprint:
        stoppedSiblingIncident.first.action_fingerprint,
      executorId: stoppedSiblingIncident.first.executor_id,
    },
  );
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: stoppedSiblingIncident.operation.id,
    stepId: stoppedSiblingIncident.first.id,
    attemptId: stoppedAttempt.attempt.id,
    outcome: "failed",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: { reasonCode: "client_execution_failed" },
  });
  // The materialized step state is deliberately stale here. Admission must
  // still reject the sibling from the durable failed-attempt fact.
  await client.query(
    `update funding_operation_steps
        set state = 'action_required', updated_at = clock_timestamp()
      where id = $1`,
    [stoppedSiblingIncident.first.id],
  );
  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: stoppedSiblingIncident.operation.id,
      stepId: stoppedSiblingIncident.second.id,
      canonicalActionFingerprint:
        stoppedSiblingIncident.second.action_fingerprint,
      executorId: stoppedSiblingIncident.second.executor_id,
    }),
    "invalid_state_transition",
  );

  const lateEvidenceIncident = await commitIncidentPlan("late-evidence");
  const lateFirstAttempt = await startFundingStepAttemptForUserInTransaction(
    client,
    {
      userId,
      operationId: lateEvidenceIncident.operation.id,
      stepId: lateEvidenceIncident.first.id,
      canonicalActionFingerprint: lateEvidenceIncident.first.action_fingerprint,
      executorId: lateEvidenceIncident.first.executor_id,
    },
  );
  const lateSecondAttempt = await startFundingStepAttemptForUserInTransaction(
    client,
    {
      userId,
      operationId: lateEvidenceIncident.operation.id,
      stepId: lateEvidenceIncident.second.id,
      canonicalActionFingerprint:
        lateEvidenceIncident.second.action_fingerprint,
      executorId: lateEvidenceIncident.second.executor_id,
    },
  );
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: lateEvidenceIncident.operation.id,
    stepId: lateEvidenceIncident.first.id,
    attemptId: lateFirstAttempt.attempt.id,
    outcome: "failed",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: { reasonCode: "client_execution_failed" },
  });
  await client.query(
    `update funding_operations
        set status = 'failed', progress_stage = 'terminal',
            completed_at = clock_timestamp(), version = version + 1
      where id = $1`,
    [lateEvidenceIncident.operation.id],
  );
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: lateEvidenceIncident.operation.id,
    stepId: lateEvidenceIncident.second.id,
    attemptId: lateSecondAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "transaction",
    receiptRefCiphertext: "ciphertext:late-evidence-transaction",
    receiptRefLookupHmac: hash("late-evidence-transaction"),
    lookupKeyVersion: 1,
    actualCosts: { networkFeeRaw: "21000" },
  });
  const recoveredLateEvidence = await fetchFundingOperationForUser(client, {
    userId,
    operationId: lateEvidenceIncident.operation.id,
  });
  assert.equal(recoveredLateEvidence?.status, "recovery_required");
  assert.equal(recoveredLateEvidence?.recoveryMode, "automatic_evidence");
  assert.equal(
    recoveredLateEvidence?.errorCode,
    "late_broadcast_after_terminal_operation",
  );

  const terminalReceiptIncident = await commitIncidentPlan("terminal-receipt");
  const terminalReceiptAttempt =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: terminalReceiptIncident.operation.id,
      stepId: terminalReceiptIncident.first.id,
      canonicalActionFingerprint:
        terminalReceiptIncident.first.action_fingerprint,
      executorId: terminalReceiptIncident.first.executor_id,
    });
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: terminalReceiptIncident.operation.id,
    stepId: terminalReceiptIncident.first.id,
    attemptId: terminalReceiptAttempt.attempt.id,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "transaction",
    receiptRefCiphertext: "ciphertext:first-finalized-after-terminal",
    receiptRefLookupHmac: hash("first-finalized-after-terminal"),
    lookupKeyVersion: 1,
    actualCosts: { networkFeeRaw: "21000" },
  });
  await client.query(
    `update funding_operations
        set status = 'failed', progress_stage = 'terminal',
            recovery_mode = null,
            completed_at = clock_timestamp(), version = version + 1
      where id = $1`,
    [terminalReceiptIncident.operation.id],
  );
  const firstFinalReceipt = {
    status: "finalized" as const,
    actionMatch: true,
    ledgerHeight: "991",
    blockHash: `0x${"ef".repeat(32)}`,
    canonical: true,
    failureCode: null,
    evidence: {
      transactionHash: `0x${"ab".repeat(32)}`,
      transactionHashSource: "provider",
      handoffEventIndex: "0",
    },
  };
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    operationId: terminalReceiptIncident.operation.id,
    stepId: terminalReceiptIncident.first.id,
    attemptId: terminalReceiptAttempt.attempt.id,
    networkId: ASSET.networkId,
    receipt: firstFinalReceipt,
  });
  const reopenedFirstFinal = await fetchFundingOperationForUser(client, {
    userId,
    operationId: terminalReceiptIncident.operation.id,
  });
  assert.equal(reopenedFirstFinal?.status, "in_progress");
  assert.equal(reopenedFirstFinal?.recoveryMode, null);
  assert.equal(reopenedFirstFinal?.errorCode, null);
  await client.query(
    `update funding_operations
        set status = 'failed', progress_stage = 'terminal',
            recovery_mode = null,
            completed_at = clock_timestamp(), version = version + 1
      where id = $1`,
    [terminalReceiptIncident.operation.id],
  );
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    operationId: terminalReceiptIncident.operation.id,
    stepId: terminalReceiptIncident.first.id,
    attemptId: terminalReceiptAttempt.attempt.id,
    networkId: ASSET.networkId,
    receipt: firstFinalReceipt,
  });
  const repeatedFinalReceipt = await fetchFundingOperationForUser(client, {
    userId,
    operationId: terminalReceiptIncident.operation.id,
  });
  assert.equal(
    repeatedFinalReceipt?.status,
    "in_progress",
    "a stale terminal cache cannot override a canonical receipt fact",
  );

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId: otherUserId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: actionExecutorId,
    }),
    "operation_not_found",
  );

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: actionExecutorId,
      expectedPolicy: { revision: "replacement-policy", version: 1 },
    }),
    "quote_invalidated",
  );
  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: hash("different-action"),
      executorId: actionExecutorId,
    }),
    "quote_mismatch",
  );
  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: actionExecutorId,
      now: new Date(Date.now() + 120_000),
    }),
    "quote_expired",
  );

  const independentlyStarted =
    await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId: independentStepId,
      canonicalActionFingerprint: secondActionFingerprint,
      executorId: "wallet_profile_evm_v1",
      expectedPolicy: {
        revision: "policy_revision_wp6_action",
        version: 1,
      },
    });
  assert.equal(independentlyStarted.attempt.attemptNumber, 1);

  const started = await startFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: committed.operation.id,
    stepId,
    canonicalActionFingerprint: actionFingerprint,
    executorId: actionExecutorId,
  });
  assert.equal(started.attempt.attemptNumber, 1);

  const canonicalHandoffEvent = {
    eventKey: "canonical-handoff-event",
    networkId: ASSET.networkId,
    assetId: handoffToken,
    sourceAddress: handoffFunder,
    destinationAddress: handoffRecipient,
    rawAmount: handoffAmount,
    receiptRefLookupHmac: null,
  } as const;
  const startedHandoffs =
    await listPotentialPolymarketHandoffsForCanonicalEvents(client, {
      userId,
      currentLookupKeyVersion: 1,
      events: [canonicalHandoffEvent],
    });
  const currentStartedHandoffs = startedHandoffs.filter(
    (candidate) => candidate.attemptId === started.attempt.id,
  );
  assert.equal(currentStartedHandoffs.length, 1);
  assert.equal(currentStartedHandoffs[0]?.attemptOutcome, "started");

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: actionExecutorId,
    }),
    "invalid_state_transition",
  );

  const reportInput = {
    userId,
    operationId: committed.operation.id,
    stepId,
    attemptId: started.attempt.id,
    outcome: "ambiguous",
    broadcastMayHaveOccurred: true,
    referenceKind: "external_handoff",
    receiptRefCiphertext: "ciphertext:polymarket-relayer:v1:handoff-report",
    receiptRefLookupHmac: hash("polymarket-relayer:v1:handoff-report"),
    lookupKeyVersion: 1,
    actualCosts: { networkFeeRaw: "21000" },
  } as const;
  const reported = await finishFundingStepAttemptForUserInTransaction(
    client,
    reportInput,
  );
  assert.equal(reported.stepState, "reconcile_required");
  const replayed = await finishFundingStepAttemptForUserInTransaction(
    client,
    reportInput,
  );
  assert.equal(replayed.attempt.id, reported.attempt.id);
  assert.equal(replayed.stepState, "reconcile_required");
  await expectFundingError(
    finishFundingStepAttemptForUserInTransaction(client, {
      ...reportInput,
      actualCosts: { networkFeeRaw: "21001" },
    }),
    "invalid_state_transition",
  );
  const storedStep = await fetchFundingOperationStepForUser(client, {
    userId,
    operationId: committed.operation.id,
    stepId,
  });
  assert.equal(storedStep?.state, "reconcile_required");

  const unknownProviderSubmission =
    await finishFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId: independentStepId,
      attemptId: independentlyStarted.attempt.id,
      outcome: "ambiguous",
      broadcastMayHaveOccurred: true,
      referenceKind: null,
      receiptRefCiphertext: null,
      receiptRefLookupHmac: null,
      lookupKeyVersion: null,
      actualCosts: {
        networkFeeRaw: null,
        reasonCode: "external_handoff_submission_unknown",
      },
    });
  assert.equal(unknownProviderSubmission.stepState, "reconcile_required");
  assert.equal(
    unknownProviderSubmission.attempt.actualCosts.reasonCode,
    "external_handoff_submission_unknown",
  );

  const matchingHandoffs =
    await listPotentialPolymarketHandoffsForCanonicalEvents(client, {
      userId,
      currentLookupKeyVersion: 1,
      events: [canonicalHandoffEvent],
    });
  const matchingHandoff = matchingHandoffs.find(
    (candidate) => candidate.attemptId === started.attempt.id,
  );
  assert.ok(matchingHandoff);
  assert.equal(matchingHandoff.referenceKind, "external_handoff");
  const resolvedHandoffTransactionHash = `0x${"ab".repeat(32)}`;
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    operationId: committed.operation.id,
    stepId,
    attemptId: started.attempt.id,
    networkId: ASSET.networkId,
    receipt: {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: { transactionHash: resolvedHandoffTransactionHash },
    },
  });
  const resolvedHandoffs =
    await listPotentialPolymarketHandoffsForCanonicalEvents(client, {
      userId,
      currentLookupKeyVersion: 1,
      events: [canonicalHandoffEvent],
    });
  const resolvedHandoff = resolvedHandoffs.find(
    (candidate) => candidate.attemptId === started.attempt.id,
  );
  assert.equal(
    resolvedHandoff?.resolvedTransactionHash,
    resolvedHandoffTransactionHash,
    "the resolved relayer transaction hash must become durable receive-session correlation evidence",
  );
  assert.equal(
    (
      await listPotentialPolymarketHandoffsForCanonicalEvents(client, {
        userId: otherUserId,
        currentLookupKeyVersion: 1,
        events: [
          {
            ...canonicalHandoffEvent,
            receiptRefLookupHmac: reportInput.receiptRefLookupHmac,
          },
        ],
      })
    ).length,
    0,
    "transaction lineage must remain scoped to the authenticated user",
  );
  const oldKeyHandoffs =
    await listPotentialPolymarketHandoffsForCanonicalEvents(client, {
      userId,
      currentLookupKeyVersion: 2,
      events: [{ ...canonicalHandoffEvent, rawAmount: "1" }],
    });
  assert.equal(
    oldKeyHandoffs.some(
      (candidate) => candidate.attemptId === started.attempt.id,
    ),
    true,
    "a reported old-key reference must remain available for decrypt-and-compare even when the envelope mismatches",
  );

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: actionExecutorId,
    }),
    "invalid_state_transition",
  );
  console.log(
    "[funding-operation-action-persistence-integration-tests] owner scope, idempotent exact report replay, mismatched replay rejection, ambiguous report, and no-rebroadcast passed",
  );
} finally {
  await client.query("rollback");
  client.release();
}
