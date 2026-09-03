import { randomBytes } from "node:crypto";

import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { Interface } from "ethers";

import type {
  AssetRef,
  JsonValue,
  WalletExecutionProfile,
} from "../domain/types.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import { sameAsset } from "../domain/asset-identity.js";
import {
  loadPolymarketPusdFundExecutionConfiguration,
  polymarketRouterExecutionConfigurationReady,
} from "../execution/delegated-funding-config.js";
import { POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID } from "../execution/delegated-funding-profile-ids.js";
import {
  telegramFundingAuthorizationFingerprint,
  telegramFundingAuthorizationFromRow,
  type TelegramFundingAuthorization,
  type TelegramFundingAuthorizationRow,
} from "../execution/telegram-funding-authorization.js";
import { activateTelegramTradeShortfallInitialStepInTransaction } from "../execution/telegram-trade-shortfall-activation.js";
import {
  canonicalJsonHash,
  fundingSubjectLookupHmac,
} from "../persistence/canonical.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  releaseFundingReservationInTransaction,
  transitionFundingOperationInTransaction,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import {
  buildPolymarketControllerApprovalActionValidation,
  buildPolymarketFundingActionValidation,
  buildPolymarketFundingFollowupAction,
} from "../preparation/polymarket-funding-followup.js";
import { inspectPolymarketDepositWallet } from "../../services/polymarket-deposit-wallet-derivation.js";
import {
  buildPolymarketFundingPlan,
  POLYMARKET_FUNDING_ROUTER_ABI,
} from "../../services/polymarket-funding-router.js";
import {
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchEvmCall,
} from "../../services/polygon-rpc.js";
import { POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW } from "../../services/polymarket-automation-policy.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  isTelegramRouterContinuationHardReason,
  telegramPolymarketRootRequiresRouterContinuationSql,
} from "./telegram-router-continuation-state.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const fundingRouterInterface = new Interface(POLYMARKET_FUNDING_ROUTER_ABI);
const erc20Interface = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

const ROUTER_CONTINUATION_HARD_FAILURE_LIMIT = 3;

type CandidateRow = TelegramFundingAuthorizationRow &
  Readonly<{
    root_operation_id: string;
    root_amount: unknown;
    market_context_snapshot: JsonRecord | null;
    market_id: string | null;
    trade_intent_id: string;
    user_id: string;
    funding_authorization_id: string | null;
  }>;

type ExactRootAmount = Readonly<{ asset: AssetRef; raw: string }>;

type LiveRouterFacts =
  | Readonly<{
      kind: "ready";
      allowanceRaw: bigint;
      controllerPusdRaw: bigint;
      depositPusdRaw: bigint;
      depositWallet: string;
      nonce: bigint;
    }>
  | Readonly<{ kind: "source_balance_insufficient" }>
  | Readonly<{ kind: "polygon_rpc_unavailable" }>
  | Readonly<{ kind: "deposit_wallet_unavailable" }>;

function jsonRecord(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function readAsset(value: unknown): AssetRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asset = value as Record<string, unknown>;
  return typeof asset.networkId === "string" &&
    typeof asset.assetId === "string" &&
    Number.isInteger(asset.decimals) &&
    typeof asset.decimals === "number"
    ? {
        networkId: asset.networkId,
        assetId: asset.assetId,
        decimals: asset.decimals,
      }
    : null;
}

function readExactRootAmount(row: CandidateRow): ExactRootAmount | null {
  const raw =
    typeof row.root_amount === "object" && row.root_amount !== null
      ? (row.root_amount as Record<string, unknown>).raw
      : null;
  const asset =
    typeof row.root_amount === "object" && row.root_amount !== null
      ? readAsset((row.root_amount as Record<string, unknown>).asset)
      : null;
  return isPositiveRawAmount(raw) && asset ? { asset, raw } : null;
}

function profileFor(
  authorization: TelegramFundingAuthorization,
): WalletExecutionProfile {
  return {
    walletId: authorization.userWalletId,
    controllerWalletRef: authorization.userWalletId,
    networkId: "evm:137",
    address: authorization.walletAddress,
    source: "embedded",
    signingModes: ["privy_authorization"],
    serverWalletRef: authorization.privyWalletId,
    sponsorshipPolicyIds: ["privy_user_authorized_evm_sponsorship_v1"],
    evmAtomicBatchMode: null,
  };
}

