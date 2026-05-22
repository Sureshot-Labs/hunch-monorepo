# Admin Rewards Referral Codes Handoff

This document describes the backend contract for admin-panel work around
referral-code campaigns, partner labels, multiplier context, and rewards point
visibility.

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

## Admin UI To Add

Add a Rewards / Referral Codes area with:

- List and filter referral codes.
- Create ownerless campaign code.
- Edit policy fields for any code.
- Deactivate campaign codes.
- Show inbound referral campaign metadata on user list/detail.
- Use the new point fields to avoid showing private tier-only points as public
  points.

Do not add a hard-delete control. Backend supports deactivation/retirement, not
delete.

## Permissions

Routes use existing admin permissions:

| Feature | Route family | Permission |
| --- | --- | --- |
| List referral codes | `/admin/rewards/referral-codes` | `rewards:read` |
| Create/update campaign or policy | `/admin/rewards/referral-codes/*` | `rewards:write` |
| User current-code management | `/admin/users/:id/referral-code` | `users:write` |
| User list/detail metadata | `/admin/users`, `/admin/users/:id` | `users:read` |
| Manual points | `/admin/rewards/points`, `/admin/points/manual-events` | `rewards:write` / `rewards:read` |

Frontend should still handle backend `403`; hiding UI is not the security
boundary.

## Referral Code List

`GET /admin/rewards/referral-codes`

Query params:

- `q`: optional text search.
- `policyType`: optional, `user` or `campaign`.
- `active`: optional boolean.
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

Display recommendations:

- Show `code`, `policy.type`, `policy.label`, `policy.multiplierOverride`,
  `visibleDropPoints`, `tierDropPoints`, `isActive`, `retiredAt`, and
  `referralCount`.
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
  "tierDropPoints": 400
}
```

Field rules:

- `code`: 3 to 10 chars. Backend normalizes to uppercase alphanumeric.
- `label`: optional display label, max 120 chars.
- `multiplierOverride`: optional positive number. Omit or clear later for no
  partner multiplier.
- `visibleDropPoints`: optional nonnegative number, defaults to `0`.
- `tierDropPoints`: optional nonnegative number, defaults to `0`.

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
  "tierDropPoints": 400
}
```

Clear nullable policy fields by sending `null`:

```json
{
  "label": null,
  "multiplierOverride": null
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

- If `summary.multiplier.source === "referral_code"` and
  `summary.multiplier.referralCode.label` exists, frontend may display
  `Polymarket: 1.5x`.
- If another multiplier wins, `summary.inboundReferral` still tells the UI that
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

## Recommended Admin Panel Screens

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
