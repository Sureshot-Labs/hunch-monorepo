import type { Pool } from "@hunch/infra";

import type { DbQuery } from "../db.js";
import {
  escapeTelegramMarkdownV2,
  loadSignalBotNotes,
  prepareSignalBotDelivery,
  resolveSignalBotBuySide,
  type SignalBotConfig,
  type SignalBotTelegramClient,
  type TelegramInlineKeyboard,
} from "./signal-bot.js";
import { buildSignalBotMiniAppEventUrl } from "./signal-bot-mini-app-links.js";
import {
  markTelegramNotificationsUnreachable,
  type TelegramNotificationTopic,
} from "./telegram-notification-preferences.js";

type TelegramNotificationOutboxRow = {
  attempt_count: number;
  id: string;
  payload: unknown;
  topic: TelegramNotificationTopic;
  user_id: string;
};

type TelegramNotificationDestinationRow = {
  enabled: boolean;
  enabled_since_event: boolean;
  reachable: boolean;
  telegram_user_id: string | null;
};

type TelegramNotificationMarket = {
  eventId: string | null;
  marketId: string | null;
  side: "NO" | "YES" | null;
  title: string | null;
};

export type TelegramUserNotificationMessage = {
  keyboard?: TelegramInlineKeyboard;
  replyToMessageId?: number;
  text: string;
};

const POSITION_SIGNAL_CURSOR_KEY = "telegram_position_signals_v1";
const ACTIVITY_NOTIFICATION_CURSOR_KEY = "telegram_activity_notifications_v1";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_DELIVERY_ATTEMPTS = 8;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBold(value: string): string {
  return `*${escapeTelegramMarkdownV2(value)}*`;
}

function formatItalic(value: string): string {
  return `_${escapeTelegramMarkdownV2(value)}_`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatShares(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value);
}

function formatPrice(value: number): string {
  if (value >= 0 && value <= 1) {
    return `${Math.round(value * 100)}¢`;
  }
  return formatUsd(value);
}

function normalizeSide(value: string | null): "NO" | "YES" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "YES" || normalized === "NO" ? normalized : null;
}

function normalizeAction(value: string | null): "BUY" | "SELL" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "BUY" || normalized === "SELL" ? normalized : null;
}

function notificationButton(input: {
  eventId: string | null;
  marketId: string | null;
  miniAppLinkBase: string | null;
  text: string;
}): TelegramInlineKeyboard | undefined {
  if (!input.eventId) return undefined;
  const url = buildSignalBotMiniAppEventUrl({
    eventId: input.eventId,
    marketId: input.marketId,
    miniAppLinkBase: input.miniAppLinkBase,
  });
  return url ? { inline_keyboard: [[{ text: input.text, url }]] } : undefined;
}

