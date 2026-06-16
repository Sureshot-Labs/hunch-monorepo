import { AuthService } from "../auth.js";
import type { DbQuery } from "../db.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  getTradeCartDetail,
  type TradeCart,
  type TradeCartItem,
  type TradeCartVenue,
} from "../repos/trade-carts-repo.js";
import { fetchLimitlessOnchainSnapshot } from "./limitless-onchain.js";
import { addLockedCollateralFields, parseOptionalBigInt } from "./locked-balance.js";
import { fetchOpenOrderCollateralLocks } from "./open-order-collateral.js";
import { fetchPolymarketOnchainSnapshot } from "./polymarket-onchain.js";
import {
  BASE_CHAIN_ID,
  buildKalshiVenueStatus,
  POLYGON_CHAIN_ID,
  SOLANA_CHAIN_ID,
  type VenueTokenBalanceStatus,
  type VenueWalletStatus,
} from "./venue-wallet-status.js";

export type TradeCartPreflightWalletStatus = VenueWalletStatus;

export type TradeCartPreflightWalletSnapshot = {
  wallets: TradeCartPreflightWalletStatus[];
};

export type TradeCartPreflightBucket = {
  id: string;
  venue: TradeCartVenue;
  chainId: string;
  tokenAddress: string;
  walletAddress: string;
  signerAddress: string | null;
  funderAddress: string | null;
  requiredRaw: string;
  balanceRaw: string;
  lockedRaw: string;
  availableAfterLockedRaw: string;
  cartItemIds: string[];
};

export type TradeCartPreflightItem = {
  cartItemId: string;
  status: "ready" | "needs_funding" | "preflight_failed" | "skipped";
  reasons: string[];
  requiredRaw: string | null;
  bucketId: string | null;
};

export type TradeCartPreflightDeficit = {
  bucketId: string;
  missingRaw: string;
  requiredRaw: string;
  availableAfterLockedRaw: string;
  cartItemIds: string[];
};

export type TradeCartPreflightResult = {
  ok: true;
  status: "ready" | "needs_funding";
  buckets: TradeCartPreflightBucket[];
  items: TradeCartPreflightItem[];
  deficits: TradeCartPreflightDeficit[];
  walletSnapshot: TradeCartPreflightWalletSnapshot;
};

export class TradeCartPreflightError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "TradeCartPreflightError";
  }
}

function normalizeWalletAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function parsePositiveRaw(value: string | null | undefined): bigint | null {
  const parsed = parseOptionalBigInt(value);
  return parsed != null && parsed > 0n ? parsed : null;
}

function isExecutableItem(item: TradeCartItem): boolean {
  return item.status !== "removed" && item.status !== "skipped";
}

function hasMarketIdentifier(item: TradeCartItem): boolean {
  return Boolean(item.tokenId || item.marketId || item.marketSlug);
}

function getTokenAvailableRaw(
  status: VenueTokenBalanceStatus | null | undefined,
): {
  balanceRaw: bigint;
  lockedRaw: bigint;
  availableAfterLockedRaw: bigint | null;
} {
  return {
    balanceRaw: parseOptionalBigInt(status?.balanceRaw) ?? 0n,
    lockedRaw: parseOptionalBigInt(status?.lockedRaw) ?? 0n,
    availableAfterLockedRaw: parseOptionalBigInt(
      status?.availableAfterLockedRaw,
    ),
  };
}

function buildBucketId(input: {
  venue: TradeCartVenue;
  chainId: string;
  tokenAddress: string;
  walletAddress: string;
  signerAddress: string | null;
  funderAddress: string | null;
}): string {
  return [
    input.venue,
    input.chainId,
    normalizeWalletAddress(input.tokenAddress) ?? input.tokenAddress,
    normalizeWalletAddress(input.walletAddress) ?? input.walletAddress,
    normalizeWalletAddress(input.signerAddress) ?? "none",
    normalizeWalletAddress(input.funderAddress) ?? "none",
  ].join("|");
}

