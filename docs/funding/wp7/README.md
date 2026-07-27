# WP7 — Unified web funding UX

Status: implementation corrected and awaiting guarded re-verification as of
2026-07-27.
The inline Buy funding caller and exact funding-reservation linkage are now
implemented for desktop/mobile Polymarket and Limitless CLOB/AMM BUY paths.
WP7 must not be marked evidence-closed until the focused automated suite and
guarded live matrix below are run. No production activation, commit,
deployment, policy mutation, wallet action, or external financial call was
performed as part of this implementation pass.

## 2026-07-27 guarded-live correction

The first Polymarket-balance → Limitless rehearsal exposed a topology bug:
the planner treated a distinct Polymarket Deposit Wallet as if its linked Privy
controller could execute Relay calls directly from the Deposit Wallet address.
Privy correctly submitted from the controller smart account instead. The
receipt reconciler rejected the mismatch; no collateral moved, but the
irrelevant zero-balance controller allowance changed.

The correction is fail-closed and topology-specific:

- a distinct derived funder never inherits the linked controller's server
  wallet reference or generic execution modes;
- eligible Polymarket Deposit Wallet pUSD now plans an exact pre-route handoff
  through the existing Polymarket relayer;
- the handoff moves only the frozen source amount to the linked controller,
  then the already quoted Relay steps run sequentially from that exact
  controller;
- the backend fingerprints the relayer payload and accepts the result only
  after a canonical receipt proves exactly one matching pUSD `Transfer` from
  the frozen funder to the frozen controller for the frozen raw amount;
- the shared controller exposes `venue_relayer` as a typed executor mode; the
  ordinary UI still shows one `Buy` journey and no technical source selector.

Focused source-planner, receipt, route, controller, presentation, restoration,
type, lint, and formatting checks pass locally. Guarded live funding/buy/sell
evidence remains pending an API and finance-worker restart with this correction.

For the observed Polygon pUSD → Base USDC path, three successful on-chain
actions are expected:

1. exact pUSD handoff from the Polymarket Deposit Wallet to its linked
   controller through the Polymarket relayer;
2. exact/bounded ERC-20 allowance from that controller to the frozen Relay
   spender when the existing allowance is insufficient;
3. the frozen Relay route from controller pUSD to destination USDC.

The first action is a topology requirement: the Deposit Wallet owns the
collateral but cannot execute arbitrary Relay calldata. The third action is the
actual route. Only the allowance action is potentially removable later, and
only with proven permit/Permit2 support or a bounded pre-authorization policy;
an unlimited generic spender approval is not an acceptable optimization.

## Delivered boundary

WP7 gives the web application one backend-owned funding and position-action
model:

```text
inspect
  -> prepare
  -> explicit wallet execution or external handoff
  -> durable report
  -> backend reconciliation
  -> ready/completed only after backend postconditions
```

The browser may report that a transaction was submitted. It cannot turn that
submission into funding readiness, redemption completion, or a trade.

### Frontend

- Typed clients cover Account Assets, Funding destinations/liquidity/quotes/
  operations/actions, wallet preparation, withdrawal-recipient registration,
  and owner-bound Position Actions.
- `useFundingController` plus its reducer owns Add Funds, Convert, direct
  Receive, bridge/Relay source routes, Privy handoff, Withdraw, multi-leg
  execution, reporting, polling, recovery, and backend status presentation.
- The normalized executor includes the exact
  `polymarket_deposit_wallet_transfer` handoff. It reuses the existing embedded
  typed-data authorization and Polymarket relayer client, then reports only the
  returned on-chain transaction hash for backend reconciliation.
- Desktop and mobile Deposit/Withdraw surfaces are thin wrappers around the
  same `FundingFlow`.
- Desktop and mobile redemption surfaces are thin wrappers around the same
  owner-bound `RedemptionFlow` and `usePositionActionController`.
- Buy/Sell confirmation uses the shared preparation boundary. BUY selection is
  constrained by an authenticated `controllerWalletRef`; SELL and Redeem use
  the exact `positionActionRef` and stored venue-owner binding.
