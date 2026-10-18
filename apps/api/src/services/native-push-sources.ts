import { tx, type Pool } from "@hunch/infra";
import { POSITION_TOKEN_MARKET_JOIN_SQL } from "../lib/pnl-sql.js";
import {
  enqueueNativePushInTransaction,
  lockNativePushRecipients,
} from "./native-push-queue.js";
import { buildHolderResearchPriceMovement } from "./holder-research-price-movement.js";

type SourceEvent = {
  id: string;
  event_key: string;
  kind: "notification" | "followed_hunch";
  subject_id: string;
  occurred_at: Date;
  recipient_cursor: string | null;
};

/** One event and at most 100 follow edges per transaction; empty pages advance. */
export async function fanoutNativePushEvent(db: Pool) {
  return tx(db, async (client) => {
    const { rows } = await client.query<SourceEvent>(
      `select * from native_push_events where not finished order by id limit 1 for update skip locked`,
    );
    const event = rows[0];
    if (!event) return false;
    if (Date.now() - new Date(event.occurred_at).getTime() > 86_400_000) {
      await client.query(
        `update native_push_events set finished=true where id=$1`,
        [event.id],
      );
      return true;
    }
    if (event.kind === "notification") {
      const { rows: notifications } = await client.query<{
        user_id: string;
        title: string;
        body: string;
        event_id: string | null;
        market_id: string | null;
      }>(
        `select n.user_id,n.title,n.body,m.event_id,m.id as market_id
        from notifications n left join unified_markets m on m.id=n.data->>'marketId'
        where n.id=$1 and n.type='position_resolved'`,
        [event.subject_id],
      );
      const notification = notifications[0];
      if (notification)
        await enqueueNativePushInTransaction(client, {
          userIds: [notification.user_id],
          eventKey: event.event_key,
          topic: "market_resolution",
          occurredAt: event.occurred_at,
          content: {
            title: notification.title,
            body: notification.body,
            target: {
              eventId: notification.event_id,
              marketId: notification.market_id,
            },
          },
        });
      await client.query(
        `update native_push_events set finished=true where id=$1`,
        [event.id],
      );
      return true;
    }
    const { rows: theses } = await client.query<{
      author_id: string;
      handle: string | null;
      display_name: string | null;
      body: string;
      market_id: string;
      event_id: string | null;
    }>(
      `select t.author_id,u.handle,u.display_name,t.body,t.market_id,coalesce(m.event_id,t.event_id) as event_id from user_theses t
      join users u on u.id=t.author_id left join unified_markets m on m.id=t.market_id where t.id=$1 and u.is_active and u.social_suspended_at is null
        and t.author_hidden_at is null and t.moderation_hidden_at is null and t.proof_invalidated_at is null`,
      [event.subject_id],
    );
    const thesis = theses[0];
    if (!thesis) {
      await client.query(
        `update native_push_events set finished=true where id=$1`,
        [event.id],
      );
      return true;
    }
    const { rows: followers } = await client.query<{
      id: string;
      blocked: boolean;
    }>(
      `with page as materialized (select f.* from user_follows f
      where f.followed_user_id=$1 and ($2::uuid is null or f.follower_user_id>$2) and f.created_at<=$3
      order by f.follower_user_id limit 100)
      select f.follower_user_id as id,exists(select 1 from user_blocks b where
          (b.blocker_user_id=f.follower_user_id and b.blocked_user_id=f.followed_user_id)
          or (b.blocker_user_id=f.followed_user_id and b.blocked_user_id=f.follower_user_id)) as blocked
      from page f order by f.follower_user_id`,
      [thesis.author_id, event.recipient_cursor, event.occurred_at],
    );
    await enqueueNativePushInTransaction(client, {
      userIds: followers.filter((row) => !row.blocked).map((row) => row.id),
      eventKey: event.event_key,
      topic: "followed_hunches",
      occurredAt: event.occurred_at,
      content: {
        title: `New Hunch from ${thesis.handle ? `@${thesis.handle}` : thesis.display_name || "a trader you follow"}`,
        body: thesis.body,
        target: {
          authorId: thesis.author_id,
          thesisId: event.subject_id,
          eventId: thesis.event_id,
          marketId: thesis.market_id,
        },
      },
    });
    await client.query(
      `update native_push_events set recipient_cursor=coalesce($2,recipient_cursor),finished=$3 where id=$1`,
      [event.id, followers.at(-1)?.id ?? null, followers.length < 100],
    );
    return true;
  });
}

