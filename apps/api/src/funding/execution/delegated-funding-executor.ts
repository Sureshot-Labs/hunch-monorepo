import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";
import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { stableWalletOpaqueId } from "../../account-value/canonical.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import type {
  JsonValue,
  NormalizedAction,
  WalletExecutionProfile,
} from "../domain/types.js";
import { canonicalAccountAddress } from "../domain/asset-identity.js";
import {
  finishFundingStepAttemptForUserInTransaction,
  resolveAmbiguousProviderFundingStepAttemptForUserInTransaction,
  startFundingStepAttemptInTransaction,
  startFundingStepAttemptForUserInTransaction,
} from "../persistence/funding-evidence-repository.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
} from "../policies/funding-policy-service.js";
import type { FundingTransactionReferenceCodec } from "./transaction-reference-codec.js";
import type { PolymarketWrapExecutionConfiguration } from "./delegated-funding-config.js";
import {
  polymarketWrapExecutorEnvironmentReady,
  polymarketWrapProfileConfigured,
} from "./delegated-funding-config.js";
import {
  classifyPolymarketWrapControlPlane,
  combineDelegatedFundingDecisions,
  fundingPolicyRevisionMayResume,
  type DelegatedFundingPreBroadcastDecision,
} from "./delegated-funding-capability.js";
import {
  delegatedFundingProfile,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  validatePolymarketDepositUsdceWrapAction,
} from "./delegated-funding-profiles.js";
import {
  telegramFundingAuthorizationFingerprint,
  telegramFundingAuthorizationFromRow,
  resolveCurrentTelegramFundingAuthority,
  type TelegramFundingAuthorizationRow,
} from "./telegram-funding-authorization.js";
import { lockTelegramFundingLinkLifecycle } from "./telegram-funding-link-lifecycle-lock.js";
import { lockFundingControllerWallet } from "./funding-controller-wallet-lock.js";
import {
  DELEGATED_PROVIDER_LOOKUP_DELAY_MS,
  DELEGATED_PROVIDER_REPLAY_MS,
  DELEGATED_UNBROADCAST_RETRY_MS,
} from "./delegated-funding-recovery-policy.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type DelegatedFundingExecutionClaim = Readonly<{
  action: NormalizedAction;
  allowanceMutationBaselineBlock?: string | null;
  actionWalletId: string;
  actionFingerprint: string;
  actionValidationResult: JsonRecord;
  authorizationFingerprint: string;
  authorizationId: string;
  attemptId: string;
  broadcastBoundaryCrossed: boolean;
  destinationOptionId: string;
  fundingPolicyRevision?: string;
  fundingPolicyVersion?: number;
  operationId: string;
  policyFingerprint: string;
  policyId: string;
  privyWalletId: string;
  profileId: string;
  receiptRaw: string;
  sponsor: boolean;
  signerFingerprint: string;
  signerId: string;
  stepId: string;
  telegramAccountId: string | null;
  telegramUserId: string;
  userId: string;
  venueId?: string;
  venueBindingOptionId: string;
  walletAddress: string;
}>;

export type DelegatedFundingRecoveryClaim = DelegatedFundingExecutionClaim;

export type DelegatedFundingProviderLookupClaim = Readonly<{
  action: NormalizedAction;
  attemptId: string;
  operationId: string;
  profileId: string;
  stepId: string;
  userId: string;
}>;

export type DelegatedFundingProviderLookupResult =
  | Readonly<{ kind: "submitted"; transactionReference: string }>
  | Readonly<{ kind: "pending" }>;

export type DelegatedFundingProfileClaim =
  | Readonly<{
      kind: "execution";
      claim: DelegatedFundingExecutionClaim;
    }>
  | Readonly<{
      kind: "rejected";
      operationId: string;
    }>
  | Readonly<{
      /**
       * A step expired before an attempt existed. This is deliberately not an
       * execution claim: no provider call or wallet authority was acquired.
       */
      kind: "expired_without_broadcast";
      operationId: string;
    }>;

export type DelegatedFundingExecutionResult =
  | Readonly<{ kind: "submitted"; transactionReference: string }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{
      kind: "proven_nonbroadcast_failure";
      reasonCode: string;
    }>;

export type DelegatedFundingNetworkDriver = Readonly<{
  execute: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<DelegatedFundingExecutionResult>;
  recover: (
    claim: DelegatedFundingRecoveryClaim,
  ) => Promise<DelegatedFundingExecutionResult>;
  lookupProviderReference: (
    claim: DelegatedFundingProviderLookupClaim,
  ) => Promise<DelegatedFundingProviderLookupResult>;
}>;

type ResolvedFundingPolicy = Awaited<ReturnType<typeof resolveFundingPolicy>>;
type DelegatedFundingRuntimePreBroadcastDecision =
  | DelegatedFundingPreBroadcastDecision
  | Readonly<{ kind: "already_satisfied" }>;

export type DelegatedFundingRuntimeProfile = Readonly<{
  profileId: string;
  controlPlaneDecision: (
    policy: ResolvedFundingPolicy,
  ) => DelegatedFundingPreBroadcastDecision;
  rejectInvalidInTransaction: (
    client: PoolClient,
    input: Readonly<{
      controlDecision: DelegatedFundingPreBroadcastDecision;
      now: Date;
    }>,
  ) => Promise<Readonly<{ operationId: string }> | null>;
  claimInTransaction: (
    client: PoolClient,
    input: Readonly<{
      policy: ResolvedFundingPolicy;
      now: Date;
      observation?: JsonRecord;
    }>,
  ) => Promise<DelegatedFundingProfileClaim | null>;
  recoverInTransaction: (
    client: PoolClient,
    input: Readonly<{
      recoverProviderReplayBefore: Date;
      recoverUnbroadcastRetryBefore: Date;
      now: Date;
    }>,
  ) => Promise<DelegatedFundingRecoveryClaim | null>;
  preBroadcastDecisionInTransaction: (
    client: PoolClient,
    input: Readonly<{
      claim: DelegatedFundingExecutionClaim;
      now: Date;
      observation?: JsonRecord;
    }>,
  ) => Promise<DelegatedFundingRuntimePreBroadcastDecision>;
  observePreBroadcast?: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<JsonRecord>;
  finalizeAlreadySatisfiedInTransaction?: (
    client: PoolClient,
    input: Readonly<{
      claim: DelegatedFundingExecutionClaim;
      now: Date;
      observation?: JsonRecord;
    }>,
  ) => Promise<void>;
  finalizeHardInvalidInTransaction?: (
    client: PoolClient,
    input: Readonly<{
      claim: DelegatedFundingExecutionClaim;
      now: Date;
      reasonCode: string;
      observation?: JsonRecord;
    }>,
  ) => Promise<void>;
  observeBeforeClaim?: (
    pool: Pool,
    input: Readonly<{ now: Date }>,
  ) => Promise<JsonRecord | undefined>;
  driver: DelegatedFundingNetworkDriver;
  validateSubmittedReference: (reference: string) => boolean;
}>;

