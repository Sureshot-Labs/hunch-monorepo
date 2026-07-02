# Privy Telegram Mini App Auth Plan

Last updated: 2026-07-02

## Summary

Hunch already uses Privy as the user authentication provider, then exchanges a
Privy access token for a Hunch backend session. Adding Telegram login should fit
the existing auth bridge with a small frontend config change, provided Privy is
configured correctly in the Dashboard.

Mini App support is a broader product and platform task. The critical backend
work is not basic token verification. It is durable Telegram identity storage,
conflict handling, bot-to-user correlation, and cookie/session behavior inside
Telegram WebView and Telegram Web.

## Current Hunch Auth Shape

Frontend:

- `Hunch_App/src/providers/auth/AuthPrivyProvider.tsx` wraps the app in
  `PrivyProvider`.
- Current client-side Privy login methods are restricted to `["wallet",
  "email"]`.
- `Hunch_App/src/providers/auth/AuthProvider.tsx` watches Privy auth state,
  calls `getAccessToken()`, and posts to `/api/hunch/auth/privy`.
- `Hunch_App/src/app/api/hunch/auth/privy/route.ts` proxies the Privy access
  token to the backend and stores the returned Hunch session token in an
  HTTP-only cookie.
- `Hunch_App/src/app/api/hunch/_shared.ts` sets `hunch_session` and `hunch_csrf`
  cookies with `sameSite: "lax"`.

Backend:

- `apps/api/src/routes/auth.ts` exposes `POST /auth/privy`, `GET /auth/me`,
  logout, wallet, and venue credential routes.
- `apps/api/src/privy-service.ts` verifies Privy access tokens, fetches Privy
  users, and extracts EVM/Solana wallets.
- `apps/api/src/auth.ts` upserts local users and wallets, creates Hunch sessions,
  validates sessions, and enforces CSRF on mutating requests.
- `users.privy_user_id` is the stable Privy DID mapping.
- Local identity resolution order is:
  1. Existing `users.privy_user_id`.
  2. Existing linked wallet ownership.
  3. Email only with a manual recovery grant.

This is a good base for Telegram because Telegram users may not have an email.
The stable identity should remain the Privy DID.

## Privy And Telegram Requirements

Privy supports:

- Standard Telegram login through Telegram's login widget.
- Seamless zero-click Telegram login when the app is opened from a Telegram bot
  or Mini App context.
- `telegram` as a React SDK login method.
- `linkTelegram` from `usePrivy()` for linking Telegram to an existing Privy
  user.
- Telegram linked account fields on the Privy user object.
- Node SDK lookups by Telegram user ID and Telegram username.

Required Dashboard/BotFather setup:

- Create or choose a Telegram bot.
- Set the bot domain with BotFather.
- Enable Telegram authentication in the Privy Dashboard.
- Configure the bot token and bot handle in Privy.
- Enable seamless authentication for Mini App usage.
- Prefer a dedicated Privy app client for the Telegram Mini App if it needs
  separate bot credentials or seamless-auth settings.
- Add production app domains to Privy allowed origins.
- Add `http://web.telegram.org` and `https://web.telegram.org` to Privy allowed
  domains for Telegram Web Mini App usage.

If Hunch later enables CSP:

- Add `https://telegram.org` to `script-src`.
- Add `https://oauth.telegram.org` to `frame-src`.
- Keep existing Privy, WalletConnect, and RPC CSP allowances.

## Implementation Plan

### Phase 1: Basic Telegram Login

Goal: Telegram appears as a login option and creates a normal Hunch session.

Frontend:

- Add `"telegram"` to `loginMethods` in
  `Hunch_App/src/providers/auth/AuthPrivyProvider.tsx`.
- Optionally add `NEXT_PUBLIC_PRIVY_APP_CLIENT_ID` and pass `clientId` to
  `PrivyProvider` if using a Mini App-specific Privy app client.
- Keep the existing `AuthProvider` backend-session recovery flow:
  `Privy authenticated -> getAccessToken() -> /auth/privy -> Hunch session`.
- Verify the current embedded wallet creation flow still creates both EVM and
  Solana wallets for Telegram-only users.

Backend:

- No new auth endpoint is required for basic login.
- Keep `POST /auth/privy` as the backend trust boundary.
- Ensure `PrivyService.verifyTokenAndGetUser` handles Telegram-only Privy users
  after embedded wallets are available.
- Keep rejecting Privy users with no supported EVM/Solana wallet until product
  explicitly supports account-without-wallet states.

Tests:

- Frontend unit test for `AuthPrivyProvider` config including `telegram`, if the
  provider config is made testable.
- Backend test for a Privy user whose linked accounts include Telegram and
  embedded wallets.
- Manual QA:
  - standard Telegram login from a browser,
  - Telegram login from mobile browser,
  - logout and re-login,
  - invite-required flow,
  - wallet bootstrap and `/auth/me`.

