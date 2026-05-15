# Agent / MCP Trading Access Plan

Last updated: 2026-05-15

## Goal

Let a user connect an AI coding/agent client such as Codex, Claude Code, or any
MCP-compatible client to their Hunch account so the agent can:

- search markets, events, market-map/discovery data, clusters, prices, and
  account state;
- inspect deposit addresses, balances, positions, orders, and bridge options;
- prepare trades, bridge actions, cancels, and redemptions;
- execute approved actions through the user's Privy-backed trading wallets when
  policy permits.

The important boundary: a skill is not an auth boundary. A skill can describe how
to use Hunch, but authenticated operations should run through an MCP server or
small local CLI that holds a limited agent token and calls Hunch's backend.

## Current Code Findings

Existing auth/session model:

- `apps/api/src/routes/auth.ts` logs users in through `POST /auth/privy`.
  The browser sends a Privy access token; the API verifies it, creates or updates
  the Hunch user, and returns a Hunch session token plus CSRF token.
- `apps/api/src/auth.ts` stores session tokens hashed at rest and validates them
  through `createAuthMiddleware()`.
- Non-GET authenticated calls require `x-csrf-token`.
- The selected wallet is the session wallet by default and can be changed with
  `X-HUNCH-WALLET`, but only to a wallet linked to the authenticated user.

Existing wallet/execution model:

- `Hunch_App/src/providers/auth/PrivyProvider.tsx` creates embedded Ethereum and
  Solana wallets for all users.
- `Hunch_App/src/hooks/trade/usePrivyAuthorizationRequests.ts` uses Privy's
  browser SDK to generate authorization signatures for prepared wallet API
  requests.
- `apps/api/src/routes/embedded-wallets.ts`,
  `apps/api/src/services/embedded-ethereum.ts`,
  `apps/api/src/services/embedded-solana.ts`, and
  `apps/api/src/services/embedded-privy.ts` already prepare and execute Privy
  wallet RPC requests, but execution requires a matching
  `privy-authorization-signature`.

Existing venue write paths:

- Polymarket private routes are mounted under `/trade/polymarket`.
  They prepare embedded wallet setup, sign CLOB orders, place signed orders with
  stored L2 credentials, sync/cancel orders, and enforce signer/funder checks.
- Limitless private routes are mounted under `/trade/limitless`.
  They prepare embedded wallet setup, sign orders, verify partner auth, place
  orders, handle AMM orders, and enforce selected-wallet signer/maker checks.
- Kalshi/DFlow routes are mounted under `/trade/kalshi` and `/trade/dflow`.
  They quote/prepare unsigned Solana transactions, submit signed transactions,
  and record executions while enforcing selected Solana wallet and policy checks.
- Bridge routes under `/bridge/*` quote and record bridge orders, validate linked
  sender wallets, and track submitted transaction hashes.

Existing policy/storage hooks:

- `user_trading_preferences` already has max order, position, and daily volume
  concepts, but trade routes do not yet provide one central policy gate for agent
  execution.
- `apps/api/src/services/runtime-policies.ts` is the existing pattern for
  runtime-configured product policy.

## Feasibility

Read-only agent access is straightforward. It can call existing public/read APIs
through a small MCP server with low-risk bearer credentials or no credentials
where endpoints are public.

Write access is feasible, but should not be implemented by handing an agent a
normal browser session token. That token has broad account power, depends on CSRF
behavior, and is not scoped to a specific wallet, venue, action, or spend limit.

Unattended execution is the hard part. Current embedded-wallet code requires a
Privy authorization signature for each prepared request. That signature is
generated client-side today. So there are two safe execution modes:

- confirmation-required: the agent creates an intent, the Hunch UI asks the user
  to approve, the browser generates the required Privy authorization signature,
  and the backend executes;
- policy-automated: allowed only after adding a proper delegated-signing or
  server-authorized Privy flow, with explicit user-created limits and revocation.

Until delegated signing is confirmed and implemented, the production v1 should
support automated research and preparation, not silent trade execution.

### Privy Signers Research Finding

Privy's current Signers / Additional Signers documentation confirms that a real
delegated signing layer exists for embedded wallets:

- users can allow an app server to sign requests with their embedded wallet;
- signing happens through Privy's infrastructure without exposing the user's
  wallet private key to Hunch or the agent;
- Hunch can configure an app authorization key / key quorum, add it as a signer
  to a user's wallet after user consent, and later send app-initiated
  transactions through Privy's Node SDK or REST API;
- Privy policies can constrain signer behavior with transfer limits,
  time-bound access, allowlists/denylists for networks, contracts, programs and
  recipients, and calldata / Solana-instruction rules.

Relevant docs:

- <https://docs.privy.io/wallets/using-wallets/signers>
- <https://docs.privy.io/wallets/using-wallets/signers/configure-signers>
- <https://docs.privy.io/wallets/using-wallets/signers/quickstart>
- <https://docs.privy.io/controls/policies/overview>

This changes the risk from "does delegated signing exist?" to "can our Privy
app configuration and each venue payload be safely constrained by the available
signer policies?" The Hunch plan should proceed assuming Privy Signers is the
preferred automation layer, while still shipping confirmation-required execution
before any unattended trade mode.

## Recommended Architecture

Add an agent gateway instead of exposing all existing private venue routes to MCP
directly.

```text
MCP server / skill wrapper / CLI
  -> Hunch Agent API
    -> existing read APIs
    -> existing quote/prepare/sign/place services
    -> existing Privy embedded wallet execution helpers
```

The gateway owns only cross-cutting concerns:

- agent authentication;
- scopes and wallet/venue/action limits;
- normalized intent creation;
- confirmation policy;
- idempotency;
- audit logs;
- dispatch into existing venue services.

It should not duplicate order building, venue authentication, bridge quoting, or
wallet execution logic that already exists.

## Dual MCP And Skill Design

A Hunch skill and a Hunch MCP server should be two entrypoints over the same
client library, not two separate integrations.

Skills are best treated as compact agent instructions plus optional helper
scripts. They provide:

- trigger metadata and short workflow guidance;
- safety rules, for example "quote before intent" and "do not claim execution
  unless the intent status is executed";
- command/tool selection guidance;
- optional scripts that call the installed Hunch agent CLI.

Skills should not own:

- OAuth/device-auth state;
- long-lived secrets;
- venue-specific request building;
- duplicated TypeScript API clients;
- signing or trade execution logic.

MCP should own the tool schema and runtime protocol. It provides stable tools to
Codex, Claude Code, and other clients:

- typed tool inputs and outputs;
- local token storage;
- device-code auth;
- policy-aware calls into the Hunch Agent API;
- redaction and error normalization.

The agent-facing code should live in a separate repo, for example
`hunch-agent-tools`, while the Hunch monorepo remains the source of truth for the
backend Agent API, DB migrations, auth, policy, and OpenAPI schema.

Recommended split:

```text
hunch-monorepo
  apps/api                # /agent API, auth, policy, signing, audit
  packages/db             # migrations and DB helpers
  openapi output          # generated contract consumed by agent tools

hunch-agent-tools
  packages/hunch-agent-client
    src/client.ts         # fetch wrapper, auth headers, retries, redaction
    src/types.ts          # generated API types once available; local types in Phase 1
    src/device-auth.ts    # device-code polling client
    src/tools.ts          # implementation functions: search, quote, intent, etc.
    src/token-store.ts    # keychain/file/env abstraction for local tokens
    src/errors.ts         # safe error shapes for agents

  apps/mcp-hunch
    src/server.ts         # MCP tool registration
    src/cli.ts            # CLI entrypoint sharing the same client package
    package.json          # binaries: hunch-mcp, hunch-agent

  skills/hunch-trading
    SKILL.md              # concise workflow and safety instructions
    agents/openai.yaml    # Codex UI metadata
    scripts/hunch         # tiny wrapper invoking bundled or installed CLI
    references/tools.md   # tool/command reference loaded only when needed
```

For the first external repo version, keep the deployable/package surface to two
units:

```text
packages/hunch-agent-client
apps/mcp-hunch
```

and expose the CLI as an extra binary from `apps/mcp-hunch`. The important DRY
rule is that MCP tools and skill scripts both call `hunch-agent-client`; neither
should hand-roll HTTP calls. The external repo should consume generated API
types from the monorepo and should not import Hunch backend packages directly.

Recommended runtime behavior:

1. If MCP tools are available, the skill tells the agent to prefer them.
2. If MCP is not available, the skill falls back to `hunch-agent` CLI commands.
3. If neither is available, the skill explains the required install/auth step
   and stops before any authenticated action.

This makes the skill useful in Codex while the MCP server remains the portable
integration for Claude Code and other clients.

### Separate Repo Boundary

Use a separate repo because MCP, CLI, and skill packaging have different release,
install, and user-support needs than the backend monorepo. This also keeps agent
clients from accidentally depending on internal backend modules.

The boundary should be:

- Hunch monorepo owns server behavior: `/agent/*`, database schema, auth,
  policy, signing, venue dispatch, OpenAPI generation, and production
  deployment.
- Agent tools repo owns client distribution: MCP server, CLI, skill files, local
  token storage, generated API client, and mocked-contract tests.
- The contract between repos is the public Agent API plus generated types.
- Breaking API changes must update the OpenAPI contract and agent-tools tests in
  the same feature branch or release sequence.

Do not duplicate venue logic in the agent-tools repo. It can validate request
shape and normalize local errors, but market semantics, quotes, transaction
payloads, wallet readiness, and execution decisions remain backend-owned.

### Current Implementation Status

As of 2026-05-13, Phase 1 is implemented in the separate
`hunch-agent-tools` repo for public/read-only workflows.

Implemented:

- PNPM/TypeScript workspace with project references, ESLint, Prettier, tests,
  build, and local release packaging.
- `packages/hunch-agent-client` with a shared fetch client, local token lookup,
  Zod input schemas, safe error shapes, response shaping, and read-only tool
  functions.
- `apps/mcp-hunch` with both binaries in one package:
  - `hunch-mcp` for MCP stdio;
  - `hunch-agent` for CLI fallback.
- Codex plugin metadata, MCP config, skill files, wrapper script, and local
  packaging artifacts.
- Read-only MCP/CLI surfaces for discovery search/browse, discovery top lists,
  market map, market/event detail, AGG/Hunch clusters, exact market
  alternatives, similar markets/events, holders, price history, tracking
  overview, wallet intel/activity/positions/series/signals, signals, and trades.
- Tests for client behavior, MCP tool registration/calls, CLI behavior, tool
  shaping, plugin packaging, and wrapper fallback behavior.

Packaging decisions made during implementation:

- The repo intentionally does not contain temporary account-specific homepage or
  repository URLs in public skill/plugin metadata.
- `plugin-dist/`, `skills/hunch-trading/bin/`, and `artifacts/` are generated
  local build outputs and are ignored by Git. Run `pnpm build` or
  `pnpm release:local` before local plugin or skill-only testing that needs
  bundled runtime files.
