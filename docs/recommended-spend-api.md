# Recommended spend: observed BUY liquidity

Two calculation-only APIs estimate how much can be bought without walking past
a relative worst-fill price boundary. This is **not** investment advice, a risk
limit, a reserved quote, or permission to execute an order. Supported venues:
Polymarket and Limitless CLOB. Limitless AMM returns `unsupported_market_type`;
Kalshi/DFlow is not supported.

## Client flow

1. Without login, read `GET /markets/:marketId/recommended-spend` with the exact
   canonical `tokenId` of the intended outcome, and optional `slippageBps`.
2. When opening Buy, an authenticated client may request
   `POST /trade/recommended-spend` with `{marketId, tokenId, slippageBps, walletId?}`.
   Use the normal Bearer session and `X-CSRF-Token`. `walletId` is an existing
   Hunch `user_wallets.id`, **not** a wallet address, venue binding ID or funder.
   Omission selects the current authenticated buy wallet; ambiguous selection
   returns `wallet_selection_required`. It never combines wallets.
3. Display “Up to $X at Y% slippage”, not “Safe to invest $X”. Keep warnings
   visible, honor `expiresAt`, and fetch again when expired or the instrument
   changes. A regular retry recovers after a transient provider failure.
4. Use the existing Buy preparation/quote and execution APIs for an actual
   purchase. They revalidate current funds, token, amount and price. This API
   creates no credentials, approval, reservation, funding operation or order.

`slippageBps` defaults to **30 (0.3%)**, valid integer range 0–10,000. This is
relative price movement, not percentage points. Input schemas reject extra
fields, including a client-supplied balance. Token mismatch is `409`, missing
market `404`, unsupported venue `400`, malformed input `400`, and rate limiting
`429`. Unauthenticated POST is `401`; invalid CSRF/unowned wallet header is `403`.
Transient book/funds failures use the typed statuses below, not invented zeroes.

## Calculation

```
priceLimit = floorToTick(bestAsk * (1 + slippageBps / 10_000))
marketCapacity = sum(price * shares where price <= priceLimit)
maxOrderAmountUsd = floorToSupportedNotionalStep(marketCapacity)
```

The boundary is also inside the venue's valid price range. All eligible observed
depth is used, without a percentage haircut. A 100-share ask at $0.50 with 1%
slippage and $0.01 ticks gives a **$0.50 limit and $50 maximum**, not $0.51/$51.
The same inward rounding/depth check is used by Polymarket market Max. Explicit
user amounts and resting limit-order semantics are unchanged.

Decimals are JSON **strings**, and unavailable amounts/prices are `null`.
The amount is normally rounded down to cents; raw arithmetic uses bigint. At
**zero** Polymarket slippage, maker cents and 1e-4 share precision must represent
the exact tick simultaneously. Recommendation/Max use that exact notional
quantum: at $0.53 and $100 funds, $99.64 is representable; at $0.531 the quantum
is $5.31, yielding $95.58. This is execution precision, not a liquidity haircut;
explicit user-entered quote amounts are not silently reduced.

The minimum is the Polymarket $1 notional boundary, or one cent for the
Limitless amount interface. Book minimum shares apply to resting orders, not FOK.
Limitless book `minSize` is a rewards parameter,
not a minimum dollar purchase. A below-minimum recommendation is zero with
`below_min_order`, distinct from unknown balance and provider failure.

## Response

Top level: `marketId`, canonical `tokenId`, `venue`, `outcome` (YES/NO),
`outcomeLabel`, `instrumentRevision`, `slippageBps`, `market`, `account`, `warnings`.
Always display the actual outcome label; never hardcode “Buy Yes”.

`market` is independent of the user:

| Field                                          | Meaning                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `status`                                       | `ready`, `no_liquidity`, `below_min_order`, `market_unavailable`, `unsupported_market_type`, `stale_book`, `unavailable` |
| `maxOrderAmountUsd`                            | Observed maximum order notional, before additional collateral fees                                                       |
| `bestAsk`, `priceLimit`                        | Current best ask and inward-rounded worst-fill boundary                                                                  |
| `expectedShares`, `averagePrice`, `worstPrice` | Book walk for the suggested notional; shares before venue deductions                                                     |
| `feesUsd`, `totalDebitUsd`, `feeTreatment`     | Separate fee/debit estimate; unknown fees are null, not zero                                                             |
| `observedAt`, `sourceAsOf`, `expiresAt`        | Fetch start, source timestamp when available, absolute local expiry                                                      |
| `depthCoverage`                                | `observed`: no assertion that a venue has disclosed its entire depth                                                     |
| `priceProtection`                              | `requires_bounded_order` for Polymarket; `not_enforced_by_current_fok` for Limitless                                     |