type ClaimRow = Omit<TelegramFundingAuthorizationRow, "id"> &
  Readonly<{
    action_fingerprint: string;
    action_validation_result: JsonRecord;
    authorization_id: string;
    authorization_fingerprint: string;
    executor_id: string;
    normalized_action: JsonRecord;
    operation_id: string;
    policy_revision: string;
    policy_version: string | number;
    payer_requirement: string;
    receipt_raw: string;
    step_id: string;
  }>;

function actionWalletId(
  row: Pick<ClaimRow, "wallet_chain" | "wallet_address">,
  networkId = "evm:137",
) {
  return stableWalletOpaqueId({
    walletType: row.wallet_chain,
    networkId,
    address: row.wallet_address,
  });
}

function delegatedControllerProfile(
  row: Pick<ClaimRow, "privy_wallet_id" | "user_wallet_id" | "wallet_address">,
  walletId: string,
  networkId = "evm:137",
): WalletExecutionProfile {
  return {
    walletId,
    controllerWalletRef: row.user_wallet_id,
    networkId,
    address: canonicalAccountAddress(networkId, row.wallet_address),
    source: "embedded",
    signingModes: ["privy_delegated"],
    serverWalletRef: row.privy_wallet_id,
    sponsorshipPolicyIds: [],
    evmAtomicBatchMode: null,
  };
}

function executionClaimFromRow(
  row: Omit<ClaimRow, "telegram_account_id"> & {
    telegram_account_id: string | null;
  },
  input: Readonly<{
    action: NormalizedAction;
    actionWalletId: string;
    attemptId: string;
    broadcastBoundaryCrossed: boolean;
  }>,
): DelegatedFundingExecutionClaim {
  return {
    action: input.action,
    actionValidationResult: row.action_validation_result,
    actionWalletId: input.actionWalletId,
    actionFingerprint: row.action_fingerprint,
    authorizationFingerprint: row.authorization_fingerprint,
    authorizationId: row.authorization_id,
    attemptId: input.attemptId,
    broadcastBoundaryCrossed: input.broadcastBoundaryCrossed,
    destinationOptionId: row.destination_option_id,
    operationId: row.operation_id,
    policyFingerprint: row.policy_fingerprint,
    policyId: row.policy_id,
    privyWalletId: row.privy_wallet_id,
    profileId: row.executor_id,
    receiptRaw: row.receipt_raw,
    signerFingerprint: row.signer_fingerprint,
    signerId: row.signer_id,
    sponsor: row.payer_requirement === "privy_sponsor",
    stepId: row.step_id,
    telegramAccountId: row.telegram_account_id,
    telegramUserId: row.telegram_user_id,
    userId: row.user_id,
    venueBindingOptionId: row.venue_binding_option_id,
    walletAddress: canonicalAccountAddress("evm:1", row.wallet_address),
  };
}

async function tryStartDelegatedFundingAttempt(
  client: PoolClient,
  row: Pick<
    ClaimRow,
    | "action_fingerprint"
    | "executor_id"
    | "operation_id"
    | "step_id"
    | "user_id"
  >,
) {
  try {
    return (
      await startFundingStepAttemptForUserInTransaction(client, {
        userId: row.user_id,
        operationId: row.operation_id,
        stepId: row.step_id,
        canonicalActionFingerprint: row.action_fingerprint,
        executorId: row.executor_id,
      })
    ).attempt;
  } catch (error) {
    // The shared attempt guard is authoritative when concurrent workers read
    // the same pre-commit snapshot. Losing that race is not a batch failure.
    if (
      error instanceof FundingPersistenceError &&
      (error.code === "invalid_state_transition" ||
        error.code === "quote_expired")
    ) {
      return null;
    }
    throw error;
  }
}

async function tryStartDelegatedFundingRejection(
  client: PoolClient,
  row: Pick<
    ClaimRow,
    "action_fingerprint" | "executor_id" | "operation_id" | "step_id"
  >,
  now: Date,
) {
  try {
    return await startFundingStepAttemptInTransaction(client, {
      operationId: row.operation_id,
      stepId: row.step_id,
      canonicalActionFingerprint: row.action_fingerprint,
      executorId: row.executor_id,
      now,
    });
  } catch (error) {
    if (
      error instanceof FundingPersistenceError &&
      error.code === "invalid_state_transition"
    ) {
      return null;
    }
    throw error;
  }
}

async function finishDelegatedFundingNonbroadcastFailure(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
    reasonCode: string;
    diagnosticCode?: string;
    now: Date;
  }>,
): Promise<void> {
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: input.userId,
    operationId: input.operationId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    outcome: "failed",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: {
      reasonCode: input.reasonCode,
      ...(input.diagnosticCode ? { diagnosticCode: input.diagnosticCode } : {}),
    },
    now: input.now,
  });
}

