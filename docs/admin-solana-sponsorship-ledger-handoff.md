# Admin Solana Sponsorship Ledger Handoff

This document describes the backend contract for the separate admin frontend to
inspect Solana sponsorship accounting rows.

These APIs are read-only operational/accounting surfaces. Sponsorship policy
controls remain in Access under the `auth_access` runtime policy JSON.

## Overview

The Solana sponsorship ledger exposes rows from `solana_sponsorship_ledger`.
Use it to inspect sponsor-funded Solana transactions across embedded-wallet
flows:

- **DFlow/Kalshi** sponsored order submission and related settlement accounting.
- **Across** sponsored bridge intent handling.
- **Direct transfer** embedded Solana sponsored transfer handling.
- **deBridge** sponsored bridge handling.
- **Admin prediction market init** sponsor spend, marked by metadata.

Do not use this surface to enable or disable sponsorship. The Access page
remains the only admin UI location for sponsorship enablement, mode, flow flags,
and limits.

## Permissions

| Feature | Route family | Permission |
| --- | --- | --- |
| Solana sponsorship ledger summary | `/admin/solana-sponsorship/ledger/summary` | `finance:read` |
| Solana sponsorship ledger rows | `/admin/solana-sponsorship/ledger/rows` | `finance:read` |
| Sponsorship policy edits | `/admin/intel/policies/auth_access` | `sponsorship:write` for sponsorship fields |

Frontend should still handle backend `403`; hiding UI is not the security
boundary.

## Filters

Both endpoints accept the same query filters:

- `q`: optional broad search across ledger id, intent id, wallet, sponsor,
  transaction signature, message digest, transaction digest, market id, user
  email, username, and display name.
- `venue`: optional `kalshi`, `bridge`, or `wallet`.
- `flow`: optional `dflow`, `across`, `directTransfer`, or `debridge`.
- `status`: optional ledger status string. Current values are `created`,
  `intent_created`, `user_signed`, `submitted`, `failed`, and `confirmed`.
- `rentStatus`: optional rent status string. Current values are `unknown`,
  `locked`, `returned`, and `lost`.
- `wallet`: optional exact wallet address filter, case-insensitive.
- `sponsor`: optional exact sponsor address filter, case-insensitive.
- `intentId`: optional exact sponsorship intent id.
- `txSignature`: optional exact Solana transaction signature.
- `userId`: optional user UUID. System/admin rows can have `user = null`.
- `from`: optional ISO datetime lower bound on `created_at`.
- `to`: optional ISO datetime upper bound on `created_at`.
- `limit`: optional, default `50`, max `100`.
- `offset`: optional, default `0`.

Exact id, wallet, sponsor, intent, and transaction filters should be treated as
exact-match controls in the UI. Use `q` for broad admin search.

## APIs

### Summary

`GET /admin/solana-sponsorship/ledger/summary`

Returns grouped counts and aggregate lamport totals for matching rows:

```json
{
  "ok": true,
  "summary": {
    "totals": {
      "count": 12,
      "estimatedSponsorLamports": "60000",
      "actualSponsorLamports": "42000",
      "rentLamports": "2039280",
      "reclaimedLamports": "2039280",
      "closeFeeLamports": "5000",
      "netActualSponsorLamports": "47000"
    },
    "byStatus": [
      { "status": "confirmed", "count": 10 },
      { "status": "failed", "count": 2 }
    ],
    "byFlow": [
      { "flow": "dflow", "count": 8 },
      { "flow": "directTransfer", "count": 4 }
    ],
    "byRentStatus": [
      { "rentStatus": "returned", "count": 6 },
      { "rentStatus": "unknown", "count": 6 }
    ]
  }
}
```

Accounting notes:

- Core totals come from ledger columns, not metadata.
- `reclaimedLamports` and `closeFeeLamports` are derived defensively from
  `metadata.sponsorshipRentReclaim` when present.
- `netActualSponsorLamports` is `actualSponsorLamports - reclaimedLamports +
  closeFeeLamports` for rows with an actual observed cost.
- Failed finalized transactions can have nonzero `actualSponsorLamports`; do
  not hide actual spend only because status is `failed`.
- Null actual costs are excluded from net actual cost until reconciliation
  observes finalized spend.

### Rows

`GET /admin/solana-sponsorship/ledger/rows`

