import { tx, type Pool, type PoolClient } from "@hunch/infra";

import {
  addUnsignedDecimals,
  compareUnsignedDecimals,
  multiplyRawByUnitPrice,
  multiplyUnsignedDecimals,
} from "../../account-value/decimal.js";
import type {
  FundingQuoteSummary,
  FundingReceiveQuotePlan,
  FundingReceiveReviewContinuation,
} from "../domain/types.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { delegatedFundingProfile } from "../execution/delegated-funding-profiles.js";
import type { DelegatedFundingPreBroadcastDecision } from "../execution/delegated-funding-capability.js";
import { lockFundingPolicyForTransaction } from "../policies/funding-policy-service.js";
import { sameAsset } from "../planner/money.js";
import type { FundingPlanningRuntime } from "../planner/runtime-service.js";
import { lockFundingAuthorizationReservationScope } from "../persistence/funding-authorization-reservation-lock.js";
import {
  claimFundingReceiveReceiptOperationLinkInTransaction,
  deferFundingReceiveReceiptRouting,
  linkFundingReceiveReceiptOperationInTransaction,
  listFundingReceiveReceiptsForRouting,
  recordFundingReceiveReceiptRoutingDisposition,
  settleFundingReceiveReceiptRouting,
  type FundingReceiveReceiptRoutingTarget,
} from "../persistence/funding-receive-session-repository.js";

const TERMINAL_UNCERTAIN_STATUSES = new Set(["refunded"]);
const MAX_ROUTING_ATTEMPTS = 5;
const BASE_ROUTING_RETRY_MS = 30_000;
const AUTOMATIC_ROUTING_RETRY_MS = 60_000;
const AUTOMATIC_ROUTING_ERROR_CODES = new Set([
  "route_unavailable",
  "routing_destination_unavailable",
  "routing_evidence_expired",
  "routing_evidence_stale",
  "routing_preparation_unavailable",
  "routing_provider_unavailable",
  "routing_stale_projection",
]);

export function fundingReceiveRoutingErrorCode(error: unknown): string {
  if (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
  ) {
    if (
      error.code === "quote_mismatch" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      if (
        error.message ===
        "quote request raw amounts differ from the selected source plan"
      ) {
        return "routing_quote_amount_mismatch";
      }
      if (
        error.message.startsWith("selected source plan differs from frozen")
      ) {
        return "routing_quote_frozen_facts_mismatch";
      }
      if (error.message === "stored plan lacks exact destination economics") {
        return "routing_quote_economics_missing";
      }
      if (
        error.message ===
        "venue preparation quote lacks its exact frozen source inputs"
      ) {
        return "routing_quote_source_inputs_missing";
      }
    }
    return `routing_${error.code}`;
  }
  return "routing_attempt_failed";
}

export function fundingReceiveRoutingNeedsRecovery(
  errorCode: string,
  nextAttempt: number,
): boolean {
  return (
    nextAttempt >= MAX_ROUTING_ATTEMPTS &&
    !AUTOMATIC_ROUTING_ERROR_CODES.has(errorCode)
  );
}

export function fundingReceiveRoutingNeedsReview(
  errorCode: string,
  nextAttempt: number,
): boolean {
  return (
    nextAttempt >= MAX_ROUTING_ATTEMPTS &&
    AUTOMATIC_ROUTING_ERROR_CODES.has(errorCode)
  );
}

export type FundingReceiveChildOperationDisposition =
  | "ready"
  | "review_retry"
  | "recovery"
  | "waiting";

/**
 * A generic failed/cancelled child is retryable only when durable attempt
 * evidence proves that no broadcast was possible and no attempt is unresolved.
 * Delegated children retain their exact receipt/operation binding. Everything
 * ambiguous fails closed to recovery instead of rebroadcasting.
 */