export function buildTradeCartPreflightResult(input: {
  items: TradeCartItem[];
  walletSnapshot: TradeCartPreflightWalletSnapshot;
  itemIds?: string[];
}): TradeCartPreflightResult {
  const requestedIds = input.itemIds ? new Set(input.itemIds) : null;
  const walletByAddress = new Map<string, TradeCartPreflightWalletStatus>();
  for (const wallet of input.walletSnapshot.wallets) {
    const key = normalizeWalletAddress(wallet.walletAddress);
    if (key) walletByAddress.set(key, wallet);
  }

  const itemResults: TradeCartPreflightItem[] = [];
  const bucketById = new Map<
    string,
    Omit<TradeCartPreflightBucket, "requiredRaw"> & { requiredRaw: bigint }
  >();
  const itemBucketIds = new Map<string, string>();

  for (const item of input.items) {
    if (requestedIds && !requestedIds.has(item.id)) continue;
    if (!isExecutableItem(item)) {
      itemResults.push({
        cartItemId: item.id,
        status: "skipped",
        reasons: [],
        requiredRaw: item.amountRaw,
        bucketId: null,
      });
      continue;
    }

    const reasons: string[] = [];
    const amountRaw = parsePositiveRaw(item.amountRaw);
    const selectedWallet = normalizeWalletAddress(item.walletAddress);
    const signerAddress = normalizeWalletAddress(item.signerAddress);
    const funderAddress = normalizeWalletAddress(item.funderAddress);

    if (!hasMarketIdentifier(item)) reasons.push("missing_market_identifier");
    if (!amountRaw) reasons.push("missing_amount");
    if (!selectedWallet) reasons.push("missing_wallet");
    if (!signerAddress) reasons.push("missing_signer");

    const walletStatus = selectedWallet
      ? walletByAddress.get(selectedWallet)
      : null;
    if (selectedWallet && !walletStatus) reasons.push("stale_wallet_context");

    let bucketInput:
      | {
          venue: TradeCartVenue;
          chainId: string;
          tokenAddress: string;
          walletAddress: string;
          signerAddress: string | null;
          funderAddress: string | null;
          tokenStatus: VenueTokenBalanceStatus | null | undefined;
        }
      | null = null;

    if (item.venue === "polymarket") {
      if (!funderAddress) reasons.push("missing_funder");
      if (walletStatus?.polymarket?.hasCredentials === false) {
        reasons.push("missing_credentials");
      }
      const expectedFunder = normalizeWalletAddress(walletStatus?.polymarket?.funder);
      if (funderAddress && expectedFunder && funderAddress !== expectedFunder) {
        reasons.push("stale_funder_context");
      }
      if (signerAddress && selectedWallet && signerAddress !== selectedWallet) {
        reasons.push("stale_signer_context");
      }
      if (funderAddress) {
        bucketInput = {
          venue: "polymarket",
          chainId: POLYGON_CHAIN_ID,
          tokenAddress:
            walletStatus?.polymarket?.pusd?.tokenAddress ??
            walletStatus?.polymarket?.usdc?.tokenAddress ??
            env.polymarketUsdcAddress,
          walletAddress: funderAddress,
          signerAddress,
          funderAddress,
          tokenStatus:
            walletStatus?.polymarket?.pusd ?? walletStatus?.polymarket?.usdc,
        };
      }
    } else if (item.venue === "limitless") {
      if (walletStatus?.limitless?.hasCredentials === false) {
        reasons.push("missing_credentials");
      }
      if (signerAddress && selectedWallet && signerAddress !== selectedWallet) {
        reasons.push("stale_signer_context");
      }
      if (selectedWallet) {
        bucketInput = {
          venue: "limitless",
          chainId: BASE_CHAIN_ID,
          tokenAddress:
            walletStatus?.limitless?.usdc?.tokenAddress ??
            env.limitlessUsdcAddress,
          walletAddress: selectedWallet,
          signerAddress,
          funderAddress: null,
          tokenStatus: walletStatus?.limitless?.usdc,
        };
      }
    } else if (item.venue === "kalshi") {
      if (walletStatus && walletStatus.walletType !== "solana") {
        reasons.push("wallet_type_mismatch");
      }
      if (walletStatus?.kalshi?.hasCredentials === false) {
        reasons.push("missing_credentials");
      }
      if (
        item.side === "BUY" &&
        walletStatus?.kalshi?.proofRequiredForBuy === true
      ) {
        reasons.push(
          walletStatus.kalshi.proofReason === "unavailable"
            ? "proof_unavailable"
            : "proof_required",
        );
      }
      if (walletStatus?.kalshi?.reasons?.includes("low_sol_balance")) {
        reasons.push("low_sol_balance");
      }
      if (signerAddress && selectedWallet && signerAddress !== selectedWallet) {
        reasons.push("stale_signer_context");
      }
      if (selectedWallet) {
        bucketInput = {
          venue: "kalshi",
          chainId: SOLANA_CHAIN_ID,
          tokenAddress:
            walletStatus?.kalshi?.usdc?.tokenAddress ?? env.solanaUsdcMint,
          walletAddress: selectedWallet,
          signerAddress,
          funderAddress: null,
          tokenStatus: walletStatus?.kalshi?.usdc,
        };
      }
    }

    if (reasons.length > 0 || !amountRaw || !bucketInput || item.side !== "BUY") {
      itemResults.push({
        cartItemId: item.id,
        status: reasons.length > 0 ? "preflight_failed" : "ready",
        reasons,
        requiredRaw: amountRaw?.toString() ?? null,
        bucketId: null,
      });
      continue;
    }

    const tokenAmounts = getTokenAvailableRaw(bucketInput.tokenStatus);
    if (tokenAmounts.availableAfterLockedRaw == null) {
      itemResults.push({
        cartItemId: item.id,
        status: "preflight_failed",
        reasons: ["missing_available_after_locked"],
        requiredRaw: amountRaw.toString(),
        bucketId: null,
      });
      continue;
    }

    const bucketId = buildBucketId(bucketInput);
    const existing = bucketById.get(bucketId);
    if (existing) {
      existing.requiredRaw += amountRaw;
      existing.cartItemIds.push(item.id);
    } else {
      bucketById.set(bucketId, {
        id: bucketId,
        venue: bucketInput.venue,
        chainId: bucketInput.chainId,
        tokenAddress: bucketInput.tokenAddress,
        walletAddress: bucketInput.walletAddress,
        signerAddress: bucketInput.signerAddress,
        funderAddress: bucketInput.funderAddress,
        requiredRaw: amountRaw,
        balanceRaw: tokenAmounts.balanceRaw.toString(),
        lockedRaw: tokenAmounts.lockedRaw.toString(),
        availableAfterLockedRaw: tokenAmounts.availableAfterLockedRaw.toString(),
        cartItemIds: [item.id],
      });
    }
    itemBucketIds.set(item.id, bucketId);
    itemResults.push({
      cartItemId: item.id,
      status: "ready",
      reasons: [],
      requiredRaw: amountRaw.toString(),
      bucketId,
    });
  }

  const buckets: TradeCartPreflightBucket[] = Array.from(bucketById.values()).map(
    (bucket) => ({
      ...bucket,
      requiredRaw: bucket.requiredRaw.toString(),
    }),
  );
  const deficits: TradeCartPreflightDeficit[] = [];
  const underfundedBucketIds = new Set<string>();

  for (const bucket of buckets) {
    const requiredRaw = BigInt(bucket.requiredRaw);
    const availableAfterLockedRaw = BigInt(bucket.availableAfterLockedRaw);
    if (availableAfterLockedRaw >= requiredRaw) continue;

    underfundedBucketIds.add(bucket.id);
    deficits.push({
      bucketId: bucket.id,
      missingRaw: (requiredRaw - availableAfterLockedRaw).toString(),
      requiredRaw: bucket.requiredRaw,
      availableAfterLockedRaw: bucket.availableAfterLockedRaw,
      cartItemIds: bucket.cartItemIds,
    });
  }

  const finalItems = itemResults.map((item) => {
    const bucketId = itemBucketIds.get(item.cartItemId) ?? null;
    if (!bucketId || !underfundedBucketIds.has(bucketId)) return item;
    return {
      ...item,
      bucketId,
      status: "needs_funding" as const,
      reasons: ["insufficient_balance"],
    };
  });

  return {
    ok: true,
    status:
      deficits.length === 0 &&
      finalItems.every((item) => item.status === "ready" || item.status === "skipped")
        ? "ready"
        : "needs_funding",
    buckets,
    items: finalItems,
    deficits,
    walletSnapshot: input.walletSnapshot,
  };
}

