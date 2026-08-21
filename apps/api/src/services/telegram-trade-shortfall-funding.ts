import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  AssetRef,
  FundingDiscoveryRequest,
  FundingQuoteSummary,
  JsonObject,
  Money,
  SourceOption,
} from "../funding/domain/types.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import {
  isPositiveRawAmount,
  parsePositiveRawAmount,
} from "../funding/domain/raw-amount.js";
import { FundingPlannerError } from "../funding/planner/money.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import {
  buildTelegramAppHandoffV2Plan,
  resolveTelegramAppHandoffFundingCapability,
  type TelegramAppHandoffV2Plan,
} from "./telegram-app-handoff-v2.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { lockFundingAuthorizationReservationScope } from "../funding/persistence/funding-authorization-reservation-lock.js";
import { releaseCompletedTradeShortfallSourceReservationsInTransaction } from "../funding/persistence/funding-evidence-repository.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-service.js";
import {
  ensureTelegramFundingAuthorization,
  ensureTelegramRelayEvmFundingAuthorization,
  loadActiveTelegramFundingAuthorization,
  telegramFundingAuthorizationFingerprint,
} from "../funding/execution/telegram-funding-authorization.js";
import { loadRelayEvmExecutionConfiguration } from "../funding/execution/delegated-funding-config.js";
import { resolveTelegramFundingProvisionWallet } from "../funding/execution/telegram-funding-managed-wallet.js";
import {
  captureRelayEvmAllowanceBaseline,
  relayEvmAllowanceBaselineSupportMetadata,
} from "../funding/execution/relay-evm-allowance-baseline.js";
import {
  isPolymarketDepositRouterProfileId,
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
} from "../funding/execution/delegated-funding-profile-ids.js";
import { activateTelegramTradeShortfallInitialStepInTransaction } from "../funding/execution/telegram-trade-shortfall-activation.js";
import {
  RELAY_EVM_FUNDING_PROFILE_SPECS,
  relayEvmFundingProfileSpec,
} from "../funding/execution/relay-evm-profile-specs.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDCE_LEGACY,
} from "../funding-providers/relay/rehearsal.js";
import { RELAY_ROUTE_SPECS } from "../funding-providers/relay/mappings.js";

type Venue = "limitless" | "polymarket";
type Side = "NO" | "YES";

function shortfallPlannerFailureReasonCode(error: unknown): string {
  return error instanceof FundingPlannerError
    ? `funding_planner_${error.code}`
    : "funding_planner_unavailable";
}

/** A non-quote safety stop that must never be presented as quote expiry. */
export class TelegramTradeShortfallCommitError extends Error {
  constructor(
    readonly code: "allowance_lane_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TelegramTradeShortfallCommitError";
  }
}

export type TelegramTradeShortfallProposal = Readonly<{
  version: 1;
  kind: "internal_stable_route";
  liquidityProjectionId: string;
  selectedSourceOptionId: string;
  serverExecutionProfileId: string;
  /** Bounded allowance cap included in the reviewed delegated Relay plan. */
  relayPersistentApprovalCapRaw?: string;
  sourceAmounts: FundingQuoteSummary["sourceAmounts"];
  expectedDestination: Money;
  minimumDestination: Money;
  fees: FundingQuoteSummary["fees"];
  eta: FundingQuoteSummary["eta"];
  destinationOptionId: string;
  venueBindingOptionId: string;
  /** Exact trusted top-up used to make the stored liquidity projection. */
  serverAdditionalDestinationAmount: Money;
  requestedDestinationAmount: Money;
  proposalFingerprint: string;
  expiresAt: string;
}>;

export type TelegramTradeShortfallInspection =
  | Readonly<{ kind: "destination_ready" }>
  | Readonly<{ kind: "external_deposit_required" }>
  | Readonly<{
      kind: "temporarily_unavailable";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      kind: "internal_route";
      proposal: TelegramTradeShortfallProposal;
    }>;

/**
 * The Mini App is allowed to execute a generic plan only after this service
 * has produced it from the same funding runtime used by ordinary web funding.
 * It intentionally has no Privy grant/provisioning branch: every resulting
 * action is a user-signed client action.
 */
