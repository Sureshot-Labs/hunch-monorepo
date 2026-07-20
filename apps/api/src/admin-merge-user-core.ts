import type { Pool, PoolClient } from "pg";

import { pool } from "./db.js";

export type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  privy_user_id: string | null;
  referral_code: string | null;
  is_admin: boolean | null;
  kalshi_proof_bypass: boolean | null;
  last_login_at: Date | null;
};

export type MergeOptions = {
  dryRun: boolean;
  keepSource: boolean;
};

export type MergeSummary = {
  walletsInserted: number;
  venueCredsDeduped: number;
  venueCredsMoved: number;
  sessionsMoved: number;
  watchlistDeduped: number;
  watchlistMoved: number;
  tradingPrefsDropped: number;
  tradingPrefsMoved: number;
  tradingStatsDropped: number;
  tradingStatsMoved: number;
  idempotencyDeduped: number;
  idempotencyMoved: number;
  executionsDeduped: number;
  executionsMoved: number;
  positionsDeduped: number;
  positionsMoved: number;
  feeEventsDeduped: number;
  feeEventsMoved: number;
  volumeEventsDeduped: number;
  volumeEventsMoved: number;
  rewardClaimsMoved: number;
  ordersMoved: number;
  orderLogsMoved: number;
  bridgeOrdersMoved: number;
  telegramAccountsMoved: number;
  telegramAccountsConflictBlocked: number;
  telegramBotTradingAuthorizationsDropped: number;
  telegramBotTradingAuthorizationsMoved: number;
  telegramTradeIntentsMoved: number;
  telegramTradeIntentsPreservedWithSource: number;
  referralsReferredDeduped: number;
  referralsReferredMoved: number;
  referralsReferrerDeduped: number;
  referralsReferrerMoved: number;
  referralCodePoliciesDeleted: number;
  referralCodePoliciesMoved: number;
  referralCodesPolicyMoved: number;
  referralsSelfRemoved: number;
  walletsDeleted: number;
  primaryWalletAssigned: number;
  targetUserUpdated: number;
  sourceUserDeleted: number;
};

export type MergeResult = {
  summary: MergeSummary;
  dryRun: boolean;
};

type MergeDb = Pick<Pool, "connect" | "query">;

type TelegramAccountRow = {
  telegram_user_id: string;
};

async function fetchTelegramAccountForMerge(
  client: Pick<PoolClient, "query">,
  userId: string,
): Promise<TelegramAccountRow | null> {
  const { rows } = await client.query<TelegramAccountRow>(
    `
      select telegram_user_id
      from user_telegram_accounts
      where user_id = $1
      limit 1
    `,
    [userId],
  );
  return rows[0] ?? null;
}

