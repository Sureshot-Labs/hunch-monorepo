# Backend Task: Telegram Notification Production Rollout

Status: implementation exists locally; production migration, operations, and live QA required
Priority: P0
Depends on: current worktree and deployment ownership

## Goal

Safely ship the Telegram preference, outbox, and delivery implementation that
already exists in the worktree. This task validates deployment behavior; it is
not a request to build a second delivery worker.

## Already Implemented Locally

Migrations `0177_telegram_user_notifications.sql` and
`0178_telegram_notification_delivery_safety.sql` add:

- `telegram_notification_preferences` with seven topic preferences and
  `enabled_at` cutoffs;
- `telegram_notification_outbox` with immutable user/event dedupe;
- `telegram_notification_cursors`;
- preference creation on Telegram account link;
- reachable/blocked state.
- immutable `event_occurred_at`, safe defaults, cursor indexes, and bounded
  terminal-row retention support.

The API implementation adds:

- explicit preference writes;
- enqueue from durable `notifications` events;
- exact-market portfolio-signal enqueue;
- outbox claiming with `FOR UPDATE SKIP LOCKED`;
- stale `sending` recovery;
- bounded exponential retries and Telegram `retry_after` handling;
- blocked/missing-user handling without unlinking identity or trading access;
- MarkdownV2 messages with at most one contextual Mini App CTA;
- a runner loop for enqueue and delivery.
- a typed `telegram_notifications` runtime policy with independent activity
  enqueue, position-signal enqueue, and delivery gates. All three compiled
  defaults are `false`.

Only an explicit private `/start` marks a linked account reachable. Linking,
`/menu`, `/settings`, callbacks, or relinking do not. Position signals are
opt-in and default to off.

Current activity mapping:

| Topic               | Event types                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `order_filled`      | `order_filled`                                                          |
| `order_issues`      | `order_cancelled`, `order_failed`                                       |
| `position_resolved` | `position_resolved`                                                     |
| `deposit_received`  | `deposit_received`                                                      |
| `bridge_updates`    | `bridge_completed`, `bridge_refunded`, `bridge_failed`                  |
| `payouts_rewards`   | `redemption_completed`, `reward_claim_confirmed`, `reward_claim_failed` |
| `position_signals`  | eligible Hunch notes for exact markets in owned positions               |

Both migrations were applied and integration-tested against the local database.
They were not applied to a live database, and live Telegram delivery was not
verified during this work.

## Migration and Deploy Plan

1. Apply migrations 0177 and 0178 in filename order; never rewrite either after
   it has been applied.
2. Deploy the database migrations before code that reads the new tables.
3. Deploy API services and the signal-bot runner. With no runtime-policy row,
   enqueue and delivery remain disabled.
4. Verify all required Telegram and Mini App configuration in the target
   environment.
5. Publish the full typed runtime policy one gate at a time for one test
   account, complete live event QA, then expand rollout while
   monitoring the outbox.

The migration review must also confirm:

- topic constraints match the seven implemented values;
- triggers and `updated_at` behavior are compatible with the target database;
- account link/unlink/relink behavior preserves preferences;
- effective reachability cannot become true before the bot is allowed to
  initiate a chat;
- existing linked accounts receive preferences without replaying historical
  notifications.

## Live QA Matrix

For a linked test user, generate one real or controlled event for each mapped
type and verify one durable notification, one outbox row, and one Telegram
message. Validate:

- explicit topic off/on behavior and the `enabled_at` cutoff;
- duplicate source processing;
- bot blocked, then `/start` recovery;
- Telegram 429 with `retry_after`;
- transient Telegram/network failure;
- worker restart while a row is `sending`;
- malformed or incomplete payload fallback;
- iOS, Android, and Desktop Markdown rendering;
- every displayed Mini App destination;
- messages without a safe destination omit the button.

Do not simulate delivery only by inserting final outbox rows. At least one QA
case per topic should start at the canonical domain notification/event so the
mapping is exercised.

## Operations Required Before General Enablement

Add dashboards or queries for:

- pending, retry, sending, and dead row counts and oldest age;
- enqueue, sent, skipped, blocked, and failed counts by topic;
- Telegram response class and retry delay;
- p50/p95 event-to-send latency;
- users marked unreachable;
- exact-market signal recipients and dedupe conflicts.

Provide a runbook for:

- pausing enqueue separately from delivery;
- diagnosing a growing backlog;
- safely requeuing selected dead rows after fixing the cause;
- excluding users whose topic is now disabled or whose chat is unreachable;
- disabling only personal signals while transactional delivery remains on;
- rolling back code without dropping preference or outbox history.

Never bulk-replay historical events merely because a preference or chat became
reachable again.

## Acceptance Criteria

- Migration ownership for 0177 and forward migration 0178 is recorded.
- Every supported event produces at most one message per user/event key.
- Preferences are checked at enqueue and again before delivery.
- Topic re-enable does not backfill older activity.
- A blocked bot marks delivery unreachable without unlinking the account or
  revoking Telegram trading permissions.
- Retry, restart recovery, and selective replay work in the deployed worker.
- Dead rows and delivery latency are observable.
- Device QA confirms readable Markdown and valid Mini App actions.
- Production has a documented kill switch and rollback/recovery runbook.

## Out of Scope

- authenticated frontend preference routes; see
  `backend-telegram-notification-preferences-api.md`;
- exact payout/PnL copy; see `backend-position-resolution-accounting.md`;
- tracked-wallet and cross-venue signal expansion; see
  `backend-telegram-signal-subscriptions.md`;
- new Security, product-update, or withdrawal producers.