- A confirm attempt re-checks Trading Wallet readiness immediately before the
  existing venue submitter. The Polymarket submitter obtains a fresh execution
  quote, and the Limitless market submitter obtains fresh CLOB depth before
  signing.
- A BUY shortfall stays inside the existing Buy confirmation. It freezes the
  market, authenticated controller-wallet reference, destination/binding, and
  full requested destination amount before discovery.
- The inline flow consumes the backend-recommended eligible Hunch source,
  including a composite multi-leg source, without asking the user to choose a
  destination or exposing provider/wallet implementation identifiers.
- Direct Receive and Privy external ingress are deliberately excluded from
  `trade_shortfall`: if no existing eligible Hunch balance can cover the Buy,
  the flow stops before commit and offers the separate Add Funds journey.
- Funding readiness returns a settled consumer reservation. Its operation and
  reservation IDs are passed through the shared venue model to Polymarket and
  Limitless CLOB/AMM BUY requests. The order backend validates the exact
  authenticated user, venue, market, active state, and expiry before consuming
  or releasing the reservation.
- The funding aggregate never submits an order. After readiness, the web Buy
  caller refreshes venue balance/readiness and the trade quote and submits once
  under the same exact original Buy authorization. If that authorization or
  its economic bounds are no longer valid, it stops for a new review.
- Changing the market, outcome, side, amount, or wallet abandons the frozen
  intent and releases the reservation as ordinary venue cash. A reservation
  that survives a client interruption still expires backend-side.
- Funding operation and pending-report references survive reload in scoped
  browser storage, while the backend remains authoritative. Recovery can also
  discover a resumable operation from authenticated history.
- A common Funding Activity view reads safe operation summaries from the
  backend.
- Token suggestion preferences are editable from the source UX. The UI states
  and the API guarantees that this ranking preference grants no transaction,
  delegated-signing, or sale authority.

### Backend support added during WP7 integration

- Public action responses expose an authenticated, owner-scoped
  `controllerWalletRef`. This is deliberately separate from stable internal
  action IDs and contains no address or provider authority.
- Account position components expose an exact `positionActionRef`, allowing
  SELL and Redeem to bind to the stored owner rather than infer ownership from
  a wallet address.
- Destination discovery accepts the authenticated controller-wallet reference
  for exact current-intent BUY selection.
- Manual Receive and policy-gated Privy ingress use a direct-ingress adapter
  with typed receive targets. The first activated Polymarket target binds one
  Polygon Deposit Wallet address and accepts pUSD or USDC.e with a minimum
  funding target.
- Direct ingress reconciliation observes every accepted target asset against
  an immutable baseline and locks one variant. pUSD completes directly; USDC.e
  activates a precommitted Funding Router step and completes only after pUSD/
  CLOB readiness. The receive observer itself does not depend on a Relay key.
- Operation reads expose public steps and ingress instructions without
  returning internal snapshots, raw authority fields, or secrets.

## Provisioning ownership

WP7 does not create Privy wallets. Existing Privy EVM/Solana creation,
single-flight behavior, user refresh, and backend wallet reconciliation remain
owned exclusively by `AuthProvider`.

This does not mean wallet creation was removed. It means Deposit, Funding,
Buy/Sell preparation, Redemption, and Telegram cannot each grow a second
provisioner. If a wallet is missing, the backend returns a typed prerequisite;
Auth completes the existing provisioning path; the caller then re-inspects
readiness.

Static review found no wallet-creation call in the new Funding feature, funding
hooks, or funding library.

Auth also owns proactive internal venue preparation. Its existing Polymarket
bootstrap now performs the canonical signer and Deposit Wallet Funding Router
allowances in the background, in addition to deployment, registration,
connection, and base venue approvals. It reuses the existing Privy
authorization, sponsorship, relayer, and single-flight paths. The existing
Limitless bootstrap continues to establish the internal profile at login;
market/side-specific Limitless requirements remain automatically checked at
the operation boundary because they cannot all be known at authentication.
Deposit does not execute or display a setup workflow.

## Existing-UI compatibility boundary

The `onLegacyRequired` callback switches a thin unified wrapper to the
pre-existing Deposit/Withdraw/Redemption component. It is a migration safety
boundary, not a new orchestration layer.

It is used only when:

1. funding creation is disabled by runtime policy; or
2. the backend returns a `signature` or `external_handoff` preparation action
   for which the new web boundary has no exact allowlisted executor. Internal
   Polymarket Deposit Wallet deployment/proxy execution is supported through
   the existing relayer and embedded authorization path; unknown handoff kinds
   still fail closed; or
3. an existing redemption belongs to an exit-only/unsupported venue or an old
   position cannot yet be resolved to exactly one `positionActionRef` and
   owner binding.

Normalized `evm_transaction` and `svm_transaction` paths remain on the unified
controller. Existing compatibility components receive no new business logic.
They must not be deleted until exact action-type parity and guarded live
evidence exist. This preserves existing external signer, Limitless login,
Polymarket setup, redemption, and withdrawal behavior instead of pretending
that a wallet signature alone proves completion.

## Security and correctness invariants

- UI choices use opaque destination, source, binding, operation, step, and
  owner-scoped controller-wallet references.
- No normal unified component branches on Relay, Polymarket, Limitless,
  Bungee, Across, or deBridge.
- Provider-specific signing details exist only in execution/presentation
  adapters.
- A connected external wallet is not enumerated as a normal destination or
  balance source. External funds enter through an explicit minimum-target
  manual Receive or configured Privy handoff; any future connected-wallet route
  requires its own explicit user-controlled signature.
- Privy sponsorship is requested only when the prepared action explicitly
  reports `payerRequirement=privy_sponsor`.
- Multi-leg funding is one durable operation. The controller executes only the
  first backend-actionable step, re-syncs, and continues sequentially.
- A submitted or ambiguous action is reported, not converted into success.
- Ready funding shows `Funds are ready. No trade has been submitted.`
- Redemption completes only after both receipt and position postconditions are
  confirmed.
- An unavailable redemption with no actionable preparation fails closed and
  exposes no active Prepare button.
- Direct external ingress waits until the backend-observed balance delta reaches
  the requested target. Partial same-asset transfers accumulate and excess
  remains ordinary Account Value. Different accepted assets are not combined;
  a mixed deposit enters recovery.
- Equivalent collateral conversion such as Polygon USDC.e → pUSD is
  preconsented in the Receive review and runs automatically after observation.
  The browser does not ask the user to select a technical route. Volatile-asset
  sale still requires a distinct quote and explicit economic consent.
- `trade_shortfall` cannot select direct Receive or Privy ingress. This prevents
  a manual external transfer from being presented as one already-consented
  Buy operation.
- Trade-shortfall history recovery never adopts an unrelated recent Buy
  operation. Recovery is restricted to the exact persisted user, intent,
  market, destination/binding, and requested-amount scope.
- A settled reservation is never treated as a second balance deduction in the
  UI; it only authorizes the linked BUY. Back/close/intent change releases
  it, successful submission consumes it, and definitive no-fill releases it.
- Pending reports are persisted before the report call, then retried after a
  reload. A 409 is resolved by reading the authoritative backend step/
  operation state.
- Creation-mode-off and unsupported action kinds preserve the already-working
  path; they do not silently choose a different wallet, destination, or owner.

## Review corrections made before closure

The final review found and corrected:

- internal stable wallet/action IDs had initially been confused with the
  authenticated wallet-row ID used by `AuthProvider`; the public
  `controllerWalletRef` contract now binds them explicitly;
- custom query builders initially omitted `controllerWalletRef` and
  `positionActionRef`; focused tests now pin both query strings;
- dialog dismissal could occur while a Privy handoff was active; busy state now
  includes presentation and locks desktop/mobile dismissal;
- `Start another operation` did not clear one-shot loading refs; reset now
  reloads destinations;
- direct external operations exposed an unsafe cancel affordance despite having
  no generic reversible external step; it was removed;
- unavailable owner-bound redemption could still display Prepare; it now fails
  closed;
- token preference and Funding Activity contracts existed without a shared WP7
  presentation; both now use the typed backend APIs.
- ordinary destination/recovery reads were accidentally treated as blocking
  Privy presentation, freezing tabs and dismissal; only real mutation/
  presentation phases now block the dialog;
