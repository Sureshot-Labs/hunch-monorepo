import { ethers } from "ethers";

import { isRecord } from "../../lib/type-guards.js";
import { isLimitlessAmmMarketMetadata } from "../../services/limitless-market-mode.js";
import { extractLimitlessMarketExchangeAddress } from "../../services/limitless-market-contracts.js";
import {
  assertLimitlessExchangeAllowance,
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
    loadFeePolicy: (slug: string) => Promise<{
      policy: LimitlessClobFeePolicy;
      exchangeAddress: string | null;
    }>;
    verifyAllowance: (
      policy: LimitlessClobFeePolicy,
      owner: string,
    ) => Promise<void>;
    verifyExchangeAllowance: (
      input: Omit<
        Parameters<typeof assertLimitlessExchangeAllowance>[0],
        "readAllowance"
      >,
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
  const { policy, exchangeAddress } = await dependencies.loadFeePolicy(
    market.slug,
  );
  if (policy.mode === "legacy") return;
  const owner = requireLimitlessFeeFundingWallet(
    operation.destinationTargetSnapshot,
    policy,
  );
  const principalRaw = operation.supportMetadata?.limitlessClobBuyPrincipalRaw;
  // Only new sealed quotes carry the exact consumer principal. The transfer
  // amount may be just the shortfall, with a fee reserve, and is not authority.
  if (principalRaw !== undefined) {
    if (
      typeof principalRaw !== "string" ||
      !/^[1-9]\d{0,77}$/.test(principalRaw) ||
      !exchangeAddress
    )
      throw unavailableLimitlessFeePolicy();
    await dependencies.verifyExchangeAllowance({
      policy,
      owner,
      exchangeAddress,
      principal: BigInt(principalRaw),
    });
  }
  await dependencies.verifyAllowance(policy, owner);
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
  const readAllowance: Parameters<
    typeof assertLimitlessExchangeAllowance
  >[0]["readAllowance"] = (request) =>
    fetchErc20Allowance({
      ...request,
      rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
      timeoutMs: Math.min(3_000, fundingSidecarRuntimeConfig.baseRpcTimeoutMs),
    });
  return {
    loadFeePolicy: async (slug: string) => {
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
      return {
        policy: readLimitlessClobFeePolicy(
          payload,
          fundingSidecarRuntimeConfig.limitlessUsdcAddress,
        ),
        exchangeAddress: extractLimitlessMarketExchangeAddress(payload),
      };
    },
    verifyAllowance: (policy: LimitlessClobFeePolicy, owner: string) =>
      assertLimitlessFeeModuleAllowance({
        policy,
        owner,
        readAllowance,
      }),
    verifyExchangeAllowance: (
      input: Omit<
        Parameters<typeof assertLimitlessExchangeAllowance>[0],
        "readAllowance"
      >,
    ) => assertLimitlessExchangeAllowance({ ...input, readAllowance }),
  };
}
