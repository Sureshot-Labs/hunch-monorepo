import type { Pool } from "@hunch/infra";

import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramFieldMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";
import { resolveActiveTelegramAccountLink } from "./telegram-account-link.js";
import {
  COMPLETED_EXECUTION_STATUSES,
  COMPLETED_ORDER_STATUSES,
  normalizeTradeAction,
} from "./completed-trade-semantics.js";
import { telegramCustomEmojiMarkdownV2 } from "./telegram-custom-emoji.js";
import {
  buildTelegramMarketIdentity,
  formatTelegramVenueLabelMarkdownV2,
} from "./telegram-market-identity.js";
import { telegramMenuIndexEmoji } from "./telegram-bot-menu-numbering.js";
import {
  canAppendTelegramBlock,
  compactTelegramText,
} from "./telegram-bot-text-budget.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  normalizeOutcomeSideForApi,
  outcomeLabelOrSide,
} from "./wallet-intel-helpers.js";

export const TELEGRAM_TRADE_HISTORY_LIMIT = 10;

type TelegramTradeHistoryRow = {
  action: string | null;
  amount_in: string | null;
  amount_out: string | null;
  event_title: string | null;
  input_decimals: number | string | null;
  kind: "order" | "swap";
  market_title: string | null;
  outcome: string | null;
  outcome_side: string | null;
  outcomes: unknown;
  output_decimals: number | string | null;
  price: string | null;
  shares: string | null;
  traded_at: Date | string | null;
  venue: string | null;
};

export type TelegramTradeHistoryEntry = {
  action: "BUY" | "SELL";
  eventTitle: string | null;
  marketTitle: string;
  notionalUsd: number | null;
  outcome: string;
  price: number | null;
  shares: number | null;
  tradedAt: Date;
  venue: string;
};

export type TelegramTradeHistorySnapshot = {
  trades: TelegramTradeHistoryEntry[];
};