export function fundingReceiveChildOperationDisposition(input: {
  childOperationStatus: string | null;
  delegatedExecution: boolean;
  broadcastMayHaveOccurred: boolean;
  hasUnfinishedAttempt: boolean;
  recoveryMode?: "automatic_evidence" | "manual_review" | null;
}): FundingReceiveChildOperationDisposition {
  if (input.childOperationStatus === "completed") return "ready";
  if (input.childOperationStatus === "reconcile_required") return "waiting";
  if (
    input.childOperationStatus === "recovery_required" &&
    input.recoveryMode === "automatic_evidence"
  ) {
    return "waiting";
  }
  if (input.childOperationStatus === "recovery_required") return "recovery";
  if (
    input.delegatedExecution &&
    (input.childOperationStatus === "failed" ||
      input.childOperationStatus === "cancelled")
  ) {
    return "recovery";
  }
  if (
    (input.childOperationStatus === "failed" ||
      input.childOperationStatus === "cancelled") &&
    !input.broadcastMayHaveOccurred &&
    !input.hasUnfinishedAttempt
  ) {
    return "review_retry";
  }
  if (
    input.childOperationStatus === "failed" ||
    input.childOperationStatus === "cancelled" ||
    (input.childOperationStatus != null &&
      TERMINAL_UNCERTAIN_STATUSES.has(input.childOperationStatus))
  ) {
    return "recovery";
  }
  return "waiting";
}

export function receiveAutomationEconomicsWithinPolicy(
  quote: Pick<FundingQuoteSummary, "fees" | "minimumDestination">,
  policy: FundingReceiveReceiptRoutingTarget["automationPolicy"],
): boolean {
  if (quote.fees.some((fee) => fee.estimatedUsd == null)) return false;
  const feeUsd = addUnsignedDecimals(
    quote.fees.map((fee) => fee.estimatedUsd ?? "0"),
  );
  if (compareUnsignedDecimals(feeUsd, policy.maximumFeeUsd) > 0) return false;
  const destinationUsd = multiplyRawByUnitPrice({
    raw: quote.minimumDestination.raw,
    decimals: quote.minimumDestination.asset.decimals,
    unitPriceUsd: "1",
  });
  return (
    compareUnsignedDecimals(
      multiplyUnsignedDecimals(feeUsd, "10000"),
      multiplyUnsignedDecimals(destinationUsd, policy.maximumFeeBps.toString()),
    ) <= 0
  );
}

export function quoteWithinReceiveAutomationPolicy(
  quote: FundingQuoteSummary,
  policy: FundingReceiveReceiptRoutingTarget["automationPolicy"],
): boolean {
  return receiveAutomationEconomicsWithinPolicy(quote, policy);
}

export type FundingReceiveRoutingErrorDirective = Readonly<{
  errorCode: string;
  retryAfterMs: number;
  retryMode: "defer_without_budget";
}>;

export type FundingReceiveReceiptAutomaticExecution = Readonly<{
  adapterKey: string;
  outsidePolicyReview?: FundingReceiveReviewContinuation;
  authorizationId?: string;
  authorizationFingerprint?: string;
  receiptBinding?: Readonly<{
    consentId: string;
    consentFingerprint: string;
  }>;
  serverExecutionProfileId?: string;
  quotePlan: (
    target: FundingReceiveReceiptRoutingTarget,
  ) => FundingReceiveQuotePlan;
  classifyError?: (
    error: unknown,
  ) => FundingReceiveRoutingErrorDirective | null;
  decision: (
    db: Pick<Pool, "query">,
    target: FundingReceiveReceiptRoutingTarget,
  ) => Promise<DelegatedFundingPreBroadcastDecision>;
  prepareOperation?: (
    db: Pool,
    target: FundingReceiveReceiptRoutingTarget,
    now: Date,
  ) => Promise<
    | Readonly<{
        verify: (client: PoolClient) => Promise<void>;
        commit: (client: PoolClient) => Promise<string>;
      }>
    | Readonly<{ kind: "outside_policy" }>
    | null
  >;
  quoteMatches?: (
    quote: FundingQuoteSummary,
    target: FundingReceiveReceiptRoutingTarget,
  ) => boolean;
  validateOperationLink: (
    client: PoolClient,
    input: Readonly<{
      operationId: string;
      target: FundingReceiveReceiptRoutingTarget;
    }>,
  ) => Promise<boolean>;
}>;

export function fundingReceiveExecutionUsesReservationScope(
  execution: Pick<
    FundingReceiveReceiptAutomaticExecution,
    "serverExecutionProfileId"
  >,
): boolean {
  if (!execution.serverExecutionProfileId) return false;
  const profile = delegatedFundingProfile(execution.serverExecutionProfileId);
  if (!profile) {
    throw new Error("delegated funding execution profile is unavailable");
  }
  return profile.securityClass === "routed_value_movement";
}

