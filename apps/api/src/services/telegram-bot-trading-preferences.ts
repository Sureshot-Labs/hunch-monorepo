import type { DbQuery } from "../db.js";
import {
  resolveSignalBotTradingPolicyStateFromDb,
  type SignalBotPolicy,
  type SignalBotTradingVenue,
} from "./signal-bot-trading-policy.js";

export const TELEGRAM_BOT_TRADING_CLAIM_LEASE_MINUTES = 10;
export const TELEGRAM_BOT_TRADING_CAPABILITIES: readonly SignalBotTradingVenue[] =
  ["polymarket"];

export type TelegramBotTradingDecisionSource =
  | "admin_merge"
  | "auto_link"
  | "legacy_enabled"
  | "legacy_preserved"
  | "manual_disable"
  | "manual_enable";

export type TelegramBotTradingPreference = {
  appliedPolicyRevision: string | null;
  blockedTelegramAccountId: string | null;
  claimDecisionVersion: number | null;
  claimExpiresAt: string | null;
  claimId: string | null;
  claimPolicyRevision: string | null;
  claimTelegramAccountId: string | null;
  decisionSource: TelegramBotTradingDecisionSource;
  decisionVersion: number;
  desiredEnabled: boolean;
  lastSetupErrorCode: string | null;
  manualDisabledAt: string | null;
  retryAfter: string | null;
  retryAttemptCount: number;
  setupBlocked: boolean;
  userId: string;
};

type PreferenceRow = {
  applied_policy_revision: string | null;
  blocked_telegram_account_id: string | null;
  claim_decision_version: string | number | null;
  claim_expires_at: Date | string | null;
  claim_id: string | null;
  claim_policy_revision: string | null;
  claim_telegram_account_id: string | null;
  decision_source: TelegramBotTradingDecisionSource;
  decision_version: string | number;
  desired_enabled: boolean;
  last_setup_error_code: string | null;
  manual_disabled_at: Date | string | null;
  retry_after: Date | string | null;
  retry_attempt_count: number;
  setup_blocked: boolean;
  user_id: string;
};

export type TelegramBotTradingManagedTarget = {
  maxAmountUsd: number;
  policyRevision: string;
  venues: SignalBotTradingVenue[];
};

export type TelegramBotTradingSetupClaim = {
  claimId: string;
  decisionVersion: number;
  expiresAt: string;
  target: TelegramBotTradingManagedTarget;
  telegramAccountId: string;
};

type TransactionalDb = DbQuery & {
  connect?: () => Promise<{
    query: DbQuery["query"];
    release: () => void;
  }>;
};

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return new Date(value).toISOString();
}

function mapPreference(row: PreferenceRow): TelegramBotTradingPreference {
  return {
    appliedPolicyRevision: row.applied_policy_revision,
    blockedTelegramAccountId: row.blocked_telegram_account_id,
    claimDecisionVersion:
      row.claim_decision_version == null
        ? null
        : Number(row.claim_decision_version),
    claimExpiresAt: iso(row.claim_expires_at),
    claimId: row.claim_id,
    claimPolicyRevision: row.claim_policy_revision,
    claimTelegramAccountId: row.claim_telegram_account_id,
    decisionSource: row.decision_source,
    decisionVersion: Number(row.decision_version),
    desiredEnabled: row.desired_enabled,
    lastSetupErrorCode: row.last_setup_error_code,
    manualDisabledAt: iso(row.manual_disabled_at),
    retryAfter: iso(row.retry_after),
    retryAttemptCount: row.retry_attempt_count,
    setupBlocked: row.setup_blocked,
    userId: row.user_id,
  };
}