async function rejectInvalidPolymarketWrapInTransaction(
  client: PoolClient,
  input: Readonly<{
    configuration: PolymarketWrapExecutionConfiguration;
    controlDecision: DelegatedFundingPreBroadcastDecision;
    now: Date;
  }>,
): Promise<Readonly<{ operationId: string }> | null> {
  const invalid = await client.query<{
    action_fingerprint: string;
    executor_id: string;
    operation_id: string;
    step_id: string;
    user_id: string;
  }>(
    `
      select
        operation.id as operation_id,
        operation.user_id,
        step.id as step_id,
        step.action_fingerprint,
        step.action_validation_result,
        step.executor_id
      from funding_operation_steps step
      join funding_operations operation on operation.id = step.operation_id
      where step.executor_id = $1
        and step.state = 'action_required'
        and operation.status not in (
          'completed', 'refunded', 'failed', 'cancelled'
        )
        and (
          step.action_expires_at is null
          or step.action_expires_at > clock_timestamp()
        )
        and operation.support_metadata ->> 'preparationKind' =
              'polymarket_funding_router'
        and not exists (
          select 1
          from funding_operation_step_attempts attempt
          where attempt.step_id = step.id
        )
        and (
          $2::boolean
          or not exists (
            select 1
            from telegram_funding_authorizations funding_authorization
            join user_telegram_accounts telegram_account
              on telegram_account.id = funding_authorization.telegram_account_id
             and telegram_account.user_id = funding_authorization.user_id
             and telegram_account.telegram_user_id =
                   funding_authorization.telegram_user_id
            join user_wallets wallet
              on wallet.id = funding_authorization.user_wallet_id
             and wallet.user_id = funding_authorization.user_id
             and wallet.is_verified = true
             and wallet.is_internal_wallet = true
             and wallet.privy_wallet_id = funding_authorization.privy_wallet_id
             and funding_account_identifier_equal(
                   funding_authorization.wallet_chain,
                   wallet.wallet_address,
                   funding_authorization.wallet_address
                 )
            join users app_user
              on app_user.id = funding_authorization.user_id
             and coalesce(app_user.is_active, true) = true
            where funding_authorization.id::text =
                    operation.support_metadata ->> 'fundingAuthorizationId'
              and funding_authorization.user_id = operation.user_id
              and funding_authorization.profile_id = $1
              and funding_authorization.security_class =
                    'closed_destination_transform'
              and (
                not $8::boolean
                or (
                  funding_authorization.signer_id = $3
                  and funding_authorization.signer_fingerprint = $4
                  and funding_authorization.policy_id = $5
                  and funding_authorization.policy_fingerprint = $6
                )
              )
              and funding_authorization.venue_id = operation.venue_id
              and funding_authorization.venue_binding_option_id =
                    operation.support_metadata ->> 'venueBindingOptionId'
              and funding_authorization.revoked_at is null
              and (
                funding_authorization.expires_at is null
                or funding_authorization.expires_at > $7
              )
              and (
                exists (
                  select 1
                    from funding_receive_receipts receipt_row
                    join telegram_funding_sessions funding_context
                      on funding_context.receive_session_id =
                           receipt_row.receive_session_id
                     and funding_context.user_id = operation.user_id
                    join telegram_funding_consents funding_consent
                      on funding_consent.id::text =
                           operation.support_metadata ->>
                             'telegramFundingConsentId'
                     and funding_consent.telegram_funding_session_id =
                           funding_context.id
                     and funding_consent.consent_fingerprint =
                           operation.support_metadata ->>
                             'telegramFundingConsentFingerprint'
                   where receipt_row.id::text =
                           operation.support_metadata ->>
                             'fundingReceiveReceiptId'
                     and receipt_row.child_funding_operation_id = operation.id
                     and receipt_row.user_id = operation.user_id
                     and receipt_row.status = 'routing'
                     and operation.requested_source_amount ->> 'raw' =
                           receipt_row.raw_amount::text
                )
                or exists (
                  select 1
                    from telegram_trade_intents trade_intent
                   where trade_intent.id::text =
                           operation.support_metadata ->>
                             'telegramTradeIntentId'
                     and trade_intent.user_id = operation.user_id
                     and trade_intent.funding_operation_id = operation.id
                     and trade_intent.status = 'funding'
                     and trade_intent.submit_started_at is null
                     and operation.support_metadata ->>
                           'delegatedOriginKind' = 'trade_shortfall_intent'
                )
              )
          )
        )
      order by operation.created_at asc, step.ordinal asc
      for update of operation, step skip locked
      limit 1
    `,
    [
      POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
      input.controlDecision.kind === "hard_invalid",
      input.configuration.signerId,
      input.configuration.signerFingerprint,
      input.configuration.policyId,
      input.configuration.policyFingerprint,
      input.now,
      polymarketWrapProfileConfigured(input.configuration),
    ],
  );
  const row = invalid.rows[0];
  if (!row) return null;
  const attempt = await tryStartDelegatedFundingRejection(
    client,
    row,
    input.now,
  );
  if (!attempt) return null;
  await finishDelegatedFundingNonbroadcastFailure(client, {
    userId: row.user_id,
    operationId: row.operation_id,
    stepId: row.step_id,
    attemptId: attempt.id,
    reasonCode:
      input.controlDecision.kind === "hard_invalid"
        ? input.controlDecision.reasonCode
        : "delegated_authority_invalid",
    now: input.now,
  });
  return { operationId: row.operation_id };
}