function bindingFor(
  authorization: TelegramFundingAuthorization,
  depositWallet: string,
) {
  const pUsd: AssetRef = {
    networkId: "evm:137",
    assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
    decimals: 6,
  };
  const bindingId = `binding_${canonicalJsonHash({
    userId: authorization.userId,
    venue: "polymarket",
    controller: authorization.walletAddress.toLowerCase(),
  }).slice(0, 32)}`;
  const locationId = `location_${canonicalJsonHash({ bindingId, asset: pUsd }).slice(0, 32)}`;
  return {
    bindingId,
    venueId: "polymarket" as const,
    controllerWalletId: authorization.userWalletId,
    executionWalletId: authorization.userWalletId,
    accountRef: depositWallet,
    settlementLocation: {
      kind: "venue_account" as const,
      locationId,
      accountId: authorization.userId,
      asset: pUsd,
      details: {
        venueId: "polymarket",
        accountRef: depositWallet,
        controllerWalletId: authorization.userWalletId,
        address: depositWallet,
      },
    },
    signingMode: "privy_authorization" as const,
  };
}

async function routerNonce(
  input: Readonly<{ signerAddress: string }>,
): Promise<bigint> {
  const result = await fetchEvmCall({
    rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
    timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
    to: POLYMARKET_FUNDING_ROUTER.polygon,
    data: fundingRouterInterface.encodeFunctionData("fundingNonce", [
      input.signerAddress,
    ]),
  });
  const decoded = fundingRouterInterface.decodeFunctionResult(
    "fundingNonce",
    result,
  ) as unknown;
  const nonce = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof nonce !== "bigint") throw new Error("Router nonce is unavailable");
  return nonce;
}

async function loadLiveRouterFacts(
  input: Readonly<{
    authorization: TelegramFundingAuthorization;
    amount: ExactRootAmount;
  }>,
): Promise<LiveRouterFacts> {
  let deposit;
  try {
    deposit = await inspectPolymarketDepositWallet({
      owner: input.authorization.walletAddress,
      rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
      timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
    });
  } catch {
    return { kind: "polygon_rpc_unavailable" };
  }
  if (!deposit.deployed) return { kind: "deposit_wallet_unavailable" };
  const depositWallet = deposit.address;
  const rpc = {
    rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
    timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
  };
  try {
    const [controllerPusdRaw, depositPusdRaw, allowanceRaw, nonce] =
      await Promise.all([
        fetchErc20BalanceOf({
          ...rpc,
          tokenAddress: fundingSidecarRuntimeConfig.polymarketPusdAddress,
          owner: input.authorization.walletAddress,
        }),
        fetchErc20BalanceOf({
          ...rpc,
          tokenAddress: fundingSidecarRuntimeConfig.polymarketPusdAddress,
          owner: depositWallet,
        }),
        fetchErc20Allowance({
          ...rpc,
          tokenAddress: fundingSidecarRuntimeConfig.polymarketPusdAddress,
          owner: input.authorization.walletAddress,
          spender: POLYMARKET_FUNDING_ROUTER.polygon,
        }),
        routerNonce({ signerAddress: input.authorization.walletAddress }),
      ]);
    if (controllerPusdRaw < BigInt(input.amount.raw)) {
      return { kind: "source_balance_insufficient" };
    }
    return {
      kind: "ready",
      allowanceRaw,
      controllerPusdRaw,
      depositPusdRaw,
      depositWallet,
      nonce,
    };
  } catch {
    return { kind: "polygon_rpc_unavailable" };
  }
}

