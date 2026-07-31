import type { Pool } from "@hunch/infra";

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
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../domain/network-fees.js";
import { sameAsset } from "../planner/money.js";
import type { FundingPlanningRuntime } from "../planner/runtime-service.js";
import {
  linkFundingReceiveReceiptOperation,
  listFundingReceiveReceiptsForRouting,
  recordFundingReceiveReceiptRoutingDisposition,
  settleFundingReceiveReceiptRouting,
  type FundingReceiveReceiptRoutingTarget,
} from "../persistence/funding-receive-session-repository.js";

const TERMINAL_UNCERTAIN_STATUSES = new Set([
  "refunded",
  "reconcile_required",
  "recovery_required",
]);
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

export type FundingReceiveChildOperationDisposition =
  | "ready"
  | "review_retry"
  | "recovery"
  | "waiting";

/**
 * A failed/cancelled child is retryable only when durable attempt evidence
 * proves that no broadcast was possible and no attempt remains unresolved.
 * Everything ambiguous fails closed to recovery instead of rebroadcasting.
 */
export function fundingReceiveChildOperationDisposition(input: {
  childOperationStatus: string | null;
  broadcastMayHaveOccurred: boolean;
  hasUnfinishedAttempt: boolean;
}): FundingReceiveChildOperationDisposition {
  if (input.childOperationStatus === "completed") return "ready";
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

export async function quoteFundingReceiveReceipt(
  runtime: Pick<FundingPlanningRuntime, "liquidity" | "quote">,
  target: FundingReceiveReceiptRoutingTarget,
): Promise<FundingQuoteSummary | null> {
  if (target.receipt.rawAmount === "0") return null;
  const amounts = receiveReceiptRoutingAmounts({
    receiptAsset: target.receipt.asset,
    destinationAsset: target.destinationAsset,
    rawAmount: target.receipt.rawAmount,
  });
  if (amounts.confirmedSourceAmount?.raw === "0") return null;
  const liquidity = await runtime.liquidity(target.userId, {
    purpose: "add_funds",
    marketContextId: null,
    confirmedSourceAmount: amounts.confirmedSourceAmount,
    requestedDestinationAmount: amounts.requestedDestinationAmount,
    destinationOptionId: target.destinationOptionId,
    venueBindingOptionId: target.venueBindingOptionId,
    withdrawalRecipientId: null,
    maxFeeUsd: target.automationPolicy.maximumFeeUsd,
    maxSlippageBps: target.automationPolicy.maximumSlippageBps,
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
    "liquidity" | "quote" | "commit"
  > | null;

  constructor(
    private readonly db: Pool,
    runtime?: Pick<FundingPlanningRuntime, "liquidity" | "quote" | "commit">,
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
          if (outcome === "created") {
            counts.operationsCreated += 1;
          } else if (outcome === "outside_policy") {
            const updated = await recordFundingReceiveReceiptRoutingDisposition(
              this.db,
              {
                receiptId: target.receipt.receiptId,
                receiveSessionId: target.receipt.receiveSessionId,
                userId: target.userId,
                disposition: "review_required",
                errorCode: "automation_policy_exceeded",
                now,
              },
            );
            counts.reviewsRequired += updated ? 1 : 0;
          } else {
            const disposition = await this.deferOrRecoverReceipt(
              target,
              "route_unavailable",
              now,
            );
            counts.retriesScheduled += disposition === "retry" ? 1 : 0;
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
          counts.recoveriesRequired += disposition === "recovery" ? 1 : 0;
        }
        continue;
      }
      const childDisposition = fundingReceiveChildOperationDisposition({
        childOperationStatus: target.childOperationStatus,
        broadcastMayHaveOccurred: target.childBroadcastMayHaveOccurred,
        hasUnfinishedAttempt: target.childHasUnfinishedAttempt,
      });
      const childOperationId = target.receipt.childFundingOperationId;
      if (!childOperationId) continue;
      if (childDisposition === "ready") {
        const settled = await settleFundingReceiveReceiptRouting(this.db, {
          receiptId: target.receipt.receiptId,
          receiveSessionId: target.receipt.receiveSessionId,
          userId: target.userId,
          childOperationId,
          childOperationStatus: target.childOperationStatus ?? "completed",
          status: "ready",
          now,
        });
        counts.receiptsReady += settled ? 1 : 0;
        continue;
      }
      if (childDisposition === "review_retry") {
        const settled = await settleFundingReceiveReceiptRouting(this.db, {
          receiptId: target.receipt.receiptId,
          receiveSessionId: target.receipt.receiveSessionId,
          userId: target.userId,
          childOperationId,
          childOperationStatus: target.childOperationStatus ?? "failed",
          status: "review_required",
          now,
        });
        counts.reviewsRequired += settled ? 1 : 0;
        continue;
      }
      if (childDisposition === "recovery") {
        const settled = await settleFundingReceiveReceiptRouting(this.db, {
          receiptId: target.receipt.receiptId,
          receiveSessionId: target.receipt.receiveSessionId,
          userId: target.userId,
          childOperationId,
          childOperationStatus:
            target.childOperationStatus ?? "recovery_required",
          status: "recovery_required",
          now,
        });
        counts.recoveriesRequired += settled ? 1 : 0;
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
  ): Promise<"created" | "no_route" | "outside_policy"> {
    const runtime = await this.planningRuntime();
    const quote = await quoteFundingReceiveReceipt(runtime, target);
    if (!quote) return "no_route";
    if (!quoteWithinReceiveAutomationPolicy(quote, target.automationPolicy)) {
      return "outside_policy";
    }
    const committed = await runtime.commit(target.userId, {
      quoteId: quote.quoteId,
      consentToken: quote.consentToken,
      idempotencyKey: `receive-receipt:${target.receipt.receiptId}`,
    });
    const linked = await linkFundingReceiveReceiptOperation(this.db, {
      receiptId: target.receipt.receiptId,
      userId: target.userId,
      childFundingOperationId: committed.operation.id,
      now,
    });
    return linked ? "created" : "no_route";
  }

  private async planningRuntime(): Promise<
    Pick<FundingPlanningRuntime, "liquidity" | "quote" | "commit">
  > {
    if (this.runtime) return this.runtime;
    const { FundingPlanningRuntime: Runtime } =
      await import("../planner/runtime-service.js");
    this.runtime = new Runtime(this.db);
    return this.runtime;
  }

  private async deferOrRecoverReceipt(
    target: FundingReceiveReceiptRoutingTarget,
    errorCode: string,
    now: Date,
  ): Promise<"retry" | "recovery" | "unchanged"> {
    const nextAttempt = target.routingAttemptCount + 1;
    if (fundingReceiveRoutingNeedsRecovery(errorCode, nextAttempt)) {
      const updated = await recordFundingReceiveReceiptRoutingDisposition(
        this.db,
        {
          receiptId: target.receipt.receiptId,
          receiveSessionId: target.receipt.receiveSessionId,
          userId: target.userId,
          disposition: "recovery_required",
          errorCode,
          now,
        },
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
