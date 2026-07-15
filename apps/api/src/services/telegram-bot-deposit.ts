import { Interface, ethers } from "ethers";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";
import { decodePolymarketDepositWalletOwnerFromRuntime } from "./wallet-onchain-state.js";

const fundingRouter = new Interface([
  "function depositWalletOf(address owner) view returns (address)",
]);

export type TelegramDepositMessage = TelegramBotTradingClientMessage & {
  depositAddress?: string;
  qrText?: string;
  venue?: "polymarket";
};

export type TelegramDepositResolverDependencies = {
  fetchCall?: typeof fetchEvmCall;
  fetchCode?: typeof fetchEvmCode;
  fundingRouterAddress?: string | null;
  polygonRpcTimeoutMs?: number;
  polygonRpcUrl?: string;
};

export type TelegramPolymarketDepositResolution =
  | { address: string; status: "ready" }
  | {
      address: null;
      status:
        | "setup_required"
        | "temporarily_unavailable"
        | "verification_failed";
    };

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
      // A deployed runtime with malformed owner data is a verification
      // failure, not a transient RPC outage.
    }
    if (normalizedRuntimeOwner !== normalizedAddress(owner)) {
      continue;
    }
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

export async function buildTelegramDepositMessage(input: {
  appBaseUrl: string;
  dependencies?: TelegramDepositResolverDependencies;
  pool: DbQuery;
  telegramUserId: string | number;
  venue?: string | null;
}): Promise<TelegramDepositMessage> {
  const venue = input.venue?.trim().toLowerCase() || "polymarket";
  const resolution =
    venue === "polymarket"
      ? await resolveCanonicalPolymarketDeposit({
          db: input.pool,
          dependencies: input.dependencies,
          telegramUserId: input.telegramUserId,
        })
      : ({ address: null, status: "setup_required" } as const);
  if (!resolution.address) {
    const temporarilyUnavailable =
      resolution.status === "temporarily_unavailable";
    return {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: temporarilyUnavailable ? "Open Hunch" : "Finish setup",
              url: new URL(
                "/settings/telegram-trading",
                input.appBaseUrl,
              ).toString(),
            },
          ],
        ],
      },
      text: [
        "*💳 Deposit*",
        "",
        escapeTelegramMarkdownV2(
          temporarilyUnavailable
            ? "Deposit verification is temporarily unavailable. Try again or open Hunch."
            : resolution.status === "verification_failed"
              ? "The Polymarket deposit wallet could not be verified. Open Hunch to check Trading Wallet setup."
              : "A verified Polymarket deposit wallet is not ready yet. Finish Trading Wallet setup in Hunch.",
        ),
      ].join("\n"),
    };
  }
  const address = resolution.address;
  return {
    depositAddress: address,
    parse_mode: "MarkdownV2",
    qrText: address,
    reply_markup: {
      inline_keyboard: [
        [{ copy_text: { text: address }, text: "Copy address" }],
        [
          {
            callback_data: "hm:v1:deposit_qr:polymarket",
            text: "Show QR",
          },
        ],
      ],
    },
    text: [
      "*💳 Deposit · Polymarket*",
      "",
      escapeTelegramMarkdownV2("Network: Polygon"),
      escapeTelegramMarkdownV2("Assets: pUSD or USDC.e"),
      "",
      escapeTelegramMarkdownV2(address),
      "",
      "_Send only supported assets on Polygon to this address\\._",
    ].join("\n"),
    venue: "polymarket",
  };
}