export type TelegramTradeMiniAppFundingInspection =
  | Readonly<{ kind: "destination_ready" }>
  | Readonly<{ kind: "external_deposit" }>
  | Readonly<{
      kind: "temporarily_unavailable";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      kind: "web_funding_plan";
      plan: TelegramAppHandoffV2Plan;
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
  additionalFundingUsd?: string;
  /** Exact-raw form replayed from a durable server proposal. */
  additionalFundingRaw?: string;
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

function exactStableRaw(input: TelegramTradeShortfallIdentity): string | null {
  const decimalRaw = input.additionalFundingUsd
    ? usdToStableRaw(input.additionalFundingUsd)
    : null;
  if (input.additionalFundingRaw != null) {
    if (!isPositiveRawAmount(input.additionalFundingRaw)) {
      throw new Error("trade funding exact shortfall is invalid");
    }
    if (decimalRaw != null && decimalRaw !== input.additionalFundingRaw) {
      throw new Error("trade funding shortfall representations disagree");
    }
    return input.additionalFundingRaw;
  }
  if (decimalRaw === "0") {
    throw new Error("trade funding exact shortfall must be positive");
  }
  return decimalRaw;
}

export function buildTelegramTradeShortfallRequest(
  input: TelegramTradeShortfallIdentity,
  serverExecutionProfileId?: string,
  relayPersistentApprovalCapRaw?: string,
): FundingDiscoveryRequest {
  const requestedDestinationAmount = {
    asset: destinationAsset(input.venue),
    raw: usdToStableRaw(input.maximumSpendUsd),
  };
  const additionalFundingRaw = exactStableRaw(input);
  return {
    purpose: "trade_shortfall",
    requestedDestinationAmount,
    ...(additionalFundingRaw != null
      ? {
          serverAdditionalDestinationAmount: {
            asset: requestedDestinationAmount.asset,
            raw: additionalFundingRaw,
          },
        }
      : {}),
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
    ...(relayPersistentApprovalCapRaw ? { relayPersistentApprovalCapRaw } : {}),
    maxFeeUsd: input.maxFeeUsd,
    maxSlippageBps: input.maxSlippageBps,
    deadline: input.deadline,
  };
}

export function buildTelegramTradeShortfallCommitRequest(
  input: TelegramTradeShortfallIdentity,
  proposal: Pick<
    TelegramTradeShortfallProposal,
    | "requestedDestinationAmount"
    | "serverAdditionalDestinationAmount"
    | "serverExecutionProfileId"
    | "relayPersistentApprovalCapRaw"
  >,
): FundingDiscoveryRequest {
  const serverAdditionalDestinationAmount =
    proposal.serverAdditionalDestinationAmount;
  if (
    !serverAdditionalDestinationAmount ||
    !sameAsset(
      serverAdditionalDestinationAmount.asset,
      proposal.requestedDestinationAmount.asset,
    ) ||
    !isPositiveRawAmount(serverAdditionalDestinationAmount.raw)
  ) {
    throw new Error("trade funding proposal lacks its exact shortfall");
  }
  const requestedRaw = parsePositiveRawAmount(
    proposal.requestedDestinationAmount.raw,
  );
  const fundingRaw = parsePositiveRawAmount(
    serverAdditionalDestinationAmount.raw,
  );
  if (requestedRaw == null || fundingRaw == null || fundingRaw > requestedRaw) {
    throw new Error("trade funding proposal lacks its exact shortfall");
  }
  return buildTelegramTradeShortfallRequest(
    {
      ...input,
      additionalFundingRaw: serverAdditionalDestinationAmount.raw,
    },
    proposal.serverExecutionProfileId,
    proposal.relayPersistentApprovalCapRaw,
  );
}

export function resolveTelegramTradeShortfallCommitAmounts(
  input: TelegramTradeShortfallIdentity,
  proposal: Pick<
    TelegramTradeShortfallProposal,
    | "requestedDestinationAmount"
    | "serverAdditionalDestinationAmount"
    | "serverExecutionProfileId"
    | "relayPersistentApprovalCapRaw"
  >,
): Readonly<{
  fundingDestinationAmount: Money;
  tradeDestinationAmount: Money;
}> {
  const request = buildTelegramTradeShortfallCommitRequest(input, proposal);
  const tradeDestinationAmount = request.requestedDestinationAmount;
  const fundingDestinationAmount = request.serverAdditionalDestinationAmount;
  if (!tradeDestinationAmount || !fundingDestinationAmount) {
    throw new Error("trade funding proposal lacks its exact shortfall");
  }
  return { fundingDestinationAmount, tradeDestinationAmount };
}

/**
 * A short-lived market quote is only the user's confirmation boundary. A
 * delegated Relay action has its own signed provider deadline and must retain
 * enough time for approve then deposit before we create an operation.
 */
export function assertTelegramTradeShortfallDelegatedRelayActionTtl(input: {
  plan: Readonly<{
    segments: readonly Readonly<{
      providerId: string;
      quoteExpiresAt: string;
    }>[];
    steps: readonly Readonly<{ actionExpiresAt?: string | null }>[];
  }>;
  profileId: string;
  now?: Date;
}): void {
  if (!relayEvmFundingProfileSpec(input.profileId)) return;
  const deadlines = [
    ...input.plan.segments
      .filter((segment) => segment.providerId === "relay")
      .map((segment) => Date.parse(segment.quoteExpiresAt)),
    ...input.plan.steps.flatMap((step) =>
      typeof step.actionExpiresAt === "string"
        ? [Date.parse(step.actionExpiresAt)]
        : [],
    ),
  ];
  const earliestDeadline = Math.min(...deadlines);
  const now = input.now ?? new Date();
  const configuration = loadRelayEvmExecutionConfiguration();
  if (
    deadlines.length === 0 ||
    !Number.isFinite(earliestDeadline) ||
    earliestDeadline - now.getTime() < configuration.minimumSequentialTtlMs
  ) {
    throw new Error(
      "trade funding delegated quote lacks sequential execution TTL",
    );
  }
}

/**
 * A receive-origin delegated route is activated only by its atomically linked
 * receipt. A shortfall route instead has a durable, user-confirmed trade
 * intent and its own cap reservation. Once both are linked in the same
 * transaction, activate exactly the initial Relay approval. The dependent
 * deposit remains planned until the approval receipt is finalized and
 * allowance ownership is anchored.
 */
export async function activateTelegramTradeShortfallInitialActionInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    profileId: string;
    tradeIntentId: string;
  }>,
): Promise<void> {
  const activated =
    await activateTelegramTradeShortfallInitialStepInTransaction(client, input);
  if (!activated) {
    throw new Error("trade funding initial action could not be activated");
  }
}

