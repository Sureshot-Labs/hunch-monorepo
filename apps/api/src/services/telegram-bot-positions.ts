import type { Pool } from "@hunch/infra";

import { env } from "../env.js";
import type { Position } from "../order-types.js";
import { getRedis } from "../redis.js";
import { fetchPositionsForUserWallet } from "../repos/positions-repo.js";
import { fetchMarketsByTokenIds } from "../repos/unified-read.js";
import { mapMarketsByTokenRows } from "./markets-by-token-response.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramFieldMarkdownV2,
} from "./telegram-bot-trading-presentation.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import {
  formatTelegramVenueButtonIcon,
  formatTelegramVenueFieldMarkdownV2,
} from "./telegram-market-identity.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  canAppendTelegramBlock,
  compactTelegramText,
  TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
} from "./telegram-bot-text-budget.js";
import { syncPositionsForUserWallet } from "./positions-sync.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";
import { telegramCustomEmojiMarkdownV2 } from "./telegram-custom-emoji.js";

type SupportedPositionVenue = "kalshi" | "limitless" | "polymarket";

type VerifiedWalletRow = {
  wallet_address: string;
  wallet_type: string;
};

export type TelegramPositionSyncTask = {
  venue: SupportedPositionVenue;
  walletAddress: string;
};

export type TelegramPositionSyncRedis = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; XX?: boolean },
  ): Promise<unknown>;
};

type MappedMarketEntry = ReturnType<typeof mapMarketsByTokenRows>[number];

export type TelegramPositionDetail = {
  averagePrice: number | null;
  currentValueUsd: number | null;
  eventId: string | null;
  marketId: string | null;
  marketOrderable: boolean;
  marketTitle: string;
  markPrice: number | null;
  pnlPercent: number | null;
  pnlUsd: number | null;
  position: Position;
  redemptionStatus: string;
  side: "NO" | "YES" | null;
};

export type TelegramPositionsSnapshot = {
  partialFailure: boolean;
  positions: TelegramPositionDetail[];
};

type TelegramPositionGroup =
  | "metadata_unavailable"
  | "open"
  | "redeemable"
  | "resolved"
  | "waiting";

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

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatUsd(value)}`;
}

function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, 1)}%`;
}

function isEvmWallet(wallet: VerifiedWalletRow): boolean {
  return (
    wallet.wallet_type.trim().toLowerCase() !== "solana" &&
    /^0x[0-9a-f]{40}$/i.test(wallet.wallet_address)
  );
}