async function claimPolymarketWrapInTransaction(
  client: PoolClient,
  input: Readonly<{
    policy: ResolvedFundingPolicy;
    now: Date;
  }>,
): Promise<DelegatedFundingProfileClaim | null> {
  const { rows } = await client.query<ClaimRow>(
    `
      select
        operation.id as operation_id,
        operation.user_id,
        operation.policy_version,
        operation.policy_revision,
        operation.support_metadata ->> 'fundingAuthorizationId' as authorization_id,
        operation.support_metadata ->> 'fundingAuthorizationFingerprint' as authorization_fingerprint,
        step.id as step_id,
        step.action_fingerprint,
        step.action_validation_result,
        step.executor_id,
        step.normalized_action,
        step.payer_requirement,
        operation.requested_source_amount ->> 'raw' as receipt_raw,
        funding_authorization.telegram_account_id,
        funding_authorization.telegram_user_id,
        funding_authorization.user_wallet_id,
        funding_authorization.privy_wallet_id,
        funding_authorization.wallet_address,
        funding_authorization.wallet_chain,
        funding_authorization.profile_id,
        funding_authorization.security_class,
        funding_authorization.max_source_raw::text,
        funding_authorization.signer_id,
        funding_authorization.signer_fingerprint,
        funding_authorization.policy_id,
        funding_authorization.policy_fingerprint,
        funding_authorization.venue_id,
        funding_authorization.destination_option_id,
        funding_authorization.venue_binding_option_id,
        funding_authorization.source_network_id,
        funding_authorization.source_asset_id,
        funding_authorization.source_asset_decimals,
        funding_authorization.destination_network_id,
        funding_authorization.destination_asset_id,
        funding_authorization.destination_asset_decimals,
        funding_authorization.granted_at,
        funding_authorization.expires_at
      from funding_operation_steps step
      join funding_operations operation
        on operation.id = step.operation_id
      left join funding_operation_steps dependency
        on dependency.id = step.depends_on_step_id
       and dependency.operation_id = step.operation_id
      join telegram_funding_authorizations funding_authorization
        on funding_authorization.id::text =
             operation.support_metadata ->> 'fundingAuthorizationId'
       and funding_authorization.user_id = operation.user_id
       and funding_authorization.profile_id = $1
       and funding_authorization.security_class = 'closed_destination_transform'
       and funding_authorization.venue_id = operation.venue_id
       and funding_authorization.venue_binding_option_id =
             operation.support_metadata ->> 'venueBindingOptionId'
       and funding_authorization.source_network_id =
             operation.requested_source_amount -> 'asset' ->> 'networkId'
       and funding_account_identifier_equal(
             operation.requested_source_amount -> 'asset' ->> 'networkId',
             funding_authorization.source_asset_id,
             operation.requested_source_amount -> 'asset' ->> 'assetId'
           )
       and funding_authorization.source_asset_decimals =
             (operation.requested_source_amount -> 'asset' ->> 'decimals')::int
       and funding_authorization.user_wallet_id is not null
       and funding_authorization.revoked_at is null
       and (
         funding_authorization.expires_at is null
         or funding_authorization.expires_at > clock_timestamp()
       )
      where step.executor_id = $1
        and step.state = 'action_required'
        and (step.depends_on_step_id is null or dependency.state = 'succeeded')
        and operation.status not in (
          'completed', 'refunded', 'failed', 'cancelled'
        )
        and (
          step.action_expires_at is null
          or step.action_expires_at > clock_timestamp()
        )
        and operation.support_metadata ->> 'preparationKind' =
              'polymarket_funding_router'
        and operation.requested_source_amount ->> 'raw' ~ '^[1-9][0-9]*$'
        and (
          exists (
            select 1
              from funding_receive_receipts receipt_row
              join telegram_funding_sessions funding_context
                on funding_context.receive_session_id =
                     receipt_row.receive_session_id
               and funding_context.user_id = operation.user_id
              join telegram_funding_consents funding_consent
                on funding_consent.id::text =
                     operation.support_metadata ->> 'telegramFundingConsentId'
               and funding_consent.telegram_funding_session_id =
                     funding_context.id
               and funding_consent.consent_fingerprint =
                     operation.support_metadata ->>
                       'telegramFundingConsentFingerprint'
             where receipt_row.id::text =
                     operation.support_metadata ->> 'fundingReceiveReceiptId'
               and receipt_row.child_funding_operation_id = operation.id
               and receipt_row.user_id = operation.user_id
               and receipt_row.status = 'routing'
               and operation.requested_source_amount ->> 'raw' =
                     receipt_row.raw_amount::text
          )
          or exists (
            select 1
              from telegram_trade_intents trade_intent
             where trade_intent.id::text =
                     operation.support_metadata ->> 'telegramTradeIntentId'
               and trade_intent.user_id = operation.user_id
               and trade_intent.funding_operation_id = operation.id
               and trade_intent.status = 'funding'
               and trade_intent.submit_started_at is null
               and operation.support_metadata ->> 'delegatedOriginKind' =
                     'trade_shortfall_intent'
          )
        )
        and not exists (
          select 1
          from funding_operation_step_attempts attempt
          where attempt.step_id = step.id
        )
      order by operation.created_at asc, step.ordinal asc
      for update of operation, step, funding_authorization skip locked
      limit 1
    `,
    [POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID],
  );
  const row = rows[0];
  if (!row) return null;

  const rejectClaim = async (
    reasonCode:
      | "delegated_action_invalid"
      | "delegated_authority_invalid"
      | "funding_policy_changed",
  ): Promise<DelegatedFundingProfileClaim | null> => {
    const attempt = await tryStartDelegatedFundingRejection(
      client,
      row,
      input.now,
    );
    if (!attempt) return null;
    await finishDelegatedFundingNonbroadcastFailure(client, {
      userId: row.user_id,
      operationId: row.operation_id,
      stepId: row.step_id,
      attemptId: attempt.id,
      reasonCode,
      now: input.now,
    });
    return { kind: "rejected", operationId: row.operation_id };
  };

  const parsed = normalizedActionSchema.safeParse(row.normalized_action);
  const action = parsed.success ? (parsed.data as NormalizedAction) : null;
  if (!action || canonicalJsonHash(action) !== row.action_fingerprint) {
    return rejectClaim("delegated_action_invalid");
  }
  let currentAuthorizationFingerprint: string;
  try {
    currentAuthorizationFingerprint = telegramFundingAuthorizationFingerprint(
      telegramFundingAuthorizationFromRow({
        ...row,
        id: row.authorization_id,
      }),
    );
  } catch {
    return rejectClaim("delegated_authority_invalid");
  }
  if (currentAuthorizationFingerprint !== row.authorization_fingerprint) {
    return rejectClaim("delegated_authority_invalid");
  }
  const expectedActionWalletId = actionWalletId(row);
  try {
    validatePolymarketDepositUsdceWrapAction({
      action,
      expectedRaw: row.receipt_raw,
      routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
      walletId: expectedActionWalletId,
    });
  } catch {
    return rejectClaim("delegated_action_invalid");
  }
  if (
    Number(row.policy_version) !== input.policy.runtime.contractVersion ||
    (row.policy_revision !== input.policy.revision &&
      !fundingPolicyRevisionMayResume(input.policy))
  ) {
    return rejectClaim("funding_policy_changed");
  }
  try {
    await lockFundingControllerWallet(
      client,
      row.user_id,
      delegatedControllerProfile(row, expectedActionWalletId),
    );
  } catch (error) {
    if (
      error instanceof FundingPersistenceError &&
      error.code === "quote_invalidated"
    ) {
      return rejectClaim("delegated_authority_invalid");
    }
    throw error;
  }
  const attempt = await tryStartDelegatedFundingAttempt(client, row);
  if (!attempt) return null;
  return {
    kind: "execution",
    claim: executionClaimFromRow(row, {
      action,
      actionWalletId: expectedActionWalletId,
      attemptId: attempt.id,
      broadcastBoundaryCrossed: false,
    }),
  };
}

