# Telegram Bot and Channel UX Plan

Status: channel renderer, private bot navigation, notification Settings,
transactional delivery, and exact-market portfolio signals implemented locally;
production rollout, device QA, and advanced subscriptions remain  
Scope: the private Hunch bot UI and public Telegram signal posts  
Out of scope: redesigning channel administration and signal selection logic

Backend handoff: `docs/telegram/backend-tasks.md`. This document is product and
UX context, not a backend implementation ticket.

## Goal

Make Hunch feel native to Telegram instead of exposing backend commands and raw
data as chat messages.

The private bot should behave like a small application with button-first
navigation. Public channel posts should behave like edited information posts:
they need an immediately readable hierarchy, a compact data block, contextual
Mini App links, and one clear call to action.

Success means that a user can:

- understand a post in a three-second scan;
- distinguish the thesis, market, evidence, and conclusion without reading a
  wall of text;
- open the relevant Hunch Mini App route without being sent to
  `app.hunch.trade`;
- see one unambiguous post CTA;
- use the private bot without learning slash commands;
- always go Back, Home, or Cancel during a multi-step bot flow.

## Product Principles

1. **One screen, one purpose.** A menu screen or channel post must have one
   primary job and one primary CTA.
2. **Hierarchy before decoration.** Native blocks, whitespace, line length,
   tables, dividers, and emphasis carry structure. Emoji are labels, not
   confetti.
3. **Headlines are content, not links.** A headline must remain high-contrast
   and readable. Links belong to contextual nouns or action phrases.
4. **Buttons are for actions.** Background information such as a wallet or
   market page belongs in the post body. It does not compete with `Buy`.
5. **Mini App first.** Every production Telegram link to a Hunch market,
   wallet, settings page, or trade flow must be a `t.me/...startapp=...` deep
   link or a `web_app` button in a private chat.
6. **Commands are fallback entry points.** Buttons are the primary UI. Slash
   commands remain for Telegram discovery, deep links, and power users.
7. **Events create messages; navigation edits them.** Signals, trade receipts,
   and durable results may create new messages. Menu navigation edits the
   current menu message in place.

## Research Notes

Telegram supports native inline keyboards, reply keyboards, command scopes,
menu buttons that launch Mini Apps, and regular-message formatting including
bold, italic, inline links, spoilers, code, and blockquotes:

