import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import type { ApiBotTradingExecutor } from "../../services/api-trading-service.js";
import type { TradingReadiness } from "../../services/trading-types.js";
import { sameAsset } from "../domain/asset-identity.js";
import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
  Money,
  WalletExecutionProfile,
} from "../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import { POLYGON_PUSD } from "../../funding-providers/relay/rehearsal.js";

type TrustedPreflightResult = Readonly<{
  additionalDestinationAmount: Money | null;
  fundingRequired: boolean;
  request: FundingDiscoveryRequest;
}>;

export type TrustedTradeShortfallPreflight = Readonly<{
  additionalDestinationAmount: Money | null;
  fundingRequired: boolean;
  liquidity: IntentLiquidityProjection | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalPolygonPusdAddress(): string {
  return (
    fundingSidecarRuntimeConfig.polymarketPusdAddress || POLYGON_PUSD
  ).toLowerCase();
}

function isCanonicalPolymarketPusd(input: Money): boolean {
  return (
    input.asset.networkId === "evm:137" &&
    input.asset.decimals === 6 &&
    input.asset.assetId.toLowerCase() === canonicalPolygonPusdAddress()
  );
}

function controlledPolymarketFundsRaw(
  readiness: TradingReadiness,
): string | null {
  if (
    !isRecord(readiness.raw) ||
    readiness.raw.kind !== "polymarket_funds_v1"
  ) {
    return null;
  }
  const raw = readiness.raw.controlledFundsRaw;
  return typeof raw === "string" && /^\d+$/u.test(raw) ? raw : null;
}

function selectedControllerProfile(
  account: AccountValueReadModel,
  controllerWalletRef: string | null | undefined,
): WalletExecutionProfile | null {
  if (!controllerWalletRef) return null;
  return (
    account.ownership?.wallets.find(
      (profile) =>
        profile.controllerWalletRef === controllerWalletRef &&
        profile.networkId === "evm:137" &&
        Boolean(profile.serverWalletRef?.trim()),
    ) ?? null
  );
}

/**
 * Builds the internal form of a public trade-shortfall request. The browser
 * may choose the trade amount, but it cannot state how much controlled venue
 * liquidity is already executable: that fact comes only from readiness.
 */
export function deriveTrustedTradeShortfallRequest(input: {
  readiness: TradingReadiness;
  request: FundingDiscoveryRequest;
}): TrustedPreflightResult {
  const requested = input.request.requestedDestinationAmount;
  const consumerIntent = input.request.consumerIntent;
  if (
    input.request.purpose !== "trade_shortfall" ||
    !requested ||
    !consumerIntent ||
    consumerIntent.venueId !== "polymarket" ||
    !isCanonicalPolymarketPusd(requested) ||
    !sameAsset(consumerIntent.spend.asset, requested.asset)
  ) {
    return {
      additionalDestinationAmount: null,
      fundingRequired: true,
      request: input.request,
    };
  }
  const controlledRaw = controlledPolymarketFundsRaw(input.readiness);
  if (controlledRaw == null) {
    return {
      additionalDestinationAmount: null,
      fundingRequired: true,
      request: input.request,
    };
  }
  const requestedRaw = BigInt(requested.raw);
  const additionalRaw = requestedRaw - BigInt(controlledRaw);
  if (additionalRaw <= 0n) {
    return {
      additionalDestinationAmount: null,
      fundingRequired: false,
      request: input.request,
    };
  }
  const additionalDestinationAmount: Money = {
    asset: requested.asset,
    raw: additionalRaw.toString(),
  };
  return {
    additionalDestinationAmount,
    fundingRequired: true,
    request: {
      ...input.request,
      serverAdditionalDestinationAmount: additionalDestinationAmount,
    },
  };
}

export async function preflightTrustedTradeShortfall(input: {
  account: AccountValueReadModel;
  liquidity: (
    request: FundingDiscoveryRequest,
  ) => Promise<IntentLiquidityProjection>;
  request: FundingDiscoveryRequest;
  trading: Pick<ApiBotTradingExecutor, "getReadiness">;
  userId: string;
}): Promise<TrustedTradeShortfallPreflight> {
  const fallback = async (): Promise<TrustedTradeShortfallPreflight> => ({
    additionalDestinationAmount: null,
    fundingRequired: true,
    liquidity: await input.liquidity(input.request),
  });
  const profile = selectedControllerProfile(
    input.account,
    input.request.controllerWalletRef,
  );
  const consumerIntent = input.request.consumerIntent;
  if (
    input.request.purpose !== "trade_shortfall" ||
    !profile?.serverWalletRef ||
    !consumerIntent ||
    consumerIntent.venueId !== "polymarket"
  ) {
    return fallback();
  }
  let readiness: TradingReadiness;
  try {
    readiness = await input.trading.getReadiness({
      actor: { kind: "web_app", userId: input.userId },
      action: "BUY",
      executionAuthorization: {
        privyWalletId: profile.serverWalletRef,
      },
      privyWalletId: profile.serverWalletRef,
      target: {
        venue: "polymarket",
        marketId: consumerIntent.marketId,
        venueMarketId: null,
        eventId: null,
        tokenId: null,
        outcome: consumerIntent.side,
        title: null,
      },
      venue: "polymarket",
      walletAddress: profile.address,
      walletChain: "ethereum",
    });
  } catch {
    return fallback();
  }
  const derived = deriveTrustedTradeShortfallRequest({
    readiness,
    request: input.request,
  });
  if (!derived.fundingRequired) {
    return {
      additionalDestinationAmount: null,
      fundingRequired: false,
      liquidity: null,
    };
  }
  return {
    additionalDestinationAmount: derived.additionalDestinationAmount,
    fundingRequired: true,
    liquidity: await input.liquidity(derived.request),
  };
}
