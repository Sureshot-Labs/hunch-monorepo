# Backend Task: Resolved-Position Accounting in Notifications

Status: win/loss notification implemented; verified amounts missing  
Priority: P1  
Depends on: venue settlement semantics and position accounting ownership

## Goal

Enrich `position_resolved` with a verified economic snapshot so the bot can
state payout and realized profit or loss when the data is trustworthy, while
retaining the current safe win/loss fallback when it is not.

## Current State

`createResolvedPositionNotificationIfVisible` currently stores:

- venue;
- market and token IDs;
- wallet address;
- resolved outcome;
- held outcome side;
- result: won or lost.

The message body is either `Claim available` or `Resolved with no payout`.
Telegram renders the market, side, resolved outcome, and this body. It does not
claim an exact payout or PnL.

The notification query intentionally limits the position input and does not
snapshot size, average price, fees, settlement value, payout, or realized PnL.

The positions domain already has useful primitives:

- `positions.size`, `average_price`, `realized_pnl`, and `unrealized_pnl`;
- resolution fields on `unified_markets`;
- shared SQL in `apps/api/src/lib/pnl-sql.ts` for binary and scalar resolution;
- `markPositionFlatByIdInTx`, which can materialize effective resolved PnL;
- `redemption_completed` events with amount where available.

These primitives are not yet assembled into an immutable resolution-event
accounting snapshot.

## Required Event Snapshot

Add nullable structured fields to `position_resolved.data`:

```text
shares
averagePrice
costBasisUsd
settlementValuePerShare
grossPayoutUsd
feesUsd
realizedPnlUsd
claimableAmountUsd
claimStatus
accountingVersion
accountingComplete
```

Definitions must be explicit:

- `costBasisUsd`: verified average cost times resolved quantity, with the
  repository's fee convention documented;
- `settlementValuePerShare`: normalized payout for the held outcome, including
  scalar resolution where supported;
- `grossPayoutUsd`: settlement value before redemption/network costs;
- `realizedPnlUsd`: payout minus verified cost basis and included fees;
- `claimableAmountUsd`: amount currently claimable, which may differ from
  gross payout after partial redemption or venue mechanics;
- `claimStatus`: `not_required`, `available`, `submitted`, `completed`, or
  `unknown`;
- `accountingComplete`: true only when all values used in user-facing exact
  copy passed venue-specific validation.

Use decimal/numeric calculations in the database or a decimal library. Do not
derive money with unbounded JavaScript floating-point arithmetic.

## Event Timing and Consistency

Create the economic snapshot from a consistent position and market state.
Prefer one of:

- create/update the notification in the same transaction that materializes
  resolved position accounting; or
- query the necessary rows with a clear snapshot/isolation boundary before
  publishing.

The event must preserve the pre-flat quantity and average price. If position
sync sets size to zero or clears average price before notification creation,
exact accounting cannot be reconstructed reliably from the current row.

Publish to Redis and Telegram only after the durable notification contains the
final snapshot for that accounting version.

The existing dedupe key is `position_resolved:{positionId}`. If an incomplete
event is created before accounting is available, define a revision policy:

- update the same notification and enqueue an immutable accounting revision;
  or
- keep the initial win/loss notification and do not send a later correction
  unless the product explicitly wants one.

Never silently mutate a previously sent amount without an auditable revision.

## Venue Verification

Add fixtures and owner sign-off for every supported venue:

- Polymarket binary resolution and redemption;
- Kalshi contract quantity, cents/dollars conversion, fees, and automatic
  settlement behavior;
- Limitless token quantity, payout asset, and redemption behavior;
- scalar/percentage outcomes where `resolved_outcome_pct` is present;
- partial fills and position aggregation;
- positions reduced before resolution;
- missing or stale average price;
- fees recorded per trade versus already included in average price;
- partial or repeated redemption.

Do not assume every venue uses `size * $1` with identical fee semantics.
Document the normalization next to the accounting implementation.

## Rendering Contract

When `accountingComplete = true`, Telegram may render:

```text
🏁 Your YES position won

Fed decision in July? · YES
Payout: $1,000.00
Realized PnL: +$380.00

[ Claim in Hunch ]
```

For a loss:

```text
🏁 Your YES position lost

Fed decision in July? · YES
Realized PnL: −$620.00

[ View position ]
```

When any required value is unverified, keep the current copy:

- won: `Claim available`;
- lost: `Resolved with no payout`.

Do not display `+$0`, estimated profit, or a value derived from stale market
price as realized PnL. Label genuinely estimated values as estimates only if a
separate product requirement approves them.

CTA depends on settlement state:

- claim required and available -> `Claim in Hunch`;
- automatic settlement or already claimed -> `View position` or `View funds`;
- no safe destination -> no button.

## Reconciliation

Add a reconciliation job or diagnostic query that compares:

- resolved notification snapshot;
- materialized `positions.realized_pnl`;
- redemption notification amount;
- venue settlement data where available.

Large or impossible differences should be observable before exact Telegram
copy is enabled globally. Consider a feature flag per venue until fixtures and
production samples agree.

## Acceptance Criteria

- Notification data snapshots pre-flat quantity and cost basis.
- Exact payout/PnL appears only when `accountingComplete = true`.
- Binary and scalar settlement formulas have decimal-safe tests.
- Every supported venue has reviewed fixtures for win, loss, fees, and claim
  behavior.
- Missing average price or ambiguous fees falls back to win/loss copy.
- Partial fills, reductions, and repeated redemption do not double-count.
- Published revisions are immutable and deduped.
- Reconciliation exposes disagreements between notification, position, and
  redemption accounting.
- Telegram CTA matches actual claim state.

## Out of Scope

- tax lots or tax reporting;
- portfolio-wide performance analytics;
- historical backfill messages to users;
- cross-venue signal equivalence.
