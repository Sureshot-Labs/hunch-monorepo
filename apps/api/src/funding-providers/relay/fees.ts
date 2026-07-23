import type { ProviderFee } from "../../funding/domain/contracts.js";
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
    const networkId = networkForRelayChainId(fee.currency.chainId);
    const asset = {
      networkId,
      assetId: normalizeRelayAssetId(networkId, fee.currency.address),
      decimals: fee.currency.decimals,
    };
    assertRelayPinnedAsset(asset);
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
      relayer.amount.asset.decimals !== relayerService.amount.asset.decimals ||
      BigInt(relayer.amount.raw) !==
        BigInt(relayerGas.amount.raw) + BigInt(relayerService.amount.raw)
    ) {
      throw new Error("Relay relayer fee breakdown does not match total");
    }
  }
  const subsidized = normalized("subsidized");
  if (subsidized && BigInt(subsidized.amount.raw) !== 0n) {
    throw new Error("Relay subsidized fee capability is disabled");
  }
  return ["gas", "relayer", "app"]
    .map(normalized)
    .filter(
      (fee): fee is ProviderFee =>
        fee !== null && BigInt(fee.amount.raw) !== 0n,
    );
}
