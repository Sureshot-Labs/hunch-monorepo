import { env } from "../../env.js";
import type { MarketByTokenRow } from "../../repos/unified-read.js";
import { buildPolymarketRedemptionPlan } from "../../services/polymarket-redemption-plan.js";
import { fetchPolymarketAccountRoute } from "../../services/polymarket-trading-execution-service.js";
import { syncPositionsForUserWallet } from "../../services/positions-sync.js";
import {
  buildUnavailableRedemptionPlan,
  type RedemptionPlan,
} from "../../services/redemption-plan.js";
import { isRecord } from "../../lib/type-guards.js";
import type { JsonObject } from "../domain/types.js";
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

function unavailablePlan(input: {
  reason: "missing_condition_id" | "missing_token_id";
}): RedemptionPlan {
  return buildUnavailableRedemptionPlan({
    venue: "polymarket",
    chainId: 137,
    reason: input.reason,
    reasonMessage:
      input.reason === "missing_condition_id"
        ? "Canonical position condition is unavailable."
        : "Canonical position token is unavailable.",
  });
}

function marketContext(
  row: MarketByTokenRow,
  outcome: "NO" | "YES",
): RedemptionMarketContext {
  const isNegRisk = row.pm_neg_risk === true;
  return {
    adapterAddress: isNegRisk
      ? env.polymarketNegRiskCollateralAdapterAddress || null
      : env.polymarketCtfCollateralAdapterAddress || null,
    conditionId: row.condition_id,
    isNegRisk,
    marketClass: isNegRisk ? "neg_risk" : "standard",
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
  return buildPolymarketRedemptionPlan({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    funder: input.position.walletAddress,
    conditionalTokensAddress: env.polymarketConditionalTokensAddress,
    collateralTokenAddress: env.polymarketUsdcAddress,
    legacyCollateralTokenAddress: env.polymarketUsdceAddress,
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress ?? null,
    ctfCollateralAdapterAddress:
      env.polymarketCtfCollateralAdapterAddress ?? null,
    negRiskCollateralAdapterAddress:
      env.polymarketNegRiskCollateralAdapterAddress ?? null,
    executionKind: "external_adapter",
    outcome: input.market.outcome,
    positionTokenId: input.position.tokenId,
    conditionId: input.market.conditionId,
    questionId: input.market.row.pm_question_id,
    negRiskParentConditionId: input.market.row.pm_neg_risk_parent_condition_id,
    negRiskRequestId: input.market.row.pm_neg_risk_request_id,
    isNegRisk: input.market.isNegRisk,
  });
}

const observeReceipt = createEvmPositionActionReceiptObserver(137);

export function createPolymarketPositionActionVenueDriver(): PositionActionVenueDriver {
  return {
    adapterId: "polymarket-owner-redemption-v1",
    venueId: "polymarket",
    buildMarketContext: marketContext,
    buildPlan,
    conditionalTokensAddress: () => env.polymarketConditionalTokensAddress,
    inspectOperatorApproval: async (input) => {
      if (!input.plan.operatorApprovalAddress) return true;
      const result = await fetchPolymarketAccountRoute({
        userId: input.userId,
        signer: input.signerAddress,
        query: { funderAddress: input.ownerAddress, refresh: true },
      });
      if (!result.ok) return null;
      return readBoolean(result.payload, [
        "conditionalTokens",
        "isApprovedForAll",
        input.market.isNegRisk
          ? "negRiskCollateralAdapter"
          : "ctfCollateralAdapter",
      ]);
    },
    resolveExecutionProfile: (input) => {
      const topologySupported = [
        "signer",
        "deposit_wallet",
        "safe_1_1",
        "magic_proxy",
      ].includes(input.topology);
      const payload: JsonObject = {
        topology: input.topology,
        funder: input.ownerAddress,
      };
      return {
        topologySupported,
        unsupportedReason:
          input.topology === "safe_unsupported"
            ? "unsupported_safe_threshold"
            : "unsupported_wallet_topology",
        externalHandoff:
          input.topology === "signer"
            ? null
            : {
                handoffKind: "polymarket_proxy_execute",
                payload,
              },
      };
    },
    observeReceipt,
    refreshPositions: async (input) => {
      await syncPositionsForUserWallet(input.db, {
        userId: input.userId,
        walletAddress: input.walletAddress,
        venue: "polymarket",
      });
    },
  };
}
