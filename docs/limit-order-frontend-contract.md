# Limit-order frontend contract

This document describes the backend-owned funding and fee semantics for
Polymarket and Limitless limit orders. It is intentionally additive: clients
that do not send `postOnly` keep their existing order behavior.

## Polymarket

### Requests

`POST /trade/polymarket/quote` and `POST /trade/polymarket/order` accept the
optional top-level field:

```json
{
  "postOnly": true
}
```

`postOnly` is valid only for `GTC` and `GTD`. Omitting it is equivalent to
`false`; a normal limit order may therefore execute immediately as a taker or
rest as a maker. `FOK` and `FAK` are distinct immediate taker orders and reject
`postOnly: true`; `FAK` keeps partial fills while `FOK` is all-or-nothing.

### Quote response

For a BUY, `totalRequiredUsdcRaw` is the authoritative maximum collateral
debit. Do not recompute fees in the browser and do not use `makerAmount` or the
entered nominal amount as the funding requirement.

The response also contains:

- `postOnly`: the normalized order option;
- `feeRoleAssumption`: `taker`, `maker`, or `maker_or_taker`;
- `platformFeeEstimateRaw`, `builderFeeEstimateRaw`, and
  `totalFeeEstimateRaw`: the components selected for the conservative debit;
- `builderFeeBoundBps`: the builder rate used for the collateral bound.

Role semantics are:

- `FOK`/`FAK`: taker debit;
- `GTC`/`GTD` with `postOnly: true`: maker debit;
- ordinary `GTC`/`GTD`: the greater of the possible maker and taker debits.

Current Polymarket public fee policy is taker-only, while the CLOB market-info
schema also carries explicit role metadata (`fd.to`) and maker/taker base-fee
fields. The backend honors that authoritative metadata defensively. A maker
quote may also include the separate builder-maker fee when the configured Hunch
builder program charges one.

The backend computes the taker platform-fee maximum over all execution prices
allowed by the signed limit. If authoritative taker fee metadata cannot be
read, a taker-capable quote fails before funding instead of returning a smaller
unsafe estimate. A post-only quote also fails closed when authoritative fee-role
metadata cannot be read; cached legacy market fields do not prove a zero maker
debit.

### Funding and labels

Let `requiredRaw = totalRequiredUsdcRaw` and let `directAvailableRaw` be the
fresh venue-local executable Polymarket balance after open-order locks.

```text
venueShortfallRaw = max(0, requiredRaw - directAvailableRaw)
```

The UI must keep the concepts separate:

- `Available`: venue-local executable balance, not the account-wide total;
- `Maximum total spend`: `totalRequiredUsdcRaw` rendered as USDC;
- `Need more`: the exact shortfall returned/confirmed by funding preflight.

CTA copy:

- no shortfall: `Place order`;
- a selectable account route can cover the shortfall: `Fund & place order`;
- no selectable route: `Add funds`.

Do not show `Buy Now` while `Need more` is positive: that path still performs a
funding action before placing the order and the label would hide that fact.

The final order endpoint recomputes the same fee-inclusive debit from the
signed order, `orderType`, and `postOnly`. It accepts a fresh debit below the
confirmed reservation cap, but never one above it or for another
market/outcome.

## Limitless

`POST /trade/limitless/order` accepts optional top-level `postOnly` for `GTC`
only. Omitting it preserves the existing behavior in which a GTC can execute
immediately or rest.

For a Limitless BUY, the signed `makerAmount` is the maximum USDC collateral
debit and remains the funding reservation amount. Do not add a synthetic USDC
fee buffer: Limitless taker fees are deducted from received outcome contracts,
not charged on top of BUY collateral. For a SELL, the fee is deducted from the
USDC proceeds.

Before execution, show payout/receive values as estimates and disclose that a
marketable limit order may pay a taker fee. After execution, prefer the venue's
exact net fields (`contractsNet` for BUY and `usdNet` for SELL) when available.

## Compatibility

- Existing request fields and response fields are unchanged.
- All new request fields are optional.
- All new Polymarket response fields are additive.
- Telegram automation remains FOK and does not create resting orders.