export function buildTelegramActivityNotificationMessage(input: {
  market: TelegramNotificationMarket | null;
  miniAppLinkBase: string | null;
  payload: unknown;
}): TelegramUserNotificationMessage | null {
  if (!isRecord(input.payload)) return null;
  const type = readString(input.payload, "type");
  const title = readString(input.payload, "title");
  const body = readString(input.payload, "body");
  const data = isRecord(input.payload.data) ? input.payload.data : {};
  if (!type || !title) return null;

  const marketTitle = input.market?.title;
  const dataSide = normalizeSide(readString(data, "outcomeSide"));
  const side = dataSide ?? input.market?.side;
  const action =
    normalizeAction(readString(data, "action")) ??
    normalizeAction(readString(data, "side"));
  const size = readNumber(data, "size");
  const price = readNumber(data, "price");
  const lines: string[] = [];
  let actionText: string | null = null;

  if (type === "order_filled") {
    lines.push(formatBold("✅ Order filled"));
    actionText = "View position";
  } else if (type === "deposit_received") {
    lines.push(formatBold("✅ Deposit received"));
  } else if (
    type === "bridge_completed" ||
    type === "bridge_refunded" ||
    type === "bridge_failed"
  ) {
    const icon =
      type === "bridge_completed"
        ? "✅"
        : type === "bridge_refunded"
          ? "↩️"
          : "⚠️";
    lines.push(formatBold(`${icon} ${title}`));
  } else if (type === "redemption_completed") {
    lines.push(formatBold("✅ Redemption completed"));
    actionText = "View position";
  } else if (type === "reward_claim_confirmed") {
    lines.push(formatBold("🎁 Cashback paid out"));
  } else if (type === "reward_claim_failed") {
    lines.push(formatBold("⚠️ Cashback claim failed"));
  } else if (type === "position_resolved") {
    const result = readString(data, "result");
    const resultTitle =
      result === "won" ? "won" : result === "lost" ? "lost" : "settled";
    lines.push(
      formatBold(`🏁 Your${side ? ` ${side}` : ""} position ${resultTitle}`),
    );
    actionText = "View position";
  } else if (type === "order_cancelled" || type === "order_failed") {
    lines.push(formatBold(`⚠️ ${title}`));
    actionText = "Review order";
  } else {
    return null;
  }

  if (marketTitle) {
    lines.push("", formatBold(marketTitle));
  }

  if (type === "position_resolved") {
    const resolvedOutcome = normalizeSide(readString(data, "resolvedOutcome"));
    if (resolvedOutcome) {
      lines.push(
        escapeTelegramMarkdownV2(`Resolved outcome: ${resolvedOutcome}`),
      );
    }
    if (body) lines.push(escapeTelegramMarkdownV2(body));
  } else {
    const details: string[] = [];
    if (action) details.push(action);
    if (side) details.push(side);
    if (size != null && size > 0 && price != null && price > 0) {
      details.push(`${formatShares(size)} shares at ${formatPrice(price)}`);
    } else {
      if (size != null && size > 0)
        details.push(`${formatShares(size)} shares`);
      if (price != null && price > 0) details.push(`at ${formatPrice(price)}`);
    }
    if (details.length > 0) {
      lines.push(escapeTelegramMarkdownV2(details.join(" · ")));
    } else if (body) {
      lines.push(escapeTelegramMarkdownV2(body));
    }
    if (type === "order_filled" && size && price && size > 0 && price > 0) {
      const valueLabel =
        action === "BUY"
          ? "Estimated spend"
          : action === "SELL"
            ? "Estimated proceeds"
            : "Estimated filled value";
      lines.push(
        escapeTelegramMarkdownV2(`${valueLabel}: ${formatUsd(size * price)}`),
      );
    }
  }

  return {
    keyboard: actionText
      ? notificationButton({
          eventId: input.market?.eventId ?? null,
          marketId: input.market?.marketId ?? null,
          miniAppLinkBase: input.miniAppLinkBase,
          text: actionText,
        })
      : undefined,
    text: lines.join("\n"),
  };
}

