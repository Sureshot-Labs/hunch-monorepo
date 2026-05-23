# Admin Finance Ledger Handoff

This document describes the backend contract for the separate admin frontend to
inspect user orders, fee lifecycle rows, reward liabilities, reward claims,
Limitless contract-fee receivables, and referral-attributed fee events.

The public user app remains backward compatible. These admin APIs are read-only
inspection surfaces unless explicitly documented elsewhere.

## Overview

The finance ledger has five related surfaces:

- **Accruals**: venue fee lifecycle rows in `venue_fee_accruals`. These are
  used by venues where fees are verified or unlocked before becoming a
  `fee_events` row, such as Polymarket builder fees and Limitless venue share.
- **Fee events**: reward/liability rows in `fee_events`. These are the source
  for cashback/referral reward accounting once a fee is collected or otherwise
  recorded as a pending liability.
- **Reward claims**: aggregate payout rows in `reward_claims`. Claims are not
  allocated back to individual fee events in this API.
- **Contract receivables**: token-denominated Limitless fee receivables in
  `limitless_contract_fee_receivables`. These are not collected USDC. They wait
  for market resolution, then link to a verified accrual while waiting for
  hot-wallet budget, and finally link to a collected fee event.
- **Backfill attempts**: retry/failure explanation rows in
  `venue_fee_backfill_attempts`. These explain why an expected venue fee did not
  become an accrual or receivable yet. Do not count them as revenue.

Use the finance ledger for fee/reward inspection. Use the user-orders endpoints
for full order inspection. The older user activity endpoint is still useful for
compact timeline widgets only.

## Permissions

| Feature | Route family | Permission |
| --- | --- | --- |
| Finance ledger summary and lists | `/admin/fees/ledger/*` | `finance:read` |
| Finance ledger detail rows | `/admin/fees/ledger/*/:id` | `finance:read` |
| Referral-code fee-event drilldown | `/admin/rewards/referral-codes/by-code/:code/fee-events` | `rewards:read` and `finance:read` |
| Referral-code referred users | `/admin/rewards/referral-codes/by-code/:code/referrals` | `rewards:read` and `users:read` |
| Per-user finance/rewards summary | `/admin/users/:id/finance-summary` | `users:read`, `finance:read`, and `rewards:read` |
| User full order inspection | `/admin/users/:id/orders*` | `users:read` |
| User compact activity timeline | `/admin/users/:id/activity` | `users:read` |

Frontend should still handle backend `403`; hiding UI is not the security
boundary.

## Shared Ledger Filters

The finance ledger list endpoints share the same query shape unless noted:

- `q`: optional search across known IDs, hashes, wallets, sources, and code
  fields.
- `venue`: optional `polymarket`, `kalshi`, or `limitless`.
- `chainId`: optional chain identifier.
- `status`: optional status string.
- `userId`: optional user UUID.
- `wallet`: optional wallet address filter.
- `orderId`: optional order UUID.
- `orderHash`: optional venue/onchain order hash.
- `venueOrderId`: optional venue order id.
- `txHash`: optional transaction hash.
- `feeEventId`: optional fee event UUID.
- `sourceId`: optional fee event source id.
- `sourceType`: optional `order` or `execution`.
- `feeProgram`: optional fee program, such as `builder` or `venue_share`.
- `tokenId`: optional token id.
- `marketId`: optional market id.
- `referralCode`: optional inbound referral code.
- `referralCodeId`: optional referral code UUID.
- `referralPolicyId`: optional referral policy UUID.
- `referrerUserId`: optional referrer user UUID.
- `referredUserId`: optional referred user UUID.
- `rewardKind`: optional `any`, `cashback`, or `referral`.
- `from`: optional ISO datetime lower bound.
- `to`: optional ISO datetime upper bound.
- `limit`: optional, default `50`, max `100`.
- `offset`: optional, default `0`.

Exact ID and hash filters should be treated as exact-match controls in the UI.
Use `q` for broad admin search.