/** @deprecated Use the profile-aware activation helper above. */
export const activateTelegramTradeShortfallRelayApprovalInTransaction =
  activateTelegramTradeShortfallInitialActionInTransaction;

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
    option.requiredActions.some((action) => action.kind === "external_handoff")
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
    const sources = optionSourceAssets(option);
    if (
      sources.length === 1 &&
      sameAsset(sources[0] as AssetRef, {
        networkId: "evm:137",
        assetId:
          fundingSidecarRuntimeConfig.polymarketPusdAddress || POLYGON_PUSD,
        decimals: 6,
      })
    ) {
      return POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID;
    }
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

/**
 * The generic source planner is intentionally free to form the best economic
 * composite.  Telegram server execution is not: it must select one exact
 * policy/profile envelope.  Plan each supported envelope independently so a
 * non-executable composite cannot hide a viable single-source route.
 */
export function telegramTradeShortfallExecutionProfiles(
  venue: Venue,
  destination: AssetRef,
): readonly string[] {
  const profiles = Object.values(RELAY_EVM_FUNDING_PROFILE_SPECS)
    .filter(
      (profile) =>
        profile.venueIds.includes(venue) &&
        profile.routeIds.some((routeId) => {
          const route = RELAY_ROUTE_SPECS[routeId];
          return route ? sameAsset(route.destination, destination) : false;
        }),
    )
    .map((profile) => profile.profileId);
  if (venue !== "polymarket") return profiles;
  return [
    POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
    ...profiles,
  ];
}

function requiresPolymarketPusdRouterContinuation(
  venue: Venue,
  profileId: string,
): boolean {
  if (venue !== "polymarket") return false;
  const profile = relayEvmFundingProfileSpec(profileId);
  return (
    profile?.routeIds.some((routeId) => {
      const route = RELAY_ROUTE_SPECS[routeId];
      return route
        ? sameAsset(route.destination, destinationAsset("polymarket"))
        : false;
    }) ?? false
  );
}

function requiresExternalHandoff(option: SourceOption): boolean {
  return option.requiredActions.some(
    (action) => action.kind === "external_handoff",
  );
}

/**
 * Planner recommendations are allowed to change after delegated authority is
 * provisioned. They must not replace a server-executable source with a
 * Deposit-Wallet handoff merely because that handoff has a larger balance.
 */
export function selectTelegramTradeShortfallAutomatedOption(input: {
  options: readonly SourceOption[];
  venue: Venue;
  destination: AssetRef;
  requiredProfileId?: string;
}): Readonly<{ option: SourceOption; profileId: string }> | null {
  const candidates = input.options.flatMap((option) => {
    if (
      !option.selectable ||
      option.experienceMode === "unavailable" ||
      requiresExternalHandoff(option)
    ) {
      return [];
    }
    const profileId =
      input.requiredProfileId &&
      isPolymarketDepositRouterProfileId(input.requiredProfileId) &&
      option.kind === "venue_preparation" &&
      option.source.kind === "venue_preparation" &&
      option.source.venueId === "polymarket"
        ? input.requiredProfileId
        : resolveTelegramTradeShortfallExecutionProfile(
            option,
            input.venue,
            input.destination,
          );
    if (
      !profileId ||
      (input.requiredProfileId && profileId !== input.requiredProfileId)
    ) {
      return [];
    }
    return [{ option, profileId }];
  });
  return (
    candidates.find((candidate) => candidate.option.recommended) ??
    candidates[0] ??
    null
  );
}

