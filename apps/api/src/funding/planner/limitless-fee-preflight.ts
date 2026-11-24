import { ethers } from "ethers";

import { isRecord } from "../../lib/type-guards.js";
import { isLimitlessAmmMarketMetadata } from "../../services/limitless-market-mode.js";
import {
  assertLimitlessFeeModuleAllowance,
  assertLimitlessMarketPayloadSlug,
  readLimitlessClobFeePolicy,
  unavailableLimitlessFeePolicy,
  type LimitlessClobFeePolicy,
} from "../../services/limitless-clob-fees.js";
import { fetchErc20Allowance } from "../../services/polygon-rpc.js";
import { buildLimitlessPartnerHmacHeaders } from "../../services/limitless-partner-auth.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import type { LimitlessFundingReconciliationConfig } from "../reconciliation/limitless-trade-attempt-reconciler.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";

/** Revalidate the exact venue wallet in the sealed Buy plan before moving funds. */
export async function assertLimitlessTradeFundingFeeAllowance(
  operation: Pick<
    FundingCommitPlan["operation"],
    | "purpose"
    | "venueId"
    | "marketId"
    | "destinationTargetSnapshot"
    | "supportMetadata"
  >,
  dependencies: {
    loadMarket: (id: string) => Promise<{
      venue: string;
      slug: string | null;
      metadata: unknown;
    } | null>;
    loadFeePolicy: (slug: string) => Promise<LimitlessClobFeePolicy>;
    verifyAllowance: (
      policy: LimitlessClobFeePolicy,
      owner: string,
    ) => Promise<void>;
  },
): Promise<void> {
  if (
    operation.purpose !== "trade_shortfall" ||
    operation.venueId !== "limitless" ||
    operation.supportMetadata?.limitlessFundingOrderType === "GTC"
  ) {
    return;
  }
  const market = operation.marketId
    ? await dependencies.loadMarket(operation.marketId)
    : null;
  if (!market || market.venue !== "limitless") {
    throw unavailableLimitlessFeePolicy();
  }
  if (isLimitlessAmmMarketMetadata(market.metadata)) return;
  if (!market.slug) throw unavailableLimitlessFeePolicy();
  const policy = await dependencies.loadFeePolicy(market.slug);
  if (policy.mode === "legacy") return;
  await dependencies.verifyAllowance(
    policy,
    requireLimitlessFeeFundingWallet(
      operation.destinationTargetSnapshot,
      policy,
    ),
  );
}

export function requireLimitlessFeeFundingWallet(
  target: FundingCommitPlan["operation"]["destinationTargetSnapshot"],
  policy: Extract<LimitlessClobFeePolicy, { mode: "collateral" }>,
): string {
  const location = target.location;
  const details = isRecord(location) ? location.details : null;
  const asset = isRecord(location) ? location.asset : null;
  if (
    target.kind !== "owned_location" ||
    !isRecord(location) ||
    location.kind !== "venue_account" ||
    !isRecord(details) ||
    details.venueId !== "limitless" ||
    typeof details.address !== "string" ||
    !ethers.isAddress(details.address) ||
    details.address.toLowerCase() === ethers.ZeroAddress ||
    typeof details.accountRef !== "string" ||
    details.accountRef.toLowerCase() !== details.address.toLowerCase() ||
    !isRecord(asset) ||
    asset.networkId !== "evm:8453" ||
    typeof asset.assetId !== "string" ||
    asset.assetId.toLowerCase() !== policy.collateralToken.toLowerCase() ||
    asset.decimals !== 6
  ) {
    throw unavailableLimitlessFeePolicy();
  }
  return ethers.getAddress(details.address);
}

/** Secret-minimal worker dependencies; no API runtime imports. */
export function delegatedLimitlessFeeDependencies(
  config: LimitlessFundingReconciliationConfig,
) {
  return {
    loadFeePolicy: async (slug: string): Promise<LimitlessClobFeePolicy> => {
      const requestPath = `/markets/${encodeURIComponent(slug)}`;
      const response = await fetch(
        `${config.apiBase.replace(/\/$/, "")}${requestPath}`,
        {
          headers: {
            ...buildLimitlessPartnerHmacHeaders({
              hmacSecret: config.hmacSecret,
              hmacTokenId: config.hmacTokenId,
              method: "GET",
              requestPath,
            }),
            ...(config.apiVersion
              ? { "x-api-version": config.apiVersion }
              : {}),
          },
          signal: AbortSignal.timeout(
            Math.min(4_000, config.timeoutMs ?? 4_000),
          ),
        },
      ).catch(() => null);
      if (!response?.ok) throw unavailableLimitlessFeePolicy();
      const payload: unknown = await response.json().catch(() => null);
      assertLimitlessMarketPayloadSlug(payload, slug);
      return readLimitlessClobFeePolicy(
        payload,
        fundingSidecarRuntimeConfig.limitlessUsdcAddress,
      );
    },
    verifyAllowance: (policy: LimitlessClobFeePolicy, owner: string) =>
      assertLimitlessFeeModuleAllowance({
        policy,
        owner,
        readAllowance: (request) =>
          fetchErc20Allowance({
            ...request,
            rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
            timeoutMs: Math.min(
              3_000,
              fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
            ),
          }),
      }),
  };
}
