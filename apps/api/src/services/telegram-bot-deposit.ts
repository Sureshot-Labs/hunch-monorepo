import { Interface, ethers } from "ethers";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";
import { filterVenuesForLifecycleCapability } from "./venue-lifecycle.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import { recordTelegramDepositResolutionAnalytics } from "./telegram-lifecycle-analytics.js";
import {
  telegramCustomEmojiIdForVenue,
  telegramCustomEmojiMarkdownV2,
  telegramCustomEmojiMarkdownV2ForNetwork,
  telegramCustomEmojiMarkdownV2ForVenue,
} from "./telegram-custom-emoji.js";

const fundingRouter = new Interface([
  "function depositWalletOf(address owner) view returns (address)",
]);
const depositWallet = new Interface([
  "function owner() view returns (address)",
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

export type TelegramDepositResolutionReason =
  | "missing_code"
  | "owner_mismatch"
  | "router_mismatch"
  | "rpc_unavailable"
  | "setup_required";

export type TelegramDepositResolution =
  | { address: string; reason: null; status: "ready" }
  | {
      address: null;
      reason: TelegramDepositResolutionReason;
      status:
        | "setup_required"
        | "temporarily_unavailable"
        | "verification_failed";
    };

export type TelegramPolymarketDepositResolution = TelegramDepositResolution;

function normalizedAddress(value: string): string {
  return ethers.getAddress(value).toLowerCase();
}

function isContractVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|invalid opcode|call exception|revert/i.test(
    message,
  );
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
    return {
      address: null,
      reason: "rpc_unavailable",
      status: "temporarily_unavailable",
    };
  }
  const call = input.dependencies?.fetchCall ?? fetchEvmCall;
  const code = input.dependencies?.fetchCode ?? fetchEvmCode;
  const rpcUrl = input.dependencies?.polygonRpcUrl ?? env.polygonRpcUrl;
  const timeoutMs =
    input.dependencies?.polygonRpcTimeoutMs ?? env.polygonRpcTimeoutMs;
  let rows: Array<{
    funder_address: string | null;
    wallet_address: string;
  }>;
  try {
    ({ rows } = await input.db.query<{
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
    ));
  } catch {
    return {
      address: null,
      reason: "rpc_unavailable",
      status: "temporarily_unavailable",
    };
  }
  if (rows.length === 0) {
    return {
      address: null,
      reason: "setup_required",
      status: "setup_required",
    };
  }
  let rpcUnavailable = false;
  let failureReason: Exclude<
    TelegramDepositResolutionReason,
    "rpc_unavailable" | "setup_required"
  > = "owner_mismatch";
  for (const row of rows) {
    let owner: string;
    let stored: string;
    try {
      owner = ethers.getAddress(row.wallet_address);
      stored = ethers.getAddress(row.funder_address ?? "");
    } catch {
      failureReason = "owner_mismatch";
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
      failureReason = "router_mismatch";
      continue;
    }
    if (derivedAddress !== normalizedAddress(stored)) {
      failureReason = "router_mismatch";
      continue;
    }
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
    if (runtime.trim().toLowerCase() === "0x" || runtime.trim() === "0x0") {
      failureReason = "missing_code";
      continue;
    }
    let ownerResult: string;
    try {
      ownerResult = await call({
        data: depositWallet.encodeFunctionData("owner"),
        rpcUrl,
        timeoutMs,
        to: stored,
      });
    } catch (error) {
      if (isContractVerificationError(error)) {
        failureReason = "owner_mismatch";
      } else {
        rpcUnavailable = true;
      }
      continue;
    }
    let contractOwner: string;
    try {
      const [decodedOwner] = depositWallet.decodeFunctionResult(
        "owner",
        ownerResult,
      );
      contractOwner = normalizedAddress(String(decodedOwner));
    } catch {
      failureReason = "owner_mismatch";
      continue;
    }
    if (contractOwner !== normalizedAddress(owner)) {
      failureReason = "owner_mismatch";
      continue;
    }
    return { address: stored, reason: null, status: "ready" };
  }
  return {
    address: null,
    reason: rpcUnavailable ? "rpc_unavailable" : failureReason,
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
    return {
      address: null,
      reason: "rpc_unavailable",
      status: "temporarily_unavailable",
    };
  }
  const internalWallets = normalizeInternalEvmWallets(input.internalWallets);
  if (internalWallets.size === 0) {
    return {
      address: null,
      reason: "setup_required",
      status: "setup_required",
    };
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
    return {
      address: null,
      reason: "rpc_unavailable",
      status: "temporarily_unavailable",
    };
  }
  if (preferredAddress) {
    try {
      const matched = internalWallets.get(
        ethers.getAddress(preferredAddress).toLowerCase(),
      );
      if (matched) return { address: matched, reason: null, status: "ready" };
    } catch {
      // Fall through to the unambiguous internal-wallet rule.
    }
  }
  if (internalWallets.size === 1) {
    const [address] = internalWallets.values();
    if (address) return { address, reason: null, status: "ready" };
  }
  return {
    address: null,
    reason: preferredAddress ? "owner_mismatch" : "setup_required",
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

function depositVenueLabel(venue: TelegramDepositVenue): string {
  return venue === "polymarket" ? "Polymarket" : "Limitless";
}

function depositNetwork(venue: TelegramDepositVenue): "Base" | "Polygon" {
  return venue === "polymarket" ? "Polygon" : "Base";
}

function depositAssetLabel(venue: TelegramDepositVenue): string {
  return venue === "polymarket" ? "pUSD / USDC.e" : "USDC";
}

function buildDepositTitleMarkdownV2(venue?: TelegramDepositVenue): string {
  const emoji = venue
    ? telegramCustomEmojiMarkdownV2ForVenue(venue)
    : telegramCustomEmojiMarkdownV2("usdc");
  const label = venue ? `${depositVenueLabel(venue)} Deposit` : "Deposit";
  return `${emoji ?? telegramCustomEmojiMarkdownV2("usdc")} *${escapeTelegramMarkdownV2(label)}*`;
}

function buildDepositVenueSummaryMarkdownV2(
  venue: TelegramDepositVenue,
): string {
  const network = depositNetwork(venue);
  return [
    telegramCustomEmojiMarkdownV2ForVenue(venue),
    escapeTelegramMarkdownV2(depositVenueLabel(venue)),
    "·",
    telegramCustomEmojiMarkdownV2ForNetwork(network),
    escapeTelegramMarkdownV2(network),
    "·",
    telegramCustomEmojiMarkdownV2("usdc"),
    escapeTelegramMarkdownV2(depositAssetLabel(venue)),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function buildTelegramDepositAddressPresentation(input: {
  address: string;
  copyButtonText?: string;
  venue: TelegramDepositVenue;
}): {
  buttonRows: NonNullable<
    TelegramDepositMessage["reply_markup"]
  >["inline_keyboard"];
  lines: string[];
  markdownV2Lines: string[];
} {
  const isPolymarket = input.venue === "polymarket";
  const network = depositNetwork(input.venue);
  const assetLabel = isPolymarket ? "pUSD or USDC.e" : "USDC";
  const lines = [
    `Network: ${network}`,
    `${isPolymarket ? "Assets" : "Asset"}: ${assetLabel}`,
    `Address: ${input.address}`,
    `Send only ${isPolymarket ? "pUSD or USDC.e on Polygon" : "USDC on Base"} to this address.`,
  ];
  return {
    buttonRows: [
      [
        {
          copy_text: { text: input.address },
          text: input.copyButtonText ?? "Copy address",
        },
      ],
      [
        {
          callback_data: `hm:v1:deposit_qr:${input.venue}`,
          text: "Show QR",
        },
      ],
    ],
    lines,
    markdownV2Lines: [
      `${telegramCustomEmojiMarkdownV2ForNetwork(network)} ${escapeTelegramMarkdownV2(lines[0] ?? "")}`,
      `${telegramCustomEmojiMarkdownV2("usdc")} ${escapeTelegramMarkdownV2(lines[1] ?? "")}`,
      escapeTelegramMarkdownV2(lines[2] ?? ""),
      `${telegramCustomEmojiMarkdownV2("usdc")} ${escapeTelegramMarkdownV2(lines[3] ?? "")}`,
    ],
  };
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
          icon_custom_emoji_id: telegramCustomEmojiIdForVenue(venue),
          text: depositVenueLabel(venue),
        },
      ]),
    },
    text: [
      buildDepositTitleMarkdownV2(),
      "",
      escapeTelegramMarkdownV2("Choose a trading venue."),
      "",
      ...(venues.includes("polymarket")
        ? [buildDepositVenueSummaryMarkdownV2("polymarket")]
        : []),
      ...(venues.includes("limitless")
        ? [buildDepositVenueSummaryMarkdownV2("limitless")]
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
  miniAppEnabled: boolean;
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
  const openButton = buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.miniAppEnabled,
    path: isPolymarket
      ? "/settings/telegram-trading"
      : buildDepositAppUrl({
          appBaseUrl: input.appBaseUrl,
          venue: input.venue,
        }),
    text:
      isPolymarket && !temporarilyUnavailable ? "Finish setup" : "Open Hunch",
  });
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...(openButton ? [[openButton]] : []),
        [{ callback_data: "hm:v1:deposit", text: "Back to venues" }],
      ],
    },
    text: [
      buildDepositTitleMarkdownV2(input.venue),
      "",
      escapeTelegramMarkdownV2(text),
      ...(!openButton
        ? ["", escapeTelegramMarkdownV2("Mini App temporarily unavailable.")]
        : []),
    ].join("\n"),
  };
}

