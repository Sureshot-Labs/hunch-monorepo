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
import { FundingPlanningRuntime } from "../planner/runtime-service.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../planner/production-source-planner.js";
import {
  linkFundingReceiveReceiptOperation,
  listFundingReceiveReceiptsForRouting,
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
  retryableErrors: number;
}>;

export class FundingReceiveReceiptRouter {
  private readonly runtime: FundingPlanningRuntime;

  constructor(private readonly db: Pool) {
    this.runtime = new FundingPlanningRuntime(db);
  }

  async runBatch(
    input: Readonly<{ limit?: number; now?: Date }> = {},
  ): Promise<FundingReceiveReceiptRoutingResult> {
    const now = input.now ?? new Date();
    const targets = await listFundingReceiveReceiptsForRouting(this.db, {
      limit: input.limit ?? 25,
    });
    const counts = {
      operationsCreated: 0,
      receiptsReady: 0,
      recoveriesRequired: 0,
      retryableErrors: 0,
    };
    for (const target of targets) {
      if (target.receipt.status === "observed") {
        try {
          const created = await this.createExactChildOperation(target);
          counts.operationsCreated += created ? 1 : 0;
        } catch {
          // Discovery, pricing, or ownership evidence can be temporarily
          // stale immediately after a receipt. Keep the immutable receipt in
          // `observed`; the next worker pass retries from fresh facts.
          counts.retryableErrors += 1;
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
  ): Promise<boolean> {
    const quote = await quoteFundingReceiveReceipt(this.runtime, target);
    if (!quote) return false;
    if (!quoteWithinReceiveAutomationPolicy(quote, target.automationPolicy)) {
      return false;
    }
    const committed = await this.runtime.commit(target.userId, {
      quoteId: quote.quoteId,
      consentToken: quote.consentToken,
      idempotencyKey: `receive-receipt:${target.receipt.receiptId}`,
    });
    return linkFundingReceiveReceiptOperation(this.db, {
      receiptId: target.receipt.receiptId,
      userId: target.userId,
      childFundingOperationId: committed.operation.id,
      now: new Date(),
    });
  }
}
