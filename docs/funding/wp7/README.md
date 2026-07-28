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

## UX and open-ingress correction plan — 2026-07-27

Live review proved that the durable router/observer mechanics are ahead of the
normal product surface, but WP7 is **not** UX-complete. The current frontend
overloads the amount-specific Funding Operation as a general Add Funds form,
collapses Limitless when only two venues exist, leaks technical asset/location
labels into Convert, and renders an automatically coverable Buy shortfall as a
separate explanatory missing step. The initial plan also specified only a
minimum-target owned Receive operation, so the general amount-free top-up gap is
a plan defect rather than a styling-only regression.

The correction is deliberately one architecture, not a second funding stack.

Practical execution order is: Phase A; the contract-independent parts of
Phases C, D, and E (Buy CTA/card removal, two-venue visibility, and human
Convert presentation); Phase B; the remaining amount-free/multi-network work
in Phase D; then Phase F and the complete verification matrix. This lands the
obvious UX regressions without coupling them to the larger receive-session
migration, while the new Add Funds promise is not exposed before its backend
contract exists.

Local implementation status on 2026-07-27:

- ordinary internal shortfall now keeps the normal green `Buy Now` CTA and
  renders no explanatory funding card. An executable internal route takes
  precedence over the current venue-wallet cash deficit; only the absence of
  such a route plus a proven external cash shortfall exposes `Add funds`.
  While route discovery is still loading, the footer keeps the same disabled
  `Buy Now` instead of rendering a technical “Hunch is finding…” status card;
- general Add Funds opens an amount-free Receive Session, shows all venues
  until the five-venue collapse threshold, and presents one explicit
  asset/network choice with address, QR, and copy action;
- migration `0190_funding_receive_sessions.sql` adds durable sessions and
  immutable receipts linked to child Funding Operations. Polygon Receive
  receipts carry canonical ERC-20 identity
  `(networkId, transactionHash, logIndex)`, block evidence, exact event
  amount, and a database-wide uniqueness constraint;
- an address stops being presented when its 24-hour receive session expires or
  is cancelled, while a separate seven-day `observeUntil` recovery window
  continues detecting late transfers. Automatic conversion is never resumed
  from expired consent; direct collateral remains visible and non-direct value
  enters recovery;
- Polygon pUSD direct and Polygon USDC.e → pUSD remain registered canonical
  receive targets. Limitless Base USDC direct receive and an exact owned Base
  USDC → destination stable route are now code-complete behind the same
  `evm_erc20_transfer_v1` capability. The planner advertises the Base variant
  only when one exact owned source-location policy, one enabled route, wallet
  ownership, signing mode, observer capability, and destination binding all
  agree; route evidence or an aggregate wallet balance alone is insufficient.
  Solana USDC and native SOL are now code-registered behind the shared
  `solana_transfer_v1` canonical event capability. The scanner freezes a
  finalized slot before showing the owner address, watches the derived USDC
  token account for SPL transfers or the exact owned address for System Program
  transfers, parses exact outer/inner instruction coordinates, and stores
  `(signature, instruction coordinate, slot, containing blockhash)` identity.
  Either asset is advertised only with the same exact owned
  wallet/location/route evidence as Base. The EVM scanner freezes its
  block cursor before the balance snapshot and before showing the address,
  waits for configured external-ingress finality, and scans accepted tokens'
  canonical `Transfer` events. The same funding controller loads and continues
  every stable child operation; the frontend does not gain a second executor;
- Relay quote-only evidence captured on 2026-07-27 proves direct
  `solana-sol-to-base-usdc` and `solana-usdc-to-base-usdc` availability in both
  `EXPECTED_OUTPUT` and `EXACT_INPUT` modes. Production adapter validation
  selected `EXPECTED_OUTPUT` and accepted exactly one SVM instruction plus one
  lookup table for each route, with observed quote latency of 1.043 seconds for
  SOL and 0.506 seconds for Solana USDC and provider ETA of 3–9 seconds. The
  direct route is the required Limitless preference; a
  Solana → Polygon pUSD → Base USDC chain is not used while the direct route is
  enabled and healthy;
- every Receive Session freezes the current funding-policy revision and its
  stable/volatile automation decision, maximum fee USD, maximum fee BPS, and
  maximum slippage BPS. An observed stable receipt can create an exact child
  operation only when the fresh quote remains inside all frozen caps; unknown
  economics fail closed. Completing one child receipt returns an amount-free
  session to `open`, so later canonical receipts can be accepted without
  reopening or inventing another operation;