export type FundingReceiveReceiptDisposition =
  | Readonly<{ kind: "direct" }>
  | Readonly<{
      kind: "automatic_execution";
      execution: FundingReceiveReceiptAutomaticExecution | null;
      quotePlan: FundingReceiveQuotePlan;
    }>
  | Readonly<{
      kind: "review_required";
      continuation: FundingReceiveReviewContinuation;
      quotePlan: FundingReceiveQuotePlan;
    }>
  | Readonly<{ kind: "hard_invalid"; reasonCode: string }>;

export type FundingReceiveReceiptDispositionResolver = (
  target: FundingReceiveReceiptRoutingTarget,
) => FundingReceiveReceiptDisposition;

type FundingReceiveReviewEvidence = Readonly<{
  continuation: FundingReceiveReviewContinuation;
  quotePlan: FundingReceiveQuotePlan;
}>;

type FundingReceiveReviewFallback = Readonly<{
  evidence: FundingReceiveReviewEvidence | null;
  errorCode: string;
}>;

function reviewEvidence(
  disposition: FundingReceiveReceiptDisposition,
): FundingReceiveReviewEvidence | null {
  if (disposition.kind === "review_required") {
    return {
      continuation: disposition.continuation,
      quotePlan: disposition.quotePlan,
    };
  }
  if (disposition.kind !== "automatic_execution") return null;
  const continuation = disposition.execution?.outsidePolicyReview;
  return continuation
    ? { continuation, quotePlan: disposition.quotePlan }
    : null;
}

type ExactChildOperationOutcome =
  | Readonly<{ kind: "created" | "no_route" | "outside_policy" }>
  | Readonly<{
      kind: "soft_paused" | "hard_invalid";
      reasonCode: string;
    }>;

export async function quoteFundingReceiveReceipt(
  runtime: Pick<FundingPlanningRuntime, "liquidity" | "quote">,
  target: FundingReceiveReceiptRoutingTarget,
  input: Readonly<{
    quotePlan: FundingReceiveQuotePlan;
    serverExecutionProfileId?: string;
  }>,
): Promise<FundingQuoteSummary | null> {
  if (target.receipt.rawAmount === "0") return null;
  const amounts = input.quotePlan;
  if (amounts.confirmedSourceAmount?.raw === "0") return null;
  const adapterOwnedPreparation = input.quotePlan.venuePreparation;
  const liquidity = await runtime.liquidity(target.userId, {
    purpose: "add_funds",
    marketContextId: null,
    confirmedSourceAmount: amounts.confirmedSourceAmount,
    requestedDestinationAmount: amounts.requestedDestinationAmount,
    destinationOptionId: target.destinationOptionId,
    venueBindingOptionId: target.venueBindingOptionId,
    withdrawalRecipientId: null,
    ...(input.serverExecutionProfileId
      ? { serverExecutionProfileId: input.serverExecutionProfileId }
      : {}),
    // The closed-destination wrap is an exact 1:1 protocol transform, not an
    // economic route. Its boundary is the full receipt and exact calldata.
    maxFeeUsd: adapterOwnedPreparation
      ? null
      : target.automationPolicy.maximumFeeUsd,
    maxSlippageBps: adapterOwnedPreparation
      ? null
      : target.automationPolicy.maximumSlippageBps,
    deadline: null,
  });
  const sources = liquidity.sourceOptions.filter((option) => {
    if (!option.selectable) return false;
    if (
      option.kind === "venue_preparation" &&
      option.source.kind === "venue_preparation"
    ) {
      return amounts.venuePreparation;
    }
    if (
      option.kind !== "wallet_asset" ||
      option.amountMode !== "exact_input" ||
      option.source.kind !== "owned_location" ||
      option.source.location.locationId !==
        target.receiptDestinationLocationId ||
      !sameAsset(option.source.location.asset, target.receipt.asset)
    ) {
      return false;
    }
    const address = option.source.location.details.address;
    return (
      typeof address === "string" &&
      sameAccountAddress(
        target.receipt.asset.networkId,
        address,
        target.receipt.destinationAddress,
      )
    );
  });
  if (sources.length !== 1) return null;
  const source = sources[0];
  if (!source) return null;
  return runtime.quote(target.userId, {
    liquidityProjectionId: liquidity.liquidityProjectionId,
    selectedSourceOptionId: source.sourceOptionId,
    confirmedSourceAmount:
      source.source.kind === "owned_location"
        ? amounts.confirmedSourceAmount
        : null,
    // Discovery needs a non-zero destination floor, but an exact-input quote
    // is bound only by its frozen source amount. Re-sending that discovery
    // floor as an exact destination contradicts the provider output frozen in
    // the selected source plan.
    requestedDestinationAmount:
      source.amountMode === "exact_input"
        ? null
        : amounts.requestedDestinationAmount,
  });
}

