# PnL Shares And Redemption API Handoff

This document describes the backend contract for public PnL share snapshots,
position-backed trade PnL shares, normalized redemption status fields, and the
portfolio position/PnL read semantics that support those surfaces.

The public user app remains backward compatible. New routes are additive. New
market response fields are additive. Existing portfolio PnL hidden-loss
semantics are preserved: hidden positions are hidden from the table UI by
default, but still count toward all-time PnL.

## Overview

There are three related surfaces:

- **Portfolio PnL share snapshots**: authenticated users create immutable,
  backend-computed public snapshots of their current portfolio PnL scope.
- **Trade PnL share snapshots**: authenticated users create immutable public
  snapshots backed by one owned `positions` row. Product can call this an
  "individual trade", but the v1 backend source of truth is a position row, not
  a reconstructed order/fill lifecycle.
- **Redemption status**: market detail and market-by-token responses include a
  normalized, read-only `redemption` object derived from existing database
  fields. List/detail reads do not call chain RPC.

## Data Model

Migration:

```bash
pnpm -C hunch-monorepo migrate
```

Table:

```sql
share_snapshots (
  id text primary key,
  kind text check (kind in ('portfolio_pnl', 'trade_pnl')),
  user_id uuid references users(id) on delete set null,
  referral_code text,
  snapshot jsonb not null,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  expires_at timestamptz null
)
```

Share IDs are non-enumerable:

- Portfolio: `pnl_` + 22 base62 chars.
- Trade/position: `trade_` + 22 base62 chars.

Snapshots are immutable in v1. There is no refresh, delete, or list endpoint.

## Auth And Rate Limits

Create routes require normal user auth:

- `POST /shares/portfolio-pnl`
- `POST /shares/trade-pnl`

Public read routes do not require auth:

- `GET /shares/:shareId`
- `GET /shares/portfolio-pnl/:shareId`
- `GET /shares/trade-pnl/:shareId`

Creation is rate limited per user:

- key: `shares:create:{userId}`
- limit: `60` creates per hour
- Redis failure mode: fail-open
- limit response: `429 { "error": "rate_limit_exceeded" }`

## Portfolio PnL Share Create

`POST /shares/portfolio-pnl`

Request:

```json
{
  "source": "portfolio",
  "referralCode": "OPTIONAL",
  "venue": "polymarket",
  "venues": ["polymarket", "kalshi"],
  "wallets": ["0x...", "solana..."],
  "topPositionId": "uuid"
}
```

Field rules:

- `source` defaults to `portfolio` and must be `portfolio` when provided.
- `referralCode` is optional. If omitted, backend uses the current user's own
  active referral code when available.
- `venue` is optional and supports `polymarket`, `kalshi`, or `limitless`.
- `venues` is optional CSV/array input and is normalized/deduped.
- `wallets` is optional CSV/array input. If omitted, backend uses the
  authenticated request wallet scope.
- `topPositionId` is optional. If supplied, it must belong to the authenticated
  user, be non-hidden, and be inside the requested wallet/venue scope.

Backend behavior:

- Computes all PnL server-side from `positions`; client-supplied PnL values are
  ignored.
- Expands Polymarket signer/funder/order wallets when the requested scope
  includes Polymarket or no venue filter.
- Uses only supported portfolio venues for unscoped reads: `polymarket`,
  `kalshi`, and `limitless`. Non-portfolio venue values from other feature
  branches are excluded until the venue is explicitly supported by this API.
- Auto-picks the non-hidden own position with the largest absolute effective
  PnL when `topPositionId` is omitted.
- Hidden loss rows still count in aggregate all-time PnL. Hidden only suppresses
  default table visibility; it is not a portfolio accounting exclusion.

Response:

```json
{
  "id": "pnl_0AaBbCcDdEeFfGgHhIiJjK",
  "kind": "portfolio_pnl",
  "createdAt": "2026-06-17T12:00:00.000Z",
  "asOf": "2026-06-17T12:00:00.000Z",
  "referralCode": "X0RB0T",
  "realizedPnlCents": -2538,
  "unrealizedPnlCents": 0,
  "totalPnlCents": -2538,
  "unrealizedPnlPercentBasisPoints": 0,
  "topPosition": {
    "positionId": "uuid",
    "venue": "polymarket",
    "eventId": "polymarket:123",
    "marketId": "polymarket:456",
    "eventTitle": "Event title",
    "marketTitle": "Market title",
    "outcome": "YES",
    "size": "10",
    "entryPrice": "0.5",
    "currentPrice": "0.62",
    "realizedPnlCents": 0,
    "unrealizedPnlCents": 120,
    "totalPnlCents": 120,
    "pnlPercentBasisPoints": 2400,
    "image": {
      "url": "https://...",
      "fallbackKey": "polymarket:polymarket:456"
    }
  }
}
```

