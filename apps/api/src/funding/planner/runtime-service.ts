import type { Pool } from "@hunch/infra";

import { buildAccountValueReadModel } from "../../account-value/runtime-service.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import { fetchMarketsByTokenIds } from "../../repos/unified-read.js";
import { canonicalJsonHash, lookupHmac } from "../persistence/canonical.js";
import {
  fetchFundingOperationForUser,
  listFundingOperationsForUser,
} from "../persistence/funding-operation-repository.js";
import { listFundingOperationStepsForUser } from "../persistence/funding-evidence-repository.js";
import { PostgresFundingPlanningStore } from "../persistence/funding-planning-repository.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import type {
  FundingCommitRequest,
  FundingDestinationOption,
  FundingDiscoveryRequest,
  FundingQuoteRequest,
  NormalizedAction,
  PreparationPurpose,
} from "../domain/types.js";
import type { PreparationResult } from "../domain/contracts.js";
import { FundingPlanner } from "./planner.js";
import { FundingQuoteService } from "./quote-service.js";
import { FundingOperationService } from "./operation-service.js";
import { canonicalMarketUpdatedAt } from "./market-context-revision.js";
import { FundingPlannerError } from "./money.js";
import { sameAsset } from "./money.js";
import { WalletPreparationRuntimeService } from "../preparation/runtime-service.js";
import { ProductionFundingSourcePlanner } from "./production-source-planner.js";
import { PolymarketFundingSourceAdapter } from "../preparation/polymarket-funding-source-adapter.js";
import { DirectIngressFundingSourceAdapter } from "./direct-ingress-source-adapter.js";
import {
  FundingOperationActionRuntime,
  type FundingActionReportOutcome,
} from "../execution/operation-action-runtime.js";
import { WithdrawalDestinationRuntime } from "../execution/withdrawal-destination-runtime.js";

const SUBJECT_FINGERPRINT_DOMAIN = "hunch:funding:subject:v1:";

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class FundingPlanningRuntime {
  private readonly planningStore: PostgresFundingPlanningStore;
  private readonly preparationRuntime: WalletPreparationRuntimeService;
  private readonly actionRuntime: FundingOperationActionRuntime;
  private readonly withdrawalRuntime: WithdrawalDestinationRuntime;

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
    query: Readonly<{
      purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw";
      marketContextId?: string | null;
      marketClass?: string | null;
      positionActionRef?: string | null;
      controllerWalletRef?: string | null;
    }>,
  ): Promise<readonly FundingDestinationOption[]> {
    return this.preparationRuntime.listDestinationOptions({
      accountId: userId,
      purpose: query.purpose,
      marketContextId: query.marketContextId ?? null,
      marketClass: query.marketClass ?? null,
      positionActionRef: query.positionActionRef ?? null,
      compatibleVenueBindingOptionIds: null,
      controllerWalletRef: query.controllerWalletRef ?? null,
    });
  }

  inspectPreparation(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
      positionActionRef?: string | null;
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
    });
  }

  prepare(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
      positionActionRef?: string | null;
      operationId: string;
      expectedInspectionRevision: string;
    }>,
  ): Promise<
    Readonly<{
      actions: readonly NormalizedAction[];
      controllerWalletRef: string;
    }>
  > {
    return this.preparationRuntime.prepareBindingOption({
      accountId: userId,
      venueBindingOptionId: request.venueBindingOptionId,
      purpose: request.purpose,
      marketContextId: request.marketContextId,
      marketClass: request.marketClass,
      positionActionRef: request.positionActionRef ?? null,
      compatibleVenueBindingOptionIds: [request.venueBindingOptionId],
      operationId: request.operationId,
      expectedInspectionRevision: request.expectedInspectionRevision,
    });
  }

  async liquidity(userId: string, request: FundingDiscoveryRequest) {
    const [resolvedPolicy, account] = await Promise.all([
      resolveFundingPolicy(this.db),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    const planner = new FundingPlanner({
      listDestinations: async ({ accountId, request, marketContext }) =>
        this.preparationRuntime.resolvedCandidates({
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
            marketContext?.compatibleVenueBindingOptionIds ?? null,
        }),
      resolveMarketContext: async ({ accountId, marketContextId }) => {
        const requestedAmount = request.requestedDestinationAmount;
        if (!requestedAmount) return null;
        const rows = await fetchMarketsByTokenIds(this.db, {
          tokenIds: [marketContextId],
          includeTop: false,
        });
        const exact = rows.filter(
          (row) =>
            row.token_id === marketContextId &&
            (row.side === "YES" || row.side === "NO"),
        );
        if (exact.length !== 1) return null;
        const market = exact[0];
        if (!market) return null;
        const candidates = await this.preparationRuntime.resolvedCandidates({
          accountId,
          purpose: "buy",
          marketContextId: market.market_id,
          marketClass: null,
          compatibleVenueBindingOptionIds: null,
        });
        const compatible = candidates.filter(
          (candidate) =>
            candidate.option.selectable &&
            candidate.option.venueId === market.venue &&
            sameAsset(candidate.option.requiredAsset, requestedAmount.asset),
        );
        if (compatible.length === 0) return null;
        const now = new Date();
        return {
          marketContextId,
          venueId: market.venue,
          marketId: market.market_id,
          side: market.side as "YES" | "NO",
          executionProfileId: `funding_${market.venue}_buy_v1`,
          marketPriceRevision: stableOpaqueId(
            "market_revision",
            canonicalJsonHash({
              marketId: market.market_id,
              side: market.side,
              status: market.market_status,
              acceptingOrders: market.pm_accepting_orders,
              updatedAt: canonicalMarketUpdatedAt(market.updated_at),
            }),
          ),
          collateralAsset: requestedAmount.asset,
          requestedCollateralRaw: requestedAmount.raw,
          compatibleVenueBindingOptionIds: compatible.map(
            (candidate) => candidate.bindingOption.venueBindingOptionId,
          ),
          expiresAt: new Date(
            now.getTime() + resolvedPolicy.policy.ttl.quoteMs,
          ).toISOString(),
        };
      },
      resolveWithdrawalRecipient: async ({ accountId, recipientId }) =>
        this.withdrawalRuntime.resolve(accountId, recipientId),
      listSources: (sourceInput) =>
        new ProductionFundingSourcePlanner(this.db, account, [
          new PolymarketFundingSourceAdapter(account),
          new DirectIngressFundingSourceAdapter(account),
        ]).list(sourceInput),
      store: this.planningStore,
    });
    return planner.discover({
      accountId: userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: account.ownershipEvidenceRevision,
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
      positiveInt(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ?? 1;
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