## Finance Ledger APIs

### Summary

`GET /admin/fees/ledger/summary`

Returns grouped totals for each ledger surface:

```json
{
  "ok": true,
  "summary": {
    "accruals": [],
    "events": [],
    "claims": [],
    "backfillAttempts": [],
    "contractReceivables": []
  }
}
```

Do not merge these groups into one revenue number. In particular, contract
receivables are not collected USDC, and backfill attempts are not revenue.

### Accruals

`GET /admin/fees/ledger/accruals`

Returns paginated `venue_fee_accruals` rows:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "user": { "id": "uuid", "email": null, "username": null, "displayName": null },
      "walletAddress": "0x...",
      "venue": "limitless",
      "feeProgram": "venue_share",
      "chainId": "8453",
      "orderId": "uuid",
      "orderHash": "0x...",
      "venueOrderId": "venue-order-id",
      "txHash": "0x...",
      "tokenId": "token-id",
      "side": "SELL",
      "role": "maker",
      "feeAmount": "0.005191",
      "feeAmountRaw": "5191",
      "feeAsset": "USDC",
      "venueFeeAmount": "0.010383",
      "venueFeeAmountRaw": "10383",
      "status": "collected",
      "verificationError": null,
      "feeEventId": "uuid",
      "order": {},
      "feeEvent": {}
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Use this table for Polymarket builder accruals and Limitless USDC venue-share
accruals. If `feeEventId` is present, the accrual has linked into a fee event.

### Fee Events

`GET /admin/fees/ledger/events`

Returns paginated `fee_events` rows with reward split and referral context:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "user": { "id": "uuid", "email": null, "username": null, "displayName": null },
      "walletAddress": "0x...",
      "venue": "limitless",
      "chainId": "8453",
      "sourceType": "order",
      "sourceId": "limitless:venue_share:...",
      "feeAmount": "0.005191",
      "feeAsset": "USDC",
      "feeUsd": "0.005191",
      "txHash": "0x...",
      "status": "collected",
      "cashbackBpsApplied": 0,
      "referralBpsApplied": 0,
      "cashbackEarnedUsdc": "0",
      "referralEarnedUsdc": "0",
      "liabilitySnapshotSource": "snapshot",
      "referral": null,
      "linkedAccruals": [],
      "linkedOrder": {},
      "linkedExecution": null
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Use the `referral` object to show inbound referral code, policy, label, and
referrer metadata when present. Use `rewardKind=referral` to focus on events
with referral rewards and `rewardKind=cashback` for cashback rewards.

### Reward Claims

`GET /admin/fees/ledger/claims`

Returns paginated `reward_claims` rows:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "user": { "id": "uuid", "email": null, "username": null, "displayName": null },
      "walletAddress": "0x...",
      "chainId": "8453",
      "amountUsdc": "0.485422",
      "txHash": "0x...",
      "status": "confirmed",
      "createdAt": "2026-05-23T12:00:00.000Z",
      "updatedAt": "2026-05-23T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Claims are aggregate payouts. The API does not expose per-fee-event allocation.

### Contract Receivables

`GET /admin/fees/ledger/contract-receivables`

Returns paginated Limitless token-fee receivables:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "venue": "limitless",
      "feeProgram": "venue_share",
      "chainId": "8453",
      "user": { "id": "uuid", "email": null, "username": null, "displayName": null },
      "walletAddress": "0x...",
      "orderId": "uuid",
      "orderHash": "0x...",
      "venueOrderId": "venue-order-id",
      "txHash": "0x...",
      "logIndex": 621,
      "rawTokenId": "104128...",
      "tokenId": "limitless:104128...",
      "outcomeSide": "NO",
      "side": "BUY",
      "role": "maker",
      "grossTokenAmountRaw": "8965",
      "grossTokenAmount": "0.008965",
      "receivableTokenAmountRaw": "4482",
      "receivableTokenAmount": "0.004482",
      "resolvedOutcome": null,
      "resolutionSource": null,
      "resolvedUsdcAmountRaw": null,
      "resolvedUsdcAmount": null,
      "accrualId": null,
      "feeEventId": null,
      "status": "pending_resolution",
      "resolutionAttempts": 0,
      "resolutionError": "Limitless market is not resolved yet",
      "order": {},
      "accrual": null,
      "feeEvent": null
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Statuses:

- `pending_resolution`: market is not resolved yet.
- `resolved_payable`: token outcome won, a USDC value was computed, and a
  verified `venue_share_contract` accrual is waiting for hot-wallet budget.
- `converted_to_fee_event`: the linked accrual unlocked and created/updated a
  collected fee event.
- `settled_zero`: token outcome lost.
- `refunded`: Limitless refunded the token-denominated fee in the same
  transaction.
- `failed`: resolution/conversion failed and needs ops inspection.

Keep this table visually separate from collected USDC. Show tx hash, log index,
token amount, resolution status, linked order, linked accrual, and linked fee
event. `resolved_payable` is not claimable revenue yet; it is the same
hot-wallet wait state as a verified USDC accrual, after the extra outcome
resolution step.

### Backfill Attempts

`GET /admin/fees/ledger/backfill-attempts`

Returns paginated retry/failure rows:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "venue": "limitless",
      "feeProgram": "venue_share",
      "orderId": "uuid",
      "venueOrderId": "venue-order-id",
      "status": "retry",
      "reason": "Limitless onchain order fill not found",
      "attempts": 1,
      "nextAttemptAt": "2026-05-23T16:52:52.159Z",
      "user": { "id": "uuid", "email": null, "username": null, "displayName": null },
      "order": {},
      "feeObservation": null
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

There is no detail endpoint for backfill attempts in this version. The list row
contains the available context.

## Detail APIs

The detail endpoints return the same row shape as their list endpoint:

- `GET /admin/fees/ledger/accruals/:id`
- `GET /admin/fees/ledger/events/:id`
- `GET /admin/fees/ledger/claims/:id`
- `GET /admin/fees/ledger/contract-receivables/:id`

Success:

```json
{
  "ok": true,
  "item": {}
}
```

Missing rows return `404`.

## Referral-Code Drilldowns

### Referred Users

`GET /admin/rewards/referral-codes/by-code/:code/referrals`

Query params:

- `limit`: optional, default `50`, max `100`.
- `offset`: optional.

Returns the referral code metadata and users attached through that exact code
alias.

### Fee Events By Referral Code

`GET /admin/rewards/referral-codes/by-code/:code/fee-events`

Supported query params:

- `q`
- `venue`
- `status`
- `rewardKind`
- `limit`
- `offset`

This endpoint is backed by the same fee-event ledger query and automatically
filters by the path referral code. Use it for a referral-code drilldown showing
which referred users generated cashback/referral rewards.

## User Orders APIs

### User Finance Summary

`GET /admin/users/:id/finance-summary`

Returns one read-only rollup for a user's rewards, claims, referrals, fee
events, accruals, Limitless contract receivables, and backfill attempts.

Success:

```json
{
  "ok": true,
  "summary": {
    "user": {
      "id": "uuid",
      "email": null,
      "username": null,
      "displayName": null,
      "primaryWalletAddress": "0x...",
      "inboundReferral": null
    },
    "rewards": {
      "cashback": {},
      "referralBonus": {},
      "totals": {
        "userRewardEarned": { "amountUsdc": "0.000000", "amountUsdcRaw": "0" },
        "ownCashbackEarned": { "amountUsdc": "0.000000", "amountUsdcRaw": "0" },
        "referralEarned": { "amountUsdc": "0.000000", "amountUsdcRaw": "0" },
        "claimable": { "amountUsdc": "0.000000", "amountUsdcRaw": "0" }
      }
    },
    "claims": {
      "byStatus": {},
      "byChain": {},
      "totals": {}
    },
    "feeEvents": {
      "groups": [],
      "byStatus": {},
      "totals": {}
    },
    "referrals": {
      "total": 0,
      "byStatus": {},
      "qualifiedCount": 0,
      "bonusBps": 0,
      "codes": [],
      "rewardsFromReferredUsers": {}
    },
    "ledger": {
      "accruals": [],
      "contractReceivables": [],
      "backfillAttempts": [],
      "totals": {}
    }
  }
}
```

