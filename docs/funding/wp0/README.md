# Funding WP0 evidence pack

Status: **WP0A read-only evidence and the Relay fixture/quote baseline are
complete; the WP0 implementation gate is not yet passed.**

WP0A was captured on 2026-07-23 without changing production, Privy
configuration, code, branches, or deployment state. A subsequent explicitly
authorized local step added the sanitized Relay fixture corpus and its unit
test. A later quote-only capture created six Relay request/log records using
non-owned fixture addresses. It made no Deposit Address mode request, wallet
signature, transaction, fund movement, production, Privy, branch, commit, or
deployment change.

## What is complete

- Local source revisions and funding/wallet touchpoints are pinned.
- Production schema, aggregate legacy bridge shapes, schedules, and relevant
  job logs were inspected read-only.
- Every production `bridge_orders` row matches a frozen legacy adapter
  classifier; unknown active adapter versions: **0**.
- Current Privy action policies, Account Funding methods and asset setup,
  funding webhook, asset watchlist, policy IDs, and integration-key presence
  controls were verified in the Dashboard without editing them.
- Relay, Privy, Across, deBridge, and Bungee claims are tied to official
  documentation and the 2026-07-23 retrieval date.
- Relay OpenAPI, chain/currency, Status v3, Quote v2, Deposit Address, webhook,
  error, drift, and negative-policy shapes are pinned in a sanitized fixture
  corpus. Live evidence includes read-only OpenAPI, chain and status GETs plus
  three quote-only route summaries; docs/synthetic fixtures remain labeled
  explicitly.
- Deterministic clone baselines were captured.
- The four mandatory WP0 matrices/runbook exist with accountable owner roles
  and current rows.

## Why WP0 is not yet complete

The sanitized provider-contract baseline and three quote-only route summaries
now exist. They do not yet prove the returned EVM/Solana actions against the
future Hunch allowlist, a real wallet's readiness, execution, destination
visibility, or refund. The guarded rehearsal runner and tiny-value
settlement/refund evidence are also absent. In addition, 106 legacy bridge rows
were non-terminal at the WP0A production snapshot, so legacy reconcilers cannot
be removed.

The remaining gate is therefore explicit: implement the Relay schemas/adapters
and guarded runner against this corpus, validate the captured action shapes,
run dry preflights, obtain separate approval for any tiny-value live action,
reconcile/classify the 106 legacy rows, then record the results here. No product
route is activated by this evidence pack or fixture corpus.

## Artifacts

- [WP0A evidence report](wp0a-evidence-report.md)
- [Legacy Exit Matrix](legacy-exit-matrix.md)
- [Live Rehearsal Harness](live-rehearsal-harness.md)
- [Functional Parity Matrix](functional-parity-matrix.md)
- [User Data Lifecycle Matrix](user-data-lifecycle-matrix.md)
- [Deterministic duplication baseline](duplication-baseline.md)
- [Relay fixture corpus](../../../apps/api/src/funding-providers/relay/fixtures/README.md)

## Accountable roles

| Role                     | Scope                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| `FundingPlatformOwner`   | domain contracts, providers, persistence, reconciliation              |
| `FundingUIOwner`         | web Deposit/Convert/Withdraw/Activity and trade integration           |
| `WalletPolicyOwner`      | Privy policies, action validation, signing and sponsorship            |
| `FinanceOperationsOwner` | production reconciliation, schedules, rehearsal approvals and reports |
| `DataLifecycleOwner`     | merge, deletion, retention, protected references and crypto-shredding |
| `VenueIntegrationOwner`  | Polymarket/Limitless readiness, execution, positions and redemption   |
| `TelegramTradingOwner`   | Telegram authorization, intent, funding and recovery parity           |

These are concrete ownership roles used by the implementation plan. Assignment
to named individuals is an organizational action outside this read-only audit;
the role responsible for every row is nevertheless unambiguous.
