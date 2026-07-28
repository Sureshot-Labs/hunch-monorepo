import type { Pool } from "@hunch/infra";

import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import {
  addUnsignedDecimals,
  compareUnsignedDecimals,
  multiplyRawByUnitPrice,
  multiplyUnsignedDecimals,
} from "../../account-value/decimal.js";
import type { AssetRef, FundingQuoteSummary, Money } from "../domain/types.js";
import { sameAsset } from "../planner/money.js";
import type { FundingPlanningRuntime } from "../planner/runtime-service.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../planner/production-source-planner.js";
import {
  linkFundingReceiveReceiptOperation,
  listFundingReceiveReceiptsForRouting,
  recordFundingReceiveReceiptRoutingDisposition,
  settleFundingReceiveReceiptRouting,
  type FundingReceiveReceiptRoutingTarget,
} from "../persistence/funding-receive-session-repository.js";

const TERMINAL_RECOVERY_STATUSES = new Set([
  "failed",
  "cancelled",
  "refunded",
  "reconcile_required",
  "recovery_required",
]);
const MAX_ROUTING_ATTEMPTS = 5;
const BASE_ROUTING_RETRY_MS = 30_000;

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
    input.receiptAsset.assetId.toLowerCase() ===
      RELAY_PINNED_ASSETS.polygonUsdce &&
    input.destinationAsset.networkId === "evm:137" &&
    input.destinationAsset.assetId.toLowerCase() ===
      RELAY_PINNED_ASSETS.polygonPusd;
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
      option.source.kind !== "owned_location" ||
      !sameAsset(option.source.location.asset, target.receipt.asset)
    ) {
      return false;
    }
    const address = option.source.location.details.address;
    return (
      typeof address === "string" &&
      address.toLowerCase() === target.receipt.destinationAddress.toLowerCase()
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
    requestedDestinationAmount: amounts.requestedDestinationAmount,
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
        } catch {
          counts.retryableErrors += 1;
          const disposition = await this.deferOrRecoverReceipt(
            target,
            "routing_attempt_failed",
            now,
          ).catch(() => "unchanged" as const);
          counts.retriesScheduled += disposition === "retry" ? 1 : 0;
          counts.recoveriesRequired += disposition === "recovery" ? 1 : 0;
        }
        continue;
      }
      if (target.childOperationStatus === "completed") {
        const settled = await settleFundingReceiveReceiptRouting(this.db, {
          receiptId: target.receipt.receiptId,
          receiveSessionId: target.receipt.receiveSessionId,
          userId: target.userId,
          status: "ready",
          now,
        });
        counts.receiptsReady += settled ? 1 : 0;
        continue;
      }
      if (
        target.childOperationStatus &&
        TERMINAL_RECOVERY_STATUSES.has(target.childOperationStatus)
      ) {
        const settled = await settleFundingReceiveReceiptRouting(this.db, {
          receiptId: target.receipt.receiptId,
          receiveSessionId: target.receipt.receiveSessionId,
          userId: target.userId,
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
    if (nextAttempt >= MAX_ROUTING_ATTEMPTS) {
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
    const delayMs = Math.min(
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
