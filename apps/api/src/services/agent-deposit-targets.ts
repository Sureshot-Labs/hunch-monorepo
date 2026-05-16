import { AuthService, type UserWallet } from "../auth.js";
import { env } from "../env.js";
import { POLYGON_NATIVE_USDC_ADDRESS } from "./polymarket-onchain.js";

export type AgentWalletVenue = "polymarket" | "kalshi" | "limitless";

export type AgentDepositAsset = {
  id: string;
  symbol: string;
  name: string;
  address: string | null;
  mint: string | null;
  decimals: number;
  chainId: string;
  chainName: string;
  isNative: boolean;
  preferred: boolean;
  purpose: "collateral" | "convertible" | "native_fee";
  aliases: string[];
};

export type AgentDepositTarget = {
  venue: AgentWalletVenue;
  walletAddress: string;
  walletType: "ethereum" | "solana";
  targetAddress: string;
  targetKind: "trading_wallet" | "venue_funder";
  chainId: string;
  chainName: string;
  asset: Omit<AgentDepositAsset, "aliases" | "chainId" | "chainName">;
  depositUri: null;
  qrPayload: string;
  depositPageUrl: string;
  warnings: string[];
};

export type AgentDepositTargetBlocker =
  | "missing_wallet"
  | "wallet_type_mismatch"
  | "unsupported_asset";

export type AgentDepositTargetResult = {
  items: AgentDepositTarget[];
  blockers: AgentDepositTargetBlocker[];
  warnings: string[];
};

const EVM_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";

function normalizeAssetLookup(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");
}

