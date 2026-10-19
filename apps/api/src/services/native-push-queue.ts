import { randomUUID } from "node:crypto";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  classifyAPNsResult,
  type APNsSend,
  type APNsEnvironment,
} from "./apns-client.js";
import { POSITION_TOKEN_MARKET_JOIN_SQL } from "../lib/pnl-sql.js";

export type NativePushTopic =
  | "market_resolution"
  | "followed_hunches"
  | "new_markets"
  | "big_moves";
export type NativePushContent = {
  title: string;
  body: string;
  target?: {
    eventId?: string | null;
    marketId?: string | null;
    authorId?: string;
    thesisId?: string;
    destination?: "discovery";
  };
};

const topicPreference = `case $4
  when 'market_resolution' then p.market_resolution
  when 'followed_hunches' then p.followed_hunches
  when 'new_markets' then p.new_markets when 'big_moves' then p.big_moves else false end`;
const topicEnabledAt = `case $4
  when 'market_resolution' then p.market_resolution_enabled_at
  when 'followed_hunches' then p.followed_hunches_enabled_at
  when 'new_markets' then p.new_markets_enabled_at when 'big_moves' then p.big_moves_enabled_at end`;

type NativePushInput = {
  userIds: string[];
  eventKey: string;
  topic: NativePushTopic;
  occurredAt: Date;
  content: NativePushContent;
};

/** Acquire every recipient before touching devices, cooldowns or delivery FKs.
 * Account lifecycle also takes ordered user locks first. NO KEY UPDATE still
 * serializes those writers while permitting lifecycle's third-party FK checks.
 * Call within a transaction. */
export async function lockNativePushRecipients(db: DbQuery, userIds: string[]) {
  return db.query<{ id: string }>(
    `select id from users where id=any($1::uuid[]) order by id for no key update`,
    [userIds],
  );
}

/** Pool entry point for callers without an existing source transaction. */
export async function enqueueNativePush(db: Pool, input: NativePushInput) {
  if (input.userIds.length === 0) return 0;
  return tx(db, (client) => enqueueNativePushInTransaction(client, input));
}

/** Source cursor, recipient locks and queue insertion commit together. */
export async function enqueueNativePushInTransaction(
  db: PoolClient,
  input: NativePushInput,
) {
  if (input.userIds.length === 0) return 0;
  await lockNativePushRecipients(db, input.userIds);
  const payload = {
    aps: {
      alert: {
        title: [...input.content.title].slice(0, 100).join(""),
        body: [...input.content.body].slice(0, 240).join(""),
      },
      sound: "default",
    },
    hunch: input.content.target ?? {},
  };
  const result = await db.query(
    `with devices as materialized (
    select d.* from native_push_devices d join native_notification_preferences p on p.user_id=d.user_id
    join users u on u.id=d.user_id join user_sessions s on s.id=d.session_id and s.user_id=d.user_id
    where d.user_id=any($1::uuid[]) and d.active and d.authorization_status in ('authorized','provisional','ephemeral')
      and u.is_active and u.social_suspended_at is null and s.is_active and s.expires_at>clock_timestamp()
      and p.enabled and ${topicPreference} and $3::timestamptz>=greatest(p.enabled_at,${topicEnabledAt})
    order by d.id for key share of d
    ) insert into native_push_deliveries(device_id,user_id,device_generation,event_key,topic,occurred_at,payload)
    select d.id,d.user_id,d.generation,$2,$4,$3,
      jsonb_set($5::jsonb,'{hunch}',coalesce($5::jsonb->'hunch','{}'::jsonb)||jsonb_build_object('userId',d.user_id))
    from devices d on conflict(device_id,event_key) do nothing`,
    [
      input.userIds,
      input.eventKey,
      input.occurredAt,
      input.topic,
      JSON.stringify(payload),
    ],
  );
  return result.rowCount ?? 0;
}

type Delivery = {
  id: string;
  device_id: string;
  user_id: string;
  device_generation: string;
  event_key: string;
  topic: NativePushTopic;
  occurred_at: Date;
  payload: Record<string, unknown>;
  attempts: number;
  lease_id: string;
};