- a technical `Check Trading Wallet setup` action made backend inspection the
  user's problem; destination readiness is now inspected automatically;
- normal Add Funds exposed every external wallet/venue binding and raw wallet
  labels; it now renders one Hunch-managed card per venue, recommends the
  backend-selected Polymarket destination, and collapses other venues;
- connected external wallets no longer compete as destinations or normal
  `Pay with` balance rows. Direct Receive/Privy are the initial external-money
  sources; connected-wallet routing remains a separate advanced contract;
- `Bridge` duplicated a source route as a top-level product mode; the unified
  UI now has Add Funds and Convert, while bridge/Relay remains an Add Funds
  source and old deep links normalize safely;
- stale evidence and a genuinely unsupported source were rendered as the same
  dead end; stale balance/price evidence now offers a bounded refresh;
- Polymarket Funding Router preparation was leaking approval jargon into
  Deposit. The existing auth bootstrap now performs its signer and Deposit
  Wallet router allowances in the background through Privy authorization,
  sponsorship, and the allowlisted relayer path. Deposit only consumes
  readiness and exposes no setup CTA;
- the Buy confirmation still exposed the same internal readiness as
  `Check/Prepare/Preparing Trading Wallet`. Privy-authorized preparation now
  auto-runs only when every normalized action is non-value-moving, successful
  background progress is not a user step, and only a terminal retryable failure
  appears as `Trading temporarily unavailable`;
- value-moving `venue_preparation` operations remain durable backend plans, but
  their product copy is `Use available Hunch balances` / `Adding funds`; the
  browser does not expose the internal Deposit Wallet, router, approval, or
  preparation-stage names.
- order APIs already enforced an exact funding reservation, but the web
  submitters did not send its operation/reservation IDs. The shared venue model
  now forwards one typed link to Polymarket and Limitless CLOB/AMM BUY requests
  and never attaches it to SELL.
- direct Receive/Privy ingress was initially discoverable for
  `trade_shortfall`, which could turn an external transfer into a misleading
  claimed Buy flow. Those sources are now limited to Add Funds/manual rebalance.
- an active unified Polymarket reservation now disables the old submit-time
  auto-top-up fallback. The submitter refreshes the exact destination balance
  and fails closed if prepared pUSD is not observable instead of silently
  starting a second funding path.
- the separate Add Funds fallback now opens with the exact current Trading
  Balance target when available; it does not ask the user to rediscover the
  destination.
- exact intent recovery includes amount and destination binding; a ready but
  unclaimed reservation is released on Back or component dismissal, while
  committed in-progress operations remain resumable instead of being
  unsafely cancelled mid-route.

## Local verification

The results below are the baseline produced before the inline Buy funding
caller was added. They are retained as historical evidence and are **not** a
claim that the current WP7 delta has been executed. Per the requested handoff,
no test, typecheck, lint, build, or live financial flow was run during the
2026-07-25 closure implementation pass.

Static review performed on the current delta:

- `git diff --check` passed in both repositories;
- deterministic duplication audit over the broader touched Funding,
  Confirmation, funding-hook, trade-hook, and confirmation-library scope
  analyzed 96 files: Type 1 coverage was 7.55% with 4.20% estimated
  redundancy; Type 2 coverage was 17.90% with 10.17% estimated redundancy;
- the reported broader clones are pre-existing venue-hook and desktop/mobile
  presentation patterns. The new `FundingFlow`/`FundAndBuyFlow`,
  trade-shortfall linkage helper, and direct-ingress adapter were refactored
  and re-audited together: 0 Type 1 and 0 Type 2 clone classes at the required
  60-token/5-line threshold.

Frontend:

- `bun run type-check` — pass
- `bun run lint` — pass
- `bun run format:check` — pass
- `bun test tests/funding` — 26/26 pass after the final venue-only,
  presentation, and background-preparation corrections
- `bun test tests` — 559/559 pass
- `bun run build` — pass; all 36 static pages generated

Backend:

- `pnpm -F api typecheck` — pass
- `pnpm -F api lint` — pass
- `pnpm -F api format:check` — pass
- focused account/funding/preparation/position-action runner — 9/9 files pass
- `pnpm -F finance-worker test` — 11/11 pass
- the complete API fast suite had already passed 29/29 files in the same WP7
  working state before the final public owner-reference schema adjustment; the
  affected routes/runtime were then re-run in the focused 9/9 set

