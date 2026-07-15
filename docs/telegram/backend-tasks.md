# Backend Handoff: Telegram Notifications and Signals

Status: ready for assignment  
Owner: backend / platform  
Product context only: `telegram-bot-and-channel-ux-plan.md`

## How to Use This Handoff

Send this index to the backend owner together with the linked task documents.
Each document is a bounded remaining task with its own dependencies and
acceptance criteria.

Do not forward the full UX plan as an implementation ticket. It records
product decisions, research, channel-post design, and already completed bot
work. Share it only when additional product context is useful.

## Local Baseline — Do Not Reimplement

The current worktree already contains:

- button-first private bot navigation and the new Settings information
  architecture;
- seven Telegram topics: order fills, order problems, position results,
  deposits, bridge results, payouts/rewards, and signals for held markets;
- explicit idempotent topic writes from bot callbacks;
- durable preferences, outbox, cursor, retry, blocked-user, and per-chat rate
  handling;
- exact-market portfolio-signal recipient selection;
- compact MarkdownV2 notification renderers and contextual Mini App actions;
- API and bot tests for the implemented behavior;
- deposit classification under the frontend `Funds` preference.

Primary implementation files:

- `packages/db/migrations/0177_telegram_user_notifications.sql`;
- `apps/api/src/services/telegram-notification-preferences.ts`;
- `apps/api/src/services/telegram-notification-delivery.ts`;
- `apps/api/src/services/signal-bot.ts`;
- `apps/api/src/signal-bot-runner.ts`.

This is a local baseline, not a production claim. Migration 0177 was not
applied to a live database and Telegram delivery was not device-tested during
this work.

## Tasks to Assign

| Priority | Task                                                                            | Deliverable                                                                                          | Dependency                                                    |
| -------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P0       | [Production rollout](backend-telegram-notification-rollout.md)                  | Safely migrate, deploy, observe, replay, and live-QA the implementation already in the worktree      | Current worktree                                              |
| P0       | [Telegram preferences API](backend-telegram-notification-preferences-api.md)    | Authenticated GET/PATCH contract so Mini App Settings and the bot share account-level Telegram state | Migration 0177 or a forward migration                         |
| P0       | [Persistent signal channel registry](backend-signal-channel-registry.md)        | Makes public-channel destinations, policies, and cursors durable instead of Redis-only               | Postgres migration and current admin commands                 |
| P0       | [Notification-first signal headlines](backend-signal-notification-headlines.md) | Puts the strongest verified result and market into the mobile notification preview                   | Current structured signal/follow-through metrics              |
| P1       | [Resolved-position accounting](backend-position-resolution-accounting.md)       | Verified payout and realized PnL snapshot with safe fallback copy                                    | Venue settlement semantics                                    |
| P1       | [Trusted market mappings](backend-trusted-market-mappings.md)                   | Reviewed persistent cross-venue equivalence and side orientation                                     | Market ingestion / AGG candidates                             |
| P1       | [Signal subscription expansion](backend-telegram-signal-subscriptions.md)       | Tracked-wallet rules, per-market controls, noise policy, and trusted cross-venue fan-out             | Existing exact fan-out; trusted mappings only for cross-venue |
| P2       | [Security event producers](backend-security-notification-events.md)             | Durable, deduped security events before exposing a Security Telegram toggle                          | Domain owners and approved event semantics                    |

Recommended order:

1. Roll out and validate the existing private-notification delivery path.
2. Persist the public-channel registry and replace generic hooks with
   notification-first headlines before the next public copy rollout.
3. Add the authenticated preferences API; this can proceed in parallel once
   the migration shape is fixed.
4. Implement resolved-position accounting and trusted mappings independently.
5. Expand signal subscriptions after the recipient and mapping contracts are
   stable.
6. Add Security only after each source mutation and delivery behavior has an
   owner.

## Shared Product Decisions

- Browser pop-up settings remain device-local. Telegram settings are
  account-level server preferences. They share taxonomy, not stored values.
- Signals remain separate from transactional notifications.
- Deposits are default-on `Funds` notifications.
- Telegram consumes canonical durable backend events; it does not poll venues
  independently.
- Preference writes set an explicit value and must be safe to replay.
- Wallet, identity, and signer mutations remain authenticated Mini App flows.
- Cross-venue personal delivery uses only reviewed persistent mappings. Runtime
  title similarity or an AI confidence score is insufficient.
- Public signal headlines lead with the strongest verified movement and a
  recognizable market so the useful fact survives mobile notification preview.
- Public channel configuration and cursors are durable Postgres state; Redis
  is not the sole source of truth.
- Product announcements remain out of scope until there is an approved consent
  model and a real producer.
- A separate withdrawal topic remains out of scope until product confirms a
  distinct withdrawal flow and the backend exposes a canonical terminal event.

## Migration Decision Required Before Merge

Backend must check whether any environment has already applied a previous form
of migration 0177:

- if not, migration 0177 may be finalized before first application;
- if yes, do not rewrite it—add migration 0178 (or the next available number)
  with compatible `ADD COLUMN`, constraint, and backfill steps.

Record that decision in the rollout PR.

## Handoff Completion

The handoff is complete when every active task has an owner, implementation PR
or explicit rejection, the migration path is recorded, and production rollout
has metrics, selective replay instructions, and a device-level Telegram QA
result.
