# WP7 — Unified web funding UX

Status: local implementation and review complete on 2026-07-24; no production
activation, commit, deployment, policy mutation, wallet action, or external
financial call was performed as part of this closure.

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
  with exact destination, network, asset, and amount instructions.
- Direct ingress reconciliation observes the exact destination balance delta,
  uses a destination advisory reservation, and does not depend on a Relay key.
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
- An external wallet is never pulled silently. It must either approve a normal
  wallet request or perform the exact manual Receive transfer.
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
- Direct external ingress waits for the backend-observed exact balance delta.
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
- connected external wallets no longer compete as destinations. They remain
  explicit sources or separate advanced compatibility flows;
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

## Local verification

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

## Activation and next work

The code is locally testable, but production funding creation remains a policy
decision. WP8 adopts the same contracts for Telegram and exact Privy delegated
policy enforcement. WP9 performs local creation-on journey rehearsal, guarded
tiny-value evidence, parity review, activation/rollback snapshots, and only
then decides whether compatibility components can be removed.