export async function buildTelegramDepositMessage(input: {
  appBaseUrl: string;
  dependencies?: TelegramDepositResolverDependencies;
  internalWallets?: readonly TelegramDepositInternalWallet[] | null;
  pool: DbQuery;
  telegramMiniAppEnabled?: boolean;
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
        buildDepositTitleMarkdownV2(),
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
  await recordTelegramDepositResolutionAnalytics({
    db: input.pool,
    reason: resolution.reason,
    source: "deposit_menu",
    status: resolution.status,
    telegramUserId: input.telegramUserId,
    venue,
  }).catch(() => undefined);
  if (resolution.status !== "ready") {
    return buildDepositUnavailableMessage({
      appBaseUrl: input.appBaseUrl,
      miniAppEnabled: input.telegramMiniAppEnabled === true,
      resolution,
      venue,
    });
  }
  const address = resolution.address;
  const presentation = buildTelegramDepositAddressPresentation({
    address,
    venue,
  });
  const openButton = buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.telegramMiniAppEnabled === true,
    path: buildDepositAppUrl({
      address,
      appBaseUrl: input.appBaseUrl,
      venue,
    }),
    text: "Open Hunch",
  });
  return {
    depositAddress: address,
    parse_mode: "MarkdownV2",
    qrText: address,
    reply_markup: {
      inline_keyboard: [
        ...presentation.buttonRows,
        ...(openButton ? [[openButton]] : []),
        [{ callback_data: "hm:v1:deposit", text: "Back to venues" }],
      ],
    },
    text: [
      buildDepositTitleMarkdownV2(venue),
      "",
      ...presentation.markdownV2Lines,
      ...(!openButton
        ? ["", escapeTelegramMarkdownV2("Mini App temporarily unavailable.")]
        : []),
    ].join("\n"),
    venue,
  };
}
