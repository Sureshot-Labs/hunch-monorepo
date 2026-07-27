# WP7 verification plan

Status: ready to execute after the local API and web application are restarted
from the current working tree. This document defines the evidence still needed;
it does not claim that any command or financial test below has already run.

## 1. Static and automated gates

Run these before moving real value.

Frontend (`Hunch_App`):

```bash
bun run format:check
bun run type-check
bun run lint
bun test tests/funding tests/confirmation/steps.test.ts
bun test tests
bun run build
```

Backend (`hunch-monorepo`):

```bash
pnpm -F api format:check
pnpm -F api typecheck
pnpm -F api lint
pnpm -F api exec tsx src/test-runner.ts --unit \
  funding-direct-ingress-source-tests \
  funding-planner-tests \
  funding-routes-tests \
  funding-multi-leg-reducer-tests \
  trade-funding-link-schema-tests
pnpm -F api test:fast
```

The initial deterministic Type-1 and Type-2 duplication audit has already been
recorded in `README.md`. Re-run it after any test-driven fixes. Review material
clone classes rather than treating the raw percentage alone as a quality
verdict.

## 2. No-value browser matrix

These cases must stop before any signature or broadcast:

| Case                                          | Expected result                                              |
| --------------------------------------------- | ------------------------------------------------------------ |
| already-funded BUY                            | ordinary Buy; no funding step                                |
| short BUY with eligible stable balance        | one `Buy`; no destination or source selector                 |
| short BUY requiring volatile asset sale       | one economic conversion review; no technical route choice    |
| several source options with recommendation    | backend recommendation is used; no user source choice        |
| several source options without recommendation | fail closed before quote/commit                              |
| no eligible source                            | separate `Add funds` action; no claimed Buy operation        |
| Back before commit                            | returns to unchanged Buy                                     |
| Back after `ready`                            | reservation is released before returning                     |
| close/change amount/wallet/outcome            | frozen intent is abandoned and reservation is released       |
| reload exact intent                           | resumes only the exact persisted operation                   |
| reload different amount/intent                | does not adopt the previous operation                        |
| funding reaches `ready`                       | exact original Buy refreshes and submits once if still valid |

Repeat the presentation cases on desktop and mobile.

## 3. Tiny-value live matrix

Use active, liquid markets with a practical minimum order and record operation
ID, reservation ID, order ID/transaction hash, source/destination amounts,
timestamps, and final database state for every case.

1. Direct Add Funds: send Polygon pUSD from the external test wallet to the
   exact Hunch-managed Polymarket destination. Verify partial amount remains
   pending, the minimum target settles, and excess remains ordinary Account
   Value.
2. Polymarket already-funded BUY and SELL: buy a small position, wait for the
   authoritative fill/position projection, then sell it.
3. Polymarket inline-funded Buy: keep the destination below the order
   requirement, retain an eligible Hunch-owned stable source, press Buy once,
   observe preparation and automatic submission, then sell the position.
4. Limitless inline-funded Buy and SELL: repeat against an active CLOB or AMM
   market, depending on the available local fixture.
5. Cross-chain source: place an eligible balance on Base, fund a Polygon
   Polymarket BUY, and verify route timing plus exact destination observation.
6. Native SOL source: create a small SOL balance on the test user's Solana
   wallet from the supplied Polygon funds, use it as the source for a Polygon
   pUSD BUY shortfall, and retain enough SOL for any unsponsored source action.
7. Composite source: split value across two eligible Hunch balances so neither
   alone covers the BUY but the backend composite option does. Verify one
   operation, sequential legs, one review, and one settled consumer
   reservation.
8. Abandonment: prepare a shortfall to `ready`, then go Back or change the
   amount. Verify `released_to_venue_cash` and no order.
9. Definitive no-fill: use a safe order shape that produces no fill if an
   active market permits it. Verify reservation release rather than
   consumption.
10. Reload/retry: reload during a non-terminal operation and resume it without
    a duplicate operation, action attempt, transfer, or order.

Do not force a route that is unavailable under policy or current liquidity.
Record it as unavailable evidence and continue with the remaining matrix.

## 4. Database evidence

For each live operation, correlate:

- `funding_operations` purpose, status, progress stage, version, requested and
  actual destination amounts;
- funding steps/action attempts and observation timestamps;
- active/released/consumed `balance_reservations`;
- linked order venue, market, status, and funding reservation reference;
- absence of duplicate operation/order/transaction records;
- Account Value invariance while value is merely in transit or reserved.

Expected terminal outcomes:

| Journey                   | Funding operation        | Settled reservation                     |
| ------------------------- | ------------------------ | --------------------------------------- |
| successful linked BUY     | completed                | consumed by trade                       |
| Back/intent change/expiry | completed                | released to venue cash                  |
| definitive no-fill        | completed                | released to venue cash                  |
| ambiguous submission      | non-terminal/reconciling | retained until authoritative resolution |

## 5. Funding budget

Recommended starting balance on the external EVM test wallet:

- **20 POL**
- **30 pUSD**

This is a working envelope, not expected net spend. Most pUSD is circulated
between owned balances and can be sold/routed back. The allowance covers two
small BUY/SELL cycles, Base and Solana staging, a composite route, slippage,
provider minimums, and one retry without requiring another top-up mid-run.

Target live order sizes should remain around **$1–$3** where venue minimums
allow. Stop before exceeding **10 pUSD of realized loss/fees** or the explicit
20 POL / 30 pUSD envelope. If a venue minimum or route quote would exceed the
envelope, record the gate and ask before continuing.
