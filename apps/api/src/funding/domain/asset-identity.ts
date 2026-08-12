import type { AssetRef } from "./types.js";

const EVM_NETWORK_PATTERN = /^evm:[1-9][0-9]*$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isEvmNetworkId(networkId: string): boolean {
  return EVM_NETWORK_PATTERN.test(networkId);
}

export function isEvmAddress(address: string): boolean {
  return EVM_ADDRESS_PATTERN.test(address);
}

export function canonicalAssetId(asset: AssetRef): string {
  return isEvmNetworkId(asset.networkId) &&
    EVM_ADDRESS_PATTERN.test(asset.assetId)
    ? asset.assetId.toLowerCase()
    : asset.assetId;
}

export function canonicalAssetKey(asset: AssetRef): string {
  return `${asset.networkId}:${canonicalAssetId(asset)}:${asset.decimals}`;
}

export function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return (
    left.networkId === right.networkId &&
    canonicalAssetId(left) === canonicalAssetId(right) &&
    left.decimals === right.decimals
  );
}

export function canonicalAccountAddress(
  networkId: string,
  address: string,
): string {
  return isEvmNetworkId(networkId) && isEvmAddress(address)
    ? address.toLowerCase()
    : address;
}

export function sameAccountAddress(
  networkId: string,
  left: string,
  right: string,
): boolean {
  return (
    canonicalAccountAddress(networkId, left) ===
    canonicalAccountAddress(networkId, right)
  );
}