- native SOL remains an explicit WP7 requirement and is code-complete as a
  `review_required` Receive variant; it is not misclassified as an automatic
  stable path. Its receive option is emitted only with canonical native
  transfer identity, an exact owned Solana wallet, and an allowlisted Relay
  route. Receipt ownership becomes Account Value first; the UI then asks once
  for economic consent showing SOL sold, minimum collateral received, fee,
  price impact, expiry, and refusal. Acceptance reuses the same
  liquidity/quote/commit and Funding Operation controller as every other route.
  The quote keeps a conservative 0.003 SOL reserve outside its input for source
  execution costs. Runtime activation still requires a service restart, active
  control-plane route publication, database persistence checks, and tiny-value
  execution/settlement evidence;
- this code is not runtime-activated until migration, service restart, database
  integration, and live route evidence pass. For Polygon Receive Sessions the
  worker scans at most one active/recovery session for each global
  network/asset/address stream, prioritizes the newest active session, advances
  a durable block cursor, and allocates every transfer event once under the
  database-wide canonical identity. The older exact-balance-delta observer
  remains only as a compatibility path for pre-Receive funding operations; it
  is not the identity source for new Receive Sessions. A provider-scale shared
  stream index may replace per-session cursors later for throughput, but is no
  longer required for correctness or route activation.

The 2026-07-27 post-extraction deterministic production-code audit covered the
Funding UI, funding hooks, and backend Funding subsystem with tests excluded:
112 files, 37,036 source lines, and 176,424 analyzed tokens. At the required
60-token/5-line threshold, combined Type 1 duplicate coverage is 2.31% with
1.17% estimated redundancy (28 clone classes); Type 2 coverage is 12.95% with
7.92% estimated redundancy (243 clone classes). Frontend-only Type 1/Type 2
coverage is 0.74%/7.59%; backend-only coverage is 2.66%/14.07%. Type 1 found no
second Funding UI/controller stack. The actionable frontend exact clone is
asset-option presentation shared by the Receive and Convert surfaces. The
largest backend exact clone is ERC-1155 `balanceOfBatch` batching, while the
largest structural classes are repeated SQL row mapping and route-handler
scaffolding. Those should be extracted as narrow primitives, not used as a
reason for a funding-stack rewrite.

The two actionable exact clones were then removed with narrow shared
primitives: Receive and Convert now share one asset selector/option renderer,
and the Polygon RPC service now shares one ERC-1155 pair-batching primitive.
The required post-change scans report 0 Type 1 and 0 Type 2 clone classes
across the two Funding asset-selector files, and 0 Type 1 clone classes in
`polygon-rpc.ts`. The broader Type 2 RPC/SQL shapes remain review candidates,
not authorization for a generalized repository or RPC rewrite.

The post-native-SOL scan includes production code plus Funding tests across
both repositories: 146 files, 49,925 source lines, and 238,945 tokens. At the
same 60-token/5-line threshold, Type 1 coverage is 2.54% with 1.34% estimated
redundancy; Type 2 coverage is 12.10% with 6.84% estimated redundancy. The
native SOL path did not introduce another frontend controller or
liquidity/quote/commit implementation. Its observer is a network adapter and
its review endpoints are owner-scoped wrappers over the existing Funding
Operation pipeline. The remaining exact Polymarket receive/preparation overlap
is a narrow follow-up extraction candidate, not evidence of two state
machines.

The subsequent presentation extraction moved quote review and
fallback/manual-ingress states into `FundingReviewPanel` and
`FundingFallbackPanel`; `FundingFlow` remains the sole owner of
`useFundingController`, execution refs, polling, and recovery effects. A
focused scan of `FundingFlow` plus all 17 Funding presentation modules found
zero Type 1 clone classes; Type 2 coverage is 1.42% with 0.73% estimated
redundancy. Contract tests explicitly fail if a presentation component imports
the controller or creates a reducer. The corrected frontend passes 79 Funding
tests, typecheck, lint, format, and the production build with all 36 static
pages generated.

Structured activation review compared four strategies: enabling every
balance-delta route now, blocking every new route until a complete scanner,
forcing all new ingress through quote-bound Relay addresses, and retaining the
verified Polygon path while adding canonical event ingestion route by route.
The coarse risk-adjusted model ranked incremental event-backed activation first
(4.95) and scanner-first blocking second (4.30), but sensitivity changed their
order when implementation cost varied. The robust conclusion is narrower:
**do not activate Base/Solana/general multi-asset ingress on per-session balance
polling alone**. Either scanner strategy is acceptable; this plan uses
route-by-route activation so the existing verified Polygon UX need not wait for
unrelated networks.

The frozen constraint journal
`wp7-funding-architecture-audit-2026-07-27` also produced satisfiable witnesses
for Polygon-only, Polygon+Base, and Polygon+Base+Solana capability sets. Every
witness requires canonical per-network receipts, the existing
planner/quote/commit pipeline, frozen session caps, exact review for volatile
conversion, and one frontend controller. No satisfying witness permits a
second funding pipeline, public balance-delta ingress, or a broad rewrite.
Solver witness counts are logical coverage only and are not probabilities.