export async function enqueueTelegramActivityNotifications(input: {
  consumerKey?: string;
  pool: Pool;
  limit?: number;
}): Promise<number> {
  const limit = Math.min(500, Math.max(1, input.limit ?? 200));
  const consumerKey =
    input.consumerKey?.trim() || ACTIVITY_NOTIFICATION_CURSOR_KEY;
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const initialized = await client.query(
      `
        insert into telegram_notification_cursors (
          consumer_key,
          cursor_created_at,
          cursor_id
        )
        values ($1, now(), $2::uuid)
        on conflict (consumer_key) do nothing
        returning consumer_key
      `,
      [consumerKey, ZERO_UUID],
    );
    if ((initialized.rowCount ?? 0) > 0) {
      await client.query("commit");
      return 0;
    }

    const { rows: cursorRows } = await client.query<{
      cursor_created_at: string;
      cursor_id: string;
    }>(
      `
        select cursor_created_at::text as cursor_created_at, cursor_id
        from telegram_notification_cursors
        where consumer_key = $1
        for update
      `,
      [consumerKey],
    );
    const cursor = cursorRows[0];
    if (!cursor) throw new Error("Activity notification cursor unavailable");

    const { rows } = await client.query<{
      enqueued: string | number;
      last_created_at: string | null;
      last_id: string | null;
    }>(
      `
        with candidates as materialized (
          select n.*
          from notifications n
          where n.type in (
            'order_filled',
            'order_cancelled',
            'order_failed',
            'position_resolved',
            'deposit_received',
            'bridge_completed',
            'bridge_refunded',
            'bridge_failed',
            'redemption_completed',
            'reward_claim_confirmed',
            'reward_claim_failed'
          )
            and n.created_at is not null
            and (
              n.created_at > $1::timestamptz
              or (n.created_at = $1::timestamptz and n.id > $2::uuid)
            )
          order by n.created_at asc, n.id asc
          limit $3
        ),
        inserted as (
          insert into telegram_notification_outbox (
            user_id,
            event_key,
            topic,
            notification_id,
            event_occurred_at,
            payload
          )
          select
            n.user_id,
            'notification:' || n.id::text || ':' || n.type,
            case
              when n.type = 'order_filled' then 'order_filled'
              when n.type in ('order_cancelled', 'order_failed') then 'order_issues'
              when n.type = 'deposit_received' then 'deposit_received'
              when n.type in (
                'bridge_completed',
                'bridge_refunded',
                'bridge_failed'
              ) then 'bridge_updates'
              when n.type in (
                'redemption_completed',
                'reward_claim_confirmed',
                'reward_claim_failed'
              ) then 'payouts_rewards'
              else 'position_resolved'
            end,
            n.id,
            n.created_at,
            jsonb_build_object(
              'kind', 'activity',
              'type', n.type,
              'title', n.title,
              'body', n.body,
              'severity', n.severity,
              'data', coalesce(n.data, '{}'::jsonb),
              'createdAt', n.created_at
            )
          from candidates n
          join telegram_notification_preferences preference
            on preference.user_id = n.user_id
           and preference.reachable = true
          join user_telegram_accounts account
            on account.user_id = n.user_id
          where (
            (n.type = 'order_filled'
              and preference.order_filled = true
              and n.created_at >= preference.order_filled_enabled_at)
            or (n.type in ('order_cancelled', 'order_failed')
              and preference.order_issues = true
              and n.created_at >= preference.order_issues_enabled_at)
            or (n.type = 'position_resolved'
              and preference.position_resolved = true
              and n.created_at >= preference.position_resolved_enabled_at)
            or (n.type = 'deposit_received'
              and preference.deposit_received = true
              and n.created_at >= preference.deposit_received_enabled_at)
            or (n.type in ('bridge_completed', 'bridge_refunded', 'bridge_failed')
              and preference.bridge_updates = true
              and n.created_at >= preference.bridge_updates_enabled_at)
            or (n.type in (
                'redemption_completed',
                'reward_claim_confirmed',
                'reward_claim_failed'
              )
              and preference.payouts_rewards = true
              and n.created_at >= preference.payouts_rewards_enabled_at)
          )
          on conflict (user_id, event_key) do nothing
          returning id
        ),
        last_candidate as (
          select created_at, id
          from candidates
          order by created_at desc, id desc
          limit 1
        )
        select
          (select count(*)::int from inserted) as enqueued,
          last_candidate.created_at::text as last_created_at,
          last_candidate.id as last_id
        from (values (1)) seed(value)
        left join last_candidate on true
      `,
      [cursor.cursor_created_at, cursor.cursor_id, limit],
    );
    const result = rows[0];
    if (result?.last_created_at && result.last_id) {
      await client.query(
        `
          update telegram_notification_cursors
          set cursor_created_at = $2::timestamptz,
              cursor_id = $3::uuid,
              updated_at = now()
          where consumer_key = $1
        `,
        [consumerKey, result.last_created_at, result.last_id],
      );
    }
    await client.query("commit");
    return Number(result?.enqueued ?? 0);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type PositionSignalRecipientRow = {
  held_sides: string[] | null;
  position_snapshot_at: string | null;
  root_telegram_message_id: string | number | null;
  user_id: string;
};

function positionSignalRelationshipContext(input: {
  heldSides: Array<"NO" | "YES">;
  signalSide: "NO" | "YES" | null;
}): string {
  if (!input.signalSide || input.heldSides.length !== 1) {
    return "You hold a position in this market";
  }
  const heldSide = input.heldSides[0] as "NO" | "YES";
  return input.signalSide === heldSide
    ? `This supports your ${heldSide} position`
    : `This challenges your ${heldSide} position`;
}

function addPositionSignalContext(text: string, context: string): string {
  const lines = text.split("\n");
  const headline = lines[0] ?? "";
  const bodyStart = lines[1] === "" ? 2 : 1;
  return [
    headline,
    "",
    formatItalic(context),
    "",
    ...lines.slice(bodyStart),
  ].join("\n");
}

export async function enqueueTelegramPositionSignals(input: {
  config: Pick<
    SignalBotConfig,
    "appBaseUrl" | "buyAmountUsd" | "telegramMiniAppLinkBase"
  >;
  limit?: number;
  pool: Pool;
}): Promise<{ enqueued: number; notes: number }> {
  const client = await input.pool.connect();
  let enqueued = 0;
  let notesProcessed = 0;
  try {
    await client.query("begin");
    const { rows: cursorRows } = await client.query<{
      cursor_created_at: string;
      cursor_id: string;
    }>(
      `
        insert into telegram_notification_cursors (
          consumer_key,
          cursor_created_at,
          cursor_id
        )
        values ($1, now(), $2::uuid)
        on conflict (consumer_key) do update
        set consumer_key = excluded.consumer_key
        returning cursor_created_at::text as cursor_created_at, cursor_id
      `,
      [POSITION_SIGNAL_CURSOR_KEY, ZERO_UUID],
    );
    const cursor = cursorRows[0];
    if (!cursor) throw new Error("Position signal cursor unavailable");

    const notes = await loadSignalBotNotes(client, {
      afterCreatedAt: cursor.cursor_created_at,
      afterId: cursor.cursor_id,
      limit: Math.min(100, Math.max(1, input.limit ?? 25)),
    });

    for (const note of notes) {
      notesProcessed += 1;
      if (note.marketId) {
        const { rows: recipients } =
          await client.query<PositionSignalRecipientRow>(
            `
              select
                p.user_id,
                array_agg(distinct upper(ut.side))
                  filter (where upper(ut.side) in ('YES', 'NO')) as held_sides,
                max(coalesce(p.last_updated_at, p.updated_at))::text as position_snapshot_at,
                root_delivery.telegram_message_id as root_telegram_message_id
              from positions p
              join unified_tokens ut
                on ut.token_id = p.token_id
               and ut.venue = p.venue
              join telegram_notification_preferences preference
                on preference.user_id = p.user_id
               and preference.reachable = true
               and preference.position_signals = true
               and $2::timestamptz >= preference.position_signals_enabled_at
              join user_telegram_accounts account
                on account.user_id = p.user_id
              left join telegram_notification_outbox root_delivery
                on root_delivery.user_id = p.user_id
               and root_delivery.topic = 'position_signals'
               and root_delivery.note_id = $3::uuid
               and root_delivery.status = 'sent'
              where ut.market_id = $1
                and p.position_scope = 'own'
                and p.size > 0
                and coalesce(p.is_hidden, false) = false
                and (
                  $4::text = 'initial'
                  or root_delivery.telegram_message_id is not null
                )
              group by p.user_id, root_delivery.telegram_message_id
            `,
            [
              note.marketId,
              note.createdAt,
              note.thesisRootNoteId,
              note.revisionKind,
            ],
          );
        const preparation = await prepareSignalBotDelivery({
          appBaseUrl: input.config.appBaseUrl,
          buyAmountUsd: input.config.buyAmountUsd,
          chatType: "private",
          db: client,
          forceOpenMarket: true,
          messageKind: note.revisionKind,
          note,
          telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
        });
        if (preparation.status !== "ready") {
          await client.query(
            `
              update telegram_notification_cursors
              set cursor_created_at = $2::timestamptz,
                  cursor_id = $3::uuid,
                  updated_at = now()
              where consumer_key = $1
            `,
            [POSITION_SIGNAL_CURSOR_KEY, note.createdAt, note.id],
          );
          continue;
        }
        const signalSide = resolveSignalBotBuySide(note);

        for (const recipient of recipients) {
          const heldSides = (recipient.held_sides ?? [])
            .map(normalizeSide)
            .filter((side): side is "NO" | "YES" => side != null);
          const relationshipContext = positionSignalRelationshipContext({
            heldSides,
            signalSide,
          });
          const { rows: inserted } = await client.query<{ id: string }>(
            `
              insert into telegram_notification_outbox (
                user_id,
                event_key,
                topic,
                note_id,
                event_occurred_at,
                payload
              )
              values (
                $1,
                $2,
                'position_signals',
                $3::uuid,
                $4::timestamptz,
                $5::jsonb
              )
              on conflict (user_id, event_key) do nothing
              returning id
            `,
            [
              recipient.user_id,
              `position-signal:${note.thesisRootNoteId}:${note.revisionKind}:${note.id}`,
              note.id,
              note.createdAt,
              JSON.stringify({
                eventId: note.eventId,
                kind: "position_signal",
                marketId: note.marketId,
                messageKind: note.revisionKind,
                actionText:
                  note.revisionKind === "research_update"
                    ? "Open market"
                    : "Review position",
                replyToMessageId:
                  note.revisionKind === "research_update"
                    ? Number(recipient.root_telegram_message_id)
                    : null,
                text: addPositionSignalContext(
                  preparation.text,
                  relationshipContext,
                ),
                holdingEvidence: "cached_position",
                positionSnapshotAt: recipient.position_snapshot_at,
                thesisKey: note.thesisKey,
                thesisRootNoteId: note.thesisRootNoteId,
              }),
            ],
          );
          enqueued += inserted.length;
        }
      }

      await client.query(
        `
          update telegram_notification_cursors
          set cursor_created_at = $2::timestamptz,
              cursor_id = $3::uuid,
              updated_at = now()
          where consumer_key = $1
        `,
        [POSITION_SIGNAL_CURSOR_KEY, note.createdAt, note.id],
      );
    }
    await client.query("commit");
    return { enqueued, notes: notesProcessed };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function claimTelegramNotificationOutbox(input: {
  db: DbQuery;
  limit: number;
}): Promise<TelegramNotificationOutboxRow[]> {
  const { rows } = await input.db.query<TelegramNotificationOutboxRow>(
    `
      with candidates as (
        select id
        from telegram_notification_outbox
        where (
          status in ('pending', 'retry')
          and next_attempt_at <= now()
        ) or (
          status = 'sending'
          and updated_at <= now() - interval '5 minutes'
        )
        and (
          topic <> 'order_filled'
          or payload #>> '{data,source}' is distinct from 'telegram_bot'
          or event_occurred_at <= now() - interval '30 seconds'
        )
        order by next_attempt_at asc, created_at asc
        for update skip locked
        limit $1
      )
      update telegram_notification_outbox outbox
      set status = 'sending',
          attempt_count = outbox.attempt_count + 1,
          updated_at = now()
      from candidates
      where outbox.id = candidates.id
      returning
        outbox.id,
        outbox.user_id,
        outbox.topic,
        outbox.payload,
        outbox.attempt_count
    `,
    [input.limit],
  );
  return rows;
}

async function hasTelegramTradeReceipt(input: {
  db: DbQuery;
  payload: unknown;
}): Promise<boolean> {
  if (!isRecord(input.payload)) return false;
  const data = isRecord(input.payload.data) ? input.payload.data : null;
  if (!data || readString(data, "source") !== "telegram_bot") return false;
  const intentId = readString(data, "sourceIntentId");
  if (!intentId || !UUID_RE.test(intentId)) return false;
  const { rows } = await input.db.query<{ delivered: boolean }>(
    `
      select exists (
        select 1
        from telegram_trade_intents
        where id = $1::uuid
          and result #>> '{telegramReceipt,deliveredAt}' is not null
      ) as delivered
    `,
    [intentId],
  );
  return rows[0]?.delivered === true;
}

async function loadTelegramNotificationDestination(input: {
  db: DbQuery;
  outboxId: string;
}): Promise<TelegramNotificationDestinationRow | null> {
  const { rows } = await input.db.query<TelegramNotificationDestinationRow>(
    `
      select
        account.telegram_user_id,
        preference.reachable,
        case outbox.topic
          when 'order_filled' then preference.order_filled
          when 'order_issues' then preference.order_issues
          when 'position_resolved' then preference.position_resolved
          when 'deposit_received' then preference.deposit_received
          when 'bridge_updates' then preference.bridge_updates
          when 'payouts_rewards' then preference.payouts_rewards
          when 'position_signals' then preference.position_signals
          else false
        end as enabled,
        outbox.event_occurred_at >= case outbox.topic
          when 'order_filled' then preference.order_filled_enabled_at
          when 'order_issues' then preference.order_issues_enabled_at
          when 'position_resolved' then preference.position_resolved_enabled_at
          when 'deposit_received' then preference.deposit_received_enabled_at
          when 'bridge_updates' then preference.bridge_updates_enabled_at
          when 'payouts_rewards' then preference.payouts_rewards_enabled_at
          when 'position_signals' then preference.position_signals_enabled_at
          else now()
        end as enabled_since_event
      from telegram_notification_outbox outbox
      left join telegram_notification_preferences preference
        on preference.user_id = outbox.user_id
      left join user_telegram_accounts account
        on account.user_id = outbox.user_id
      where outbox.id = $1
      limit 1
    `,
    [input.outboxId],
  );
  return rows[0] ?? null;
}

async function loadTelegramNotificationMarket(input: {
  db: DbQuery;
  payload: unknown;
}): Promise<TelegramNotificationMarket | null> {
  if (!isRecord(input.payload)) return null;
  const data = isRecord(input.payload.data)
    ? input.payload.data
    : input.payload;
  const marketId = readString(data, "marketId");
  const tokenId = readString(data, "tokenId");
  const venue = readString(data, "venue");
  if (!marketId && !tokenId) return null;

  const { rows } = await input.db.query<{
    event_id: string | null;
    market_id: string;
    side: string | null;
    title: string | null;
  }>(
    `
      select
        market.id as market_id,
        market.event_id,
        market.title,
        token.side
      from unified_markets market
      left join unified_tokens token
        on token.market_id = market.id
       and $2::text is not null
       and token.token_id = $2
       and ($3::text is null or token.venue = $3)
      where ($1::text is not null and market.id = $1)
         or (
           $2::text is not null
           and token.token_id = $2
           and ($3::text is null or token.venue = $3)
         )
      order by case when market.id = $1 then 0 else 1 end
      limit 1
    `,
    [marketId, tokenId, venue?.toLowerCase() ?? null],
  );
  const row = rows[0];
  return row
    ? {
        eventId: row.event_id,
        marketId: row.market_id,
        side: normalizeSide(row.side),
        title: row.title,
      }
    : null;
}

function buildPositionSignalMessage(input: {
  miniAppLinkBase: string | null;
  payload: unknown;
}): TelegramUserNotificationMessage | null {
  if (!isRecord(input.payload)) return null;
  const text = readString(input.payload, "text");
  if (!text) return null;
  const actionText = readString(input.payload, "actionText");
  const replyToMessageId = readNumber(input.payload, "replyToMessageId");
  return {
    keyboard: notificationButton({
      eventId: readString(input.payload, "eventId"),
      marketId: readString(input.payload, "marketId"),
      miniAppLinkBase: input.miniAppLinkBase,
      text: actionText ?? "Open market",
    }),
    replyToMessageId:
      replyToMessageId != null &&
      Number.isInteger(replyToMessageId) &&
      replyToMessageId > 0
        ? replyToMessageId
        : undefined,
    text,
  };
}

async function markOutboxSkipped(input: {
  db: DbQuery;
  id: string;
  reason: string;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_notification_outbox
      set status = 'skipped', last_error = $2, updated_at = now()
      where id = $1
    `,
    [input.id, input.reason],
  );
}

async function markOutboxSent(input: {
  db: DbQuery;
  id: string;
  messageId: number | null;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_notification_outbox
      set status = 'sent',
          telegram_message_id = $2,
          last_error = null,
          sent_at = now(),
          updated_at = now()
      where id = $1
    `,
    [input.id, input.messageId],
  );
}

async function markOutboxFailed(input: {
  attemptCount: number;
  db: DbQuery;
  id: string;
  message: string;
  retryAfterSec?: number;
}): Promise<void> {
  const dead = input.attemptCount >= MAX_DELIVERY_ATTEMPTS;
  const retryAfterSec = Math.max(
    1,
    Math.min(
      3_600,
      input.retryAfterSec ?? 5 * 2 ** Math.max(0, input.attemptCount - 1),
    ),
  );
  await input.db.query(
    `
      update telegram_notification_outbox
      set status = $2,
          last_error = $3,
          next_attempt_at = now() + ($4::int * interval '1 second'),
          updated_at = now()
      where id = $1
    `,
    [input.id, dead ? "dead" : "retry", input.message, retryAfterSec],
  );
}

async function deferOutboxForChatRate(input: {
  db: DbQuery;
  id: string;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_notification_outbox
      set status = 'retry',
          attempt_count = greatest(0, attempt_count - 1),
          last_error = 'Deferred to respect the per-chat Telegram rate limit.',
          next_attempt_at = now() + interval '1 second',
          updated_at = now()
      where id = $1
    `,
    [input.id],
  );
}

export async function cleanupTelegramNotificationOutbox(input: {
  db: DbQuery;
  limit?: number;
  retentionDays?: number;
}): Promise<number> {
  const limit = Math.min(10_000, Math.max(1, input.limit ?? 1_000));
  const retentionDays = Math.min(
    365,
    Math.max(1, Math.trunc(input.retentionDays ?? 90)),
  );
  const result = await input.db.query(
    `
      with expired as (
        select id
        from telegram_notification_outbox
        where status in ('sent', 'skipped', 'dead')
          and updated_at < now() - ($1::int * interval '1 day')
        order by updated_at asc
        limit $2
      )
      delete from telegram_notification_outbox outbox
      using expired
      where outbox.id = expired.id
    `,
    [retentionDays, limit],
  );
  return result.rowCount ?? 0;
}

export async function deliverTelegramNotificationOutbox(input: {
  db: DbQuery;
  limit?: number;
  miniAppLinkBase: string | null;
  telegram: Pick<SignalBotTelegramClient, "sendMessage">;
}): Promise<{
  blocked: number;
  claimed: number;
  deferred: number;
  failed: number;
  sent: number;
  skipped: number;
}> {
  const rows = await claimTelegramNotificationOutbox({
    db: input.db,
    limit: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let blocked = 0;
  let deferred = 0;
  let failed = 0;
  let sent = 0;
  let skipped = 0;
  const attemptedChats = new Set<string>();

  for (const row of rows) {
    if (
      row.topic === "order_filled" &&
      (await hasTelegramTradeReceipt({ db: input.db, payload: row.payload }))
    ) {
      skipped += 1;
      await markOutboxSkipped({
        db: input.db,
        id: row.id,
        reason: "Telegram trade receipt already delivered.",
      });
      continue;
    }
    const destination = await loadTelegramNotificationDestination({
      db: input.db,
      outboxId: row.id,
    });
    if (
      !destination?.telegram_user_id ||
      !destination.enabled ||
      !destination.enabled_since_event ||
      !destination.reachable
    ) {
      skipped += 1;
      await markOutboxSkipped({
        db: input.db,
        id: row.id,
        reason:
          destination?.enabled === true &&
          destination.enabled_since_event === false
            ? "Notification predates the latest topic enablement."
            : "Telegram destination or preference is unavailable.",
      });
      continue;
    }
    if (attemptedChats.has(destination.telegram_user_id)) {
      deferred += 1;
      await deferOutboxForChatRate({ db: input.db, id: row.id });
      continue;
    }
    attemptedChats.add(destination.telegram_user_id);

    const message =
      row.topic === "position_signals"
        ? buildPositionSignalMessage({
            miniAppLinkBase: input.miniAppLinkBase,
            payload: row.payload,
          })
        : buildTelegramActivityNotificationMessage({
            market: await loadTelegramNotificationMarket({
              db: input.db,
              payload: row.payload,
            }),
            miniAppLinkBase: input.miniAppLinkBase,
            payload: row.payload,
          });
    if (!message) {
      skipped += 1;
      await markOutboxSkipped({
        db: input.db,
        id: row.id,
        reason: "Notification payload could not be rendered.",
      });
      continue;
    }

    const result = await input.telegram.sendMessage({
      chat_id: destination.telegram_user_id,
      disable_web_page_preview: true,
      parse_mode: "MarkdownV2",
      reply_parameters: message.replyToMessageId
        ? {
            allow_sending_without_reply: false,
            message_id: message.replyToMessageId,
          }
        : undefined,
      reply_markup: message.keyboard,
      text: message.text,
    });
    if (result.ok) {
      sent += 1;
      await markOutboxSent({
        db: input.db,
        id: row.id,
        messageId: result.messageId,
      });
      continue;
    }
    if (result.error === "blocked_or_missing") {
      blocked += 1;
      await markTelegramNotificationsUnreachable({
        db: input.db,
        userId: row.user_id,
      });
      await input.db.query(
        `
          update telegram_notification_outbox
          set status = 'dead', last_error = $2, updated_at = now()
          where id = $1
        `,
        [row.id, result.message],
      );
      continue;
    }
    failed += 1;
    await markOutboxFailed({
      attemptCount: row.attempt_count,
      db: input.db,
      id: row.id,
      message: result.message,
      retryAfterSec: result.retryAfterSec,
    });
  }

  return {
    blocked,
    claimed: rows.length,
    deferred,
    failed,
    sent,
    skipped,
  };
}