export async function fetchUser(
  userId: string,
  db: Pick<Pool, "query"> = pool,
): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `
      select id,
             email,
             username,
             display_name,
             avatar_url,
             privy_user_id,
             referral_code,
             is_admin,
             kalshi_proof_bypass,
             last_login_at
      from users
      where id = $1
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0] ?? null;
}

export async function mergeUsersById(
  sourceId: string,
  targetId: string,
  options: MergeOptions,
  db: MergeDb = pool,
): Promise<MergeResult> {
  if (sourceId === targetId) {
    throw new Error("Source and target must be different users");
  }

  const source = await fetchUser(sourceId, db);
  const target = await fetchUser(targetId, db);

  if (!source) {
    throw new Error(`Source user not found (${sourceId})`);
  }
  if (!target) {
    throw new Error(`Target user not found (${targetId})`);
  }

  return mergeUsers(source, target, options, db);
}

export async function mergeUsers(
  source: UserRow,
  target: UserRow,
  options: MergeOptions,
  db: MergeDb = pool,
): Promise<MergeResult> {
  const client = await db.connect();
  const summary: MergeSummary = {
    walletsInserted: 0,
    venueCredsDeduped: 0,
    venueCredsMoved: 0,
    sessionsMoved: 0,
    watchlistDeduped: 0,
    watchlistMoved: 0,
    tradingPrefsDropped: 0,
    tradingPrefsMoved: 0,
    tradingStatsDropped: 0,
    tradingStatsMoved: 0,
    idempotencyDeduped: 0,
    idempotencyMoved: 0,
    executionsDeduped: 0,
    executionsMoved: 0,
    positionsDeduped: 0,
    positionsMoved: 0,
    feeEventsDeduped: 0,
    feeEventsMoved: 0,
    volumeEventsDeduped: 0,
    volumeEventsMoved: 0,
    rewardClaimsMoved: 0,
    ordersMoved: 0,
    orderLogsMoved: 0,
    bridgeOrdersMoved: 0,
    telegramAccountsMoved: 0,
    telegramAccountsConflictBlocked: 0,
    telegramBotTradingAuthorizationsDropped: 0,
    telegramBotTradingAuthorizationsMoved: 0,
    telegramTradeIntentsMoved: 0,
    telegramTradeIntentsPreservedWithSource: 0,
    referralsReferredDeduped: 0,
    referralsReferredMoved: 0,
    referralsReferrerDeduped: 0,
    referralsReferrerMoved: 0,
    referralCodePoliciesDeleted: 0,
    referralCodePoliciesMoved: 0,
    referralCodesPolicyMoved: 0,
    referralsSelfRemoved: 0,
    walletsDeleted: 0,
    primaryWalletAssigned: 0,
    targetUserUpdated: 0,
    sourceUserDeleted: 0,
  };

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-merge:${source.id}:${target.id}`,
    ]);

    summary.walletsInserted =
      (
        await client.query(
          `
          insert into user_wallets (
            user_id,
            wallet_address,
            wallet_type,
            name,
            is_primary,
            is_verified,
            verification_signature,
            created_at,
            updated_at
          )
          select
            $1,
            w.wallet_address,
            w.wallet_type,
            w.name,
            false,
            w.is_verified,
            w.verification_signature,
            w.created_at,
            w.updated_at
          from user_wallets w
          where w.user_id = $2
            and not exists (
              select 1
              from user_wallets t
              where t.user_id = $1
                and t.wallet_address = w.wallet_address
            )
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.venueCredsDeduped =
      (
        await client.query(
          `
          delete from user_venue_credentials s
          using user_venue_credentials t
          where s.user_id = $2
            and t.user_id = $1
            and s.wallet_address = t.wallet_address
            and s.venue = t.venue
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.venueCredsMoved =
      (
        await client.query(
          `update user_venue_credentials set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.sessionsMoved =
      (
        await client.query(
          `update user_sessions set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.watchlistDeduped =
      (
        await client.query(
          `
          delete from user_watchlist s
          using user_watchlist t
          where s.user_id = $2
            and t.user_id = $1
            and s.market_id = t.market_id
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.watchlistMoved =
      (
        await client.query(
          `update user_watchlist set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.tradingPrefsDropped =
      (
        await client.query(
          `
          delete from user_trading_preferences
          where user_id = $2
            and exists (select 1 from user_trading_preferences where user_id = $1)
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.tradingPrefsMoved =
      (
        await client.query(
          `update user_trading_preferences set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.tradingStatsDropped =
      (
        await client.query(
          `
          delete from user_trading_stats
          where user_id = $2
            and exists (select 1 from user_trading_stats where user_id = $1)
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.tradingStatsMoved =
      (
        await client.query(
          `update user_trading_stats set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.idempotencyDeduped =
      (
        await client.query(
          `
          delete from idempotency s
          using idempotency t
          where s.user_id = $2
            and t.user_id = $1
            and s.endpoint = t.endpoint
            and s.idempotency_key = t.idempotency_key
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.idempotencyMoved =
      (
        await client.query(
          `update idempotency set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.executionsDeduped =
      (
        await client.query(
          `
          delete from executions s
          using executions t
          where s.user_id = $2
            and t.user_id = $1
            and s.wallet_address is not distinct from t.wallet_address
            and s.venue = t.venue
            and s.tx_signature = t.tx_signature
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.executionsMoved =
      (
        await client.query(
          `update executions set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.positionsDeduped =
      (
        await client.query(
          `
          delete from positions s
          using positions t
          where s.user_id = $2
            and t.user_id = $1
            and s.wallet_address is not distinct from t.wallet_address
            and s.venue = t.venue
            and s.token_id is not distinct from t.token_id
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.positionsMoved =
      (
        await client.query(
          `update positions set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.feeEventsDeduped =
      (
        await client.query(
          `
          delete from fee_events s
          using fee_events t
          where s.user_id = $2
            and t.user_id = $1
            and s.source_type = t.source_type
            and s.source_id = t.source_id
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.feeEventsMoved =
      (
        await client.query(
          `update fee_events set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.volumeEventsDeduped =
      (
        await client.query(
          `
          delete from volume_events s
          using volume_events t
          where s.user_id = $2
            and t.user_id = $1
            and s.source_type = t.source_type
            and s.source_id = t.source_id
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.volumeEventsMoved =
      (
        await client.query(
          `update volume_events set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.rewardClaimsMoved =
      (
        await client.query(
          `update reward_claims set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.ordersMoved =
      (
        await client.query(
          `update orders set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.orderLogsMoved =
      (
        await client.query(
          `update order_logs set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.bridgeOrdersMoved =
      (
        await client.query(
          `update bridge_orders set user_id = $1 where user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    const sourceTelegramAccount = await fetchTelegramAccountForMerge(
      client,
      source.id,
    );
    const targetTelegramAccount = await fetchTelegramAccountForMerge(
      client,
      target.id,
    );
    if (
      sourceTelegramAccount &&
      targetTelegramAccount &&
      sourceTelegramAccount.telegram_user_id !==
        targetTelegramAccount.telegram_user_id
    ) {
      summary.telegramAccountsConflictBlocked = 1;
      throw new Error(
        "Cannot merge users with different linked Telegram accounts; unlink or resolve the Telegram account before merging",
      );
    }

    if (!options.keepSource) {
      await client.query(
        `INSERT INTO telegram_bot_trading_preferences (
           user_id,
           desired_enabled,
           decision_source,
           decision_version,
           manual_disabled_at,
           applied_policy_revision,
           retry_attempt_count,
           retry_after,
           last_setup_error_code,
           setup_blocked,
           created_at,
           updated_at
         )
         SELECT
           $1,
           desired_enabled,
           'admin_merge',
           decision_version + 1,
           manual_disabled_at,
           applied_policy_revision,
           0,
           NULL,
           NULL,
           false,
           created_at,
           now()
         FROM telegram_bot_trading_preferences
         WHERE user_id = $2
         ON CONFLICT (user_id) DO UPDATE SET
           desired_enabled = telegram_bot_trading_preferences.desired_enabled
             AND EXCLUDED.desired_enabled,
           decision_source = 'admin_merge',
           decision_version = greatest(
             telegram_bot_trading_preferences.decision_version,
             EXCLUDED.decision_version
           ) + 1,
           manual_disabled_at = CASE
             WHEN telegram_bot_trading_preferences.desired_enabled
               AND EXCLUDED.desired_enabled THEN NULL
             ELSE coalesce(
               telegram_bot_trading_preferences.manual_disabled_at,
               EXCLUDED.manual_disabled_at
             )
           END,
           applied_policy_revision = CASE
             WHEN telegram_bot_trading_preferences.applied_policy_revision
               = EXCLUDED.applied_policy_revision
             THEN EXCLUDED.applied_policy_revision
             ELSE NULL
           END,
           retry_attempt_count = 0,
           retry_after = NULL,
           last_setup_error_code = NULL,
           setup_blocked = false,
           claim_id = NULL,
           claim_telegram_account_id = NULL,
           claim_decision_version = NULL,
           claim_policy_revision = NULL,
           claim_expires_at = NULL,
           blocked_telegram_account_id = NULL,
           updated_at = now()`,
        [target.id, source.id],
      );
    }

    if (sourceTelegramAccount && !targetTelegramAccount) {
      if (options.keepSource) {
        summary.telegramAccountsConflictBlocked = 1;
      } else {
        summary.telegramAccountsMoved =
          (
            await client.query(
              `
              update user_telegram_accounts
              set user_id = $1,
                  updated_at = now()
              where user_id = $2
            `,
              [target.id, source.id],
            )
          ).rowCount ?? 0;

        summary.telegramBotTradingAuthorizationsMoved =
          (
            await client.query(
              `
              update telegram_bot_trading_authorizations
              set user_id = $1,
                  updated_at = now()
              where user_id = $2
            `,
              [target.id, source.id],
            )
          ).rowCount ?? 0;
      }
    }

    const preserveTelegramTradeIntentsWithSource =
      options.keepSource && sourceTelegramAccount && !targetTelegramAccount;
    if (preserveTelegramTradeIntentsWithSource) {
      const preserved = await client.query<{ count: string }>(
        `select count(*)::text as count from telegram_trade_intents where user_id = $1`,
        [source.id],
      );
      summary.telegramTradeIntentsPreservedWithSource = Number(
        preserved.rows[0]?.count ?? 0,
      );
    } else {
      summary.telegramTradeIntentsMoved =
        (
          await client.query(
            `update telegram_trade_intents set user_id = $1 where user_id = $2`,
            [target.id, source.id],
          )
        ).rowCount ?? 0;
    }

    summary.referralsReferredDeduped =
      (
        await client.query(
          `
          delete from referrals
          where referred_user_id = $2
            and exists (select 1 from referrals where referred_user_id = $1)
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.referralsReferredMoved =
      (
        await client.query(
          `update referrals set referred_user_id = $1 where referred_user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.referralCodesPolicyMoved =
      (
        await client.query(
          `
          with target_policy as (
            insert into referral_code_policies (policy_type, owner_user_id)
            values ('user', $1)
            on conflict do nothing
            returning id
          ),
          resolved_target_policy as (
            select id from target_policy
            union all
            select id
            from referral_code_policies
            where policy_type = 'user'
              and owner_user_id = $1
            limit 1
          ),
          source_policy as (
            select id
            from referral_code_policies
            where policy_type = 'user'
              and owner_user_id = $2
            limit 1
          )
          update referral_codes rc
          set policy_id = (select id from resolved_target_policy)
          where rc.policy_id = (select id from source_policy)
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.referralCodePoliciesDeleted =
      (
        await client.query(
          `
          delete from referral_code_policies
          where policy_type = 'user'
            and owner_user_id = $1
        `,
          [source.id],
        )
      ).rowCount ?? 0;

    summary.referralCodePoliciesMoved =
      (
        await client.query(
          `
          update referral_code_policies
          set owner_user_id = $1
          where policy_type = 'user'
            and owner_user_id = $2
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.referralsReferrerDeduped =
      (
        await client.query(
          `
          delete from referrals
          where referrer_user_id = $2
            and referred_user_id = $1
        `,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.referralsReferrerMoved =
      (
        await client.query(
          `update referrals set referrer_user_id = $1 where referrer_user_id = $2`,
          [target.id, source.id],
        )
      ).rowCount ?? 0;

    summary.referralsSelfRemoved =
      (
        await client.query(
          `delete from referrals where referrer_user_id = $1 and referred_user_id = $1`,
          [target.id],
        )
      ).rowCount ?? 0;

    summary.walletsDeleted =
      (
        await client.query(`delete from user_wallets where user_id = $1`, [
          source.id,
        ])
      ).rowCount ?? 0;

    summary.primaryWalletAssigned =
      (
        await client.query(
          `
          update user_wallets
          set is_primary = true
          where id = (
            select id
            from user_wallets
            where user_id = $1
            order by created_at asc
            limit 1
          )
          and not exists (
            select 1 from user_wallets where user_id = $1 and is_primary = true
          )
        `,
          [target.id],
        )
      ).rowCount ?? 0;

    if (!options.keepSource) {
      summary.sourceUserDeleted =
        (await client.query(`delete from users where id = $1`, [source.id]))
          .rowCount ?? 0;

      summary.targetUserUpdated =
        (
          await client.query(
            `
            update users
            set email = coalesce(email, $2),
                username = coalesce(username, $3),
                display_name = coalesce(display_name, $4),
                avatar_url = coalesce(avatar_url, $5),
                privy_user_id = coalesce(privy_user_id, $6),
                referral_code = coalesce(referral_code, $7),
                is_admin = is_admin or $8,
                kalshi_proof_bypass = kalshi_proof_bypass or $9,
                last_login_at = greatest(coalesce(last_login_at, $10), $10)
            where id = $1
          `,
            [
              target.id,
              source.email,
              source.username,
              source.display_name,
              source.avatar_url,
              source.privy_user_id,
              source.referral_code,
              source.is_admin ?? false,
              source.kalshi_proof_bypass ?? false,
              source.last_login_at,
            ],
          )
        ).rowCount ?? 0;
    } else {
      summary.targetUserUpdated =
        (
          await client.query(
            `
            update users
            set is_admin = is_admin or $2,
                kalshi_proof_bypass = kalshi_proof_bypass or $3,
                last_login_at = greatest(coalesce(last_login_at, $4), $4)
            where id = $1
          `,
            [
              target.id,
              source.is_admin ?? false,
              source.kalshi_proof_bypass ?? false,
              source.last_login_at,
            ],
          )
        ).rowCount ?? 0;
    }

    if (options.dryRun) {
      await client.query("rollback");
      return { summary, dryRun: true };
    }

    await client.query("commit");
    return { summary, dryRun: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