/**
 * Freeze the exact funding leg that the selected server route can actually
 * guarantee. A trade can be short by less than a route's executable floor
 * (for example, a $0.324 pUSD gap with a $0.50 Relay minimum). Replanning
 * only the gap would make the same selected route fail its own economics
 * checks. The residual stays as controller collateral for the same Buy.
 */
export function selectedTelegramTradeShortfallFundingRaw(
  input: Readonly<{
    collateralAsset: AssetRef;
    requestedCollateralRaw: string;
    shortfallRaw: string;
    option: Pick<SourceOption, "minimumDestination">;
  }>,
): string | null {
  const minimumDestination = input.option.minimumDestination;
  if (
    !minimumDestination ||
    !sameAsset(minimumDestination.asset, input.collateralAsset) ||
    !isPositiveRawAmount(input.shortfallRaw) ||
    !isPositiveRawAmount(input.requestedCollateralRaw)
  ) {
    return null;
  }
  const minimumRaw = parsePositiveRawAmount(minimumDestination.raw);
  const shortfallRaw = parsePositiveRawAmount(input.shortfallRaw);
  const requestedCollateralRaw = parsePositiveRawAmount(
    input.requestedCollateralRaw,
  );
  if (
    minimumRaw == null ||
    shortfallRaw == null ||
    requestedCollateralRaw == null
  ) {
    return null;
  }
  if (minimumRaw < shortfallRaw || minimumRaw > requestedCollateralRaw) {
    return null;
  }
  return minimumDestination.raw;
}

/**
 * The delegated replan may intentionally fund more than the economic gap to
 * satisfy a route floor. The destination balance is stable when that gap is
 * unchanged between planning passes; it is not required to equal the larger
 * funding leg.
 */
export function isTelegramTradeShortfallBalanceStable(
  initialShortfallRaw: string,
  replannedShortfallRaw: string,
): boolean {
  return (
    isPositiveRawAmount(initialShortfallRaw) &&
    initialShortfallRaw === replannedShortfallRaw
  );
}

