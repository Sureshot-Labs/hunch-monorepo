# Telegram Mini App-only execution

## Behaviour

`signal_bot.miniAppHandoffMode = always` is strict: Telegram selects the
market, side and amount; the user signs through the existing Mini App v2
consumer. An unavailable handoff or web funding quote must not select a
delegated funding plan or server trade. The bot offers a retry or the ordinary
market screen instead. Direct bot redemption is likewise not offered in this
mode; redemption remains available in the app.

`fallback` and `off` retain their existing server execution rules and signer
caps. Switching the mode does not revoke keys, rewrite historical operations,
or stop reconciliation of transactions already sent. The final server submit
boundary rechecks the mode, including old v1 callback replay.

Mini App identity requires an active user, their current Telegram link and a
verified EVM controller with a Privy wallet identity. Existing verified bot
wallet bindings are retained; a user without a grant uses a managed wallet
profile. No authorization or preferences row is created to enable handoff.
This identity never grants unattended signing permission.

In `always`, effective `autoEnableOnTelegramLink` is false even if an older
runtime payload requests automatic setup. Explicit server grants are not
deleted. Wallet ownership, one-time consent, exact source/spend bounds,
reservation validation and pre-submit cancellation remain enforced.

The Hunch `maxTradeAmountUsd` remains a separate product ceiling. Mini App
v2 does not inherit the narrower delegated signer cap. It is not an unlimited
or unconfirmed execution mode.

## Production audit — 2026-09-04

Read-only inspection used the API's `run-with-secrets` bootstrap and fetched
the configured live Privy policies; no policies or secrets were changed.

- Backend image observed: `7bccb0d`; frontend: `ed9cc14`.
- Runtime policy revision: `ae47fc95-aa09-4a54-a00f-6a61fdf0e054`.
- Mode: `fallback`; contract: `2`; trading, receive and continuation enabled.
- Server venues: Polymarket; actions: Buy/Sell; Hunch maximum: $25.
- Configured combined policy fingerprint matches the live policy:
  `5f3f61f2904e5d334d2774325291d664b1d952f06201deb71141f549a202d969`.
- The combined policy contains trading, exact Relay token/network rules and
  Router funding rules, not only Polymarket order signing. Do not delete it
  wholesale as part of a delivery-mode change.
- API wallet credentials, automation authorization and Polygon/Base/Solana
  RPC secrets were present. This is not an audit of every user's attached
  signer, nor a guarantee of provider availability.

## Switch sequence (operator action; not performed by this change)

1. Deploy this backend change while retaining `fallback` and current secrets.
2. Verify existing direct Polymarket bot Buy/Sell and Limitless Mini App flows.
3. Inspect outstanding delegated funding/trades. Let already-authorized money
   movements reconcile; do not force-terminal them to change execution mode.
4. Set mode to `always`, keeping contract `2`, trading and ordinary Buy/Sell
   enabled; Buy also requires receive and continuation enabled. Keep Mini App
   links enabled. Explicitly set auto-enable false for an unambiguous payload.
5. Test new and opted-out accounts before separately considering signer-policy
   removal. Preserve Privy app credentials, relayer/sponsorship and any keys
   still required by withdrawals or previously authorized funding jobs.

## Verification matrix

- New linked user, no grant/preferences: card → Review → user-signed handoff.
- Existing enabled/disabled automation: same verified wallet; no extra grant
  prompt in `always`; existing direct bot path still available in `fallback`.
- Buy/Sell on Polymarket and Limitless; sufficient destination funds and a
  composite funding route; stale quote requires a fresh bounded Review.
- Missing Mini App capability or planner failure: retry/open market, zero
  delegated funding or server submission. No funds are requested on a guessed
  shortfall.
- Open twice, expire, cancel before venue submission, or switch delivery mode
  with an old card: no duplicate order; sent transactions still reconcile.
- Live smoke remains necessary: local tests do not contact real wallets or
  execute paid trades.