async function buildDefaultWalletSnapshot(input: {
  userId: string;
  items: TradeCartItem[];
  refresh?: boolean;
}): Promise<TradeCartPreflightWalletSnapshot> {
  const linkedWallets = await AuthService.getUserWallets(input.userId);
  const neededWalletKeys = new Set<string>();
  const neededVenuesByWallet = new Map<string, Set<TradeCartVenue>>();
  for (const item of input.items) {
    if (!isExecutableItem(item)) continue;
    const walletKey = normalizeWalletAddress(item.walletAddress);
    if (!walletKey) continue;
    neededWalletKeys.add(walletKey);
    const venues = neededVenuesByWallet.get(walletKey) ?? new Set();
    venues.add(item.venue);
    neededVenuesByWallet.set(walletKey, venues);
  }

  const wallets = linkedWallets.filter((wallet) => {
    const key = normalizeWalletAddress(wallet.walletAddress);
    return key ? neededWalletKeys.has(key) : false;
  });

  const evmWallets = wallets.filter((wallet) => wallet.walletType !== "solana");
  const solanaWallets = wallets.filter(
    (wallet) => wallet.walletType === "solana",
  );
  const needsKalshiStatus = solanaWallets.some((wallet) => {
    const key = normalizeWalletAddress(wallet.walletAddress);
    return key ? (neededVenuesByWallet.get(key)?.has("kalshi") ?? false) : false;
  });
  const user = needsKalshiStatus
    ? await AuthService.getUserById(input.userId)
    : null;

  const credentials = new Map<
    string,
    {
      polymarket: Awaited<
        ReturnType<typeof AuthService.getVenueCredentialsInfo>
      > | null;
      limitless: Awaited<
        ReturnType<typeof AuthService.getVenueCredentialsInfo>
      > | null;
    }
  >();
  await Promise.all(
    evmWallets.map(async (wallet) => {
      const key = normalizeWalletAddress(wallet.walletAddress);
      if (!key) return;
      const neededVenues = neededVenuesByWallet.get(key);
      const needsPolymarket = neededVenues?.has("polymarket") ?? false;
      const needsLimitless = neededVenues?.has("limitless") ?? false;
      const [polymarket, limitless] = await Promise.all([
        needsPolymarket
          ? AuthService.getVenueCredentialsInfo(
              input.userId,
              "polymarket",
              wallet.walletAddress,
            )
          : Promise.resolve(null),
        needsLimitless
          ? AuthService.getVenueCredentialsInfo(
              input.userId,
              "limitless",
              wallet.walletAddress,
            )
          : Promise.resolve(null),
      ]);
      credentials.set(key, { polymarket, limitless });
    }),
  );

  const polymarketFunders = evmWallets.flatMap((wallet) => {
    const key = normalizeWalletAddress(wallet.walletAddress);
    if (!key || !neededVenuesByWallet.get(key)?.has("polymarket")) return [];
    const creds = key ? credentials.get(key)?.polymarket : null;
    return [creds?.funderAddress ?? wallet.walletAddress];
  });
  const limitlessWallets = evmWallets.flatMap((wallet) => {
    const key = normalizeWalletAddress(wallet.walletAddress);
    if (!key || !neededVenuesByWallet.get(key)?.has("limitless")) return [];
    return [wallet.walletAddress];
  });
  let collateralLocks: Awaited<ReturnType<typeof fetchOpenOrderCollateralLocks>>;
  try {
    collateralLocks = await fetchOpenOrderCollateralLocks(pool, {
      userId: input.userId,
      polymarketWallets: polymarketFunders,
      limitlessWallets,
    });
  } catch {
    collateralLocks = {
      polymarket: new Map(),
      limitless: new Map(),
    };
  }

  const evmStatuses = await Promise.all(
    evmWallets.map(async (wallet): Promise<TradeCartPreflightWalletStatus> => {
      const key = normalizeWalletAddress(wallet.walletAddress);
      const neededVenues = key ? neededVenuesByWallet.get(key) : null;
      const needsPolymarket = neededVenues?.has("polymarket") ?? false;
      const needsLimitless = neededVenues?.has("limitless") ?? false;
      const creds = key ? credentials.get(key) : null;

      const status: TradeCartPreflightWalletStatus = {
        walletAddress: wallet.walletAddress,
        walletType: wallet.walletType,
        kalshi: {
          hasCredentials: false,
        },
      };

      if (needsPolymarket) {
        const funder = creds?.polymarket?.funderAddress ?? wallet.walletAddress;
        const funderKey = normalizeWalletAddress(funder) ?? funder;
        const polymarketSnapshot = await fetchPolymarketOnchainSnapshot({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          signer: wallet.walletAddress,
          funder,
          includeSignerUsdc: false,
          negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress,
          feeCollectorAddress: null,
        });
        const pusd = addLockedCollateralFields(
          {
            tokenAddress: env.polymarketUsdcAddress,
            decimals: 6,
            balanceRaw: polymarketSnapshot.pusdBalance.toString(),
          },
          collateralLocks.polymarket.get(funderKey) ?? 0n,
        );
        status.polymarket = {
          hasCredentials: Boolean(creds?.polymarket),
          funder,
          pusd,
          usdc: pusd,
        };
      }

      if (needsLimitless) {
        const limitlessSnapshot = await fetchLimitlessOnchainSnapshot({
          rpcUrl: env.baseRpcUrl,
          timeoutMs: env.baseRpcTimeoutMs,
          owner: wallet.walletAddress,
        });
        const limitlessUsdc = addLockedCollateralFields(
          {
            tokenAddress: env.limitlessUsdcAddress,
            decimals: 6,
            balanceRaw: limitlessSnapshot.usdcBalance.toString(),
          },
          collateralLocks.limitless.get(key ?? wallet.walletAddress) ?? 0n,
        );
        status.limitless = {
          hasCredentials: Boolean(creds?.limitless),
          usdc: limitlessUsdc,
        };
      }

      return status;
    }),
  );

  const solanaStatuses = await Promise.all(
    solanaWallets.map(async (wallet): Promise<TradeCartPreflightWalletStatus> => {
      const key = normalizeWalletAddress(wallet.walletAddress);
      const neededVenues = key ? neededVenuesByWallet.get(key) : null;
      const status: TradeCartPreflightWalletStatus = {
        walletAddress: wallet.walletAddress,
        walletType: wallet.walletType,
        polymarket: {
          hasCredentials: false,
        },
        limitless: {
          hasCredentials: false,
        },
      };
      if (neededVenues?.has("kalshi")) {
        status.kalshi = await buildKalshiVenueStatus({
          userId: input.userId,
          user,
          walletAddress: wallet.walletAddress,
          refresh: input.refresh,
        });
      }
      return status;
    }),
  );

  return { wallets: [...evmStatuses, ...solanaStatuses] };
}

export async function preflightTradeCart(
  db: DbQuery,
  input: {
    userId: string;
    cartId: string;
    itemIds?: string[];
    refresh?: boolean;
  },
  walletSnapshotProvider: (args: {
    userId: string;
    items: TradeCartItem[];
    refresh?: boolean;
  }) => Promise<TradeCartPreflightWalletSnapshot> = buildDefaultWalletSnapshot,
): Promise<{
  cart: TradeCart;
  preflight: TradeCartPreflightResult;
} | null> {
  const detail = await getTradeCartDetail(db, {
    userId: input.userId,
    cartId: input.cartId,
  });
  if (!detail) return null;

  const items = detail.items.filter((item) => {
    if (!input.itemIds?.length) return true;
    return input.itemIds.includes(item.id);
  });
  const walletSnapshot = await walletSnapshotProvider({
    userId: input.userId,
    items,
    refresh: input.refresh,
  });

  return {
    cart: detail.cart,
    preflight: buildTradeCartPreflightResult({
      items,
      walletSnapshot,
      itemIds: input.itemIds,
    }),
  };
}
