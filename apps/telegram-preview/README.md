# Telegram preview

Local static replica of Hunch's Telegram screens for reviewing button colors and
navigation with a separate BotFather bot. It uses long polling and needs no
database, Redis, wallet, trading API or production deployment.

## Run

From the repository root, after the usual workspace dependency installation:

```sh
cp apps/telegram-preview/.env.example apps/telegram-preview/.env
# Set TELEGRAM_PREVIEW_BOT_TOKEN in that file to the separate bot's token.
node --import tsx apps/telegram-preview/src/main.ts
```

The root aliases `pnpm telegram:preview`, `pnpm telegram:preview:snapshots` and
`pnpm test:telegram-preview` are also available. The direct Node commands above
work without pnpm trying to reconcile an existing workspace installation.

Do not overwrite an existing `.env`. The app reads only its own ignored `.env`,
or explicitly named `TELEGRAM_PREVIEW_*` environment variables. It never loads
the repository's `.env`. The token is never logged. A bot with an existing webhook
is rejected without changing the webhook. Run only one polling process per bot.

Only the eight IDs in `src/config.ts` may use the bot, in private chats. The gate
checks the sender of every message and callback, including after a restart.
Groups, outsiders and inline callbacks are silently ignored. Sessions stay in
memory; old or forged buttons cannot navigate a different message or user.
Messages use Telegram's content-protection flag.

- `/start` — demo notice and the original home menu.
- `/scenarios` — catalog of static states, including trade/funding errors.
- `/colors` — switch native styles on/off for the current user's screens.
- `/reset` — home with colors enabled.

Search and custom inputs select predetermined sample data. No input changes
balances, notifications, invite codes or actual trades. Timestamps are fixed.
Deposit addresses are deliberately invalid. Stop with Ctrl+C; restart resets
sessions. The preview isn't part of the root `dev` task or production runners.

## Native Mini App buttons

Run `node --import tsx apps/telegram-preview/src/mini-app-server.ts` from the repository root to serve `mini-app/index.html` on
`127.0.0.1:8787`. Expose it through an HTTPS tunnel or host the static file on a
separate demo domain, put that URL in `TELEGRAM_PREVIEW_WEB_APP_URL`, and restart
the bot. Configure the test bot's Mini App/domain in BotFather if Telegram asks.
This page demonstrates opening the native window and the requested route; it is
not a copy of the full Hunch web application.

With an HTTPS URL configured, `web_app` and URL buttons retain their original
types, labels, layout, icons and colors, with destinations rewritten to the demo
page. Without one, those buttons show a configuration hint via callback. The
runtime never opens the original bot's button URLs or shares production invites.

## DRY snapshot workflow

```sh
node apps/telegram-preview/scripts/generate.mjs
node apps/telegram-preview/scripts/generate.mjs --check
node --import tsx --test apps/telegram-preview/src/preview.test.ts
```

`apps/api/src/telegram-preview` calls the existing production presenters with
fictional fixtures. The market card uses an in-memory query adapter, fake quotes
and an injected position reader; execution methods throw. The exporter runs in a
fresh subprocess with an allowlisted environment, disabled network access, a
fixed clock and deterministic callback IDs. It cannot inherit the bot token or
production connection credentials.

The reviewed output is `snapshots/screens.json`. This generated file includes
the regular and existing custom-emoji fallback renderings. Do not hand-edit it.
The runtime reads only this JSON and does not import API modules. Regenerate it
after Telegram UI changes; `snapshots:check` detects drift. This keeps menu
templates in one place without pulling business services into the preview.

Tests cover access control, cross-user/stale callbacks, recovery after failed
renders, colors, custom-emoji fallback, URL isolation, snapshot reachability and
Telegram keyboard limits. Telegram client appearance still needs manual review
on the devices used by the testers.
