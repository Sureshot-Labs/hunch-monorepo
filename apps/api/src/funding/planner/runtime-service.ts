import type { Pool } from "@hunch/infra";

import { buildAccountValueReadModel } from "../../account-value/runtime-service.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import {
  resolveTradeMarketByRef,
  resolveTradeMarketOutcomeIdentity,
  type ApiTradeMarket,
} from "../../services/api-trading-market-repo.js";
import { canonicalJsonHash, lookupHmac } from "../persistence/canonical.js";
import {
  fetchFundingOperationForUser,
  listFundingOperationsForUser,
} from "../persistence/funding-operation-repository.js";
import { listFundingOperationStepsForUser } from "../persistence/funding-evidence-repository.js";
import {
  createOrReplayFundingPreparationRun,
  fetchFundingPreparationRun,
  reportFundingPreparationAction,
  resolveFundingPreparationRun,
  type FundingPreparationActionReport,
  type FundingPreparationRun,
  type FundingPreparationRunRequest,
} from "../persistence/funding-preparation-run-repository.js";
import { PostgresFundingPlanningStore } from "../persistence/funding-planning-repository.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import { recommendFundingDestinations } from "./destination-adapters.js";
import {
  fundingDestinationEnabled,
  fundingVenueReceiveEnabled,
} from "../policies/funding-policy-v2.js";
import type {
  FundingCommitRequest,
  FundingDestinationOption,
  FundingDiscoveryRequest,
  FundingQuoteRequest,
  IntentLiquidityProjection,
  PreparationPurpose,
} from "../domain/types.js";
import type { PreparationResult } from "../domain/contracts.js";
import { FundingPlanner } from "./planner.js";
import { FundingQuoteService } from "./quote-service.js";
import { FundingOperationService } from "./operation-service.js";
import {
  canonicalMarketUpdatedAt,
  matchesCanonicalMarketIdentity,
} from "./market-context-revision.js";
import { FundingPlannerError } from "./money.js";
import { WalletPreparationRuntimeService } from "../preparation/runtime-service.js";
import { ProductionFundingSourcePlanner } from "./production-source-planner.js";
import { PolymarketFundingSourceAdapter } from "../preparation/polymarket-funding-source-adapter.js";
import { DirectIngressFundingSourceAdapter } from "./direct-ingress-source-adapter.js";
import { parsePositiveInteger } from "../runtime/positive-integer.js";
import {
  FundingOperationActionRuntime,
  type FundingActionReportOutcome,
} from "../execution/operation-action-runtime.js";
import { WithdrawalDestinationRuntime } from "../execution/withdrawal-destination-runtime.js";
import { sameAsset } from "../domain/asset-identity.js";

const SUBJECT_FINGERPRINT_DOMAIN = "hunch:funding:subject:v1:";
const PREPARATION_RUN_TTL_MS = 15 * 60_000;

export type FundingDestinationQuery = Readonly<{
  purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw";
  marketContextId?: string | null;
  marketClass?: string | null;
  positionActionRef?: string | null;
  controllerWalletRef?: string | null;
}>;

export class FundingLiquiditySingleflight {
  private readonly inflight = new Map<
    string,
    Promise<IntentLiquidityProjection>
  >();

  run(
    userId: string,
    request: FundingDiscoveryRequest,
    discover: () => Promise<IntentLiquidityProjection>,
  ): Promise<IntentLiquidityProjection> {
    const key = canonicalJsonHash({
      userId,
      request: {
        ...request,
        controllerWalletRef: request.controllerWalletRef ?? null,
      },
    });
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const started = Promise.resolve()
      .then(discover)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, started);
    return started;
  }
}

export class FundingPlanningRuntime {
  private readonly planningStore: PostgresFundingPlanningStore;
  private readonly preparationRuntime: WalletPreparationRuntimeService;
  private readonly actionRuntime: FundingOperationActionRuntime;
  private readonly withdrawalRuntime: WithdrawalDestinationRuntime;
  private readonly liquiditySingleflight = new FundingLiquiditySingleflight();

  constructor(private readonly db: Pool) {
    this.planningStore = new PostgresFundingPlanningStore(db);
    this.preparationRuntime = new WalletPreparationRuntimeService(db);
    this.actionRuntime = new FundingOperationActionRuntime(db);
    this.withdrawalRuntime = new WithdrawalDestinationRuntime(db);
  }

