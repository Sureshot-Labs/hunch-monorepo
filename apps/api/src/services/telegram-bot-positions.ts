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
  formatTelegramCalloutMarkdownV2,
  formatTelegramFieldMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import {
  buildTelegramMarketIdentity,
  formatTelegramVenueFieldMarkdownV2,
} from "./telegram-market-identity.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  canAppendTelegramBlock,
  compactTelegramText,
} from "./telegram-bot-text-budget.js";
import { telegramMenuIndexEmoji } from "./telegram-bot-menu-numbering.js";
import { syncPositionsForUserWallet } from "./positions-sync.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";
import { telegramCustomEmojiMarkdownV2 } from "./telegram-custom-emoji.js";
import {
  canonicalAccountAddress,
  sameAccountAddress,
} from "../funding/domain/asset-identity.js";

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
  eventTitle: string | null;
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

export const TELEGRAM_POSITIONS_PAGE_SIZE = 5;
const TELEGRAM_POSITIONS_GRID_COLUMNS = 3;

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
        const walletKey = canonicalAccountAddress(
          task.venue === "kalshi" ? "solana:mainnet" : "evm:1",
          task.walletAddress,
        );
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
      eventTitle: null,
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
    eventTitle: marketEntry.market.event.eventTitle ?? null,
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

