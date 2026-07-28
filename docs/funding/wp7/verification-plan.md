# WP7 verification plan

Status: blocked on the WP7 UX/open-ingress correction phases in `README.md`.
The existing amount-specific router may continue to be tested, but the full
product verification below must not be reported as passing until the corrected
contracts and UI are implemented. This document defines the evidence still
needed; it does not claim that any command or financial test below has already
run.

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
  funding-receive-session-tests \
  funding-planner-tests \
  funding-routes-tests \
  funding-multi-leg-reducer-tests \
  trade-funding-link-schema-tests
pnpm -F api test:fast
pnpm -F api exec tsx src/test-runner.ts --integration \
  funding-receive-session-persistence-integration-tests
```

The receive-session integration test requires migration `0190` in the local
test database. It proves concurrent open idempotency, durable reload/restart
recovery, policy-revision replacement, continuation after a first routed
receipt, acceptance of a second canonical receipt, and expiry of an in-flight
processing session. The migration itself is first validated inside an explicit
`BEGIN`/`ROLLBACK` transaction.

The initial deterministic Type-1 and Type-2 duplication audit has already been
recorded in `README.md`. Re-run it after any test-driven fixes. Review material
clone classes rather than treating the raw percentage alone as a quality
verdict.

## 2. No-value browser matrix

These cases must stop before any signature or broadcast:

| Case                                          | Expected result                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| already-funded BUY                            | green `Buy Now`; no funding card or alternate CTA                              |
| short BUY with eligible stable balance        | green `Buy Now`; preparation begins after click; no source selector            |
| short BUY requiring volatile asset sale       | `Buy Now`, then one economic review; no technical route choice                 |
| several source options with recommendation    | backend recommendation is used; no user source choice                          |
| several source options without recommendation | fail closed before quote/commit                                                |
| no eligible internal source                   | separate `Add funds`; no claimed Buy operation                                 |
| route discovery still loading                 | same disabled green `Buy Now`; no technical funding card and no layout jump    |
| Back before commit                            | returns to unchanged Buy                                                       |
| Back after `ready`                            | reservation is released before returning                                       |
| close/change amount/wallet/outcome            | frozen intent is abandoned and reservation is released                         |
| reload exact intent                           | resumes only the exact persisted operation                                     |
| reload different amount/intent                | does not adopt the previous operation                                          |
| funding reaches `ready`                       | exact original Buy refreshes and submits once if still valid                   |
| two Add Funds venues                          | Polymarket and Limitless both render directly                                  |
| five Add Funds venues                         | recommended/recent venues plus `More venues`                                   |
| general owned-address top-up                  | amount is optional; address/QR is available after asset/network selection      |
| external Buy shortfall                        | missing amount is prefilled/frozen; no unrelated general amount question       |
| strict provider deposit address               | exact amount, expiry, refund, and quote economics are shown before address use |
| asset/network picker                          | only activated exact-contract routes appear; human labels contain no raw IDs   |
| equivalent stable receive                     | automatic-conversion meaning is clear; no technical route choice               |
| volatile receive                              | receipt becomes Account Value; conversion requires exact economic consent      |
| Convert                                       | canonical From/To cards, one source amount, computed destination/minimum/fees  |
| operation progress                            | one stable status surface; no transient duplicate cards or layout jump         |

Repeat the presentation cases on desktop and mobile.

## 3. Open-ingress integration and chaos matrix

Before real value, run deterministic chain/provider fixtures for:

1. one open Receive Session observing several same-asset transfers;
2. two accepted assets arriving as separate canonical receipts and creating
   separate child operations without double allocation;
3. duplicate webhook/poll observations for the same transaction/event;
4. receipt before browser polling begins and receipt after session UI expiry;
5. tab close, API restart, and worker restart at address shown, receipt
   observed, child committed, first action prepared, broadcast accepted,
   destination observed, and reservation ready;
6. `started` action attempt with no broadcast evidence, confirmed broadcast
   evidence, and ambiguous evidence;
7. unsupported asset, wrong network, stale nonce, out-of-cap fee/slippage,
   insufficient gas/rent, and unavailable destination observer;
8. old frontend against the additive backend and corrected frontend against a
   backend without the new capability version.

Every case must preserve ownership value, avoid duplicate transfer/order
creation, and terminate in ready, recoverable, or explicit fail-closed state.
For EVM routes, fixtures must additionally prove that the cursor is frozen
before the address is exposed, only blocks satisfying the configured external
ingress finality are scanned, and the same `(networkId, txHash, logIndex)`
cannot be allocated to another session even when session polling overlaps.
Polygon and Base use the canonical ERC-20 event capability; Base must still
remain unadvertised unless its exact owned source-location policy and route
evidence pass. Solana USDC and native SOL use the canonical
`solana_transfer_v1` signature/instruction capability and are subject to the
same exact wallet/location/route gate. Unit fixtures now cover SPL USDC and
System Program native transfers plus the `review_required` disposition. Runtime
activation remains blocked until migration `0190`, persistence integration,
service restart, exact route discovery, and a tiny-value review/commit test
pass.

## 4. Tiny-value live matrix

Use active, liquid markets with a practical minimum order and record operation
ID, reservation ID, order ID/transaction hash, source/destination amounts,
timestamps, and final database state for every case.

1. Open Polymarket Add Funds with Polygon pUSD: choose venue, `Send crypto`,
   pUSD/Polygon, obtain address/QR without a mandatory amount, send a tiny
   amount, and verify receipt child operation plus final trading balance.
2. Open Polymarket Add Funds with Polygon USDC.e: repeat and verify automatic
   Funding Router continuation to pUSD.
3. Open Limitless Add Funds with Base USDC: run only after its exact capability
   is activated; verify direct readiness.
4. Polymarket already-funded BUY and SELL: buy a small position, wait for the
   authoritative fill/position projection, then sell it.
5. Polymarket inline-funded Buy: keep the destination below the order
   requirement, retain an eligible Hunch-owned stable source, press Buy once,
   observe preparation and automatic submission, then sell the position.
6. Limitless inline-funded Buy and SELL: repeat against an active CLOB or AMM
   market, depending on the available local fixture.
7. Cross-chain source: place an eligible balance on Base, fund a Polygon
   Polymarket BUY, and verify route timing plus exact destination observation.
8. Existing owned native SOL source: create a small SOL balance on the test
   user's Solana
   wallet, use it first as the source for a Limitless Base USDC BUY shortfall
   through the direct `solana-sol-to-base-usdc` route, require the economic
   review, and retain enough SOL for any unsponsored source action. Record
   quote, signature-to-confirmation, Relay fill, destination-observation, and
   resumed-Buy timings separately. Then test the Polygon pUSD route independently.
9. External native SOL Receive: choose Polymarket or Limitless, `Send crypto`,
   SOL/Solana, verify that the exact Solana address and QR are shown, send a
   tiny transfer, observe a canonical native receipt in `review_required`,
   review the live minimum output/fees/expiry, commit once, and verify the
   linked child Funding Operation reaches the selected Trading Balance.
10. External Solana ingress: after the specific Solana USDC/SOL receive
    capability is activated, choose it in Add Funds, verify the Solana address
    and exact asset instructions, send a tiny amount, then verify
    `solana-usdc-to-base-usdc` direct stable routing or
    `solana-sol-to-base-usdc` post-receipt volatile review for Limitless. Assert
    that no Polygon intermediate child operation is created.
11. Composite source: split value across two eligible Hunch balances so neither
    alone covers the BUY but the backend composite option does. Verify one
    operation, sequential legs, one review, and one settled consumer
    reservation.
12. Abandonment: prepare a shortfall to `ready`, then go Back or change the
    amount. Verify `released_to_venue_cash` and no order.
13. Definitive no-fill: use a safe order shape that produces no fill if an
    active market permits it. Verify reservation release rather than
    consumption.
14. Reload/retry: reload during a non-terminal operation and resume it without
    a duplicate operation, action attempt, transfer, or order.

Do not force a route that is unavailable under policy or current liquidity.
Record it as unavailable evidence and continue with the remaining matrix.

## 5. Timing and visual evidence

Record independent timestamps for:

- primary CTA click and first visible progress;
- planner start/end;
- quote request/response;
- operation commit;
- each action prepared, wallet/provider accepted, broadcast, first receipt,
  required finality, destination observation, and venue readiness;
- refreshed trade quote, order submission, acknowledgement, fill, and position
  projection.

Required budgets:

- progress appears without layout shift within 100 ms of the click;
- planner target remains p95 <= 7 seconds;
- Hunch-controlled reconciliation after required receipt/finality targets
  p95 <= 3 seconds;
- internal same-owner EVM paths use one confirmation unless an exact
  route-specific policy proves two are required;
- a route is not marketed as inline merely because the provider quote succeeded;
  measured end-to-end p95 and timeout/recovery policy decide activation.

Save desktop and mobile screenshots for: ordinary `Buy Now`, internal
shortfall progress, volatile review, external `Add funds`, venue list, method
choice, asset/network choice, address/QR, waiting/received/converting/ready,
restored Buy, filled Buy, position, Sell, and converted From/To review. No image
may expose secrets or full private identifiers beyond the intentionally shown
public receive address.

## 6. Database evidence

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

## 7. Funding budget

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
