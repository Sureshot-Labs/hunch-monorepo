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

export async function resolveCanonicalPolymarketDepositAddress(input: {
  db: DbQuery;
  dependencies?: TelegramDepositResolverDependencies;
  telegramUserId: string | number;
}): Promise<string | null> {
  const fundingRouterAddress =
    input.dependencies?.fundingRouterAddress !== undefined
      ? input.dependencies.fundingRouterAddress
      : env.polymarketFundingRouterAddress;
  if (!fundingRouterAddress) return null;
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
  for (const row of rows) {
    try {
      const owner = ethers.getAddress(row.wallet_address);
      const stored = ethers.getAddress(row.funder_address ?? "");
      const data = fundingRouter.encodeFunctionData("depositWalletOf", [owner]);
      const result = await call({
        data,
        rpcUrl,
        timeoutMs,
        to: fundingRouterAddress,
      });
      const [derived] = fundingRouter.decodeFunctionResult(
        "depositWalletOf",
        result,
      );
      if (ethers.getAddress(String(derived)) !== stored) continue;
      const runtime = await code({
        address: stored,
        bypassCache: true,
        rpcUrl,
        timeoutMs,
      });
      if (decodePolymarketDepositWalletOwnerFromRuntime(runtime) !== owner) {
        continue;
      }
      return stored;
    } catch {
      continue;
    }
  }
  return null;
}

export async function buildTelegramDepositMessage(input: {
  appBaseUrl: string;
  pool: DbQuery;
  telegramUserId: string | number;
  venue?: string | null;
}): Promise<TelegramDepositMessage> {
  const venue = input.venue?.trim().toLowerCase() || "polymarket";
  const address =
    venue === "polymarket"
      ? await resolveCanonicalPolymarketDepositAddress({
          db: input.pool,
          telegramUserId: input.telegramUserId,
        })
      : null;
  if (!address) {
    return {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Finish setup",
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
          "A verified Polymarket deposit wallet is not ready yet. Finish Trading Wallet setup in Hunch.",
        ),
      ].join("\n"),
    };
  }
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