function renderPosition(
  detail: TelegramPositionDetail,
  displayIndex: number,
): string {
  const identity = buildTelegramMarketIdentity({
    eventTitle: detail.eventTitle,
    marketTitle: detail.marketTitle,
  });
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
  const positionFacts = [
    `${formatNumber(detail.position.size)} shares`,
    detail.averagePrice == null
      ? null
      : `Avg ${formatNumber(detail.averagePrice * 100, 1)}¢`,
  ].filter((value): value is string => value != null);
  const valueFacts = [
    detail.currentValueUsd != null
      ? formatUsd(detail.currentValueUsd)
      : "unavailable",
    detail.pnlUsd != null && detail.pnlPercent != null
      ? `PnL ${formatSignedUsd(detail.pnlUsd)} (${formatSignedPercent(
          detail.pnlPercent,
        )})`
      : null,
  ].filter((value): value is string => value != null);
  return [
    formatTelegramBoldMarkdownV2(
      `${telegramMenuIndexEmoji(displayIndex)} ${compactTelegramText(
        identity.lines[0],
        150,
      )} · ${detail.side ?? "POSITION"}`,
    ),
    ...(identity.lines[1]
      ? [
          `🎯 ${formatTelegramFieldMarkdownV2(
            "Market",
            compactTelegramText(identity.lines[1], 150),
          )}`,
        ]
      : []),
    `${formatTelegramVenueFieldMarkdownV2(
      detail.position.venue,
    )} ${escapeTelegramMarkdownV2("·")} ${status.icon} ${formatTelegramBoldMarkdownV2(
      status.label,
    )}`,
    `📦 ${formatTelegramFieldMarkdownV2(
      "Position",
      positionFacts.join(" · "),
    )}`,
    `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
      "Value",
      valueFacts.join(" · "),
    )}`,
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
  key: TelegramPositionGroup;
  label: string;
}> = [
  { key: "open", label: "Open" },
  { key: "redeemable", label: "Ready to redeem" },
  { key: "waiting", label: "Waiting for settlement" },
  { key: "resolved", label: "Resolved" },
  { key: "metadata_unavailable", label: "Details unavailable" },
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
  const limitlessWallets = credentialRows.filter(
    (row) => row.venue === "limitless",
  );
  const tasks = buildPositionTasks(wallets).filter(
    (task) =>
      task.venue !== "limitless" ||
      limitlessWallets.some((row) =>
        sameAccountAddress("evm:1", row.wallet_address, task.walletAddress),
      ),
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
  page?: number;
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
  const orderedPositions = grouped.flatMap((group) => group.positions);
  const pageCount = Math.max(
    1,
    Math.ceil(orderedPositions.length / TELEGRAM_POSITIONS_PAGE_SIZE),
  );
  const page = Math.min(
    pageCount - 1,
    Math.max(0, Math.trunc(input.page ?? 0)),
  );
  const pageStart = page * TELEGRAM_POSITIONS_PAGE_SIZE;
  const pagePositions = orderedPositions.slice(
    pageStart,
    pageStart + TELEGRAM_POSITIONS_PAGE_SIZE,
  );
  const visible: TelegramPositionDetail[] = [];
  const dataQualityNotes: string[] = [];
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
    for (const position of pagePositions) {
      const block = renderPosition(position, visible.length + 1);
      if (
        !canAppendTelegramBlock({
          block,
          currentLines: lines,
          reserve: 320,
        })
      ) {
        break;
      }
      visible.push(position);
      lines.push(block, "");
    }
    lines.push(
      `📊 ${formatTelegramFieldMarkdownV2(
        "Summary",
        grouped
          .map((group) => `${group.label} ${group.positions.length}`)
          .join(" · "),
      )}`,
    );
    if (pageCount > 1) {
      lines.push(
        `📄 ${formatTelegramFieldMarkdownV2(
          "Page",
          `${page + 1}/${pageCount}`,
        )}`,
      );
    }
    if (pagePositions.length > visible.length) {
      lines.push(
        escapeTelegramMarkdownV2(
          `+ ${pagePositions.length - visible.length} more on this page`,
        ),
      );
    }
    if (positions.some((position) => !position.marketId)) {
      dataQualityNotes.push(
        escapeTelegramMarkdownV2(
          "Some holdings are shown without market details until metadata refreshes.",
        ),
      );
    }
  }
  if (input.snapshot.partialFailure) {
    dataQualityNotes.push(
      escapeTelegramMarkdownV2("Some balances may be delayed."),
    );
  }
  if (dataQualityNotes.length > 0) {
    lines.push(
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: dataQualityNotes,
        icon: "ℹ️",
        title: "Data may be incomplete",
      }),
    );
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
  const positionButtonRows: NonNullable<
    TelegramBotTradingClientMessage["reply_markup"]
  >["inline_keyboard"] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const position = visible[index];
    if (!position) continue;
    const rowIndex = Math.floor(index / TELEGRAM_POSITIONS_GRID_COLUMNS);
    const row = positionButtonRows[rowIndex] ?? [];
    row.push({
      callback_data: `hm:v1:pos:${position.position.id}:${page}`,
      text: telegramMenuIndexEmoji(index + 1),
    });
    positionButtonRows[rowIndex] = row;
  }
  const paginationRows: NonNullable<
    TelegramBotTradingClientMessage["reply_markup"]
  >["inline_keyboard"] =
    pageCount > 1
      ? [
          [
            {
              callback_data: `hm:v1:positions_page:${Math.max(0, page - 1)}`,
              text:
                page === 0 ? `· Page ${page + 1}/${pageCount}` : "⬅️ Previous",
            },
            {
              callback_data: `hm:v1:positions_page:${Math.min(
                pageCount - 1,
                page + 1,
              )}`,
              text:
                page === pageCount - 1
                  ? `Page ${page + 1}/${pageCount} ·`
                  : "Next ➡️",
            },
          ],
        ]
      : [];
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...positionButtonRows,
        ...paginationRows,
        ...(portfolioButton ? [[portfolioButton]] : []),
        [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
      ],
    },
    text: joinTelegramMarkdownV2Lines(lines),
  };
}

export async function buildTelegramPositionsMessage(input: {
  appBaseUrl: string;
  page?: number;
  pool: Pool;
  telegramMiniAppEnabled?: boolean;
  telegramUserId: string | number;
}): Promise<TelegramBotTradingClientMessage> {
  const loaded = await loadTelegramPositions(input);
  if (!loaded.linked) {
    return {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[{ callback_data: "hm:v1:home", text: "🏠 Home" }]],
      },
      text: `💼 ${formatTelegramBoldMarkdownV2(
        "My positions",
      )}\n\n🔗 ${formatTelegramBoldMarkdownV2(
        "Account not connected",
      )}\n\nConnect this Telegram account to Hunch first\\.`,
    };
  }
  return buildTelegramPositionsSnapshotMessage({
    appBaseUrl: input.appBaseUrl,
    page: input.page,
    snapshot: loaded.snapshot,
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
  });
}
