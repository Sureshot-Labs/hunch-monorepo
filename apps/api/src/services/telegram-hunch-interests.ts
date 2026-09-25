import { randomUUID } from "node:crypto";
import {
  acquireEmbeddingGenerationPin,
  embeddingCachePrefix,
  embeddingIndex,
  embeddingKey,
  parseEmbeddingVector,
  readActiveGeneration,
} from "@hunch/embeddings";
import { createRedisClient, type Pool, type PoolClient } from "@hunch/infra";
import { RESP_TYPES } from "redis";
import { loadSignalBotNotes } from "./signal-bot.js";

const EXACT_CURSOR_KEY = "telegram_interest_exact_v1";
const SEMANTIC_CURSOR_KEY = "telegram_interest_semantic_v1";
const WORKER_LOCK_KEY = "telegram_interest_worker_v1";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_RELATED_EVENTS = 8;
const SEMANTIC_REPAIR_WINDOW_MS = 24 * 60 * 60_000;
// Read-only Qwen samples on live events showed direct topical neighbors below
// 0.25 and unrelated sanction/event neighbors above it. This is a conservative
// alert threshold, not a generic search cutoff.
const MAX_NEIGHBOR_DISTANCE = 0.25;

type RedisClient = NonNullable<ReturnType<typeof createRedisClient>>;
type SignalNote = Awaited<ReturnType<typeof loadSignalBotNotes>>[number];
type Cursor = { cursor_created_at: string; cursor_id: string };

