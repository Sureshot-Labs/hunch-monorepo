import { Interface, ethers } from "ethers";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";
import { filterVenuesForLifecycleCapability } from "./venue-lifecycle.js";
import { decodePolymarketDepositWalletOwnerFromRuntime } from "./wallet-onchain-state.js";

const fundingRouter = new Interface([
  "function depositWalletOf(address owner) view returns (address)",
]);

export type TelegramDepositVenue = "limitless" | "polymarket";

export type TelegramDepositMessage = TelegramBotTradingClientMessage & {
  depositAddress?: string;
  qrText?: string;
  venue?: TelegramDepositVenue;
};

export type TelegramDepositInternalWallet = {
  walletAddress: string;
  walletChain: "ethereum" | "solana";
};

export type TelegramDepositResolverDependencies = {
  allowedVenues?: readonly TelegramDepositVenue[];
  fetchCall?: typeof fetchEvmCall;
  fetchCode?: typeof fetchEvmCode;
  fundingRouterAddress?: string | null;
  polygonRpcTimeoutMs?: number;
  polygonRpcUrl?: string;
};

export type TelegramDepositResolution =
  | { address: string; status: "ready" }
  | {
      address: null;
      status:
        | "setup_required"
        | "temporarily_unavailable"
        | "verification_failed";
    };

export type TelegramPolymarketDepositResolution = TelegramDepositResolution;

function normalizedAddress(value: string): string {
  return ethers.getAddress(value).toLowerCase();
}

export async function resolveCanonicalPolymarketDeposit(input: {
  db: DbQuery;
  dependencies?: TelegramDepositResolverDependencies;
  telegramUserId: string | number;
}): Promise<TelegramPolymarketDepositResolution> {
  const fundingRouterAddress =
    input.dependencies?.fundingRouterAddress !== undefined
      ? input.dependencies.fundingRouterAddress
      : env.polymarketFundingRouterAddress;
  if (!fundingRouterAddress) {
    return { address: null, status: "temporarily_unavailable" };
  }
  const call = input.dependencies?.fetchCall ?? fetchEvmCall;
  const code = input.dependencies?.fetchCode ?? fetchEvmCode;
  const rpcUrl = input.dependencies?.polygonRpcUrl ?? env.polygonRpcUrl;
  const timeoutMs =
    input.dependencies?.polygonRpcTimeoutMs ?? env.polygonRpcTimeoutMs;
  const { rows } = await input.db.query<{
    funder_address: string | null;
    wallet_address: string;
  }>(
    `select uvc.wallet_address, uvc.funder_address
       from user_telegram_accounts uta
       join user_venue_credentials uvc
         on uvc.user_id = uta.user_id
        and uvc.venue = 'polymarket'
        and uvc.is_active = true
      where uta.telegram_user_id = $1
        and uvc.funder_address is not null
      order by uvc.updated_at desc`,
    [String(input.telegramUserId)],
  );
  if (rows.length === 0) {
    return { address: null, status: "setup_required" };
  }
  let rpcUnavailable = false;
  for (const row of rows) {
    let owner: string;
    let stored: string;
    try {
      owner = ethers.getAddress(row.wallet_address);
      stored = ethers.getAddress(row.funder_address ?? "");
    } catch {
      continue;
    }
    const data = fundingRouter.encodeFunctionData("depositWalletOf", [owner]);
    let result: string;
    try {
      result = await call({
        data,
        rpcUrl,
        timeoutMs,
        to: fundingRouterAddress,
      });
    } catch {
      rpcUnavailable = true;
      continue;
    }
    let derivedAddress: string;
    try {
      const [derived] = fundingRouter.decodeFunctionResult(
        "depositWalletOf",
        result,
      );
      derivedAddress = normalizedAddress(String(derived));
    } catch {
      continue;
    }
    if (derivedAddress !== normalizedAddress(stored)) continue;
    let runtime: string;
    try {
      runtime = await code({
        address: stored,
        bypassCache: true,
        rpcUrl,
        timeoutMs,
      });
    } catch {
      rpcUnavailable = true;
      continue;
    }
    const runtimeOwner = decodePolymarketDepositWalletOwnerFromRuntime(runtime);
    let normalizedRuntimeOwner: string | null = null;
    try {
      normalizedRuntimeOwner = runtimeOwner
        ? normalizedAddress(runtimeOwner)
        : null;
    } catch {
      // Malformed owner data is a verification failure, not an RPC outage.
    }
    if (normalizedRuntimeOwner !== normalizedAddress(owner)) continue;
    return { address: stored, status: "ready" };
  }
  return {
    address: null,
    status: rpcUnavailable ? "temporarily_unavailable" : "verification_failed",
  };
}

