# Backend Task: Persistent Signal Channel Registry

Status: ready for backend implementation  
Priority: P0 reliability  
Depends on: current signal-bot admin commands and Postgres migration ownership

## Goal

Move the public Telegram signal destination registry and delivery cursors from
Redis-only state to a durable, auditable Postgres source of truth. Redis may
remain a cache, lock, and short-lived cooldown store.

## Current State

The bot itself is configured through environment variables, including:

- `HUNCH_SIGNAL_BOT_ENABLED`;
- `HUNCH_SIGNAL_BOT_TOKEN`;
- `HUNCH_SIGNAL_BOT_ADMIN_USER_IDS`;
- publishing, confidence, Mini App, and trading settings.

There is no single hard-coded channel ID. An authorized admin enables a
destination with `/enable_signals` in the chat or with
`/enable_signals <channel_id>` from an admin chat.

Runtime destination state is stored in Redis:

```text
tg:signal_bot:v1:enabled_chats
tg:signal_bot:v1:chat:{chat_id}
```

The per-chat hash contains title/type, enabling actor/time, delivery cursor,
and destination-venue policy. `publishSignalBotTick` and follow-through
delivery read the Redis set. A blocked or missing destination is removed from
Redis.

Postgres `signal_bot_messages` records sent/failed delivery history and enables
dedupe/threading, but it does not own whether a channel is enabled or the
channel's next-delivery cursor.

Redis loss can therefore remove the destination registry, cursor, and venue
policy even though delivery history remains in Postgres.

## Required Data Model

Use repository naming conventions; illustrative shape:

```text
signal_bot_channels
  chat_id text primary key
  chat_type text
  title text/null
  username text/null
  status enabled | disabled | unreachable
  enabled_by_telegram_user_id text/null
  enabled_at timestamptz/null
  disabled_at timestamptz/null
  disabled_reason text/null
  cursor_created_at timestamptz
  cursor_id uuid
  destination_policy jsonb/null
  last_delivery_at timestamptz/null
  last_error_code text/null
  last_error_at timestamptz/null
  created_at, updated_at
```

Add an audit table or immutable operational event stream for enable, disable,
policy change, cursor reset, unreachable, and manual replay actions. Record
the actor and old/new safe values.

Do not delete the channel row on disable or Telegram delivery failure.

## Command and Service Contract

Admin commands must call one shared repository/service:

- `/enable_signals [channel_id]`;
- `/disable_signals [channel_id]`;
- `/status [channel_id]`;
- `/signal_venues <venues|all> [channel_id]`.

On enable:

1. authorize the Telegram user against configured admin IDs;
2. resolve the actual Telegram chat through the Bot API;
3. verify that the bot can post to that chat/channel;
4. store canonical chat metadata;
5. set status to enabled;
6. start from `now` by default so old signals are not backfilled.

Do not trust a fabricated title such as `Telegram channel -100...` as verified
metadata. If Telegram verification is temporarily unavailable, fail closed or
store a pending state that the publisher cannot use.

On re-enable, do not silently resume from an arbitrarily old cursor. Default to
`max(previous cursor, now)` unless an explicit, audited replay operation was
requested.

On `blocked_or_missing` or missing post permission, set status to unreachable,
retain the cursor and configuration, and store a normalized error. Recovery
must require successful Telegram verification or an explicit admin action.

## Publisher Semantics

The publisher and follow-through worker must query enabled rows from Postgres
or from a rebuildable Redis cache whose source is Postgres.

Cursor advancement must be durable and consistent with delivery history:

- a process restart must not lose an enabled channel;
- cursor advancement must not happen before the delivery outcome is recorded;
- retries and unique `signal_bot_messages` constraints must remain safe;
- one channel failure must not block other channels;
- manual disable during a tick must prevent new sends as soon as practical;
- a Redis flush must not change the durable enabled/disabled decision.

Document whether cursor update and `signal_bot_messages` insert share a
transaction. If Telegram succeeds but the database write fails, reconciliation
must use Telegram/message metadata or the existing unique key to avoid an
unbounded duplicate loop.

## Migration and Rollout

1. Create the Postgres registry and audit schema.
2. Build an idempotent importer for the current Redis set and per-chat hashes.
3. Export and review current production Redis destinations before cutover.
4. Deploy a short dual-write period for admin mutations if needed.
5. Switch reads to Postgres as source of truth.
6. Rebuild/compare the Redis cache and Postgres rows in shadow mode.
7. Remove Redis as authoritative configuration only after parity is verified.

If a Redis channel hash is missing, do not automatically enable a destination
solely because historical `signal_bot_messages` exist. Produce a reconciliation
report for manual review.

## Operations

Expose an admin view or diagnostic command showing:

- chat ID, title, username, and verified chat type;
- status and status reason;
- enabled actor/time;
- cursor and last successful delivery;
- destination venues;
- last normalized error;
- pending/retry counts where applicable.

Add metrics for enabled/unreachable channels, delivery age by channel, policy
changes, failed verification, cursor lag, and Redis/Postgres parity during
migration.

## Acceptance Criteria

- Restarting or flushing Redis does not lose enabled destinations or cursors.
- Admin commands are authorized, idempotent, and audited.
- Enabling an arbitrary channel ID without verified bot post access fails.
- First enable and normal re-enable do not backfill old signals.
- Disable/unreachable state retains history and can be diagnosed.
- Publisher and follow-through delivery use the same durable registry.
- Destination-venue policy survives restarts and cache loss.
- Existing Redis channels migrate without duplicate or historical sends.
- Tests cover enable/disable/re-enable, permission loss, blocked chat, Redis
  loss, concurrent admin commands, cursor recovery, and partial migration.

## Out of Scope

- private per-user Telegram notification destinations, which use
  `user_telegram_accounts` and the notification outbox;
- changing signal eligibility or research selection;
- Telegram channel creation or membership management;
- storing the bot token in this registry.