Review searches:

- no Privy wallet-creation call under the new Funding feature/hooks/library;
- no Relay/Polymarket/Limitless/provider branch under the unified Funding
  feature/hooks/library;
- no remaining application caller imports the old desktop/mobile
  Deposit/Withdraw/Redemption component directly; callers resolve through the
  unified index exports.

## External-address consistency review — 2026-07-25

The initial normal Add Funds contract is now explicit and consistent across
the plan, backend source discovery, and web presentation:

| Capability                                                                             | Status                                      | Initial behavior                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| destination selection                                                                  | implemented                                 | venue-first, one opaque Hunch-managed Trading Balance per venue                                                  |
| Hunch-owned source balances, including enabled embedded SOL                            | implemented                                 | route or combine through backend-issued opaque source options                                                    |
| direct transfer from an external address                                               | implemented                                 | `Deposit crypto` shows the exact final owned address, asset, and network                                         |
| direct Receive amount handling                                                         | implemented                                 | requested amount is a minimum target; partial transfers accumulate and excess remains Account Value              |
| Privy handoff                                                                          | implemented, policy-gated                   | exact destination is handed to the configured method; backend observation settles                                |
| connected external wallet balance in normal `Pay with`                                 | deliberately excluded                       | it is neither auto-selected nor rendered; a future advanced signer contract is required                          |
| external different-asset/network deposit, such as Phantom SOL directly to Polygon pUSD | not activated                               | direct Receive rejects the implication; strict Relay Deposit Address or a separate advanced contract is required |
| strict Relay Deposit Address                                                           | architecture and fixtures exist, routes off | exact amount, refund, expiry, and reconciliation evidence remain activation gates                                |
| one available source                                                                   | implemented                                 | source choice is skipped and the UI proceeds to review                                                           |
| several sources                                                                        | implemented                                 | backend recommendation plus explicit `Pay with` choice                                                           |

The direct Receive address is not a Relay address. Sending the displayed
destination collateral to it is one operation. Sending a different token to an
intermediate Hunch wallet and then routing it would be two sequential
operations; the initial plan does not pretend those have one immutable quote or
one automatic consent.

The former material web gap has been implemented: trade-shortfall callers no
longer use the generic Deposit path when an eligible Hunch balance exists. The
inline flow fixes market/destination/amount, executes one backend-selected
source plan, and links its settled reservation to the same BUY. Equivalent
stable collateral resumes automatically under the original Buy authorization;
volatile or out-of-bound refreshed economics require a new review. The generic
Add Funds dialog is retained only as an explicit fallback when discovery
reports that existing eligible Hunch balances cannot cover the shortfall.

## Pending closure evidence

WP7 is implementation-complete but evidence-pending until all of the following
are green:

1. frontend funding/confirmation tests, typecheck, lint, format, and build;
2. backend funding source/planner/reservation/order tests, typecheck, lint, and
   format;
3. deterministic Type-1 and Type-2 duplication audit remains green after any
   fixes made by the automated/live test pass;
4. desktop and mobile already-funded BUY, inline-funded Buy, back/close, amount-change,
   reload, retry, and no-source/Add Funds journeys;
5. Polymarket BUY then SELL with a linked reservation;
6. Limitless CLOB or AMM BUY then SELL with a linked reservation;
7. Polygon pUSD, cross-chain Hunch balance, native SOL source, and composite
   multi-leg source coverage where the local fixture can make each route
   eligible;
8. database evidence that successful BUY consumes the reservation, definitive
   no-fill or abandonment releases it, and no duplicate operation/order is
   produced.

The executable order, expected observations, and bounded live-value budget are
frozen in [`verification-plan.md`](./verification-plan.md).

## Activation and next work

The code is ready for the pending local and guarded tiny-value verification
above, but production funding creation remains a policy decision. WP8 adopts
the same contracts for Telegram and exact Privy delegated policy enforcement.
WP9 owns production-style activation/rollback evidence and the decision to
remove compatibility components.