function positiveNumber(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function decimalAmount(
  value: string | null,
  decimals: number | string | null,
): number | null {
  const raw = positiveNumber(value);
  if (raw == null) return null;
  const scale = Number(decimals ?? 6);
  if (!Number.isInteger(scale) || scale < 0 || scale > 30) return null;
  const normalized = raw / 10 ** scale;
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function normalizeOutcome(row: TelegramTradeHistoryRow): string {
  const recorded = row.outcome?.trim();
  if (recorded && !["YES", "NO"].includes(recorded.toUpperCase())) {
    return recorded;
  }
  const side = normalizeOutcomeSideForApi(recorded || row.outcome_side);
  return side ? outcomeLabelOrSide(row.outcomes, side) : "Outcome unavailable";
}

function mapTradeHistoryRow(
  row: TelegramTradeHistoryRow,
): TelegramTradeHistoryEntry | null {
  const action = normalizeTradeAction(row.action);
  const venue = row.venue?.trim();
  if (!action || !venue || row.traded_at == null) return null;
  const tradedAt = new Date(row.traded_at);
  if (!Number.isFinite(tradedAt.getTime())) return null;

  let shares = positiveNumber(row.shares);
  let price = positiveNumber(row.price);
  let notionalUsd = shares != null && price != null ? shares * price : null;

  if (row.kind === "swap") {
    const input = decimalAmount(row.amount_in, row.input_decimals);
    const output = decimalAmount(row.amount_out, row.output_decimals);
    shares = action === "BUY" ? output : input;
    notionalUsd = action === "BUY" ? input : output;
    price = shares != null && notionalUsd != null ? notionalUsd / shares : null;
  }

  return {
    action,
    eventTitle: row.event_title,
    marketTitle: row.market_title?.trim() || "Prediction market",
    notionalUsd,
    outcome: normalizeOutcome(row),
    price,
    shares,
    tradedAt,
    venue,
  };
}

export async function loadTelegramTradeHistory(input: {
  pool: Pool;
  telegramUserId: string | number;
}): Promise<
  | { linked: false; snapshot: TelegramTradeHistorySnapshot }
  | { linked: true; snapshot: TelegramTradeHistorySnapshot; userId: string }
> {
  const link = await resolveActiveTelegramAccountLink({
    db: input.pool,
    telegramUserId: input.telegramUserId,
  });
  if (!link) return { linked: false, snapshot: { trades: [] } };
  const userId = link.userId;

  const { rows } = await input.pool.query<TelegramTradeHistoryRow>(
    `with ranked_orders as (
       select o.id,
              o.user_id,
              o.venue,
              o.venue_order_id,
              o.side as action,
              coalesce(market_token.market_id, legacy_token.market_id) as market_id,
              coalesce(market_token.outcome_side, legacy_token.side) as outcome_side,
              case
                when coalesce(o.filled_size, 0) > 0 then o.filled_size
                when lower(coalesce(o.status, '')) = any($2::text[]) then o.size
                else null
              end::text as shares,
              coalesce(o.average_fill_price, o.price)::text as price,
              coalesce(o.filled_at, o.last_update, o.posted_at) as traded_at,
              row_number() over (
                partition by o.user_id,
                             o.venue,
                             coalesce(nullif(o.venue_order_id, ''), o.id::text)
                order by (o.average_fill_price is not null)::int desc,
                         (o.filled_size is not null and o.filled_size > 0)::int desc,
                         o.last_update desc nulls last,
                         o.id desc
              ) as row_rank
         from orders o
         left join unified_market_tokens market_token
           on market_token.token_id = o.token_id
          and market_token.venue = o.venue
         left join unified_tokens legacy_token
           on legacy_token.token_id = o.token_id
          and legacy_token.venue = o.venue
        where o.user_id = $1::uuid
          and o.venue is not null
          and upper(coalesce(o.side, '')) in ('BUY', 'SELL')
          and coalesce(o.filled_at, o.last_update, o.posted_at) is not null
          and (
            coalesce(o.filled_size, 0) > 0
            or coalesce(o.average_fill_price, 0) > 0
            or lower(coalesce(o.status, '')) = any($2::text[])
          )
     ), completed_trades as (
       select 'order'::text as kind,
              ranked.action,
              ranked.venue,
              ranked.market_id,
              ranked.outcome_side,
              null::text as outcome,
              ranked.shares,
              ranked.price,
              null::text as amount_in,
              null::text as amount_out,
              null::integer as input_decimals,
              null::integer as output_decimals,
              ranked.traded_at
         from ranked_orders ranked
        where ranked.row_rank = 1
       union all
       select 'swap'::text as kind,
              execution.side as action,
              execution.venue,
              execution.unified_market_id as market_id,
              null::text as outcome_side,
              execution.outcome,
              null::text as shares,
              null::text as price,
              execution.amount_in::text,
              execution.amount_out::text,
              execution.input_decimals,
              execution.output_decimals,
              coalesce(execution.updated_at, execution.created_at) as traded_at
         from executions execution
        where execution.user_id = $1::uuid
          and upper(coalesce(execution.side, '')) in ('BUY', 'SELL')
          and coalesce(execution.updated_at, execution.created_at) is not null
          and lower(coalesce(execution.status, '')) = any($3::text[])
     )
     select trade.kind,
            trade.action,
            trade.venue,
            trade.outcome_side,
            trade.outcome,
            trade.shares,
            trade.price,
            trade.amount_in,
            trade.amount_out,
            trade.input_decimals,
            trade.output_decimals,
            trade.traded_at,
            market.title as market_title,
            market.outcomes,
            event_row.title as event_title
       from completed_trades trade
       left join unified_markets market on market.id = trade.market_id
       left join unified_events event_row on event_row.id = market.event_id
      order by trade.traded_at desc nulls last
      limit $4`,
    [
      userId,
      COMPLETED_ORDER_STATUSES,
      COMPLETED_EXECUTION_STATUSES,
      TELEGRAM_TRADE_HISTORY_LIMIT,
    ],
  );

  return {
    linked: true,
    snapshot: {
      trades: rows
        .map(mapTradeHistoryRow)
        .filter((trade): trade is TelegramTradeHistoryEntry => trade != null),
    },
    userId,
  };
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

function formatTradeTime(value: Date): string {
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][value.getUTCMonth()];
  const time = `${String(value.getUTCHours()).padStart(2, "0")}:${String(
    value.getUTCMinutes(),
  ).padStart(2, "0")}`;
  return `${month} ${value.getUTCDate()}, ${value.getUTCFullYear()} · ${time} UTC`;
}

function renderTrade(
  trade: TelegramTradeHistoryEntry,
  displayIndex: number,
): string {
  const identity = buildTelegramMarketIdentity({
    eventTitle: trade.eventTitle,
    marketTitle: trade.marketTitle,
  });
  const directionEmoji = telegramCustomEmojiMarkdownV2(
    trade.action === "BUY" ? "positionBuy" : "positionSell",
  );
  const fillFacts = [
    trade.notionalUsd == null ? null : formatUsd(trade.notionalUsd),
    trade.shares == null
      ? trade.price == null
        ? null
        : `Avg ${formatNumber(trade.price * 100, 1)}¢`
      : `${formatNumber(trade.shares, 4)} shares${
          trade.price == null ? "" : ` @ ${formatNumber(trade.price * 100, 1)}¢`
        }`,
  ].filter((fact): fact is string => fact != null);
  const fillIcon =
    trade.notionalUsd == null ? "📦" : telegramCustomEmojiMarkdownV2("usdc");

  return [
    `${directionEmoji} ${formatTelegramBoldMarkdownV2(
      `${telegramMenuIndexEmoji(displayIndex)} ${trade.action} · ${compactTelegramText(
        trade.outcome,
        48,
      )}`,
    )}`,
    `🎯 ${formatTelegramBoldMarkdownV2(
      compactTelegramText(identity.lines[0], 64),
    )}`,
    ...(identity.lines[1]
      ? [
          formatTelegramFieldMarkdownV2(
            "Market",
            compactTelegramText(identity.lines[1], 64),
          ),
        ]
      : []),
    `${formatTelegramVenueLabelMarkdownV2(
      trade.venue,
    )} ${escapeTelegramMarkdownV2("·")} 🕒 ${escapeTelegramMarkdownV2(
      formatTradeTime(trade.tradedAt),
    )}`,
    `${fillIcon} ${formatTelegramFieldMarkdownV2(
      "Filled",
      fillFacts.length > 0 ? fillFacts.join(" · ") : "completed",
    )}`,
  ].join("\n");
}

export function buildTelegramTradeHistorySnapshotMessage(input: {
  snapshot: TelegramTradeHistorySnapshot;
}): TelegramBotTradingClientMessage {
  const lines = [`📜 ${formatTelegramBoldMarkdownV2("Trading History")}`, ""];
  const visible: TelegramTradeHistoryEntry[] = [];
  const trades = input.snapshot.trades.slice(0, TELEGRAM_TRADE_HISTORY_LIMIT);
  if (trades.length === 0) {
    lines.push(
      `ℹ️ ${formatTelegramBoldMarkdownV2("No completed trades yet")}`,
      "",
      escapeTelegramMarkdownV2(
        "Filled Buy and Sell trades across your Hunch account will appear here.",
      ),
    );
  } else {
    lines.push(
      escapeTelegramMarkdownV2(
        `Your ${trades.length} most recent completed trade${trades.length === 1 ? "" : "s"}.`,
      ),
      "",
    );
    for (const trade of trades) {
      const block = renderTrade(trade, visible.length + 1);
      if (
        !canAppendTelegramBlock({ block, currentLines: lines, reserve: 180 })
      ) {
        break;
      }
      visible.push(trade);
      lines.push(block, "");
    }
    if (visible.length < trades.length) {
      lines.push(
        escapeTelegramMarkdownV2(
          `+ ${trades.length - visible.length} more completed trades`,
        ),
      );
    }
  }

  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: "hm:v1:trade_history",
            text: "🔄 Refresh",
          },
        ],
        [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
      ],
    },
    text: joinTelegramMarkdownV2Lines(lines),
  };
}

export async function buildTelegramTradeHistoryMessage(input: {
  pool: Pool;
  telegramUserId: string | number;
}): Promise<TelegramBotTradingClientMessage> {
  const loaded = await loadTelegramTradeHistory(input);
  if (!loaded.linked) {
    return {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[{ callback_data: "hm:v1:home", text: "🏠 Home" }]],
      },
      text: [
        `📜 ${formatTelegramBoldMarkdownV2("Trading History")}`,
        "",
        `🔗 ${formatTelegramBoldMarkdownV2("Account not connected")}`,
        "",
        "Connect this Telegram account to Hunch first\\.",
      ].join("\n"),
    };
  }
  return buildTelegramTradeHistorySnapshotMessage({
    snapshot: loaded.snapshot,
  });
}

export const telegramBotTradeHistoryTestHooks = {
  mapTradeHistoryRow,
  renderTrade,
};