`topPosition` can be `null`.

## Trade PnL Share Create

`POST /shares/trade-pnl`

Request:

```json
{
  "source": "position",
  "positionId": "uuid",
  "referralCode": "OPTIONAL"
}
```

Field rules:

- `source` must be `position`.
- `positionId` must be an owned, non-hidden position row for the authenticated
  user.
- `referralCode` follows the same validation/defaulting behavior as portfolio
  shares.

Response:

```json
{
  "id": "trade_0AaBbCcDdEeFfGgHhIiJjK",
  "kind": "trade_pnl",
  "source": "position",
  "createdAt": "2026-06-17T12:00:00.000Z",
  "asOf": "2026-06-17T12:00:00.000Z",
  "referralCode": "X0RB0T",
  "positionId": "uuid",
  "positionStatus": "open",
  "venue": "polymarket",
  "eventId": "polymarket:123",
  "marketId": "polymarket:456",
  "eventTitle": "Event title",
  "marketTitle": "Market title",
  "outcome": "NO",
  "side": "LONG",
  "size": "10",
  "entryPrice": "0.5",
  "exitPrice": null,
  "currentPrice": "0.42",
  "realizedPnlCents": 0,
  "unrealizedPnlCents": -80,
  "totalPnlCents": -80,
  "pnlPercentBasisPoints": -1600,
  "openedAt": "2026-06-16T12:00:00.000Z",
  "closedAt": null,
  "image": {
    "url": "https://...",
    "fallbackKey": "polymarket:polymarket:456"
  }
}
```

`positionStatus` is `closed` when the row is flat or size is zero. `closedAt`
uses the position `updated_at` timestamp for closed rows.

`pnlPercentBasisPoints` is intentionally conservative:

- It is computed only when there is a current open cost basis and no realized
  PnL on the row.
- It is `null` for closed rows, missing/zero cost basis, or partial-realized
  rows, because v1 does not have a reliable lifetime denominator.

## Public Share Reads

`GET /shares/:shareId`

Returns either share kind by ID.

Kind-specific aliases:

- `GET /shares/portfolio-pnl/:shareId`
- `GET /shares/trade-pnl/:shareId`

Aliases enforce the expected kind and return `404` if the ID exists with a
different kind.

Errors:

- unknown or expired ID: `404 { "error": "Share not found" }`
- invalid owned-position or out-of-scope top position on create: `404`
- invalid/inactive referral code on create: `400`
- no wallet scope on portfolio create: `400`

Public share responses must not expose:

- `user_id`
- wallet addresses
- signer/funder addresses
- raw orders/fills
- venue order IDs
- private balances
- auth-only account data

## Referral Code Semantics

Share creation normalizes referral codes through existing rewards/referral
logic.

If `referralCode` is supplied:

- invalid, inactive, or exhausted codes return `400`.
- creation does not attach a referral to the current user.
- creation does not award points or rewards.

If `referralCode` is omitted:

- backend uses the user's current active own referral code when available.
- invalid/missing own code silently becomes `null`.

## Redemption Field

Market detail and market-by-token responses now include `redemption` alongside
the existing raw `redemptionStatus`.

Surfaces:

- `GET /markets/:marketId`
- `GET /markets/by-token?tokenIds=...`
- `GET /positions?includeMarkets=true` through nested market metadata

Shape:

```json
{
  "redemptionStatus": "ready",
  "redemption": {
    "status": "redeemable",
    "reasonCode": "ready",
    "reason": "Position is resolved and redeemable.",
    "redeemableAt": null,
    "resolvedOutcome": "YES",
    "resolvedOutcomePct": null,
    "rawStatus": "ready"
  }
}
```

Status enum:

- `market_open`
- `closed`
- `pending_resolution`
- `settlement_pending`
- `resolved_not_redeemable`
- `redeemable`
- `redeemed`
- `failed_retryable`

The normalized field is explanatory and read-only. It is derived from existing
read-model fields:

- market status
- close/expiration/end time
- `redemption_status`
- `resolved_outcome`
- `resolved_outcome_pct`
- token outcome side when available
- optional position size when the caller has position context

Do not use this field as the transaction-readiness source of truth for submit
flows. Explicit redeem/prepare flows still use the existing redemption plan
builders and can call chain RPC where needed.

## Portfolio Position Read Notes

The portfolio page should use the position endpoints this way:

- Default active view: do not request `minSize=0`; use the default min size or
  pass `MIN_POSITION_SIZE`.
- "Small positions" enabled: pass `minSize=0`.
- "Resolved losses" enabled: pass `includeHidden=true`.
- Hidden positions are only suppressed from the default UI. They remain valid
  position rows and still count in `/positions/pnl` all-time PnL.

`GET /positions/pnl` returns aggregate accounting for the requested supported
portfolio venue scope. It does not exclude hidden losses.

Unscoped position reads are limited to supported portfolio venues:

- `polymarket`
- `kalshi`
- `limitless`

Non-portfolio venue values from other feature branches should not be displayed
by these portfolio APIs until the backend/frontend explicitly support that
venue.

## Frontend Integration Notes

For share creation:

- Use the existing Next proxy under `/api/hunch/*` so auth cookies and CSRF are
  handled consistently.
- Create snapshots from server data only. Do not send client-computed PnL as a
  source of truth.
- Treat returned snapshots as immutable. If the user wants a fresher card,
  create a new share.
- Render `pnlPercentBasisPoints: null` as omitted/unknown, not as `0%`.
- Use `image.url` when available and `image.fallbackKey` for deterministic OG
  fallback art if the external image fails.

For public share pages:

- Fetch `GET /shares/:shareId` without auth.
- Use `kind` to branch portfolio vs trade layout.
- Do not require wallet/session state to render the public page.
- Crawlers should consume the frontend-generated share image route, not raw
  venue image URLs directly.

For redemption display:

- Prefer `market.redemption.status` and `reason` for user-facing wait/redeem
  explanations.
- Keep raw `redemptionStatus` available for diagnostics only.
- Do not start RPC fanout from list/table screens based on `redemption`.

## Backend Files

Primary implementation:

- `apps/api/src/routes/shares.ts`
- `apps/api/src/schemas/shares.ts`
- `apps/api/src/services/share-snapshots.ts`
- `apps/api/src/repos/shares.ts`
- `apps/api/src/services/redemption-status.ts`
- `apps/api/src/services/markets-by-token-response.ts`
- `apps/api/src/routes/markets.ts`
- `apps/api/src/repos/positions-repo.ts`
- `packages/db/migrations/0158_share_snapshots.sql`

Registration:

- `apps/api/src/routes/index.ts`

## QA

Backend:

```bash
pnpm -C hunch-monorepo -F api test -- shares positions-routes markets-redemption-status positions-repo
pnpm -C hunch-monorepo -F api run typecheck
pnpm -C hunch-monorepo -F api run lint
```

Frontend after integrating share pages/buttons:

```bash
cd Hunch_App
bun run type-check
bun run lint
```

Manual smoke examples through the frontend proxy:

```http
POST /api/hunch/shares/portfolio-pnl
POST /api/hunch/shares/trade-pnl
GET /api/hunch/shares/pnl_...
GET /api/hunch/shares/trade_...
GET /api/hunch/markets/by-token?tokenIds=...&includeTop=true
GET /api/hunch/positions/pnl?wallets=...
```

## Compatibility

Backward compatible changes:

- `/shares/*` routes are new.
- `share_snapshots` migration is additive.
- Market responses add `redemption`; older clients can ignore it.
- Existing `redemptionStatus` remains present.
- Existing position/PnL response wrappers remain unchanged.

Behavioral fixes:

- Resolved position PnL is normalized so resolved rows report effective PnL as
  realized and no longer carry stale unresolved PnL.
- Default portfolio position reads should avoid flat-row overfetch unless the
  frontend explicitly requests dust/resolved rows.
- Unscoped portfolio reads exclude non-portfolio venue values until that venue
  is supported end-to-end.
