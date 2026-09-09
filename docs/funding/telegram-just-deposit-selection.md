# Telegram Just Deposit: exact receive selection

## Incident evidence (2026-09-09 UTC)

Read-only production inspection confirmed two USDC-on-Solana selections:

- Context `e5bdb254-42d2-4cbe-baa4-602e79b608fb`: consent revision 1 selected
  Polygon pUSD at 01:27:33.075; revision 2 selected Solana USDC at 01:27:35.590.
  Outbox nevertheless delivered the Polygon address at 01:27:35.791, then an
  address-free Polygon `unavailable` card at 01:27:36.751.
- Context `64d6a0fa-0825-41b0-97bc-16018c820079` repeated the same sequence
  at 01:28:19–01:28:22.
- Cancellation of context `b9b55795-25c4-42a8-b20c-749203f989ab` persisted at
  01:30:07.197. Its terminal delivery retried with `funding_render_superseded`.
  Database cancellation was successful; presentation ownership conflicted.

Callback bodies are not present in the inspected container logs. The USDC.e
path is independently reproduced from the shipped button and callback parser:
the menu emitted `deposit_route:pw`, although the route registry rejected it.

## Fix boundaries

- The retained-source disclosure guard accepts exactly native SOL, canonical
  Solana USDC, or canonical Polygon USDC.e.
  Consent, frozen variant and accepted target must match the **same asset**;
  current managed-wallet ownership and expected receive address remain checked
  both at projection and immediately before delivery.
- Explicit `open-route` passes its server-derived choice into `open`. A new
  session does not first consent to or enqueue the default Polygon route.
  Reuse and retries apply the same exact selection; opening a venue without
  an explicit asset retains the existing sole-direct behavior.
- The USDC.e button and `pw` callback select the new receive-only route
  `polymarket_polygon_controller_usdce_v1`: the verified current managed
  Polygon controller, **not** its Deposit Wallet. The received asset stays
  USDC.e; no child funding operation, wrap, Relay quote or Buy is created.
  Receiving does not require a Router snapshot, allowance, delegated trading
  permission or an enabled automation route.
- Receipt observation still requires canonical token Transfer evidence. The
  new variant is an owned-source credit, never evidence of pUSD venue funding.
  A later user-confirmed Mini App purchase uses the existing funding planner,
  including USDC.e preparation and approvals where needed. Those execution
  checks are not bypassed. An app-handoff Buy can expose the retained source;
  a bot-submit Buy must not mistake it for ready venue collateral.
- Opening or replaying the retained route does not provision automation.
  Historical `polymarket_polygon_usdce_wrap_v1` consents remain non-executable;
  a stale callback selects the new exact choice, never silently substitutes pUSD.
- Retained receipt copy uses the actual network. Only native SOL is passed to
  the lamport-price estimator; USDC and USDC.e are not priced as SOL.
- Cancellation and its durable delivery share the canonical address-free card.
  Cancellation render tokens permit that delivery; ordinary Any/menu navigation
  does not grant background funding permission to replace the selected menu.
  Terminal cards include Add funds; existing Back to market remains available.

Migration `0255_funding_receive_retained_stablecoins.sql` replaces only the
receipt-identity predicate: exact Solana USDC and Polygon USDC.e join the
existing native SOL allowlist. No table/column changes, historical rewrites,
data-dependent migration assertions or new signing permissions. The predicate
still verifies the user, session, frozen variant, network, mint, decimals and
recipient. Retained source receipts do not satisfy pUSD destination readiness.
No frontend change or production repair.
No historical Buy or conversion is resumed. Already-terminal receive contexts
remain terminal: after deployment, open a fresh deposit. Do not resend a transfer
that has already been sent. Durable redaction obligations are not cleared merely
because a newer menu generation exists; that alone does not prove delivery.

## Regression coverage

- HTTP route selection for all seven supported direct/retained menu routes.
- Callback coverage for displayed menu buttons, including USDC.e.
- PostgreSQL 16: explicit USDC open/replay, exact consent revisions, managed
  Solana disclosure, real projector/outbox delivery, cancellation and retry.
- PostgreSQL 16: USDC.e open/replay with disabled trading permission and an
  automation provisioner that throws if called; exact controller disclosure;
  ready receipt projection with no child operation. Foreign-controller
  substitution is rejected. The new wallet lock SQL is exercised here.
- PostgreSQL 16: canonical USDC.e event is processed through the real observer
  and receipt allocator, not merely inserted as ready by the test. The retained
  receipt must pass the SQL frozen-variant predicate and have no child operation.
- Negative address substitution and existing revoked-wallet protection.
- Funding unit suite and bot callback/render-generation suite.

Production Telegram smoke verification is still required after deployment:
Any → USDC Solana → Back → SOL → cancel → Add funds, plus USDC.e Polygon,
pUSD Polygon and USDC Base. Every address-bearing card must match the selected
network/asset.

## Verification boundaries

The purchase planner, Router execution validator and delegated executor are
unchanged by this fix. Local funding tests cover the existing USDC.e
planning/approval paths. No signed transaction or new onchain wrap was sent
as part of this verification; deployment and live Telegram smoke remain
the operator's next step.

Verification on 2026-09-09: funding unit suites 67/67; signal-bot tests
261/261; deposit callback/HTTP cases 9/9; TypeScript, scoped ESLint and Prettier.
Both receive persistence/observer and Telegram receive integration suites ran
on PostgreSQL 16.2. Migration 0255 was tested as an upgrade and in a complete
migration run on a fresh disposable database. The isolated rerun avoids an
old leftover fixture in the shared review database affecting global batch
candidate counts; no assertion was weakened to accommodate that fixture.

Review corrections include the SQL/TypeScript retained-asset mismatch,
unnecessary receive-time automation provisioning, SOL-only valuation applied
to stablecoins, and truncation collisions in derived selection idempotency keys.
No changes were committed, pushed or deployed.