export type FundingReceiveReceiptRoutingResult = Readonly<{
  receiptsInspected: number;
  operationsCreated: number;
  receiptsReady: number;
  recoveriesRequired: number;
  reviewsRequired: number;
  retriesScheduled: number;
  retryableErrors: number;
}>;

export class FundingReceiveReceiptRouter {
  private runtime: Pick<
    FundingPlanningRuntime,
    "liquidity" | "quote" | "prepareCommit" | "commitPreparedInTransaction"
  > | null;

  constructor(
    private readonly db: Pool,
    runtime?: Pick<
      FundingPlanningRuntime,
      "liquidity" | "quote" | "prepareCommit" | "commitPreparedInTransaction"
    >,
    private readonly resolveDisposition: FundingReceiveReceiptDispositionResolver = () => ({
      kind: "hard_invalid",
      reasonCode: "receipt_disposition_unavailable",
    }),
  ) {
    this.runtime = runtime ?? null;
  }

  private reviewFallback(
    target: FundingReceiveReceiptRoutingTarget,
  ): FundingReceiveReviewFallback {
    try {
      const disposition = this.resolveDisposition(target);
      return {
        evidence: reviewEvidence(disposition),
        errorCode:
          disposition.kind === "hard_invalid"
            ? disposition.reasonCode
            : "receipt_disposition_invalid",
      };
    } catch (error) {
      return {
        evidence: null,
        errorCode: fundingReceiveRoutingErrorCode(error),
      };
    }
  }