export async function resolveCanonicalPolymarketDepositAddress(input: {
  db: DbQuery;
  dependencies?: TelegramDepositResolverDependencies;
  telegramUserId: string | number;
}): Promise<string | null> {
  const resolution = await resolveCanonicalPolymarketDeposit(input);
  return resolution.address;
}

function normalizeInternalEvmWallets(
  wallets: readonly TelegramDepositInternalWallet[],
): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const wallet of wallets) {
    if (wallet.walletChain !== "ethereum") continue;
    try {
      const address = ethers.getAddress(wallet.walletAddress);
      normalized.set(address.toLowerCase(), address);
    } catch {
      // Malformed or non-EVM candidates cannot receive a Base deposit.
    }
  }
  return normalized;
}

export async function resolveCanonicalLimitlessDeposit(input: {
  db: DbQuery;
  internalWallets: readonly TelegramDepositInternalWallet[] | null;
  telegramUserId: string | number;
}): Promise<TelegramDepositResolution> {
  if (input.internalWallets == null) {
    return { address: null, status: "temporarily_unavailable" };
  }
  const internalWallets = normalizeInternalEvmWallets(input.internalWallets);
  if (internalWallets.size === 0) {
    return { address: null, status: "setup_required" };
  }
  let preferredAddress: string | null = null;
  try {
    const { rows } = await input.db.query<{ wallet_address: string }>(
      `select wallet_address
         from telegram_bot_trading_authorizations
        where telegram_user_id = $1
          and wallet_chain = 'ethereum'
        limit 1`,
      [String(input.telegramUserId)],
    );
    preferredAddress = rows[0]?.wallet_address ?? null;
  } catch {
    return { address: null, status: "temporarily_unavailable" };
  }
  if (preferredAddress) {
    try {
      const matched = internalWallets.get(
        ethers.getAddress(preferredAddress).toLowerCase(),
      );
      if (matched) return { address: matched, status: "ready" };
    } catch {
      // Fall through to the unambiguous internal-wallet rule.
    }
  }
  if (internalWallets.size === 1) {
    const [address] = internalWallets.values();
    if (address) return { address, status: "ready" };
  }
  return {
    address: null,
    status: preferredAddress ? "verification_failed" : "setup_required",
  };
}

function buildDepositAppUrl(input: {
  address?: string | null;
  appBaseUrl: string;
  venue?: TelegramDepositVenue;
}): string {
  const url = new URL("/", input.appBaseUrl);
  url.searchParams.set("deposit", "manual");
  url.searchParams.set("source", "telegram");
  if (input.venue) url.searchParams.set("venue", input.venue);
  if (input.address) url.searchParams.set("address", input.address);
  return url.toString();
}

async function resolveDepositVenues(input: {
  db: DbQuery;
  dependencies?: TelegramDepositResolverDependencies;
}): Promise<TelegramDepositVenue[]> {
  if (input.dependencies?.allowedVenues) {
    return Array.from(new Set(input.dependencies.allowedVenues));
  }
  const resolved = await filterVenuesForLifecycleCapability(
    input.db,
    ["polymarket", "limitless"],
    "increaseExposure",
  );
  return resolved.venues.filter(
    (venue): venue is TelegramDepositVenue =>
      venue === "polymarket" || venue === "limitless",
  );
}

function buildDepositVenueMenu(
  venues: readonly TelegramDepositVenue[],
): TelegramDepositMessage {
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: venues.map((venue) => [
        {
          callback_data: `hm:v1:deposit:${venue}`,
          text: venue === "polymarket" ? "Polymarket" : "Limitless",
        },
      ]),
    },
    text: [
      "*💳 Deposit*",
      "",
      escapeTelegramMarkdownV2("Choose a trading venue."),
      "",
      ...(venues.includes("polymarket")
        ? [escapeTelegramMarkdownV2("Polymarket · Polygon · pUSD / USDC.e")]
        : []),
      ...(venues.includes("limitless")
        ? [escapeTelegramMarkdownV2("Limitless · Base · USDC")]
        : []),
      ...(venues.length === 0
        ? [
            escapeTelegramMarkdownV2(
              "No trading venue can be funded right now.",
            ),
          ]
        : []),
    ].join("\n"),
  };
}