async function recoverPolymarketWrapInTransaction(
  client: PoolClient,
  input: Readonly<{
    recoverProviderReplayBefore: Date;
    recoverUnbroadcastRetryBefore: Date;
    now: Date;
  }>,
): Promise<DelegatedFundingRecoveryClaim | null> {
  const { rows } = await client.query<
    Omit<ClaimRow, "telegram_account_id"> & {
      attempt_id: string;
      attempt_outcome: "started" | "ambiguous";
      telegram_account_id: string | null;
    }
  >(
    `
      select
        attempt.id as attempt_id,
        attempt.outcome as attempt_outcome,
        operation.id as operation_id,
        operation.user_id,
        operation.policy_version,
        operation.policy_revision,
        operation.support_metadata ->> 'fundingAuthorizationId' as authorization_id,
        operation.support_metadata ->> 'fundingAuthorizationFingerprint' as authorization_fingerprint,
        step.id as step_id,
        step.action_fingerprint,
        step.action_validation_result,
        step.executor_id,
        step.normalized_action,
        step.payer_requirement,
        operation.requested_source_amount ->> 'raw' as receipt_raw,
        funding_authorization.telegram_account_id,
        funding_authorization.telegram_user_id,
        funding_authorization.user_wallet_id,
        funding_authorization.privy_wallet_id,
        funding_authorization.wallet_address,
        funding_authorization.wallet_chain,
        funding_authorization.profile_id,
        funding_authorization.security_class,
        funding_authorization.max_source_raw::text,
        funding_authorization.signer_id,
        funding_authorization.signer_fingerprint,
        funding_authorization.policy_id,
        funding_authorization.policy_fingerprint,
        funding_authorization.venue_id,
        funding_authorization.destination_option_id,
        funding_authorization.venue_binding_option_id,
        funding_authorization.source_network_id,
        funding_authorization.source_asset_id,
        funding_authorization.source_asset_decimals,
        funding_authorization.destination_network_id,
        funding_authorization.destination_asset_id,
        funding_authorization.destination_asset_decimals,
        funding_authorization.granted_at,
        funding_authorization.expires_at
      from funding_operation_step_attempts attempt
      join funding_operation_steps step on step.id = attempt.step_id
      join funding_operations operation on operation.id = step.operation_id
      join telegram_funding_authorizations funding_authorization
        on funding_authorization.id::text =
             operation.support_metadata ->> 'fundingAuthorizationId'
       and funding_authorization.user_id = operation.user_id
      where attempt.executor_id = $1
        and (
          (
            attempt.outcome = 'started'
            and step.state = 'action_required'
          )
          or (
            attempt.outcome = 'ambiguous'
            and attempt.reference_kind = 'provider_receipt'
            and (
              step.state = 'reconcile_required'
              or (
                step.state = 'recovery_required'
                and operation.status = 'recovery_required'
                and operation.recovery_mode = 'automatic_evidence'
              )
            )
          )
        )
        and attempt.updated_at <= case
              when attempt.outcome = 'started' then $2::timestamptz
              else $3::timestamptz
            end
        and step.executor_id = $1
        and operation.requested_source_amount ->> 'raw' ~ '^[1-9][0-9]*$'
        and (
          attempt.outcome = 'ambiguous'
          or exists (
            select 1
              from funding_receive_receipts receipt_row
              join telegram_funding_sessions funding_context
                on funding_context.receive_session_id =
                     receipt_row.receive_session_id
               and funding_context.user_id = operation.user_id
              join telegram_funding_consents funding_consent
                on funding_consent.id::text =
                     operation.support_metadata ->> 'telegramFundingConsentId'
               and funding_consent.telegram_funding_session_id =
                     funding_context.id
               and funding_consent.consent_fingerprint =
                     operation.support_metadata ->>
                       'telegramFundingConsentFingerprint'
             where receipt_row.id::text =
                     operation.support_metadata ->> 'fundingReceiveReceiptId'
               and receipt_row.child_funding_operation_id = operation.id
               and receipt_row.user_id = operation.user_id
               and receipt_row.status = 'routing'
               and operation.requested_source_amount ->> 'raw' =
                     receipt_row.raw_amount::text
          )
          or exists (
            select 1
              from telegram_trade_intents trade_intent
             where trade_intent.id::text =
                     operation.support_metadata ->> 'telegramTradeIntentId'
               and trade_intent.user_id = operation.user_id
               and trade_intent.funding_operation_id = operation.id
               and trade_intent.status = 'funding'
               and trade_intent.submit_started_at is null
               and operation.support_metadata ->> 'delegatedOriginKind' =
                     'trade_shortfall_intent'
          )
        )
        and operation.status not in (
          'completed', 'refunded', 'failed', 'cancelled'
        )
      order by attempt.updated_at asc, attempt.id asc
      for update of attempt, step, operation skip locked
      limit 1
    `,
    [
      POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
      input.recoverUnbroadcastRetryBefore,
      input.recoverProviderReplayBefore,
    ],
  );
  const row = rows[0];
  if (!row) return null;
  const leased = await client.query(
    `
      update funding_operation_step_attempts
      set updated_at = $2
      where id = $1
        and outcome in ('started', 'ambiguous')
        and updated_at <= $3
    `,
    [
      row.attempt_id,
      input.now,
      row.attempt_outcome === "started"
        ? input.recoverUnbroadcastRetryBefore
        : input.recoverProviderReplayBefore,
    ],
  );
  if (leased.rowCount !== 1) {
    throw new Error("delegated funding recovery lease was lost");
  }
  const parsed = normalizedActionSchema.safeParse(row.normalized_action);
  const action = parsed.success ? (parsed.data as NormalizedAction) : null;
  if (!action || canonicalJsonHash(action) !== row.action_fingerprint) {
    throw new Error("delegated funding recovery action is invalid");
  }
  const expectedActionWalletId = actionWalletId(row);
  validatePolymarketDepositUsdceWrapAction({
    action,
    expectedRaw: row.receipt_raw,
    routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
    walletId: expectedActionWalletId,
  });
  return executionClaimFromRow(row, {
    action,
    actionWalletId: expectedActionWalletId,
    attemptId: row.attempt_id,
    broadcastBoundaryCrossed: row.attempt_outcome === "ambiguous",
  });
}

export type DelegatedFundingExecutorBatchResult = Readonly<{
  providerLookups: number;
  providerReferencesResolved: number;
  claimed: number;
  recovered: number;
  softPaused: number;
  submitted: number;
  alreadySatisfied: number;
  ambiguous: number;
  definitivelyFailed: number;
  expiredWithoutBroadcast: number;
  pending: number;
  operationIds: readonly string[];
}>;

type DelegatedFundingProviderLookupRow = Readonly<{
  action_fingerprint: string;
  attempt_id: string;
  normalized_action: JsonRecord;
  operation_id: string;
  profile_id: string;
  provider_reference_lookup_hmac: string;
  step_id: string;
  user_id: string;
}>;

async function listDelegatedFundingProviderLookupClaims(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    limit: number;
    lookupDueBefore: Date;
    profileIds: readonly string[];
  }>,
): Promise<readonly DelegatedFundingProviderLookupRow[]> {
  if (input.profileIds.length === 0) return [];
  const { rows } = await pool.query<DelegatedFundingProviderLookupRow>(
    `
      select
        attempt_row.id as attempt_id,
        attempt_row.receipt_ref_lookup_hmac
          as provider_reference_lookup_hmac,
        step_row.id as step_id,
        step_row.operation_id,
        step_row.executor_id as profile_id,
        step_row.action_fingerprint,
        step_row.normalized_action,
        operation_row.user_id
      from funding_operation_step_attempts attempt_row
      join funding_operation_steps step_row
        on step_row.id = attempt_row.step_id
       and step_row.executor_id = attempt_row.executor_id
      join funding_operations operation_row
        on operation_row.id = step_row.operation_id
      where step_row.executor_id = any($1::text[])
        and attempt_row.outcome = 'ambiguous'
        and attempt_row.broadcast_may_have_occurred
        and attempt_row.reference_kind = 'provider_receipt'
        and attempt_row.receipt_ref_ciphertext is not null
        and attempt_row.receipt_ref_lookup_hmac is not null
        and attempt_row.lookup_key_version is not null
        and attempt_row.finished_at is not null
        and attempt_row.finished_at <= $2
        and attempt_row.canonical_action_fingerprint =
              step_row.action_fingerprint
        and step_row.state in ('reconcile_required', 'recovery_required')
        and operation_row.status not in (
              'completed', 'refunded', 'failed', 'cancelled'
            )
      order by attempt_row.finished_at, attempt_row.id
      limit $3
    `,
    [input.profileIds, input.lookupDueBefore, input.limit],
  );
  return rows;
}

export function delegatedFundingProfileOrder<T>(
  profiles: readonly T[],
  startIndex: number,
): readonly T[] {
  if (profiles.length < 2) return profiles;
  const normalized =
    ((Math.trunc(startIndex) % profiles.length) + profiles.length) %
    profiles.length;
  return [...profiles.slice(normalized), ...profiles.slice(0, normalized)];
}

