import { tx, type Pool } from "@hunch/infra";

import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import {
  addUnsignedDecimals,
  compareUnsignedDecimals,
  multiplyRawByUnitPrice,
  multiplyUnsignedDecimals,
} from "../../account-value/decimal.js";
import type { AssetRef, FundingQuoteSummary, Money } from "../domain/types.js";
import {
  canonicalAssetId,
  sameAccountAddress,
} from "../domain/asset-identity.js";
import { loadPolymarketWrapExecutionConfiguration } from "../execution/delegated-funding-config.js";
import {
  delegatedFundingProfile,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
} from "../execution/delegated-funding-profiles.js";
import type { DelegatedFundingPreBroadcastDecision } from "../execution/delegated-funding-capability.js";
import { resolveTelegramPolymarketWrapCapability } from "../execution/delegated-funding-capability-resolver.js";
import {
  parseTelegramFundingAutomationPolicyV2,
  telegramFundingAutomationPolicyMatchesAuthorization,
  telegramFundingReceiptIsProspectivelyAuthorized,
} from "../execution/telegram-funding-automation-policy.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../domain/network-fees.js";
import { sameAsset } from "../planner/money.js";
import type { FundingPlanningRuntime } from "../planner/runtime-service.js";
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
      error.code === "invalid_operation_state" &&
      "message" in error &&
      error.message ===
        "another Polymarket Funding Router operation is unresolved"
    ) {
      return "routing_predecessor_unresolved";
    }
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

export function quoteWithinReceiveAutomationPolicy(
  quote: FundingQuoteSummary,
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

export function receiveReceiptRoutingAmounts(
  input: Readonly<{
    receiptAsset: AssetRef;
    destinationAsset: AssetRef;
    rawAmount: string;
  }>,
): Readonly<{
  confirmedSourceAmount: Money | null;
  requestedDestinationAmount: Money;
  venuePreparation: boolean;
}> {
  const venuePreparation =
    input.receiptAsset.networkId === "evm:137" &&
    canonicalAssetId(input.receiptAsset) ===
      RELAY_PINNED_ASSETS.polygonUsdce.toLowerCase() &&
    input.destinationAsset.networkId === "evm:137" &&
    canonicalAssetId(input.destinationAsset) ===
      RELAY_PINNED_ASSETS.polygonPusd.toLowerCase();
  const nativeSol =
    input.receiptAsset.networkId === "solana:mainnet" &&
    input.receiptAsset.assetId === RELAY_PINNED_ASSETS.solanaNative &&
    input.receiptAsset.decimals === 9;
  const nativeSolRaw = nativeSol
    ? BigInt(input.rawAmount) > SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
      ? (
          BigInt(input.rawAmount) - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
        ).toString()
      : "0"
    : null;
  return {
    confirmedSourceAmount: venuePreparation
      ? null
      : {
          asset: input.receiptAsset,
          raw: nativeSolRaw ?? input.rawAmount,
        },
    requestedDestinationAmount: {
      asset: input.destinationAsset,
      // Cross-network receipts are exact-input operations. The actual Relay
      // quote freezes the economically safe output; this single-unit floor
      // prevents a zero-output route without pretending the transfer is 1:1.
      raw: venuePreparation ? input.rawAmount : "1",
    },
    venuePreparation,
  };
}

export async function telegramUsdceWrapRoutingDecision(
  db: Pool,
  target: FundingReceiveReceiptRoutingTarget,
): Promise<DelegatedFundingPreBroadcastDecision> {
  const snapshot = parseTelegramFundingAutomationPolicyV2(
    target.telegramAutomationPolicy,
  );
  if (
    !snapshot ||
    !target.telegramAccountId ||
    target.telegramFundingAuthorizationId !== snapshot.authorizationId ||
    !target.telegramUserId ||
    snapshot.profileId !== POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID ||
    snapshot.destinationOptionId !== target.destinationOptionId ||
    snapshot.venueBindingOptionId !== target.venueBindingOptionId ||
    !sameAsset(snapshot.sourceAsset, target.receipt.asset) ||
    !sameAsset(snapshot.destinationAsset, target.destinationAsset) ||
    !telegramFundingReceiptIsProspectivelyAuthorized({
      policy: snapshot,
      variantId: target.receipt.variantId,
      ledgerHeight: target.receipt.ledgerHeight ?? null,
    })
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_authority_invalid",
    };
  }
  const configuration = loadPolymarketWrapExecutionConfiguration();
  const capability = await resolveTelegramPolymarketWrapCapability(db, {
    userId: target.userId,
    telegramAccountId: target.telegramAccountId,
    telegramUserId: target.telegramUserId,
    destinationOptionId: target.destinationOptionId,
    venueBindingOptionId: target.venueBindingOptionId,
    configuration,
    expectedAuthorizationId: snapshot.authorizationId,
    expectedAuthorizationFingerprint: snapshot.authorizationFingerprint,
    expectedFundingPolicyRevision: snapshot.fundingPolicyRevision,
  });
  if (
    capability.authorization &&
    !telegramFundingAutomationPolicyMatchesAuthorization(
      snapshot,
      capability.authorization,
    )
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_authority_invalid",
    };
  }
  return capability.decision;
}