### Phase A — freeze the product and API contracts

1. Separate five user-visible cases:
   - sufficient venue balance → ordinary `Buy Now`;
   - internal equivalent-stable shortfall → ordinary `Buy Now`, then automatic
     inline preparation and order submission;
   - internal volatile shortfall → ordinary `Buy Now`, then one exact economic
     conversion review before any sale;
   - external shortfall → `Add funds`, with the exact missing destination value;
   - general top-up → venue/method/asset-network/address without a mandatory
     amount when the receive contract supports an open amount.
2. Add a presentation-only ingress capability model. It must provide opaque
   receive-option ID, human asset/network metadata, exact contract identity,
   handling (`direct`, `automatic_stable_conversion`,
   `review_after_receipt`, or `quote_bound`), amount policy
   (`optional`, `minimum`, or `exact`), route-proof state, fee/ETA class, and
   safe instructions. An address is returned only after creating the receive
   contract.
3. Keep current `FundingOperation` immutable and amount-specific. Introduce a
   durable Receive Session for amount-free owned-address observation; each
   canonical receipt creates one exact child operation.
4. Preserve strict Relay Deposit Address as a separate quote-bound contract.
   It still requires amount, expiry, refund semantics, and provider evidence.
5. Keep all new APIs additive so the previously deployed frontend can continue
   using the current minimum-target endpoints during rollout.

Exit gate: request/response schemas, state transitions, consent boundaries,
late-arrival behavior, and compatibility tests are reviewed before UI work.

### Phase B — backend open-ingress and capability registry

1. Add additive persistence for receive sessions, accepted asset/network
   variants, observer cursors, canonical receipts, session-to-child-operation
   links, durable user-facing funding methods, consent caps, and
   expiry/recovery state. Reload must restore the same policy-gated
   `Send crypto` / Privy choices instead of rediscovering or guessing them in
   the browser. Every stored method carries its exact server-validated safe
   ingress presentation; the browser must not reconstruct provider/network/
   asset behavior from the destination asset.
2. Ingest each address/network/asset stream once. Allocate receipts
   idempotently by chain transaction/event identity instead of polling the same
   wallet independently for every browser session.
3. Create an exact child operation after observing the actual asset and amount:
   - destination collateral → direct credit/readiness;
   - equivalent stable asset → automatic route only inside frozen
     fee/slippage/action/amount caps;
   - volatile asset → Account Value credit plus exact conversion review;
   - unproven or out-of-cap route → owned value remains safe and the session
     becomes recoverable/review-required, never silently substituted.
4. Implement capability adapters incrementally:
   - retain Polymarket Polygon pUSD direct and USDC.e → pUSD;
   - expose Limitless Base USDC direct receive when its exact destination,
     observer, and readiness evidence pass;
   - add native Polygon USDC, other EVM stablecoins, Solana USDC, and native SOL
     only one exact contract/network route at a time after fixtures, finality,
     execution profile, timeout, refund/recovery, and tiny-value evidence.
5. Use route-specific finality. Same-owner internal EVM movement should normally
   proceed after one confirmed receipt; external ingress may require two when
   policy says so. Twelve-confirmation waits are not a default for internal
   balance preparation.
6. Close the action-attempt crash window: persist prepared/broadcast identity
   before or atomically with reporting, reconcile ambiguous `started` attempts,
   and never duplicate a broadcast after tab close, API restart, or worker
   restart.

Exit gate: unit, database integration, concurrency, duplicate-receipt,
late-receipt, mixed-asset, restart, and fail-closed tests pass without enabling
an unproven route.

### Phase C — ordinary Buy UX

1. Remove the visible `Hunch will prepare this Buy` missing-step card and its
   alternate `Buy` CTA.
2. Render the same green `Buy Now` CTA for sufficient balance and automatically
   coverable internal shortfall. Resolve the executable internal route before
   interpreting a venue-wallet cash deficit as external shortfall.
3. Start preparation and show the existing three-stage progress immediately
   after the click; do not briefly reveal another button or emit transient
   status cards below the progress surface.
4. Keep the original market/outcome/amount frozen. Automatically submit after
   readiness and fresh quote when still inside authorization.
5. Render `Add funds` only when discovery proves that no eligible existing
   Hunch value can cover the shortfall. Render an economic review only when a
   volatile sale or changed economics actually requires consent.

Exit gate: desktop/mobile component tests cover sufficient balance, internal
stable shortfall, volatile review, external shortfall, route checking, route
failure, reload, and double-click. There is always a stable footer height and
exactly one actionable primary CTA.