async function polymarketWrapPreBroadcastDecisionInTransaction(
  client: PoolClient,
  input: Readonly<{
    claim: DelegatedFundingExecutionClaim;
    configuration: PolymarketWrapExecutionConfiguration;
    now: Date;
  }>,
): Promise<DelegatedFundingPreBroadcastDecision> {
  await lockTelegramFundingLinkLifecycle(client, input.claim.userId);
  await lockFundingPolicyForTransaction(client);
  const policy = await resolveFundingPolicy(client);
  const controlDecision = classifyPolymarketWrapControlPlane({
    configuration: input.configuration,
    policy,
  });
  const environmentDecision: DelegatedFundingPreBroadcastDecision =
    polymarketWrapExecutorEnvironmentReady()
      ? { kind: "allowed" }
      : {
          kind: "soft_paused",
          reasonCode: "delegated_profile_unavailable",
        };
  const scope = await client.query<{
    action_fingerprint: string;
    normalized_action: JsonRecord;
    policy_revision: string;
    policy_version: string | number;
    receipt_raw: string;
    action_expires_at: Date | null;
    checked_at: Date;
  }>(
    `
      select
        operation.policy_revision,
        operation.policy_version,
        step.action_expires_at,
        clock_timestamp() as checked_at,
        step.action_fingerprint,
        step.normalized_action,
        operation.requested_source_amount ->> 'raw' as receipt_raw
      from funding_operation_step_attempts attempt
      join funding_operation_steps step on step.id = attempt.step_id
      join funding_operations operation on operation.id = step.operation_id
      where operation.id = $1
        and operation.user_id = $2
        and operation.support_metadata ->> 'fundingAuthorizationId' = $3
        and operation.support_metadata ->> 'fundingAuthorizationFingerprint' = $4
        and step.id = $5
        and step.executor_id = $6
        and step.state = 'action_required'
        and attempt.id = $7
        and attempt.outcome = 'started'
        and attempt.canonical_action_fingerprint = step.action_fingerprint
        and operation.requested_source_amount ->> 'raw' ~ '^[1-9][0-9]*$'
        and (
          exists (
            select 1
              from funding_receive_receipts receipt_row
              join telegram_funding_sessions funding_context
                on funding_context.receive_session_id =
                     receipt_row.receive_session_id
               and funding_context.user_id = operation.user_id
              join telegram_funding_consents funding_consent
                on funding_consent.id::text =
                     operation.support_metadata ->> 'telegramFundingConsentId'
               and funding_consent.telegram_funding_session_id =
                     funding_context.id
               and funding_consent.consent_fingerprint =
                     operation.support_metadata ->>
                       'telegramFundingConsentFingerprint'
             where receipt_row.id::text =
                     operation.support_metadata ->> 'fundingReceiveReceiptId'
               and receipt_row.child_funding_operation_id = operation.id
               and receipt_row.user_id = operation.user_id
               and receipt_row.status = 'routing'
               and operation.requested_source_amount ->> 'raw' =
                     receipt_row.raw_amount::text
          )
          or exists (
            select 1
              from telegram_trade_intents trade_intent
             where trade_intent.id::text =
                     operation.support_metadata ->> 'telegramTradeIntentId'
               and trade_intent.user_id = operation.user_id
               and trade_intent.funding_operation_id = operation.id
               and trade_intent.status = 'funding'
               and trade_intent.submit_started_at is null
               and operation.support_metadata ->> 'delegatedOriginKind' =
                     'trade_shortfall_intent'
          )
        )
      for update of operation, step, attempt
    `,
    [
      input.claim.operationId,
      input.claim.userId,
      input.claim.authorizationId,
      input.claim.authorizationFingerprint,
      input.claim.stepId,
      input.claim.profileId,
      input.claim.attemptId,
    ],
  );
  const row = scope.rows[0];
  if (!row) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_action_invalid",
    };
  }
  if (Number(row.policy_version) !== policy.runtime.contractVersion) {
    return {
      kind: "hard_invalid",
      reasonCode: "funding_runtime_contract_changed",
    };
  }
  if (
    row.action_expires_at !== null &&
    row.action_expires_at <= row.checked_at
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_quote_expired",
    };
  }
  if (
    row.policy_revision !== policy.revision &&
    !fundingPolicyRevisionMayResume(policy)
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "funding_policy_changed",
    };
  }
  const parsed = normalizedActionSchema.safeParse(row.normalized_action);
  const action = parsed.success ? (parsed.data as NormalizedAction) : null;
  try {
    if (
      !action ||
      canonicalJsonHash(action) !== row.action_fingerprint ||
      row.action_fingerprint !== input.claim.actionFingerprint
    ) {
      throw new Error("delegated action fingerprint changed");
    }
    validatePolymarketDepositUsdceWrapAction({
      action,
      expectedRaw: row.receipt_raw,
      routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
      walletId: input.claim.actionWalletId,
    });
  } catch {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_action_invalid",
    };
  }
  const authority = input.claim.telegramAccountId
    ? await resolveCurrentTelegramFundingAuthority(client, {
        userId: input.claim.userId,
        telegramAccountId: input.claim.telegramAccountId,
        telegramUserId: input.claim.telegramUserId,
        destinationOptionId: input.claim.destinationOptionId,
        venueBindingOptionId: input.claim.venueBindingOptionId,
        configuration: input.configuration,
        expectedAuthorizationId: input.claim.authorizationId,
        expectedAuthorizationFingerprint: input.claim.authorizationFingerprint,
        now: row.checked_at,
        lock: true,
      })
    : ({
        kind: "hard_invalid",
        reasonCode: "delegated_authority_invalid",
      } as const);
  const decision = combineDelegatedFundingDecisions(
    controlDecision,
    environmentDecision,
    authority.kind === "allowed" ? { kind: "allowed" } : authority,
  );
  if (decision.kind !== "allowed") return decision;
  const boundaryClock = await client.query<{ now: Date }>(
    "select clock_timestamp() as now",
  );
  const boundaryNow = boundaryClock.rows[0]?.now;
  if (
    !boundaryNow ||
    (row.action_expires_at !== null && row.action_expires_at <= boundaryNow)
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_quote_expired",
    };
  }
  return decision;
}

export function createPolymarketWrapDelegatedFundingProfile(
  input: Readonly<{
    configuration: PolymarketWrapExecutionConfiguration;
    driver: DelegatedFundingNetworkDriver;
  }>,
): DelegatedFundingRuntimeProfile {
  return {
    profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    controlPlaneDecision: (policy) =>
      classifyPolymarketWrapControlPlane({
        configuration: input.configuration,
        policy,
      }),
    rejectInvalidInTransaction: (client, rejectionInput) =>
      rejectInvalidPolymarketWrapInTransaction(client, {
        configuration: input.configuration,
        ...rejectionInput,
      }),
    claimInTransaction: (client, claimInput) =>
      claimPolymarketWrapInTransaction(client, {
        ...claimInput,
      }),
    recoverInTransaction: (client, recoveryInput) =>
      recoverPolymarketWrapInTransaction(client, recoveryInput),
    preBroadcastDecisionInTransaction: (client, boundaryInput) =>
      polymarketWrapPreBroadcastDecisionInTransaction(client, {
        configuration: input.configuration,
        ...boundaryInput,
      }),
    driver: input.driver,
    validateSubmittedReference: (reference) =>
      /^0x[0-9a-f]{64}$/i.test(reference),
  };
}