export async function deliverNativePushBatch(input: {
  db: Pool;
  send: APNsSend;
  batchSize?: number;
}) {
  const leaseID = randomUUID();
  const { rows } = await input.db.query<Delivery>(
    `with selected as (
    select id from native_push_deliveries where status in ('pending','sending')
      and available_at<=now() and (lease_until is null or lease_until<now())
    order by available_at,id limit $1 for update skip locked
  ) update native_push_deliveries d set status='sending',lease_id=$2,
    lease_until=now()+interval '60 seconds',available_at=now()+interval '60 seconds',attempts=d.attempts+1
    from selected where d.id=selected.id returning d.*`,
    [Math.min(20, input.batchSize ?? 10), leaseID],
  );
  const counts = { sent: 0, skipped: 0, retry: 0, failed: 0 };
  // Send concurrently so the entire bounded batch fits within its lease.
  await Promise.all(
    rows.map(async (delivery) => {
      const { rows: devices } = await input.db.query<{
        token: string;
        environment: APNsEnvironment;
        updated_at: Date;
        registration_id: string;
      }>(
        `select d.token,d.environment,d.updated_at,d.registration_id
      from native_push_devices d join native_notification_preferences p on p.user_id=d.user_id
      join users u on u.id=d.user_id join user_sessions s on s.id=d.session_id and s.user_id=d.user_id
      where d.id=$1 and d.user_id=$2 and d.generation=$3 and d.active
        and d.authorization_status in ('authorized','provisional','ephemeral') and s.is_active and s.expires_at>now()
        and u.is_active and u.social_suspended_at is null and p.enabled and ${topicPreference}
        and $5::timestamptz>=greatest(p.enabled_at,${topicEnabledAt})
        and ($4<>'followed_hunches' or exists(
          select 1 from user_theses t join users author on author.id=t.author_id
          join user_follows f on f.followed_user_id=t.author_id and f.follower_user_id=d.user_id
          where t.id=($6::jsonb->'hunch'->>'thesisId')::uuid and author.is_active
            and t.author_id=($6::jsonb->'hunch'->>'authorId')::uuid and f.created_at<=$5
            and author.social_suspended_at is null and t.author_hidden_at is null
            and t.moderation_hidden_at is null and t.proof_invalidated_at is null
            and not exists(select 1 from user_blocks b where
              (b.blocker_user_id=d.user_id and b.blocked_user_id=t.author_id)
              or (b.blocker_user_id=t.author_id and b.blocked_user_id=d.user_id))))
        and ($4<>'big_moves' or exists(select 1 from positions p ${POSITION_TOKEN_MARKET_JOIN_SQL}
          join unified_markets held_market on held_market.id=umt.market_id and held_market.status='ACTIVE'
            and (held_market.close_time is null or held_market.close_time>now())
            and (held_market.expiration_time is null or held_market.expiration_time>now())
          where p.user_id=d.user_id and p.position_scope='own' and p.size>0 and coalesce(p.is_hidden,false)=false
            and umt.market_id=$6::jsonb->'hunch'->>'marketId'))`,
        [
          delivery.device_id,
          delivery.user_id,
          delivery.device_generation,
          delivery.topic,
          delivery.occurred_at,
          JSON.stringify(delivery.payload),
        ],
      );
      const device = devices[0];
      const expired =
        Date.now() - new Date(delivery.occurred_at).getTime() > 86_400_000;
      if (!device || expired) {
        await finish(
          input.db,
          delivery,
          "skipped",
          expired ? "expired" : "subscription_changed",
        );
        counts.skipped++;
        return;
      }
      let result;
      try {
        result = await input.send({
          token: device.token,
          environment: device.environment,
          id: delivery.id,
          payload: delivery.payload,
          expiresAt:
            Math.floor(new Date(delivery.occurred_at).getTime() / 1000) +
            86_400,
        });
      } catch {
        result = {
          status: 0,
          reason: "transport_unavailable",
          invalidatedAt: null,
        };
      }
      const outcome = classifyAPNsResult(result);
      // APNs reasons are a small machine vocabulary; never retain arbitrary remote text.
      const code =
        result.reason && /^[A-Za-z_]{1,80}$/.test(result.reason)
          ? result.reason
          : `apns_${result.status}`;
      if (outcome === "invalid_device") {
        await tx(input.db, async (db) => {
          await db.query(
            `update native_push_devices set active=false,generation=generation+1 where id=$1 and generation=$2 and registration_id=$4
          and ($3::bigint is null or updated_at<=to_timestamp($3::double precision/1000))`,
            [
              delivery.device_id,
              delivery.device_generation,
              result.invalidatedAt,
              device.registration_id,
            ],
          );
          await finish(db, delivery, "failed", code);
        });
        counts.failed++;
      } else if (outcome === "retry" && delivery.attempts < 12) {
        const seconds = Math.min(
          3_600,
          15 * 2 ** Math.min(delivery.attempts - 1, 8),
        );
        await input.db.query(
          `update native_push_deliveries set status='pending',available_at=now()+($3*interval '1 second'),
        lease_id=null,lease_until=null,error_code=$4 where id=$1 and lease_id=$2 and status='sending'`,
          [delivery.id, delivery.lease_id, seconds, code],
        );
        counts.retry++;
      } else {
        const status = outcome === "sent" ? "sent" : "failed";
        await finish(
          input.db,
          delivery,
          status,
          outcome === "sent" ? null : code,
        );
        counts[status]++;
      }
    }),
  );
  return counts;
}

async function finish(
  db: DbQuery,
  delivery: Delivery,
  status: "sent" | "skipped" | "failed",
  error: string | null,
) {
  await db.query(
    `update native_push_deliveries set status=$3,error_code=$4,finished_at=now(),lease_id=null,lease_until=null
    where id=$1 and lease_id=$2 and status='sending'`,
    [delivery.id, delivery.lease_id, status, error],
  );
}
