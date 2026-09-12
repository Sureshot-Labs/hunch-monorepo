export type DepositTransfer = {
  caip2: string;
  sender?: string | null;
  asset: { address?: string | null };
};
export type DepositVenueConfig = Readonly<{
  polymarketPusdAddress: string;
  polymarketUsdcAddress: string;
  polymarketUsdceAddress: string;
  polymarketExchangeAddress: string;
  polymarketNegRiskExchangeAddress: string;
  polymarketNegRiskAdapterAddress: string;
  polymarketCollateralOnrampAddress: string;
  polymarketCollateralOfframpAddress: string;
  limitlessUsdcAddress: string;
  limitlessClobAddress: string;
  limitlessNegRiskAddress: string;
}>;

export const HUNCH_SOLANA_CHAIN_ID = "7565164";
export const POLYGON_CHAIN_ID = "137";
export const BASE_CHAIN_ID = "8453";
export const ACROSS_SOLANA_DEPOSIT_SENDER =
  "E4bX4nCwe2GcKqt9NpofnXVrCeRp37PAMaiZtV9x3kxC";
const ACROSS_BASE_WITHDRAW_SENDER =
  "0xcad97616f91872c02ba3553db315db4015cbe850";
const ACROSS_BASE_SPOKE_POOL_SENDER =
  "0xfd03abcadaf3f930fa4e37eb2f6ea3a44a41b7f0";
const ACROSS_BASE_FILL_TRANSFER_SENDER =
  "0x0f7ae28de1c8532170ad4ee566b5801485c13a0e";
const ACROSS_POLYGON_DEPOSIT_SENDER =
  "0xb5b25e9b8c5c2d4e03ca0a79e42aa226cdec3ff2";
const ACROSS_POLYGON_ENTRYPOINT_SENDER =
  "0x0000000071727de22e5e9d8baf0edac6f37da032";
const ACROSS_POLYGON_FILL_TRANSFER_SENDER =
  "0x0000000000000000000000000000000000000000";
const ACROSS_POLYGON_FILL_TRANSFER_FROM_SENDER =
  "0x07ae8551be970cb1cca11dd7a11f47ae82e70e67";
const KNOWN_ACROSS_DEPOSIT_SENDERS_BY_CHAIN: Record<string, Set<string>> = {
  [HUNCH_SOLANA_CHAIN_ID]: new Set([ACROSS_SOLANA_DEPOSIT_SENDER]),
  [BASE_CHAIN_ID]: new Set([
    ACROSS_BASE_WITHDRAW_SENDER,
    ACROSS_BASE_SPOKE_POOL_SENDER,
    ACROSS_BASE_FILL_TRANSFER_SENDER,
  ]),
  [POLYGON_CHAIN_ID]: new Set([
    ACROSS_POLYGON_DEPOSIT_SENDER,
    ACROSS_POLYGON_ENTRYPOINT_SENDER,
    ACROSS_POLYGON_FILL_TRANSFER_SENDER,
    ACROSS_POLYGON_FILL_TRANSFER_FROM_SENDER,
  ]),
};

function normalizeKnownAcrossSender(chainId: string, sender: string): string {
  return chainId === HUNCH_SOLANA_CHAIN_ID
    ? sender.trim()
    : sender.toLowerCase();
}

export function isKnownAcrossBridgeDeposit(event: DepositTransfer): boolean {
  const chainId = resolveBridgeChainIdFromCaip2(event.caip2);
  const sender = event.sender?.trim();
  if (!chainId || !sender) return false;
  return (
    KNOWN_ACROSS_DEPOSIT_SENDERS_BY_CHAIN[chainId]?.has(
      normalizeKnownAcrossSender(chainId, sender),
    ) ?? false
  );
}

export function normalizeEvmAddress(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function resolveBridgeChainIdFromCaip2(caip2: string): string | null {
  const normalized = caip2.trim().toLowerCase();
  if (normalized.startsWith("eip155:")) {
    const chainId = normalized.slice("eip155:".length).trim();
    return chainId || null;
  }
  if (normalized.startsWith("solana:")) {
    return HUNCH_SOLANA_CHAIN_ID;
  }
  return null;
}

function buildAddressSet(
  values: Array<string | null | undefined>,
): Set<string> {
  return new Set(
    values
      .map((value) => normalizeEvmAddress(value))
      .filter((value): value is string => Boolean(value)),
  );
}

export function isVenueCashDeposit(
  event: DepositTransfer,
  config: DepositVenueConfig,
): boolean {
  const caip2 = event.caip2.toLowerCase();
  const sender = normalizeEvmAddress(event.sender);
  const assetAddress = normalizeEvmAddress(event.asset.address);
  if (!sender || !assetAddress) return false;

  if (caip2 === "eip155:137") {
    const cashAssets = buildAddressSet([
      config.polymarketPusdAddress,
      config.polymarketUsdcAddress,
      config.polymarketUsdceAddress,
    ]);
    const venueSenders = buildAddressSet([
      config.polymarketExchangeAddress,
      config.polymarketNegRiskExchangeAddress,
      config.polymarketNegRiskAdapterAddress,
      config.polymarketCollateralOnrampAddress,
      config.polymarketCollateralOfframpAddress,
    ]);
    return cashAssets.has(assetAddress) && venueSenders.has(sender);
  }

  if (caip2 === "eip155:8453") {
    const cashAssets = buildAddressSet([config.limitlessUsdcAddress]);
    const venueSenders = buildAddressSet([
      config.limitlessClobAddress,
      config.limitlessNegRiskAddress,
    ]);
    return cashAssets.has(assetAddress) && venueSenders.has(sender);
  }

  return false;
}