Returns paginated sponsorship ledger rows:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "createdAt": "2026-06-02T12:00:00.000Z",
      "updatedAt": "2026-06-02T12:05:00.000Z",
      "user": {
        "id": "uuid",
        "email": "user@example.com",
        "username": null,
        "displayName": null
      },
      "venue": "kalshi",
      "flow": "dflow",
      "status": "confirmed",
      "intentId": "solsp_...",
      "walletAddress": "solana-wallet",
      "sponsorAddress": "sponsor-wallet",
      "marketId": "kalshi:...",
      "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "outputMint": "outcome-mint",
      "amountRaw": "1000000",
      "messageDigest": "base64url-or-hex-digest",
      "transactionDigest": "base64url-or-hex-digest",
      "txSignature": "solana-signature",
      "estimatedSponsorLamports": "5000",
      "actualSponsorLamports": "10000",
      "rentLamports": "2039280",
      "rentStatus": "returned",
      "error": null,
      "metadata": {},
      "adminPredictionMarketInit": false,
      "reconciledAt": "2026-06-02T12:05:00.000Z",
      "reclaimedAt": "2026-06-02T12:10:00.000Z",
      "reclaimedLamports": "2039280",
      "remainingOpenLamports": "0",
      "closeFeeLamports": "5000",
      "netActualSponsorLamports": "15000",
      "txSolscanUrl": "https://solscan.io/tx/solana-signature",
      "walletSolscanUrl": "https://solscan.io/account/solana-wallet",
      "sponsorSolscanUrl": "https://solscan.io/account/sponsor-wallet"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Important row fields:

- `status`: ledger lifecycle state. `failed` can still represent real sponsor
  spend if a finalized transaction paid fees before failing.
- `rentStatus`: rent lifecycle state. Use this for rent recovery visibility,
  not for transaction success.
- `estimatedSponsorLamports`: reserved/estimated cost before final
  reconciliation.
- `actualSponsorLamports`: observed cost after reconciliation. It can be null
  for rows still awaiting final evidence.
- `rentLamports`: observed non-fee/rent exposure when available.
- `reclaimedLamports`: rent reclaim amount parsed from metadata, default `0`.
- `closeFeeLamports`: close transaction fees parsed from metadata, default `0`.
- `netActualSponsorLamports`: actual cost adjusted for reclaimed rent and close
  fees, null when actual cost is still unknown.
- `adminPredictionMarketInit`: true when this is sponsor spend for admin market
  initialization.
- `reconciledAt`: timestamp from DFlow or generic sponsorship reconciliation
  metadata when present.
- `metadata`: raw ledger metadata for drilldown/debug views. Treat as optional
  and shape-unstable.

## Admin Panel Guidance

Recommended placement:

- Add a **Sponsorship** tab under the existing finance/fees admin section.
- Keep it read-only.
- Include a link to `/admin/access` for policy edits.
- Do not render sponsorship enable/disable controls in this tab.

Recommended table columns:

- Created
- Status
- Flow
- Venue
- Wallet
- Sponsor
- Tx signature
- Estimated SOL
- Actual SOL
- Rent status
- Reclaimed SOL
- Error

Recommended detail view:

- Full metadata JSON.
- Intent id.
- Message and transaction digests.
- Solscan links.
- Reconciliation timestamp.
- Reclaim timestamp, reclaimed lamports, close fees, and remaining open
  lamports.
- Error details.

Display lamports as SOL for human-readable totals, but keep raw lamport strings
available in detail views for copy/paste and accounting checks.

## Policy Separation

The sponsorship ledger is not a policy editor.

Keep policy in Access:

- `auth_access.embeddedSolanaSponsorship`
- `auth_access.embeddedSolanaSponsorshipMode`
- `auth_access.embeddedSolanaSponsorshipFlows`
- `auth_access.embeddedSolanaSponsorshipLimits`

The backend continues to write runtime policy JSON through
`/admin/intel/policies/:key`. Sponsorship field changes on `auth_access`
require `sponsorship:write`.

## Compatibility

These endpoints are additive. Existing admin fee ledger endpoints, Access
policy endpoints, and public user APIs are unchanged.

External admin clients can ignore these endpoints until they want to display
Solana sponsorship accounting. Older clients do not need to change.