export function parseRelatedHunchEventIds(
  raw: unknown[],
  prefix: string,
  eventId: string,
): string[] {
  const ids: string[] = [];
  for (let i = 1; i < raw.length && ids.length < MAX_RELATED_EVENTS; i += 2) {
    const key = String(raw[i] ?? "");
    const fields = raw[i + 1];
    if (!key.startsWith(prefix) || !Array.isArray(fields)) continue;
    const scorePosition = fields.findIndex((item) => String(item) === "score");
    const distance = Number(fields[scorePosition + 1]);
    if (
      scorePosition < 0 ||
      !Number.isFinite(distance) ||
      distance < 0 ||
      distance > MAX_NEIGHBOR_DISTANCE
    )
      continue;
    const id = key.slice(prefix.length);
    if (id && id !== eventId && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function relatedHunchEventIds(
  redis: RedisClient | null,
  eventId: string,
): Promise<string[] | null> {
  if (!redis) throw new Error("redis_unavailable");
  const generation = await readActiveGeneration(redis);
  const pin = await acquireEmbeddingGenerationPin(
    redis,
    generation,
    `telegram-hunch-interest:${eventId}:${randomUUID()}`,
  );
  if (!pin) throw new Error("embedding_generation_unavailable");
  try {
    const bufferClient = redis.withTypeMapping({
      [RESP_TYPES.BLOB_STRING]: Buffer,
    });
    pin.assertHeld();
    const [embedding, textHash] = await bufferClient.hmGet(
      embeddingKey(generation, "event", eventId),
      ["embedding", "text_hash"],
    );
    // A fresh note can precede its event vector. The caller retries briefly;
    // exact-market/event delivery remains independent of that retry.
    if (
      !Buffer.isBuffer(embedding) ||
      !parseEmbeddingVector(embedding, generation)
    ) {
      return null;
    }
    const cacheKey = `${embeddingCachePrefix(generation)}:telegram-interest:v2:${eventId}:${String(textHash ?? "")}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((id): id is string => typeof id === "string")
            .slice(0, MAX_RELATED_EVENTS);
        }
      } catch {
        // Recompute a malformed derived cache.
      }
    }
    pin.assertHeld();
    const raw = (await redis.sendCommand([
      "FT.SEARCH",
      embeddingIndex(generation, "event"),
      "(@status:{ACTIVE})=>[KNN 21 @embedding $vec AS score]",
      "PARAMS",
      "2",
      "vec",
      embedding,
      "SORTBY",
      "score",
      "RETURN",
      "1",
      "score",
      "LIMIT",
      "0",
      "21",
      "DIALECT",
      "2",
    ])) as unknown[];
    pin.assertHeld();
    const ids = parseRelatedHunchEventIds(
      raw,
      embeddingKey(generation, "event", ""),
      eventId,
    );
    await redis.set(cacheKey, JSON.stringify(ids), { EX: 300 });
    return ids;
  } finally {
    await pin.release();
  }
}

async function initializeCursors(client: PoolClient): Promise<void> {
  await client.query(
    `insert into telegram_notification_cursors
       (consumer_key, cursor_created_at, cursor_id)
     values ($1, now(), $3::uuid), ($2, now(), $3::uuid)
     on conflict (consumer_key) do nothing`,
    [EXACT_CURSOR_KEY, SEMANTIC_CURSOR_KEY, ZERO_UUID],
  );
}

async function readCursor(client: PoolClient, key: string): Promise<Cursor> {
  const { rows } = await client.query<Cursor>(
    `select cursor_created_at::text as cursor_created_at, cursor_id
     from telegram_notification_cursors where consumer_key = $1`,
    [key],
  );
  if (!rows[0]) throw new Error(`Interest Hunch cursor unavailable: ${key}`);
  return rows[0];
}

async function advanceCursor(
  client: PoolClient,
  key: string,
  note: SignalNote,
): Promise<void> {
  await client.query(
    `update telegram_notification_cursors
     set cursor_created_at = $2::timestamptz,
         cursor_id = $3::uuid, updated_at = now()
     where consumer_key = $1`,
    [key, note.createdAt, note.id],
  );
}

async function deferSemanticNote(
  client: PoolClient,
  noteId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `insert into telegram_interest_semantic_repair
       (note_id, attempts, next_attempt_at, last_error)
     values ($1::uuid, 1, now() + interval '5 minutes', $2)
     on conflict (note_id) do update
     set attempts = telegram_interest_semantic_repair.attempts + 1,
         next_attempt_at = now() + interval '5 minutes',
         last_error = excluded.last_error`,
    [noteId, reason.slice(0, 120)],
  );
}

async function insertInterestRecipients(
  client: PoolClient,
  note: SignalNote,
  eventIds: string[],
): Promise<number> {
  if (!note.marketId || !note.eventId || eventIds.length === 0) return 0;
  const { rows } = await client.query<{ inserted_count: string }>(
    `with scoped_markets as materialized (
       select m.id, m.event_id, m.venue
       from unified_markets m
       where m.event_id = any($2::text[]) and m.status = 'ACTIVE'
     ), scoped_tokens as materialized (
       select t.token_id, t.venue, m.event_id, m.id as market_id
       from scoped_markets m
       join unified_tokens t on t.market_id = m.id and t.venue = m.venue
     ), interactions as (
       -- A current watchlist entry remains an active interest; only historical
       -- fills and position observations decay or expire below.
       select w.user_id, m.event_id, m.id as market_id,
              now() as observed_at, 3.0 as base_weight
       from scoped_markets m
       join user_watchlist w on w.market_id = m.id
       union all
       select o.user_id, t.event_id, t.market_id,
              o.posted_at as observed_at, 2.0 as base_weight
       from scoped_tokens t
       join orders o on o.token_id = t.token_id and o.venue = t.venue
       where o.filled_size > 0
       union all
       select p.user_id, t.event_id, t.market_id,
              p.last_updated_at as observed_at, 1.0 as base_weight
       from scoped_tokens t
       join positions p on p.token_id = t.token_id and p.venue = t.venue
       where p.position_scope = 'own' and p.size > 0
         and coalesce(p.is_hidden, false) = false
     ), eligible as (
       select i.user_id,
              case when i.market_id = $1 then 0
                   when i.event_id = $3 then 1 else 2 end as relation_rank,
              i.event_id,
              i.base_weight * power(
                0.5,
                greatest(0, extract(epoch from (now() - i.observed_at))) / 1209600
              ) as interest_weight
       from interactions i
       where i.observed_at >= now() - interval '90 days'
     ), recipients as (
       select distinct on (eligible.user_id)
              eligible.user_id, eligible.relation_rank,
              e.title as event_title
       from eligible
       join telegram_notification_preferences pref
         on pref.user_id = eligible.user_id
        and pref.reachable and pref.interest_signals
        and pref.interest_signals_enabled_at <= $4::timestamptz
       join user_telegram_accounts account
         on account.user_id = eligible.user_id
       left join unified_events e on e.id = eligible.event_id
       where eligible.interest_weight >= 0.5
       order by eligible.user_id, eligible.relation_rank,
                eligible.interest_weight desc
     ), inserted as (
       insert into telegram_notification_outbox
         (user_id, event_key, topic, note_id, event_occurred_at, payload)
       select recipients.user_id, $5, 'interest_signals',
              $6::uuid, $4::timestamptz,
              jsonb_build_object(
                'kind', 'interest_signal',
                'noteId', $6::text,
                'eventId', $3::text,
                'marketId', $1::text,
                'venue', $7::text,
                'phase', 'preparing',
                'messageKind', $8::text,
                'rootDeliveryId', case when $8::text = 'research_update'
                  then root_delivery.id::text else null end,
                'actionText', 'Open market',
                'relationshipContext', case
                  when recipients.relation_rank = 0
                    then 'A Hunch for a market you follow'
                  else 'Related to ' || coalesce(
                    recipients.event_title, 'your market interests'
                  )
                end
              )
       from recipients
       left join telegram_notification_outbox root_delivery
         on root_delivery.user_id = recipients.user_id
        and root_delivery.topic in ('position_signals', 'interest_signals')
        and root_delivery.note_id = $9::uuid
        and root_delivery.status in ('pending', 'retry', 'sending', 'sent')
       on conflict (user_id, event_key) do nothing
       returning id
     )
     select count(*)::text as inserted_count from inserted`,
    [
      note.marketId,
      eventIds,
      note.eventId,
      note.createdAt,
      `position-signal:${note.thesisRootNoteId}:${note.revisionKind}:${note.id}`,
      note.id,
      note.marketVenue,
      note.revisionKind,
      note.thesisRootNoteId,
    ],
  );
  return Number(rows[0]?.inserted_count ?? 0);
}

export async function enqueueTelegramInterestHunches(input: {
  limit?: number;
  pool: Pool;
  redis: RedisClient | null;
}): Promise<{ enqueued: number; notes: number; semanticErrors: number }> {
  const client = await input.pool.connect();
  let acquired = false;
  let enqueued = 0;
  let semanticErrors = 0;
  let notesProcessed = 0;
  const limit = Math.min(10, Math.max(1, input.limit ?? 5));
  try {
    const lock = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtextextended($1::text, 0)) as acquired`,
      [WORKER_LOCK_KEY],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return { enqueued, notes: notesProcessed, semanticErrors };
    await initializeCursors(client);
    const subscriber = await client.query<{ subscribed: boolean }>(
      `select exists (
         select 1 from telegram_notification_preferences pref
         join user_telegram_accounts account on account.user_id = pref.user_id
         where pref.reachable and pref.interest_signals
       ) as subscribed`,
    );
    const hasSubscriber = subscriber.rows[0]?.subscribed === true;

    const exactCursor = await readCursor(client, EXACT_CURSOR_KEY);
    const exactNotes = await loadSignalBotNotes(client, {
      afterCreatedAt: exactCursor.cursor_created_at,
      afterId: exactCursor.cursor_id,
      limit,
    });
    for (const note of exactNotes) {
      await client.query("begin");
      try {
        if (hasSubscriber && note.eventId) {
          enqueued += await insertInterestRecipients(client, note, [
            note.eventId,
          ]);
        }
        await advanceCursor(client, EXACT_CURSOR_KEY, note);
        await client.query("commit");
        notesProcessed += 1;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }

    if (!hasSubscriber) {
      const latest = exactNotes.at(-1);
      await client.query(
        `update telegram_notification_cursors
         set cursor_created_at = $2::timestamptz, cursor_id = $3::uuid,
             updated_at = now()
         where consumer_key = $1
           and (cursor_created_at, cursor_id) < ($2::timestamptz, $3::uuid)`,
        [
          SEMANTIC_CURSOR_KEY,
          latest?.createdAt ?? exactCursor.cursor_created_at,
          latest?.id ?? exactCursor.cursor_id,
        ],
      );
      return { enqueued, notes: notesProcessed, semanticErrors };
    }

    const semanticCursor = await readCursor(client, SEMANTIC_CURSOR_KEY);
    const semanticNotes = await loadSignalBotNotes(client, {
      afterCreatedAt: semanticCursor.cursor_created_at,
      afterId: semanticCursor.cursor_id,
      limit,
    });
    for (const note of semanticNotes) {
      if (Date.now() - Date.parse(note.createdAt) > SEMANTIC_REPAIR_WINDOW_MS) {
        await client.query("begin");
        try {
          await advanceCursor(client, SEMANTIC_CURSOR_KEY, note);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        }
        continue;
      }
      let related: string[] = [];
      if (note.eventId) {
        try {
          const neighbors = await relatedHunchEventIds(
            input.redis,
            note.eventId,
          );
          if (neighbors === null) {
            await client.query("begin");
            try {
              await deferSemanticNote(
                client,
                note.id,
                "event_vector_unavailable",
              );
              await advanceCursor(client, SEMANTIC_CURSOR_KEY, note);
              await client.query("commit");
            } catch (error) {
              await client.query("rollback").catch(() => undefined);
              throw error;
            }
            semanticErrors += 1;
            continue;
          } else {
            related = neighbors;
          }
        } catch (error) {
          semanticErrors += 1;
          console.warn("[telegram-hunch-interests] semantic lookup deferred", {
            noteId: note.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // Exact delivery has already committed. Leave this cursor on the
          // last successful note; the next tick retries this exact note.
          break;
        }
      }
      await client.query("begin");
      try {
        if (related.length > 0) {
          enqueued += await insertInterestRecipients(client, note, related);
        }
        await advanceCursor(client, SEMANTIC_CURSOR_KEY, note);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }

    const repairs = await client.query<{ note_id: string }>(
      `select note_id from telegram_interest_semantic_repair
       where next_attempt_at <= now()
       order by next_attempt_at, note_id
       limit $1`,
      [limit],
    );
    for (const repair of repairs.rows) {
      const notes = await loadSignalBotNotes(client, {
        afterCreatedAt: "1970-01-01T00:00:00Z",
        afterId: ZERO_UUID,
        noteId: repair.note_id,
        limit: 1,
      });
      const note = notes[0];
      if (
        !note ||
        !note.eventId ||
        Date.now() - Date.parse(note.createdAt) > SEMANTIC_REPAIR_WINDOW_MS
      ) {
        await client.query(
          `delete from telegram_interest_semantic_repair where note_id = $1::uuid`,
          [repair.note_id],
        );
        continue;
      }
      let neighbors: string[] | null;
      try {
        neighbors = await relatedHunchEventIds(input.redis, note.eventId);
      } catch (error) {
        await deferSemanticNote(
          client,
          repair.note_id,
          error instanceof Error ? error.message : String(error),
        );
        semanticErrors += 1;
        break;
      }
      if (neighbors === null) {
        await deferSemanticNote(
          client,
          repair.note_id,
          "event_vector_unavailable",
        );
        semanticErrors += 1;
        continue;
      }
      await client.query("begin");
      try {
        if (neighbors.length > 0) {
          enqueued += await insertInterestRecipients(client, note, neighbors);
        }
        await client.query(
          `delete from telegram_interest_semantic_repair where note_id = $1::uuid`,
          [repair.note_id],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
    return { enqueued, notes: notesProcessed, semanticErrors };
  } finally {
    if (acquired) {
      await client
        .query(`select pg_advisory_unlock(hashtextextended($1::text, 0))`, [
          WORKER_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}