- For Phase 1, the tools call existing public Hunch APIs directly. They do not
  depend on `/agent/*`, device auth, private account state, or trading routes.
- Generated OpenAPI-derived types are still a future integration point. Until
  the Agent API contract exists, Phase 1 uses narrow local types and Zod schemas
  for the read-only public surface.

As of 2026-05-15, Phase 2A and Phase 2B authenticated read access are
implemented in code:

- `0106_agent_grants.sql` adds agent grants, short-lived device
  authorizations, and audit events.
- `apps/api/src/routes/agent.ts` exposes device start/token, browser
  approve/deny, grant list/revoke, audit, `/agent/me`,
  `/agent/notifications`, `/agent/wallets`, `/agent/wallet-balances`,
  `/agent/positions`, `/agent/positions/pnl`, `/agent/orders`,
  `/agent/orders/:id`, `/agent/venue-status`, `/agent/readiness`, and
  `/agent/deposit-targets`.
- `createAgentAuthMiddleware` validates HMAC-hashed bearer tokens, scopes,
  active grants, grant expiry, and linked-wallet ownership.
- `Hunch_App` has minimal `/agent/approve/:approvalToken` and
  `/settings/agents` surfaces through the existing browser-session proxy, plus
  typed frontend API helpers for the Phase 2B account-read routes.
- `hunch-agent-tools` has `auth login`, `auth status`, `auth list`,
  `auth use`, `auth logout`, multi-profile local token storage, and
  native MCP auth/profile tools (`hunch_auth_start_login`,
  `hunch_auth_complete_login`, `hunch_auth_status`,
  `hunch_auth_list_profiles`, `hunch_auth_use_profile`, and
  `hunch_auth_logout`). The CLI remains a fallback, not the only auth path.
- `hunch-agent-tools` has authenticated MCP/CLI account-read tools for
  notifications, wallets, balances, positions/PnL, orders/order detail, venue
  status, readiness, and deposit targets.
- Account tool descriptions now explicitly separate source-of-truth semantics:
  positions for displayed holdings, PnL for account totals, readiness for
  user-facing tradability, venue status for diagnostics, wallet balances for raw
  funding balances, account orders for authenticated fills/swaps, and public
  trades for market tape.
- Agent-tools compactness and payload controls have been tightened for tracking
  and wallet-intel tools: `tracking_overview` supports `sections`,
  `topWalletSections`, and `topMarketsLimit`; embedded wallet series in
  `wallet_intel` honors `seriesLimit`.

Still not implemented:

- Intent, trading, bridge, redemption, or delegated signing flows.
- Generated OpenAPI-derived client types for the external `hunch-agent-tools`
  repo boundary.
- Full automated install/release path for public npm/plugin distribution beyond
  local release artifacts.

### Skill Runtime Wrapper And Session

The skill can include a runtime wrapper, but that wrapper should be a thin CLI
shim. It should not have its own auth stack.

Good shape:

```text
skills/hunch-trading/scripts/hunch
  -> finds/invokes bundled, plugin, dev, or installed `hunch-agent`
    -> uses hunch-agent-tools/packages/hunch-agent-client
      -> reads the local agent grant token
      -> calls Hunch Agent API
```

The wrapper can support commands such as:

```text
hunch auth login
hunch auth status
hunch auth logout
hunch search "election markets"
hunch market <market-id>
hunch quote trade --venue polymarket --market <id> --side buy --amount-usd 25
hunch intent trade --venue polymarket --market <id> --side buy --amount-usd 25
hunch intent execute <intent-id>
```

Session ownership should be:

- Backend owns the real grant and stores only token hashes.
- `hunch-agent-client` owns local token lookup and redaction.
- MCP and CLI share the same local token store.
- The skill script only calls the CLI and never stores secrets.

Local token lookup order:

1. Explicit `--profile` CLI flag or MCP tool `profile` argument.
2. Active local profile from CLI/MCP config.
3. OS keychain when available.
4. File fallback with `0600` permissions, for example:
   `~/.config/hunch/agent/sessions.json`.
5. `HUNCH_AGENT_TOKEN` only when no local profile is selected or an explicit
   env-token mode is used.

`HUNCH_AGENT_TOKEN` is an escape hatch, not the normal user path. For any future
write/intent tool, require an explicit profile unless the user passes an
override flag such as `--allow-env-token`; read-only tools may use it only after
the selected-profile lookup fails and must clearly echo that the environment
token is being used.

The stored local session should support multiple profiles from the start. This
lets one agent installation switch between multiple Hunch accounts or multiple
grants for the same account without sharing tokens across accounts.

```json
{
  "activeProfile": "main",
  "profiles": {
    "main": {
      "baseUrl": "https://api.hunch.trade",
      "grantId": "uuid",
      "token": "one-time-visible-agent-token",
      "expiresAt": "2026-06-10T00:00:00.000Z",
      "userId": "uuid",
      "scopes": ["read:markets", "read:wallets", "read:positions"],
      "walletAddresses": ["0x...", "solana..."]
    },
    "research-alt": {
      "baseUrl": "https://api.hunch.trade",
      "grantId": "uuid",
      "token": "another-limited-agent-token",
      "expiresAt": "2026-06-10T00:00:00.000Z",
      "userId": "uuid",
      "scopes": ["read:markets"],
      "walletAddresses": ["0x..."]
    }
  }
}
```

The token is sensitive locally, but still limited server-side by scopes, wallets,
venues, expiry, confirmation mode, and spend limits. A leaked agent token should
not be equivalent to a browser session.

Local storage rules:

- the config directory must be created with `0700`;
- the session file must be written with `0600`;
- `auth status` and logs must never print raw tokens;
- expired profiles should be ignored by default and clearly marked by
  `auth list`;
- `auth logout --profile` should remove only that profile;
- `auth logout --all` should remove all local profiles;
- OS keychain support is preferred when available, but file fallback is
  acceptable for Phase 2 because the token is scoped, expiring, and revocable.

Profile CLI behavior:

```text
hunch auth login --profile main
hunch auth login --profile alt
hunch auth list
hunch auth use main
hunch auth logout --profile alt
hunch positions --profile main
```

Authenticated MCP tools should accept an optional `profile` argument where the
tool meaningfully touches account state. If omitted, they use `activeProfile`.
For write/intent tools, the response must echo the selected profile, Hunch user,
wallet, venue, and grant before preparing or executing anything. This prevents
silent use of the wrong account on machines where multiple Hunch accounts are
connected.

The CLI should return structured JSON when called by a skill:

```text
hunch --json search "NBA finals"
hunch --json intent trade ...
```

Common non-zero errors should be machine-readable:

```json
{
  "ok": false,
  "code": "AUTH_REQUIRED",
  "message": "Run hunch auth login before authenticated actions."
}
```

This lets Codex use the skill reliably without needing hidden state in the skill
folder itself.

## Agent Authentication

Use a device-code style connection as the default v1 flow.

1. The MCP server or CLI starts and asks Hunch for a short-lived device code.
2. The agent shows the user a login link and short code.
3. The user opens Hunch in the browser, logs in with Privy, enters or follows the
   link/code, and selects scopes, wallets, venues, limits, and expiry.
4. Browser approval stores only approved scopes, wallets, venues, limits, and
   grant expiry on the pending device authorization. It does not create or see
   the raw agent token.
5. The MCP server polls until approved.
6. On the first successful `/agent/device/token` poll after approval, the
   backend generates one raw agent token, creates `agent_grants` with only the
   HMAC hash plus prefix, marks the device authorization as `token_issued`, and
   returns the raw token once.
7. The MCP server stores the returned token locally in the user's agent
   config/keychain.

Avoid using the existing Hunch browser session token as the MCP credential except
as a local development shortcut.

Token and code hardening:

- generate agent tokens, device codes, and approval tokens with at least 256
  bits of cryptographic randomness;
- store agent token hashes as `HMAC_SHA256(token, AGENT_TOKEN_HASH_SECRET)`,
  not plain SHA-256, so a database leak alone is less useful;
- store device-code and approval-token hashes the same way or with a separate
  server-side pepper;
- keep approval/device sessions short-lived, for example 10 minutes;
- Phase 2 read-only grants should default to 30 days, with approval-page options
  such as 1 day, 7 days, 30 days, and 90 days;
- do not offer "forever" grants in public v1; 90 days should be the maximum
  read-only grant duration unless a later admin/enterprise policy explicitly
  allows more;
- later write/trading, bridge, redeem, cancel, and delegated-signing grants
  should start with shorter expiries, for example 1 to 7 days;
- log only token prefixes, grant IDs, and safe metadata;
- never log full approval URLs, device codes, raw agent tokens, or bearer
  headers;
- approval tokens in URLs are acceptable only because they are short-lived and
  still require the user's normal Hunch browser session.

Recommended migration:

```text
packages/db/migrations/0106_agent_grants.sql
```

Use one migration for this phase. These tables are new and not legacy, so avoid
splitting the migration unless a later feature adds a genuinely separate table.
`0105_admin_rbac_roles.sql` is already present after the admin-auth merge, so
the agent migration should use the next number even though same-number
independent migrations are technically allowed by the filename-based migrator.

`agent_grants` is the durable approved access object. It belongs to one Hunch
user, one approved agent grant, and one token hash.

```sql
create table if not exists agent_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  client_name text,
  client_version text,
  client_kind text,
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default '{}',
  wallet_addresses text[] not null default '{}',
  venues text[] not null default '{}',
  allowed_chains text[] not null default '{}',
  allowed_assets text[] not null default '{}',
  confirmation_mode text not null default 'always',
  limits jsonb not null default '{}',
  metadata jsonb not null default '{}',
  is_active boolean not null default true,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_agent_grants_token_hash_unique
  on agent_grants(token_hash);

create index if not exists idx_agent_grants_user_active
  on agent_grants(user_id, is_active, expires_at desc);

create index if not exists idx_agent_grants_active_expiry
  on agent_grants(expires_at)
  where is_active = true;
```

`agent_device_authorizations` stores short-lived pending login/approval sessions.
The device code is for MCP/CLI polling. The approval token is for the browser
approval link. Store both as hashes.

```sql
create table if not exists agent_device_authorizations (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  approval_token_hash text not null unique,
  status text not null check (
    status in ('pending', 'approved', 'denied', 'expired', 'token_issued')
  ),
  requested_scopes text[] not null default '{}',
  requested_wallet_addresses text[] not null default '{}',
  requested_venues text[] not null default '{}',
  requested_limits jsonb not null default '{}',
  approved_scopes text[],
  approved_wallet_addresses text[],
  approved_venues text[],
  approved_limits jsonb,
  grant_expires_at timestamptz,
  client_name text,
  client_version text,
  client_kind text,
  metadata jsonb not null default '{}',
  approved_user_id uuid references users(id) on delete cascade,
  approved_grant_id uuid references agent_grants(id) on delete set null,
  poll_count integer not null default 0,
  approval_attempts integer not null default 0,
  last_polled_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  token_issued_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_device_authorizations_status_expiry
  on agent_device_authorizations(status, expires_at);

create index if not exists idx_agent_device_authorizations_grant
  on agent_device_authorizations(approved_grant_id);

create index if not exists idx_agent_device_authorizations_created
  on agent_device_authorizations(created_at desc);
```

