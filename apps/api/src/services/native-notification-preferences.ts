import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import type {
  NativeDeviceInput,
  NativePreferences,
  NativePreferencesInput,
} from "../schemas/native-notifications.js";
import { SocialError } from "./social-primitives.js";

export class NativeNotificationError extends SocialError {
  constructor(
    code: string,
    status: number,
    readonly preferences?: NativePreferences,
  ) {
    super(code, status);
  }
}

type PreferencesRow = {
  revision: string;
  enabled: boolean;
  market_resolution: boolean;
  followed_hunches: boolean;
  new_markets: boolean;
  big_moves: boolean;
};

export function nativePreferences(row?: PreferencesRow): NativePreferences {
  return {
    version: 1,
    revision: row ? Number(row.revision) : 0,
    enabled: row?.enabled ?? true,
    marketResolution: row?.market_resolution ?? true,
    followedHunches: row?.followed_hunches ?? true,
    newMarkets: row?.new_markets ?? true,
    bigMoves: row?.big_moves ?? false,
  };
}

export async function readNativePreferences(db: DbQuery, userId: string) {
  const { rows } = await db.query<PreferencesRow>(
    `select revision,enabled,market_resolution,followed_hunches,new_markets,big_moves
      from native_notification_preferences where user_id=$1`,
    [userId],
  );
  return nativePreferences(rows[0]);
}

async function lockDeviceSession(
  db: DbQuery,
  userId: string,
  sessionId: string,
) {
  // Match account deletion's lock order. FOR SHARE also fences concurrent logout:
  // either registration commits first, or the revoked session is rejected here.
  const active = await db.query(
    `select id from users where id=$1 and is_active for update`,
    [userId],
  );
  if (!active.rows.length)
    throw new NativeNotificationError("user_unavailable", 403);
  const session = await db.query(
    `select id from user_sessions where id=$1 and user_id=$2 and is_active and expires_at>clock_timestamp() for share`,
    [sessionId, userId],
  );
  if (!session.rows.length)
    throw new NativeNotificationError("unauthorized", 401);
}

async function checkDeviceSessionDeadline(
  db: DbQuery,
  userId: string,
  sessionId: string,
) {
  // now() is fixed at BEGIN. A token/device lock may outlast that session's TTL.
  // The session row remains locked against logout until commit; recheck wall time
  // after all potentially waiting writes and roll them back if the TTL elapsed.
  const session = await db.query(
    `select id from user_sessions where id=$1 and user_id=$2 and is_active and expires_at>clock_timestamp()`,
    [sessionId, userId],
  );
  if (!session.rows.length)
    throw new NativeNotificationError("unauthorized", 401);
}

export class NativeNotificationPreferencesService {
  constructor(private readonly db: Pool) {}

  async save(userId: string, input: NativePreferencesInput) {
    return tx(this.db, async (db) => {
      // Share the account lock order used by profile writes, merge and deletion.
      const active = await db.query(
        `select id from users where id=$1 and is_active for update`,
        [userId],
      );
      if (!active.rows.length)
        throw new NativeNotificationError("user_unavailable", 403);
      const current = await readNativePreferences(db, userId);
      const desired = {
        enabled: input.enabled,
        marketResolution: input.marketResolution,
        followedHunches: input.followedHunches,
        newMarkets: input.newMarkets,
        bigMoves: input.bigMoves,
      };
      if (
        current.revision > 0 &&
        Object.entries(desired).every(
          ([key, value]) => current[key as keyof NativePreferences] === value,
        )
      )
        return current;
      if (current.revision !== input.expectedRevision)
        throw new NativeNotificationError(
          "notification_preferences_conflict",
          409,
          current,
        );
      if (current.revision === Number.MAX_SAFE_INTEGER)
        throw new NativeNotificationError(
          "notification_revision_exhausted",
          409,
          current,
        );
      const { rows } = await db.query<PreferencesRow>(
        `insert into native_notification_preferences(user_id,revision,enabled,market_resolution,followed_hunches,new_markets,big_moves)
        values($1,1,$2,$3,$4,$5,$6) on conflict(user_id) do update set
        revision=native_notification_preferences.revision+1,enabled=excluded.enabled,
        market_resolution=excluded.market_resolution,followed_hunches=excluded.followed_hunches,
        new_markets=excluded.new_markets,big_moves=excluded.big_moves,
        enabled_at=case when not native_notification_preferences.enabled and excluded.enabled then now() else native_notification_preferences.enabled_at end,
        market_resolution_enabled_at=case when not native_notification_preferences.market_resolution and excluded.market_resolution then now() else native_notification_preferences.market_resolution_enabled_at end,
        followed_hunches_enabled_at=case when not native_notification_preferences.followed_hunches and excluded.followed_hunches then now() else native_notification_preferences.followed_hunches_enabled_at end,
        new_markets_enabled_at=case when not native_notification_preferences.new_markets and excluded.new_markets then now() else native_notification_preferences.new_markets_enabled_at end,
        big_moves_enabled_at=case when not native_notification_preferences.big_moves and excluded.big_moves then now() else native_notification_preferences.big_moves_enabled_at end,
        updated_at=now() returning revision,enabled,market_resolution,followed_hunches,new_markets,big_moves`,
        [
          userId,
          input.enabled,
          input.marketResolution,
          input.followedHunches,
          input.newMarkets,
          input.bigMoves,
        ],
      );
      return nativePreferences(rows[0]);
    });
  }

  async register(
    userId: string,
    sessionId: string,
    id: string,
    input: NativeDeviceInput,
  ) {
    await tx(this.db, async (db) => {
      await lockDeviceSession(db, userId, sessionId);
      // Serialize the rare cross-account reassignment of the same APNs token.
      await db.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `native-push:${input.environment}:${input.token}`,
      ]);
      await db.query(
        `delete from native_push_devices where environment=$1 and token=$2 and id<>$3`,
        [input.environment, input.token, id],
      );
      await db.query(
        `insert into native_push_devices(id,user_id,session_id,token,environment,authorization_status)
        values($1,$2,$3,$4,$5,$6) on conflict(id) do update set
        user_id=excluded.user_id,session_id=excluded.session_id,token=excluded.token,
        environment=excluded.environment,authorization_status=excluded.authorization_status,active=true,
        generation=case when (native_push_devices.user_id,native_push_devices.session_id,native_push_devices.token,native_push_devices.environment,native_push_devices.authorization_status,native_push_devices.active)
          is distinct from (excluded.user_id,excluded.session_id,excluded.token,excluded.environment,excluded.authorization_status,true)
          then native_push_devices.generation+1 else native_push_devices.generation end,
        registration_id=gen_random_uuid(),updated_at=now()`,
        [
          id,
          userId,
          sessionId,
          input.token,
          input.environment,
          input.authorization,
        ],
      );
      await checkDeviceSessionDeadline(db, userId, sessionId);
    });
  }

  async unregister(userId: string, sessionId: string, id: string) {
    await tx(this.db, async (db) => {
      await lockDeviceSession(db, userId, sessionId);
      await db.query(
        `update native_push_devices set active=false,generation=generation+1,registration_id=gen_random_uuid(),updated_at=now()
        where id=$1 and user_id=$2 and session_id=$3 and active`,
        [id, userId, sessionId],
      );
      await checkDeviceSessionDeadline(db, userId, sessionId);
    });
  }
}