Polymarket reuses existing fee calculations. Fees increase required collateral;
unknown fee curves make the personal maximum unavailable. Limitless FOK is an
exact-input purchase: the collateral debit is known while fees reduce received
shares. Its fee value is currently unknown (`feesUsd:null`), and displayed shares
are pre-fee. Slippage concerns the instrument price, not the price after fees.

For POST, `account` retains the same market result and adds:

- `walletId`, `availableCollateralUsd`, `balanceAsOf`;
- `recommendedOrderAmountUsd`, plus the same share/price/fee/debit fields;
- `status`: `ready`, `balance_unavailable`, `wallet_selection_required`,
  `wallet_unavailable`, `fees_unavailable`, `below_min_order`, `market_unavailable`;
- `limitingFactor`: `liquidity`, `balance`, `minimum_order`, or null;
- `openOrderCoverage`: `venue_live_and_hunch`, `hunch_recorded`, or `unknown`.

Personal capacity uses only fresh, exact-asset collateral of the selected venue
wallet. No controller top-up, conversion, bridge or cross-wallet aggregation.
Cash is net of covered open orders, durable reservations and submitted debits;
Limitless also caps it by the exact exchange's current allowance. Unknown,
missing, duplicate or stale cash evidence is unavailable, not zero. Fees must fit
within this net amount. `ready` means usable **advisory data**, not execution
authorization or a guarantee of fill.

Polymarket requires a complete valid live private order traversal and combines
its lock with Hunch's recorded lock using the maximum, not a double deduction.
Limitless provides only per-market user order listings; this endpoint uses the
existing Hunch-recorded order accounting and returns `hunch_recorded` plus
`external_orders_not_included`. Its available collateral is an estimate net of
**covered** orders, not an authoritative venue-wide free balance. Orders placed
outside Hunch can further reduce it; execution checks still apply.

## Freshness, protection and performance

- Public books are shared by recommendation and quote/Max: 2-second bounded
  in-memory cache and in-flight coalescing, keyed by immutable Polymarket token
  or Limitless exact slug. Limitless responses must match the current canonical
  YES token before mirroring for NO; the representations are not added together.
- Expiry is at most 5 seconds from fetch start and earlier if the source timestamp
  demands it. Cache reads never extend it. Unknown source time is explicitly
  flagged; receiving a response now does not prove venue freshness.
- Both endpoints use `no-store`; personal responses use `private, no-store`.
  Balances and credentials never enter the public book cache.
- The market calculation waits at most 3 seconds for book/context; personal
  observation waits at most 3.5 seconds. Existing provider timeouts/rate limits
  apply. Fee-cap binary search is local arithmetic, not repeated quote/RPC calls.
- Stale/changed books, changed canonical instruments and closed markets cannot
  return a usable recommendation. Last-price, midpoint and aggregate liquidity
  are never used to invent order-book depth.
- **Limitless warning:** its current FOK submission omits a price field, so this
  calculated boundary is not enforced by that order. FAK with a price would be a
  separate execution change; this patch does not implement it or enable bots.

Relevant venue contracts: [Limitless order book](https://docs.limitless.exchange/api-reference/trading/orderbook),
[Limitless orders](https://docs.limitless.exchange/api-reference/trading/create-order),
[per-market user orders](https://docs.limitless.exchange/api-reference/trading/user-orders).

## Verification

`recommended-spend-tests.ts` covers raw arithmetic, tick boundaries, partial
depth, fee-constrained capacity, cache coalescing/failure recovery, stale and
changed instruments, account isolation, private cache headers and OpenAPI.
`recommended-spend-auth-tests.ts` proves no session bookkeeping write while
preserving session, CSRF and wallet-ownership checks.
`recommended-spend-integration-tests.ts` exercises the exact reused market SQL on
PostgreSQL 16 in a read-only transaction, including custom/generic plans.

The injected-route benchmark has a 150 ms p95 assertion; the PostgreSQL fixture
also exercises the warm route with a real local DB and a cached fixture book,
counting provider-loader calls. These do **not** establish production latency,
full private account-runtime performance, RPC latency or venue availability.
No live trade or private production probe is part of local verification.
