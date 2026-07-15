# Backend Task: Telegram Notification Production Rollout

Status: implementation exists locally; migration, operations, and live QA required  
Priority: P0  
Depends on: current worktree and deployment ownership

## Goal

Safely ship the Telegram preference, outbox, and delivery implementation that
already exists in the worktree. This task validates deployment behavior; it is
not a request to build a second delivery worker.

## Already Implemented Locally

Migration `0177_telegram_user_notifications.sql` adds:

- `telegram_notification_preferences` with seven topic preferences and
  `enabled_at` cutoffs;
- `telegram_notification_outbox` with immutable user/event dedupe;
- `telegram_notification_cursors`;
- preference creation on Telegram account link;
- reachable/blocked state.

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

The migration was not applied to a live database and live Telegram delivery
was not verified during this work.

## Migration and Deploy Plan

1. Determine whether any environment has applied an earlier migration 0177.
2. If none has, finalize and apply 0177 normally. If one has, create the next
   forward migration; never edit applied migration history.
3. Deploy the database migration before code that reads the new tables.
4. Deploy API services and the signal-bot runner with a production kill switch
   for enqueue/delivery if one does not already exist.
5. Verify all required Telegram and Mini App configuration in the target
   environment.
6. Enable one test account, complete live event QA, then expand rollout while
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

- Migration ownership and the 0177/forward-migration decision are recorded.
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
