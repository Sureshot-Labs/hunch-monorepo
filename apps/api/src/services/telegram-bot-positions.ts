import type { Pool } from "@hunch/infra";

import { env } from "../env.js";
import type { Position } from "../order-types.js";
import { getRedis } from "../redis.js";
import { fetchPositionsForUserWallet } from "../repos/positions-repo.js";
import { fetchMarketsByTokenIds } from "../repos/unified-read.js";
import { mapMarketsByTokenRows } from "./markets-by-token-response.js";
import { escapeTelegramMarkdownV2 } from "./signal-bot.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import { syncPositionsForUserWallet } from "./positions-sync.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";

type SupportedPositionVenue = "kalshi" | "limitless" | "polymarket";

type VerifiedWalletRow = {
  wallet_address: string;
  wallet_type: string;
};

type PositionSyncTask = {
  venue: SupportedPositionVenue;
  walletAddress: string;
};

function formatNumber(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function isEvmWallet(wallet: VerifiedWalletRow): boolean {
  return (
    wallet.wallet_type.trim().toLowerCase() !== "solana" &&
    /^0x[0-9a-f]{40}$/i.test(wallet.wallet_address)
  );
}

function buildPositionTasks(wallets: VerifiedWalletRow[]): PositionSyncTask[] {
  const tasks: PositionSyncTask[] = [];
  for (const wallet of wallets) {
    if (isEvmWallet(wallet)) {
      tasks.push(
        { venue: "polymarket", walletAddress: wallet.wallet_address },
        { venue: "limitless", walletAddress: wallet.wallet_address },
      );
    } else {
      tasks.push({ venue: "kalshi", walletAddress: wallet.wallet_address });
    }
  }
  return tasks;
}

async function runBounded<T>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next++];
        if (value) await worker(value);
      }
    }),
  );
}

function positionMarkPrice(
  position: Position,
  marketEntry: ReturnType<typeof mapMarketsByTokenRows>[number] | undefined,
): number | null {
  const market = marketEntry?.market;
  if (!market) return null;
  const side = marketEntry.side?.trim().toUpperCase();
  if (side === "YES") return market.bestBidYes ?? market.lastPrice ?? null;
  if (side === "NO") {
    if (market.bestBidNo != null) return market.bestBidNo;
    if (
      market.lastPrice != null &&
      market.lastPrice >= 0 &&
      market.lastPrice <= 1
    ) {
      return 1 - market.lastPrice;
    }
  }
  return market.bestBid ?? market.lastPrice ?? null;
}

function renderPosition(
  position: Position,
  marketEntry: ReturnType<typeof mapMarketsByTokenRows>[number] | undefined,
): string {
  const title =
    marketEntry?.market.marketTitle ??
    marketEntry?.market.event.eventTitle ??
    "Prediction market";
  const side = marketEntry?.side?.trim().toUpperCase() ?? "POSITION";
  const cost =
    position.averagePrice != null && position.averagePrice > 0
      ? position.size * position.averagePrice
      : null;
  const mark = positionMarkPrice(position, marketEntry);
  const currentValue = mark != null ? position.size * mark : null;
  const holding = [
    `${formatNumber(position.size)} shares`,
    cost != null ? `Cost ${formatUsd(cost)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `*${escapeTelegramMarkdownV2(`${title} · ${side}`)}*`,
    escapeTelegramMarkdownV2(holding),
    currentValue != null
      ? escapeTelegramMarkdownV2(`Current value: ${formatUsd(currentValue)}`)
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function buildTelegramPositionsMessage(input: {
  appBaseUrl: string;
  pool: Pool;
  telegramUserId: string | number;
}): Promise<TelegramBotTradingClientMessage> {
  const { rows: accountRows } = await input.pool.query<{ user_id: string }>(
    `
      select user_id
      from user_telegram_accounts
      where telegram_user_id = $1
      limit 1
    `,
    [String(input.telegramUserId)],
  );
  const userId = accountRows[0]?.user_id;
  if (!userId) {
    return {
      parse_mode: "MarkdownV2",
      text: "*💼 My positions*\n\nConnect this Telegram account to Hunch first\\.",
    };
  }

  const { rows: wallets } = await input.pool.query<VerifiedWalletRow>(
    `
      select wallet_address, wallet_type
      from user_wallets
      where user_id = $1
        and is_verified = true
      order by is_primary desc, created_at asc
    `,
    [userId],
  );
  const { rows: credentialRows } = await input.pool.query<{
    venue: string;
    wallet_address: string;
  }>(
    `
      select venue, wallet_address
      from user_venue_credentials
      where user_id = $1
        and is_active = true
    `,
    [userId],
  );
  const limitlessWallets = new Set(
    credentialRows
      .filter((row) => row.venue === "limitless")
      .map((row) => row.wallet_address.toLowerCase()),
  );
  const tasks = buildPositionTasks(wallets).filter(
    (task) =>
      task.venue !== "limitless" ||
      limitlessWallets.has(task.walletAddress.toLowerCase()),
  );
  let partialFailure = false;
  const redis =
    env.positionsSyncCooldownSec > 0
      ? await getRedis().catch(() => {
          partialFailure = true;
          return null;
        })
      : null;
  await runBounded(tasks, 2, async (task) => {
    try {
      if (
        !(await venueLifecycleAllows(input.pool, task.venue, "accountRead"))
      ) {
        return;
      }
      if (redis && env.positionsSyncCooldownSec > 0) {
        const key = `positions:sync:${userId}:${task.walletAddress}:${task.venue}`;
        const acquired = await redis.set(key, Date.now().toString(), {
          EX: env.positionsSyncCooldownSec,
          NX: true,
        });
        if (!acquired) return;
      }
      await syncPositionsForUserWallet(input.pool, {
        userId,
        venue: task.venue,
        walletAddress: task.walletAddress,
      });
    } catch {
      partialFailure = true;
    }
  });

  const positions = await fetchPositionsForUserWallet(input.pool, {
    userId,
    walletAddresses: wallets.map((wallet) => wallet.wallet_address),
    venues: ["polymarket", "limitless", "kalshi"],
  });
  const tokenIds = Array.from(
    new Set(positions.map((position) => position.tokenId)),
  );
  const marketRows =
    tokenIds.length > 0
      ? await fetchMarketsByTokenIds(input.pool, { tokenIds })
      : [];
  const marketByToken = new Map(
    mapMarketsByTokenRows(marketRows).map((entry) => [entry.tokenId, entry]),
  );
  const visible = positions.slice(0, 10);
  const lines = ["*💼 My positions*", ""];
  if (visible.length === 0) {
    lines.push("No open positions\\.");
  } else {
    lines.push(
      visible
        .map((position) =>
          renderPosition(position, marketByToken.get(position.tokenId)),
        )
        .join("\n\n"),
      "",
      escapeTelegramMarkdownV2(`Open positions: ${positions.length}`),
    );
    if (positions.length > visible.length) {
      lines.push(
        escapeTelegramMarkdownV2(`+ ${positions.length - visible.length} more`),
      );
    }
  }
  if (partialFailure) {
    lines.push("", "_Some balances may be delayed\\._");
  }

  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Open portfolio",
            url: new URL("/portfolio", input.appBaseUrl).toString(),
          },
        ],
      ],
    },
    text: lines.join("\n"),
  };
}