  registerWithdrawalDestination(
    userId: string,
    input: Readonly<{
      asset: Readonly<{
        networkId: string;
        assetId: string;
        decimals: number;
      }>;
      address: string;
    }>,
  ) {
    return this.withdrawalRuntime.register(userId, input);
  }

  revokeWithdrawalDestination(userId: string, recipientId: string) {
    return this.withdrawalRuntime.revoke(userId, recipientId);
  }

  async capabilities() {
    const resolvedPolicy = await resolveFundingPolicy(this.db);
    return {
      fundingApiVersion: 1 as const,
      receiveSessionsVersion: 1 as const,
      creationMode: resolvedPolicy.policy.creationMode,
      destinationVenues: resolvedPolicy.policy.venues
        .filter((venue) =>
          fundingVenueReceiveEnabled(resolvedPolicy.policy, venue.venueId),
        )
        .map((venue) => venue.venueId)
        .sort((left, right) => left.localeCompare(right)),
      supportedActionKinds: [
        "add_funds",
        "trade_shortfall",
        "convert_asset",
        "withdrawal",
        "redeem",
      ] as const,
    };
  }

  async destinations(
    userId: string,
    query: FundingDestinationQuery,
  ): Promise<readonly FundingDestinationOption[]> {
    return (await this.destinationAccess(userId, query)).options;
  }

  async destinationAccess(
    userId: string,
    query: FundingDestinationQuery,
  ): Promise<
    Readonly<{
      options: readonly FundingDestinationOption[];
      policyDisabledOptions: readonly FundingDestinationOption[];
    }>
  > {
    const [resolvedPolicy, rawOptions] = await Promise.all([
      resolveFundingPolicy(this.db),
      this.preparationRuntime.listDestinationOptions({
        accountId: userId,
        purpose: query.purpose,
        marketContextId: query.marketContextId ?? null,
        marketClass: query.marketClass ?? null,
        positionActionRef: query.positionActionRef ?? null,
        compatibleVenueBindingOptionIds: null,
        controllerWalletRef: query.controllerWalletRef ?? null,
      }),
    ]);
    const options: FundingDestinationOption[] = [];
    const policyDisabledOptions: FundingDestinationOption[] = [];
    for (const option of rawOptions) {
      (fundingDestinationEnabled(resolvedPolicy.policy, option, query.purpose)
        ? options
        : policyDisabledOptions
      ).push(option);
    }
    return {
      options:
        query.purpose === "fund"
          ? recommendFundingDestinations(
              options,
              resolvedPolicy.policy.genericAddFundsRecommendationOrder,
            )
          : options,
      policyDisabledOptions,
    };
  }

