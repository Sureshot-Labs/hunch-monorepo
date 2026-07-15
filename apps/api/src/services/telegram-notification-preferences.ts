import type { DbQuery } from "../db.js";

export type TelegramNotificationTopic =
  | "bridge_updates"
  | "deposit_received"
  | "order_filled"
  | "order_issues"
  | "payouts_rewards"
  | "position_resolved"
  | "position_signals";

export type TelegramNotificationPreferences = {
  bridgeUpdates: boolean;
  depositReceived: boolean;
  orderFilled: boolean;
  orderIssues: boolean;
  payoutsRewards: boolean;
  positionResolved: boolean;
  positionSignals: boolean;
  reachable: boolean;
  userId: string;
};

type TelegramNotificationPreferencesRow = {
  bridge_updates: boolean;
  deposit_received: boolean;
  user_id: string;
  order_filled: boolean;
  order_issues: boolean;
  payouts_rewards: boolean;
  position_resolved: boolean;
  position_signals: boolean;
  reachable: boolean;
};

function rowToPreferences(
  row: TelegramNotificationPreferencesRow,
): TelegramNotificationPreferences {
  return {
    bridgeUpdates: row.bridge_updates,
    depositReceived: row.deposit_received,
    orderFilled: row.order_filled,
    orderIssues: row.order_issues,
    payoutsRewards: row.payouts_rewards,
    positionResolved: row.position_resolved,
    positionSignals: row.position_signals,
    reachable: row.reachable,
    userId: row.user_id,
  };
}

export async function ensureTelegramNotificationPreferences(input: {
  db: DbQuery;
  markStarted?: boolean;
  telegramUserId: number | string;
}): Promise<TelegramNotificationPreferences | null> {
  const { rows } = await input.db.query<TelegramNotificationPreferencesRow>(
    `
      insert into telegram_notification_preferences (
        user_id,
        reachable,
        blocked_at,
        last_started_at
      )
      select
        uta.user_id,
        true,
        null,
        case when $2::boolean then now() else null end
      from user_telegram_accounts uta
      where uta.telegram_user_id = $1
      on conflict (user_id) do update
      set
        order_filled_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.order_filled_enabled_at
        end,
        order_issues_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.order_issues_enabled_at
        end,
        position_resolved_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.position_resolved_enabled_at
        end,
        deposit_received_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.deposit_received_enabled_at
        end,
        bridge_updates_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.bridge_updates_enabled_at
        end,
        payouts_rewards_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.payouts_rewards_enabled_at
        end,
        position_signals_enabled_at = case
          when telegram_notification_preferences.reachable = false
            then now()
          else telegram_notification_preferences.position_signals_enabled_at
        end,
        reachable = true,
        blocked_at = null,
        last_started_at = case
          when $2::boolean then now()
          else telegram_notification_preferences.last_started_at
        end,
        updated_at = now()
      returning
        user_id,
        order_filled,
        order_issues,
        position_resolved,
        deposit_received,
        bridge_updates,
        payouts_rewards,
        position_signals,
        reachable
    `,
    [String(input.telegramUserId), input.markStarted === true],
  );
  const row = rows[0];
  return row ? rowToPreferences(row) : null;
}

const topicColumns: Record<
  TelegramNotificationTopic,
  { enabled: string; enabledAt: string }
> = {
  bridge_updates: {
    enabled: "bridge_updates",
    enabledAt: "bridge_updates_enabled_at",
  },
  deposit_received: {
    enabled: "deposit_received",
    enabledAt: "deposit_received_enabled_at",
  },
  order_filled: {
    enabled: "order_filled",
    enabledAt: "order_filled_enabled_at",
  },
  order_issues: {
    enabled: "order_issues",
    enabledAt: "order_issues_enabled_at",
  },
  payouts_rewards: {
    enabled: "payouts_rewards",
    enabledAt: "payouts_rewards_enabled_at",
  },
  position_resolved: {
    enabled: "position_resolved",
    enabledAt: "position_resolved_enabled_at",
  },
  position_signals: {
    enabled: "position_signals",
    enabledAt: "position_signals_enabled_at",
  },
};

export async function setTelegramNotificationTopic(input: {
  db: DbQuery;
  enabled: boolean;
  telegramUserId: number | string;
  topic: TelegramNotificationTopic;
}): Promise<TelegramNotificationPreferences | null> {
  const preferences = await ensureTelegramNotificationPreferences({
    db: input.db,
    telegramUserId: input.telegramUserId,
  });
  if (!preferences) return null;

  const columns = topicColumns[input.topic];
  const { rows } = await input.db.query<TelegramNotificationPreferencesRow>(
    `
      update telegram_notification_preferences
      set
        ${columns.enabledAt} = case
          when $2::boolean = true and ${columns.enabled} = false then now()
          else ${columns.enabledAt}
        end,
        ${columns.enabled} = $2::boolean,
        updated_at = now()
      where user_id = $1
      returning
        user_id,
        order_filled,
        order_issues,
        position_resolved,
        deposit_received,
        bridge_updates,
        payouts_rewards,
        position_signals,
        reachable
    `,
    [preferences.userId, input.enabled],
  );
  const row = rows[0];
  return row ? rowToPreferences(row) : null;
}

export async function markTelegramNotificationsUnreachable(input: {
  db: DbQuery;
  userId: string;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_notification_preferences
      set reachable = false,
          blocked_at = now(),
          updated_at = now()
      where user_id = $1
    `,
    [input.userId],
  );
}