The approved fields are intentionally separate from requested fields. The user
may approve a narrower wallet/scope/venue set or a different expiry than the
agent requested. `/agent/device/token` must create the grant from the approved
fields, not by trusting the original requested values.

Wallet selection needs one Phase 2B adjustment before private account routes are
useful. A device request with wallet-sensitive scopes (`read:wallets`,
`read:positions`, `read:orders`, or `read:funding`) and no
`requested_wallet_addresses` should mean "let the signed-in user choose linked
wallets on the approval page", not "the agent can never receive wallet access".
If the request does include specific wallet addresses, approval must still be a
subset of those requested addresses. This keeps explicit narrow requests strict,
while allowing a simple `hunch auth login --scopes read:account,read:wallets`
flow where the user picks the wallets in Hunch. No migration is needed for this:
an empty `requested_wallet_addresses` already represents "no preselected wallet
filter" during approval, and the durable grant still stores the concrete
approved `wallet_addresses`.

`agent_audit_events` starts in this phase so grant lifecycle and later intents
share one audit path.

```sql
create table if not exists agent_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  grant_id uuid references agent_grants(id) on delete set null,
  device_authorization_id uuid references agent_device_authorizations(id)
    on delete set null,
  event_type text not null,
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_audit_events_user_created
  on agent_audit_events(user_id, created_at desc);

create index if not exists idx_agent_audit_events_grant_created
  on agent_audit_events(grant_id, created_at desc);
```

Audit retention should be explicit. Phase 2 should use privacy-first user
deletion semantics: user deletion may cascade audit rows, while grant/device
references use `on delete set null` where useful for lifecycle visibility. Do
not store raw tokens, full approval URLs, bearer headers, Privy signatures,
partner credentials, or other secrets in audit metadata. Add a separate timed
retention job only when audit volume or compliance policy requires it; do not
block Phase 2 on a complex archival system.

Device-code auth requirements:

- device codes and approval tokens are single-use and short-lived;
- `/agent/device/token` returns the agent token only once;
- polling has a minimum interval and max poll count;
- approval has a max attempt count and IP/session rate limit;
- use the existing `checkRateLimitForSecurityClientIp` helper for device start,
  browser approval, and token polling route limits instead of adding a parallel
  rate-limit mechanism; keep DB `poll_count`/`last_polled_at` as the device-flow
  state machine guard;
- expired device rows are cleaned up by a scheduled job or opportunistic cleanup;
- approval always requires the user's normal browser session.

Recommended scopes:

```text
read:markets
read:account
read:wallets
read:orders
read:positions
read:funding
read:notifications
manage:notifications
quote:trade
prepare:venue
prepare:trade
submit:trade
cancel:order
prepare:bridge
submit:bridge
redeem
manage:positions
```

Phase 2 should enable only read scopes first:

```text
read:account
read:wallets
read:orders
read:positions
read:funding
read:notifications
```

Quote, prepare, submit, cancel, bridge, redeem, and position-management scopes
belong to later intent/execution phases.
`manage:notifications` is also future-only; Phase 2 notification access is
read/list only through `read:notifications`.

Phase 2 endpoint-to-scope mapping should be explicit:

```text
GET /agent/me                 read:account
GET /agent/notifications      read:notifications
GET /agent/wallets            read:wallets
GET /agent/wallet-balances    read:wallets
GET /agent/positions          read:positions
GET /agent/orders             read:orders
GET /agent/venue-status       read:funding
GET /agent/readiness          read:funding
GET /agent/deposit-targets    read:funding
```

Routes that combine multiple resources must require every relevant read scope.
For example, an account overview that includes wallets and positions requires
`read:account`, `read:wallets`, and `read:positions`.

### Phase 2 Backend Implementation Detail

Backend files should stay focused:

```text
apps/api/src/routes/agent.ts
apps/api/src/services/agent-auth.ts
apps/api/src/schemas/agent.ts
apps/api/src/fastify.d.ts
apps/api/src/routes/index.ts
```

Do not wire agent auth into every private route directly. Add a small Agent API
gateway first, then reuse existing account/read services behind it.
Agent auth must remain separate from the merged admin-auth system: do not reuse
`AdminRole`, `AdminPermission`, admin sessions, or admin tables for agent
grants. Agent scopes are a separate user-grant model under `/agent/*`.

Environment:

```text
AGENT_AUTH_ENABLED=false
AGENT_TOKEN_HASH_SECRET=<32+ bytes secret>
AGENT_AUTH_APPROVAL_TTL_MS=600000
AGENT_GRANT_DEFAULT_TTL_MS=<30 days for Phase 2 read-only grants>
AGENT_GRANT_MAX_READ_TTL_MS=<90 days>
AGENT_GRANT_MAX_WRITE_TTL_MS=<1-7 days, later phases only>
AGENT_AUTH_POLL_INTERVAL_MS=3000
AGENT_AUTH_MAX_POLLS=<bounded count>
```

`AGENT_TOKEN_HASH_SECRET` must be independent from `JWT_SECRET`. Rotating it
invalidates active agent grants unless a versioned secret scheme is added, so
start with one secret and plan rotation before public unattended trading. The
API should register `/agent/*` routes only when `AGENT_AUTH_ENABLED=true`.
When enabled, startup must fail if `AGENT_TOKEN_HASH_SECRET` is missing, shorter
than 32 bytes, or equal to `JWT_SECRET`. Add `token_hash_version` only when
rotation is implemented; do not add unused rotation plumbing in Phase 2.

Public/device routes:

```http
POST /agent/device/start
POST /agent/device/token
GET  /agent/capabilities
```

Phase 2A response contracts should be stable and small:

```ts
type AgentGrantSummary = {
  id: string;
  name: string;
  clientName: string | null;
  clientVersion: string | null;
  clientKind: string | null;
  scopes: string[];
  walletAddresses: string[];
  venues: string[];
  limits: Record<string, unknown>;
  confirmationMode: "always" | "policy" | "never";
  isActive: boolean;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type AgentDeviceStartResponse = {
  ok: true;
  deviceCode: string;
  approvalUrl: string;
  expiresAt: string;
  pollIntervalSec: number;
};

type AgentDeviceTokenResponse =
  | {
      ok: true;
      token: string;
      tokenType: "Bearer";
      grant: AgentGrantSummary;
      expiresAt: string;
    }
  | {
      ok: false;
      error:
        | "authorization_pending"
        | "slow_down"
        | "access_denied"
        | "expired_token"
        | "token_already_issued";
      message: string;
      pollIntervalSec?: number;
    };

type AgentApprovalResponse = {
  ok: true;
  authorization: {
    id: string;
    status: "pending" | "approved" | "denied" | "expired" | "token_issued";
    requestedScopes: string[];
    requestedWalletAddresses: string[];
    requestedVenues: string[];
    requestedLimits: Record<string, unknown>;
    clientName: string | null;
    clientVersion: string | null;
    clientKind: string | null;
    expiresAt: string;
  };
};

type AgentMeResponse = {
  ok: true;
  user: { id: string; email?: string | null };
  grant: AgentGrantSummary;
};
```

Error responses should follow the existing backend style:

```json
{ "error": "agent_auth_required", "message": "Agent token required" }
```

Do not return raw agent tokens from browser-user routes. The only route that can
return `token` is `POST /agent/device/token`.

`POST /agent/device/start`:

- accepts requested scopes, requested wallets, requested venues, requested
  limits, client name/version/kind, and optional profile label;
- validates requested scopes against the server allowlist;
- rate-limits by security client IP with `checkRateLimitForSecurityClientIp`;
- generates device and approval tokens with cryptographic randomness;
- creates `agent_device_authorizations` with hashed device and approval tokens;
- returns `deviceCode`, `approvalUrl`, `expiresAt`, and `pollIntervalSec`;
- writes an `agent_device_started` audit event with safe metadata only.

`POST /agent/device/token`:

- accepts `deviceCode`;
- hashes and looks up the pending authorization;
- rate-limits by security client IP with `checkRateLimitForSecurityClientIp`
  and rate-limits polling with `poll_count`, `last_polled_at`, and minimum
  interval;
- returns `authorization_pending`, `slow_down`, `access_denied`, or
  `expired_token` until approved;
- after approval, generates the raw agent token, creates `agent_grants` from
  approved scopes/wallets/venues/limits/expiry, stores only the HMAC hash plus
  prefix, marks `token_issued_at`, and returns the raw token once;
- after token issuance, returns a terminal already-issued response instead of
  replaying the raw token:

```json
{
  "error": "token_already_issued",
  "message": "This device authorization already issued a token. Reconnect to create a new grant."
}
```

Browser-user routes:

```http
GET    /agent/device/approval/:approvalToken
POST   /agent/device/approve
POST   /agent/device/deny
GET    /agent/grants
DELETE /agent/grants/:id
GET    /agent/audit
```

These use the normal Hunch browser session middleware and CSRF rules. They are
for the frontend, not for the MCP server.

Browser-user route contracts:

```ts
type AgentApproveBody = {
  approvalToken: string;
  scopes: string[];
  walletAddresses: string[];
  venues: string[];
  limits?: Record<string, unknown>;
  expiresInDays: 1 | 7 | 30 | 90;
  grantName?: string;
};

type AgentApproveResponse = {
  ok: true;
  status: "approved";
};

type AgentDenyResponse = {
  ok: true;
  status: "denied";
};

type AgentGrantListResponse = {
  ok: true;
  items: AgentGrantSummary[];
};

type AgentGrantRevokeResponse = {
  ok: true;
  revoked: true;
};

type AgentAuditResponse = {
  ok: true;
  items: Array<{
    id: string;
    eventType: string;
    actorType: "user" | "agent" | "system";
    grantId: string | null;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
};
```

Approval behavior:

- hash and look up `approvalToken`;
- require `status = 'pending'` and `expires_at > now()`;
- require the approving user to be logged in;
- validate requested wallets are linked to that user;
- normalize wallet identifiers before storing or comparing them: EVM addresses
  are compared by lowercase address plus chain/type, Solana addresses are
  compared by exact base58 string plus chain/type, and display formatting can
  use checksummed EVM addresses;
- validate venues and scopes are currently allowed;
- store approved scopes, wallets, venues, limits, grant expiry, and approving
  user on `agent_device_authorizations`;