  async runBatch(
    input: Readonly<{ limit?: number; now?: Date }> = {},
  ): Promise<FundingReceiveReceiptRoutingResult> {
    const now = input.now ?? new Date();
    const targets = await listFundingReceiveReceiptsForRouting(this.db, {
      limit: input.limit ?? 25,
      now,
    });
    const counts = {
      operationsCreated: 0,
      receiptsReady: 0,
      recoveriesRequired: 0,
      reviewsRequired: 0,
      retriesScheduled: 0,
      retryableErrors: 0,
    };
    for (const target of targets) {
      if (
        target.receipt.status === "review_required" &&
        (!target.receipt.reviewContinuation || !target.receipt.reviewQuotePlan)
      ) {
        const fallback = this.reviewFallback(target);
        const evidence = fallback.evidence;
        const updated = evidence
          ? await this.recordDisposition(
              target,
              "review_required",
              "economic_review_required",
              now,
              evidence.continuation,
              evidence.quotePlan,
            )
          : await this.recordDisposition(
              target,
              "recovery_required",
              fallback.errorCode,
              now,
            );
        if (updated) {
          if (evidence) {
            counts.reviewsRequired += 1;
          } else {
            counts.recoveriesRequired += 1;
          }
        }
        continue;
      }
      if (target.receipt.status === "observed") {
        let execution: FundingReceiveReceiptAutomaticExecution | null = null;
        let fallbackReview: FundingReceiveReviewEvidence | null = null;
        try {
          const disposition = this.resolveDisposition(target);
          if (disposition.kind === "review_required") {
            const updated = await this.recordDisposition(
              target,
              "review_required",
              "economic_review_required",
              now,
              disposition.continuation,
              disposition.quotePlan,
            );
            counts.reviewsRequired += updated ? 1 : 0;
            continue;
          }
          if (disposition.kind === "hard_invalid") {
            const updated = await this.recordDisposition(
              target,
              "recovery_required",
              disposition.reasonCode,
              now,
            );
            counts.recoveriesRequired += updated ? 1 : 0;
            continue;
          }
          if (disposition.kind === "direct") {
            const updated = await this.recordDisposition(
              target,
              "recovery_required",
              "receipt_disposition_invalid",
              now,
            );
            counts.recoveriesRequired += updated ? 1 : 0;
            continue;
          }
          execution = disposition.execution;
          fallbackReview = reviewEvidence(disposition);
          const outcome = await this.createExactChildOperation(
            target,
            now,
            disposition.quotePlan,
            execution,
          );
          if (outcome.kind === "created") {
            counts.operationsCreated += 1;
          } else if (outcome.kind === "soft_paused") {
            const updated = await deferFundingReceiveReceiptRouting(this.db, {
              receiptId: target.receipt.receiptId,
              userId: target.userId,
              errorCode: outcome.reasonCode,
              retryAt: new Date(now.getTime() + AUTOMATIC_ROUTING_RETRY_MS),
              now,
            });
            counts.retriesScheduled += updated ? 1 : 0;
          } else if (outcome.kind === "hard_invalid") {
            const updated = await this.recordDisposition(
              target,
              "recovery_required",
              outcome.reasonCode,
              now,
            );
            counts.recoveriesRequired += updated ? 1 : 0;
          } else if (outcome.kind === "outside_policy") {
            const continuation = execution?.outsidePolicyReview;
            const updated = continuation
              ? await this.recordDisposition(
                  target,
                  "review_required",
                  "automation_policy_exceeded",
                  now,
                  continuation,
                  disposition.quotePlan,
                )
              : await this.recordDisposition(
                  target,
                  "recovery_required",
                  "automation_policy_exceeded",
                  now,
                );
            if (updated) {
              if (continuation) counts.reviewsRequired += 1;
              else counts.recoveriesRequired += 1;
            }
          } else {
            const disposition = await this.deferOrRecoverReceipt(
              target,
              "route_unavailable",
              now,
              fallbackReview,
            );
            counts.retriesScheduled += disposition === "retry" ? 1 : 0;
            counts.reviewsRequired += disposition === "review" ? 1 : 0;
            counts.recoveriesRequired += disposition === "recovery" ? 1 : 0;
          }
        } catch (error) {
          counts.retryableErrors += 1;
          const directive = execution?.classifyError?.(error) ?? null;
          const disposition = await (
            directive?.retryMode === "defer_without_budget"
              ? this.deferReceipt(
                  target,
                  directive.errorCode,
                  directive.retryAfterMs,
                  now,
                )
              : this.deferOrRecoverReceipt(
                  target,
                  fundingReceiveRoutingErrorCode(error),
                  now,
                  fallbackReview,
                )
          ).catch(() => "unchanged" as const);
          counts.retriesScheduled += disposition === "retry" ? 1 : 0;
          counts.reviewsRequired += disposition === "review" ? 1 : 0;
          counts.recoveriesRequired += disposition === "recovery" ? 1 : 0;
        }
        continue;
      }
      const childDisposition = fundingReceiveChildOperationDisposition({
        childOperationStatus: target.childOperationStatus,
        delegatedExecution: Boolean(
          target.childExecutorId &&
          delegatedFundingProfile(target.childExecutorId),
        ),
        broadcastMayHaveOccurred: target.childBroadcastMayHaveOccurred,
        hasUnfinishedAttempt: target.childHasUnfinishedAttempt,
        recoveryMode: target.childOperationRecoveryMode,
      });
      const childOperationId = target.receipt.childFundingOperationId;
      if (!childOperationId || childDisposition === "waiting") continue;
      const fallbackReview =
        childDisposition === "review_retry"
          ? this.reviewFallback(target).evidence
          : null;
      const status =
        childDisposition === "ready"
          ? "ready"
          : childDisposition === "review_retry" && fallbackReview
            ? "review_required"
            : "recovery_required";
      const childOperationStatus =
        target.childOperationStatus ??
        (childDisposition === "ready"
          ? "completed"
          : childDisposition === "review_retry"
            ? "failed"
            : "recovery_required");
      const settled = await settleFundingReceiveReceiptRouting(this.db, {
        receiptId: target.receipt.receiptId,
        receiveSessionId: target.receipt.receiveSessionId,
        userId: target.userId,
        childOperationId,
        childOperationStatus,
        status,
        ...(fallbackReview ?? {}),
        now,
      });
      if (settled) {
        if (childDisposition === "ready") counts.receiptsReady += 1;
        else if (status === "review_required") counts.reviewsRequired += 1;
        else counts.recoveriesRequired += 1;
      }
    }
    return {
      receiptsInspected: targets.length,
      ...counts,
    };
  }

