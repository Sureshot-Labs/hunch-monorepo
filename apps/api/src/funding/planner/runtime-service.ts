import type { Pool } from "@hunch/infra";

import { buildAccountValueReadModel } from "../../account-value/runtime-service.js";
import { lookupHmac } from "../persistence/canonical.js";
import {
  fetchFundingOperationForUser,
  listFundingOperationsForUser,
} from "../persistence/funding-operation-repository.js";
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
import { FundingPlannerError } from "./money.js";
import { WalletPreparationRuntimeService } from "../preparation/runtime-service.js";
import { ProductionFundingSourcePlanner } from "./production-source-planner.js";
import { PolymarketFundingSourceAdapter } from "../preparation/polymarket-funding-source-adapter.js";
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

  async destinations(
    userId: string,
    query: Readonly<{
      purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw";
      marketContextId?: string | null;
      marketClass?: string | null;
    }>,
  ): Promise<readonly FundingDestinationOption[]> {
    return this.preparationRuntime.listDestinationOptions({
      accountId: userId,
      purpose: query.purpose,
      marketContextId: query.marketContextId ?? null,
      marketClass: query.marketClass ?? null,
      compatibleVenueBindingOptionIds: null,
    });
  }

  inspectPreparation(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
    }>,
  ): Promise<PreparationResult> {
    return this.preparationRuntime.inspectBindingOption({
      accountId: userId,
      venueBindingOptionId: request.venueBindingOptionId,
      purpose: request.purpose,
      marketContextId: request.marketContextId,
      marketClass: request.marketClass,
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
      operationId: string;
      expectedInspectionRevision: string;
    }>,
  ): Promise<readonly NormalizedAction[]> {
    return this.preparationRuntime.prepareBindingOption({
      accountId: userId,
      venueBindingOptionId: request.venueBindingOptionId,
      purpose: request.purpose,
      marketContextId: request.marketContextId,
      marketClass: request.marketClass,
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
      resolveMarketContext: async () => null,
      resolveWithdrawalRecipient: async ({ accountId, recipientId }) =>
        this.withdrawalRuntime.resolve(accountId, recipientId),
      listSources: (sourceInput) =>
        new ProductionFundingSourcePlanner(this.db, account, [
          new PolymarketFundingSourceAdapter(account),
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
