#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import bs58 from "bs58";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import type {
  EvmTransactionAction,
  JsonValue,
  Money,
  SvmTransactionAction,
  WalletExecutionProfile,
} from "../../domain/types.js";
import {
  buildExactErc20WithdrawalAction,
  buildExactSolWithdrawalAction,
  DIRECT_WITHDRAWAL_ADAPTER_ID,
  DIRECT_WITHDRAWAL_PROVIDER_ID,
  DIRECT_WITHDRAWAL_ROUTE_ID,
} from "../../execution/direct-withdrawal-transfer.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  finishFundingStepAttemptForUserInTransaction,
  resolveAmbiguousProviderFundingStepAttemptForUserInTransaction,
  startFundingStepAttemptInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  fetchFundingOperationForUser,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  applyFundingStepReceiptEvidenceInTransaction,
  listFundingStepReceiptTargets,
  type FundingStepReceiptEvidence,
} from "../../persistence/funding-step-receipt-repository.js";
import { reduceFundingOperationInTransaction } from "../../reconciliation/funding-reducer.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type DirectAction = EvmTransactionAction | SvmTransactionAction;

function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const client = await pool.connect();
try {
  await client.query("begin");
  const user = await client.query<{ id: string }>(
    `insert into users (email, is_active, is_verified)
     values ($1, true, true)
     returning id`,
    [`direct-withdrawal-${crypto.randomUUID()}@example.com`],
  );
  const userId = user.rows[0]?.id;
  assert.ok(userId);

  async function runScenario(
    input: Readonly<{
      amount: Money;
      profile: WalletExecutionProfile;
      recipientAddress: string;
      action: DirectAction;
      actionValidation: JsonRecord;
      executorId: "wallet_profile_evm_v1" | "wallet_profile_svm_v1";
      receipt: FundingStepReceiptEvidence;
      expectedDestinationAddress: string;
      legacyTerminalStatus: "completed" | "failed";
      throughPrivyProviderReference?: boolean;
      futureCreditFence?: Readonly<{
        componentId: string;
        locationId: string;
        amount: Money;
      }>;
    }>,
  ): Promise<void> {
    const recipientFingerprint = hash(input.recipientAddress);
    const recipient = await client.query<{ id: string }>(
      `insert into funding_withdrawal_destinations (
         user_id, network_id, asset_id, asset_decimals, address_ciphertext,
         address_lookup_hmac, lookup_key_version, validation_evidence,
         policy_version, expires_at
       ) values ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, 1, now() + interval '15 minutes')
       returning id`,
      [
        userId,
        input.amount.asset.networkId,
        input.amount.asset.assetId.toLowerCase(),
        input.amount.asset.decimals,
        "ciphertext:recipient",
        recipientFingerprint,
        { addressFingerprint: recipientFingerprint },
      ],
    );
    const recipientId = recipient.rows[0]?.id;
    assert.ok(recipientId);
    const sourceLocationId = opaque("location");
    const sourceComponentId = opaque("component");
    const source = {
      kind: "owned_location" as const,
      location: {
        kind: "wallet" as const,
        locationId: sourceLocationId,
        accountId: userId,
        asset: input.amount.asset,
        details: {
          walletId: input.profile.walletId,
          address: input.profile.address,
        },
      },
    };
    const destination = {
      kind: "external_recipient" as const,
      recipient: {
        recipientId,
        accountId: userId,
        networkId: input.amount.asset.networkId,
        asset: input.amount.asset,
        addressFingerprint: recipientFingerprint,
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        validationPolicyVersion: 1,
      },
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const plan: FundingCommitPlan = {
      operation: {
        purpose: "withdrawal",
        initialState: { status: "in_progress", stage: "committed" },
        experienceMode: "prepare_first",
        planKind: "wallet_route",
        sourceSnapshot: source,
        destinationTargetSnapshot: destination,
        externalRecipientId: recipientId,
        venueId: null,
        marketId: null,
        marketContextSnapshot: null,
        venueBindingSnapshot: null,
        walletExecutionSnapshot: input.profile,
        placementSnapshot: {},
        requestedSourceAmount: input.amount,
        requestedDestinationAmount: input.amount,
        supportMetadata: {
          adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
          routeId: DIRECT_WITHDRAWAL_ROUTE_ID,
          withdrawalExecutionKind: "exact_same_asset_transfer",
        },
      },
      segments: [
        {
          providerId: DIRECT_WITHDRAWAL_PROVIDER_ID,
          adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
          adapterVersion: 1,
          segmentKind: "same_network_swap",
          status: "planned",
          sourceSnapshot: source,
          destinationTargetSnapshot: destination,
          quotedInput: input.amount,
          quotedExpectedOutput: input.amount,
          quotedMinOutput: input.amount,
          providerQuoteRefCiphertext: null,
          providerQuoteRefLookupHmac: null,
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: 1,
          refundLocationSnapshot: source.location,
          quoteExpiresAt: expiresAt,
        },
      ],
      steps: [
        {
          ordinal: 0,
          segmentOrdinal: 0,
          stepKind: "transaction",
          state: "action_required",
          actionFingerprint: canonicalJsonHash(input.action),
          executorId: input.executorId,
          payerRequirement: "user",
          dependsOnOrdinal: null,
          normalizedAction: input.action,
          actionValidationResult: input.actionValidation,
          actionExpiresAt: expiresAt,
        },
      ],
      reservations: [
        {
          segmentOrdinal: 0,
          componentId: sourceComponentId,
          locationId: sourceLocationId,
          networkId: input.amount.asset.networkId,
          assetId: input.amount.asset.assetId,
          assetDecimals: input.amount.asset.decimals,
          rawAmount: input.amount.raw,
          mode: "subtract_available",
          expiresAt,
        },
        ...(input.futureCreditFence
          ? [
              {
                segmentOrdinal: null,
                componentId: input.futureCreditFence.componentId,
                locationId: input.futureCreditFence.locationId,
                networkId: input.futureCreditFence.amount.asset.networkId,
                assetId: input.futureCreditFence.amount.asset.assetId,
                assetDecimals: input.futureCreditFence.amount.asset.decimals,
                rawAmount: input.futureCreditFence.amount.raw,
                mode: "subtract_available" as const,
                expiresAt,
                economicRole: "future_credit_fence" as const,
              },
            ]
          : []),
      ],
    };
    const consentToken = opaque("consent");
    const quote = await createFundingQuoteInTransaction(client, {
      userId,
      discoveryProjectionId: opaque("projection"),
      selectedSourceOptionSnapshot: plan.operation.sourceSnapshot ?? {},
      marketContextSnapshot: null,
      destinationOptionSnapshot: destination,
      venueBindingSnapshot: null,
      planSnapshot: plan,
      policyVersion: 1,
      policyRevision: "direct_withdrawal_policy_v1",
      canonicalRequest: { purpose: "withdrawal", recipientId },
      consentToken,
      expiresAt: new Date(expiresAt),
    });
    const committed = await commitFundingOperationInTransaction(client, {
      userId,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: opaque("idempotency"),
      plan,
      subjectLookupHmac: hash(userId),
      subjectLookupKeyVersion: 1,
    });
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");
    let competingCommit:
      | Readonly<{
          consentToken: string;
          idempotencyKey: string;
          plan: FundingCommitPlan;
          quoteId: string;
        }>
      | undefined;
    if (input.futureCreditFence) {
      // The source adapter test proves which canonical controller-asset
      // identity is emitted. This database test isolates the matching
      // reservation contract: no other operation may claim that identity
      // between the Deposit Wallet handoff and the dependent transfer.
      const competingPlan: FundingCommitPlan = {
        ...plan,
        reservations: [
          {
            segmentOrdinal: 0,
            componentId: input.futureCreditFence.componentId,
            locationId: input.futureCreditFence.locationId,
            networkId: input.futureCreditFence.amount.asset.networkId,
            assetId: input.futureCreditFence.amount.asset.assetId,
            assetDecimals: input.futureCreditFence.amount.asset.decimals,
            rawAmount: input.futureCreditFence.amount.raw,
            mode: "subtract_available",
            expiresAt,
          },
        ],
      };
      const competingConsentToken = opaque("consent");
      const competingQuote = await createFundingQuoteInTransaction(client, {
        userId,
        discoveryProjectionId: opaque("projection"),
        selectedSourceOptionSnapshot:
          competingPlan.operation.sourceSnapshot ?? {},
        marketContextSnapshot: null,
        destinationOptionSnapshot:
          competingPlan.operation.destinationTargetSnapshot,
        venueBindingSnapshot: null,
        planSnapshot: competingPlan,
        policyVersion: 1,
        policyRevision: "direct_withdrawal_future_credit_fence_v1",
        canonicalRequest: {
          purpose: "withdrawal",
          sourceComponentId: input.futureCreditFence.componentId,
        },
        consentToken: competingConsentToken,
        expiresAt: new Date(expiresAt),
      });
      competingCommit = {
        consentToken: competingConsentToken,
        idempotencyKey: opaque("idempotency"),
        plan: competingPlan,
        quoteId: competingQuote.id,
      };
      await client.query("savepoint competing_controller_credit_commit");
      await assert.rejects(
        commitFundingOperationInTransaction(client, {
          userId,
          quoteId: competingCommit.quoteId,
          consentToken: competingCommit.consentToken,
          idempotencyKey: competingCommit.idempotencyKey,
          plan: competingCommit.plan,
          subjectLookupHmac: hash("competing-controller-credit"),
          subjectLookupKeyVersion: 1,
        }),
        (error: unknown) => {
          assert.ok(error instanceof FundingPersistenceError);
          assert.equal(error.code, "quote_invalidated");
          return true;
        },
      );
      // The production transaction wrapper rolls back the whole failed
      // commit. Mirror that here while retaining the quote for the retry after
      // the holder operation releases its fence.
      await client.query(
        "rollback to savepoint competing_controller_credit_commit",
      );
      await client.query("set constraints all deferred");
    }
    const persisted = await client.query<{
      segment_id: string;
      step_id: string;
    }>(
      `select funding_step.id as step_id, funding_step.segment_id
         from funding_operation_steps funding_step
        where funding_step.operation_id = $1`,
      [committed.operation.id],
    );
    const stepId = persisted.rows[0]?.step_id;
    const segmentId = persisted.rows[0]?.segment_id;
    assert.ok(stepId);
    assert.ok(segmentId);
    const attempt = await startFundingStepAttemptInTransaction(client, {
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: canonicalJsonHash(input.action),
      executorId: input.executorId,
    });
    if (input.throughPrivyProviderReference) {
      const providerReferenceLookupHmac = hash("privy-transaction-id");
      await finishFundingStepAttemptForUserInTransaction(client, {
        userId,
        operationId: committed.operation.id,
        stepId,
        attemptId: attempt.id,
        outcome: "ambiguous",
        broadcastMayHaveOccurred: true,
        referenceKind: "provider_receipt",
        receiptRefCiphertext: "ciphertext:privy-transaction-id",
        receiptRefLookupHmac: providerReferenceLookupHmac,
        lookupKeyVersion: 1,
        actualCosts: { providerReferenceKind: "privy_transaction" },
      });
      const providerTargets = await listFundingStepReceiptTargets(
        client,
        committed.operation.id,
      );
      assert.equal(providerTargets.length, 1);
      assert.equal(providerTargets[0]?.referenceKind, "provider_receipt");
      await resolveAmbiguousProviderFundingStepAttemptForUserInTransaction(
        client,
        {
          userId,
          operationId: committed.operation.id,
          stepId,
          attemptId: attempt.id,
          providerReferenceLookupHmac,
          retryableDefinitiveFailure: false,
          resolution: {
            kind: "transaction",
            receiptRefCiphertext: "ciphertext:transaction",
            receiptRefLookupHmac: hash(attempt.id),
            lookupKeyVersion: 1,
          },
        },
      );
    } else {
      await finishFundingStepAttemptForUserInTransaction(client, {
        userId,
        operationId: committed.operation.id,
        stepId,
        attemptId: attempt.id,
        outcome: "submitted",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: "ciphertext:transaction",
        receiptRefLookupHmac: hash(attempt.id),
        lookupKeyVersion: 1,
        actualCosts: {},
      });
    }
    const beforeConfirmation = await client.query<{ count: string }>(
      `select count(*)::text as count from notifications
        where user_id = $1 and dedupe_key = $2`,
      [userId, `withdrawal:${committed.operation.id}`],
    );
    assert.equal(
      beforeConfirmation.rows[0]?.count,
      "0",
      "submitted/ambiguous transfers must not announce successful withdrawal",
    );
    await client.query(
      `update funding_operations
          set status = $2, progress_stage = 'terminal',
              completed_at = clock_timestamp(), version = version + 1
        where id = $1`,
      [committed.operation.id, input.legacyTerminalStatus],
    );
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: committed.operation.id,
      stepId,
      attemptId: attempt.id,
      networkId: input.amount.asset.networkId,
      receipt: input.receipt,
    });
    const reopened = await fetchFundingOperationForUser(client, {
      userId,
      operationId: committed.operation.id,
    });
    assert.equal(
      reopened?.status,
      "completed",
      "a stale terminal cache cannot delay a finalized exact withdrawal",
    );
    assert.equal(reopened?.recoveryMode, null);
    const observation = await client.query<{
      kind: string;
      segment_id: string | null;
      to_address: string;
    }>(
      `select kind, segment_id, to_address
         from funding_observations
        where operation_id = $1`,
      [committed.operation.id],
    );
    assert.deepEqual(observation.rows, [
      {
        kind: "destination_credit",
        segment_id: segmentId,
        to_address: input.expectedDestinationAddress,
      },
    ]);
    const reduced = await reduceFundingOperationInTransaction(client, {
      operationId: committed.operation.id,
    });
    assert.deepEqual(reduced.finalState, {
      status: "completed",
      stage: "terminal",
    });
    const notices = await client.query<{ count: string }>(
      `select count(*)::text as count from notifications
        where user_id = $1 and dedupe_key = $2`,
      [userId, `withdrawal:${committed.operation.id}`],
    );
    assert.equal(
      notices.rows[0]?.count,
      input.legacyTerminalStatus === "completed" ? "0" : "1",
      "canonical completion emits once; old terminal caches are not replayed",
    );
    if (competingCommit) {
      const releasedFence = await client.query<{
        economic_role: string;
        state: string;
      }>(
        `select economic_role, state
           from balance_reservations
          where operation_id = $1
            and component_id = $2`,
        [committed.operation.id, input.futureCreditFence?.componentId],
      );
      assert.deepEqual(releasedFence.rows, [
        { economic_role: "future_credit_fence", state: "released" },
      ]);
      const committedAfterRelease = await commitFundingOperationInTransaction(
        client,
        {
          userId,
          quoteId: competingCommit.quoteId,
          consentToken: competingCommit.consentToken,
          idempotencyKey: competingCommit.idempotencyKey,
          plan: competingCommit.plan,
          subjectLookupHmac: hash("competing-controller-credit"),
          subjectLookupKeyVersion: 1,
        },
      );
      assert.equal(committedAfterRelease.replayed, false);
    }
    const terminalTargets = await listFundingStepReceiptTargets(
      client,
      committed.operation.id,
    );
    assert.equal(terminalTargets.length, 1);
    assert.equal(terminalTargets[0]?.attemptId, attempt.id);

    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: committed.operation.id,
      stepId,
      attemptId: attempt.id,
      networkId: input.amount.asset.networkId,
      receipt: {
        ...input.receipt,
        status: "reorged",
        canonical: false,
        failureCode: "finalized_transaction_reorged",
      },
    });
    const reorgedObservation = await client.query<{
      canonical: boolean;
      finality_status: string;
    }>(
      `select canonical, finality_status
         from funding_observations
        where operation_id = $1
          and kind = 'destination_credit'`,
      [committed.operation.id],
    );
    assert.deepEqual(reorgedObservation.rows, [
      { canonical: false, finality_status: "reorged" },
    ]);
    const reorgedReduction = await reduceFundingOperationInTransaction(client, {
      operationId: committed.operation.id,
    });
    assert.equal(reorgedReduction.reorgBlockedByTerminalState, false);
    assert.deepEqual(reorgedReduction.finalState, {
      status: "recovery_required",
      stage: "source_action",
    });
  }

  const evmAmount = {
    asset: {
      networkId: "evm:137",
      assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      decimals: 6,
    },
    raw: "50000000",
  } as const;
  const evmProfile = {
    walletId: opaque("wallet"),
    controllerWalletRef: opaque("controller"),
    networkId: evmAmount.asset.networkId,
    address: "0x3333333333333333333333333333333333333333",
    source: "external" as const,
    signingModes: ["web_client" as const],
    serverWalletRef: null,
    sponsorshipPolicyIds: [],
  };
  const evmRecipient = "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0";
  const evmBuilt = buildExactErc20WithdrawalAction({
    amount: evmAmount,
    profile: evmProfile,
    recipient: {
      address: evmRecipient,
      addressFingerprint: hash(evmRecipient),
    },
  });
  await runScenario({
    amount: evmAmount,
    profile: evmProfile,
    recipientAddress: evmRecipient,
    action: evmBuilt.action,
    actionValidation: evmBuilt.validation,
    executorId: "wallet_profile_evm_v1",
    receipt: {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "100",
      blockHash: `0x${hash("evm-block-hash")}`,
      canonical: true,
      failureCode: null,
      evidence: {
        attributedSourceRaw: evmAmount.raw,
        sourceDebitEventIndex: "0",
        transactionHash: `0x${hash("evm-transaction-hash")}`,
      },
    },
    expectedDestinationAddress: evmRecipient.toLowerCase(),
    legacyTerminalStatus: "failed",
    throughPrivyProviderReference: true,
  });

  const solAmount = {
    asset: {
      networkId: "solana:mainnet",
      assetId: "11111111111111111111111111111111",
      decimals: 9,
    },
    raw: "10000000",
  } as const;
  const solProfile = {
    walletId: opaque("wallet"),
    controllerWalletRef: opaque("controller"),
    networkId: solAmount.asset.networkId,
    address: "78Hpb2CbmvW2Gp2aJGZec8nphXdqtRdfjPwwLfxKgo6t",
    source: "embedded" as const,
    signingModes: ["web_client" as const, "privy_authorization" as const],
    serverWalletRef: opaque("privy_wallet"),
    sponsorshipPolicyIds: [],
  };
  const solRecipient = "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ";
  const solBuilt = buildExactSolWithdrawalAction({
    amount: solAmount,
    profile: solProfile,
    recipient: {
      address: solRecipient,
      addressFingerprint: hash(solRecipient),
    },
  });
  const solSignature = bs58.encode(Buffer.alloc(64, 7));
  await runScenario({
    amount: solAmount,
    profile: solProfile,
    recipientAddress: solRecipient,
    action: solBuilt.action,
    actionValidation: solBuilt.validation,
    executorId: "wallet_profile_svm_v1",
    receipt: {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "200",
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: { transactionSignature: solSignature },
    },
    expectedDestinationAddress: solRecipient,
    legacyTerminalStatus: "completed",
  });

  const usdceAmount = {
    asset: {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonUsdce,
      decimals: 6,
    },
    raw: "6305257",
  } as const;
  const usdceRecipient = "0x2222222222222222222222222222222222222222";
  const usdceProfile = {
    ...evmProfile,
    walletId: opaque("wallet"),
  };
  const usdceTransfer = buildExactErc20WithdrawalAction({
    amount: usdceAmount,
    profile: usdceProfile,
    recipient: {
      address: usdceRecipient,
      addressFingerprint: hash(usdceRecipient),
    },
  });
  await runScenario({
    amount: usdceAmount,
    profile: usdceProfile,
    recipientAddress: usdceRecipient,
    action: usdceTransfer.action,
    actionValidation: usdceTransfer.validation,
    executorId: "wallet_profile_evm_v1",
    receipt: {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "300",
      blockHash: `0x${hash("usdce-withdrawal-block-hash")}`,
      canonical: true,
      failureCode: null,
      evidence: {
        attributedSourceRaw: usdceAmount.raw,
        sourceDebitEventIndex: "0",
        transactionHash: `0x${hash("usdce-withdrawal-transaction-hash")}`,
      },
    },
    expectedDestinationAddress: usdceRecipient.toLowerCase(),
    legacyTerminalStatus: "failed",
    futureCreditFence: {
      componentId: opaque("controller_usdce_component"),
      locationId: opaque("controller_usdce_location"),
      amount: {
        asset: usdceAmount.asset,
        raw: usdceAmount.raw,
      },
    },
  });

  console.log(
    "[funding-direct-withdrawal-integration-tests] exact EVM/SOL/USDC.e completion, Privy provider-reference recovery, future-credit fencing, and terminal reorg detection passed",
  );
} finally {
  await client.query("rollback");
  client.release();
}
