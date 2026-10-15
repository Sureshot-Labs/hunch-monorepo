import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import type { Hip4OrderFeeObservation } from "./services/hip4-order-fees.js";

/** Offline synthetic financial terms, never a provider capture. */
export function hip4FeeTestObservation(
  overrides: Partial<Hip4OrderFeeObservation> = {},
): Hip4OrderFeeObservation {
  return {
    version: "hip4-outcome-fees-v1",
    environment: "mainnet",
    address: `0x${"ab".repeat(20)}`,
    marketId: "hyperliquid:mainnet:outcome:1473",
    quoteAssetId: HYPERCORE_MAINNET_USDC.assetId,
    side: "SELL",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    marketRevision: "synthetic-fee-market-1",
    alignmentTreatment: "undiscounted_upper_rate",
    closing: {
      userFees: {
        userSpotCrossRate: "0.0007",
        userSpotAddRate: "0.0004",
        activeReferralDiscount: "0",
      },
      feeScale: "1",
      deployerFeeScale: "1",
    },
    ...overrides,
  };
}