/** One UTC daily digest; no historical catch-up and no interest-based ranking. */
export async function enqueueNativeMarketDigest(db: Pool, now = new Date()) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const deliveryTime = new Date(end.getTime() + 12 * 3_600_000);
  if (now < deliveryTime) return false;
  const start = new Date(end.getTime() - 86_400_000);
  const key = `new-markets:${end.toISOString().slice(0, 10)}`;
  return tx(db, async (client) => {
    await client.query(
      `insert into native_push_worker_cursors(name,cycle_started_at,available_at) values($1,$2,$3) on conflict do nothing`,
      [key, end, deliveryTime],
    );
    const { rows: cursors } = await client.query<{
      user_id: string | null;
      available_at: Date;
    }>(
      `select user_id,available_at from native_push_worker_cursors where name=$1 for update skip locked`,
      [key],
    );
    const cursor = cursors[0];
    if (!cursor || new Date(cursor.available_at).getTime() > now.getTime())
      return false;
    const { rows: markets } = await client.query<{
      id: string;
      event_id: string;
      title: string;
    }>(
      `select id,event_id,title from unified_markets
      where status='ACTIVE' and venue in ('polymarket','limitless') and created_at_db>=$1 and created_at_db<$2
        and (created_at is null or created_at>=$1) and (close_time is null or close_time>now())
        and (expiration_time is null or expiration_time>now()) order by created_at_db,id limit 3`,
      [start, end],
    );
    if (!markets.length) {
      await client.query(
        `update native_push_worker_cursors set available_at=$2 where name=$1`,
        [key, new Date(end.getTime() + 2 * 86_400_000)],
      );
      return false;
    }
    const { rows: users } = await client.query<{ user_id: string }>(
      `select user_id from native_notification_preferences
      where enabled and new_markets and ($1::uuid is null or user_id>$1) order by user_id limit 100`,
      [cursor.user_id],
    );
    await enqueueNativePushInTransaction(client, {
      userIds: users.map((row) => row.user_id),
      eventKey: key,
      topic: "new_markets",
      occurredAt: deliveryTime,
      content: {
        title: "New markets to explore",
        body: markets.map((row) => row.title).join(" · "),
        target: { destination: "discovery" },
      },
    });
    await client.query(
      `update native_push_worker_cursors set user_id=coalesce($2,user_id),available_at=$3 where name=$1`,
      [
        key,
        users.at(-1)?.user_id ?? null,
        users.length < 100 ? new Date(end.getTime() + 2 * 86_400_000) : now,
      ],
    );
    return users.length > 0;
  });
}

type MoveRow = {
  id: string;
  market_id: string | null;
  event_id: string | null;
  title: string | null;
  bid: string | null;
  ask: string | null;
  historical: string | null;
  historical_at: Date | null;
};

export function nativeProbabilityMove(input: {
  bid: unknown;
  ask: unknown;
  historical: unknown;
}): number | null {
  if (input.bid == null || input.ask == null || input.historical == null)
    return null;
  const bid = Number(input.bid),
    ask = Number(input.ask),
    historical = Number(input.historical);
  if (
    ![bid, ask, historical].every(Number.isFinite) ||
    bid < 0 ||
    ask > 1 ||
    bid > ask ||
    historical < 0 ||
    historical > 1
  )
    return null;
  return (bid + ask) / 2 - historical;
}