export async function telegramUsdceWrapRoutingAuthorized(
  db: Pool,
  target: FundingReceiveReceiptRoutingTarget,
): Promise<boolean> {
  return (
    (await telegramUsdceWrapRoutingDecision(db, target)).kind === "allowed"
  );
}

export function exactPolymarketUsdceWrapQuote(
  quote: FundingQuoteSummary,
  target: FundingReceiveReceiptRoutingTarget,
): boolean {
  return (
    quote.planKind === "venue_preparation" &&
    quote.destinationOptionId === target.destinationOptionId &&
    quote.venueBindingOptionId === target.venueBindingOptionId &&
    quote.sourceAmounts.length === 1 &&
    quote.sourceAmounts[0]?.amount.raw === target.receipt.rawAmount &&
    sameAsset(quote.sourceAmounts[0]?.amount.asset, target.receipt.asset) &&
    quote.expectedDestination.raw === target.receipt.rawAmount &&
    quote.minimumDestination.raw === target.receipt.rawAmount &&
    sameAsset(quote.expectedDestination.asset, target.destinationAsset) &&
    sameAsset(quote.minimumDestination.asset, target.destinationAsset) &&
    quote.fees.length === 0
  );
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
  input: Readonly<{ serverExecutionProfileId?: string }> = {},
): Promise<FundingQuoteSummary | null> {
  if (target.receipt.rawAmount === "0") return null;
  const amounts = receiveReceiptRoutingAmounts({
    receiptAsset: target.receipt.asset,
    destinationAsset: target.destinationAsset,
    rawAmount: target.receipt.rawAmount,
  });
  if (amounts.confirmedSourceAmount?.raw === "0") return null;
  const closedDestinationWrap =
    input.serverExecutionProfileId === POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
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
    maxFeeUsd: closedDestinationWrap
      ? null
      : target.automationPolicy.maximumFeeUsd,
    maxSlippageBps: closedDestinationWrap
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
    "liquidity" | "quote" | "commitInTransaction"
  > | null;

  constructor(
    private readonly db: Pool,
    runtime?: Pick<
      FundingPlanningRuntime,
      "liquidity" | "quote" | "commitInTransaction"
    >,
  ) {
    this.runtime = runtime ?? null;
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
      if (target.receipt.status === "observed") {
        try {
          const outcome = await this.createExactChildOperation(target, now);
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
            const updated = await this.recordDisposition(
              target,
              "review_required",
              "automation_policy_exceeded",
              now,
            );
            counts.reviewsRequired += updated ? 1 : 0;
          } else {
            const disposition = await this.deferOrRecoverReceipt(
              target,
              "route_unavailable",
              now,
            );
            counts.retriesScheduled += disposition === "retry" ? 1 : 0;
            counts.reviewsRequired += disposition === "review" ? 1 : 0;
            counts.recoveriesRequired += disposition === "recovery" ? 1 : 0;
          }
        } catch (error) {
          counts.retryableErrors += 1;
          const disposition = await this.deferOrRecoverReceipt(
            target,
            fundingReceiveRoutingErrorCode(error),
            now,
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
      const status =
        childDisposition === "ready"
          ? "ready"
          : childDisposition === "review_retry"
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
        now,
      });
      if (settled) {
        if (childDisposition === "ready") counts.receiptsReady += 1;
        else if (childDisposition === "review_retry")
          counts.reviewsRequired += 1;
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
  ): Promise<ExactChildOperationOutcome> {
    const telegramOwned = target.ownerChannel === "telegram";
    const automation = parseTelegramFundingAutomationPolicyV2(
      target.telegramAutomationPolicy,
    );
    if (telegramOwned) {
      if (!automation) {
        return {
          kind: "hard_invalid",
          reasonCode: "delegated_authority_invalid",
        };
      }
      const decision = await telegramUsdceWrapRoutingDecision(this.db, target);
      if (decision.kind !== "allowed") return decision;
    }
    const runtime = await this.planningRuntime();
    const quote = await quoteFundingReceiveReceipt(
      runtime,
      target,
      telegramOwned
        ? {
            serverExecutionProfileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
          }
        : {},
    );
    if (!quote) return { kind: "no_route" };
    if (telegramOwned && !exactPolymarketUsdceWrapQuote(quote, target)) {
      return {
        kind: "hard_invalid",
        reasonCode: "delegated_action_invalid",
      };
    }
    if (
      !telegramOwned &&
      !quoteWithinReceiveAutomationPolicy(quote, target.automationPolicy)
    ) {
      return { kind: "outside_policy" };
    }
    return tx(this.db, async (client) => {
      const claimed =
        await claimFundingReceiveReceiptOperationLinkInTransaction(client, {
          receiptId: target.receipt.receiptId,
          userId: target.userId,
        });
      if (!claimed) return { kind: "no_route" } as const;
      const committed = await runtime.commitInTransaction(
        client,
        target.userId,
        {
          quoteId: quote.quoteId,
          consentToken: quote.consentToken,
          idempotencyKey: `receive-receipt:${target.receipt.receiptId}`,
        },
      );
      const linked = await linkFundingReceiveReceiptOperationInTransaction(
        client,
        {
          receiptId: target.receipt.receiptId,
          userId: target.userId,
          childFundingOperationId: committed.operation.id,
          ...(telegramOwned && automation
            ? {
                authorizationId: automation.authorizationId,
                authorizationFingerprint: automation.authorizationFingerprint,
                telegramFundingConsentId:
                  target.telegramFundingConsentId ?? undefined,
                telegramFundingConsentFingerprint:
                  target.telegramFundingConsentFingerprint ?? undefined,
              }
            : {}),
          now,
        },
      );
      if (!linked) {
        throw new Error("claimed funding receipt could not be linked");
      }
      return { kind: "created" } as const;
    });
  }

  private async planningRuntime(): Promise<
    Pick<FundingPlanningRuntime, "liquidity" | "quote" | "commitInTransaction">
  > {
    if (this.runtime) return this.runtime;
    const { FundingPlanningRuntime: Runtime } =
      await import("../planner/runtime-service.js");
    this.runtime = new Runtime(this.db);
    return this.runtime;
  }

  private recordDisposition(
    target: FundingReceiveReceiptRoutingTarget,
    disposition: "review_required" | "recovery_required",
    errorCode: string,
    now: Date,
  ): Promise<boolean> {
    return recordFundingReceiveReceiptRoutingDisposition(this.db, {
      receiptId: target.receipt.receiptId,
      receiveSessionId: target.receipt.receiveSessionId,
      userId: target.userId,
      disposition,
      errorCode,
      now,
    });
  }

  private async deferOrRecoverReceipt(
    target: FundingReceiveReceiptRoutingTarget,
    errorCode: string,
    now: Date,
  ): Promise<"retry" | "review" | "recovery" | "unchanged"> {
    if (errorCode === "routing_predecessor_unresolved") {
      const updated = await deferFundingReceiveReceiptRouting(this.db, {
        receiptId: target.receipt.receiptId,
        userId: target.userId,
        errorCode,
        retryAt: new Date(now.getTime() + AUTOMATIC_ROUTING_RETRY_MS),
        now,
      });
      return updated ? "retry" : "unchanged";
    }
    const nextAttempt = target.routingAttemptCount + 1;
    if (fundingReceiveRoutingNeedsReview(errorCode, nextAttempt)) {
      const updated = await this.recordDisposition(
        target,
        "review_required",
        errorCode,
        now,
      );
      return updated ? "review" : "unchanged";
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
}