async function withTransaction<T>(
  db: DbQuery,
  callback: (client: DbQuery) => Promise<T>,
): Promise<T> {
  const transactional = db as TransactionalDb;
  if (!transactional.connect) return callback(db);
  const client = await transactional.connect();
  try {
    await client.query("BEGIN");
    const result = await callback({ query: client.query.bind(client) });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function resolveTelegramBotTradingManagedTarget(input: {
  policy: SignalBotPolicy;
  policyRevision: string;
}): TelegramBotTradingManagedTarget {
  const capabilities = new Set<SignalBotTradingVenue>(
    TELEGRAM_BOT_TRADING_CAPABILITIES,
  );
  const runtimeVenues = new Set(input.policy.tradingVenues);
  return {
    maxAmountUsd: Math.min(
      input.policy.autoManagedMaxAmountUsd,
      input.policy.maxTradeAmountUsd,
    ),
    policyRevision: input.policyRevision,
    venues: input.policy.autoManagedVenues.filter(
      (venue) => capabilities.has(venue) && runtimeVenues.has(venue),
    ),
  };
}

export function resolveTelegramBotTradingEffectiveMaxAmountUsd(input: {
  authorizationMaxAmountUsd?: string | number | null;
  policy: SignalBotPolicy;
  signerPolicyMaxAmountUsd: number;
}): number {
  const authorizationMax =
    typeof input.authorizationMaxAmountUsd === "number"
      ? input.authorizationMaxAmountUsd
      : typeof input.authorizationMaxAmountUsd === "string"
        ? Number(input.authorizationMaxAmountUsd)
        : null;
  const runtimeManagedMax = Math.min(
    input.policy.maxTradeAmountUsd,
    input.policy.autoManagedMaxAmountUsd,
  );
  return Math.min(
    runtimeManagedMax,
    Number.isFinite(authorizationMax) && authorizationMax != null
      ? authorizationMax
      : runtimeManagedMax,
    Number.isFinite(input.signerPolicyMaxAmountUsd) &&
      input.signerPolicyMaxAmountUsd > 0
      ? input.signerPolicyMaxAmountUsd
      : runtimeManagedMax,
  );
}

export async function ensureTelegramBotTradingPreferenceForLink(
  db: DbQuery,
  input: { isNewLink: boolean; userId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO telegram_bot_trading_preferences (
       user_id,
       desired_enabled,
       decision_source,
       decision_version,
       manual_disabled_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, 1, NULL, now(), now())
     ON CONFLICT (user_id) DO NOTHING`,
    [
      input.userId,
      input.isNewLink,
      input.isNewLink ? "auto_link" : "legacy_preserved",
    ],
  );
}

export async function loadTelegramBotTradingPreference(
  db: DbQuery,
  userId: string,
): Promise<TelegramBotTradingPreference | null> {
  const result = await db.query<PreferenceRow>(
    `SELECT *
       FROM telegram_bot_trading_preferences
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? mapPreference(result.rows[0]) : null;
}

export async function setTelegramBotTradingDesiredEnabled(
  db: DbQuery,
  input: {
    desiredEnabled: boolean;
    source: "manual_disable" | "manual_enable";
    userId: string;
  },
): Promise<TelegramBotTradingPreference> {
  const result = await db.query<PreferenceRow>(
    `INSERT INTO telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source, decision_version,
       manual_disabled_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, 1, CASE WHEN $2 THEN NULL ELSE now() END, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       desired_enabled = EXCLUDED.desired_enabled,
       decision_source = CASE
         WHEN telegram_bot_trading_preferences.desired_enabled IS DISTINCT FROM EXCLUDED.desired_enabled
           OR (
             EXCLUDED.decision_source = 'manual_disable'
             AND telegram_bot_trading_preferences.decision_source <> 'manual_disable'
           )
           THEN EXCLUDED.decision_source
         ELSE telegram_bot_trading_preferences.decision_source
       END,
       decision_version = CASE
         WHEN telegram_bot_trading_preferences.desired_enabled IS DISTINCT FROM EXCLUDED.desired_enabled
           OR (
             EXCLUDED.decision_source = 'manual_disable'
             AND telegram_bot_trading_preferences.decision_source <> 'manual_disable'
           )
           THEN telegram_bot_trading_preferences.decision_version + 1
         ELSE telegram_bot_trading_preferences.decision_version
       END,
       manual_disabled_at = CASE
         WHEN EXCLUDED.desired_enabled THEN NULL
         ELSE coalesce(telegram_bot_trading_preferences.manual_disabled_at, now())
       END,
       claim_id = NULL,
       claim_telegram_account_id = NULL,
       claim_decision_version = NULL,
       claim_policy_revision = NULL,
       claim_expires_at = NULL,
       retry_attempt_count = CASE WHEN EXCLUDED.desired_enabled THEN 0 ELSE telegram_bot_trading_preferences.retry_attempt_count END,
       retry_after = NULL,
       last_setup_error_code = NULL,
       setup_blocked = false,
       updated_at = now()
     RETURNING *`,
    [input.userId, input.desiredEnabled, input.source],
  );
  const row = result.rows[0];
  if (!row) {
    // Lightweight unit DB doubles may not model INSERT ... RETURNING. A real
    // PostgreSQL execution either returns this row or throws.
    return {
      appliedPolicyRevision: null,
      blockedTelegramAccountId: null,
      claimDecisionVersion: null,
      claimExpiresAt: null,
      claimId: null,
      claimPolicyRevision: null,
      claimTelegramAccountId: null,
      decisionSource: input.source,
      decisionVersion: 1,
      desiredEnabled: input.desiredEnabled,
      lastSetupErrorCode: null,
      manualDisabledAt: input.desiredEnabled ? null : new Date().toISOString(),
      retryAfter: null,
      retryAttemptCount: 0,
      setupBlocked: false,
      userId: input.userId,
    };
  }
  return mapPreference(row);
}

export async function claimTelegramBotTradingAutoSetup(
  db: DbQuery,
  input: { claimId: string; userId: string },
): Promise<TelegramBotTradingSetupClaim> {
  return withTransaction(db, async (client) => {
    const policyState = await resolveSignalBotTradingPolicyStateFromDb(client);
    const target = resolveTelegramBotTradingManagedTarget(policyState);
    const result = await client.query<
      PreferenceRow & { telegram_account_id: string | null }
    >(
      `SELECT p.*, uta.id AS telegram_account_id
         FROM telegram_bot_trading_preferences p
         LEFT JOIN user_telegram_accounts uta ON uta.user_id = p.user_id
        WHERE p.user_id = $1
        FOR UPDATE OF p`,
      [input.userId],
    );
    const row = result.rows[0];
    if (!row?.desired_enabled)
      throw new Error("telegram_bot_trading_opted_out");
    if (!row.telegram_account_id) throw new Error("telegram_account_required");
    if (row.blocked_telegram_account_id === row.telegram_account_id) {
      throw new Error("telegram_link_generation_blocked");
    }
    if (
      !policyState.policy.tradingEnabled ||
      !policyState.policy.autoEnableOnTelegramLink
    ) {
      throw new Error("telegram_bot_trading_auto_setup_disabled");
    }
    const unsupportedManagedVenue = policyState.policy.autoManagedVenues.find(
      (venue) => !TELEGRAM_BOT_TRADING_CAPABILITIES.includes(venue),
    );
    if (unsupportedManagedVenue) {
      throw new Error(`unsupported_managed_venue:${unsupportedManagedVenue}`);
    }
    if (target.venues.length === 0)
      throw new Error("no_managed_venues_available");
    const retryAfter = row.retry_after ? new Date(row.retry_after) : null;
    if (retryAfter && retryAfter.getTime() > Date.now()) {
      throw new Error("telegram_bot_trading_retry_wait");
    }
    const claimExpiresAt = row.claim_expires_at
      ? new Date(row.claim_expires_at)
      : null;
    if (
      row.claim_id === input.claimId &&
      (row.claim_telegram_account_id !== row.telegram_account_id ||
        Number(row.claim_decision_version) !== Number(row.decision_version) ||
        row.claim_policy_revision !== target.policyRevision)
    ) {
      throw new Error("telegram_bot_trading_claim_stale");
    }
    if (
      row.claim_id &&
      row.claim_id !== input.claimId &&
      claimExpiresAt &&
      claimExpiresAt.getTime() > Date.now()
    ) {
      throw new Error("telegram_bot_trading_claim_held");
    }
    const updated = await client.query<PreferenceRow>(
      `UPDATE telegram_bot_trading_preferences
          SET claim_id = $2::uuid,
              claim_telegram_account_id = $3::uuid,
              claim_decision_version = decision_version,
              claim_policy_revision = $4,
              claim_expires_at = now() + ($5::int * interval '1 minute'),
              last_setup_error_code = NULL,
              setup_blocked = false,
              updated_at = now()
        WHERE user_id = $1
      RETURNING *`,
      [
        input.userId,
        input.claimId,
        row.telegram_account_id,
        target.policyRevision,
        TELEGRAM_BOT_TRADING_CLAIM_LEASE_MINUTES,
      ],
    );
    const preference = updated.rows[0];
    if (!preference?.claim_expires_at) {
      throw new Error("telegram_bot_trading_claim_failed");
    }
    return {
      claimId: input.claimId,
      decisionVersion: Number(preference.decision_version),
      expiresAt: new Date(preference.claim_expires_at).toISOString(),
      target,
      telegramAccountId: row.telegram_account_id,
    };
  });
}

export async function assertTelegramBotTradingSetupClaim(
  db: DbQuery,
  input: { claimId: string; policyRevision: string; userId: string },
): Promise<void> {
  const result = await db.query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM telegram_bot_trading_preferences p
       JOIN user_telegram_accounts uta
         ON uta.user_id = p.user_id
        AND uta.id = p.claim_telegram_account_id
      WHERE p.user_id = $1
        AND p.desired_enabled = true
        AND p.claim_id = $2::uuid
        AND p.claim_decision_version = p.decision_version
        AND p.claim_policy_revision = $3
        AND p.claim_expires_at > now()
        AND p.blocked_telegram_account_id IS DISTINCT FROM uta.id
      FOR UPDATE OF p, uta`,
    [input.userId, input.claimId, input.policyRevision],
  );
  if (!result.rows[0]?.ok) throw new Error("telegram_bot_trading_claim_stale");
}

export async function completeTelegramBotTradingSetupClaim(
  db: DbQuery,
  input: { claimId: string; policyRevision: string; userId: string },
): Promise<void> {
  const result = await db.query(
    `UPDATE telegram_bot_trading_preferences
        SET applied_policy_revision = $3,
            retry_attempt_count = 0,
            retry_after = NULL,
            last_setup_error_code = NULL,
            setup_blocked = false,
            claim_id = NULL,
            claim_telegram_account_id = NULL,
            claim_decision_version = NULL,
            claim_policy_revision = NULL,
            claim_expires_at = NULL,
            updated_at = now()
      WHERE user_id = $1
        AND desired_enabled = true
        AND claim_id = $2::uuid
        AND claim_policy_revision = $3`,
    [input.userId, input.claimId, input.policyRevision],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("telegram_bot_trading_claim_stale");
  }
}

export async function failTelegramBotTradingSetupClaim(
  db: DbQuery,
  input: {
    blocked: boolean;
    claimId: string;
    errorCode: string;
    userId: string;
  },
): Promise<void> {
  const result = await db.query(
    `UPDATE telegram_bot_trading_preferences
        SET retry_attempt_count = retry_attempt_count + 1,
            retry_after = CASE
              WHEN $4::boolean THEN NULL
              ELSE now() + (
                least(60, power(2, least(retry_attempt_count, 6)))::int
                * interval '1 minute'
              )
            END,
            last_setup_error_code = $3,
            setup_blocked = $4,
            claim_id = NULL,
            claim_telegram_account_id = NULL,
            claim_decision_version = NULL,
            claim_policy_revision = NULL,
            claim_expires_at = NULL,
            updated_at = now()
      WHERE user_id = $1
        AND claim_id = $2::uuid
        AND desired_enabled = true`,
    [input.userId, input.claimId, input.errorCode.slice(0, 128), input.blocked],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("telegram_bot_trading_claim_stale");
  }
}

export async function blockTelegramBotTradingLinkGeneration(
  db: DbQuery,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE telegram_bot_trading_preferences p
        SET blocked_telegram_account_id = uta.id,
            claim_id = NULL,
            claim_telegram_account_id = NULL,
            claim_decision_version = NULL,
            claim_policy_revision = NULL,
            claim_expires_at = NULL,
            last_setup_error_code = 'telegram_unlinked',
            setup_blocked = false,
            updated_at = now()
       FROM user_telegram_accounts uta
      WHERE p.user_id = $1
        AND uta.user_id = p.user_id`,
    [userId],
  );
}
