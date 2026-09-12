// Pure formatting shared by API webhooks and receive workers.
import type { NotificationInput } from "./notifications.js";

export function parseScaledAmount(
  raw: string,
  decimals: number,
): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value) || decimals < 0 || decimals > 30) return null;
  const scale = 10 ** decimals;
  const parsed = Number(value) / scale;
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatScaledAmount(
  raw: string,
  decimals: number,
): string | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value) || decimals < 0 || decimals > 30) return null;

  const amount = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  if (fraction === 0n) return whole.toString();

  const fractional = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const trimmedFraction =
    fractional.length > 6 ? fractional.slice(0, 6) : fractional;
  const displayFraction = trimmedFraction.replace(/0+$/, "");
  return displayFraction
    ? `${whole.toString()}.${displayFraction}`
    : whole.toString();
}

export function formatChainLabel(
  chain?: string | number | null,
): string | null {
  if (chain == null) return null;
  const raw = String(chain).trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  if (
    normalized === "solana" ||
    normalized.startsWith("solana:") ||
    normalized === "7565164" ||
    normalized === "34268394551451"
  ) {
    return "Solana";
  }
  if (
    normalized === "base" ||
    normalized === "8453" ||
    normalized === "eip155:8453"
  ) {
    return "Base";
  }
  if (
    normalized === "polygon" ||
    normalized === "matic" ||
    normalized === "137" ||
    normalized === "eip155:137"
  ) {
    return "Polygon";
  }
  if (
    normalized === "ethereum" ||
    normalized === "eth" ||
    normalized === "1" ||
    normalized === "eip155:1"
  ) {
    return "Ethereum";
  }

  return raw;
}

export function formatChainNetwork(
  chain?: string | number | null,
): string | null {
  if (chain == null) return null;
  const normalized = String(chain).trim().toLowerCase();
  if (
    normalized === "solana" ||
    normalized.startsWith("solana:") ||
    normalized === "7565164" ||
    normalized === "34268394551451"
  ) {
    return "solana";
  }
  if (
    normalized === "base" ||
    normalized === "8453" ||
    normalized === "eip155:8453"
  ) {
    return "base";
  }
  if (
    normalized === "polygon" ||
    normalized === "matic" ||
    normalized === "137" ||
    normalized === "eip155:137"
  ) {
    return "polygon";
  }
  if (
    normalized === "ethereum" ||
    normalized === "eth" ||
    normalized === "1" ||
    normalized === "eip155:1"
  ) {
    return "ethereum";
  }
  return null;
}

function formatDepositChain(caip2?: string | null): string | null {
  return formatChainLabel(caip2);
}

function formatDepositNetwork(caip2?: string | null): string | null {
  return formatChainNetwork(caip2);
}

function normalizeDepositAssetAddress(
  asset: Record<string, unknown> | null | undefined,
): string {
  const address = typeof asset?.address === "string" ? asset.address : "";
  return address.toLowerCase();
}

function formatKnownDepositUsdAsset(
  asset: Record<string, unknown> | null | undefined,
): string | null {
  const mint = typeof asset?.mint === "string" ? asset.mint : "";
  const address = normalizeDepositAssetAddress(asset);
  if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return "USDC";
  if (address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") return "USDC";
  if (address === "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359") return "USDC";
  if (address === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174") return "USDC.e";
  if (address === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb") return "pUSD";
  return null;
}

function formatDepositAsset(
  asset: Record<string, unknown> | null | undefined,
  caip2?: string | null,
): string {
  const type = typeof asset?.type === "string" ? asset.type : "";
  const mint = typeof asset?.mint === "string" ? asset.mint : "";
  const address = typeof asset?.address === "string" ? asset.address : "";
  const normalizedCaip2 = caip2?.toLowerCase() ?? "";
  if (type === "native-token") {
    if (normalizedCaip2.startsWith("solana:")) return "SOL";
    if (normalizedCaip2 === "eip155:137") return "POL";
    return "native token";
  }
  const knownUsdAsset = formatKnownDepositUsdAsset({ mint, address });
  if (knownUsdAsset) return knownUsdAsset;
  if (type === "spl") return "SPL token";
  if (type === "erc20") return "token";
  return "funds";
}

function isDepositUsdStableAsset(
  asset: Record<string, unknown> | null | undefined,
): boolean {
  const mint = typeof asset?.mint === "string" ? asset.mint : "";
  const address = typeof asset?.address === "string" ? asset.address : "";
  return (
    mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ||
    address.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
    address.toLowerCase() === "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" ||
    address.toLowerCase() === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" ||
    address.toLowerCase() === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb"
  );
}

function inferDepositAssetDecimals(
  asset: Record<string, unknown> | null | undefined,
  caip2?: string | null,
): number | null {
  const type = typeof asset?.type === "string" ? asset.type : "";
  const normalizedCaip2 = caip2?.toLowerCase() ?? "";
  if (isDepositUsdStableAsset(asset)) return 6;
  if (type === "native-token") {
    if (normalizedCaip2.startsWith("solana:")) return 9;
    if (normalizedCaip2.startsWith("eip155:")) return 18;
  }
  return null;
}

function formatDepositAmountLabel(input: {
  amountRaw: string;
  asset: Record<string, unknown> | null | undefined;
  caip2?: string | null;
}): string | null {
  const decimals = inferDepositAssetDecimals(input.asset, input.caip2);
  if (decimals == null) return null;
  const amount = formatScaledAmount(input.amountRaw, decimals);
  if (!amount) return null;
  return `${amount} ${formatDepositAsset(input.asset, input.caip2)}`;
}

export function buildDepositNotification(input: {
  userId: string;
  source: string;
  walletAddress?: string | null;
  walletType?: string | null;
  caip2?: string | null;
  asset?: Record<string, unknown> | null;
  amountRaw: string;
  txHash?: string | null;
  idempotencyKey: string;
  dedupeKey?: string | null;
}): NotificationInput {
  const asset = formatDepositAsset(input.asset, input.caip2);
  const chain = formatDepositChain(input.caip2);
  const amountLabel = formatDepositAmountLabel({
    amountRaw: input.amountRaw,
    asset: input.asset,
    caip2: input.caip2,
  });
  const amountUsd = isDepositUsdStableAsset(input.asset)
    ? parseScaledAmount(input.amountRaw, 6)
    : null;
  const assetLabel = amountLabel ?? asset;
  const body = chain
    ? `${assetLabel} deposit received on ${chain}`
    : `${assetLabel} deposit received`;
  const dedupeKey =
    input.dedupeKey ?? `deposit:${input.source}:${input.idempotencyKey}`;

  return {
    userId: input.userId,
    type: "deposit_received",
    title: "Deposit received",
    body,
    severity: "success",
    data: {
      category: "funds",
      source: input.source,
      walletAddress: input.walletAddress ?? null,
      walletType: input.walletType ?? null,
      caip2: input.caip2 ?? null,
      network: formatDepositNetwork(input.caip2),
      asset: input.asset ?? null,
      amountRaw: input.amountRaw,
      amountLabel,
      amountUsd,
      txHash: input.txHash ?? null,
    },
    dedupeKey,
  };
}
