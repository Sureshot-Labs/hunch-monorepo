# Backend Task: Telegram Notification Preferences API

Status: ready for backend implementation  
Priority: P0  
Depends on: migration 0177 or its forward-compatible successor

## Goal

Expose authenticated account endpoints through which the Mini App can read and
set the same Telegram delivery preferences already used by private-bot
callbacks.

This is not a browser notification API. Existing browser pop-up preferences
remain device-local in `localStorage`.

## Already Implemented Locally

The database and bot currently support these account-level topics:

| Section | Topic key           | Default |
| ------- | ------------------- | ------- |
| Trading | `order_filled`      | On      |
| Trading | `order_issues`      | On      |
| Trading | `position_resolved` | On      |
| Funds   | `deposit_received`  | On      |
| Funds   | `bridge_updates`    | On      |
| Funds   | `payouts_rewards`   | On      |
| Signals | `position_signals`  | On      |

`setTelegramNotificationTopic` applies an explicit target state and advances a
topic's `enabled_at` only when it changes from off to on. Bot callback retries
therefore cannot invert a preference twice.

There is no authenticated HTTP route for frontend Settings yet.

## Required API

Add account-authenticated endpoints:

```text
GET   /telegram/notification-preferences
PATCH /telegram/notification-preferences
```

Suggested GET response:

```json
{
  "channel": {
    "linked": true,
    "reachable": true,
    "lastStartedAt": "2026-07-15T09:00:00.000Z",
    "blockedAt": null
  },
  "topics": {
    "order_filled": true,
    "order_issues": true,
    "position_resolved": true,
    "deposit_received": true,
    "bridge_updates": true,
    "payouts_rewards": true,
    "position_signals": true
  },
  "version": 1
}
```

PATCH sets one or more explicit values:

```json
{
  "topics": {
    "deposit_received": false,
    "position_signals": true
  }
}
```

PATCH must:

- derive `user_id` from the authenticated request, never from request data;
- reject unknown topic keys and non-boolean values;
- update all supplied topics in one transaction;
- return the complete new state;
- be idempotent when the same request is replayed;
- update each `enabled_at` only on an off-to-on transition.

Use the same internal service for bot and HTTP writes after each caller has
resolved its authenticated user. Do not duplicate topic semantics in a route
handler.

## Linkage and Reachability Semantics

Return these as separate facts:

- `linked`: a `user_telegram_accounts` link currently exists;
- `lastStartedAt`: the private bot has observed `/start` for this chat;
- `reachable`: proactive Telegram delivery is currently permitted and has not
  been invalidated by a blocked/missing-chat response;
- topic booleans: the user's desired delivery choices.

An account link alone must not be presented as proof that proactive messaging
works. Backend should review the current `reachable DEFAULT true` behavior in
migration 0177 against the actual linking flow. If a link can be created before
the bot observes `/start`, effective reachability must remain false until that
start occurs.

Unlinking Telegram must not delete the user's topic choices. It should make the
channel unavailable while preserving preferences for an intentional relink.
Define and test the state returned when no current link exists.

## Frontend Contract

The Mini App may show the same three sections as the bot—Trading, Funds, and
Signals—but it must label them as Telegram delivery settings. It must not read
or overwrite browser pop-up values.

Document the route in OpenAPI and generate/use the repository's normal typed
client. The UI needs distinct states for:

- Telegram not linked;
- linked but bot not started or no longer reachable;
- reachable with all topics disabled;
- loading and failed preference updates.

Tracked-wallet scope/filter settings are intentionally not part of this first
API. Add them with the schema and behavior defined in
`backend-telegram-signal-subscriptions.md`, rather than exposing fields that do
nothing.

## Acceptance Criteria

- Bot and Mini App read and update the same preference row.
- Repeating the same PATCH returns the same state and does not move
  `enabled_at` again.
- Browser pop-up values do not change after a Telegram preference update.
- Unknown topics and invalid payloads return a validation error.
- An authenticated user cannot read or change another user's preferences.
- Linked, started/reachable, and enabled states are distinguishable.
- Enabling a topic cannot enqueue activity older than its new `enabled_at`.
- Concurrent partial PATCH requests do not lose unrelated topic values.
- OpenAPI and route/service tests cover defaults, authorization, unlink/relink,
  blocked/restarted bot behavior, and replayed writes.

## Out of Scope

- controlling Telegram chat sound or operating-system push settings;
- browser notification synchronization between devices;
- tracked-wallet rules before their backend behavior exists;
- Security and product-update topics;
- identity, wallet, signer, or trading-permission mutations through this API.