### Phase D — Add Funds UX

1. `Where to add`: render Polymarket and Limitless as peer venue cards while
   there are fewer than five venues. At five or more, show recommended/recent
   venues and `More venues`.
2. `How to add`: show only real methods such as `Send crypto` and a configured
   Privy method. Funding Activity remains secondary history, not a primary
   step.
3. `What are you sending`: show a human asset/network selector backed only by
   activated capabilities. For Polymarket the initial default is Polygon pUSD;
   Polygon USDC.e is an explicit alternative. Solana options appear only after
   their exact route is activated.
4. Amount rules:
   - general owned-address top-up: no required amount; an optional planned
     amount may improve the estimate but cannot make the address unsafe;
   - external Buy shortfall: exact/minimum missing amount is supplied by Buy;
   - strict provider address or prequoted volatile route: exact amount required.
5. Address state: network, selected asset, exact address, QR, copy, accepted
   alternatives, fee/ETA semantics, and warnings are visible together.
   Tracking starts before the address appears; the user may send immediately.
6. Status is a single stable surface:
   `Waiting for transfer` → `Received` → `Converting` when needed →
   `Ready to trade`. Closing the dialog never loses tracking.

Exit gate: no raw IDs, no amount `0`, no hidden second venue, no unsupported
asset selector, no `Start tracking, then send`, and no dead-end completed state.

### Phase E — Convert visual and interaction restoration

1. Keep the new backend planner/controller; do not restore legacy business
   orchestration.
2. Extract reusable presentation primitives from the established Deposit UI:
   large `From`/`To` cards, venue/asset/network identity, balance, `Max`,
   direction affordance, quote summary, and primary review CTA.
3. Replace the raw component select with human labels and icons. Hide wallet,
   component, provider, and `evm:*` identifiers behind optional technical
   details.
4. The user enters source amount only. Destination amount, minimum receive,
   fees, price impact, ETA, expiry, and default slippage are quote outputs.
   Advanced slippage is disclosed only when it is useful and safe to edit.
5. Use the canonical product tokens and shared responsive primitives. Do not
   introduce an orange/green palette specific to Funding and do not maintain
   separate desktop/mobile state machines.

Exit gate: reviewed desktop/mobile visual snapshots match the canonical product
hierarchy, keyboard/focus behavior works, and the new controller is the only
business-logic owner.

### Phase F — structure, rollout, and compatibility

1. Split the current monolithic Funding renderer into thin, data-driven
   surfaces: shell, venue picker, method picker, asset/network picker, receive
   panel, convert panel, operation progress, and secondary activity. Keep one
   reducer/controller and one set of selectors.
2. Run the deterministic duplication audit before and after extraction. Reuse
   presentation primitives; do not import the legacy Deposit flow wholesale or
   copy its routing logic.
3. Roll out backend migration/API/worker capability first, then frontend. The
   frontend renders only capabilities advertised by the running backend and
   falls back to the existing minimum-target flow when the new contract is
   absent.
4. Keep creation flags route-specific. No Solana/EVM option is enabled merely
   because Relay can quote it in isolation.

Exit gate: old-frontend/new-backend contract tests pass, new frontend fails
closed against an old backend, rollback leaves received assets visible as
Account Value, and no legacy path receives new business logic.

## Updated closure evidence

WP7 is core-mechanics-complete but UX/open-ingress-correction-pending until all
of the following are green:

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
9. ordinary Buy shows `Buy Now` for sufficient and internally coverable
   shortfall cases, with no pre-click funding card or alternate CTA;
10. two-venue Add Funds displays Polymarket and Limitless directly;
11. amount-free open top-up creates exact receipt child operations and handles
    late/multiple receipts without loss or double allocation;
12. Polygon pUSD, Polygon USDC.e, Limitless Base USDC, and every subsequently
    activated EVM/Solana receive option pass exact address/asset/finality/live
    evidence;
13. Convert desktop/mobile visual review contains no raw IDs or user-entered
    minimum output and preserves the established From/To hierarchy;
14. measured telemetry separates planner, user/external transfer, provider,
    chain confirmation, Hunch reconciliation, destination readiness, and order
    submission latency. UI feedback begins within 100 ms and Hunch-controlled
    post-receipt reconciliation targets p95 <= 3 seconds.

The executable order, expected observations, and bounded live-value budget are
frozen in [`verification-plan.md`](./verification-plan.md).

## Activation and next work

The durable WP7 router/reservation core is ready for continued guarded
verification, but the normal product surface is not ready for production
activation until the correction phases above close. WP8 adopts the corrected
contracts for Telegram and exact Privy delegated policy enforcement. WP9 owns
production-style activation/rollback evidence and the decision to remove
compatibility components.