### Phase 2: Telegram Identity Persistence

Goal: Hunch can reason about Telegram identities independently of the current
Privy user payload.

Recommended data model:

```sql
create table user_telegram_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  telegram_user_id text not null unique,
  username text,
  first_name text,
  last_name text,
  photo_url text,
  verified_at timestamptz,
  first_verified_at timestamptz,
  latest_verified_at timestamptz,
  raw_account jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index idx_user_telegram_accounts_user_id
  on user_telegram_accounts(user_id);

create index idx_user_telegram_accounts_username
  on user_telegram_accounts(lower(username))
  where username is not null;
```

Alternative: use a generic `user_linked_identities` table if we expect more
identity providers to need first-class backend lookup soon.

Backend changes:

- Add `PrivyService.extractTelegramAccount(privyUser)` or
  `extractTelegramAccounts(privyUser)`.
- During `AuthService.createOrUpdateUserFromPrivyWithClient`, upsert Telegram
  identity rows for the resolved local user.
- If a Telegram account is removed from Privy, decide whether to delete the
  local row or mark it inactive. Prefer hard delete for consistency with current
  wallet unlink sync unless bot audit/history needs retained rows.
- Add conflict handling:
  - If `telegram_user_id` is linked to another local user, return a terminal
    conflict error.
  - Do not match or merge local users by Telegram username. Usernames can
    change.
  - Treat Telegram user ID as stable and unique.
- Optionally include Telegram identity in `/auth/me` if frontend needs profile
  display or Mini App state.

Tests:

- Extract Telegram account from camelCase and snake_case Privy payloads.
- Upsert Telegram account for new user.
- Update Telegram username/photo/name on repeated login.
- Reject Telegram account conflict across users.
- Remove or mark inactive when Telegram is no longer in Privy linked accounts.

### Phase 3: Existing User Linking

Goal: Existing wallet/email users can attach Telegram without accidentally
creating duplicate Hunch users.

Frontend:

- Add a user action to link Telegram, likely in account/settings or wallet auth
  controls.
- Use `linkTelegram` from `usePrivy()`.
- For seamless linking inside a Mini App, pass Telegram launch params to
  `linkTelegram` if using `@telegram-apps/bridge`.

Backend:

- No separate endpoint is necessary if linking is completed in Privy and then
  synced through `syncWallets` or backend login refresh.
- Ensure the post-link sync path calls `/auth/privy` so local Telegram identity
  rows are updated.
- Add a recovery path for `telegram_conflict` similar to existing
  `wallet_conflict` and `email_conflict`.

Product:

- Strongly encourage a durable backup login method. Privy docs warn that users
  can lose access to social-only accounts and associated embedded wallets if
  their only login method disappears.

### Phase 4: Telegram Mini App Shell

Goal: Hunch works cleanly when launched inside Telegram.

Frontend:

- Add a Mini App bootstrap component if we need native Telegram behavior:
  - call Telegram WebApp ready/expand APIs,
  - track Telegram viewport, safe-area, theme, and platform values,
  - handle Telegram back button behavior,
  - detect Mini App context for analytics and UI tweaks.
- Keep the current first screen as the actual app, not a landing page.
- Verify mobile layout in Telegram WebView. Tailwind breakpoints are disabled in
  Hunch, so use existing mobile/desktop device routing patterns rather than
  `sm:`/`md:`/`lg:` classes.

Backend:

- No Telegram launch data should be trusted directly for Hunch authorization.
  Use Privy access token verification as the auth boundary.
- If storing Mini App launch metadata, store it as analytics/context only unless
  independently verified.

Session/cookie validation:

- Test `hunch_session` and `hunch_csrf` cookies in:
  - Telegram iOS,
  - Telegram Android,
  - Telegram desktop,
  - Telegram Web.
- Current cookies are `SameSite=Lax`. If Telegram Web embeds the app in a
  cross-site frame where cookies are not sent, add environment-configurable
  cookie settings for Mini App deployment:
  - `SameSite=None`,
  - `Secure=true`,
  - narrow domain/path as needed.
- Keep CSRF validation in place for mutating backend requests.

### Phase 5: Bot Launch And Deep Links

Goal: Telegram bot messages can open Hunch as a Mini App, not just as a browser
URL.

Current backend signal bot:

- `apps/api/src/services/signal-bot.ts` builds plain URL buttons with
  `inline_keyboard`.
- `TelegramInlineKeyboard` currently only types `{ text, url }`.

Backend changes:

- Widen Telegram inline button types to support `web_app` and/or `login_url`.
- Add config for Mini App launch mode:
  - plain URL,
  - Telegram `web_app`,
  - Telegram `login_url`.
- For private bot chats, prefer `web_app: { url }` to launch the Mini App.
- Keep plain URL fallback for channels/groups/platforms where `web_app` is not
  available.
- Add tests around generated `reply_markup` for URL and Mini App modes.