/** Account/position keysets keep sparse or large portfolios resumable. */
export async function enqueueNativeBigMoves(db: Pool, now = new Date()) {
  return tx(db, async (client) => {
    await client.query(
      `insert into native_push_worker_cursors(name,available_at) values('big-moves',$1) on conflict do nothing`,
      [now],
    );
    const { rows: cursors } = await client.query<{
      user_id: string | null;
      item_id: string | null;
      available_at: Date;
      cycle_started_at: Date;
    }>(
      `select * from native_push_worker_cursors where name='big-moves' for update skip locked`,
    );
    const cursor = cursors[0];
    if (!cursor || new Date(cursor.available_at).getTime() > now.getTime())
      return false;
    const { rows: users } = await client.query<{ user_id: string }>(
      `select user_id from native_notification_preferences
      where enabled and big_moves and ($1::uuid is null or user_id>$1 or (user_id=$1 and $2::uuid is not null)) order by user_id limit 1`,
      [cursor.user_id, cursor.item_id],
    );
    const user = users[0];
    if (!user) {
      await client.query(
        `update native_push_worker_cursors set user_id=null,item_id=null,cycle_started_at=$1::timestamptz,available_at=$1::timestamptz+interval '15 minutes' where name='big-moves'`,
        [now],
      );
      return false;
    }
    // Lifecycle must win before any cooldown or device FK is touched. Re-read
    // recipients in enqueue after a wait, including keep-source merge cleanup.
    await lockNativePushRecipients(client, [user.user_id]);
    const positionCursor =
      user.user_id === cursor.user_id ? cursor.item_id : null;
    const { rows } = await client.query<MoveRow>(
      `with held as materialized (
      select * from positions where user_id=$1 and position_scope='own' and size>0 and coalesce(is_hidden,false)=false
        and ($2::uuid is null or id>$2) order by id limit 100
    ) select p.id,m.id as market_id,m.event_id,m.title,top.best_bid::text as bid,top.best_ask::text as ask,history.avg_mid_24h::text as historical,history.bucket_24h as historical_at
      from held p ${POSITION_TOKEN_MARKET_JOIN_SQL}
      left join unified_markets m on m.id=umt.market_id and m.status='ACTIVE'
        and (m.close_time is null or m.close_time>now()) and (m.expiration_time is null or m.expiration_time>now())
      left join lateral (select token_id from unified_market_tokens where market_id=m.id and outcome_side='YES' order by updated_at desc nulls last,token_id limit 1) canonical on true
      left join unified_token_top_latest top on top.token_id=canonical.token_id and top.ts>=now()-interval '15 minutes'
      left join unified_token_change_24h history on history.token_id=canonical.token_id and history.updated_at>=now()-interval '1 hour'
      order by p.id`,
      [user.user_id, positionCursor],
    );
    const seen = new Set<string>();
    for (const row of rows) {
      const move = nativeProbabilityMove(row);
      const movement = buildHolderResearchPriceMovement({
        baseline: {
          yes: row.historical == null ? null : Number(row.historical),
          no: null,
          yesAt: row.historical_at?.toISOString() ?? null,
          noAt: null,
        },
        yesProbabilityNow:
          move === null ? null : (Number(row.bid) + Number(row.ask)) / 2,
        now,
      });
      if (
        !row.market_id ||
        seen.has(row.market_id) ||
        move === null ||
        movement.quality !== "available" ||
        Math.abs(move) + 1e-12 < 0.1
      )
        continue;
      seen.add(row.market_id);
      const cooldown = await client.query(
        `select 1 from native_push_topic_cooldowns where user_id=$1 and topic='big_moves' and subject_key=$2
        and occurred_at>$3::timestamptz-interval '24 hours'`,
        [user.user_id, row.market_id, now],
      );
      if (cooldown.rows.length) continue;
      const queued = await enqueueNativePushInTransaction(client, {
        userIds: [user.user_id],
        eventKey: `big-move:${now.toISOString().slice(0, 10)}:${row.market_id}`,
        topic: "big_moves",
        occurredAt: now,
        content: {
          title: "Big move in a market you hold",
          body: `${row.title ?? "Market"}: probability moved ${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)} percentage points versus its 24h reference.`,
          target: { marketId: row.market_id, eventId: row.event_id },
        },
      });
      // The account lock serializes competing signal writers. Retention only
      // removes expired rows and never advances their timestamp. An empty queue
      // (permission prompt, no device, expired session, duplicate) spends nothing.
      if (queued > 0)
        await client.query(
          `insert into native_push_topic_cooldowns(user_id,topic,subject_key,occurred_at)
          values($1,'big_moves',$2,$3) on conflict(user_id,topic,subject_key) do update set occurred_at=excluded.occurred_at`,
          [user.user_id, row.market_id, now],
        );
    }
    await client.query(
      `update native_push_worker_cursors set user_id=$1,item_id=$2 where name='big-moves'`,
      [user.user_id, rows.length === 100 ? (rows.at(-1)?.id ?? null) : null],
    );
    return true;
  });
}
