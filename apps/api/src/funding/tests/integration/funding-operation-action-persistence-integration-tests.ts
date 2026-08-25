#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { ethers } from "ethers";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  fetchFundingOperationStepForUser,
  finishFundingStepAttemptForUserInTransaction,
  listPotentialPolymarketHandoffsForCanonicalEvents,
  startFundingStepAttemptForUserInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";

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
    /only exact venue preparation or Polymarket pre-route handoff steps may be unbound/u,
  );
  await client.query("rollback to savepoint invalid_pre_route_shape");
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
  assert.equal(startedHandoffs.length, 1);
  assert.equal(startedHandoffs[0]?.attemptId, started.attempt.id);
  assert.equal(startedHandoffs[0]?.attemptOutcome, "started");

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
    referenceKind: "transaction",
    receiptRefCiphertext: "ciphertext:transaction",
    receiptRefLookupHmac: hash("transaction"),
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
      events: [
        {
          ...canonicalHandoffEvent,
          receiptRefLookupHmac: reportInput.receiptRefLookupHmac,
        },
      ],
    });
  assert.equal(matchingHandoffs.length, 1);
  assert.equal(matchingHandoffs[0]?.attemptId, started.attempt.id);
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
  assert.equal(
    (
      await listPotentialPolymarketHandoffsForCanonicalEvents(client, {
        userId,
        currentLookupKeyVersion: 2,
        events: [{ ...canonicalHandoffEvent, rawAmount: "1" }],
      })
    ).length,
    1,
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