export class DelegatedFundingExecutor {
  private nextProfileIndex = 0;

  constructor(
    private readonly pool: Pool,
    private readonly input: Readonly<{
      profiles: readonly DelegatedFundingRuntimeProfile[];
      referenceCodec: FundingTransactionReferenceCodec;
      providerLookupDelayMs?: number;
      providerReplayMs?: number;
      unbroadcastRetryMs?: number;
    }>,
  ) {
    const seen = new Set<string>();
    for (const runtime of input.profiles) {
      if (!delegatedFundingProfile(runtime.profileId)) {
        throw new Error(
          `unknown delegated funding profile ${runtime.profileId}`,
        );
      }
      if (seen.has(runtime.profileId)) {
        throw new Error(
          `duplicate delegated funding profile ${runtime.profileId}`,
        );
      }
      seen.add(runtime.profileId);
    }
  }

  private async lookupProviderReferences(
    input: Readonly<{
      limit: number;
      now: Date;
      profiles: readonly DelegatedFundingRuntimeProfile[];
    }>,
  ): Promise<
    Readonly<{
      operationIds: readonly string[];
      providerLookups: number;
      providerReferencesResolved: number;
    }>
  > {
    const profileById = new Map(
      input.profiles.map((profile) => [profile.profileId, profile]),
    );
    const lookupDelayMs = Math.max(
      1,
      this.input.providerLookupDelayMs ?? DELEGATED_PROVIDER_LOOKUP_DELAY_MS,
    );
    const rows = await listDelegatedFundingProviderLookupClaims(this.pool, {
      limit: input.limit,
      lookupDueBefore: new Date(input.now.getTime() - lookupDelayMs),
      profileIds: [...profileById.keys()],
    });
    let providerLookups = 0;
    let providerReferencesResolved = 0;
    const operationIds: string[] = [];
    await Promise.all(
      rows.map(async (row) => {
        const runtime = profileById.get(row.profile_id);
        const parsed = normalizedActionSchema.safeParse(row.normalized_action);
        if (
          !runtime ||
          !parsed.success ||
          canonicalJsonHash(parsed.data) !== row.action_fingerprint
        ) {
          return;
        }
        const providerReferenceLookupHmac =
          this.input.referenceCodec.fingerprint(row.attempt_id);
        if (
          providerReferenceLookupHmac !== row.provider_reference_lookup_hmac
        ) {
          return;
        }
        providerLookups += 1;
        let lookup: DelegatedFundingProviderLookupResult;
        try {
          lookup = await runtime.driver.lookupProviderReference({
            action: parsed.data as NormalizedAction,
            attemptId: row.attempt_id,
            operationId: row.operation_id,
            profileId: row.profile_id,
            stepId: row.step_id,
            userId: row.user_id,
          });
        } catch {
          return;
        }
        if (lookup.kind !== "submitted") return;
        const transactionReference = lookup.transactionReference.trim();
        if (!runtime.validateSubmittedReference(transactionReference)) return;
        try {
          await tx(this.pool, (client) =>
            resolveAmbiguousProviderFundingStepAttemptForUserInTransaction(
              client,
              {
                userId: row.user_id,
                operationId: row.operation_id,
                stepId: row.step_id,
                attemptId: row.attempt_id,
                providerReferenceLookupHmac,
                resolution: {
                  kind: "transaction",
                  receiptRefCiphertext:
                    this.input.referenceCodec.encrypt(transactionReference),
                  receiptRefLookupHmac:
                    this.input.referenceCodec.fingerprint(transactionReference),
                  lookupKeyVersion: this.input.referenceCodec.keyVersion,
                },
                now: input.now,
              },
            ),
          );
        } catch (error) {
          if (
            error instanceof FundingPersistenceError &&
            error.code === "invalid_state_transition"
          ) {
            return;
          }
          throw error;
        }
        providerReferencesResolved += 1;
        operationIds.push(row.operation_id);
      }),
    );
    return {
      operationIds,
      providerLookups,
      providerReferencesResolved,
    };
  }