- mark the device authorization approved without creating the grant yet;
- write audit events;
- never return the raw agent token to the browser;
- avoid logging full `approvalToken` or full `approvalUrl`.

Agent-token routes:

```http
GET /agent/me
GET /agent/notifications
```

This is the first route behind `createAgentAuthMiddleware`. It proves token
validation, scope attachment, grant metadata, user lookup, and profile display
without touching private trading flows. Later authenticated read routes can add
wallets, balances, positions, orders, rewards, venue status, readiness, and
deposit targets. The full `/agent/funding-plan` route stays in Phase 3 because
it combines missing-balance guidance, bridge suggestions, and intent-oriented
funding decisions.

Notifications should be included as a Phase 2 authenticated read surface:

```http
GET /agent/notifications?limit=20&cursor=...&unreadOnly=true
```

Rules:

- require `read:notifications`;
- reuse the existing notification read model/repository instead of creating a
  parallel notification store;
- return user-level notifications for the authenticated grant's user, with
  the same cursor pagination shape as the existing `/notifications` route;
- support `limit`, `cursor`, and `unreadOnly` in Phase 2; do not add
  offset/status/type filters unless the shared notification schema is extended
  for both browser and agent routes;
- include safe links to related Hunch pages when the notification references an
  event, market, wallet, grant, or later an intent;
- Phase 2 is list/read only: do not mark notifications read, delete
  notifications, or mutate notification preferences from an agent token;
- marking read or managing notification settings should require a later
  `manage:notifications` scope or the normal browser session.

Phase 2B authenticated account-read routes should reuse existing account,
wallet, position, order, and venue-status services. They must filter requested
wallets by both linked-wallet ownership and the active agent grant's
`wallet_addresses`.

```http
GET /agent/wallets
GET /agent/wallet-balances?walletAddress=...&tokens=...&chains=...
GET /agent/positions?venue=...&wallets=...&marketId=...&eventId=...
GET /agent/orders?venue=...&wallets=...&status=...&limit=25&offset=0
GET /agent/venue-status?walletAddress=...&includeAllWallets=false&refresh=false
GET /agent/readiness?venue=...&walletAddress=...&marketId=...
GET /agent/deposit-targets?venue=...&walletAddress=...&asset=pUSD|USDC.e|USDC|SOL|POL|ETH
```

Code-grounded Phase 2B implementation map:

- `/agent/wallets` should reuse the same wallet payload shape as
  `/auth/me`. Extract the wallet enrichment helper from
  `apps/api/src/routes/auth.ts` so it can include `walletSource`,
  `isEmbeddedWallet`, `isSmartWallet`, `isInternalWallet`, display name, and
  primary/verified flags without duplicating Privy classification logic. Filter
  the returned wallets to the active grant's `wallet_addresses`. If the grant
  has `read:wallets` but no approved wallets, return an empty `items` array.
- `/agent/wallet-balances` should reuse the existing
  `/wallets/balances` and `/wallets/balances/batch` behavior from
  `apps/api/src/routes/wallets.ts`. The balance implementation is route-local
  today, so first extract the balance lookup and wallet-resolution helpers into
  a shared service, then have both the browser route and agent route call it.
  The agent route must reject any requested wallet that is not in the active
  grant. It should require `tokens` or `chains`, preserving existing max-token
  and batch limits.
- `/agent/positions` can call `fetchPositionsForUserWallet`,
  `fetchPositionsForUserWalletByTokenIds`, and
  `fetchPositionPnlSummaryForUserWallet` from
  `apps/api/src/repos/positions-repo.ts`. The repo already expands approved
  Polymarket signer wallets to stored/derived funders when needed, so the agent
  should pass approved signer wallets and not grant funder addresses directly.
  Keep `venue`, `venues`, `wallets`, `eventId`, `marketId`, `includeHidden`, and
  `minSize` aligned with the existing `/positions` schema.
- `/agent/orders` can call `fetchUnifiedOrders` and `fetchUnifiedOrderById`
  from `apps/api/src/repos/unified-orders.ts`. The repository already matches
  both `wallet_address` and `signer_address` for venue orders, which is needed
  for Polymarket funder-backed orders. Extract or share the existing
  `mapUnifiedOrder` response mapper from `apps/api/src/routes/orders.ts` so the
  browser and agent responses stay identical.
- `/agent/venue-status` should reuse the existing
  `/wallets/venue-status` computation, including the 15 second in-process cache
  and in-flight de-duplication. That logic is also route-local today, so extract
  it beside the balance helpers before adding the agent route. Preserve
  `includeAllWallets`, `walletAddress`, `wallets`, and `refresh`, but scope
  `includeAllWallets` to "all wallets approved by this grant".
- `/agent/readiness` should be a summarizer over existing data, not a parallel
  venue integration. Start from venue status plus unified market state when
  `marketId` or `eventId` is supplied. Use private account endpoints only when
  the summary needs account fields that venue status does not expose, for
  example Limitless spender-specific approvals for a known AMM/CLOB market.
- `/agent/deposit-targets` should be backend-derived from approved wallets and
  venue status. It must not assume a single USDC target. Polymarket may expose
  pUSD collateral, Polygon USDC.e/native USDC conversion sources, and Polygon
  native POL for fees. Limitless may expose Base USDC and Base ETH. Kalshi may
  expose Solana USDC and SOL, while embedded Solana trading wallets can mark
  native fees as sponsored. Return structured chain/asset/address data plus
  `qrPayload` and a first-party Hunch `depositPageUrl`; do not choose bridge
  routes or quote funding in Phase 2B.

Frontend/client grounding:

- Existing browser API clients live in `Hunch_App/src/lib/api/wallets.ts`,
  `positions.ts`, `orders.ts`, `deposit.ts`, and the venue-private clients.
  Phase 2B frontend additions should go in `Hunch_App/src/lib/api/agent.ts` and
  call `/api/hunch/agent/*` through the existing catch-all proxy. No new Next
  proxy route is required.
- The approval page currently displays requested scopes/wallets and approves
  exactly the requested wallet list. For 2B, it must render a minimal wallet
  selector whenever wallet-sensitive scopes are requested. If the agent
  requested specific wallets, only those linked wallets are selectable. If it
  requested wallet-sensitive scopes with no specific wallets, all linked wallets
  are selectable and the user must select at least one before approval.
- The agent-tools repo already supports scope and wallet flags in
  `hunch-agent auth login`; its default login is currently
  `read:account,read:notifications`. Phase 2B should add convenience presets or
  documented examples for account reads, for example
  `--scopes read:account,read:wallets,read:positions,read:orders,read:funding`
  with wallet selection completed in the Hunch approval UI.

No Phase 2B migration is expected. The durable access control remains
`agent_grants.wallet_addresses`, `scopes`, and `venues`; Phase 2B only adds
read routes, shared service extraction, frontend client functions, and tests.

Phase 2B response contracts:

```ts
type AgentWallet = {
  walletAddress: string;
  walletType: "ethereum" | "solana";
  walletSource?: "embedded" | "smart" | "external" | "unknown";
  isEmbeddedWallet?: boolean;
  isSmartWallet?: boolean;
  isInternalWallet?: boolean;
  isPrimary: boolean;
  displayName?: string | null;
  venues: Array<"polymarket" | "kalshi" | "limitless">;
};

type AgentWalletsResponse = {
  ok: true;
  items: AgentWallet[];
};

type AgentBalance = {
  chainId: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  balance: string;
  balanceRaw: string;
  isNative: boolean;
};

type AgentWalletBalancesResponse = {
  ok: true;
  walletAddress: string;
  walletType: "ethereum" | "solana";
  balances: AgentBalance[];
  warnings: string[];
};

type AgentPositionsResponse = {
  ok: true;
  positions: Position[];
  venue?: "polymarket" | "kalshi" | "limitless";
};

type AgentOrdersResponse = {
  ok: true;
  orders: UnifiedOrder[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};
```

Readiness must summarize venue-specific blockers from existing Hunch services
instead of hiding them behind one generic `ready` boolean:

```ts
type AgentReadinessBlocker =
  | "missing_wallet"
  | "wallet_not_in_grant"
  | "wallet_type_mismatch"
  | "missing_credentials"
  | "invalid_credentials"
  | "account_verification_required"
  | "account_verification_unavailable"
  | "geo_or_proof_blocked"
  | "approval_required"
  | "allowance_required"
  | "insufficient_balance"
  | "native_fee_required"
  | "low_native_balance"
  | "relayer_disabled"
  | "service_unavailable"
  | "market_not_accepting_orders"
  | "market_expired";

type AgentVenueReadiness = {
  venue: "polymarket" | "kalshi" | "limitless";
  supported: boolean;
  ready: boolean;
  blockers: AgentReadinessBlocker[];
  warnings: string[];
  walletAddress: string;
  walletType: "ethereum" | "solana";
  chainId?: string | number;
  account?: {
    hasCredentials?: boolean;
    credentialsValid?: boolean | null;
    verificationRequired?: boolean;
    verificationStatus?:
      | "verified"
      | "required"
      | "unavailable"
      | "disabled"
      | "bypassed";
  };
  approvals?: Array<{
    kind: "erc20_allowance" | "erc1155_operator" | "venue_connection";
    target: string;
    ok: boolean;
    allowanceRaw?: string | null;
  }>;
  balances?: AgentBalance[];
  nextActions: Array<{
    code: AgentReadinessBlocker;
    label: string;
    href?: string | null;
  }>;
};

type AgentReadinessResponse = {
  ok: true;
  wallets: Array<{
    walletAddress: string;
    walletType: "ethereum" | "solana";
    venues: AgentVenueReadiness[];
  }>;
};
```

Readiness should cover account/KYC-style risks where Hunch can observe them:
Kalshi/DFlow proof status, geofence blocks, venue account credentials,
Limitless partner auth validity, Polymarket funder/relayer state, ERC20
allowances, ERC1155 operator approvals, venue collateral/stablecoin balances,
native gas/SOL buffers where they are actually required, service availability,
and market accept/expiry state when a market is supplied.
It should not claim to complete off-platform KYC or legal eligibility. It should
return `account_verification_required`, `geo_or_proof_blocked`, or
`account_verification_unavailable` with a safe Hunch/venue link when the next
step requires the user.

Deposit targets in Phase 2B are read-only and must be backend-derived:

```ts
type AgentDepositTarget = {
  venue?: "polymarket" | "kalshi" | "limitless";
  walletAddress: string;
  walletType: "ethereum" | "solana";
  targetAddress: string;
  targetKind: "trading_wallet" | "venue_funder";
  chainId: string;
  chainName: string;
  asset: {
    id: string;
    symbol: string;
    purpose: "collateral" | "convertible" | "native_fee";
    address?: string | null;
    mint?: string | null;
    decimals: number;
    aliases?: string[];
  };
  depositUri?: string | null;
  qrPayload: string;
  depositPageUrl: string;
  warnings: string[];
};

type AgentDepositTargetsResponse = {
  ok: true;
  items: AgentDepositTarget[];
};
```