function buildPositionTasks(
  wallets: VerifiedWalletRow[],
): TelegramPositionSyncTask[] {
  const tasks: TelegramPositionSyncTask[] = [];
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

export async function runTelegramPositionSyncTasks(input: {
  cooldownSec: number;
  pool: Pool;
  redis: TelegramPositionSyncRedis | null;
  syncPosition?: typeof syncPositionsForUserWallet;
  tasks: TelegramPositionSyncTask[];
  userId: string;
  venueAllowed?: typeof venueLifecycleAllows;
}): Promise<{ partialFailure: boolean }> {
  const cooldownSec = Math.max(0, Math.floor(input.cooldownSec));
  if (cooldownSec > 0 && !input.redis) {
    return { partialFailure: true };
  }
  const syncPosition = input.syncPosition ?? syncPositionsForUserWallet;
  const venueAllowed = input.venueAllowed ?? venueLifecycleAllows;
  let partialFailure = false;
  await runBounded(input.tasks, 2, async (task) => {
    let cooldownKey: string | null = null;
    let attemptToken: string | null = null;
    try {
      if (!(await venueAllowed(input.pool, task.venue, "accountRead"))) return;
      if (cooldownSec > 0) {
        if (!input.redis) {
          partialFailure = true;
          return;
        }
        const walletKey = /^0x[0-9a-f]{40}$/i.test(task.walletAddress)
          ? task.walletAddress.toLowerCase()
          : task.walletAddress;
        cooldownKey = `positions:sync:${input.userId}:${walletKey}:${task.venue}`;
        attemptToken = crypto.randomUUID();
        const acquired = await input.redis.set(cooldownKey, attemptToken, {
          EX: cooldownSec,
          NX: true,
        });
        if (!acquired) return;
      }
      await syncPosition(input.pool, {
        userId: input.userId,
        venue: task.venue,
        walletAddress: task.walletAddress,
      });
    } catch {
      partialFailure = true;
      if (input.redis && cooldownKey && attemptToken) {
        const currentToken = await input.redis
          .get(cooldownKey)
          .catch(() => null);
        if (currentToken === attemptToken) {
          await input.redis
            .set(cooldownKey, attemptToken, {
              EX: Math.max(1, Math.min(cooldownSec, 30)),
              XX: true,
            })
            .catch(() => undefined);
        }
      }
    }
  });
  return { partialFailure };
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
  marketEntry: MappedMarketEntry | undefined,
): number | null {
  const market = marketEntry?.market;
  if (!market) return null;
  const side = marketEntry.side?.trim().toUpperCase();
  if (side === "YES") return market.bestBidYes ?? market.bestBid ?? null;
  if (side === "NO") return market.bestBidNo ?? null;
  return market.bestBid ?? null;
}

export function buildTelegramPositionDetail(
  position: Position,
  marketEntry: MappedMarketEntry | undefined,
  canonicalSide?: string | null,
): TelegramPositionDetail {
  const normalizedSide = (marketEntry?.side ?? canonicalSide ?? position.side)
    ?.trim()
    .toUpperCase();
  const side =
    normalizedSide === "YES" || normalizedSide === "NO" ? normalizedSide : null;
  const averagePrice =
    position.averagePrice != null && position.averagePrice > 0
      ? position.averagePrice
      : null;
  const cost = averagePrice == null ? null : position.size * averagePrice;
  const mark = positionMarkPrice(position, marketEntry);
  const currentValue = mark != null ? position.size * mark : null;
  const pnl = cost != null && currentValue != null ? currentValue - cost : null;
  if (!marketEntry) {
    return {
      averagePrice,
      currentValueUsd: null,
      eventId: null,
      marketId: null,
      marketOrderable: false,
      marketTitle: "Position",
      markPrice: null,
      pnlPercent: null,
      pnlUsd: null,
      position,
      redemptionStatus: "metadata_unavailable",
      side,
    };
  }
  return {
    averagePrice,
    currentValueUsd: currentValue,
    eventId: marketEntry.market.event.eventId,
    marketId: marketEntry.market.marketId,
    marketOrderable: marketEntry.market.acceptingOrders,
    marketTitle:
      marketEntry.market.marketTitle ??
      marketEntry.market.event.eventTitle ??
      "Prediction market",
    markPrice: mark,
    pnlPercent:
      pnl != null && cost != null && cost > 0 ? (pnl / cost) * 100 : null,
    pnlUsd: pnl,
    position,
    redemptionStatus: marketEntry.market.redemption.status,
    side,
  };
}

function renderPosition(detail: TelegramPositionDetail): string {
  const cost =
    detail.averagePrice == null
      ? null
      : detail.position.size * detail.averagePrice;
  const status =
    detail.redemptionStatus === "metadata_unavailable"
      ? { icon: "⚠️", label: "Market details unavailable" }
      : detail.redemptionStatus === "redeemable"
        ? { icon: "✅", label: "Ready to redeem" }
        : detail.redemptionStatus === "market_open"
          ? { icon: "🟢", label: "Market open" }
          : detail.redemptionStatus === "resolved_not_redeemable" ||
              detail.redemptionStatus === "redeemed"
            ? { icon: "🏁", label: "Resolved" }
            : { icon: "⏳", label: "Waiting for settlement" };
  const priceAndCost = [
    detail.averagePrice != null
      ? formatTelegramFieldMarkdownV2(
          "Average price",
          `${formatNumber(detail.averagePrice * 100, 1)}¢`,
        )
      : null,
    cost != null
      ? formatTelegramFieldMarkdownV2("Cost", formatUsd(cost))
      : null,
  ].filter((line): line is string => line != null);
  return [
    formatTelegramVenueFieldMarkdownV2(detail.position.venue),
    `🎯 ${formatTelegramFieldMarkdownV2(
      "Market",
      `${compactTelegramText(detail.marketTitle, 120)} · ${detail.side ?? "POSITION"}`,
    )}`,
    `📦 ${formatTelegramFieldMarkdownV2(
      "Shares",
      formatNumber(detail.position.size),
    )}`,
    ...(priceAndCost.length > 0
      ? [`💳 ${priceAndCost.join(escapeTelegramMarkdownV2(" · "))}`]
      : []),
    `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
      "Value",
      detail.currentValueUsd != null
        ? formatUsd(detail.currentValueUsd)
        : "unavailable",
    )}`,
    ...(detail.pnlUsd != null && detail.pnlPercent != null
      ? [
          `${detail.pnlUsd >= 0 ? "📈" : "📉"} ${formatTelegramFieldMarkdownV2(
            "PnL",
            `${formatSignedUsd(detail.pnlUsd)} (${formatSignedPercent(
              detail.pnlPercent,
            )})`,
          )}`,
        ]
      : []),
    `${status.icon} ${formatTelegramBoldMarkdownV2(status.label)}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function positionGroup(detail: TelegramPositionDetail): TelegramPositionGroup {
  if (!detail.marketId) return "metadata_unavailable";
  if (detail.redemptionStatus === "market_open") return "open";
  if (detail.redemptionStatus === "redeemable") return "redeemable";
  if (
    detail.redemptionStatus === "resolved_not_redeemable" ||
    detail.redemptionStatus === "redeemed"
  ) {
    return "resolved";
  }
  return "waiting";
}

export const telegramBotPositionsTestHooks = {
  positionGroup,
  renderPosition,
};

const POSITION_GROUPS: Array<{
  icon: string;
  key: TelegramPositionGroup;
  label: string;
}> = [
  { icon: "🟢", key: "open", label: "Open" },
  { icon: "✅", key: "redeemable", label: "Ready to redeem" },
  { icon: "⏳", key: "waiting", label: "Waiting for settlement" },
  { icon: "🏁", key: "resolved", label: "Resolved" },
  { icon: "⚠️", key: "metadata_unavailable", label: "Details unavailable" },
];

export async function loadTelegramPositions(input: {
  pool: Pool;
  telegramUserId: string | number;
  sync?: boolean;
}): Promise<
  | { linked: false; snapshot: TelegramPositionsSnapshot }
  | { linked: true; snapshot: TelegramPositionsSnapshot; userId: string }
> {
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
      linked: false,
      snapshot: { partialFailure: false, positions: [] },
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
  const shouldSync = input.sync !== false;
  const redis =
    shouldSync && env.positionsSyncCooldownSec > 0
      ? await getRedis().catch(() => {
          partialFailure = true;
          return null;
        })
      : null;
  if (shouldSync) {
    const syncResult = await runTelegramPositionSyncTasks({
      cooldownSec: env.positionsSyncCooldownSec,
      pool: input.pool,
      redis,
      tasks,
      userId,
    });
    partialFailure ||= syncResult.partialFailure;
  }

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
  let tokenSideRows: Array<{
    outcome_side: string | null;
    token_id: string;
  }> = [];
  if (tokenIds.length > 0) {
    try {
      ({ rows: tokenSideRows } = await input.pool.query<{
        outcome_side: string | null;
        token_id: string;
      }>(
        `select token_id, outcome_side
           from unified_market_tokens
          where token_id = any($1::text[])`,
        [tokenIds],
      ));
    } catch {
      partialFailure = true;
    }
  }
  const sideByToken = new Map(
    tokenSideRows.map((row) => [row.token_id, row.outcome_side]),
  );
  return {
    linked: true,
    snapshot: {
      partialFailure,
      positions: positions.map((position) =>
        buildTelegramPositionDetail(
          position,
          marketByToken.get(position.tokenId),
          sideByToken.get(position.tokenId),
        ),
      ),
    },
    userId,
  };
}

export function buildTelegramPositionsSnapshotMessage(input: {
  appBaseUrl: string;
  snapshot: TelegramPositionsSnapshot;
  telegramMiniAppEnabled?: boolean;
}): TelegramBotTradingClientMessage {
  const positions = input.snapshot.positions;
  const valued = positions.filter(
    (position) =>
      position.currentValueUsd != null && position.averagePrice != null,
  );
  const invested = valued.reduce(
    (total, position) =>
      total + position.position.size * (position.averagePrice ?? 0),
    0,
  );
  const value = valued.reduce(
    (total, position) => total + (position.currentValueUsd ?? 0),
    0,
  );
  const pnl = value - invested;
  const grouped = POSITION_GROUPS.map((group) => ({
    ...group,
    positions: positions.filter(
      (position) => positionGroup(position) === group.key,
    ),
  })).filter((group) => group.positions.length > 0);
  let remaining = 8;
  const candidateGroups = grouped
    .map((group) => {
      const visiblePositions = group.positions.slice(0, remaining);
      remaining -= visiblePositions.length;
      return { ...group, positions: visiblePositions };
    })
    .filter((group) => group.positions.length > 0);
  const visible: TelegramPositionDetail[] = [];
  const lines = [`💼 ${formatTelegramBoldMarkdownV2("My positions")}`, ""];
  if (positions.length === 0) {
    lines.push(
      `ℹ️ ${formatTelegramBoldMarkdownV2("No open positions")}`,
      "",
      "Markets you trade will appear here\\.",
    );
  } else {
    if (valued.length > 0) {
      lines.push(
        `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2("Portfolio value", formatUsd(value))}`,
        `💳 ${formatTelegramFieldMarkdownV2("Invested", formatUsd(invested))}`,
        `${pnl >= 0 ? "📈" : "📉"} ${formatTelegramFieldMarkdownV2(
          "PnL",
          `${formatSignedUsd(pnl)}${
            invested > 0
              ? ` (${formatSignedPercent((pnl / invested) * 100)})`
              : ""
          }`,
        )}`,
      );
      if (valued.length !== positions.length) {
        lines.push(
          `📊 ${formatTelegramFieldMarkdownV2(
            "Valuation coverage",
            `${valued.length}/${positions.length} positions`,
          )}`,
        );
      }
      lines.push("");
    } else {
      lines.push(
        `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
          "Portfolio value",
          "unavailable",
        )}`,
        `📊 ${formatTelegramFieldMarkdownV2(
          "Valuation coverage",
          `0/${positions.length} positions`,
        )}`,
        "",
      );
    }
    for (const group of candidateGroups) {
      const groupLines = [
        `${group.icon} ${formatTelegramBoldMarkdownV2(group.label)}`,
      ];
      const accepted: TelegramPositionDetail[] = [];
      for (const position of group.positions) {
        const block = renderPosition(position);
        if (
          !canAppendTelegramBlock({
            block: [...groupLines, block].join("\n\n"),
            currentLines: lines,
            reserve: 320,
          })
        ) {
          break;
        }
        groupLines.push(block);
        accepted.push(position);
      }
      if (accepted.length === 0) continue;
      visible.push(...accepted);
      lines.push(groupLines.join("\n\n"), "");
    }
    lines.push(
      `📊 ${formatTelegramFieldMarkdownV2(
        "Summary",
        grouped
          .map((group) => `${group.label} ${group.positions.length}`)
          .join(" · "),
      )}`,
    );
    if (positions.length > visible.length) {
      lines.push(
        escapeTelegramMarkdownV2(
          `+ ${positions.length - visible.length} more positions`,
        ),
      );
    }
    if (positions.some((position) => !position.marketId)) {
      lines.push(
        "",
        "_Some holdings are shown without market details until metadata refreshes\\._",
      );
    }
  }
  if (input.snapshot.partialFailure) {
    lines.push("", "_Some balances may be delayed\\._");
  }

  const portfolioButton = buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.telegramMiniAppEnabled === true,
    path: "/portfolio",
    text: "Open portfolio",
  });
  if (!portfolioButton) {
    lines.push(
      "",
      `⚠️ ${formatTelegramBoldMarkdownV2("Mini App temporarily unavailable")}`,
    );
  }
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...visible
          .filter(
            (position) => position.marketId != null && position.side != null,
          )
          .map((position) => [
            {
              callback_data: `hm:v1:pos:${position.position.id}`,
              icon_custom_emoji_id: formatTelegramVenueButtonIcon(
                position.position.venue,
              ),
              text: compactTelegramText(
                `${position.marketTitle} · ${position.side ?? "Position"}${
                  position.pnlUsd != null
                    ? ` · ${formatSignedUsd(position.pnlUsd)}`
                    : ""
                }`,
                TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
              ),
            },
          ]),
        ...(portfolioButton ? [[portfolioButton]] : []),
      ],
    },
    text: lines.join("\n"),
  };
}

export async function buildTelegramPositionsMessage(input: {
  appBaseUrl: string;
  pool: Pool;
  telegramMiniAppEnabled?: boolean;
  telegramUserId: string | number;
}): Promise<TelegramBotTradingClientMessage> {
  const loaded = await loadTelegramPositions(input);
  if (!loaded.linked) {
    return {
      parse_mode: "MarkdownV2",
      text: `💼 ${formatTelegramBoldMarkdownV2(
        "My positions",
      )}\n\n🔗 ${formatTelegramBoldMarkdownV2(
        "Account not connected",
      )}\n\nConnect this Telegram account to Hunch first\\.`,
    };
  }
  return buildTelegramPositionsSnapshotMessage({
    appBaseUrl: input.appBaseUrl,
    snapshot: loaded.snapshot,
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
  });
}