  private async createExactChildOperation(
    target: FundingReceiveReceiptRoutingTarget,
    now: Date,
    quotePlan: FundingReceiveQuotePlan,
    execution: FundingReceiveReceiptAutomaticExecution | null,
  ): Promise<ExactChildOperationOutcome> {
    if (execution) {
      const decision = await execution.decision(this.db, target);
      if (decision.kind !== "allowed") return decision;
    }
    const prepared = execution?.prepareOperation
      ? await execution.prepareOperation(this.db, target, now)
      : null;
    if (execution?.prepareOperation && !prepared) {
      return { kind: "no_route" };
    }
    if (prepared && "kind" in prepared) {
      return prepared;
    }
    if (prepared && execution) {
      return tx(this.db, async (client) => {
        await lockFundingPolicyForTransaction(client);
        if (
          execution.authorizationId &&
          fundingReceiveExecutionUsesReservationScope(execution) &&
          !(await lockFundingAuthorizationReservationScope(client, {
            authorizationId: execution.authorizationId,
            userId: target.userId,
          }))
        ) {
          throw new Error("automatic funding authorization is unavailable");
        }
        await prepared.verify(client);
        const claimed =
          await claimFundingReceiveReceiptOperationLinkInTransaction(client, {
            receiptId: target.receipt.receiptId,
            userId: target.userId,
          });
        if (!claimed) return { kind: "no_route" } as const;
        const operationId = await prepared.commit(client);
        if (
          !(await execution.validateOperationLink(client, {
            operationId,
            target,
          }))
        ) {
          throw new Error("automatic funding operation evidence is invalid");
        }
        const linked = await linkFundingReceiveReceiptOperationInTransaction(
          client,
          {
            receiptId: target.receipt.receiptId,
            userId: target.userId,
            childFundingOperationId: operationId,
            authorizationId: execution.authorizationId,
            authorizationFingerprint: execution.authorizationFingerprint,
            telegramFundingConsentId: execution.receiptBinding?.consentId,
            telegramFundingConsentFingerprint:
              execution.receiptBinding?.consentFingerprint,
            serverExecutionProfileId: execution.serverExecutionProfileId,
            now,
          },
        );
        if (!linked) {
          throw new Error("claimed funding receipt could not be linked");
        }
        return { kind: "created" } as const;
      });
    }
    const runtime = await this.planningRuntime();
    const quote = await quoteFundingReceiveReceipt(runtime, target, {
      quotePlan,
      ...(execution?.serverExecutionProfileId
        ? { serverExecutionProfileId: execution.serverExecutionProfileId }
        : {}),
    });
    if (!quote) return { kind: "no_route" };
    if (execution && !execution.quoteMatches?.(quote, target)) {
      return {
        kind: "hard_invalid",
        reasonCode: "delegated_action_invalid",
      };
    }
    if (
      !execution &&
      !quoteWithinReceiveAutomationPolicy(quote, target.automationPolicy)
    ) {
      return { kind: "outside_policy" };
    }
    const commitRequest = {
      quoteId: quote.quoteId,
      consentToken: quote.consentToken,
      idempotencyKey: `receive-receipt:${target.receipt.receiptId}`,
    };
    const preparedCommit = await runtime.prepareCommit(
      target.userId,
      commitRequest,
    );
    return tx(this.db, async (client) => {
      await lockFundingPolicyForTransaction(client);
      if (
        execution?.authorizationId &&
        fundingReceiveExecutionUsesReservationScope(execution) &&
        !(await lockFundingAuthorizationReservationScope(client, {
          authorizationId: execution.authorizationId,
          userId: target.userId,
        }))
      ) {
        throw new Error("automatic funding authorization is unavailable");
      }
      const claimed =
        await claimFundingReceiveReceiptOperationLinkInTransaction(client, {
          receiptId: target.receipt.receiptId,
          userId: target.userId,
        });
      if (!claimed) return { kind: "no_route" } as const;
      const committed = await runtime.commitPreparedInTransaction(
        client,
        preparedCommit,
      );
      if (
        execution &&
        !(await execution.validateOperationLink(client, {
          operationId: committed.operation.id,
          target,
        }))
      ) {
        throw new Error("automatic funding operation evidence is invalid");
      }
      const linked = await linkFundingReceiveReceiptOperationInTransaction(
        client,
        {
          receiptId: target.receipt.receiptId,
          userId: target.userId,
          childFundingOperationId: committed.operation.id,
          ...(execution
            ? {
                authorizationId: execution.authorizationId,
                authorizationFingerprint: execution.authorizationFingerprint,
                telegramFundingConsentId: execution.receiptBinding?.consentId,
                telegramFundingConsentFingerprint:
                  execution.receiptBinding?.consentFingerprint,
                serverExecutionProfileId: execution.serverExecutionProfileId,
              }
            : {}),
          now: committed.operation.createdAt,
        },
      );
      if (!linked) {
        throw new Error("claimed funding receipt could not be linked");
      }
      return { kind: "created" } as const;
    });
  }