Do not include bridge quotes, bridge recipients, or missing-balance routing in
Phase 2B deposit targets. Those belong to the Phase 3 funding plan.

Agent auth middleware:

```ts
createAgentAuthMiddleware({
  requiredScopes?: string[];
})
```

Rules:

- require `Authorization: Bearer <agent-token>`;
- HMAC-hash the token with `AGENT_TOKEN_HASH_SECRET` and do one indexed lookup
  by `agent_grants.token_hash`;
- reject inactive, revoked, or expired grants;
- reject inactive users;
- re-check approved wallets are still linked before returning wallet-sensitive
  data or preparing later intents;
- compare wallet access by normalized wallet address plus chain/type, not by
  raw display string alone;
- attach `request.agentGrant`, `request.user`, and approved wallet/scope/venue
  context;
- enforce `requiredScopes`;
- update `last_used_at` only when it is null or older than 5 minutes, using
  async best effort where practical, so frequent MCP reads do not write on every
  request;
- do not require CSRF because agent routes use bearer tokens, not browser
  cookies.

Raw token generation should use a recognizable prefix for support/debugging,
for example:

```text
ha_live_<random>
ha_test_<random>
```

Only the prefix and hash go into Postgres. The full token is visible once to the
MCP/CLI polling session and then stored locally by `hunch-agent-tools`.
Token issuance, grant insertion, and `token_issued_at` update must happen in one
database transaction. If the token response is lost after issuance, the user
should reconnect rather than the backend replaying the raw token.

Phase 2 authenticated-read rollout should be split:

Phase 2A:

1. device start/token, browser approve/deny, grant list/revoke, audit;
   **implemented**.
2. `createAgentAuthMiddleware`; **implemented**.
3. `/agent/me`; **implemented**.
4. `/agent/notifications`; **implemented**.
5. frontend `/agent/approve/:approvalToken` and `/settings/agents`;
   **implemented**.
6. agent-tools `auth login`, `auth list`, `auth use`, `auth status`, and
   `auth logout`; **implemented**.

Phase 2B:

1. approval-page wallet selection for wallet-sensitive read scopes;
   **implemented**.
2. shared wallet payload helper extracted from `/auth/me`; **implemented**.
3. shared wallet balance and venue-status services extracted from
   `/wallets/*`; **implemented for Phase 2B read needs**.
4. shared order response mapper extracted from `/orders`; **implemented for
   Phase 2B account-order responses**.
5. `/agent/wallets`; **implemented**.
6. `/agent/wallet-balances`; **implemented**.
7. `/agent/positions` and `/agent/positions/pnl`; **implemented**.
8. `/agent/orders` and `/agent/orders/:id`; **implemented**.
9. `/agent/venue-status`; **implemented**.
10. `/agent/readiness`; **implemented**.
11. `/agent/deposit-targets`; **implemented as read-only backend-derived
    funding instructions**.
12. agent-tools authenticated account-read MCP tools and CLI commands;
    **implemented**.
13. MCP-native auth/profile tools so agents do not need the skill CLI for
    normal login, profile status/list/use, or logout; **implemented**.

Phase 2B is now the current read-only account baseline. It intentionally stops
before intents, trading, bridge routing, redemption, notification mutation, or
delegated signing.

Implementation order:

1. Add the `0106_agent_grants.sql` migration.
2. Add agent token/code generation, HMAC hashing, and grant/device auth service.
3. Add public `/agent/device/start`, `/agent/device/token`, and
   `/agent/capabilities`.
4. Add browser-session approval, deny, grant list, grant revoke, and audit
   routes.
5. Add `createAgentAuthMiddleware`.
6. Add `/agent/me`.
7. Add backend tests for the full device approval and one-time token lifecycle.
8. Add read-only `/agent/notifications`.
9. Add frontend approval/settings pages against the browser-session routes.
10. Add agent-tools multi-profile login/logout/list/use support and
    `hunch_get_notifications`.
11. Add Phase 2B shared read services and authenticated private read tools only
    after `/agent/me` and multi-profile auth are stable. **Implemented.**

Backend tests:

- start auth session creates hashed device/approval tokens only;
- token/device/approval hashes use the agent HMAC secret, not raw SHA-256;
- generated tokens have at least 256 bits of entropy;
- invalid scopes are rejected;
- polling pending returns pending;
- polling too fast returns slow-down or rate-limit response;
- expired session cannot be approved;
- denied session never issues a token;
- browser approval stores approved scopes/wallets/venues/limits/expiry but does
  not create a raw token or grant;
- first successful token poll after approval creates the grant from approved
  values and issues the token once;
- repeated token polls after issuance do not replay the raw token;
- raw token is not stored in Postgres;
- token hash lookup authenticates the grant;
- revoked grant rejects immediately;
- expired grant rejects;
- missing required scope rejects;
- `/agent/notifications` requires `read:notifications`, paginates results, and
  does not expose notification mutations;
- unlinked wallet approval rejects;
- browser approval requires normal user auth and CSRF;
- revoke requires owning user;
- grant list only shows the current user's grants;
- approval routes and audit metadata do not include raw tokens or full approval
  URLs;
- audit events are written for start, approve, deny, token issuance, revoke, and
  failed auth where useful.
- wallet-sensitive scopes with no requested wallets allow the approving user to
  select any linked wallet, but only after normal browser auth;
- wallet-sensitive scopes with explicit requested wallets only allow approving a
  subset of those requested wallets;
- wallet-sensitive `/agent/*` routes reject wallets outside the active grant;
- wallet-sensitive `/agent/*` routes use all approved grant wallets when no
  `wallets` or `walletAddress` query is supplied;
- `/agent/wallets` returns the same wallet metadata semantics as `/auth/me`,
  including internal Trading Wallet flags when Privy enrichment is available;
- `/agent/positions` matches `/positions` for the same approved wallet and query
  filters;
- `/agent/orders` matches `/orders` for the same approved wallet and query
  filters;
- `/agent/wallet-balances` and `/agent/venue-status` preserve the existing
  browser-route validation, cache, and batch limits;
- `/agent/readiness` maps existing venue-status reasons to stable blocker codes;
- `/agent/deposit-targets` never returns an arbitrary caller-supplied target
  address and returns Polymarket funder targets when venue state uses a funder.

External agent-tools tests:

- local session directory is created with `0700` and file with `0600`;
- `auth status`, errors, and debug output redact raw tokens;
- expired profiles are ignored for requests and shown as expired in
  `auth list`;
- `auth logout --profile` removes only the selected profile;
- `auth logout --all` removes every local profile;
- profile-specific requests use that profile's `baseUrl` and token;
- write/intent tools require explicit profile or clearly echo environment-token
  usage before action.

## Confirmation And Limits

Use one normalized policy check for every agent write action.

Grant fields should include:

- allowed wallets;
- allowed venues;
- allowed chains;
- allowed assets;
- allowed operations;
- max USD per order;
- max USD per market per day;
- max USD per venue per day;
- max bridge amount;
- max slippage;
- allowed order types;
- allowed market IDs or blocked market IDs;
- max outstanding open orders;
- expiry and revocation.

Confirmation modes:

```text
always
  Every write creates an intent and waits for user approval.

policy
  Execute only if the intent is within explicit limits; otherwise require
  approval.

never
  Only available after a real delegated-signing implementation exists. It must
  still obey limits, audit logs, idempotency, and revocation.
```

For v1, use `always` and `policy` with policy execution limited to operations
that do not require a wallet signature. Trade/bridge execution should remain
confirmation-required unless delegated signing is explicitly added.

## Browser Approval Links

The agent should not ask users to paste secrets into chat. For login and write
approval, it should return a Hunch link.

Auth link:

```text
https://app.hunch.trade/agent/approve/<approval-token>
```

Intent approval link:

```text
https://app.hunch.trade/agent/intents/<intent-id>
```

The approval page should show:

- requesting agent/grant name;
- action type;
- venue;
- wallet;
- market/event;
- side/outcome;
- amount, price, slippage, fees, and quote age;
- funding target if funds are missing;
- policy decision and remaining limits;
- whether the action will execute once or update an automation policy.

The user can choose:

```text
approve once
reject
approve and remember within these limits
```

`approve and remember` should update the agent grant limits/confirmation mode,
not bypass backend checks. The backend must still enforce scopes, wallets,
venues, market allow/block lists, spend limits, slippage, expiry, idempotency,
and revocation on every call.

If a signed wallet action is required, approval must still produce the required
Privy authorization signatures or use an explicitly configured delegated-signing
grant. A UI checkbox alone is not sufficient for no-confirmation wallet signing
unless the signing layer supports it.

## Frontend UX Surfaces

The frontend should make agent access feel like a normal Hunch account-control
flow, not a developer-only token flow. The user should approve links in Hunch,
inspect connected agents in settings, and confirm sensitive actions from a
first-party page.

Phase 2 frontend should be deliberately minimal. Use existing `Hunch_App`
patterns: the `src/app/api/hunch/[...path]/route.ts` proxy, `useAuth` /
Privy login flow, TanStack Query, `@/ui` buttons/alerts/table primitives, and
existing typography/color tokens. Do not introduce a new design system, a
complex automation-policy builder, or Tailwind breakpoint prefixes such as
`sm:`, `md:`, or `lg:` because project breakpoints are disabled. Use a simple
stacked responsive layout with constrained content width, clear loading/error
states, and compact cards or tables matching existing app surfaces.

### 1. Agent Approval Flow

Add a browser route such as:

```text
/agent/approve/:approvalToken
```

Responsibilities:

- if the user is not logged in, use the existing Hunch/Privy auth flow and
  return to the same approval URL after login;
- load the pending device/auth session from the backend;
- show the requesting agent name, client/app metadata, requested scopes,
  requested wallets/venues, expiry, and requested policy limits;
- let the user choose an expiry from bounded options such as 1 day, 7 days, 30
  days, or 90 days for read-only grants; do not offer "forever" grants in public
  v1;
- explain that approval gives a limited Hunch agent grant, not wallet private
  keys, Privy browser cookies, or broad account session access;
- provide `Approve` and `Deny` actions;
- never show, copy, or store the issued agent token in the browser UI.

Required states:

- loading pending authorization;
- logged-out/authenticating;
- pending approval with expiry selector and requested access summary;
- approve success: "Agent connected. You can close this page.";
- deny success;
- expired, denied, token-issued, not-found, and backend-unavailable errors;
- action-in-flight disabled buttons.

The backend returns the agent token only to the polling MCP/CLI session after
approval. The frontend only approves or denies the pending session with the
user's normal Hunch session.

### 2. Agent Access Settings

Add a settings route such as:

```text
/settings/agents
```

Responsibilities:

- list active, expired, and revoked agent grants;
- show grant name, scopes, wallet/account access, venues, limits, created time,
  expiry, last-used time, and status;
- support revoke access;
- do not support editing limits in Phase 2A; show a disabled or omitted edit
  affordance until broader automation exists;
- show recent audit activity only if `/agent/audit` is implemented; otherwise
  keep the settings page to grant list and revoke.

This is the user's main kill switch. It should be obvious how to revoke an
agent without using the CLI or MCP client.

### 3. Intent Confirmation UI

Add a browser route such as:

```text
/agent/intents/:intentId
```

Responsibilities:

- load the pending intent with the user's normal Hunch session;
- show the full normalized action before approval:
  - market/event and venue;
  - selected wallet and network;
  - buy/sell, YES/NO or outcome, order type, amount, limit price, estimated
    shares/proceeds, quote age, fees, slippage, and expiry;
  - balance impact and funding/bridge blockers;
  - requesting agent/grant name;
  - policy decision and remaining limits;
- provide `Confirm` and `Reject` actions;
- run the existing Privy authorization/signature flow when a signed wallet
  action is required;
- bind approval to the exact intent payload or explicitly show refreshed
  economics before approval.

Later, this page can offer `approve similar actions within limits`, but the
first version should default to explicit per-intent confirmation.

### 4. Frontend API Integration

Use the existing `Hunch_App` API-client and proxy-route patterns rather than a
parallel frontend stack.

Expected frontend additions:

```text
Hunch_App/src/lib/api/agent.ts
Hunch_App/src/app/api/hunch/agent/...
```

The Next route handlers under `src/app/api/hunch/*` should proxy
cookie-authenticated browser calls to the backend for approval, grant
management, and intent confirmation. The agent token itself should not pass
through these browser routes.

Reusable UI pieces should stay close to existing Hunch components:

- scope/permission summary;
- grant card;
- policy summary/editor;
- intent summary;
- audit log;
- wallet funding/deposit panel;
- QR rendering from backend-provided `qrPayload` or `depositUri`.

Hosted Hunch pages should be the canonical user-facing funding surface. Agent
tools may show text guidance or render QR codes as a convenience, but whenever a
funding/deposit flow is user-facing the response should include a Hunch
`depositPageUrl`/`fundingPageUrl` that opens a first-party page with the QR,
plain address, chain, asset, amount when known, copy buttons, warnings, and
status.

Reuse existing market/event cards, venue badges, wallet displays, and trade
summary components wherever possible. Do not build a second trading UI for
agent intents.

### KISS Frontend Version

The first frontend milestone should ship only:

1. `/agent/approve/:approvalToken`;
2. `/settings/agents`;
3. `/agent/intents/:intentId`.

Avoid a complex automation-policy builder until confirmation-required intents
are working end to end. A compact policy summary plus revoke controls are enough
for the first authenticated-read and explicit-confirmation releases.

## Signing Delegation Solution

The real signing delegation layer should be a backend-owned signer-grant system,
not MCP or skill logic.

Define a signer abstraction:

```ts
type AgentSignerMode = "user_confirmation" | "delegated_privy" | "session_key";

type AgentSignerGrant = {
  id: string;
  userId: string;
  agentGrantId: string;
  walletAddress: string;
  walletType: "ethereum" | "solana";
  mode: AgentSignerMode;
  provider: "privy" | "smart_account" | "none";
  providerGrantId?: string | null;
  allowedChains: string[];
  allowedVenues: string[];
  allowedOperations: string[];
  policy: AgentSigningPolicy;
  expiresAt: string;
  revokedAt?: string | null;
};
```

The execution flow should always be:

1. Agent creates or previews an intent.
2. Backend normalizes the action and evaluates Hunch policy.
3. Backend checks whether an active signer grant can sign this exact payload.
4. If no signer grant matches, return `requiresUserConfirmation: true` and an
   approval link.
5. If a signer grant matches, execute through the signer adapter and write an
   audit event.

The signer policy must be enforced in two places:

- Hunch policy in Postgres/runtime policy, for visibility, audit, and product
  controls.
- Signing-layer policy when possible, so a leaked server credential or bug is
  still constrained by the wallet/signing provider or smart-account module.

Minimum signing policy fields:

```ts
type AgentSigningPolicy = {
  maxUsdPerAction: number;
  maxUsdPerDay: number;
  maxOpenOrdersUsd: number;
  maxSlippageBps: number;
  allowedContracts?: string[];
  allowedPrograms?: string[];
  allowedFunctionSelectors?: string[];
  allowedMarketIds?: string[];
  blockedMarketIds?: string[];
  requireLimitOrders?: boolean;
  allowMarketOrders?: boolean;
  allowBridge?: boolean;
};
```

### Preferred Path: Privy Delegated Signing

Privy Signers should be the preferred delegated-signing implementation. The
agent, MCP server, and skill do not receive signing authority. Hunch owns the
Privy signer integration on the backend and exposes only limited agent grants
and intent APIs to the agent.

User flow:

1. User opens `/agent/approve/:approvalToken` or `/agent/intents/:id`.
2. User selects automatic execution and limits.
3. Hunch creates or reuses an app authorization key / key quorum and asks Privy
   to add it as a signer for the selected Trading Wallet, with policy IDs that
   match the user's selected limits.
4. Backend stores the signer/grant metadata and policy mapping. The Privy
   authorization key material must live in server secret storage, not in MCP,
   skill, browser local storage, or the database as raw plaintext.
5. Every agent execution still passes through Hunch policy and audit.
6. Revoking the Hunch grant disables Hunch-side execution immediately and should
   also remove or invalidate the matching Privy signer/policy attachment where
   Privy's API supports it.

This is the cleanest solution because it keeps embedded-wallet custody inside
Privy and avoids inventing our own signer custody.

Privy policy is not a replacement for Hunch policy. Hunch must still enforce
grant scopes, venue allowlists, market allow/block lists, quote freshness,
slippage, spend counters, open-order exposure, idempotency, and audit before
asking Privy to sign. Privy policy is the defense-in-depth layer that constrains
the wallet action if Hunch code or credentials are compromised.

### Fallback Path: EVM Smart Account Session Keys

If Privy does not support the needed delegated signing, EVM automation can be
implemented with smart-account/session-key infrastructure.

Model:

- user authorizes a session key once from the Trading Wallet;
- session key can only call allowlisted contracts/functions;
- limits and expiry live in a smart-account module or guard when possible;
- backend stores the session key in KMS/secret storage and maps it to an
  `agent_signer_grant`;
- backend still enforces Hunch policy before using the key.

This can work for EVM venues first, but it is more complex than Privy-native
delegation and may require moving operational assets/allowances to a smart
account or venue funder controlled by that smart account.

### Solana And Bridge Automation

Solana automation should not be assumed equivalent to EVM automation.

For Kalshi/DFlow and Solana bridges, keep confirmation-required execution until
one of these exists:

- Privy Signers is validated against the exact Solana transaction shapes and
  policy rules we need;
- a Solana program/account-authority design exists that can constrain spending
  and actions safely;
- the action can be represented as a narrow token delegate or venue-native
  permission without allowing arbitrary wallet spending.

Bridge automation is especially risky because wrong-chain/wrong-token mistakes
can strand funds. Treat bridges as confirmation-required in v1 unless a
delegated signer can enforce route, token, amount, recipient, and slippage.

### Practical V1 Scope

Start with:

- all reads automated;
- all quotes automated;
- all intent creation automated;
- venue setup and trade execution confirmation-required;
- automatic cancellation only if the venue API can cancel without a fresh wallet
  signature and policy allows it;
- no automatic bridge execution;
- no automatic redemption execution.

Then add automatic signed execution in this order:

1. EVM small limit orders on internal Trading Wallets.
2. EVM order cancels and low-risk venue maintenance.
3. EVM redemption when payloads are deterministic and policy-constrained.
4. Solana/Kalshi only after delegated signing is proven.
5. Bridge execution last.

## Intent API

Add backend routes under `/agent/*`.

```text
POST /agent/device/start
GET  /agent/device/approval/:approvalToken
POST /agent/device/approve
POST /agent/device/deny
POST /agent/device/token
GET  /agent/capabilities
GET  /agent/grants
DELETE /agent/grants/:id
GET  /agent/me
GET  /agent/notifications
POST /agent/intents/preview
POST /agent/intents
GET  /agent/intents/:id
POST /agent/intents/:id/approve
POST /agent/intents/:id/execute
GET  /agent/audit
GET  /agent/funding-plan
```

These routes have three different auth contexts:

Public/device-code routes:

```text
POST /agent/device/start
POST /agent/device/token
GET  /agent/capabilities
```

Agent-token routes:

```text
GET  /agent/me
GET  /agent/notifications
POST /agent/intents/preview
POST /agent/intents
GET  /agent/intents/:id
POST /agent/intents/:id/execute
GET  /agent/funding-plan
```

Browser-user session routes:

```text
GET  /agent/device/approval/:approvalToken
POST /agent/device/approve
POST /agent/device/deny
GET  /agent/grants
DELETE /agent/grants/:id
POST /agent/intents/:id/approve
GET  /agent/audit
```

Do not let an agent token approve its own device login, widen its own grant, or
approve its own pending intent. Those actions require the user's normal Hunch
session and, when signing is needed, Privy authorization in the browser.

For Phase 2, grants are created only through device approval plus the first
successful token poll. Do not add a separate `POST /agent/grants` creation path
until there is a separate product need for manual grant creation.

`/agent/intents` should accept normalized actions such as:

```ts
type AgentIntent =
  | {
      type: "venue_setup";
      venue: "polymarket" | "kalshi" | "limitless";
      walletAddress: string;
      marketId?: string;
    }
  | {
      type: "trade";
      venue: "polymarket" | "kalshi" | "limitless";
      walletAddress: string;
      marketId: string;
      outcomeId?: string;
      side: "buy" | "sell";
      orderType: "limit" | "market" | "fok";
      price?: number;
      amountUsd?: number;
      shares?: number;
      maxSlippageBps?: number;
    }
  | {
      type: "cancel_order";
      venue: "polymarket" | "kalshi" | "limitless";
      walletAddress: string;
      orderId: string;
    }
  | {
      type: "bridge";
      walletAddress: string;
      srcChainId: string;
      dstChainId: string;
      srcToken: string;
      dstToken: string;
      amountIn: string;
      maxSlippageBps?: number;
    }
  | {
      type: "funding";
      walletAddress: string;
      venue?: "polymarket" | "kalshi" | "limitless";
      asset: string;
      amountRaw?: string;
      preferredSourceChainId?: string;
      source?: "external_deposit" | "bridge";
    }
  | {
      type: "redeem";
      venue: "polymarket" | "limitless";
      walletAddress: string;
      marketId?: string;
      tokenId?: string;
      conditionId?: string;
      outcome?: string;
    };
```

Store intents and events:

```sql
create table if not exists agent_intents (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid references agent_grants(id) on delete set null,
  user_id uuid not null references users(id) on delete cascade,
  wallet_address text not null,
  type text not null,
  status text not null check (
    status in (
      'pending_confirmation',
      'approved',
      'executing',
      'executed',
      'rejected',
      'expired',
      'failed',
      'cancelled'
    )
  ),
  idempotency_key text not null,
  request jsonb not null,
  preview jsonb,
  policy_decision jsonb not null,
  execution_result jsonb,
  requires_user_confirmation boolean not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  executed_at timestamptz,
  unique (grant_id, idempotency_key)
);

alter table agent_audit_events
  add column if not exists intent_id uuid
  references agent_intents(id) on delete set null;

create index if not exists idx_agent_audit_events_intent_created
  on agent_audit_events(intent_id, created_at desc);
```

Intent idempotency and state-machine rules:

- clients may provide an idempotency key, but the backend generates one if
  absent before inserting the intent;
- all write execution uses the persisted intent row and never reconstructs an
  independent venue action from a duplicate request;
- `pending_confirmation` can only become `approved`, `rejected`, `expired`, or
  `cancelled`;
- auto-executable intents may be inserted as `approved` only after policy and
  signer checks pass;
- `execute` must lock the intent row, reject invalid transitions, move
  `approved` to `executing`, and then move to `executed` or `failed`;
- agent tokens cannot approve intents or widen grants.

Payload storage rules:

- `request`, `preview`, `execution_result`, and audit metadata must not store raw
  secrets, Privy authorization signatures, private key material, bearer tokens,
  or venue partner credentials;
- raw signed payloads should not be persisted unless encrypted with short
  retention and a clear operational need;
- store hashes, venue IDs, transaction IDs, order IDs, and safe quote metadata
  for traceability instead of sensitive payload bodies.

Indexes should cover:

- active grant lookup by `token_hash`;
- user grant management by `(user_id, is_active, expires_at)`;
- pending approvals by `(user_id, status, created_at desc)`;
- idempotency by `(grant_id, idempotency_key)`;
- audit by `(user_id, created_at desc)`.

## MCP Tool Surface

Package the MCP server in the external `hunch-agent-tools` repo as
`apps/mcp-hunch`. Keep reusable HTTP/session/tool logic in that repo's
`packages/hunch-agent-client`. The monorepo exposes the API contract; the
external repo consumes it.

Current public/read tools:

```text
hunch_search_discovery
hunch_browse_discovery
hunch_get_discovery_top_lists
hunch_get_discovery_map
hunch_get_market_detail
hunch_get_event_detail
hunch_get_arbitrage_clusters
hunch_get_market_alternatives
hunch_get_similar_markets
hunch_get_similar_events
hunch_get_market_holders
hunch_get_market_price_history
hunch_get_event_price_history
hunch_get_tracking_overview
hunch_get_wallet_intel
hunch_get_wallet_activity
hunch_get_wallet_positions
hunch_get_wallet_series
hunch_get_wallet_signals
hunch_get_signals
hunch_get_trades
```

Phase 2 authenticated read tools:

```text
hunch_get_account
hunch_get_wallets
hunch_get_wallet_balances
hunch_get_venue_status
hunch_get_readiness
hunch_get_deposit_targets
hunch_get_positions
hunch_get_orders
hunch_get_notifications
```

`hunch_get_wallet_positions` in the public/read tool set means public wallet
intelligence for an arbitrary wallet. `hunch_get_positions` in the authenticated
tool set means the connected Hunch user's own account positions under the active
agent grant. Tool descriptions should keep that distinction explicit.

Write/intent tools:

```text
hunch_quote_trade
hunch_quote_bridge
hunch_create_venue_setup_intent
hunch_create_funding_intent
hunch_create_trade_intent
hunch_create_bridge_intent
hunch_create_redemption_intent
hunch_cancel_order_intent
hunch_sync_positions
hunch_sync_orders
hunch_execute_intent
hunch_get_intent
hunch_list_pending_intents
```

Tool descriptions must be explicit that creating an intent is not the same as
executing a trade unless the returned intent status is `executed`.

## End-To-End Trading Coverage

The agent surface should cover the full Hunch trade lifecycle, not only order
submission.

### 1. Discover And Select

Reuse existing read paths:

- market map and sidebar discovery;
- feed/search when exposed through the agent API;
- AGG/Hunch clusters;
- market/event details;
- similar markets/events;
- candlesticks and price snapshots where useful.

The agent response must return stable Hunch IDs and venue IDs:

```text
eventId
marketId
venue
venueMarketId
tokenId / outcomeId
marketSlug
conditionId
```

### 2. Resolve Tradable Outcome

Before quote or intent creation, the backend should normalize the requested
outcome into venue-specific identifiers:

- Polymarket: CLOB token ID, yes/no side, neg-risk exchange, tick size, min
  size, accepting-orders status.
- Limitless: market slug or market address, outcome index/token, AMM vs CLOB
  mode, exchange address.
- Kalshi/DFlow: input/output mints, settlement mint, initialized-state checks,
  geo/proof policy.

The MCP client should not infer venue token semantics from labels alone.

### 3. Account, Readiness, And Funding

Expose a single readiness tool backed by existing status/account endpoints:

- `/auth/me` for user and linked wallets;
- `/wallets/venue-status` for venue readiness;
- `/wallets/balances` and `/wallets/balances/batch` for chain/token balances;
- `/trade/polymarket/account` and `/trade/polymarket/funder-derive`;
- `/trade/limitless/account` and `/trade/limitless/auth/verify`;
- `/trade/kalshi/account`;
- bridge chain/token/quote endpoints.

Readiness must report the next missing step, for example:

```text
missing_wallet
wallet_type_mismatch
missing_credentials
invalid_credentials
account_verification_required
account_verification_unavailable
approval_required
allowance_required
insufficient_balance
native_fee_required
low_native_balance
relayer_disabled
service_unavailable
market_not_accepting_orders
market_expired
geo_or_proof_blocked
bridge_required
```

`bridge_required` is a Phase 3 funding-plan blocker. Phase 2B readiness may
report missing balances and deposit targets, but it should not route bridge
execution or choose bridge recipients.

For agent trading, v1 should default to internal Privy Trading Wallets:

- EVM Trading Wallet for Polymarket and Limitless;
- Solana Trading Wallet for Kalshi/DFlow;
- no external wallets for automated or policy-approved execution.

This keeps deposit guidance simple for most cases: the deposit wallet is the
selected Trading Wallet on the needed chain. When venue state says the operational
wallet differs, for example a Polymarket funder/vault, the backend must return
that exact funding target instead of letting the agent guess.

Funding and bridge destinations must be backend-derived or backend-validated.
The agent can request a venue, wallet, asset, amount, and source preference, but
it cannot choose an arbitrary `targetAddress` in v1. Bridge recipients must be an
approved user Trading Wallet, venue funder, or bridge recipient derived from
Hunch venue state.

Funding plan output should include:

```ts
type AgentFundingPlan = {
  id: string;
  walletAddress: string;
  walletType: "ethereum" | "solana";
  venue?: "polymarket" | "kalshi" | "limitless";
  targetAddress: string;
  targetKind: "trading_wallet" | "venue_funder" | "bridge_recipient";
  chainId: string;
  chainName: string;
  asset: {
    symbol: string;
    address?: string | null;
    mint?: string | null;
    decimals: number;
  };
  missingAmountRaw?: string | null;
  missingAmountUi?: string | null;
  depositUri?: string | null;
  qrPayload: string;
  depositPageUrl: string;
  fundingPageUrl?: string | null;
  bridgeRequired: boolean;
  bridgeQuote?: unknown;
  warnings: string[];
  instructions: string[];
};
```

The API should not render a QR image. It should return structured funding data,
`qrPayload`, `depositUri`, and a first-party Hunch `depositPageUrl` or
`fundingPageUrl`. The hosted Hunch page is canonical because it can present
Hunch-styled QR, plain address, chain, asset, amount when known, copy controls,
warnings, and status in a user-verifiable context.

MCP tools may include `qrPayload` and copyable text guidance, but should prefer
showing the Hunch page link for normal users because MCP clients vary in image
support. The CLI may optionally render a terminal QR or write a PNG/SVG in a
later convenience feature, but that rendering must be derived only from the
backend-provided payload and must also print the plain address, chain, asset,
and amount guidance. No agent, MCP client, or CLI may construct or override the
target address.

Venue setup should be its own intent type, not hidden inside trade execution:

```ts
type VenueSetupIntent = {
  type: "venue_setup";
  venue: "polymarket" | "kalshi" | "limitless";
  walletAddress: string;
  marketId?: string;
};
```

For Polymarket and Limitless, this maps to the existing embedded
`ensure-ready/prepare` and `ensure-ready/execute` flows. For Kalshi/DFlow, it is
mostly readiness/proof/balance validation unless a future setup step is added.

### 4. Quote

Quote should be available before creating a write intent and should return a
normalized quote plus raw venue metadata.

Existing backends to reuse:

- Polymarket `/trade/polymarket/quote`, `/market-info`, `/order-params`;
- Limitless `/trade/limitless/amm/quote`, `/market/exchange`, and CLOB order
  preparation data;
- Kalshi/DFlow `/trade/kalshi/quote` and `/trade/kalshi/order`;
- bridge `/bridge/quote`.

Quotes should include amount, shares, price, fees, slippage, min received, order
type, expiry/staleness, and readiness blockers.

### 5. Create Intent

Intent creation should freeze:

- a non-null idempotency key;
- normalized market/outcome identifiers;
- quote inputs and quote timestamp;
- wallet and venue;
- policy decision;
- required user-confirmation status;
- exact prepared wallet payloads when available.

The backend should reject stale quotes or rebuild the quote at execution time and
show the user the changed economics before approval.

Prepared payloads should be stored by safe metadata and hashes wherever possible.
Secrets, Privy authorization signatures, partner credentials, and raw key
material must not be stored in plaintext JSONB.

### 6. Approve And Execute

Confirmation-required execution should reuse existing browser Privy signature
flows:

- Polymarket: embedded connect/approvals, order signing, fee authorization, CLOB
  placement, order sync.
- Limitless: embedded connect, order signing, AMM/CLOB placement, order sync.
- Kalshi/DFlow: unsigned quote/swap transaction, embedded Solana signing when
  supported, submit signed transaction, execution record.
- Bridge: quote/order creation, embedded EVM/Solana transaction signing when
  supported, submit/status tracking.

Execution must be idempotent and must bind approval to the exact prepared
payload or an explicitly refreshed quote.

Execution must also be concurrency-safe: `POST /agent/intents/:id/execute` locks
the intent row, verifies that the caller is allowed to execute it, validates the
current status transition, and only then dispatches to venue execution. A second
execute call for the same intent should return the existing terminal result or a
clear in-progress response, never submit another independent venue order.