function buildDepositUnavailableMessage(input: {
  appBaseUrl: string;
  resolution: Exclude<TelegramDepositResolution, { status: "ready" }>;
  venue: TelegramDepositVenue;
}): TelegramDepositMessage {
  const temporarilyUnavailable =
    input.resolution.status === "temporarily_unavailable";
  const isPolymarket = input.venue === "polymarket";
  const text = isPolymarket
    ? temporarilyUnavailable
      ? "Deposit verification is temporarily unavailable. Try again or open Hunch."
      : input.resolution.status === "verification_failed"
        ? "The Polymarket deposit wallet could not be verified. Open Hunch to check Trading Wallet setup."
        : "A verified Polymarket deposit wallet is not ready yet. Finish Trading Wallet setup in Hunch."
    : temporarilyUnavailable
      ? "Limitless Trading Wallet lookup is temporarily unavailable. Try again or open Hunch."
      : input.resolution.status === "verification_failed"
        ? "The saved Telegram signer does not match an internal Hunch Trading Wallet. Open Hunch to choose the wallet."
        : "An unambiguous internal EVM Trading Wallet is not available. Open Hunch to choose the wallet.";
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              isPolymarket && !temporarilyUnavailable
                ? "Finish setup"
                : "Open Hunch",
            url: isPolymarket
              ? new URL(
                  "/settings/telegram-trading",
                  input.appBaseUrl,
                ).toString()
              : buildDepositAppUrl({
                  appBaseUrl: input.appBaseUrl,
                  venue: input.venue,
                }),
          },
        ],
        [{ callback_data: "hm:v1:deposit", text: "Back to venues" }],
      ],
    },
    text: ["*💳 Deposit*", "", escapeTelegramMarkdownV2(text)].join("\n"),
  };
}

export async function buildTelegramDepositMessage(input: {
  appBaseUrl: string;
  dependencies?: TelegramDepositResolverDependencies;
  internalWallets?: readonly TelegramDepositInternalWallet[] | null;
  pool: DbQuery;
  telegramUserId: string | number;
  venue?: string | null;
}): Promise<TelegramDepositMessage> {
  const requestedVenue = input.venue?.trim().toLowerCase() || null;
  if (!requestedVenue) {
    return buildDepositVenueMenu(
      await resolveDepositVenues({
        db: input.pool,
        dependencies: input.dependencies,
      }),
    );
  }
  const venue =
    requestedVenue === "polymarket" || requestedVenue === "limitless"
      ? requestedVenue
      : null;
  if (!venue) {
    return {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ callback_data: "hm:v1:deposit", text: "Back to venues" }],
        ],
      },
      text: [
        "*💳 Deposit*",
        "",
        escapeTelegramMarkdownV2(
          "Deposits for this venue are not available right now.",
        ),
      ].join("\n"),
    };
  }
  const resolution =
    venue === "polymarket"
      ? await resolveCanonicalPolymarketDeposit({
          db: input.pool,
          dependencies: input.dependencies,
          telegramUserId: input.telegramUserId,
        })
      : await resolveCanonicalLimitlessDeposit({
          db: input.pool,
          internalWallets: input.internalWallets ?? null,
          telegramUserId: input.telegramUserId,
        });
  if (resolution.status !== "ready") {
    return buildDepositUnavailableMessage({
      appBaseUrl: input.appBaseUrl,
      resolution,
      venue,
    });
  }
  const address = resolution.address;
  const isPolymarket = venue === "polymarket";
  return {
    depositAddress: address,
    parse_mode: "MarkdownV2",
    qrText: address,
    reply_markup: {
      inline_keyboard: [
        [{ copy_text: { text: address }, text: "Copy address" }],
        [
          {
            callback_data: `hm:v1:deposit_qr:${venue}`,
            text: "Show QR",
          },
        ],
        [
          {
            text: "Open Hunch",
            url: buildDepositAppUrl({
              address,
              appBaseUrl: input.appBaseUrl,
              venue,
            }),
          },
        ],
        [{ callback_data: "hm:v1:deposit", text: "Back to venues" }],
      ],
    },
    text: [
      `*💳 ${isPolymarket ? "Polymarket" : "Limitless"} Deposit*`,
      "",
      escapeTelegramMarkdownV2(`Network: ${isPolymarket ? "Polygon" : "Base"}`),
      escapeTelegramMarkdownV2(
        `${isPolymarket ? "Assets" : "Asset"}: ${isPolymarket ? "pUSD or USDC.e" : "USDC"}`,
      ),
      "",
      escapeTelegramMarkdownV2(address),
      "",
      escapeTelegramMarkdownV2(
        `Send only ${isPolymarket ? "pUSD or USDC.e on Polygon" : "USDC on Base"} to this address.`,
      ),
    ].join("\n"),
    venue,
  };
}
