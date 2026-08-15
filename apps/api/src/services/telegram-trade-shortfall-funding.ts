import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  AssetRef,
  FundingDiscoveryRequest,
  FundingQuoteSummary,
  Money,
  SourceOption,
} from "../funding/domain/types.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { lockFundingAuthorizationReservationScope } from "../funding/persistence/funding-authorization-reservation-lock.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-service.js";
import {
  ensureTelegramFundingAuthorization,
  ensureTelegramRelayEvmFundingAuthorization,
  loadActiveTelegramFundingAuthorization,
  telegramFundingAuthorizationFingerprint,
} from "../funding/execution/telegram-funding-authorization.js";
import { resolveTelegramFundingProvisionWallet } from "../funding/execution/telegram-funding-managed-wallet.js";
import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "../funding/execution/delegated-funding-profile-ids.js";
import { RELAY_EVM_FUNDING_PROFILE_SPECS } from "../funding/execution/relay-evm-profile-specs.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDCE_LEGACY,
} from "../funding-providers/relay/rehearsal.js";
import { RELAY_ROUTE_SPECS } from "../funding-providers/relay/mappings.js";

type Venue = "limitless" | "polymarket";
type Side = "NO" | "YES";

export type TelegramTradeShortfallProposal = Readonly<{
  version: 1;
  kind: "internal_stable_route";
  liquidityProjectionId: string;
  selectedSourceOptionId: string;
  serverExecutionProfileId: string;
  sourceAmounts: FundingQuoteSummary["sourceAmounts"];
  expectedDestination: Money;
  minimumDestination: Money;
  fees: FundingQuoteSummary["fees"];
  eta: FundingQuoteSummary["eta"];
  destinationOptionId: string;
  venueBindingOptionId: string;
  requestedDestinationAmount: Money;
  proposalFingerprint: string;
  expiresAt: string;
}>;

export type TelegramTradeShortfallInspection =
  | Readonly<{ kind: "destination_ready" }>
  | Readonly<{ kind: "external_deposit_required" }>
  | Readonly<{ kind: "managed_setup_required" }>
  | Readonly<{
      kind: "temporarily_unavailable";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      kind: "internal_route";
      proposal: TelegramTradeShortfallProposal;
    }>;

export type TelegramTradeShortfallIdentity = Readonly<{
  authorizationId: string;
  telegramAccountId: string;
  telegramUserId: string;
  tradeIntentId: string;
  userId: string;
  venue: Venue;
  marketId: string;
  marketContextId: string;
  side: Side;
  maximumSpendUsd: string;
  maxFeeUsd: string;
  maxSlippageBps: number;
  deadline: string;
}>;

function destinationAsset(venue: Venue): AssetRef {
  return venue === "limitless"
    ? {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      }
    : {
        networkId: "evm:137",
        assetId:
          fundingSidecarRuntimeConfig.polymarketPusdAddress || POLYGON_PUSD,
        decimals: 6,
      };
}

function usdToStableRaw(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new Error("trade funding maximum spend is invalid");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = `${fraction}000000`.slice(0, 6);
  const remainder = fraction.slice(6);
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(padded) +
    (/[1-9]/u.test(remainder) ? 1n : 0n)
  ).toString();
}

function tradeShortfallRequest(
  input: TelegramTradeShortfallIdentity,
  serverExecutionProfileId?: string,
): FundingDiscoveryRequest {
  const requestedDestinationAmount = {
    asset: destinationAsset(input.venue),
    raw: usdToStableRaw(input.maximumSpendUsd),
  };
  return {
    purpose: "trade_shortfall",
    requestedDestinationAmount,
    confirmedSourceAmount: null,
    marketContextId: input.marketContextId,
    consumerIntent: {
      venueId: input.venue,
      marketId: input.marketId,
      marketContextId: input.marketContextId,
      side: "BUY",
      spend: requestedDestinationAmount,
    },
    destinationOptionId: null,
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    controllerWalletRef: null,
    ...(serverExecutionProfileId ? { serverExecutionProfileId } : {}),
    maxFeeUsd: input.maxFeeUsd,
    maxSlippageBps: input.maxSlippageBps,
    deadline: input.deadline,
  };
}