function buildPlan(
  input: Readonly<{
    authorization: TelegramFundingAuthorization;
    rootOperationId: string;
    tradeIntentId: string;
    amount: ExactRootAmount;
    marketContextSnapshot: JsonRecord | null;
    marketId: string | null;
    live: Extract<LiveRouterFacts, { kind: "ready" }>;
    now: Date;
  }>,
): FundingCommitPlan {
  const live = input.live;
  const requiresApproval = live.allowanceRaw < BigInt(input.amount.raw);
  const plan = buildPolymarketFundingPlan({
    signer: input.authorization.walletAddress,
    depositWallet: live.depositWallet,
    routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
    routerNonce: live.nonce,
    requiredRaw: live.depositPusdRaw + BigInt(input.amount.raw),
    depositPusdRaw: live.depositPusdRaw,
    depositLockedRaw: live.depositPusdRaw,
    fundingCapRaw: BigInt(input.amount.raw),
    signerPusdRaw: live.controllerPusdRaw,
    signerLockedRaw: live.controllerPusdRaw - BigInt(input.amount.raw),
    signerUsdceRaw: 0n,
    routerPusdAllowanceRaw: requiresApproval
      ? POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW
      : live.allowanceRaw,
    routerUsdceAllowanceRaw: 0n,
  });
  if (
    !plan ||
    plan.pUsdAmountRaw !== input.amount.raw ||
    plan.usdceAmountRaw !== "0"
  ) {
    throw new Error("exact Router continuation plan is unavailable");
  }
  const binding = bindingFor(input.authorization, live.depositWallet);
  const operationIdentity = canonicalJsonHash({
    rootOperationId: input.rootOperationId,
    tradeIntentId: input.tradeIntentId,
    amount: input.amount,
    plan,
  });
  const fundAction = buildPolymarketFundingFollowupAction({
    binding,
    canonicalRouterAddress: POLYMARKET_FUNDING_ROUTER.polygon,
    inspectionRevision: operationIdentity,
    operationId: `telegram-trade-funding:${input.tradeIntentId}:router`,
    plan,
  });
  const profile = profileFor(input.authorization);
  const sponsorship = resolveActionSponsorship({ action: fundAction, profile });
  const approvalAction = {
    kind: "evm_transaction" as const,
    actionId: `action_${canonicalJsonHash({
      kind: "controller_pusd_router_approval",
      operationIdentity,
    }).slice(0, 32)}`,
    networkId: "evm:137",
    senderWalletId: input.authorization.userWalletId,
    to: fundingSidecarRuntimeConfig.polymarketPusdAddress,
    data: erc20Interface.encodeFunctionData("approve", [
      POLYMARKET_FUNDING_ROUTER.polygon,
      POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const approvalSponsorship = resolveActionSponsorship({
    action: approvalAction,
    profile,
  });
  const pUsd = input.amount.asset;
  const reservationExpiresAt = new Date(
    input.now.getTime() + FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  ).toISOString();
  const sourceLocationId = `location_${canonicalJsonHash({
    userId: input.authorization.userId,
    wallet: input.authorization.walletAddress.toLowerCase(),
    asset: pUsd,
  }).slice(0, 32)}`;
  return {
    operation: {
      purpose: "trade_shortfall",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "venue_preparation",
      sourceSnapshot: {
        kind: "venue_preparation",
        venueId: "polymarket",
        venueBindingId: binding.bindingId,
        inputCount: 1,
      },
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: binding.settlementLocation,
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: input.marketId,
      marketContextSnapshot: input.marketContextSnapshot,
      venueBindingSnapshot: jsonRecord(binding),
      walletExecutionSnapshot: jsonRecord(profile),
      placementSnapshot: { mode: "trade_shortfall_continuation" },
      requestedSourceAmount: jsonRecord(input.amount),
      requestedDestinationAmount: jsonRecord(input.amount),
      supportMetadata: {
        adapterId: "polymarket_funding_router_v1",
        preparationKind: "polymarket_funding_router",
        planValidation: {
          validatorId: "polymarket_funding_router_v1",
          version: 1,
        },
        venueBindingOptionId: input.authorization.venueBindingOptionId,
        fundingPlan: jsonRecord(plan),
        before: {
          routerNonceRaw: live.nonce.toString(),
          depositPusdRaw: live.depositPusdRaw.toString(),
          clobPusdRaw: null,
          observedAt: input.now.toISOString(),
        },
        delegatedOriginKind: "trade_shortfall_intent",
        fundingAuthorizationId: input.authorization.id,
        fundingAuthorizationFingerprint:
          telegramFundingAuthorizationFingerprint(input.authorization),
        telegramTradeIntentId: input.tradeIntentId,
        continuationOfOperationId: input.rootOperationId,
      },
    },
    segments: [],
    steps: [
      ...(requiresApproval
        ? [
            {
              ordinal: 0,
              segmentOrdinal: null,
              stepKind: "transaction" as const,
              state: "planned" as const,
              actionFingerprint: canonicalJsonHash(approvalAction),
              executorId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
              payerRequirement: "privy_sponsor" as const,
              dependsOnOrdinal: null,
              normalizedAction: jsonRecord(approvalAction),
              actionValidationResult:
                buildPolymarketControllerApprovalActionValidation({
                  kind: "controller_pusd_router_approval",
                  profileAddress: profile.address,
                  routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
                  sponsorship: approvalSponsorship,
                }),
              actionExpiresAt: null,
            },
          ]
        : []),
      {
        ordinal: requiresApproval ? 1 : 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation" as const,
        state: "planned" as const,
        actionFingerprint: canonicalJsonHash(fundAction),
        executorId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
        payerRequirement: sponsorship.payerRequirement,
        dependsOnOrdinal: requiresApproval ? 0 : null,
        normalizedAction: jsonRecord(fundAction),
        actionValidationResult: buildPolymarketFundingActionValidation({
          destinationAssetId: pUsd.assetId,
          plan,
          profileAddress: profile.address,
          routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
          sponsorship,
        }),
        actionExpiresAt: null,
      },
    ],
    reservations: [
      {
        segmentOrdinal: null,
        componentId: `asset_${canonicalJsonHash({ sourceLocationId, amount: input.amount }).slice(0, 32)}`,
        locationId: sourceLocationId,
        networkId: pUsd.networkId,
        assetId: pUsd.assetId,
        assetDecimals: pUsd.decimals,
        rawAmount: input.amount.raw,
        mode: "subtract_available",
        expiresAt: reservationExpiresAt,
      },
    ],
  };
}

function candidateSql(): string {
  return `select root_operation.id::text as root_operation_id,
                 coalesce(root_operation.actual_destination_amount, root_ready_reservation.amount) as root_amount,
                 root_operation.market_context_snapshot,
                 root_operation.market_id,
                 trade_intent.id::text as trade_intent_id,
                 funding_authorization.id::text as funding_authorization_id,
                 funding_authorization.*,
                 -- Keep the candidate's owner even when the optional Router
                 -- authorization is absent. Its wildcard columns would
                 -- otherwise overwrite user_id with NULL in node-postgres.
                 trade_intent.user_id as user_id
            from telegram_trade_intents trade_intent
            join funding_operations root_operation
              on root_operation.id = trade_intent.funding_operation_id
            left join lateral (
              select case when count(*) = 1 then (array_agg(
                jsonb_build_object(
                  'asset', jsonb_build_object(
                    'networkId', reservation_row.network_id,
                    'assetId', reservation_row.asset_id,
                    'decimals', reservation_row.asset_decimals
                  ),
                  'raw', reservation_row.raw_amount::text
                )
              ))[1] end as amount
                from balance_reservations reservation_row
               where reservation_row.operation_id = root_operation.id
                 and reservation_row.user_id = root_operation.user_id
                 and reservation_row.mode = 'settled_for_consumer'
                 and reservation_row.state = 'active'
            ) root_ready_reservation on true
            left join lateral (
              select authorization_row.*
                from telegram_funding_authorizations authorization_row
               where authorization_row.user_id = trade_intent.user_id
                 and authorization_row.telegram_user_id = trade_intent.telegram_user_id
                 and authorization_row.profile_id = $1
                 and authorization_row.security_class = 'closed_destination_transform'
                 and authorization_row.venue_id = 'polymarket'
                 and authorization_row.revoked_at is null
                 and (authorization_row.expires_at is null or authorization_row.expires_at > clock_timestamp())
               order by authorization_row.granted_at desc, authorization_row.id desc
               limit 1
            ) funding_authorization on true
           where trade_intent.status = 'funding'
             and trade_intent.submit_started_at is null
             and ($3::uuid is null or trade_intent.id = $3::uuid)
             and trade_intent.venue = 'polymarket'
             and trade_intent.action = 'buy'
             and root_operation.status = 'ready'
             and root_operation.progress_stage = 'ready_for_consumer'
             and ${telegramPolymarketRootRequiresRouterContinuationSql("root_operation")}
             and not exists (
               select 1 from funding_operations child_operation
                where child_operation.user_id = root_operation.user_id
                  and child_operation.support_metadata ->> 'telegramTradeIntentId' = trade_intent.id::text
                  and child_operation.support_metadata ->> 'continuationOfOperationId' = root_operation.id::text
             )
           order by root_operation.updated_at, root_operation.id
           limit $2`;
}

async function recordContinuationWait(
  pool: Pool,
  input: Readonly<{
    intentId: string;
    rootOperationId: string;
    reasonCode: string;
  }>,
): Promise<number> {
  const hardReason = isTelegramRouterContinuationHardReason(input.reasonCode);
  const result = await pool.query<{ hard_failure_count: string | null }>(
    `update telegram_trade_intents
        set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
              'fundingContinuationState', 'waiting',
              'fundingContinuationReasonCode', $3::text,
              'fundingContinuationUpdatedAt', clock_timestamp(),
              'fundingContinuationHardFailureCount', case
                when $4::boolean then least(
                  case
                    when result ->> 'fundingContinuationReasonCode' = $3::text
                     and result ->> 'fundingContinuationState' = 'waiting'
                    then case
                      when coalesce(result ->> 'fundingContinuationHardFailureCount', '') ~ '^[0-9]{1,6}$'
                      then (result ->> 'fundingContinuationHardFailureCount')::int
                      else 0
                    end
                    else 0
                  end + 1,
                  $5::int
                )
                else 0
              end
            ),
            updated_at = clock_timestamp()
      where id = $1::uuid
        and status = 'funding'
        and funding_operation_id = $2::uuid
        and submit_started_at is null
        and (
          result ->> 'fundingContinuationState' is distinct from 'waiting'
          or result ->> 'fundingContinuationReasonCode' is distinct from $3::text
          or (
            $4::boolean
            and case
              when coalesce(result ->> 'fundingContinuationHardFailureCount', '') ~ '^[0-9]{1,6}$'
              then (result ->> 'fundingContinuationHardFailureCount')::int
              else 0
            end < $5::int
          )
        )
      returning case
        when coalesce(result ->> 'fundingContinuationHardFailureCount', '') ~ '^[0-9]{1,6}$'
        then (result ->> 'fundingContinuationHardFailureCount')::int
        else 0
      end as hard_failure_count`,
    [
      input.intentId,
      input.rootOperationId,
      input.reasonCode,
      hardReason,
      ROUTER_CONTINUATION_HARD_FAILURE_LIMIT,
    ],
  );
  if (result.rows[0]) {
    return Number(result.rows[0].hard_failure_count ?? 0);
  }
  // A capped hard reason intentionally does not rewrite the intent every
  // worker pass. Still return its durable count so a prior CAS miss can be
  // retried rather than leaving the ready root permanently blocked.
  const current = await pool.query<{ hard_failure_count: string | null }>(
    `select case
              when coalesce(result ->> 'fundingContinuationHardFailureCount', '') ~ '^[0-9]{1,6}$'
              then (result ->> 'fundingContinuationHardFailureCount')::int
              else 0
            end as hard_failure_count
       from telegram_trade_intents
      where id = $1::uuid
        and status = 'funding'
        and funding_operation_id = $2::uuid
        and submit_started_at is null`,
    [input.intentId, input.rootOperationId],
  );
  return Number(current.rows[0]?.hard_failure_count ?? 0);
}

async function hardBlockRouterContinuation(
  pool: Pool,
  input: Readonly<{
    intentId: string;
    rootOperationId: string;
    userId: string;
    reasonCode: string;
  }>,
): Promise<boolean> {
  return tx(pool, async (client) => {
    const rows = await client.query<{
      id: string;
      status: "ready" | string;
      progress_stage: "ready_for_consumer" | string;
      version: string | number;
    }>(
      `select root_operation.id, root_operation.status, root_operation.progress_stage,
              root_operation.version
         from telegram_trade_intents trade_intent
         join funding_operations root_operation
           on root_operation.id = trade_intent.funding_operation_id
        where trade_intent.id = $1::uuid
          and trade_intent.user_id = $2::uuid
          and trade_intent.status = 'funding'
          and trade_intent.submit_started_at is null
          and root_operation.id = $3::uuid
          and root_operation.status = 'ready'
          and root_operation.progress_stage = 'ready_for_consumer'
          and not exists (
            select 1
              from funding_operations child_operation
             where child_operation.user_id = root_operation.user_id
               and child_operation.support_metadata ->> 'telegramTradeIntentId' = trade_intent.id::text
               and child_operation.support_metadata ->> 'continuationOfOperationId' = root_operation.id::text
          )
        for update of trade_intent, root_operation`,
      [input.intentId, input.userId, input.rootOperationId],
    );
    const root = rows.rows[0];
    if (!root) return false;
    const reservations = await client.query<{ id: string }>(
      `select id
         from balance_reservations
        where operation_id = $1::uuid
          and user_id = $2::uuid
          and mode = 'settled_for_consumer'
          and state = 'active'
        for update`,
      [input.rootOperationId, input.userId],
    );
    if (reservations.rows.length !== 1) return false;
    const reservation = reservations.rows[0];
    if (!reservation) return false;
    const now = new Date();
    await releaseFundingReservationInTransaction(client, {
      reservationId: reservation.id,
      outcomeReason: "trade_shortfall_router_continuation_hard_blocked",
      now,
    });
    await transitionFundingOperationInTransaction(client, {
      operationId: root.id,
      scope: { kind: "worker" },
      expectedVersion: Number(root.version),
      expectedState: { status: "ready", stage: "ready_for_consumer" },
      nextState: { status: "completed", stage: "terminal" },
      supportMetadataPatch: {
        consumerResolution: "released_to_controller_cash",
        consumerResolvedAt: now.toISOString(),
        consumerResolutionReason: "router_continuation_hard_blocked",
        routerContinuationReasonCode: input.reasonCode,
      },
      now,
    });
    await client.query(
      `update telegram_funding_authorization_reservations
          set status = 'settled',
              resolved_at = $2,
              resolution_evidence = resolution_evidence || jsonb_build_object(
                'operationStatus', 'completed',
                'operationId', $1::text,
                'reason', 'router_continuation_hard_blocked'
              ),
              updated_at = $2
        where funding_operation_id = $1::uuid
          and status = 'reserved'`,
      [root.id, now],
    );
    const terminalized = await client.query(
      `update telegram_trade_intents
          set status = 'failed',
              error_code = $2::text,
              error_message = 'Polymarket funding setup changed before the final Router step. No trade was submitted.',
              result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                'fundingContinuationState', 'hard_blocked',
                'fundingContinuationReasonCode', $2::text,
                'fundingContinuationTerminalizedAt', $3::timestamptz
              ),
              updated_at = $3
        where id = $1::uuid
          and status = 'funding'
          and submit_started_at is null`,
      [input.intentId, input.reasonCode, now],
    );
    if (terminalized.rowCount !== 1) {
      throw new Error(
        "Router continuation intent changed before hard-block commit",
      );
    }
    return true;
  });
}

async function recordRouterContinuationWait(
  pool: Pool,
  input: Readonly<{
    intentId: string;
    rootOperationId: string;
    userId: string;
    reasonCode: string;
  }>,
): Promise<void> {
  const failures = await recordContinuationWait(pool, input);
  if (
    failures >= ROUTER_CONTINUATION_HARD_FAILURE_LIMIT &&
    isTelegramRouterContinuationHardReason(input.reasonCode)
  ) {
    await hardBlockRouterContinuation(pool, input);
  }
}

export async function runTelegramRouterContinuationCommitter(
  pool: Pool,
  input: Readonly<{
    limit: number;
    subjectLookupHmacKey: string;
    subjectLookupKeyVersion: number;
    inspectRouterProfile: (
      input: Readonly<{
        walletAddress: string;
        walletId: string;
        profileId: string;
      }>,
    ) => Promise<"valid" | "invalid" | "unavailable">;
    tradeIntentId?: string;
  }>,
): Promise<Readonly<{ created: number; skipped: number }>> {
  const configuration = loadPolymarketPusdFundExecutionConfiguration();
  const rows = await pool.query<CandidateRow>(candidateSql(), [
    POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
    Math.max(1, Math.min(input.limit, 100)),
    input.tradeIntentId ?? null,
  ]);
  let created = 0;
  let skipped = 0;
  if (!polymarketRouterExecutionConfigurationReady(configuration)) {
    for (const row of rows.rows) {
      await recordRouterContinuationWait(pool, {
        intentId: row.trade_intent_id,
        rootOperationId: row.root_operation_id,
        userId: row.user_id,
        reasonCode: "router_execution_configuration_unavailable",
      });
    }
    return { created: 0, skipped: rows.rows.length };
  }
  for (const row of rows.rows) {
    const amount = readExactRootAmount(row);
    if (!row.funding_authorization_id) {
      await recordRouterContinuationWait(pool, {
        intentId: row.trade_intent_id,
        rootOperationId: row.root_operation_id,
        userId: row.user_id,
        reasonCode: "router_authorization_missing",
      });
      skipped += 1;
      continue;
    }
    if (!amount) {
      await recordRouterContinuationWait(pool, {
        intentId: row.trade_intent_id,
        rootOperationId: row.root_operation_id,
        userId: row.user_id,
        reasonCode: "router_root_amount_unavailable",
      });
      skipped += 1;
      continue;
    }
    const authorization = telegramFundingAuthorizationFromRow(row);
    const expectedAsset: AssetRef = {
      networkId: "evm:137",
      assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
      decimals: 6,
    };
    if (
      !sameAsset(amount.asset, expectedAsset) ||
      authorization.profileId !== POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID ||
      authorization.signerId !== configuration.signerId ||
      authorization.signerFingerprint !== configuration.signerFingerprint ||
      authorization.policyId !== configuration.policyId ||
      authorization.policyFingerprint !== configuration.policyFingerprint ||
      !sameAsset(authorization.sourceAsset, expectedAsset) ||
      !sameAsset(authorization.destinationAsset, expectedAsset)
    ) {
      await recordRouterContinuationWait(pool, {
        intentId: row.trade_intent_id,
        rootOperationId: row.root_operation_id,
        userId: row.user_id,
        reasonCode: "router_authorization_mismatch",
      });
      skipped += 1;
      continue;
    }
    try {
      const profileState = await input.inspectRouterProfile({
        walletAddress: authorization.walletAddress,
        walletId: authorization.privyWalletId,
        profileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
      });
      if (profileState !== "valid") {
        await recordRouterContinuationWait(pool, {
          intentId: row.trade_intent_id,
          rootOperationId: row.root_operation_id,
          userId: row.user_id,
          reasonCode:
            profileState === "invalid"
              ? "router_policy_or_wallet_setup_invalid"
              : "router_policy_or_wallet_setup_unavailable",
        });
        skipped += 1;
        continue;
      }
      const now = new Date();
      const live = await loadLiveRouterFacts({ authorization, amount });
      if (live.kind !== "ready") {
        await recordRouterContinuationWait(pool, {
          intentId: row.trade_intent_id,
          rootOperationId: row.root_operation_id,
          userId: row.user_id,
          reasonCode:
            live.kind === "polygon_rpc_unavailable"
              ? "router_polygon_rpc_unavailable"
              : live.kind === "source_balance_insufficient"
                ? "router_source_balance_insufficient"
                : "router_deposit_wallet_unavailable",
        });
        skipped += 1;
        continue;
      }
      const plan = buildPlan({
        authorization,
        rootOperationId: row.root_operation_id,
        tradeIntentId: row.trade_intent_id,
        amount,
        marketContextSnapshot: row.market_context_snapshot,
        marketId: row.market_id,
        live,
        now,
      });
      const idempotencyKey = `telegram-trade-funding:${row.trade_intent_id}:router`;
      const consentToken = randomBytes(32).toString("hex");
      const committed = await tx(pool, async (client: PoolClient) => {
        const lockedRoot = await client.query<{ id: string }>(
          `select root_operation.id
             from telegram_trade_intents trade_intent
             join funding_operations root_operation
               on root_operation.id = trade_intent.funding_operation_id
            where trade_intent.id = $1::uuid
              and trade_intent.user_id = $2::uuid
              and trade_intent.status = 'funding'
              and trade_intent.submit_started_at is null
              and root_operation.id = $3::uuid
              and root_operation.status = 'ready'
              and root_operation.progress_stage = 'ready_for_consumer'
            for update of trade_intent, root_operation`,
          [row.trade_intent_id, row.user_id, row.root_operation_id],
        );
        if (!lockedRoot.rows[0]) {
          throw new Error("Router continuation root is no longer ready");
        }
        const lockedAuthorization = await client.query<{ id: string }>(
          `select id
             from telegram_funding_authorizations
            where id = $1::uuid
              and user_id = $2::uuid
              and profile_id = $3
              and security_class = 'closed_destination_transform'
              and venue_id = 'polymarket'
              and revoked_at is null
              and (expires_at is null or expires_at > clock_timestamp())
            for update`,
          [
            authorization.id,
            row.user_id,
            POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
          ],
        );
        if (!lockedAuthorization.rows[0]) {
          throw new Error("Router continuation authorization changed");
        }
        const currentPolicy = await resolveFundingPolicy(client);
        if (
          currentPolicy.runtime.creationMode !== "on" ||
          !currentPolicy.runtime.gates.quoteCreation ||
          !currentPolicy.runtime.gates.commit
        ) {
          throw new Error("funding policy is not enabled");
        }
        const quote = await createFundingQuoteInTransaction(client, {
          userId: row.user_id,
          discoveryProjectionId: `telegram-router-continuation:${row.root_operation_id}`,
          selectedSourceOptionSnapshot: { sourceOptionId: "root_relay_pusd" },
          marketContextSnapshot: row.market_context_snapshot,
          destinationOptionSnapshot: {
            destinationOptionId: authorization.destinationOptionId,
          },
          venueBindingSnapshot: {
            venueBindingOptionId: authorization.venueBindingOptionId,
          },
          planSnapshot: plan,
          policyVersion: currentPolicy.runtime.contractVersion,
          policyRevision: currentPolicy.revision,
          canonicalRequest: {
            idempotencyKey,
            rootOperationId: row.root_operation_id,
            amount,
          },
          consentToken,
          expiresAt: new Date(now.getTime() + 15 * 60_000),
        });
        const result = await commitFundingOperationInTransaction(client, {
          userId: row.user_id,
          quoteId: quote.id,
          consentToken,
          idempotencyKey,
          plan,
          subjectLookupHmac: fundingSubjectLookupHmac(
            row.user_id,
            input.subjectLookupHmacKey,
          ),
          subjectLookupKeyVersion: input.subjectLookupKeyVersion,
          verifyCurrentFacts: async (verifiedClient) => {
            const stillAuthorized = await verifiedClient.query<{ id: string }>(
              `select id
                 from telegram_funding_authorizations
                where id = $1::uuid
                  and user_id = $2::uuid
                  and profile_id = $3
                  and security_class = 'closed_destination_transform'
                  and venue_id = 'polymarket'
                  and revoked_at is null
                  and (expires_at is null or expires_at > clock_timestamp())`,
              [
                authorization.id,
                row.user_id,
                POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
              ],
            );
            if (!stillAuthorized.rows[0]) {
              throw new Error(
                "Router continuation authorization changed before commit",
              );
            }
          },
        });
        await client.query(
          `update telegram_trade_intents
              set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                    'fundingContinuationOperationId', $2::text,
                    'fundingContinuationCommittedAt', clock_timestamp(),
                    'fundingContinuationState', 'committed',
                    'fundingContinuationReasonCode', null
                  ),
                  updated_at = clock_timestamp()
            where id = $1::uuid
              and status = 'funding'
              and funding_operation_id = $3::uuid
              and submit_started_at is null`,
          [row.trade_intent_id, result.operation.id, row.root_operation_id],
        );
        await activateTelegramTradeShortfallInitialStepInTransaction(client, {
          operationId: result.operation.id,
          profileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
          tradeIntentId: row.trade_intent_id,
        });
        return result;
      });
      if (!committed.replayed) created += 1;
    } catch (error) {
      await recordRouterContinuationWait(pool, {
        intentId: row.trade_intent_id,
        rootOperationId: row.root_operation_id,
        userId: row.user_id,
        reasonCode: "router_continuation_commit_retrying",
      });
      console.warn("[telegram-router-continuation] commit skipped", {
        intentId: row.trade_intent_id,
        rootOperationId: row.root_operation_id,
        errorMessage: error instanceof Error ? error.message : "unknown_error",
      });
      skipped += 1;
    }
  }
  return { created, skipped };
}
