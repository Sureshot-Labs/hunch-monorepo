import { env } from "../../env.js";
import { extractLimitlessMetadata } from "../../lib/limitless-metadata.js";
import { isRecord } from "../../lib/type-guards.js";
import type { MarketByTokenRow } from "../../repos/unified-read.js";
import { buildLimitlessRedemptionPlan } from "../../services/limitless-redemption-plan.js";
import { fetchLimitlessAccountRoute } from "../../services/limitless-trading-execution-service.js";
import { syncPositionsForUserWallet } from "../../services/positions-sync.js";
import {
  buildUnavailableRedemptionPlan,
  type RedemptionPlan,
} from "../../services/redemption-plan.js";
import {
  createEvmPositionActionReceiptObserver,
  type PositionActionVenueDriver,
  type RedemptionMarketContext,
  type StoredPositionContext,
} from "./venue-driver.js";

function readBoolean(value: unknown, path: readonly string[]): boolean | null {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === "boolean" ? cursor : null;
}

function isNegRisk(
  metadata: ReturnType<typeof extractLimitlessMetadata>,
): boolean {
  return Boolean(
    metadata.negRiskRequestId ||
    metadata.negRiskMarketId ||
    metadata.venueAdapter ||
    metadata.venueExchange,
  );
}

function unavailablePlan(input: {
  reason: "adapter_unavailable" | "missing_condition_id" | "missing_token_id";
}): RedemptionPlan {
  return buildUnavailableRedemptionPlan({
    venue: "limitless",
    chainId: 8453,
    reason: input.reason,
    reasonMessage:
      input.reason === "missing_condition_id"
        ? "Canonical position condition is unavailable."
        : input.reason === "missing_token_id"
          ? "Canonical position token is unavailable."
          : "Canonical redemption adapter is unavailable.",
  });
}

function marketContext(
  row: MarketByTokenRow,
  outcome: "NO" | "YES",
): RedemptionMarketContext {
  const metadata = extractLimitlessMetadata(
    row.market_metadata,
    row.event_metadata,
  );
  const negRisk = isNegRisk(metadata);
  const tradeType =
    metadata.tradeType?.toLowerCase() === "amm" ? "amm" : "clob";
  return {
    adapterAddress: negRisk ? (metadata.venueAdapter ?? null) : null,
    conditionId: row.condition_id,
    isNegRisk: negRisk,
    marketClass: negRisk ? `${tradeType}_neg_risk` : tradeType,
    marketId: row.market_id,
    outcome,
    row,
  };
}

async function buildPlan(input: {
  market: RedemptionMarketContext;
  position: StoredPositionContext;
}): Promise<RedemptionPlan> {
  if (!input.market.conditionId) {
    return unavailablePlan({ reason: "missing_condition_id" });
  }
  if (!input.position.tokenId.trim()) {
    return unavailablePlan({ reason: "missing_token_id" });
  }
  if (input.market.isNegRisk && !input.market.adapterAddress) {
    return unavailablePlan({ reason: "adapter_unavailable" });
  }
  return buildLimitlessRedemptionPlan({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    owner: input.position.walletAddress,
    conditionId: input.market.conditionId,
    tokenId: input.position.tokenId,
    outcome: input.market.outcome,
    isNegRisk: input.market.isNegRisk,
    adapterAddress: input.market.adapterAddress,
  });
}

const observeReceipt = createEvmPositionActionReceiptObserver(8453);

export function createLimitlessPositionActionVenueDriver(): PositionActionVenueDriver {
  return {
    adapterId: "limitless-owner-redemption-v1",
    venueId: "limitless",
    buildMarketContext: marketContext,
    buildPlan,
    conditionalTokensAddress: () => env.limitlessConditionalTokensAddress,
    inspectOperatorApproval: async (input) => {
      if (!input.plan.operatorApprovalAddress) return true;
      const result = await fetchLimitlessAccountRoute({
        userId: input.userId,
        signerRaw: input.signerAddress,
        query: {
          refresh: true,
          adapterSpender: input.plan.operatorApprovalAddress,
          tokenId: input.market.row.token_id,
        },
      });
      return result.ok
        ? readBoolean(result.payload, [
            "conditionalTokens",
            "isApprovedForAll",
            "adapter",
          ])
        : null;
    },
    resolveExecutionProfile: (input) => ({
      topologySupported:
        input.topology === "internal_eoa" || input.topology === "external_eoa",
      unsupportedReason: "unsupported_wallet_topology",
      externalHandoff: null,
    }),
    observeReceipt,
    refreshPositions: async (input) => {
      await syncPositionsForUserWallet(input.db, {
        userId: input.userId,
        walletAddress: input.walletAddress,
        venue: "limitless",
      });
    },
  };
}