function optionSourceAssets(option: SourceOption): readonly AssetRef[] {
  const sources = option.sourceLegs?.map((leg) => leg.sourceAmount.asset) ?? [];
  if (sources.length > 0) return sources;
  if (option.source.kind === "owned_location") {
    return [option.source.location.asset];
  }
  return [];
}

export function resolveTelegramTradeShortfallExecutionProfile(
  option: SourceOption,
  venue: Venue,
  destination: AssetRef,
): string | null {
  // A Polymarket Deposit Wallet handoff is a separate, user-authorized
  // relayer action. Do not present a route containing that action as an
  // unattended Telegram/server route until it has its own exact authority
  // and executor profile.
  if (
    option.requiredActions.some(
      (action) => action.kind === "external_handoff",
    ) &&
    !fundingSidecarRuntimeConfig.polymarketDepositWalletPullerAddress
  ) {
    return null;
  }
  if (
    option.source.kind === "venue_preparation" &&
    option.source.venueId === "polymarket" &&
    venue === "polymarket" &&
    sameAsset(destination, {
      networkId: "evm:137",
      assetId:
        fundingSidecarRuntimeConfig.polymarketPusdAddress || POLYGON_PUSD,
      decimals: 6,
    })
  ) {
    return POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
  }
  const sources = optionSourceAssets(option);
  if (sources.length !== 1) return null;
  const source = sources[0];
  if (!source) return null;
  if (
    venue === "polymarket" &&
    sameAsset(source, {
      networkId: "evm:137",
      assetId: POLYGON_USDCE_LEGACY,
      decimals: 6,
    }) &&
    sameAsset(destination, {
      networkId: "evm:137",
      assetId:
        fundingSidecarRuntimeConfig.polymarketPusdAddress || POLYGON_PUSD,
      decimals: 6,
    })
  ) {
    return POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
  }
  const matches = Object.values(RELAY_EVM_FUNDING_PROFILE_SPECS).filter(
    (profile) =>
      profile.venueIds.includes(venue) &&
      sameAsset(profile.sourceAsset, source) &&
      profile.routeIds.some((routeId) => {
        const route = RELAY_ROUTE_SPECS[routeId];
        return route ? sameAsset(route.destination, destination) : false;
      }),
  );
  return matches.length === 1 ? (matches[0]?.profileId ?? null) : null;
}

function recommendedOption(
  options: readonly SourceOption[],
): SourceOption | null {
  const selectable = options.filter(
    (option) =>
      option.selectable &&
      option.experienceMode !== "unavailable" &&
      (option.source.kind === "owned_location" ||
        option.source.kind === "venue_preparation" ||
        (option.source.kind === "composite" &&
          option.sourceLegs?.every(
            (leg) =>
              leg.source.kind === "owned_location" ||
              leg.source.kind === "venue_preparation",
          ) === true)),
  );
  return (
    selectable.find((option) => option.recommended) ?? selectable[0] ?? null
  );
}

function proposalFromOption(
  projection: Readonly<{
    liquidityProjectionId: string;
    destinationOptionId: string | null;
    venueBindingOptionId: string | null;
    collateralAsset: AssetRef;
    requestedCollateralRaw: string;
    expiresAt: string;
  }>,
  option: SourceOption,
  profileId: string,
): TelegramTradeShortfallProposal {
  if (
    !projection.destinationOptionId ||
    !projection.venueBindingOptionId ||
    !option.expectedDestination ||
    !option.minimumDestination
  ) {
    throw new Error("trade funding quote is missing its exact destination");
  }
  const sourceAmounts =
    option.sourceLegs?.map((leg) => ({
      safeLabel: leg.safeLabel,
      amount: leg.sourceAmount,
    })) ??
    (option.source.kind === "owned_location" && option.maximumSourceRaw
      ? [
          {
            safeLabel: option.safeLabel,
            amount: {
              asset: option.source.location.asset,
              raw: option.maximumSourceRaw,
            },
          },
        ]
      : []);
  if (sourceAmounts.length === 0) {
    throw new Error("trade funding route has no exact source amount");
  }
  const body = {
    version: 1 as const,
    kind: "internal_stable_route" as const,
    liquidityProjectionId: projection.liquidityProjectionId,
    selectedSourceOptionId: option.sourceOptionId,
    serverExecutionProfileId: profileId,
    sourceAmounts,
    expectedDestination: option.expectedDestination,
    minimumDestination: option.minimumDestination,
    fees: option.fees,
    eta: option.eta,
    destinationOptionId: projection.destinationOptionId,
    venueBindingOptionId: projection.venueBindingOptionId,
    requestedDestinationAmount: {
      asset: projection.collateralAsset,
      raw: projection.requestedCollateralRaw,
    },
    expiresAt: projection.expiresAt,
  };
  return {
    ...body,
    proposalFingerprint: canonicalJsonHash(body),
  };
}