function proposalSourceAmounts(
  option: SourceOption,
  profileId: string,
  destination: Money,
): FundingQuoteSummary["sourceAmounts"] {
  const sourceLegAmounts = option.sourceLegs?.map((leg) => ({
    safeLabel: leg.safeLabel,
    amount: leg.sourceAmount,
  }));
  if (sourceLegAmounts?.length) return sourceLegAmounts;
  if (
    option.source.kind === "owned_location" &&
    option.maximumSourceRaw != null
  ) {
    return [
      {
        safeLabel: option.safeLabel,
        amount: {
          asset: option.source.location.asset,
          raw: option.maximumSourceRaw,
        },
      },
    ];
  }
  if (
    option.source.kind === "venue_preparation" &&
    option.maximumSourceRaw != null &&
    isPolymarketDepositRouterProfileId(profileId)
  ) {
    return [
      {
        safeLabel: option.safeLabel,
        amount: {
          asset:
            profileId === POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID
              ? {
                  networkId: "evm:137",
                  assetId: POLYGON_USDCE_LEGACY,
                  decimals: 6,
                }
              : destination.asset,
          raw: option.maximumSourceRaw,
        },
      },
    ];
  }
  return [];
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
  serverAdditionalDestinationAmount: Money,
  relayPersistentApprovalCapRaw?: string,
): TelegramTradeShortfallProposal {
  if (
    !projection.destinationOptionId ||
    !projection.venueBindingOptionId ||
    !option.expectedDestination ||
    !option.minimumDestination
  ) {
    throw new Error("trade funding quote is missing its exact destination");
  }
  const sourceAmounts = proposalSourceAmounts(
    option,
    profileId,
    option.expectedDestination,
  );
  if (sourceAmounts.length === 0) {
    throw new Error("trade funding route has no exact source amount");
  }
  const body = {
    version: 1 as const,
    kind: "internal_stable_route" as const,
    liquidityProjectionId: projection.liquidityProjectionId,
    selectedSourceOptionId: option.sourceOptionId,
    serverExecutionProfileId: profileId,
    ...(relayPersistentApprovalCapRaw ? { relayPersistentApprovalCapRaw } : {}),
    sourceAmounts,
    expectedDestination: option.expectedDestination,
    minimumDestination: option.minimumDestination,
    fees: option.fees,
    eta: option.eta,
    destinationOptionId: projection.destinationOptionId,
    venueBindingOptionId: projection.venueBindingOptionId,
    serverAdditionalDestinationAmount,
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

  /**
   * Builds a sealed client-execution envelope for a shortfall. This is not an
   * operation commit and does not grant an authority: it is a read-only
   * generic plan inspection used immediately before Telegram seals v2.
   */
  async inspectMiniAppFunding(
    input: TelegramTradeShortfallIdentity,
    trade: JsonObject,
  ): Promise<TelegramTradeMiniAppFundingInspection> {
    const observedBalanceInput: TelegramTradeShortfallIdentity = {
      ...input,
      additionalFundingRaw: undefined,
      additionalFundingUsd: undefined,
    };
    let observed;
    try {
      observed = await this.runtime.liquidity(
        input.userId,
        buildTelegramTradeShortfallRequest(observedBalanceInput),
      );
    } catch (error) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [shortfallPlannerFailureReasonCode(error)],
      };
    }
    if (observed.completeness !== "complete" || observed.errors.length > 0) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [
          ...observed.reasonCodes,
          ...observed.errors.map((error) => error.code),
        ],
      };
    }
    if (!isPositiveRawAmount(observed.shortfallRaw)) {
      return { kind: "destination_ready" };
    }
    const exactInput: TelegramTradeShortfallIdentity = {
      ...input,
      additionalFundingRaw: observed.shortfallRaw,
      additionalFundingUsd: undefined,
    };
    const discoveryRequest = buildTelegramTradeShortfallRequest(exactInput);
    let plan;
    try {
      plan = await this.runtime.liquidity(input.userId, discoveryRequest);
    } catch (error) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [shortfallPlannerFailureReasonCode(error)],
      };
    }
    if (plan.completeness !== "complete" || plan.errors.length > 0) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [
          ...plan.reasonCodes,
          ...plan.errors.map((error) => error.code),
        ],
      };
    }
    if (plan.shortfallRaw !== observed.shortfallRaw) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["handoff_destination_balance_changed"],
      };
    }
    const capability = resolveTelegramAppHandoffFundingCapability({
      projection: plan,
      serverBotExact: false,
    });
    if (capability.kind === "external_deposit") {
      return { kind: "external_deposit" };
    }
    if (capability.kind !== "web_funding_plan") {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [
          capability.kind === "unavailable"
            ? capability.reason
            : "unexpected_server_funding_capability",
        ],
      };
    }
    return {
      kind: "web_funding_plan",
      plan: buildTelegramAppHandoffV2Plan({
        discoveryRequest,
        fundingPolicyRevision: await this.runtime.currentPolicyRevision(),
        projection: plan,
        trade,
      }),
    };
  }

  async inspect(
    input: TelegramTradeShortfallIdentity,
    options: Readonly<{ requiredProfileId?: string }> = {},
  ): Promise<TelegramTradeShortfallInspection> {
    // This is accounting repair, not a route retry.  A prior shortfall may
    // have reached the venue, then lost its consumer before submission.  Its
    // terminal source reservation must not suppress the fresh plan's real
    // wallet balance.
    await tx(this.pool, async (client) => {
      const completed = await client.query<{ id: string }>(
        `
          select id
          from funding_operations
          where user_id = $1
            and purpose = 'trade_shortfall'
            and status = 'completed'
            and progress_stage = 'terminal'
            and exists (
              select 1
              from balance_reservations reservation
              where reservation.operation_id = funding_operations.id
                and reservation.user_id = funding_operations.user_id
                and reservation.state = 'active'
                and reservation.mode <> 'settled_for_consumer'
            )
          order by updated_at
          for update
        `,
        [input.userId],
      );
      for (const operation of completed.rows) {
        await releaseCompletedTradeShortfallSourceReservationsInTransaction(
          client,
          {
            operationId: operation.id,
            userId: input.userId,
          },
        );
      }
    });
    const destination = destinationAsset(input.venue);
    // A Telegram card's preliminary balance can include assets only the web
    // composite flow can consume.  The server executor must first let the
    // planner observe the selected venue destination without that estimate,
    // then bind the delegated quote to the resulting exact raw shortfall.
    const observedBalanceInput: TelegramTradeShortfallIdentity = {
      ...input,
      additionalFundingRaw: undefined,
      additionalFundingUsd: undefined,
    };
    const plannedCandidates: Array<
      Readonly<{
        plan: Awaited<ReturnType<FundingPlanningRuntime["liquidity"]>>;
        profileId: string;
        fundingDestinationRaw: string;
        relayPersistentApprovalCapRaw?: string;
      }>
    > = [];
    let completedProfileInspection = false;
    const unavailableReasonCodes: string[] = [];
    const profileIds = options.requiredProfileId
      ? [options.requiredProfileId]
      : telegramTradeShortfallExecutionProfiles(input.venue, destination);
    for (const profileId of profileIds) {
      let plan: Awaited<ReturnType<FundingPlanningRuntime["liquidity"]>>;
      try {
        plan = await this.runtime.liquidity(
          input.userId,
          buildTelegramTradeShortfallRequest(observedBalanceInput, profileId),
        );
      } catch (error) {
        const reasonCode = shortfallPlannerFailureReasonCode(error);
        console.warn("[telegram-trade-shortfall] profile inspection failed", {
          errorMessage:
            error instanceof Error ? error.message : "unknown_error",
          errorName: error instanceof Error ? error.name : typeof error,
          profileId,
          reasonCode,
        });
        unavailableReasonCodes.push(reasonCode);
        continue;
      }
      if (plan.completeness !== "complete" || plan.errors.length > 0) {
        unavailableReasonCodes.push(
          ...plan.reasonCodes,
          ...plan.errors.map((error) => error.code),
        );
        continue;
      }
      completedProfileInspection = true;
      const automated = selectTelegramTradeShortfallAutomatedOption({
        options: plan.sourceOptions,
        venue: input.venue,
        destination,
        requiredProfileId: profileId,
      });
      if (automated) {
        const fundingDestinationRaw = selectedTelegramTradeShortfallFundingRaw({
          collateralAsset: plan.collateralAsset,
          requestedCollateralRaw: plan.requestedCollateralRaw,
          shortfallRaw: plan.shortfallRaw,
          option: automated.option,
        });
        if (fundingDestinationRaw) {
          plannedCandidates.push({
            plan,
            profileId: automated.profileId,
            fundingDestinationRaw,
          });
        } else {
          unavailableReasonCodes.push(
            "internal_route_shortfall_amount_unavailable",
          );
        }
      }
    }
    if (plannedCandidates.length === 0) {
      if (!completedProfileInspection && unavailableReasonCodes.length > 0) {
        return {
          kind: "temporarily_unavailable",
          reasonCodes: [...new Set(unavailableReasonCodes)],
        };
      }
      // This is a complete, safe planning result, but none of the exact
      // server-policy envelopes can execute it. Preserve the Buy and use the
      // ordinary verified Deposit path; never claim that a retry will make an
      // unsupported composite executable.
      return { kind: "external_deposit_required" };
    }
    const controller = await resolveTelegramFundingProvisionWallet(this.pool, {
      userId: input.userId,
      telegramAccountId: input.telegramAccountId,
      telegramUserId: input.telegramUserId,
      controllerNetworkId: input.venue === "limitless" ? "evm:8453" : "evm:137",
      executionVenueId: input.venue,
    });
    if (!controller) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_controller_wallet_unavailable"],
      };
    }
    let candidate: (typeof plannedCandidates)[number] | null = null;
    for (const plannedCandidate of plannedCandidates) {
      if (
        !plannedCandidate.plan.destinationOptionId ||
        !plannedCandidate.plan.venueBindingOptionId
      ) {
        unavailableReasonCodes.push(
          "internal_route_destination_binding_unavailable",
        );
        continue;
      }
      const authorizationInput = {
        userId: input.userId,
        telegramAccountId: input.telegramAccountId,
        telegramUserId: input.telegramUserId,
        controllerWalletId: controller.controllerWalletId,
        destinationOptionId: plannedCandidate.plan.destinationOptionId,
        venueBindingOptionId: plannedCandidate.plan.venueBindingOptionId,
        venueId: input.venue,
      } as const;
      const provisioned = isPolymarketDepositRouterProfileId(
        plannedCandidate.profileId,
      )
        ? await ensureTelegramFundingAuthorization(this.pool, {
            ...authorizationInput,
            profileId: plannedCandidate.profileId as
              | typeof POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID
              | typeof POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
          })
        : await ensureTelegramRelayEvmFundingAuthorization(this.pool, {
            ...authorizationInput,
            profileId: plannedCandidate.profileId,
          });
      if (!provisioned) {
        unavailableReasonCodes.push(
          "internal_route_delegated_authority_unavailable",
        );
        continue;
      }
      // A Relay route that reaches Polygon pUSD only prepares controller
      // funds. Its mandatory next leg is the exact Router fund action, so do
      // not commit the root unless that child authority is already durable.
      if (
        requiresPolymarketPusdRouterContinuation(
          input.venue,
          plannedCandidate.profileId,
        ) &&
        !(await ensureTelegramFundingAuthorization(this.pool, {
          ...authorizationInput,
          profileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
        }))
      ) {
        unavailableReasonCodes.push(
          "internal_route_router_authority_unavailable",
        );
        continue;
      }
      candidate = {
        ...plannedCandidate,
        ...(relayEvmFundingProfileSpec(plannedCandidate.profileId) &&
        provisioned.maxSourceRaw
          ? { relayPersistentApprovalCapRaw: provisioned.maxSourceRaw }
          : {}),
      };
      break;
    }
    if (!candidate) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [...new Set(unavailableReasonCodes)],
      };
    }
    const profileId = candidate.profileId;
    // The generic preview can include controller assets that the delegated
    // profile cannot consume. Requote exactly the selected route's guaranteed
    // funding amount, rather than a smaller display-only shortfall.
    const exactAdditionalRaw = candidate.fundingDestinationRaw;
    const exactInput: TelegramTradeShortfallIdentity = {
      ...input,
      additionalFundingRaw: exactAdditionalRaw,
      additionalFundingUsd: undefined,
    };
    let delegatedPlan: Awaited<ReturnType<FundingPlanningRuntime["liquidity"]>>;
    try {
      delegatedPlan = await this.runtime.liquidity(
        input.userId,
        buildTelegramTradeShortfallRequest(
          exactInput,
          profileId,
          candidate.relayPersistentApprovalCapRaw,
        ),
      );
    } catch (error) {
      const reasonCode = shortfallPlannerFailureReasonCode(error);
      console.warn(
        "[telegram-trade-shortfall] delegated profile recheck failed",
        {
          errorMessage:
            error instanceof Error ? error.message : "unknown_error",
          errorName: error instanceof Error ? error.name : typeof error,
          profileId,
          reasonCode,
        },
      );
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [reasonCode],
      };
    }
    if (
      delegatedPlan.completeness !== "complete" ||
      delegatedPlan.errors.length > 0
    ) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: [
          ...delegatedPlan.reasonCodes,
          ...delegatedPlan.errors.map((error) => error.code),
        ],
      };
    }
    if (
      !isTelegramTradeShortfallBalanceStable(
        candidate.plan.shortfallRaw,
        delegatedPlan.shortfallRaw,
      )
    ) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_destination_balance_changed"],
      };
    }
    const delegatedAutomated = selectTelegramTradeShortfallAutomatedOption({
      options: delegatedPlan.sourceOptions,
      venue: input.venue,
      destination,
      requiredProfileId: profileId,
    });
    if (!delegatedAutomated) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_changed_during_delegated_planning"],
      };
    }
    const delegatedRequest = buildTelegramTradeShortfallRequest(
      exactInput,
      profileId,
      candidate.relayPersistentApprovalCapRaw,
    );
    const serverAdditionalDestinationAmount =
      delegatedRequest.serverAdditionalDestinationAmount;
    if (!serverAdditionalDestinationAmount) {
      return {
        kind: "temporarily_unavailable",
        reasonCodes: ["internal_route_shortfall_amount_unavailable"],
      };
    }
    return {
      kind: "internal_route",
      proposal: proposalFromOption(
        delegatedPlan,
        delegatedAutomated.option,
        profileId,
        serverAdditionalDestinationAmount,
        candidate.relayPersistentApprovalCapRaw,
      ),
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
    if (
      input.proposal.relayPersistentApprovalCapRaw != null &&
      !isPositiveRawAmount(input.proposal.relayPersistentApprovalCapRaw)
    ) {
      throw new Error("trade funding Relay approval cap is invalid");
    }
    const commitAmounts = resolveTelegramTradeShortfallCommitAmounts(
      input,
      input.proposal,
    );
    const requestedDestinationAmount = commitAmounts.tradeDestinationAmount;
    const fundingDestinationAmount = commitAmounts.fundingDestinationAmount;
    if (
      !requestedDestinationAmount ||
      !fundingDestinationAmount ||
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
      // The saved source option is a quote for the shortfall leg, not the
      // complete Buy ceiling. The full ceiling above remains independently
      // bound to the proposal and is used by the later Buy Review.
      requestedDestinationAmount: fundingDestinationAmount,
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
    const pUsdAsset: AssetRef = {
      networkId: "evm:137",
      assetId:
        fundingSidecarRuntimeConfig.polymarketPusdAddress || POLYGON_PUSD,
      decimals: 6,
    };
    const routerPusdFunding =
      input.proposal.serverExecutionProfileId ===
      POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID;
    const routerSourcesValid =
      routerPusdFunding &&
      quote.sourceAmounts.length >= 1 &&
      quote.sourceAmounts.length <= 2 &&
      quote.sourceAmounts.some((source) =>
        sameAsset(source.amount.asset, pUsdAsset),
      ) &&
      quote.sourceAmounts.every(
        (source) =>
          sameAsset(source.amount.asset, pUsdAsset) ||
          sameAsset(source.amount.asset, {
            networkId: "evm:137",
            assetId: POLYGON_USDCE_LEGACY,
            decimals: 6,
          }),
      );
    const exactSourceAsset = routerPusdFunding
      ? pUsdAsset
      : quote.sourceAmounts[0]?.amount.asset;
    if (
      !exactSourceAsset ||
      (!routerSourcesValid && quote.sourceAmounts.length !== 1)
    ) {
      throw new Error(
        "trade funding delegated execution requires its exact permitted stable source set",
      );
    }
    const securityClass = isPolymarketDepositRouterProfileId(
      input.proposal.serverExecutionProfileId,
    )
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
    const routerContinuationRequired = requiresPolymarketPusdRouterContinuation(
      input.venue,
      input.proposal.serverExecutionProfileId,
    );
    const routerAuthorization = routerContinuationRequired
      ? await loadActiveTelegramFundingAuthorization(this.pool, {
          userId: input.userId,
          telegramAccountId: input.telegramAccountId,
          telegramUserId: input.telegramUserId,
          destinationOptionId: quote.destinationOptionId as string,
          venueBindingOptionId: quote.venueBindingOptionId as string,
          venueId: "polymarket",
          profileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
          securityClass: "closed_destination_transform",
          sourceAsset: pUsdAsset,
          destinationAsset: pUsdAsset,
          requireTradingEnabled: true,
        })
      : null;
    if (routerContinuationRequired && !routerAuthorization) {
      throw new Error("trade funding Router authorization is unavailable");
    }
    const relayProfile = relayEvmFundingProfileSpec(
      input.proposal.serverExecutionProfileId,
    );
    const relayAllowanceBaseline = relayProfile
      ? await captureRelayEvmAllowanceBaseline(relayProfile, {
          owner: fundingAuthorization.walletAddress,
        })
      : null;
    const prepared = await this.runtime.prepareCommit(input.userId, {
      quoteId: quote.quoteId,
      consentToken: quote.consentToken,
      idempotencyKey: `telegram-trade-funding:${input.tradeIntentId}`,
    });
    assertTelegramTradeShortfallDelegatedRelayActionTtl({
      plan: prepared.operation.quote.planSnapshot,
      profileId: input.proposal.serverExecutionProfileId,
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
        throw new TelegramTradeShortfallCommitError(
          "allowance_lane_unavailable",
          "trade funding allowance lane is unavailable",
        );
      }
      const lockedIntent = await client.query<{ status: string }>(
        `select status
           from telegram_trade_intents
          where id = $1::uuid
            and user_id = $2::uuid
            and authorization_id = $3::uuid
            and status = $4
            and funding_operation_id is null
            and submit_started_at is null
          for update`,
        [
          input.tradeIntentId,
          input.userId,
          input.authorizationId,
          "confirming",
        ],
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
      if (
        relayEvmFundingProfileSpec(input.proposal.serverExecutionProfileId) &&
        input.proposal.relayPersistentApprovalCapRaw != null &&
        input.proposal.relayPersistentApprovalCapRaw !==
          lockedAuthorization.maxSourceRaw
      ) {
        throw new Error("trade funding Relay approval cap changed");
      }
      if (routerContinuationRequired) {
        const lockedRouterAuthorization =
          await loadActiveTelegramFundingAuthorization(client, {
            userId: input.userId,
            telegramAccountId: input.telegramAccountId,
            telegramUserId: input.telegramUserId,
            destinationOptionId: quote.destinationOptionId as string,
            venueBindingOptionId: quote.venueBindingOptionId as string,
            venueId: "polymarket",
            expectedAuthorizationId: routerAuthorization?.id,
            profileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
            securityClass: "closed_destination_transform",
            sourceAsset: pUsdAsset,
            destinationAsset: pUsdAsset,
            lock: true,
            requireTradingEnabled: true,
          });
        if (!lockedRouterAuthorization) {
          throw new Error("trade funding Router authorization changed");
        }
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
                ) || $6::jsonb,
                updated_at = clock_timestamp(),
                version = version + 1
          where id = $1::uuid and user_id = $2::uuid`,
        [
          operationId,
          input.userId,
          lockedAuthorization.id,
          telegramFundingAuthorizationFingerprint(lockedAuthorization),
          input.tradeIntentId,
          JSON.stringify({
            ...(relayAllowanceBaseline
              ? relayEvmAllowanceBaselineSupportMetadata(relayAllowanceBaseline)
              : {}),
          }),
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
      await activateTelegramTradeShortfallInitialActionInTransaction(client, {
        operationId,
        profileId: input.proposal.serverExecutionProfileId,
        tradeIntentId: input.tradeIntentId,
      });
      return { operationId };
    });
  }
}