  inspectPreparation(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
      positionActionRef?: string | null;
      controllerWalletRef?: string | null;
    }>,
  ): Promise<PreparationResult> {
    return this.preparationRuntime.inspectBindingOption({
      accountId: userId,
      venueBindingOptionId: request.venueBindingOptionId,
      purpose: request.purpose,
      marketContextId: request.marketContextId,
      marketClass: request.marketClass,
      positionActionRef: request.positionActionRef ?? null,
      compatibleVenueBindingOptionIds: [request.venueBindingOptionId],
      controllerWalletRef: request.controllerWalletRef ?? null,
    });
  }

  async prepare(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
      positionActionRef?: string | null;
      controllerWalletRef?: string | null;
      operationId?: string;
      expectedInspectionRevision: string;
    }>,
  ): Promise<FundingPreparationRun> {
    const resolvedMarket = request.marketContextId
      ? await resolveTradeMarketByRef(this.db, request.marketContextId)
      : null;
    const snapshot: FundingPreparationRunRequest = {
      venueBindingOptionId: request.venueBindingOptionId,
      purpose: request.purpose,
      marketContextId: resolvedMarket?.market.id ?? request.marketContextId,
      marketClass: request.marketClass,
      positionActionRef: request.positionActionRef ?? null,
      controllerWalletRef: request.controllerWalletRef ?? null,
      expectedInspectionRevision: request.expectedInspectionRevision,
    };
    return createOrReplayFundingPreparationRun(this.db, {
      userId,
      request: snapshot,
      expiresAt: new Date(Date.now() + PREPARATION_RUN_TTL_MS),
      materialize: (runId) =>
        this.preparationRuntime.prepareBindingOption({
          accountId: userId,
          venueBindingOptionId: snapshot.venueBindingOptionId,
          purpose: snapshot.purpose,
          marketContextId: snapshot.marketContextId,
          marketClass: snapshot.marketClass,
          positionActionRef: snapshot.positionActionRef,
          compatibleVenueBindingOptionIds: [snapshot.venueBindingOptionId],
          controllerWalletRef: snapshot.controllerWalletRef,
          operationId: runId,
          expectedInspectionRevision: snapshot.expectedInspectionRevision,
        }),
    });
  }

  preparationRun(userId: string, runId: string) {
    return fetchFundingPreparationRun(this.db, { userId, runId });
  }

  reportPreparationAction(
    userId: string,
    input: Readonly<{
      runId: string;
      actionId: string;
      report: FundingPreparationActionReport;
    }>,
  ) {
    return reportFundingPreparationAction(this.db, {
      userId,
      runId: input.runId,
      actionId: input.actionId,
      report: input.report,
    });
  }

  async reconcilePreparationRun(
    userId: string,
    runId: string,
  ): Promise<FundingPreparationRun | null> {
    const run = await fetchFundingPreparationRun(this.db, { userId, runId });
    if (!run || run.status === "succeeded" || run.status === "expired") {
      return run;
    }
    const preparation = await this.inspectPreparation(userId, run.request);
    return resolveFundingPreparationRun(this.db, {
      userId,
      runId,
      succeeded: preparation.status === "ready",
    });
  }

  liquidity(
    userId: string,
    request: FundingDiscoveryRequest,
  ): Promise<IntentLiquidityProjection> {
    return this.liquiditySingleflight.run(userId, request, () =>
      this.discoverLiquidity(userId, request),
    );
  }

  private async discoverLiquidity(
    userId: string,
    request: FundingDiscoveryRequest,
  ): Promise<IntentLiquidityProjection> {
    let resolvedMarketForPreparation: ApiTradeMarket | null = null;
    const accountPromise = buildAccountValueReadModel({
      pool: this.db,
      userId,
    });
    // Discovery can resolve the market and inspect its exact destination while
    // the authoritative owned-source inventory is being collected. Keep the
    // same account snapshot for source selection and ownership persistence;
    // only remove the former sequential wait between these independent reads.
    void accountPromise.catch(() => undefined);
    const resolvedPolicy = await resolveFundingPolicy(this.db);
    const sourcePlannerPromise = accountPromise.then(
      (account) =>
        new ProductionFundingSourcePlanner(this.db, account, [
          new PolymarketFundingSourceAdapter(account),
          new DirectIngressFundingSourceAdapter(account),
        ]),
    );
    const planner = new FundingPlanner({
      listDestinations: async ({ accountId, request, marketContext }) =>
        this.preparationRuntime.resolvedCandidates(
          {
            accountId,
            purpose:
              request.purpose === "trade_shortfall"
                ? "buy"
                : request.purpose === "withdrawal"
                  ? "withdraw"
                  : "fund",
            marketContextId: marketContext?.marketId ?? null,
            marketClass: null,
            compatibleVenueBindingOptionIds:
              request.venueBindingOptionId != null
                ? [request.venueBindingOptionId]
                : marketContext &&
                    marketContext.compatibleVenueBindingOptionIds.length > 0
                  ? marketContext.compatibleVenueBindingOptionIds
                  : null,
            controllerWalletRef: request.controllerWalletRef ?? null,
          },
          resolvedMarketForPreparation,
        ),
      resolveMarketContext: async ({ marketContextId }) => {
        const requestedAmount = request.requestedDestinationAmount;
        const consumerIntent = request.consumerIntent;
        if (!requestedAmount || !consumerIntent) {
          throw new FundingPlannerError(
            "invalid_market_context",
            "trade funding requires an exact normalized consumer intent",
          );
        }
        const resolved = await resolveTradeMarketOutcomeIdentity(this.db, {
          venue: consumerIntent.venueId,
          marketId: consumerIntent.marketId,
          marketContextId,
        });
        if (!resolved?.market || !resolved.side) return null;
        const market = resolved.market;
        if (
          !matchesCanonicalMarketIdentity(consumerIntent, market) ||
          consumerIntent.marketContextId !== marketContextId ||
          consumerIntent.side !== "BUY" ||
          !sameAsset(consumerIntent.spend.asset, requestedAmount.asset) ||
          BigInt(requestedAmount.raw) < BigInt(consumerIntent.spend.raw)
        ) {
          throw new FundingPlannerError(
            "invalid_market_context",
            "trade consumer intent differs from the resolved funding market",
          );
        }
        resolvedMarketForPreparation = market;
        // The opaque binding is still revalidated by the one authoritative
        // destination discovery below. Do not perform the same live wallet
        // inspection once here merely to rediscover an ID the client already
        // selected, and then immediately perform it again for placement.
        const explicitBindingOptionId = request.venueBindingOptionId;
        const compatibleVenueBindingOptionIds = explicitBindingOptionId
          ? [explicitBindingOptionId]
          : [];
        const now = new Date();
        return {
          marketContextId,
          venueId: market.venue,
          marketId: market.id,
          side: resolved.side,
          executionProfileId: `funding_${market.venue}_buy_v1`,
          marketPriceRevision: stableOpaqueId(
            "market_revision",
            canonicalJsonHash({
              marketId: market.id,
              side: resolved.side,
              status: market.status,
              acceptingOrders: market.accepting_orders,
              updatedAt: canonicalMarketUpdatedAt(market.updated_at),
            }),
          ),
          collateralAsset: consumerIntent.spend.asset,
          requestedCollateralRaw: consumerIntent.spend.raw,
          compatibleVenueBindingOptionIds,
          expiresAt: new Date(
            now.getTime() + resolvedPolicy.policy.ttl.quoteMs,
          ).toISOString(),
        };
      },
      resolveWithdrawalRecipient: async ({ accountId, recipientId }) =>
        this.withdrawalRuntime.resolve(accountId, recipientId),
      listSources: async (sourceInput) =>
        (await sourcePlannerPromise).list(sourceInput),
      discoverSources: async (sourceInput) =>
        (await sourcePlannerPromise).discover(sourceInput),
      listSourceBlockers: async (sourceInput) =>
        (await sourcePlannerPromise).listBlockingReasonCodes(sourceInput),
      store: this.planningStore,
    });
    return planner.discover({
      accountId: userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: accountPromise.then(
        (account) => account.ownershipEvidenceRevision,
      ),
    });
  }

  async quote(userId: string, request: FundingQuoteRequest) {
    const [resolvedPolicy, account] = await Promise.all([
      resolveFundingPolicy(this.db),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    return new FundingQuoteService({
      db: this.db,
      planningStore: this.planningStore,
      revalidateWithdrawalRecipient: async (ownerId, recipientId) => {
        await this.withdrawalRuntime.resolve(ownerId, recipientId);
      },
    }).quote({
      userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: account.ownershipEvidenceRevision,
    });
  }

  async commit(userId: string, request: FundingCommitRequest) {
    const [resolvedPolicy, account] = await Promise.all([
      resolveFundingPolicy(this.db),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
    const keyVersion =
      parsePositiveInteger(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ??
      1;
    if (!lookupKey) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding subject fingerprint key is not configured",
      );
    }
    return new FundingOperationService({
      db: this.db,
      subjectLookupHmac: (subjectUserId) =>
        lookupHmac(`${SUBJECT_FINGERPRINT_DOMAIN}${subjectUserId}`, lookupKey),
      subjectLookupKeyVersion: keyVersion,
      resolveOwnershipRevision: async (subjectUserId) =>
        (
          await buildAccountValueReadModel({
            pool: this.db,
            userId: subjectUserId,
          })
        ).ownershipEvidenceRevision,
      revalidateWithdrawalRecipient: async (db, input) => {
        await this.withdrawalRuntime.resolve(input.userId, input.recipientId, {
          db,
          lockForShare: true,
        });
      },
    }).commit({
      userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: account.ownershipEvidenceRevision,
    });
  }

  operation(userId: string, operationId: string) {
    return fetchFundingOperationForUser(this.db, { userId, operationId });
  }

  operationSteps(userId: string, operationId: string) {
    return listFundingOperationStepsForUser(this.db, {
      userId,
      operationId,
    });
  }

  prepareOperationAction(
    userId: string,
    input: Readonly<{ operationId: string; stepId: string }>,
  ) {
    return this.actionRuntime.prepare(userId, input);
  }

  reportOperationAction(
    userId: string,
    input: Readonly<{
      operationId: string;
      stepId: string;
      attemptId: string;
      outcome: FundingActionReportOutcome;
      transactionReference: string | null;
      actualCosts: Readonly<{ networkFeeRaw: string | null }>;
    }>,
  ) {
    return this.actionRuntime.report(userId, input);
  }

  operations(
    userId: string,
    input: Readonly<{ limit: number; before: Date | null }>,
  ) {
    return listFundingOperationsForUser(this.db, {
      userId,
      limit: input.limit,
      beforeCreatedAt: input.before,
    });
  }
}