Operational setup:

- Configure bot menu button or main Mini App in BotFather if we want
  `t.me/<bot>/<app>` or `startapp` entrypoints.
- Ensure the app URL sent by the bot matches the domain configured in BotFather
  and Privy.

## Backend-Specific Design Notes

### Auth Boundary

Do not authenticate Hunch requests directly from Telegram launch params. The
backend should continue to trust only:

- Hunch session JWT plus active `user_sessions` row, or
- Privy access token on `POST /auth/privy`.

Telegram launch data can help Privy seamless auth or be stored as analytics, but
it should not replace Privy token verification.

### User Matching

Keep matching stable and conservative:

- Privy DID is the primary account key.
- Wallet ownership remains a valid fallback for old users and linked-wallet
  continuity.
- Telegram user ID can be a conflict detector and bot correlation key after it
  is synced from Privy.
- Telegram username must not be used as an account ownership key.
- Email-only recovery behavior should remain manual.

### Wallet Requirement

The current backend requires at least one supported wallet from Privy. Telegram
login should keep this requirement unless product wants a non-trading account
state.

If non-wallet accounts are allowed later, the backend and frontend need broader
changes:

- `POST /auth/privy` must allow session creation with no primary wallet.
- `user_sessions.wallet_address` must become nullable or use a separate active
  account scope.
- Many private routes currently expect `request.walletAddress`.
- UI needs an account state that can browse but not trade.

This is not recommended for the first Telegram rollout.

### Bot Correlation

If the existing signal bot evolves into user-specific trading or portfolio
commands, it needs a reliable local mapping:

- Telegram message has `msg.from.id`.
- Privy Node SDK can look up a Privy user by Telegram user ID.
- Hunch should then map Privy DID or synced `telegram_user_id` to local
  `users.id`.
- Commands that mutate funds or trading state should still require a Hunch auth
  session or an explicit signer/delegation model, not just possession of a
  Telegram chat.

## Rollout Checklist

Pre-code:

- Confirm production domain for Telegram Mini App.
- Confirm whether we use existing Telegram signal bot or a new auth/Mini App
  bot.
- Configure BotFather domain.
- Configure Privy Telegram auth.
- Decide whether to use a separate Privy app client and client ID.

Code:

- Add `telegram` login method.
- Add optional app client ID support.
- Add Telegram identity extraction and storage.
- Add conflict error handling.
- Add Mini App bootstrap only if required for first release.
- Add signal bot Mini App button support if launching from bot messages.

QA:

- Standard browser Telegram login.
- Telegram Mini App seamless login.
- Existing user links Telegram.
- New Telegram-only user gets embedded EVM and Solana wallets.
- Invite-required and invite-prompt policies.
- Logout clears Hunch and Privy state.
- `/auth/me` works after reload inside Telegram.
- CSRF-protected mutation works inside Telegram.
- Signal bot buttons open expected destination.

Ops:

- Add any new env vars to `.env.example` and prod secret bundles.
- Update deploy notes if Mini App cookie settings differ from normal web.
- Monitor `/auth/privy` errors by status and terminal error code.
- Monitor invalid/no-wallet Privy users after enabling Telegram.

## Rough Estimate

- Basic Telegram login: 0.5 to 1 day, excluding Dashboard/BotFather access.
- Backend Telegram identity persistence: 1 to 2 days.
- Mini App UX shell and QA: 2 to 4 days.
- Signal bot Mini App launch support: 0.5 to 1.5 days.
- Cookie/session hardening and cross-platform QA: 1 to 2 days.

## Open Questions

- Should Telegram be available on normal web login immediately, or only inside
  Telegram/Mini App contexts?
- Should we require users to link email/passkey after Telegram login before
  larger trading actions?
- Do we use the existing signal bot token for auth/Mini App launch, or create a
  separate bot?
- Should Telegram identity be returned from `/auth/me`, or only stored
  backend-side for bot correlation and support?
- Are we willing to set `SameSite=None` for Hunch session cookies in a Mini App
  deployment if Telegram Web requires it?

## References

- Privy Telegram login:
  https://docs.privy.io/authentication/user-authentication/login-methods/telegram
- Privy access tokens:
  https://docs.privy.io/authentication/user-authentication/access-tokens
- Privy React setup:
  https://docs.privy.io/basics/react/setup
- Privy app clients:
  https://docs.privy.io/basics/get-started/dashboard/app-clients
- Privy allowed domains:
  https://docs.privy.io/recipes/react/allowed-domains
- Privy CSP guidance:
  https://docs.privy.io/security/implementation-guide/content-security-policy
- Privy Telegram bot recipe:
  https://docs.privy.io/recipes/telegram-bot
- Telegram Mini Apps:
  https://core.telegram.org/bots/webapps
- Telegram InlineKeyboardButton:
  https://core.telegram.org/bots/api#inlinekeyboardbutton