Accounting rules:

- `rewards.totals.userRewardEarned` is the user's own cashback plus referral
  rewards earned from users they referred.
- `feeEvents.totals.referralGeneratedForReferrer` is not this user's earned
  reward. It is the referral amount their own fee events generated for their
  referrer.
- `claims.totals.nonFailed` is the aggregate amount reserved/subtracted by
  reward claims. Claims are not allocated to cashback vs referral in this API.
- `ledger.contractReceivables` are operational receivables. They are not
  claimable until they become collected fee events.
- `ledger.backfillAttempts` explain retries/failures and must not be counted
  as revenue.

Missing users return `404`.

### List User Orders

`GET /admin/users/:id/orders`

Returns full unified order rows for a user. This is the admin order browser.
Use `/admin/users/:id/activity` only for compact mixed timelines.

Query params:

- `venue`: optional `polymarket`, `kalshi`, or `limitless`.
- `wallet`: optional single wallet filter.
- `wallets`: optional comma-separated wallet filter.
- `eventId`: optional unified event id. If present without `marketId`, the
  backend expands it to the event's market ids.
- `marketId`: optional unified market id.
- `tokenId`: optional token id.
- `status`: optional order status.
- `type`: optional `order` or `swap`.
- `from`: optional ISO datetime lower bound over order/execution created time.
- `to`: optional ISO datetime upper bound over order/execution created time.
- `limit`: optional, default `50`, max `100`.
- `offset`: optional, default `0`.

Response:

```json
{
  "ok": true,
  "orders": [
    {
      "id": "uuid",
      "kind": "order",
      "venue": "limitless",
      "walletAddress": "0x...",
      "venueOrderId": "venue-order-id",
      "tokenId": "limitless:...",
      "side": "BUY",
      "outcome": null,
      "orderType": "FOK",
      "price": 0.35,
      "size": 2.8571,
      "status": "filled",
      "filledSize": 2.8571,
      "averageFillPrice": 0.35,
      "expiresAt": null,
      "createdAt": "2026-05-23T17:42:20.000Z",
      "updatedAt": "2026-05-23T17:42:20.000Z",
      "filledAt": "2026-05-23T17:42:20.000Z",
      "cancelledAt": null,
      "unifiedMarketId": "limitless:market",
      "inputMint": null,
      "outputMint": null,
      "amountIn": null,
      "amountOut": null,
      "inputDecimals": null,
      "outputDecimals": null,
      "txSignature": null
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

The response shape intentionally mirrors the user-facing `GET /orders` unified
order model.

### Get User Order

`GET /admin/users/:id/orders/:orderId`

Returns one unified order if it belongs to the target user.

Success:

```json
{
  "ok": true,
  "order": {}
}
```

Missing user, missing order, or an order that belongs to another user returns
`404`.

## Admin Panel Guidance

- Finance Ledger table modes should be: `Accruals`, `Fee Events`, `Claims`,
  `Contract Receivables`, and `Backfill Attempts`.
- Use ledger filters for fee/reward attribution by `userId`, `wallet`,
  `orderId`, `orderHash`, `venueOrderId`, `txHash`, and referral code.
- In detail drawers, expose raw ids and raw micro amounts. This is an admin
  debugging surface.
- Keep contract receivables separate from collected fee totals until their
  linked accrual unlocks into a collected fee event.
- Use user-orders endpoints for full order inspection and to navigate from a
  ledger row to the underlying order.
- Use `/admin/users/:id/activity` only for a compact mixed timeline of orders,
  executions, and claims.
