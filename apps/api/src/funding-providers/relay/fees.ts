import type { ProviderFee } from "../../funding/domain/contracts.js";
import type { AssetRef } from "../../funding/domain/types.js";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";
import {
  assertRelayPinnedAsset,
  networkForRelayChainId,
  normalizeRelayAssetId,
} from "./mappings.js";
import type { RelayQuoteResponse } from "./schemas.js";

const RELAY_FEE_KINDS = new Set([
  "app",
  "gas",
  "relayer",
  "relayerGas",
  "relayerService",
  "subsidized",
]);

export function normalizeRelayFees(
  quote: RelayQuoteResponse,
): readonly ProviderFee[] {
  return readRelayFees(
    quote,
    (currency) => {
      const networkId = networkForRelayChainId(currency.chainId);
      const asset = {
        networkId,
        assetId: normalizeRelayAssetId(networkId, currency.address),
        decimals: currency.decimals,
      };
      assertRelayPinnedAsset(asset);
      return asset;
    },
    true,
  ).fees;
}

/** Only for the validated native sendAsset -> perps depository envelope.
 * The zero currency is a provider balance-class selector, not a new token.
 * Summary fees are charged once. A component rounding discrepancy is reported,
 * never used to alter the summary debit or loosen the caller's fee/debit cap. */
export function normalizeRelayHypercoreFees(quote: RelayQuoteResponse) {
  return readRelayFees(
    quote,
    (currency) => {
      if (
        currency.chainId !== 1337 ||
        currency.address !== `0x${"0".repeat(32)}` ||
        currency.decimals !== 8
      )
        throw new Error("Relay native fee denomination mismatch");
      return HYPERCORE_MAINNET_USDC;
    },
    false,
  );
}

function readRelayFees(
  quote: RelayQuoteResponse,
  normalizeCurrency: (currency: {
    chainId: number;
    address: string;
    decimals: number;
  }) => AssetRef,
  requireExactBreakdown: boolean,
) {
  const fees = quote.fees ?? {};
  for (const kind of Object.keys(fees)) {
    if (!RELAY_FEE_KINDS.has(kind)) {
      throw new Error(`Relay fee ${kind} is outside the pinned schema`);
    }
  }
  const normalized = (kind: string): ProviderFee | null => {
    const fee = fees[kind];
    if (!fee) return null;
    if (fee.currency.decimals === undefined) {
      throw new Error(`Relay fee ${kind} currency decimals are missing`);
    }
    if (
      fee.minimumAmount !== undefined &&
      BigInt(fee.minimumAmount) > BigInt(fee.amount)
    ) {
      throw new Error(`Relay fee ${kind} minimum exceeds amount`);
    }
    const asset = normalizeCurrency({
      ...fee.currency,
      decimals: fee.currency.decimals,
    });
    return {
      kind,
      amount: {
        asset,
        raw: fee.amount,
      },
    };
  };
  const relayer = normalized("relayer");
  const relayerGas = normalized("relayerGas");
  const relayerService = normalized("relayerService");
  let breakdownVarianceRaw: string | null = null;
  if (Boolean(relayerGas) !== Boolean(relayerService)) {
    throw new Error("Relay relayer fee breakdown is incomplete");
  }
  if (relayerGas && relayerService) {
    if (
      !relayer ||
      relayer.amount.asset.networkId !== relayerGas.amount.asset.networkId ||
      relayer.amount.asset.networkId !==
        relayerService.amount.asset.networkId ||
      relayer.amount.asset.assetId !== relayerGas.amount.asset.assetId ||
      relayer.amount.asset.assetId !== relayerService.amount.asset.assetId ||
      relayer.amount.asset.decimals !== relayerGas.amount.asset.decimals ||
      relayer.amount.asset.decimals !== relayerService.amount.asset.decimals
    ) {
      throw new Error("Relay relayer fee breakdown does not match total");
    }
    breakdownVarianceRaw = (
      BigInt(relayer.amount.raw) -
      BigInt(relayerGas.amount.raw) -
      BigInt(relayerService.amount.raw)
    ).toString();
    if (requireExactBreakdown && breakdownVarianceRaw !== "0")
      throw new Error("Relay relayer fee breakdown does not match total");
  }
  const subsidized = normalized("subsidized");
  if (subsidized && BigInt(subsidized.amount.raw) !== 0n) {
    throw new Error("Relay subsidized fee capability is disabled");
  }
  return {
    breakdownVarianceRaw,
    fees: ["gas", "relayer", "app"]
      .map(normalized)
      .filter(
        (fee): fee is ProviderFee =>
          fee !== null && BigInt(fee.amount.raw) !== 0n,
      ),
  };
}

export function normalizeRelayFeeUsd(
  quote: RelayQuoteResponse,
  normalizedFees: readonly ProviderFee[],
): readonly (string | null)[] {
  return normalizedFees.map(
    ({ kind }) => quote.fees?.[kind]?.amountUsd ?? null,
  );
}