  private async planningRuntime(): Promise<
    Pick<
      FundingPlanningRuntime,
      "liquidity" | "quote" | "prepareCommit" | "commitPreparedInTransaction"
    >
  > {
    if (this.runtime) return this.runtime;
    throw new Error("funding receive route adapter is unavailable");
  }

  private recordDisposition(
    target: FundingReceiveReceiptRoutingTarget,
    disposition: "review_required" | "recovery_required",
    errorCode: string,
    now: Date,
    reviewContinuation?: FundingReceiveReviewContinuation,
    reviewQuotePlan?: FundingReceiveQuotePlan,
  ): Promise<boolean> {
    return recordFundingReceiveReceiptRoutingDisposition(this.db, {
      receiptId: target.receipt.receiptId,
      receiveSessionId: target.receipt.receiveSessionId,
      userId: target.userId,
      disposition,
      errorCode,
      ...(reviewContinuation ? { reviewContinuation } : {}),
      ...(reviewQuotePlan ? { reviewQuotePlan } : {}),
      now,
    });
  }

  private async deferOrRecoverReceipt(
    target: FundingReceiveReceiptRoutingTarget,
    errorCode: string,
    now: Date,
    fallbackReview: FundingReceiveReviewEvidence | null,
  ): Promise<"retry" | "review" | "recovery" | "unchanged"> {
    const nextAttempt = target.routingAttemptCount + 1;
    if (fundingReceiveRoutingNeedsReview(errorCode, nextAttempt)) {
      const updated = await this.recordDisposition(
        target,
        fallbackReview ? "review_required" : "recovery_required",
        errorCode,
        now,
        fallbackReview?.continuation,
        fallbackReview?.quotePlan,
      );
      return updated ? (fallbackReview ? "review" : "recovery") : "unchanged";
    }
    if (fundingReceiveRoutingNeedsRecovery(errorCode, nextAttempt)) {
      const updated = await this.recordDisposition(
        target,
        "recovery_required",
        errorCode,
        now,
      );
      return updated ? "recovery" : "unchanged";
    }
    const delayMs = AUTOMATIC_ROUTING_ERROR_CODES.has(errorCode)
      ? AUTOMATIC_ROUTING_RETRY_MS
      : Math.min(
          15 * 60_000,
          BASE_ROUTING_RETRY_MS * 2 ** target.routingAttemptCount,
        );
    const updated = await recordFundingReceiveReceiptRoutingDisposition(
      this.db,
      {
        receiptId: target.receipt.receiptId,
        receiveSessionId: target.receipt.receiveSessionId,
        userId: target.userId,
        disposition: "retry_scheduled",
        errorCode,
        retryAt: new Date(now.getTime() + delayMs),
        now,
      },
    );
    return updated ? "retry" : "unchanged";
  }

  private async deferReceipt(
    target: FundingReceiveReceiptRoutingTarget,
    errorCode: string,
    retryAfterMs: number,
    now: Date,
  ): Promise<"retry" | "unchanged"> {
    const updated = await deferFundingReceiveReceiptRouting(this.db, {
      receiptId: target.receipt.receiptId,
      userId: target.userId,
      errorCode,
      retryAt: new Date(now.getTime() + retryAfterMs),
      now,
    });
    return updated ? "retry" : "unchanged";
  }
}