  async runBatch(options: Readonly<{ limit?: number; now?: Date }> = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const profiles = delegatedFundingProfileOrder(
      this.input.profiles,
      this.nextProfileIndex,
    );
    const batchNow = options.now ?? new Date();
    const providerLookup = await this.lookupProviderReferences({
      limit,
      now: batchNow,
      profiles,
    });
    const result = {
      providerLookups: providerLookup.providerLookups,
      providerReferencesResolved: providerLookup.providerReferencesResolved,
      claimed: 0,
      recovered: 0,
      softPaused: 0,
      submitted: 0,
      alreadySatisfied: 0,
      ambiguous: 0,
      definitivelyFailed: 0,
      expiredWithoutBroadcast: 0,
      pending: 0,
      operationIds: [...providerLookup.operationIds],
    };
    const exhausted = new Set<string>();
    while (
      result.claimed + result.expiredWithoutBroadcast < limit &&
      exhausted.size < profiles.length
    ) {
      for (const runtime of profiles) {
        if (
          result.claimed + result.expiredWithoutBroadcast >= limit ||
          exhausted.has(runtime.profileId)
        ) {
          continue;
        }
        const now = options.now ?? new Date();
        const providerReplayMs = Math.max(
          1,
          this.input.providerReplayMs ?? DELEGATED_PROVIDER_REPLAY_MS,
        );
        const unbroadcastRetryMs = Math.max(
          1,
          this.input.unbroadcastRetryMs ?? DELEGATED_UNBROADCAST_RETRY_MS,
        );
        const recovery = await tx(this.pool, (client) =>
          runtime.recoverInTransaction(client, {
            now,
            recoverProviderReplayBefore: new Date(
              now.getTime() - providerReplayMs,
            ),
            recoverUnbroadcastRetryBefore: new Date(
              now.getTime() - unbroadcastRetryMs,
            ),
          }),
        );
        let claimObservation: JsonRecord | undefined;
        if (!recovery && runtime.observeBeforeClaim) {
          try {
            claimObservation = await runtime.observeBeforeClaim(this.pool, {
              now,
            });
          } catch {
            // A maintenance observation is never authority to broadcast. The
            // later pre-broadcast fence will require fresh evidence before
            // sending anything. Continue with no observation so a purely
            // local terminal transition (for example an expired, unstarted
            // action) is not held hostage by an RPC outage.
            result.pending += 1;
          }
        }
        const claimed = recovery
          ? { kind: "recovery" as const, claim: recovery }
          : await tx(this.pool, async (client) => {
              await lockFundingPolicyForTransaction(client);
              const currentPolicy = await resolveFundingPolicy(client);
              const controlDecision =
                runtime.controlPlaneDecision(currentPolicy);
              const rejected = await runtime.rejectInvalidInTransaction(
                client,
                {
                  controlDecision,
                  now,
                },
              );
              if (rejected) {
                return { kind: "rejected" as const, ...rejected };
              }
              const claim = await runtime.claimInTransaction(client, {
                policy: currentPolicy,
                now,
                ...(claimObservation ? { observation: claimObservation } : {}),
              });
              return claim;
            });
        if (!claimed) {
          exhausted.add(runtime.profileId);
          continue;
        }
        const claimedProfileIndex = this.input.profiles.indexOf(runtime);
        this.nextProfileIndex =
          claimedProfileIndex < 0
            ? 0
            : (claimedProfileIndex + 1) % this.input.profiles.length;
        if (claimed.kind === "expired_without_broadcast") {
          result.expiredWithoutBroadcast += 1;
          result.operationIds.push(claimed.operationId);
          continue;
        }
        result.claimed += 1;
        if (claimed.kind === "rejected") {
          result.definitivelyFailed += 1;
          result.operationIds.push(claimed.operationId);
          continue;
        }
        const { claim } = claimed;
        if (claimed.kind === "recovery") result.recovered += 1;
        result.operationIds.push(claim.operationId);
        const providerReferenceLookupHmac =
          this.input.referenceCodec.fingerprint(claim.attemptId);
        let preBroadcastObservation: JsonRecord | undefined;
        if (!claim.broadcastBoundaryCrossed && runtime.observePreBroadcast) {
          try {
            preBroadcastObservation = await runtime.observePreBroadcast(claim);
          } catch {
            // The attempt remains durably started and is recoverable. No
            // broadcast boundary has been crossed, so failing closed here can
            // never authorize a duplicate submission.
            result.pending += 1;
            continue;
          }
        }
        const boundaryDecision = claim.broadcastBoundaryCrossed
          ? ({ kind: "reconciliation_only" } as const)
          : await tx(this.pool, async (client) => {
              const decision = await runtime.preBroadcastDecisionInTransaction(
                client,
                {
                  claim,
                  now,
                  ...(preBroadcastObservation
                    ? { observation: preBroadcastObservation }
                    : {}),
                },
              );
              if (decision.kind === "soft_paused") return decision;
              if (decision.kind === "hard_invalid") {
                await finishDelegatedFundingNonbroadcastFailure(client, {
                  userId: claim.userId,
                  operationId: claim.operationId,
                  stepId: claim.stepId,
                  attemptId: claim.attemptId,
                  reasonCode: decision.reasonCode,
                  ...(decision.diagnosticCode
                    ? { diagnosticCode: decision.diagnosticCode }
                    : {}),
                  now,
                });
                if (runtime.finalizeHardInvalidInTransaction) {
                  await runtime.finalizeHardInvalidInTransaction(client, {
                    claim,
                    now,
                    reasonCode: decision.reasonCode,
                    ...(preBroadcastObservation
                      ? { observation: preBroadcastObservation }
                      : {}),
                  });
                }
                return decision;
              }
              if (decision.kind === "already_satisfied") {
                if (!runtime.finalizeAlreadySatisfiedInTransaction) {
                  throw new Error(
                    `profile ${runtime.profileId} cannot finalize an already-satisfied action`,
                  );
                }
                await runtime.finalizeAlreadySatisfiedInTransaction(client, {
                  claim,
                  now,
                  ...(preBroadcastObservation
                    ? { observation: preBroadcastObservation }
                    : {}),
                });
                return decision;
              }
              await finishFundingStepAttemptForUserInTransaction(client, {
                userId: claim.userId,
                operationId: claim.operationId,
                stepId: claim.stepId,
                attemptId: claim.attemptId,
                outcome: "ambiguous",
                broadcastMayHaveOccurred: true,
                referenceKind: "provider_receipt",
                receiptRefCiphertext: this.input.referenceCodec.encrypt(
                  claim.attemptId,
                ),
                receiptRefLookupHmac: providerReferenceLookupHmac,
                lookupKeyVersion: this.input.referenceCodec.keyVersion,
                actualCosts: {
                  providerReferenceKind: "privy_reference_id",
                },
                now,
              });
              return decision;
            });
        if (boundaryDecision.kind === "soft_paused") {
          result.softPaused += 1;
          result.pending += 1;
          continue;
        }
        if (boundaryDecision.kind === "hard_invalid") {
          result.definitivelyFailed += 1;
          continue;
        }
        if (boundaryDecision.kind === "already_satisfied") {
          result.alreadySatisfied += 1;
          continue;
        }
        const executionClaim = claim.broadcastBoundaryCrossed
          ? claim
          : { ...claim, broadcastBoundaryCrossed: true };
        let execution: DelegatedFundingExecutionResult;
        try {
          execution =
            claimed.kind === "recovery" && claim.broadcastBoundaryCrossed
              ? await runtime.driver.recover(executionClaim)
              : await runtime.driver.execute(executionClaim);
        } catch {
          execution = { kind: "ambiguous" };
        }
        if (execution.kind === "pending" || execution.kind === "ambiguous") {
          result.pending += 1;
          result.ambiguous += 1;
          continue;
        }
        let resolution:
          | Readonly<{
              kind: "transaction";
              receiptRefCiphertext: string;
              receiptRefLookupHmac: string;
              lookupKeyVersion: number;
            }>
          | Readonly<{
              kind: "definitive_failure";
              actualCosts: JsonRecord;
            }>
          | null;
        if (execution.kind === "submitted") {
          const transactionReference = execution.transactionReference.trim();
          resolution =
            transactionReference &&
            runtime.validateSubmittedReference(transactionReference)
              ? {
                  kind: "transaction",
                  receiptRefCiphertext:
                    this.input.referenceCodec.encrypt(transactionReference),
                  receiptRefLookupHmac:
                    this.input.referenceCodec.fingerprint(transactionReference),
                  lookupKeyVersion: this.input.referenceCodec.keyVersion,
                }
              : null;
        } else {
          resolution = {
            kind: "definitive_failure",
            actualCosts: { reasonCode: execution.reasonCode },
          };
        }
        if (!resolution) {
          result.pending += 1;
          result.ambiguous += 1;
          continue;
        }
        await tx(this.pool, (client) =>
          resolveAmbiguousProviderFundingStepAttemptForUserInTransaction(
            client,
            {
              userId: claim.userId,
              operationId: claim.operationId,
              stepId: claim.stepId,
              attemptId: claim.attemptId,
              providerReferenceLookupHmac,
              retryableDefinitiveFailure:
                claim.actionValidationResult.relayStepKind === "cleanup",
              resolution,
              now,
            },
          ),
        );
        if (execution.kind === "submitted") result.submitted += 1;
        else result.definitivelyFailed += 1;
      }
    }
    return result satisfies DelegatedFundingExecutorBatchResult;
  }
}