export class TelegramTradeShortfallFundingService {
  private readonly runtime: FundingPlanningRuntime;

  constructor(private readonly pool: Pool) {
    this.runtime = new FundingPlanningRuntime(pool);
  }

  async inspect(
    input: TelegramTradeShortfallIdentity,
  ): Promise<TelegramTradeShortfallInspection> {
    const initial = await this.runtime.liquidity(
      input.userId,
      tradeShortfallRequest(input),
    );
    if (initial.completeness !== "complete" || initial.errors.length > 0) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [
          ...initial.reasonCodes,
          ...initial.errors.map((error) => error.code),
        ],
      };
    }
    const selected = recommendedOption(initial.sourceOptions);
    if (!selected) return { kind: "external_deposit_required" };
    const profileId = resolveTelegramTradeShortfallExecutionProfile(
      selected,
      input.venue,
      destinationAsset(input.venue),
    );
    if (!profileId) {
      if (
        selected.requiredActions.some(
          (action) => action.kind === "external_handoff",
        )
      ) {
        return { kind: "external_deposit_required" };
      }
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_requires_unsupported_execution_profile"],
      };
    }
    if (!initial.destinationOptionId || !initial.venueBindingOptionId) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_destination_binding_unavailable"],
      };
    }
    const controller = await resolveTelegramFundingProvisionWallet(this.pool, {
      userId: input.userId,
      telegramAccountId: input.telegramAccountId,
      telegramUserId: input.telegramUserId,
      controllerNetworkId: input.venue === "limitless" ? "evm:8453" : "evm:137",
    });
    if (!controller) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_controller_wallet_unavailable"],
      };
    }
    const authorizationInput = {
      userId: input.userId,
      telegramAccountId: input.telegramAccountId,
      telegramUserId: input.telegramUserId,
      controllerWalletId: controller.controllerWalletId,
      destinationOptionId: initial.destinationOptionId,
      venueBindingOptionId: initial.venueBindingOptionId,
      venueId: input.venue,
    } as const;
    const provisioned =
      profileId === POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID
        ? await ensureTelegramFundingAuthorization(
            this.pool,
            authorizationInput,
          )
        : await ensureTelegramRelayEvmFundingAuthorization(
            this.pool,
            authorizationInput,
          );
    if (!provisioned) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_delegated_authority_unavailable"],
      };
    }
    let delegated;
    try {
      delegated = await this.runtime.liquidity(
        input.userId,
        tradeShortfallRequest(input, profileId),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Open Hunch once to finish wallet setup")
      )
        return { kind: "managed_setup_required" };
      throw error;
    }
    if (delegated.completeness !== "complete" || delegated.errors.length > 0) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [
          ...delegated.reasonCodes,
          ...delegated.errors.map((error) => error.code),
        ],
      };
    }
    const delegatedOption = recommendedOption(delegated.sourceOptions);
    if (
      !delegatedOption ||
      resolveTelegramTradeShortfallExecutionProfile(
        delegatedOption,
        input.venue,
        destinationAsset(input.venue),
      ) !== profileId
    ) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_changed_during_delegated_planning"],
      };
    }
    return {
      kind: "internal_route",
      proposal: proposalFromOption(delegated, delegatedOption, profileId),
    };
  }

  async commit(
    input: TelegramTradeShortfallIdentity & {
      proposal: TelegramTradeShortfallProposal;
    },
  ): Promise<Readonly<{ operationId: string }>> {
    const proposalBody = { ...input.proposal } as Record<string, unknown>;
    delete proposalBody.proposalFingerprint;
    if (
      input.proposal.version !== 1 ||
      input.proposal.kind !== "internal_stable_route" ||
      canonicalJsonHash(proposalBody) !== input.proposal.proposalFingerprint ||
      new Date(input.proposal.expiresAt).getTime() <= Date.now()
    ) {
      throw new Error("trade funding proposal expired or changed");
    }
    const requestedDestinationAmount = tradeShortfallRequest(
      input,
      input.proposal.serverExecutionProfileId,
    ).requestedDestinationAmount;
    if (
      !requestedDestinationAmount ||
      requestedDestinationAmount.raw !==
        input.proposal.requestedDestinationAmount.raw ||
      !sameAsset(
        requestedDestinationAmount.asset,
        input.proposal.requestedDestinationAmount.asset,
      )
    ) {
      throw new Error("trade funding requested destination changed");
    }
    const quote = await this.runtime.quote(input.userId, {
      liquidityProjectionId: input.proposal.liquidityProjectionId,
      selectedSourceOptionId: input.proposal.selectedSourceOptionId,
      confirmedSourceAmount: null,
      requestedDestinationAmount,
    });
    if (
      BigInt(quote.minimumDestination.raw) <
        BigInt(input.proposal.minimumDestination.raw) ||
      !sameAsset(
        quote.minimumDestination.asset,
        input.proposal.minimumDestination.asset,
      )
    ) {
      throw new Error("trade funding economics moved outside confirmed bounds");
    }
    const sourceRaw = quote.sourceAmounts.reduce(
      (sum, source) => sum + BigInt(source.amount.raw),
      0n,
    );
    if (sourceRaw <= 0n) throw new Error("trade funding source is empty");
    const exactSourceAsset = quote.sourceAmounts[0]?.amount.asset;
    if (!exactSourceAsset || quote.sourceAmounts.length !== 1) {
      throw new Error(
        "trade funding delegated execution requires one exact stable source",
      );
    }
    const securityClass =
      input.proposal.serverExecutionProfileId ===
      POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID
        ? "closed_destination_transform"
        : "routed_value_movement";
    const fundingAuthorization = await loadActiveTelegramFundingAuthorization(
      this.pool,
      {
        userId: input.userId,
        telegramAccountId: input.telegramAccountId,
        telegramUserId: input.telegramUserId,
        destinationOptionId: quote.destinationOptionId as string,
        venueBindingOptionId: quote.venueBindingOptionId as string,
        venueId: input.venue,
        profileId: input.proposal.serverExecutionProfileId,
        securityClass,
        sourceAsset: exactSourceAsset,
        destinationAsset: quote.minimumDestination.asset,
        requireTradingEnabled: true,
      },
    );
    if (!fundingAuthorization) {
      throw new Error("trade funding authorization is unavailable");
    }
    const prepared = await this.runtime.prepareCommit(input.userId, {
      quoteId: quote.quoteId,
      consentToken: quote.consentToken,
      idempotencyKey: `telegram-trade-funding:${input.tradeIntentId}`,
    });
    return tx(this.pool, async (client: PoolClient) => {
      await lockFundingPolicyForTransaction(client);
      if (
        securityClass === "routed_value_movement" &&
        !(await lockFundingAuthorizationReservationScope(client, {
          authorizationId: fundingAuthorization.id,
          userId: input.userId,
        }))
      ) {
        throw new Error("trade funding allowance lane is unavailable");
      }
      const lockedIntent = await client.query<{ status: string }>(
        `select status
           from telegram_trade_intents
          where id = $1::uuid
            and user_id = $2::uuid
            and authorization_id = $3::uuid
            and status = 'confirming'
            and submit_started_at is null
          for update`,
        [input.tradeIntentId, input.userId, input.authorizationId],
      );
      if (!lockedIntent.rows[0]) {
        throw new Error("trade funding intent is no longer confirmable");
      }
      const lockedAuthorization = await loadActiveTelegramFundingAuthorization(
        client,
        {
          userId: input.userId,
          telegramAccountId: input.telegramAccountId,
          telegramUserId: input.telegramUserId,
          destinationOptionId: quote.destinationOptionId as string,
          venueBindingOptionId: quote.venueBindingOptionId as string,
          venueId: input.venue,
          expectedAuthorizationId: fundingAuthorization.id,
          profileId: input.proposal.serverExecutionProfileId,
          securityClass,
          sourceAsset: exactSourceAsset,
          destinationAsset: quote.minimumDestination.asset,
          lock: true,
          requireTradingEnabled: true,
        },
      );
      if (!lockedAuthorization) {
        throw new Error("trade funding authorization changed");
      }
      const committed = await this.runtime.commitPreparedInTransaction(
        client,
        prepared,
      );
      const operationId = committed.operation.id;
      await client.query(
        `update funding_operations
            set support_metadata = support_metadata || jsonb_build_object(
                  'fundingAuthorizationId', $3::text,
                  'fundingAuthorizationFingerprint', $4::text,
                  'telegramTradeIntentId', $5::text,
                  'delegatedOriginKind', 'trade_shortfall_intent'
                ),
                updated_at = clock_timestamp(),
                version = version + 1
          where id = $1::uuid and user_id = $2::uuid`,
        [
          operationId,
          input.userId,
          lockedAuthorization.id,
          telegramFundingAuthorizationFingerprint(lockedAuthorization),
          input.tradeIntentId,
        ],
      );
      const capReservation =
        securityClass === "routed_value_movement"
          ? await client.query<{ id: string }>(
              `insert into telegram_funding_authorization_reservations (
           authorization_id,
           source_trade_intent_id,
           funding_operation_id,
           source_raw,
           status,
           reserved_at
         )
         select funding_authorization.id, $3::uuid, $4::uuid, $5::numeric,
                'reserved', clock_timestamp()
           from telegram_funding_authorizations funding_authorization
          where funding_authorization.id = $1::uuid
            and funding_authorization.user_id = $2::uuid
            and funding_authorization.security_class = 'routed_value_movement'
            and funding_authorization.max_source_raw is not null
            and $5::numeric <= funding_authorization.max_source_raw
            and $5::numeric + coalesce((
              select sum(lane_charge.source_raw)
                from (
                  select reservation_row.funding_operation_id,
                         max(reservation_row.source_raw) as source_raw
                    from telegram_funding_authorization_reservations reservation_row
                    join telegram_funding_authorizations prior_funding_authorization
                      on prior_funding_authorization.id = reservation_row.authorization_id
                   where prior_funding_authorization.user_id = funding_authorization.user_id
                     and lower(prior_funding_authorization.wallet_address) =
                           lower(funding_authorization.wallet_address)
                     and prior_funding_authorization.wallet_chain =
                           funding_authorization.wallet_chain
                     and prior_funding_authorization.profile_id =
                           funding_authorization.profile_id
                     and reservation_row.status <> 'released'
                     and reservation_row.funding_operation_id <> $4::uuid
                     and reservation_row.reserved_at >=
                           clock_timestamp() - interval '24 hours'
                   group by reservation_row.funding_operation_id
                ) lane_charge
            ), 0) <= funding_authorization.max_source_raw
         on conflict (funding_operation_id) do nothing
         returning id`,
              [
                lockedAuthorization.id,
                input.userId,
                input.tradeIntentId,
                operationId,
                sourceRaw.toString(),
              ],
            )
          : null;
      if (capReservation && !capReservation.rows[0]) {
        throw new Error("trade funding authorization cap is unavailable");
      }
      const linked = await client.query(
        `update telegram_trade_intents
            set status = 'funding',
                funding_operation_id = $2::uuid,
                expires_at = greatest(
                  expires_at,
                  clock_timestamp() + interval '30 minutes'
                ),
                result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                  'fundingProposal', $3::jsonb,
                  'fundingCommittedAt', clock_timestamp()
                ),
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'confirming'
            and funding_operation_id is null
            and funding_reservation_id is null`,
        [input.tradeIntentId, operationId, JSON.stringify(input.proposal)],
      );
      if ((linked.rowCount ?? 0) !== 1) {
        throw new Error("trade funding operation could not be linked");
      }
      return { operationId };
    });
  }
}
