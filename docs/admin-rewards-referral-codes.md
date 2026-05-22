# Admin Rewards Referral Codes Handoff

This document describes the backend contract for admin-panel work around
referral-code campaigns, partner labels, multiplier context, and rewards point
visibility. It also lists the System/Ops read APIs added in the same admin
handoff batch so the new external panel has one implementation document.

The public user app remains backward compatible. Existing fields stay in place;
new fields are additive unless noted.

## Overview

Referral codes now have two layers:

- **Code alias**: the string users enter, such as `POLY15`.
- **Policy**: live config attached to that code, including label, multiplier,
  visible drop points, and tier-only drop points.

Codes can be:

- `user`: owned by a normal user. This is the user's share code.
- `campaign`: ownerless partner/promo campaign code.

Important lifecycle rules:

- Current user codes are active and attachable.
- Old user codes are retired when a user changes code. Retired codes are not
  attachable, but existing referrals keep attribution through them.
- Code strings are globally reserved. A historical user code cannot later become
  a campaign code.
- Campaign codes can be deactivated. Deactivation blocks future attaches only.
- Policy edits are live for already-attached users.

## External Panel Work To Add

This is a capability checklist, not a navigation recommendation. The external
panel can decide placement and grouping.

Referral-code capabilities:

- List and filter referral codes.
- Create ownerless campaign code.
- Edit policy fields for any code.
- Deactivate campaign codes.
- Open a code drilldown listing users referred by that code.
- Show inbound referral campaign metadata on user list/detail.
- Use clear labels:
  - `Share code`: the user's own code.
  - `Used referral code`: the inbound code this user attached with.
  - `Referred by`: the source user or campaign label.
- Use the new point fields to avoid showing private tier-only points as public
  points.

Rewards multiplier capabilities:

- Edit the global multiplier display label separately from multiplier policy
  notes.
- Edit user override display labels separately from override reasons.
- Render a multiplier badge label only when the winning multiplier source
  returns an explicit label.

System/Ops capabilities added for the external panel:

- Postgres health and slow-query stats from `/admin/system/postgres`.
- Indexer hot-token, stream-hot-token, price-refresh queue, and heartbeat stats
  from `/admin/system/indexers`.
- Existing vector stats remain at `/admin/vector`; keep them conceptually
  separate from System/Ops stats.

Do not add a hard-delete control. Backend supports deactivation/retirement, not
delete.

## Permissions

Routes use existing admin permissions:

| Feature | Route family | Permission |
| --- | --- | --- |
| List referral codes | `/admin/rewards/referral-codes` | `rewards:read` |
| Create/update campaign or policy | `/admin/rewards/referral-codes/*` | `rewards:write` |
| Referred users by code | `/admin/rewards/referral-codes/by-code/:code/referrals` | `rewards:read` and `users:read` |
| User current-code management | `/admin/users/:id/referral-code` | `users:write` |
| User list/detail metadata | `/admin/users`, `/admin/users/:id` | `users:read` |
| Multiplier policy | `/admin/rewards/multiplier-policy` | `rewards:read` / `rewards:write` |
| Multiplier overrides | `/admin/rewards/multiplier-overrides` | `rewards:read` / `rewards:write` |
| Manual points | `/admin/rewards/points`, `/admin/points/manual-events` | `rewards:write` / `rewards:read` |
| Postgres System/Ops stats | `/admin/system/postgres` | `analytics:read` |
| Indexer System/Ops stats | `/admin/system/indexers` | `analytics:read` |
| Vector stats | `/admin/vector` | `analytics:read` |

Frontend should still handle backend `403`; hiding UI is not the security
boundary.

## Referral Code List

`GET /admin/rewards/referral-codes`

Query params:

- `q`: optional text search.
- `policyType`: optional, `user` or `campaign`.
- `active`: optional boolean.
- `usageLimit`: optional, `limited` or `unlimited`.
- `limit`: optional, default `50`, max `100`.
- `offset`: optional.

Example:

```http
GET /admin/rewards/referral-codes?policyType=campaign&active=true&limit=50
```

Response:

```json
{
  "ok": true,
  "items": [
    {
      "id": "f8f16b6f-29c2-44df-bc42-24cb20a34f7a",
      "code": "POLY15",
      "isActive": true,
      "retiredAt": null,
      "retiredReason": null,
      "maxUses": 100,
      "uses": 42,
      "remainingUses": 58,
      "policy": {
        "id": "e2d7b08d-6d55-47de-9c36-3b0be1582a11",
        "type": "campaign",
        "label": "Polymarket",
        "multiplierOverride": 1.5,
        "visibleDropPoints": 100,
        "tierDropPoints": 400,
        "ownerUserId": null,
        "owner": null
      },
      "referralCount": 42,
      "createdAt": "2026-05-22T12:00:00.000Z",
      "updatedAt": "2026-05-22T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Implementation notes:

- Show `code`, `policy.type`, `policy.label`, `policy.multiplierOverride`,
  `visibleDropPoints`, `tierDropPoints`, `isActive`, `retiredAt`, and
  `referralCount`.
- `uses` is the successful attach count for this exact code alias.
- `maxUses: null` means unlimited. `remainingUses` is `null` for unlimited
  codes.
- Use `usageLimit=limited` for capped codes and `usageLimit=unlimited` for
  uncapped codes. This composes with `q`, `policyType`, and `active`.
- For `user` policies, show `policy.owner`.
- For inactive/retired codes, visually mark them as not attachable.

## Create Campaign Code

`POST /admin/rewards/referral-codes/campaigns`

Request:

```json
{
  "code": "POLY15",
  "label": "Polymarket",
  "multiplierOverride": 1.5,
  "visibleDropPoints": 100,
  "tierDropPoints": 400,
  "maxUses": 100
}
```

Field rules:

- `code`: 3 to 10 chars. Backend normalizes to uppercase alphanumeric.
- `label`: optional display label, max 120 chars.
- `multiplierOverride`: optional positive number. Omit or clear later for no
  partner multiplier.
- `visibleDropPoints`: optional nonnegative number, defaults to `0`.
- `tierDropPoints`: optional nonnegative number, defaults to `0`.
- `maxUses`: optional positive integer. Omit for unlimited.

Response:

```json
{
  "ok": true,
  "item": {
    "id": "f8f16b6f-29c2-44df-bc42-24cb20a34f7a",
    "code": "POLY15",
    "isActive": true,
    "retiredAt": null,
    "retiredReason": null,
    "maxUses": 100,
    "uses": 0,
    "remainingUses": 100,
    "policy": {
      "id": "e2d7b08d-6d55-47de-9c36-3b0be1582a11",
      "type": "campaign",
      "label": "Polymarket",
      "multiplierOverride": 1.5,
      "visibleDropPoints": 100,
      "tierDropPoints": 400,
      "ownerUserId": null,
      "owner": null
    },
    "referralCount": 0,
    "createdAt": "2026-05-22T12:00:00.000Z",
    "updatedAt": "2026-05-22T12:00:00.000Z"
  }
}
```

Common errors:

- `400`: invalid code or invalid field value.
- `409`: code string is already reserved by active, retired, user, or campaign
  code.

## Update Code Policy

`PATCH /admin/rewards/referral-codes/:id`

This updates policy fields for user codes and campaign codes. It does not change
the code string.

Request:

```json
{
  "label": "Polymarket",
  "multiplierOverride": 1.5,
  "visibleDropPoints": 100,
  "tierDropPoints": 400,
  "maxUses": 100
}
```

Clear nullable policy fields by sending `null`:

```json
{
  "label": null,
  "multiplierOverride": null,
  "maxUses": null
}
```

Deactivate a campaign code:

```json
{
  "deactivate": true
}
```

Notes:

- `deactivate` is allowed only for `campaign` codes.
- Deactivation blocks new attaches. Existing attached users keep the policy
  relationship; clear `multiplierOverride` if the partner multiplier should stop
  applying to existing users.
- Drop point fields are attach-time incentives only. Changing them later does
  not retroactively grant old referrals.
- Limited-use caps apply only to campaign codes.
- A use is counted only when a new referral attachment row is created.
  Already-attached retries do not consume capacity.
- Backend rejects `maxUses` lower than current `uses`.
- When a successful attach reaches `maxUses`, backend automatically retires the
  code with `retiredReason: "usage_limit_reached"`.
- To reactivate a capped retired code, raise `maxUses` above current `uses` or
  clear it to `null`, then send `reactivate: true`.

Response shape is the same `item` object used by create/list.

## User Current Referral Code

Existing endpoint remains:

`POST /admin/users/:id/referral-code`

Request:

```json
{
  "code": "NEWHUNCH",
  "forceTransfer": false
}
```

Behavior:

- Retires the user's old active code alias.
- Creates a new active alias linked to the same user policy.
- Updates `users.referral_code` for compatibility.
- Existing referred users keep pointing to their original retired alias and the
  same live user policy.
- `forceTransfer` must not be used for historically used codes. Backend returns
  conflict if the code has referral history. Use it only for unused code
  cleanup/reassignment.

Response:

```json
{
  "ok": true,
  "code": "NEWHUNCH",
  "transferredFromUserId": null
}
```

## User List And Detail Additions

`GET /admin/users`

The existing user list response keeps `points` as public points and adds:

```json
{
  "points": 173,
  "tierPoints": 573,
  "qualificationPoints": 1073,
  "rawPoints": 1073,
  "inboundReferral": {
    "code": "POLY15",
    "policyType": "campaign",
    "label": "Polymarket",
    "multiplierOverride": 1.5,
    "ownerUserId": null,
    "attachedAt": "2026-05-22T12:00:00.000Z"
  }
}
```

`GET /admin/users/:id`

The `stats` object keeps `points` as public points and adds:

```json
{
  "stats": {
    "points": 173,
    "tierPoints": 573,
    "qualificationPoints": 1073,
    "rawPoints": 1073,
    "feeUsdTotal": 0,
    "feeUsdCollected": 0,
    "referralCount": 0
  },
  "user": {
    "referralCode": "USERCODE",
    "inboundReferral": {
      "code": "POLY15",
      "policyType": "campaign",
      "label": "Polymarket",
      "multiplierOverride": 1.5,
      "ownerUserId": null,
      "attachedAt": "2026-05-22T12:00:00.000Z"
    }
  }
}
```

Admin user search `q` now matches:

- email, username, display name
- exact user id
- current user referral code
- inbound referral code
- inbound partner label
- exact wallet/funder address
- wallet/funder substring only when query length is at least 6 chars

No UI change is required for search input; existing search box can use the new
backend matching.

## Referred Users By Code

`GET /admin/rewards/referral-codes/by-code/:code/referrals`

Required permissions:

- `rewards:read`
- `users:read`

Query params:

- `limit`: optional, default `50`, max `100`.
- `offset`: optional.

The `:code` path param is normalized with the same referral-code rules used by
referral attach. The endpoint works for both user-owned share codes and
ownerless campaign codes. Unknown codes return `404`.

Example:

```http
GET /admin/rewards/referral-codes/by-code/POLY15/referrals?limit=50&offset=0
```

Response:

```json
{
  "ok": true,
  "code": {
    "id": "f8f16b6f-29c2-44df-bc42-24cb20a34f7a",
    "code": "POLY15",
    "isActive": true,
    "retiredAt": null,
    "retiredReason": null,
    "policy": {
      "id": "e2d7b08d-6d55-47de-9c36-3b0be1582a11",
      "type": "campaign",
      "label": "Polymarket",
      "multiplierOverride": 1.5,
      "visibleDropPoints": 100,
      "tierDropPoints": 400,
      "ownerUserId": null,
      "owner": null
    },
    "referralCount": 42,
    "createdAt": "2026-05-22T12:00:00.000Z",
    "updatedAt": "2026-05-22T12:00:00.000Z"
  },
  "referrals": [
    {
      "id": "8d9b3e1c-1111-4444-9999-2bdb5a9e55aa",
      "referredUserId": "7f2e6c1f-83f1-4dc8-b4c3-9487f0440a24",
      "email": "user@example.com",
      "username": "hunchuser",
      "displayName": "Hunch User",
      "primaryWallet": "0x45bd000000000000000000000000000000001733",
      "status": "qualified",
      "qualifiedAt": "2026-05-22T13:00:00.000Z",
      "attachedAt": "2026-05-22T12:00:00.000Z",
      "publicPoints": 173,
      "tierPoints": 573,
      "qualificationPoints": 1073,
      "referralBonus": 25
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Implementation details:

- Show code metadata above the table so admins can confirm campaign/user code,
  label, owner, multiplier, and drop config.
- Use `attachedAt` as the referral attach timestamp.
- Use `status` and `qualifiedAt` for qualification state.
- Keep `publicPoints`, `tierPoints`, and `qualificationPoints` labeled
  separately. Do not show `tierPoints` as public leaderboard points.

## Multiplier Policy And Override Labels

Multiplier labels are public display labels for the active multiplier badge.
They are separate from admin-only notes and reasons.

### Multiplier Policy

`GET /admin/rewards/multiplier-policy`

Relevant response fields:

```json
{
  "ok": true,
  "policy": {
    "effectiveAt": "2026-05-22T12:00:00.000Z",
    "globalMultiplier": 1.25,
    "globalMultiplierLabel": "Launch Boost",
    "referralRules": [],
    "tierRules": [],
    "notes": "Internal admin notes"
  },
  "active": {
    "id": "11111111-1111-4111-8111-111111111111",
    "effectiveAt": "2026-05-22T12:00:00.000Z",
    "globalMultiplier": 1.25,
    "globalMultiplierLabel": "Launch Boost",
    "referralRules": [],
    "tierRules": [],
    "notes": "Internal admin notes",
    "createdAt": "2026-05-22T12:00:00.000Z",
    "updatedAt": "2026-05-22T12:00:00.000Z"
  }
}
```

`POST /admin/rewards/multiplier-policy`

Request:

```json
{
  "globalMultiplier": 1.25,
  "globalMultiplierLabel": "Launch Boost",
  "referralRules": [],
  "tierRules": [],
  "notes": "Internal admin notes"
}
```

Field notes:

- `globalMultiplierLabel`: optional public display label, max 120 chars.
- `notes`: internal/admin text. Do not show it in the public user app.
- Empty or `null` `globalMultiplierLabel` means no badge label if global wins.

### User Multiplier Overrides

`GET /admin/rewards/multiplier-overrides`

Items include:

```json
{
  "userId": "7f2e6c1f-83f1-4dc8-b4c3-9487f0440a24",
  "walletAddress": "0x45bd000000000000000000000000000000001733",
  "email": "user@example.com",
  "username": "hunchuser",
  "displayName": "Hunch User",
  "multiplier": 1.75,
  "label": "VIP Boost",
  "reason": "Internal admin reason",
  "effectiveAt": "2026-05-22T12:00:00.000Z",
  "expiresAt": null,
  "createdAt": "2026-05-22T12:00:00.000Z",
  "updatedAt": "2026-05-22T12:00:00.000Z"
}
```

`POST /admin/rewards/multiplier-overrides`

Request:

```json
{
  "userId": "7f2e6c1f-83f1-4dc8-b4c3-9487f0440a24",
  "multiplier": 1.75,
  "label": "VIP Boost",
  "reason": "Internal admin reason",
  "expiresAt": null
}
```

Field notes:

- `label`: optional public display label, max 120 chars.
- `reason`: internal/admin text. Do not show it in the public user app.
- Override search `q` matches the label as well as user/wallet fields.

## System/Ops Read APIs

These APIs were added for the new external panel as read-only operational
surfaces. They do not mutate database state, reset stats, restart workers, or
modify queues.

### Postgres Stats

`GET /admin/system/postgres`

Required permission:

- `analytics:read`

Response fields:

- `generatedAt`
- `database.name`
- `database.sizeBytes`
- `database.maxConnections`
- `connections.byState`
- `connections.waiting`
- `locks.summary`
- `locks.blockers`
- `slowQueries.available`
- `slowQueries.error`
- `slowQueries.items`
- `tableHealth`

Slow-query rows contain normalized, truncated query text and timing/IO fields:

```json
{
  "query": "select ...",
  "calls": 42,
  "totalMs": 12000,
  "meanMs": 285.7,
  "maxMs": 1300,
  "rows": 1000,
  "sharedBlksHit": 5000,
  "sharedBlksRead": 200,
  "tempBlksRead": 0,
  "tempBlksWritten": 0
}
```

Implementation notes:

- If `pg_stat_statements` is missing or unreadable, the endpoint still returns
  successfully with `slowQueries.available=false`.
- `locks.blockers` contains current blocker/waiter pairs; empty means no active
  blocking pair was found at request time.
- `tableHealth` is ordered by relation size and includes live/dead row estimates,
  scan counts, vacuum/analyze timestamps, and `totalBytes`.
- Query text is admin-only operational data even though literals are normalized
  by `pg_stat_statements`.

### Indexer And Redis Stats

`GET /admin/system/indexers`

Required permission:

- `analytics:read`

Venues returned:

- `polymarket`
- `dflow`
- `limitless`

DFlow is the Kalshi data path. Do not add legacy Kalshi indexer stats.

Top-level Redis status:

```json
{
  "redis": {
    "available": true,
    "status": "ready",
    "error": null
  }
}
```

Each venue item contains:

```json
{
  "venue": "polymarket",
  "hotTokens": {
    "key": "hot:tokens:polymarket",
    "total": 5000,
    "fresh": 5000,
    "oldestAgeMs": 114000,
    "newestAgeMs": 250
  },
  "streamHotTokens": {
    "key": "hot:tokens:stream:polymarket",
    "total": 268,
    "fresh": 268,
    "oldestAgeMs": 30000,
    "newestAgeMs": 120
  },
  "priceRefreshQueue": {
    "key": "price-refresh:tokens:polymarket",
    "total": 1350,
    "due": 1350,
    "delayed": 0,
    "oldestDueAgeMs": 15500
  },
  "heartbeat": {
    "schemaVersion": 1,
    "venue": "polymarket",
    "updatedAt": "2026-05-22T20:54:14.000Z",
    "priceRefresh": {
      "lastRunAt": "2026-05-22T20:54:14.000Z",
      "durationMs": 900,
      "consumers": 2,
      "batch": 100,
      "claimed": 200,
      "claimedBySide": { "oldest": 100, "newest": 100 },
      "refreshed": 338,
      "failed": 0,
      "backlog": 1150
    }
  },
  "error": null
}
```

Implementation notes:

- `hotTokens` and `streamHotTokens` are Redis sorted-set snapshots. `fresh`
  counts entries newer than the configured TTL.
- `priceRefreshQueue.total` is all queued tokens. `due` is ready to claim now.
  `delayed` is scheduled for the future.
- `oldestDueAgeMs` growing across multiple refresh waves means the queue is not
  draining fast enough.
- Missing `heartbeat` is allowed and should be shown as unavailable/unknown, not
  as a route failure.
- If Redis is unavailable, the route still returns venue rows with null stats
  and an error.

### Price Refresh Heartbeat Interpretation

The external panel only needs to interpret the returned heartbeat fields; env
configuration belongs in ops/runbook docs.

- `heartbeat.priceRefresh.consumers`: workers used in the last refresh wave.
- `heartbeat.priceRefresh.batch`: max tokens each worker could claim.
- `heartbeat.priceRefresh.claimed`: tokens claimed from the queue.
- `heartbeat.priceRefresh.claimedBySide`: split of claimed tokens from the
  oldest and newest due ends of the queue.
- `heartbeat.priceRefresh.refreshed`: token/market refreshes completed.
- `heartbeat.priceRefresh.failed`: refresh failures in the wave.
- `heartbeat.priceRefresh.backlog`: remaining queue size after the wave.
- If `priceRefreshQueue.oldestDueAgeMs` and `heartbeat.priceRefresh.backlog`
  keep growing across refreshes, the indexer is falling behind.
- Indexer logs are one aggregate success log per wave. The System/Ops panel
  should use heartbeat fields rather than scraping logs.

## Point Semantics

Use these fields consistently:

| Field | Meaning | Public? | Includes hidden manual? | Includes tier-only drops? |
| --- | --- | --- | --- | --- |
| `points` | Public display/leaderboard points | Yes | No | No |
| `tierPoints` | Tier and multiplier progress | No | No | Yes |
| `qualificationPoints` | Referral qualification | No | Yes | Yes |
| `rawPoints` | Audit sum of all point rows | No | Yes | Yes |

Volume is trading-only. Manual grants and referral-code drops do not count as
volume.

Manual grants and referral-code drops are exact point adjustments:

- `multiplier_applied = 1`
- points are not multiplied by global, tier, referral, user override, or partner
  multiplier policies

## Public Rewards Summary Context

The public user-facing endpoint already exposes enough context for a future UI
badge.

`GET /rewards/summary`

Relevant response fields:

```json
{
  "summary": {
    "clout": {
      "points": 173,
      "tierPoints": 573,
      "qualificationPoints": 1073,
      "volumeUsd": 42.5
    },
    "multiplier": {
      "value": 1.5,
      "source": "referral_code",
      "label": "Polymarket",
      "asOf": "2026-05-22T12:00:00.000Z",
      "referralCode": {
        "code": "POLY15",
        "label": "Polymarket",
        "policyType": "campaign"
      }
    },
    "inboundReferral": {
      "code": "POLY15",
      "referralCodeId": "f8f16b6f-29c2-44df-bc42-24cb20a34f7a",
      "policyType": "campaign",
      "label": "Polymarket",
      "multiplierOverride": 1.5,
      "ownerUserId": null,
      "status": "pending",
      "attachedAt": "2026-05-22T12:00:00.000Z"
    }
  }
}
```

Display guidance:

- Show a multiplier badge label only when `summary.multiplier.label` is
  non-empty. Preserve the label casing.
- `summary.multiplier.label` can come from a winning referral-code policy,
  global multiplier policy, or user override.
- Referral-count and tier multipliers return `label: null`.
- If the user came from a partner code but another multiplier wins,
  `summary.inboundReferral` still tells the UI that
  the user came from a partner code. In that case, show partner attribution only
  if product wants it; do not imply that partner multiplier is the active
  multiplier.
- `summary.clout.points` remains safe public points.
- `summary.clout.tierPoints` should be used only for progress/tier UI if shown.

## Manual Points

`POST /admin/rewards/points`

Request:

```json
{
  "userId": "7f2e6c1f-83f1-4dc8-b4c3-9487f0440a24",
  "amount": 500,
  "visible": false,
  "venue": "admin",
  "sourceType": "execution"
}
```

Rules:

- `visible=false`: hidden manual grant. Counts only toward
  `qualificationPoints` and `rawPoints`.
- `visible=true`: visible manual grant. Counts toward public `points`,
  `tierPoints`, `qualificationPoints`, and `rawPoints`.
- Manual grants never count as trading volume.
- Manual grants are exact and are not multiplied.

Response:

```json
{
  "ok": true,
  "event": {
    "id": "uuid",
    "userId": "7f2e6c1f-83f1-4dc8-b4c3-9487f0440a24",
    "walletAddress": "0x...",
    "venue": "admin",
    "sourceType": "execution",
    "sourceId": "manual:...",
    "amount": 500,
    "visible": false
  }
}
```

Manual event listing:

`GET /admin/points/manual-events?userId=<uuid>`

This returns both hidden and visible manual grants. Use `visible` to label rows
in the UI.

## Referral Fields To Surface

### Referral Codes

Columns:

- Code
- Type (`user` / `campaign`)
- Label
- Multiplier override
- Visible drop
- Tier drop
- Active / retired
- Owner
- Referral count
- Updated at

Actions:

- Create campaign code.
- Edit label/multiplier/drops.
- Deactivate campaign code.
- Open owner user detail for user codes.
- Open referred-users drilldown for any code.

### User List / Detail

Add read-only fields:

- Own share code: existing `referralCode`.
- Inbound code: `inboundReferral.code`.
- Partner/tag: `inboundReferral.label`.
- Partner multiplier: `inboundReferral.multiplierOverride`.
- Public points: `points`.
- Tier points: `tierPoints`.
- Qualification points: `qualificationPoints`.
- Raw points: `rawPoints`.

Suggested labels:

- `points`: "Public points"
- `tierPoints`: "Tier points"
- `qualificationPoints`: "Qualification points"
- `rawPoints`: "Raw points"

Avoid showing `rawPoints` as a leaderboard/public score.

### Multiplier Policy / Overrides

Add editable fields:

- Global policy display label: `globalMultiplierLabel`.
- User override display label: `label`.

Keep these fields internal/admin-only:

- Multiplier policy `notes`.
- Override `reason`.

Public multiplier badge behavior should read `summary.multiplier.label`; do not
derive public labels from notes or reasons.

## Rollout Notes

- Apply migrations before enabling campaign-code UI.
- Backward compatibility:
  - Existing `/admin/users` and `/admin/users/:id` consumers can keep reading
    `points`.
  - Existing `/rewards/referral-code` continues to return the user's current
    share code.
  - Existing `/rewards/summary` keeps `clout.points`; new fields are additive.
- After deploy, create campaign codes from admin UI or API, not by editing user
  referral codes directly.