function inferWalletType(wallet: UserWallet): "ethereum" | "solana" {
  return wallet.walletType === "solana" ? "solana" : "ethereum";
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function walletSupportsVenue(
  walletType: "ethereum" | "solana",
  venue: AgentWalletVenue,
): boolean {
  return venue === "kalshi"
    ? walletType === "solana"
    : walletType === "ethereum";
}

export function venuesForWallet(wallet: UserWallet): AgentWalletVenue[] {
  return inferWalletType(wallet) === "solana"
    ? ["kalshi"]
    : ["polymarket", "limitless"];
}

export function depositAssetsForVenue(
  venue: AgentWalletVenue,
): AgentDepositAsset[] {
  if (venue === "polymarket") {
    return [
      {
        id: "polymarket-pusd",
        symbol: "pUSD",
        name: "Polymarket collateral",
        address: env.polymarketUsdcAddress,
        mint: null,
        decimals: 6,
        chainId: "137",
        chainName: "Polygon",
        isNative: false,
        preferred: true,
        purpose: "collateral",
        aliases: ["pusd", "polymarket-usdc", "collateral"],
      },
      {
        id: "polygon-usdce",
        symbol: "USDC.e",
        name: "Bridged USDC",
        address: env.polymarketUsdceAddress,
        mint: null,
        decimals: 6,
        chainId: "137",
        chainName: "Polygon",
        isNative: false,
        preferred: false,
        purpose: "convertible",
        aliases: ["usdce", "usdc.e", "bridged-usdc"],
      },
      {
        id: "polygon-usdc",
        symbol: "USDC",
        name: "Native USDC",
        address: POLYGON_NATIVE_USDC_ADDRESS,
        mint: null,
        decimals: 6,
        chainId: "137",
        chainName: "Polygon",
        isNative: false,
        preferred: false,
        purpose: "convertible",
        aliases: ["usdc", "native-usdc", "polygon-usdc"],
      },
      {
        id: "polygon-pol",
        symbol: "POL",
        name: "Polygon native gas",
        address: EVM_NATIVE_ADDRESS,
        mint: null,
        decimals: 18,
        chainId: "137",
        chainName: "Polygon",
        isNative: true,
        preferred: false,
        purpose: "native_fee",
        aliases: ["pol", "matic", "gas"],
      },
    ];
  }

  if (venue === "limitless") {
    return [
      {
        id: "base-usdc",
        symbol: "USDC",
        name: "Base USDC",
        address: env.limitlessUsdcAddress,
        mint: null,
        decimals: 6,
        chainId: "8453",
        chainName: "Base",
        isNative: false,
        preferred: true,
        purpose: "collateral",
        aliases: ["usdc", "base-usdc"],
      },
      {
        id: "base-eth",
        symbol: "ETH",
        name: "Base native gas",
        address: EVM_NATIVE_ADDRESS,
        mint: null,
        decimals: 18,
        chainId: "8453",
        chainName: "Base",
        isNative: true,
        preferred: false,
        purpose: "native_fee",
        aliases: ["eth", "base-eth", "gas"],
      },
    ];
  }

  return [
    {
      id: "solana-usdc",
      symbol: "USDC",
      name: "Solana USDC",
      address: null,
      mint: env.solanaUsdcMint,
      decimals: 6,
      chainId: "7565164",
      chainName: "Solana",
      isNative: false,
      preferred: true,
      purpose: "collateral",
      aliases: ["usdc", "solana-usdc"],
    },
    {
      id: "solana-sol",
      symbol: "SOL",
      name: "Solana native fees",
      address: null,
      mint: SOLANA_NATIVE_ADDRESS,
      decimals: 9,
      chainId: "7565164",
      chainName: "Solana",
      isNative: true,
      preferred: false,
      purpose: "native_fee",
      aliases: ["sol", "gas"],
    },
  ];
}

export function filterDepositAssets(
  venue: AgentWalletVenue,
  assetQuery: string | undefined,
): AgentDepositAsset[] {
  const assets = depositAssetsForVenue(venue);
  const normalizedQuery = normalizeAssetLookup(assetQuery);
  if (!normalizedQuery) return assets;
  return assets.filter((asset) =>
    [
      asset.id,
      asset.symbol,
      asset.name,
      asset.address,
      asset.mint,
      ...asset.aliases,
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalizeAssetLookup(value) === normalizedQuery),
  );
}

export function buildDepositPageUrl(input: {
  venue: AgentWalletVenue;
  targetAddress: string;
  asset?: AgentDepositAsset;
}): string {
  const url = new URL("/", env.agentAppBaseUrl);
  url.searchParams.set("deposit", "manual");
  url.searchParams.set("depositVenue", input.venue);
  url.searchParams.set("depositTarget", input.targetAddress);
  if (input.asset) {
    url.searchParams.set("depositAsset", input.asset.id);
    url.searchParams.set("depositChainId", input.asset.chainId);
    url.searchParams.set(
      "depositToken",
      input.asset.address ?? input.asset.mint ?? "",
    );
  }
  return url.toString();
}

export async function buildAgentDepositTargets(input: {
  userId: string;
  wallets: UserWallet[];
  venue?: AgentWalletVenue;
  asset?: string;
}): Promise<AgentDepositTargetResult> {
  if (input.wallets.length === 0) {
    return {
      items: [],
      blockers: ["missing_wallet"],
      warnings: ["No approved wallet is available for deposit targets."],
    };
  }

  const blockers: AgentDepositTargetBlocker[] = [];
  const warnings: string[] = [];
  const polymarketTargetCache = new Map<
    string,
    Promise<
      Pick<AgentDepositTarget, "targetAddress" | "targetKind">
    >
  >();
  let sawCompatibleVenue = false;
  let sawMatchingAsset = !input.asset;
  let sawIncompatibleVenue = false;

  const resolveTarget = async (
    wallet: UserWallet,
    venue: AgentWalletVenue,
  ): Promise<Pick<AgentDepositTarget, "targetAddress" | "targetKind">> => {
    if (venue !== "polymarket") {
      return {
        targetAddress: wallet.walletAddress,
        targetKind: "trading_wallet",
      };
    }

    const cacheKey = `${input.userId}:polymarket:${wallet.walletAddress.toLowerCase()}`;
    let cached = polymarketTargetCache.get(cacheKey);
    if (!cached) {
      cached = AuthService.getVenueCredentialsInfo(
        input.userId,
        "polymarket",
        wallet.walletAddress,
      ).then((creds) => ({
        targetAddress: creds?.funderAddress ?? wallet.walletAddress,
        targetKind: creds?.funderAddress
          ? ("venue_funder" as const)
          : ("trading_wallet" as const),
      }));
      polymarketTargetCache.set(cacheKey, cached);
    }
    return cached;
  };

  const items = await Promise.all(
    input.wallets.flatMap((wallet) => {
      const walletType = inferWalletType(wallet);
      const venues = input.venue ? [input.venue] : venuesForWallet(wallet);
      return venues.flatMap((venue) => {
        if (!walletSupportsVenue(walletType, venue)) {
          sawIncompatibleVenue = true;
          return [];
        }
        sawCompatibleVenue = true;
        const assets = filterDepositAssets(venue, input.asset);
        if (assets.length > 0) sawMatchingAsset = true;
        return assets.map(async (asset) => {
          const { targetAddress, targetKind } = await resolveTarget(
            wallet,
            venue,
          );
          return {
            venue,
            walletAddress: wallet.walletAddress,
            walletType,
            targetAddress,
            targetKind,
            chainId: asset.chainId,
            chainName: asset.chainName,
            asset: {
              id: asset.id,
              symbol: asset.symbol,
              name: asset.name,
              address: asset.address,
              mint: asset.mint,
              decimals: asset.decimals,
              isNative: asset.isNative,
              preferred: asset.preferred,
              purpose: asset.purpose,
            },
            depositUri: null,
            qrPayload: targetAddress,
            depositPageUrl: buildDepositPageUrl({
              venue,
              targetAddress,
              asset,
            }),
            warnings:
              asset.purpose === "convertible"
                ? [
                    "This asset may need conversion before it can be used as venue collateral.",
                  ]
                : [],
          };
        });
      });
    }),
  );

  if (!sawCompatibleVenue && sawIncompatibleVenue) {
    blockers.push("wallet_type_mismatch");
    warnings.push(
      input.venue
        ? `No approved wallet can fund venue '${input.venue}'.`
        : "No approved wallet can fund the requested venue.",
    );
  } else if (input.asset && sawCompatibleVenue && !sawMatchingAsset) {
    blockers.push("unsupported_asset");
    warnings.push(`No deposit target supports asset '${input.asset}'.`);
  }

  return {
    items: items.flat(),
    blockers: Array.from(new Set(blockers)),
    warnings: uniqueStrings(warnings),
  };
}
