# Backend Task: Telegram Signal Subscriptions

Status: exact portfolio fan-out implemented; expansion required  
Priority: P1  
Depends on: existing Telegram preference/outbox baseline; trusted mappings for
cross-venue delivery

## Goal

Turn the bot's `Signals` section into real server-side subscription controls
for two distinct products:

1. Hunch research signals for markets in the user's own portfolio.
2. Wallet-activity signals for wallets the user follows or that match a chosen
   tracked-wallet scope.

Keep signals separate from transactional notifications because their volume,
filters, digest behavior, and mute controls are different.

## What Is Implemented Locally

`enqueueTelegramPositionSignals` currently:

- advances a durable `telegram_position_signals_v1` cursor;
- loads eligible Hunch notes after the cursor;
- selects users with visible owned positions (`position_scope = own`, size > 0)
  on the exact target `market_id`;
- checks `position_signals`, reachability, and `enabled_at`;
- derives held side from `unified_tokens.side`;
- labels the signal as supporting, challenging, or generally relevant;
- inserts one immutable outbox event per user and note;
- sends the normal private signal rendering with one `Review position` action.

It intentionally does not include followed positions and does not perform
cross-venue matching.

The frontend already has tracked-wallet signal concepts:

- `wallet_follows.notifications_enabled` exists in the database;
- wallet activity signal APIs accept scope `following`, `active`, or `all`;
- frontend Settings exposes the same scope choices;
- frontend filter `positive` means the tracked position's current open PnL is
  present and greater than zero;
- frontend delivery is currently only browser polling/toasts and stores its
  rules in `localStorage`.

## Preference Model

Add account-level Telegram fields:

- `position_signals` boolean, already implemented;
- `tracked_wallet_signals` boolean, default off;
- `tracked_wallet_signal_scope`: `following`, `active`, or `all`, default
  `following`;
- `tracked_wallet_signal_filter`: `positive` or `all`, default `positive`.

`wallet_follows.notifications_enabled` remains the per-wallet eligibility
switch for followed scope. The global Telegram topic cannot override a wallet
the user explicitly muted.

Browser scope/filter values must not automatically overwrite these fields.
Frontend Settings may show both delivery channels, but each has explicit state.

## Portfolio Signal Rules

Keep the exact-market implementation as the safe baseline, then add:

- trusted cross-venue equivalence using
  `backend-trusted-market-mappings.md`;
- per-market mute/follow overrides;
- optional signal-only quiet hours or digest mode after immediate delivery is
  measured.

Only initial and material research-update notes should notify by default.
Periodic channel follow-through posts are not automatically personal
notifications. Position resolution remains a transactional event.

Suggested override model:

```text
telegram_market_signal_overrides
  user_id
  market_or_equivalence_group_id
  mode = muted | following
  created_at, updated_at
```

Semantics:

- an owned visible position creates automatic eligibility;
- `muted` suppresses automatic eligibility for that market/equivalence group;
- leaving the position removes automatic eligibility;
- `following` keeps explicit eligibility even without an open position;
- a global `position_signals = false` suppresses all portfolio signal delivery
  but preserves overrides;
- a new position should not erase an earlier explicit mute.

Define whether overrides apply to an exact market or a trusted equivalence
group before schema creation. Once cross-venue mappings are active, group-level
controls are usually less surprising.

## Tracked-Wallet Signal Fan-Out

Do not make the Telegram worker repeatedly poll the same public endpoint for
every user. Consume a durable wallet-activity signal/event identity or add a
cursor over the canonical wallet activity data, then select recipients in SQL.

Recipient selection must apply, in order:

1. global `tracked_wallet_signals` enabled and Telegram reachable;
2. scope:
   - `following`: followed wallets with `notifications_enabled = true`;
   - `active`: the backend's defined active-wallet set;
   - `all`: union of eligible followed and active wallets with dedupe;
3. filter:
   - `positive`: current open PnL exists and is greater than zero;
   - `all`: no PnL filter;
4. per-user/wallet/event dedupe;
5. rate and batching policy.

The meaning of `active` is dynamic. Store the rule, not a frozen list, but
record the wallet IDs that matched in the outbox payload for auditability.

Use a stable event key such as:

```text
tracked-wallet-signal:{canonical-signal-id}:{presentation-kind}
```

combined with `user_id` by the existing unique constraint. Do not use frontend
feed order or a random toast ID.

## Noise and Rate Policy

Telegram is more interruptive than an in-app toast:

- tracked-wallet signals default off;
- default scope is `following`, not `all`;
- default filter is `positive`;
- cap immediate messages per user and time window;
- coalesce multiple wallet actions on the same market when they represent one
  burst;
- defer lower-priority signals into a digest rather than dropping them if a
  future digest product is approved;
- transactional order/security messages must not be delayed behind a signal
  burst.

The existing one-message-per-chat-per-outbox-batch behavior is transport
protection, not a product rate policy. Add explicit per-user signal quotas and
metrics.

## Bot Actions

The Signals screen should support:

- enable/disable portfolio signals;
- enable/disable tracked-wallet signals;
- choose tracked-wallet scope;
- choose positive/all filter;
- mute the market from a delivered portfolio signal;
- open the relevant position, market, or tracked wallet in the Mini App.

Callbacks must call explicit set operations. A stale double tap must not invert
state twice. Per-market mute callbacks must include a compact opaque identifier
or signed lookup key, not raw unrestricted market/user IDs trusted from
callback data.

## Cursor and Transaction Safety

The current position-signal cursor and enqueue happen in one transaction. Keep
that property: advance a cursor only after all recipient outbox rows for a
source event have been attempted successfully in the transaction.

For high fan-out tracked-wallet events, use bounded batches and a resumable
event/recipient cursor so one large event cannot hold a transaction for an
unbounded time. Dedupe constraints remain the final correctness boundary.

## Acceptance Criteria

- Exact held-market signals continue to work independently of cross-venue
  mapping availability.
- Cross-venue fan-out uses only active trusted mappings and stores mapping IDs.
- Supporting/challenging labels apply side orientation exactly once.
- Tracked-wallet delivery respects global topic, scope, positive/all filter,
  and per-wallet `notifications_enabled`.
- Tracked-wallet delivery defaults off and cannot replay old feed history when
  enabled.
- One source signal produces at most one message per user and presentation
  kind, even when several positions or wallets match.
- A per-market mute survives position resync and suppresses future delivery.
- Cursor crashes/restarts do not lose or duplicate user-visible events.
- Signal rate limiting cannot starve transactional notifications.
- Tests cover scopes, filters, open-PnL null/zero/positive/negative values,
  exact/mapped markets, direct/inverted sides, multi-wallet aggregation,
  toggles during delivery, and cursor recovery.

## Out of Scope

- automatic trading from signals;
- loosely related market recommendations;
- browser toast synchronization across devices;
- exact settlement PnL, covered in
  `backend-position-resolution-accounting.md`.