- [Telegram bot features](https://core.telegram.org/bots/features)
- [Telegram Bot API formatting options](https://core.telegram.org/bots/api#formatting-options)
- [Telegram Mini Apps launched from the menu button](https://core.telegram.org/bots/webapps#launching-mini-apps-from-the-menu-button)
- [Practical button-first bot UX patterns](https://gramio.dev/guides/ux-patterns)

Bot API 10.2 introduced Rich Messages with headings, dividers, structured
lists, tables, and richer block types on July 14, 2026. Signal posts now use
`sendRichMessage` as their primary delivery path. The renderer emits native
paragraphs, inline bold/link entities, bordered striped metric tables, and
dividers. The previous `MarkdownV2` output remains a delivery fallback while
the new surface is verified across Telegram clients.

Public information-channel patterns reviewed for this plan:

- [Watcher Guru](https://t.me/s/watcherguru) uses a stable alert label and one
  short fact, making each post recognizable before it is read.
- [Bloomberg](https://t.me/s/bloomberg) generally leads with one concise claim,
  adds only the context needed to understand it, and places the destination
  link in the story rather than turning every headline into UI chrome.
- [Wu Blockchain](https://t.me/s/wublockchainenglish) frequently uses a
  title-like first line followed by a compact explanatory paragraph and a
  discreet source link.
- [unfolded.](https://t.me/s/unfolded) is an extreme example of one-insight-per-
  post and contextual action links.

Hunch should not copy any one channel's visual identity. The useful shared
pattern is a stable content grammar: recognizable label, standalone headline,
short evidence, interpretation, then a quiet source/action area.

## Baseline Before This Work

### Private bot

The following bullets record the implementation that motivated the redesign;
the Phase 2 status below describes what is now implemented.

- `/start` and public `/help` return plain text from `publicHelpText`.
- Admin `/help` is a long list of slash commands.
- A global authorization gate blocks every command except `/start` and
  `/help` for non-admin users. This also blocks personal trading commands even
  though those commands perform their own user and private-chat checks.
- The bot does not call `setMyCommands` or `setChatMenuButton`.
- The send-message type only accepts `TelegramInlineKeyboard`; it does not
  model `ReplyKeyboardMarkup`, `ReplyKeyboardRemove`, or `ForceReply`.
- Inline callbacks exist, but their router is currently trading-specific and
  uses the `hbt:*` namespace.
- The Telegram client already supports `answerCallbackQuery` and
  `editMessageText`, so the main primitives for an app-like menu exist.

Relevant code:

- `apps/api/src/services/signal-bot.ts`
  - `SignalBotCommand`
  - `handleSignalBotCommand`
  - `publicHelpText` / `helpText`
  - `TelegramInlineKeyboardButton`
  - `TelegramBotApiClient`
- `apps/api/src/services/telegram-bot-trading-client.ts`
  - `TELEGRAM_BOT_TRADING_CALLBACK_PREFIX`

### Channel posts

The current problems are produced deliberately by the renderer rather than by
Telegram itself:

- `buildSignalBotMessage` turns the title into a bold inline link pointing at
  the web application.
- `createSignalBotBodyTextRenderer` can link a wallet mention, but it receives
  the web `holderUrl`, so the body link points at `app.hunch.trade` even when
  Mini App deep links are configured for buttons.
- `buildSignalBotLinkRow` adds Wallet and Open market buttons after the Buy
  button.
- `buildSignalBotFollowthroughKeyboard` always appends Open market after
  conditionally adding Buy.
- `buildSignalBotFollowthroughMessage` escapes every completed line as plain
  MarkdownV2. It therefore cannot express bold values, italic interpretation,
  or a quote-style metric block.
- `formatSignalBotFollowthroughActivityLine` compresses several distinct
  wallet states into one long line.
- The generic Telegram renderer in `signal-delivery.ts` is also intentionally
  flat and does not model semantic sections.

Useful existing primitives:

- `buildSignalBotMarketStartParam`
- `buildSignalBotBuyStartParam`
- `buildSignalBotHolderStartParam`
- `buildSignalBotMiniAppEventUrl`
- `buildSignalBotMiniAppTradeUrl`
- `buildSignalBotMiniAppHolderUrl`
- `buildSignalBotTelegramButton`

The start-param and Mini App URL layer already exists. The problem is that it
is only consistently used by buttons, not by links rendered inside message
bodies.

---

## Part 1: Private Bot Menu

### Target interaction model

Use a hybrid model:

1. The Telegram chat menu button says `Open Hunch` and launches the Main Mini
   App.
2. `/start` and `/menu` render the bot home screen with an inline keyboard.
3. Inline callbacks drive nested navigation and edit the same message.
4. A short scoped command list remains as a fallback.
5. Admin operations live behind a separate dynamically visible `Admin` entry
   and separate Telegram command scope.

Do not build the primary navigation as buttons whose visible labels are slash
commands. A Telegram Reply Keyboard sends its visible label as a user message;
it cannot display `Performance` while secretly sending `/stats`. Friendly
labels should route to shared intent handlers directly.

### Home screen

```text
🔮 Hunch

Market signals and trading without leaving Telegram.

[          💸 Trade a market          ]
[             👤 My trading             ]
[               Open Hunch               ]
[               ⚙️ Settings               ]
[            ❓ How it works            ]
```

This is deliberately smaller than the bot's full capability set. The regular
user home screen should expose only common user intentions, not every backend
command or every report the system can produce.

- `Trade a market` immediately starts market-link input; it does not add an
  intermediate screen with another button for the same action.
- `My trading` shows the user's connection, permission, and trade status.
- `Open Hunch` launches the Main Mini App through a `web_app` button.
- `Settings` controls real notification topics and links to trading
  permissions.
- `How it works` explains signals and the confirmation-based trade flow.
- `Admin` is appended only for allowlisted operators and opens a separate
  operational menu.

Do not add `Latest signal` to the regular home screen. The channel is the
signal feed, so repeating a single latest item in private chat has no clear
job. Do not expose global `Performance` until its audience, data semantics, and
product value are explicitly approved. Settings should remain a top-level
destination only while it contains real user controls; notification topics and
trading permissions now justify it.

### Navigation semantics

- `Back` returns to the known parent screen.
- `Home` returns directly to the root menu.
- `Cancel` aborts a pending input or transaction and clears its transient
  state.
- Every non-root screen has Back.
- Every screen deeper than two levels has both Back and Home.
- Destructive actions use a separate confirmation screen with the safe action
  first.
- Every callback calls `answerCallbackQuery` immediately, before doing slow
  work.
- A stale or unknown callback redraws Home with a small explanation instead of
  ending in a dead button.

Suggested callback namespace:

```text
hm:v1:home
hm:v1:trading
hm:v1:trading:market_input
hm:v1:settings
hm:v1:settings:notifications
hm:v1:ntf:fill:{on|off}
hm:v1:ntf:issues:{on|off}
hm:v1:ntf:resolution:{on|off}
hm:v1:ntf:position_signals:{on|off}
hm:v1:help
hm:v1:admin
hm:v1:admin:help
hm:v1:admin:test_signal
hm:v1:performance:24h
hm:v1:performance:7d
hm:v1:performance:30d
```

Keep `hbt:*` exclusively for existing trading intents such as Buy, Sell,
Confirm, and Cancel.

The performance routes currently belong to the admin surface. Keeping them in
the namespace does not make them public; every admin callback is authorized on
the server again even if someone constructs callback data manually.

### Admin performance screen

```text
📊 Signal performance

Choose a period.

[ 24h ] [ 7d ] [ 30d ]
[ ⬜ Detailed report ]

[ ◀ Back ] [ 🏠 Home ]
```

Selecting a period or toggling detail edits the same message. The toggle label
shows its current state (`⬜` or `✅`).

### My trading screen

Ready state:

```text
👤 My trading

Account: Linked
Bot trading: Enabled
Wallet permission: Active

[ Enter market link ]
[ Trading status ] [ Trading permissions ]

[ ◀ Back ] [ 🏠 Home ]
```

Not-linked state:

```text
👤 My trading

Connect Telegram to your Hunch account before trading in the bot.

[ Connect Hunch account ]
[ ◀ Back ] [ 🏠 Home ]
```

`Enter market link` starts a short input flow:

```text
Send a Hunch, Polymarket, Kalshi, or Limitless market URL or ID.

[ ✕ Cancel ]
```

Use `ForceReply` plus a Redis state keyed by chat and Telegram user, such as
`awaiting_market_ref`. Clear it on success, Cancel, Home, timeout, or a new
top-level command. The state should have a short TTL.

### Commands and authorization

Register a short public command list via `setMyCommands`:

- `/start` — open the main menu;
- `/menu` — open the main menu;
- `/settings` — open notification and permission settings;
- `/help` — explain the bot.

Register admin commands under an admin/chat-specific scope. Command scopes are
presentation only; backend authorization remains mandatory.

Replace the global “everything except start/help is admin-only” check with a
per-intent policy:

- public navigation and explicitly approved read-only actions;
- personal trading actions authorized by Telegram-user/account binding and
  trading policy;
- admin operations authorized by the existing admin allowlist.

Do not expose a button until the corresponding policy decision is explicit.
For example, determine whether global signal performance is public before
making `Performance` available to all users.

### Bot implementation tasks

- Add `/menu`, `/settings`, and approved public actions to command parsing.
- Add `setMyCommands`, `getMyCommands` for diagnostics, and
  `setChatMenuButton` to `TelegramBotApiClient`.
- Expand reply-markup types to include inline keyboard, reply keyboard,
  keyboard removal, and Force Reply.
- Create a pure screen renderer returning text and inline keyboard from a
  typed route.
- Create one `sendOrEditBotScreen` path shared by slash commands and callbacks.
- Route `hm:v1:*` before the existing trading callback parser.
- Add transient input-state storage with TTL for market URL/ID entry.
- Add per-intent authorization instead of the current global admin gate.
- Configure the production menu button to open the Mini App.
- Keep navigation messages free of web previews.

### Bot acceptance criteria

- `/start` shows a short hero and buttons, not a command list.
- A normal user can complete every exposed flow without typing a slash command.
- No non-root menu screen is a dead end.
- Menu navigation edits a single message and immediately clears the Telegram
  callback spinner.
- Admin-only entries are absent for regular users and still protected on the
  server if called directly.
- Expired callbacks and expired input state recover to a usable screen.
- The menu button launches the Hunch Mini App.
- Tests cover routing, authorization, Back/Home/Cancel, stale callbacks,
  message editing, and command scopes.

### Next capability: notification settings

The first menu pass intentionally omitted Settings because no user-editable
preference model or Telegram notification delivery existed behind it. Settings
becomes a real destination once the bot can deliver and control the following
events:

- an order was filled;
- an order failed, expired, or was cancelled;
- a held position resolved as a win or loss;
- a new Hunch signal concerns a market in the user's portfolio.

Implementation status (July 15, 2026): Settings, `/settings`, per-topic
preferences, the durable Telegram outbox, activity renderers, retries,
blocked-user handling, and exact-market position-signal fan-out are
implemented. Migration rollout and live Telegram/database QA remain. Trusted
cross-venue position-signal matching and exact resolution PnL remain future
work.

Settings is restored to the regular Home in the same change as its backend
behavior, rather than shipping an empty screen. The resulting Home is:

```text
🔮 Hunch

[          💸 Trade a market          ]
[             👤 My trading             ]
[               Open Hunch               ]
[               ⚙️ Settings               ]
[            ❓ How it works            ]
```

### Settings information architecture

The frontend Settings implementation is the product baseline, but it should
not be copied into Telegram mechanically. It currently has five sections:

- `Account`: current identity and wallet, email, and Telegram sign-in methods;
- `Telegram trading`: bot access, authorized internal trading wallets, venues,
  and the maximum buy amount;
- `Wallets`: connected wallets, aliases, active-wallet selection, balances,
  and unlink actions;
- `Notifications`: browser pop-ups and the `Security`, `Funds`, `Trading`, and
  `System` category filters;
- `Signals`: tracked-wallet pop-up scope (`Following`, `Active wallet`, or
  `All tracked`) and filter (`Positive PnL` or `All activity`).

The browser notification and signal choices are currently device-local
`localStorage` settings. They are not account-level notification preferences.
Telegram notification preferences are server-side and must remain independent
per delivery channel. The shared part should be the vocabulary and event
classification, not one boolean that unexpectedly changes both browser and
Telegram delivery.

The frontend exposed a real taxonomy mismatch: Settings described `Funds` as
“Bridge, deposit, payout”, while `deposit_received` declared
`category: system` and the notification view model mapped deposit types to
`System`. This work now emits `category: funds` and maps deposits into the
frontend funds/payouts notification group.

The target bot Settings home is:

```text
⚙️ Settings

[ 🔔 Notifications ]
[ 📡 Signals ]
[ 👤 Account ]
[ 🤖 Telegram trading ]
[ ◀ Back ]
```

This preserves the frontend's semantic separation while adapting it to a chat
surface:

- `Notifications` contains transactional account activity, not signal rules;
- `Signals` contains portfolio and tracked-wallet intelligence preferences;
- `Account` is a read-only status screen with Mini App actions for account and
  wallet management;
- `Telegram trading` opens the existing Mini App settings route for venues,
  signer permissions, and maximum buy amount;
- `Wallets` is not a fifth bot-native settings screen. Connecting, switching,
  renaming, or unlinking wallets is security-sensitive and belongs in the Mini
  App. A `Manage wallets` action can live inside `Account`.

Do not implement email connection, wallet unlinking, Telegram unlinking, or
signer revocation as one-tap inline callbacks. Show status in the bot, then
open the authenticated Mini App flow for the mutation and its confirmation.

The target Notifications landing screen is grouped by meaning instead of
showing an unstructured list of every event:

```text
🔔 Notifications

[ 📈 Trading · 3/3 on ]
[ 💰 Funds & payouts · 3/3 on ]
[ 🛡 Security · 1/1 on ]
[ 📣 Product updates · Off ]

[ ◀ Back ] [ 🏠 Home ]
```

Each category opens a child screen with explicit topic toggles:

| Section         | Topics                                                         |
| --------------- | -------------------------------------------------------------- |
| Trading         | Order fills, order problems, position results                  |
| Funds & payouts | Deposits received, bridge/transfer results, payouts/rewards    |
| Security        | Account, wallet, Telegram-link, and trading-permission changes |
| Product updates | Non-transactional Hunch announcements                          |

`Deposit received` should be enabled by default. It is a high-value,
low-volume confirmation and the backend already emits a durable
`deposit_received` event. Delivery must happen only after the existing deposit
finality/idempotency path has accepted the event; the bot must not invent a
second deposit detector.

Only terminal, decision-useful events should notify by default. Do not send
both `trade_executed` and `order_filled` for one user action, intermediate
bridge polling states, or reward-submitted noise. Product updates should be
off by default and should not appear as a working toggle until a real producer
and consent policy exist.

The target Signals screen is separate:

```text
📡 Signals

Portfolio
[ ✅ Signals for markets I hold ]

Tracked wallets
[ ⬜ Tracked-wallet signals ]
[ Scope · Following ]
[ Filter · Positive PnL ]

[ ◀ Back ] [ 🏠 Home ]
```

`Signals for markets I hold` is implemented today for exact unified-market
matches. Tracked-wallet Telegram delivery, server-side scope/filter settings,
trusted cross-venue matching, and per-market follow/mute controls remain
backend tasks. Tracked-wallet Telegram delivery should be opt-in because its
event volume is materially higher than transactional activity.

Quiet hours, signal digests, per-market mutes, and a temporary signal pause are
useful later additions. They should be applied to signal/intelligence delivery
first. Telegram users already control chat sound and OS push behavior in the
Telegram client, so a fake bot-side `Sound` switch should not be added.

The target Account screen is status plus safe deep links:

```text
👤 Account

Hunch account: Linked
Telegram: @username
Primary wallet: 0x12…89ab

[ Manage account ]
[ Manage wallets ]

[ ◀ Back ] [ 🏠 Home ]
```

Current implementation status (July 15, 2026): the bot Settings home contains
`Notifications`, `Signals`, `Account`, and the `Telegram trading` Mini App
link. Notifications has separate Trading and Funds & payouts screens; Signals
contains portfolio-market signals; Account exposes safe Mini App links. Seven
server topics are implemented: order fills, order problems, position results,
deposits, bridge results, payouts/rewards, and portfolio signals. Security
events, tracked-wallet delivery, and product updates remain unavailable rather
than appearing as fake toggles. Remaining backend tasks are indexed in
`docs/telegram/backend-tasks.md`.

The implemented notification screens edit the same menu message when a toggle
changes:

```text
🔔 Notifications

Trading
[ ✅ Order fills ]
[ ✅ Order problems ]
[ ✅ Position results ]

Funds & payouts
[ ✅ Deposits received ]
[ ✅ Bridge results ]
[ ✅ Payouts & rewards ]

[ ◀ Back ] [ 🏠 Home ]
```

Use explicit topic labels rather than one ambiguous master switch. Category
rows summarize and navigate; they must not secretly toggle every child topic.

Suggested compact callback namespace:

```text
hm:v1:settings
hm:v1:settings:notifications
hm:v1:settings:notifications:trading
hm:v1:settings:notifications:funds
hm:v1:settings:notifications:security
hm:v1:settings:signals
hm:v1:settings:account
hm:v1:ntf:fill:{on|off}
hm:v1:ntf:issues:{on|off}
hm:v1:ntf:resolution:{on|off}
hm:v1:ntf:deposit:{on|off}
hm:v1:ntf:bridge:{on|off}
hm:v1:ntf:payout:{on|off}
hm:v1:ntf:security:{on|off}
hm:v1:ntf:position_signals:{on|off}
hm:v1:ntf:tracked_wallet_signals:{on|off}
```

Telegram callback data is intentionally kept short. Every toggle must resolve
the Telegram account to a Hunch user and authorize the write on the server;
the visible button state is not an authorization boundary.

### Backend implementation status and handoff

The local worktree now contains the durable preference/outbox delivery path,
seven topic controls, transactional renderers, and exact-market portfolio
signal fan-out described earlier in this plan. These changes still require a
production migration, deployment ownership, observability, and device QA.

Remaining backend work is intentionally maintained as bounded task documents:

- Signal Post V10 backend completion and rollout (legacy filename retained):
  `backend-signal-post-copy-v4.md`;
- typed holder-research update delta and canonical identity:
  `backend-holder-research-update-contract.md`;
- durable public-channel registry and cursor:
  `backend-signal-channel-registry.md`;
- rollout and operations: `backend-telegram-notification-rollout.md`;
- authenticated Mini App preferences API:
  `backend-telegram-notification-preferences-api.md`;
- verified resolution payout/PnL:
  `backend-position-resolution-accounting.md`;
- reviewed cross-venue equivalence: `backend-trusted-market-mappings.md`;
- tracked-wallet, per-market, and cross-venue subscriptions:
  `backend-telegram-signal-subscriptions.md`;
- future security producers: `backend-security-notification-events.md`.

`backend-tasks.md` is the canonical handoff index and records task order,
dependencies, migration ownership, and work that must not be reimplemented.

---

## Part 2: Channel Post Content System

### Content grammar

All posts share a notification-first headline and restrained formatting, but
they must not share one rigid vertical template. The final block answers a
different user question for each message family:

| Family          | What is new?                               | Supporting block                | Ending                          |
| --------------- | ------------------------------------------ | ------------------------------- | ------------------------------- |
| Initial signal  | Why this trade is interesting now          | Captionless position table      | Position table is terminal      |
| Research update | What materially changed since the signal   | Captionless current-state table | Current-state table is terminal |
| Follow-through  | How price and tracked wallets have evolved | Captionless since-call table    | Since-call table is terminal    |
| Resolution      | Whether the called side won or lost        | Captionless result table        | Result table is terminal        |

Common rules:

1. The standalone headline is the mobile notification lead and names the
   recognizable proposition plus the verified event.
2. The body explains the headline instead of restating it.
3. Only the smallest relevant evidence component is included.
4. Mini App links attach to meaningful nouns already present in the body.
5. Exactly one CTA class is selected by message state and safety policy.

Whitespace is structural. Rich signal posts keep the headline and its one or
two narrative steps in one paragraph block with explicit blank lines, then
finish with a native table. They do
not contain `U+2800`, zero-width characters, or decorative hyphen rules. The
legacy `MarkdownV2` fallback still owns its centralized `U+2800` separator
until client and rollout telemetry allow that fallback to be retired.

### Formatting vocabulary

Use Telegram Rich Message entities deliberately:

- **Marked text:** the editorial “thumbnail” hook. The explanatory
  continuation of the first line remains regular.
- **Bold:** decisive numeric facts in prose and table values, not whole
  paragraphs or generic section labels.
- _Italic:_ genuinely secondary metadata only; do not italicize an entire
  current-position or conclusion line.
- Table: a compact, captionless two-column proof card. Use bordered and striped
  rendering; keep human labels on the left and values on the right. The first
  row identifies and contextually links the market when it was not linked in
  the narrative.
- Divider: not used in short production signal posts. It remains available for
  future long-form sourced posts where two genuinely different sections need
  separation.
- Blockquote and pull quote: not used in signal posts. Both still communicate
  quotation semantics, while Hunch is presenting its own interpretation.
- Inline link: only on a market/outcome phrase or real wallet identity that
  already belongs in the sentence. Omit the link if no natural phrase exists.
- Monospace/code: only for literal IDs, hashes, or addresses that a user may
  copy. Do not use it for normal prices, PnL, or prose.
- Spoiler: only for genuinely hidden content, never as decoration.
- `────────`: reserved for a future source-rich editorial post type. Signal
  posts do not append a detached source/context footer.

Formatting must remain restrained. A post where every line is bold and begins
with an emoji has no hierarchy.

### Stable visual labels

Keep a small semantic vocabulary:

- `💰` — material net flow or a material tracked position;
- `🔥` — a strong fade/against angle or unusually strong confluence;
- `👀` — a performance-led or undernoticed angle when no more specific market
  icon fits;
- `🏆` / `⚽` / `🪙` — winner, matchup, and price-target stories;
- `⚠️` — cooling, thin follow-through, deterioration, or risk;
- `📈` — tracked buying or a positive market reaction; in a divergence title it
  classifies the leading `bought` event even when the continuation says price
  fell;
- `📉` — selling/outflow or a price-only adverse move;
- `🏁` — resolved result;

Use one leading status marker in the hook. Do not add a second `📍` market block
when the headline already identifies the proposition. Metric rows should not
each receive a random emoji.

### Headline rules

- The headline is standalone and never a hyperlink. Only its short hook is
  marked; the market explanation remains regular weight.
- Use sentence case.
- Treat the first line as the mobile push-notification preview, not only as the
  heading of an opened post.
- Build it like a YouTube thumbnail plus title on one line: the marked hook is
  truthful cover copy; the plain continuation delivers the payoff.
- Put a strong meaningful number first when it is the best hook, but compare it
  against human tension first. `22 early wallets are cashing out` can be more
  powerful than `+50¢ / +$1M`, while `+$542K in 30 days` can be stronger than
  `$20.5K backs Spain`.
- Do not use one rigid title schema. Select among low probability, profitable
  minority versus crowd, favourite versus contrarian, unusually large stake,
  credible wallets staying through a loss, late-stage exits, and market
  movement against a holder.
- Prefer `July Fed “no change” jumps 11¢ to 91¢` over internal syntax such as
  `YES +11¢ on Fed: No change`.
- Use 80 visible grapheme clusters as an initial lint target, then establish a
  versioned budget from iOS/Android device fixtures. Rewrite the market
  proposition semantically; never truncate it into an ambiguous entity name.
- Select copy semantically from the underlying state. Do not rotate equivalent
  positive hooks by hash only for variety.
- A verified positive recent wallet PnL may lead a single-wallet or
  sharp-cluster initial signal because it establishes why the actor deserves
  attention. Estimated PnL never leads and its basis must be named explicitly.

Bad:

```text
[Sharp YES interest](https://app.hunch.trade/...)
```

Good when material flow is the strongest fact:

```text
💰 **+$67.7K bought.** Tracked money is building behind NO on BTC hitting
$57.5K in July.
```

Good when price is the strongest fact:

```text
📈 **+6¢ to 81¢.** NO on BTC hitting $70K in July moved with the call.
```

Reserve `🔥` for genuine confluence; a positive tick or initial call alone is
not fire-worthy.

### Follow-through redesign

Current output:

```text
🔥 More wallets are moving into this trade

📍 Fed Decision in July? · No change
Since the call:
+$1.1M net copy flow
32 wallets added · 32 trimmed · 4 exited · 64 still hold
YES: 80¢ → 91¢ (+11¢)
Est. open PnL: +$208K

The market moved with the call and tracked wallets have not fully faded it yet.
```

Rich V10 structure:

```text
⚠️ **+$67.7K bought. 8 wallets cut.** Tracked wallets remain split on NO on
BTC hitting $57.5K in July.

More tracked money entered, but the wallets behind the call are no longer
moving together.

The price barely moved, so the disagreement remains unresolved.

┌──────────────────────────────────┐
│ Market          BTC hitting $57.5K│
│ Net tracked flow        +$67.7K │
│ Wallet activity  5 added · 8 cut │
│ Still holding                 15 │
│ NO price          87¢ → 89¢ +2¢ │
│ Est. open PnL             +$1.6K │
└──────────────────────────────────┘
```

The box above documents a native bordered, striped Telegram table, not literal
text characters.

Recommended emphasis inside the rendered block:

- no `Since the call` caption; the headline and narrative already establish
  that this is an update;
- metric labels remain plain while important values are bold;
- adds, trims, and exits share one compact `Wallet activity` row; `Still
holding` remains separate;
- the price delta and estimated PnL value are bold;
- the conclusion explicitly reports mixed breadth, exits, adverse price, or
  thin evidence when present.
- gross wallet additions are not sufficient to publish: a small flow update is
  suppressed when trims/exits or adverse price contradict it. Material absolute
  flow or price movement may still publish, but its headline must describe the
  divergence instead of using `backs` or `builds behind`.

The interpretation belongs before the table and has no `Read:` label. It must
synthesize the state—especially mixed breadth, exits, adverse movement, or thin
evidence—while the terminal table verifies the exact figures.

### Initial-signal structure

```text
⚽ **+$542K in 30 days.** This wallet is backing Spain over Argentina.

Most tracked money is on Argentina, but this wallet is holding $20.5K on Spain.

The market prefers Argentina. This wallet does not.

┌──────────────────────────────────┐
│ Market       Spain over Argentina│
│ Position          $20.5K on Spain│
│ Spain price                   21¢ │
│ Wallet 30d PnL            +$542K │
└──────────────────────────────────┘
```

Rules:

- Do not link the hook or market heading.
- If a real public wallet identity appears naturally in the thesis, link that
  first meaningful mention instead of adding a generic Wallet button.
- If no safe identity or natural market phrase is available, omit that body
  link. Do not add a generic navigation footer.
- Do not add `Why it matters`, `Wallet edge`, or `Position` above the table.
  The table is already the visual boundary.
- Prefer human proof (`Position`, selected-side price, open PnL, aligned
  profitable wallets, 30-day PnL) over internal scoring such as `pts vs
market`.
- Include volume when trading activity is one of the facts that makes the
  wallet credible, or when unusual size/activity is itself the selected story;
  omit it from unrelated probability and crowd-disagreement cards.
- Avoid mechanically restating the whole title in prose, but allow the proof
  block to repeat the exact scoped metric behind rounded cover copy.
- A decisive metric may appear in the marked hook, narrative, and table when
  each appearance does a different job: attention, interpretation, and exact
  proof. Do not remove `still holding` or `hasn't backed away` merely because
  the position also appears in the table.
- If the title says `four wallets up nearly $1M`, the body must say that this is
  combined 30-day PnL and show the exact value. Attention in the headline and
  precision in the body are complementary, not competing rules.
- A cluster-side price must be scoped explicitly (`with NO at 92¢`), not left
  dangling after the event proposition.
- Do not add a deterministic “still holding” sentence after a headline that
  already leads with the position. The generated thesis must carry new
  explanatory value.
- Never describe a representative wallet position as aggregate cluster
  capital; scopes must remain explicit.

### Resolution and research-update structure

Resolved posts:

- use `🏁 Call side won` or `🏁 Call side lost` as the standalone hook;
- show entry, resolution, and result in a compact quote block;
- let the `Result` card end the post; do not append “closed green/red” prose
  that merely translates the same values;
- do not show Buy;
- do not show Open market unless there is a real, useful post-resolution route.

Research updates:

- are replies to the original signal, not standalone repetitions of it;
- derive the headline from a supported material delta, for example
  `📈 **+8¢ to 83¢.** NO on BTC hitting $70K in July moved with the call`,
  `💰 **+$8K added.** One tracked wallet increased its ... position`, or
  `⚠️ **2 fewer strong wallets. 5 remain.** Strong-wallet support for ... has
thinned`;
- use `🔎` only when the actual delta is new sourced external evidence;
- clearly explain the named change from the original signal;
- show a single wallet as `Wallet position: $78.4K on Under 2.5 · 59¢ now`;
- label a single holder's mark-to-entry result `Wallet open PnL`; when a price
  move since publication points in the opposite direction, state that the two
  values use different starting prices;
- show aggregate evidence as `Strong-wallet support: $2.8M on Spain · 5
strong wallets · 59¢ now`; never collapse both scopes into `Position now`;
- remove internal sports collection suffixes such as `- More Markets` before
  rendering, and keep total alias normalization idempotent;
- suppress literal `No summary.`; for totals, use a deterministic
  win-condition sentence when generated prose is unavailable;
- do not repeat `Why it matters`, track record, pricing edge, or
  volume already established in the parent signal;
- do not append `No cited external evidence was available` or a detached `📰`
  line;
- link a market phrase or `original signal` contextually in the body;
- show Buy only when the selected-side delta is positive and the normal
  execution/price-safety policy says it is currently actionable;
- otherwise show Open market for a useful open-market route;
- produce no notification when no supported comparable delta exists.

The current local compatibility layer supports side-matched price, position,
and strong-wallet-count deltas. It intentionally suppresses market-wide
`fresh_flow`, holder-set rotation, `force_recheck`, and legacy records without
a prior snapshot because those inputs cannot support honest directional copy.
Typed side flow, holder entry/exit, persistence after a material move, and new
external evidence remain backend-contract work.

### Link policy

Production channel posts must not contain direct `app.hunch.trade` links.

Use:

- `buildSignalBotMiniAppEventUrl` for market context;
- `buildSignalBotMiniAppHolderUrl` for a wallet identity/context link;
- `buildSignalBotMiniAppTradeUrl` for trade links when a URL button is needed;
- existing `web_app` routes in private chats where Telegram supports them.

Body link behavior:

- Build the Mini App holder URL before calling the body-text renderer.
- Do not pass the web `holderUrl` into `createSignalBotBodyTextRenderer` when a
  Mini App link is available.
- Do not use `marketUrl` to wrap `titleMarkdown`.
- Link an existing market/outcome phrase or wallet identity, not full
  headlines, full paragraphs, or generic footer labels.
- Disable link previews for compact channel posts unless a future post type is
  deliberately designed around a preview card.

Production should fail closed at the link level. If `telegramMiniAppLinkBase`
is missing or cannot encode a route, keep the informational post but omit the
affected body link or CTA and record a visible operational diagnostic. Do not
silently publish a web-app link. Non-production previews may retain an
explicit, visibly marked web fallback for debugging.

### CTA decision matrix

| State                                             | Inline keyboard                        |
| ------------------------------------------------- | -------------------------------------- |
| Executable Buy is available                       | Buy button(s) only                     |
| Positive actionable research delta                | Buy after normal price/execution guard |
| Neutral or negative research delta                | One `Open market` button               |
| Buy is unavailable, market is useful and openable | One `Open market` button               |
| Resolved/closed and no useful route               | No buttons                             |
| Wallet context exists                             | Body link only; never a Wallet button  |

Additional rules:

- When Buy exists, do not add Wallet or Open market buttons.
- A cheaper executable venue may appear as a second Buy option because it is
  the same CTA class. Limit the keyboard to the minimum useful choices.
- If the delivery target differs from the source market, body copy must make
  that routing clear; do not make users infer it from a venue label alone.
- Keep labels short and action-led, for example `Buy YES · 91¢`.
- Include the venue only when it prevents ambiguity or explains alternative
  execution.
- An Open market button must open the Mini App, never `app.hunch.trade`.

### Channel implementation status

Implemented locally: standalone semantic headlines, structured evidence cards,
mixed-state interpretations, contextual Mini App links, CTA selection,
copy-version audit, and deterministic renderer tests.

Remaining backend work:

1. Add reviewed canonical Telegram subjects/outcome aliases and typed evidence
   rows; see `backend-signal-post-copy-v4.md`.
2. Complete real-device/channel QA and approve versioned materiality policy;
   see `backend-signal-post-copy-v4.md`.
3. Persist the public-channel registry, cursor, and destination policy in
   Postgres; see `backend-signal-channel-registry.md`.

### Channel acceptance criteria

- No post headline is an inline link.
- With production Mini App configuration, message text and buttons contain no
  `https://app.hunch.trade` URL.
- Wallet and market links appear in meaningful body context.
- A post with Buy contains no Wallet or Open market button.
- A post without Buy and with an openable market contains exactly one Open
  market button.
- Follow-through metrics render as a visually grouped block, not as an
  unformatted paragraph.
- Wallet activity is not compressed into an unreadable single line for larger
  combinations of states.
- Formatting remains valid for apostrophes, parentheses, underscores, plus and
  minus signs, URLs, Unicode market titles, and very long outcome labels.
- Long titles wrap without destroying the relationship between market and
  outcome.
- The first line contains the strongest verified metric/result and recognizable
  market fragment within the notification headline budget.
- Every message stays within Telegram limits after escaping and link markup.
- Snapshot tests cover initial, follow-through, cooling, resolved win/loss,
  research update, Buy eligible, Buy ineligible, Mini App configured, and
  missing/invalid Mini App configuration.

## Visual QA Checklist

Automated string tests are not enough for Telegram formatting. Before rollout,
send real preview messages to a private test channel and inspect:

- iOS, Android, and Telegram Desktop;
- light and dark themes;
- narrow mobile width;
- short and long market titles;
- generic YES/NO and semantic outcomes;
- positive, negative, zero, missing, and very large values;
- single-wallet and wallet-cluster signals;
- Buy, cheaper Buy, Open market fallback, and no-button states;
- the actual Mini App destination reached from every body link and button.

The preview must be judged as a feed item, not only as an isolated message.
Send several different post families consecutively and verify that the stable
hierarchy makes them recognizable without making the channel visually noisy.

## Recommended Delivery Order

### Phase 1 — Content renderer and CTA cleanup

Implementation status (July 15, 2026): the renderer, Mini App body links, CTA
matrix, follow-through data block, and unit coverage are implemented. A live
preview pass on iOS, Android, and Desktop is still required before rollout.

- remove linked headlines;
- use Mini App links in message bodies;
- implement the CTA matrix;
- redesign follow-through metrics as a quote/data block;
- add snapshot tests and device preview fixtures.

This produces the largest visible channel improvement with limited product
policy risk.

### Phase 2 — Private bot navigation shell

Implementation status (July 15, 2026): the regular Home, /start, /menu, typed
hm:v1 navigation, Home/Back/Cancel, stale callback recovery, transient market
input, per-intent authorization, scoped Telegram commands, and the Mini App
menu button are implemented. Settings was added later together with real
notification behavior. Performance and operational tools are available only
inside the allowlisted admin menu.

- add menu routes and callback namespace;
- add `/menu`, scoped commands, and Mini App menu button;
- implement Home, Back, Cancel, editing, and stale callback recovery;
- separate public, personal-trading, and admin authorization.

### Phase 3 — Notification settings and transactional delivery

Implementation status (July 15, 2026): implemented in the API and signal-bot
runner with migrations 0177 and 0178 plus a fail-closed runtime policy. Local
integration QA passes; production migration rollout and live delivery QA remain.

- add durable per-topic Telegram preferences;
- restore Settings and `/settings` in the same release;
- add the delivery outbox and retry worker;
- deliver order fills/issues, position win/loss, deposits, bridge results, and
  payouts/rewards;
- recover the Telegram reachable state on `/start`;
- keep the regular Home small as the capability is added.

### Phase 4 — Position-aware signals

Implementation status (July 15, 2026): exact unified-market matching and
initial/research-update threading are implemented. Position signals default to
off and require opt-in. Cross-venue matching and per-market manual controls
remain.

- fan out initial and research-update signals for exact held markets;
- keep the verified signal delta as the only headline, then explain whether it
  supports or challenges the held side in one secondary line directly below;
- add per-user/note/kind dedupe and rate limiting;
- persist trusted cross-venue market and side mappings before expanding
  matching beyond exact unified market IDs;
- add per-market mute/follow controls after the global behavior is stable.

### Phase 5 — Measure and refine

Track by copy/render version:

- post button click-through;
- Mini App opens from body links versus buttons;
- Buy initiation and completion;
- menu entry and action completion;
- callback errors and stale-state recovery;
- post views/reactions where Telegram data is available.

Do not optimize for raw button count. The core metric is whether a user
understands the signal and reaches the intended next step with less ambiguity.