Automatic execution mode should be treated as an extension of this same flow:

1. agent creates or previews an intent;
2. backend evaluates policy;
3. if policy allows and signing capability exists, backend executes;
4. otherwise backend returns `requiresUserConfirmation: true` and an approval
   link.

This means the agent can safely say "I can execute this automatically under your
current policy" only when the backend response says so.

### 7. Reconcile

After execution, expose:

- order status and open orders;
- position sync and by-token position lookup;
- execution/transaction status;
- bridge order status;
- updated balances;
- notifications or audit events.

Position management should include:

- list positions by wallet/venue;
- sync positions after execution;
- inspect by-token position for a selected market;
- hide/unhide or local portfolio-management actions only behind separate scopes;
- identify redeemable positions and expose redemption plans.

### 8. Redeem / Settle

Redemption is part of e2e trading and should not be deferred from the data model.
Add an intent type even if execution is confirmation-required:

```ts
type RedemptionIntent = {
  type: "redeem";
  venue: "polymarket" | "limitless";
  walletAddress: string;
  marketId?: string;
  tokenId?: string;
  conditionId?: string;
  outcome?: string;
};
```

Reuse existing redemption plan endpoints:

- `/trade/polymarket/redemption-plan`;
- `/trade/limitless/redemption-plan`;
- `/trade/limitless/redemption/status`.

## Phased Plan

### Phase 1: Read-Only MCP

- Create the separate `hunch-agent-tools` repo. **Implemented.**
- Add the MCP package and shared API client. **Implemented with local read-only
  types; generated API types remain pending.**
- Use existing public/read endpoints only. **Implemented.**
- Do not depend on device auth or private user account state in this phase.
- Add tests with mocked API responses. **Implemented for current read tools and
  packaging paths.**
- Ship docs for local setup in Codex/Claude. **Started.**

This proves the developer/user workflow without risking funds.

### Phase 2: Agent Grants

Phase 2A and Phase 2B are implemented as the read-only authenticated account
baseline. This phase is not a trading phase.

- In the Hunch monorepo, add one migration for `agent_grants`,
  `agent_device_authorizations`, and `agent_audit_events`. **Implemented.**
- In the Hunch monorepo, add token hashing, `/agent/device/*`,
  `/agent/grants`, `/agent/audit`, `/agent/me`, and
  `createAgentAuthMiddleware`. **Implemented.**
- In the Hunch monorepo, hash agent tokens/device codes/approval tokens with an
  agent-specific HMAC secret, use short device approval TTLs, redact raw tokens
  from logs/audit metadata, and re-check wallet ownership on agent access.
  **Implemented.**
- In the Hunch monorepo, add scope, wallet, venue, chain, and asset checks.
  **Implemented for read scopes.**
- In the frontend, add `/agent/approve/:approvalToken` and `/settings/agents` so
  users can approve limited grants, inspect connected agents, and revoke access.
  **Implemented as minimal UI.**
- In the external tools repo, enable Phase 2A authenticated tools for account
  and notifications first; add wallets, balances, positions, orders, readiness,
  deposit targets, and venue status in Phase 2B. **Implemented.**
- In the external tools repo, support multiple local auth profiles:
  `auth login --profile`, `auth list`, `auth use`, and
  `auth logout --profile`; authenticated tools may accept optional `profile`.
  **Implemented.**
- In the external tools repo, keep local token files permission-restricted,
  redact token output, ignore expired profiles, and treat `HUNCH_AGENT_TOKEN` as
  an explicit escape hatch instead of the normal multi-account UX. Explicit
  profile and active-profile selection must win over the environment token;
  later write/intent tools must require a named profile unless the user
  explicitly passes an override such as `--allow-env-token`. **Implemented for
  current read tools.**
- Add backend API tests for expiry, revocation, scope denial, wallet denial,
  token hash lookup, one-time token issuance, expiry, rate limits, max attempts,
  polling limits, HMAC hashing, entropy, redaction, and wallet re-checks.
  **Partially implemented; keep as a QA checklist before broad rollout.**
- Add external repo tests for auth flow polling, token storage, redaction, and
  authenticated read tool errors, including multi-profile selection.
  **Implemented for current tools.**
- Add frontend tests for logged-out redirect/return, approve, deny, revoke, and
  no-token-exposure behavior. **Still pending.**

### Current Next Steps After Phase 2B

1. Run a focused pre-merge QA pass for the Phase 2B read-only baseline:
   backend typecheck/lint/build, frontend `bun check`, agent-tools
   typecheck/lint/test/release smoke, and one local auth read flow after
   migration.
2. Add or backfill missing frontend tests for `/agent/approve/:approvalToken`,
   `/settings/agents`, revoke, deny, logged-out redirect, and "token never
   appears in browser response" behavior.
3. Tighten operational rollout docs: required env vars, migration order,
   feature flag state, local/prod plugin release process, and rollback steps.
4. Decide whether generated OpenAPI types should become the agent-tools API
   boundary before Phase 3. This is useful but should not block Phase 2B if the
   current narrow schemas remain covered by tests.
5. Treat `discovery_map(level=1)` empty results as a backend/data follow-up, not
   an MCP schema blocker.
6. Start Phase 3 only after Phase 2B is stable in production. Phase 3 should add
   preview/intent records and funding-plan reads; it must still avoid direct
   MCP-side transaction construction or unattended signing.

### Phase 3: Preview And Intent Records

- Add `/agent/intents/preview` and `/agent/intents`.
- Add `/agent/funding-plan` for deposit address, QR payload, bridge suggestion,
  missing-balance guidance, and a canonical Hunch-hosted funding page URL.
- Normalize venue setup, funding, trade, bridge, cancel, and redemption requests
  into one intent model.
- Reuse existing market lookup, quote, bridge, and venue preparation services.
- Add policy evaluation using grant limits and user trading preferences.
- Add audit events.
- Enforce non-null idempotency keys and backend-derived funding/bridge targets.
- Add tests for limit decisions, idempotency, unsupported venues, missing
  wallet, expired market handling, backend-derived funding targets, and venue
  readiness blockers.

### Phase 4: Confirmation-Required Execution

- Add `/agent/intents/:intentId` for pending agent intents.
- User approval should run the same Privy authorization-signature flow used by
  normal trading.
- Execution should dispatch to existing venue/bridge routes or extracted shared
  service functions.
- Add tests that a trade intent cannot execute without approval/signatures and
  that approval binds to the exact prepared payload.
- Add tests for legal/illegal status transitions, row locking, duplicate execute
  calls, and terminal-result replay.
- Add frontend tests for intent details, reject, confirm, stale quote handling,
  insufficient-funds/funding guidance, and Privy authorization errors.

### Phase 5: Policy Automation

- Only after Phase 4 is stable, allow low-risk automation where no wallet
  signature is required, for example read/account actions and possibly order
  cancellation if venue credentials allow it safely.
- For signed trade/bridge execution, do not enable no-confirmation mode until
  Privy delegated signing or another explicit user-approved signing mechanism is
  implemented and tested.
- Add daily spend counters and open-order exposure accounting before any
  auto-trade mode.

### Phase 6: Delegated Signing Research/Implementation

- Configure and validate Privy Signers for the Hunch Privy app, including app
  authorization key / key quorum creation, policy creation, signer attachment,
  signer removal, and server-side transaction execution.
- Add server secret storage for Privy authorization-key material. Store only
  revocable signer/grant identifiers, policy IDs, and metadata in Postgres.
- Bind delegation to grant limits, wallets, chains, and expiry.
- Build a signer adapter that signs only after the normalized intent and Hunch
  policy evaluator approve the exact payload.
- Validate each venue payload against Privy policy expressiveness:
  Polymarket/Limitless EVM typed data and transactions first, Kalshi/DFlow
  Solana transactions second, bridges last.
- Add kill switch in runtime policy.
- Add dry-run and canary mode before production enablement.

## KISS / DRY Rules

- Keep MCP/CLI/skill distribution in the separate agent-tools repo and backend
  implementation in the Hunch monorepo.
- Use generated API types as the repo boundary; do not import Hunch backend
  packages from the external tools repo.
- Do not build separate venue-specific MCP servers.
- Do not let the MCP client construct Polymarket/Limitless/Kalshi transactions
  itself. It should request previews/intents from Hunch.
- Do not expose AGG, DFlow, Privy app secrets, venue partner credentials, or
  existing browser sessions to the MCP client.
- Keep venue-specific correctness in existing venue services.
- Keep cross-cutting safety in one agent policy evaluator.
- Prefer short-lived device grants and revocation over long-lived broad API
  keys.

## Security Checklist

- Agent tokens are generated once and stored only as hashes server-side.
- Every write has scope, wallet, venue, market, amount, and slippage checks.
- Every write has chain and asset checks when funds can move.
- Every write has an idempotency key.
- Every execute path locks the intent row and validates the status transition.
- Every write creates an audit event.
- Every signed wallet action is bound to an exact prepared payload.
- Funding and bridge destinations are backend-derived or backend-validated.
- Sensitive payloads, signatures, tokens, and partner credentials are not stored
  in plaintext JSONB.
- User confirmation shows venue, market, side, amount, price, slippage, wallet,
  and estimated fees.
- Grants are revocable and expiring.
- Runtime policy can disable all agent writes globally.
- Existing geo, proof, and venue readiness checks remain in force.
- MCP tools clearly distinguish quote, intent creation, approval, and execution.

## Open Questions

- Which Privy Signers features are enabled for the Hunch Privy app today, and
  what dashboard/API setup is required before implementation?
- Can Privy policies safely express the exact EVM typed-data, EVM transaction,
  and Solana instruction constraints needed for each venue payload?
- What is the operational storage plan for Privy app authorization-key material
  in each environment?
- What short retention, if any, is required for encrypted raw signed payloads?
- Should unattended mode ever support bridge operations, or should bridge always
  require explicit confirmation because mistakes can strand funds?
- Which write scopes should be allowed first: cancel-only, small limit orders,
  or no writes until the approval UI is complete?
- Should grant limits be per wallet only, or also per venue market and category?
- How should mobile users approve pending intents when the agent is running on a
  desktop machine?
- Should `hunch-agent-tools` be public from Phase 1, or private until
  authenticated/write tools are ready?

## Recommendation

Build this in order:

1. Read-only MCP. **Done.**
2. Agent grant/device auth plus authenticated read tools. **Done as the Phase 2B
   read-only baseline; keep QA/rollout checks active.**
3. Intent preview and policy records. **Next implementation phase.**
4. Confirmation-required execution through existing Privy/browser approval.
5. Limited automation only after delegated signing and exposure accounting are
   explicitly implemented.

This gives users useful agent workflows early while preserving the strongest
part of the current architecture: venue-specific correctness and wallet signing
stay inside the existing Hunch/Privy flow.
