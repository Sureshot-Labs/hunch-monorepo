# Agent / MCP Trading Access Plan

Last updated: 2026-05-11

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

The shared code should live underneath both:

```text
packages/hunch-agent-client
  src/client.ts          # fetch wrapper, auth headers, retries, redaction
  src/types.ts           # shared DTOs and Zod schemas
  src/device-auth.ts     # device-code polling client
  src/tools.ts           # implementation functions: search, quote, intent, etc.
  src/token-store.ts     # keychain/file/env abstraction for local tokens
  src/errors.ts          # safe error shapes for agents

apps/mcp-hunch
  src/server.ts          # MCP tool registration
  src/tools/*.ts         # thin tool adapters over hunch-agent-client
  package.json           # binary: hunch-mcp

apps/hunch-agent-cli
  src/cli.ts             # optional CLI: auth, search, quote, intent, execute
  package.json           # binary: hunch-agent

skills/hunch-trading
  SKILL.md               # concise workflow and safety instructions
  agents/openai.yaml     # Codex UI metadata
  scripts/hunch-agent    # tiny wrapper invoking the installed CLI, if needed
  references/tools.md    # tool/command reference loaded only when needed
```

If that feels like too many packages at first, keep the deployable/package
surface to two units:

```text
packages/hunch-agent-client
apps/mcp-hunch
```

and expose the CLI as an extra binary from `apps/mcp-hunch`. The important DRY
rule is that MCP tools and skill scripts both call `hunch-agent-client`; neither
should hand-roll HTTP calls.

Recommended runtime behavior:

1. If MCP tools are available, the skill tells the agent to prefer them.
2. If MCP is not available, the skill falls back to `hunch-agent` CLI commands.
3. If neither is available, the skill explains the required install/auth step
   and stops before any authenticated action.

This makes the skill useful in Codex while the MCP server remains the portable
integration for Claude Code and other clients.

### Skill Runtime Wrapper And Session

The skill can include a runtime wrapper, but that wrapper should be a thin CLI
shim. It should not have its own auth stack.

Good shape:

```text
skills/hunch-trading/scripts/hunch
  -> finds/invokes installed `hunch-agent`
    -> uses packages/hunch-agent-client
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

1. `HUNCH_AGENT_TOKEN` for CI or temporary one-off use.
2. OS keychain when available.
3. File fallback with `0600` permissions, for example:
   `~/.config/hunch/agent/sessions.json`.

The stored local session should include only:

```json
{
  "baseUrl": "https://api.hunch.app",
  "grantId": "uuid",
  "token": "one-time-visible-agent-token",
  "expiresAt": "2026-06-10T00:00:00.000Z",
  "scopes": ["read:markets", "quote:trade", "prepare:trade"],
  "walletAddresses": ["0x...", "solana..."]
}
```

The token is sensitive locally, but still limited server-side by scopes, wallets,
venues, expiry, confirmation mode, and spend limits. A leaked agent token should
not be equivalent to a browser session.

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
4. The MCP server polls until approved.
5. The backend returns one agent token once.
6. The MCP server stores it locally in the user's agent config/keychain.
7. The backend stores only a hash of the token.

Avoid using the existing Hunch browser session token as the MCP credential except
as a local development shortcut.

Recommended DB tables:

```sql
agent_grants (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scopes text[] not null,
  wallet_addresses text[] not null,
  venues text[] not null,
  allowed_chains text[] not null default '{}',
  allowed_assets text[] not null default '{}',
  confirmation_mode text not null,
  limits jsonb not null,
  is_active boolean not null default true,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

agent_device_authorizations (
  id uuid primary key,
  device_code_hash text not null unique,
  user_code_hash text not null unique,
  status text not null,
  requested_scopes text[] not null,
  approved_grant_id uuid references agent_grants(id) on delete set null,
  poll_count integer not null default 0,
  approval_attempts integer not null default 0,
  last_polled_at timestamptz,
  approved_at timestamptz,
  token_issued_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

Device-code auth requirements:

- device codes and user codes are single-use and short-lived;
- `/agent/device/token` returns the agent token only once;
- polling has a minimum interval and max poll count;
- user-code approval has a max attempt count and IP/session rate limit;
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
https://hunch.app/agent/connect?code=<user-code>
```

Intent approval link:

```text
https://hunch.app/agent/intents/<intent-id>
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

1. User opens `/agent/connect` or `/agent/intents/:id`.
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
POST /agent/device/approve
POST /agent/device/token
GET  /agent/capabilities
GET  /agent/grants
POST /agent/grants
DELETE /agent/grants/:id
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
POST /agent/intents/preview
POST /agent/intents
GET  /agent/intents/:id
POST /agent/intents/:id/execute
GET  /agent/audit
GET  /agent/funding-plan
```

Browser-user session routes:

```text
POST /agent/device/approve
GET  /agent/grants
POST /agent/grants
DELETE /agent/grants/:id
POST /agent/intents/:id/approve
```

Do not let an agent token approve its own device login, widen its own grant, or
approve its own pending intent. Those actions require the user's normal Hunch
session and, when signing is needed, Privy authorization in the browser.

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
agent_intents (
  id uuid primary key,
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

agent_audit_events (
  id uuid primary key,
  grant_id uuid references agent_grants(id) on delete set null,
  intent_id uuid references agent_intents(id) on delete set null,
  user_id uuid not null references users(id) on delete cascade,
  event_type text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
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

Package the MCP server as `apps/mcp-hunch`. Keep reusable HTTP/session/tool
logic in `packages/hunch-agent-client`.

Read tools:

```text
hunch_search_markets
hunch_get_market
hunch_get_event
hunch_get_feed
hunch_get_similar_markets
hunch_get_similar_events
hunch_get_market_map
hunch_get_discovery_sidebars
hunch_get_clusters
hunch_get_prices
hunch_get_account
hunch_get_wallets
hunch_get_wallet_balances
hunch_get_venue_status
hunch_get_funding_plan
hunch_get_positions
hunch_get_orders
hunch_get_deposit_address
hunch_get_bridge_options
hunch_get_redemption_plan
hunch_get_notifications
```

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
missing_venue_connect
approval_required
insufficient_balance
bridge_required
native_fee_required
market_not_accepting_orders
market_expired
geo_or_proof_blocked
```

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
  bridgeRequired: boolean;
  bridgeQuote?: unknown;
  instructions: string[];
};
```

The API does not need to render a QR image. It should return `qrPayload` and
`depositUri`; the MCP/CLI or frontend can render a QR code from that payload.
For text-only agents, the tool should also return copyable address, chain, asset,
and amount guidance.

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

- Add the MCP package with typed API client wrappers.
- Use existing public/read endpoints only.
- Do not depend on device auth or private user account state in this phase.
- Add tests with mocked API responses.
- Ship docs for local setup in Codex/Claude.

This proves the developer/user workflow without risking funds.

### Phase 2: Agent Grants

- Add `agent_grants`, device auth tables, and token hashing.
- Add `/agent/device/*`, `/agent/grants`, and `createAgentAuthMiddleware`.
- Add scope, wallet, venue, chain, and asset checks.
- Enable authenticated read tools for account, wallets, balances, positions,
  orders, funding plan, and venue readiness.
- Add UI to create/revoke grants and inspect last use.
- Add API tests for expiry, revocation, scope denial, wallet denial, and token
  hash lookup.
- Add device-code tests for one-time token issuance, expiry, rate limits, max
  attempts, and polling limits.

### Phase 3: Preview And Intent Records

- Add `/agent/intents/preview` and `/agent/intents`.
- Add `/agent/funding-plan` for deposit address, QR payload, bridge suggestion,
  and missing-balance guidance.
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

- Add a Hunch UI surface for pending agent intents.
- User approval should run the same Privy authorization-signature flow used by
  normal trading.
- Execution should dispatch to existing venue/bridge routes or extracted shared
  service functions.
- Add tests that a trade intent cannot execute without approval/signatures and
  that approval binds to the exact prepared payload.
- Add tests for legal/illegal status transitions, row locking, duplicate execute
  calls, and terminal-result replay.

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

## Recommendation

Build this in order:

1. Read-only MCP.
2. Agent grant/device auth plus authenticated read tools.
3. Intent preview and policy records.
4. Confirmation-required execution through existing Privy/browser approval.
5. Limited automation only after delegated signing and exposure accounting are
   explicitly implemented.

This gives users useful agent workflows early while preserving the strongest
part of the current architecture: venue-specific correctness and wallet signing
stay inside the existing Hunch/Privy flow.
