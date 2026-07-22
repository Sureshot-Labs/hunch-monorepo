# Funding WP0 evidence pack

Status: **WP0A read-only evidence capture complete; WP0 implementation gate not yet passed.**

Captured on 2026-07-23 without changing production, Privy configuration, code,
branches, or deployment state. The only changes made by this audit are the
documents in this directory.

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
- Deterministic clone baselines were captured.
- The four mandatory WP0 matrices/runbook exist with accountable owner roles
  and current rows.

## Why WP0 is not yet complete

WP0 requires executable/sanitized provider fixtures and a guarded tiny-value
rehearsal runner. Read-only WP0A could define and review that harness, but could
not add executable code, spend funds, create Relay requests, or change Privy
configuration. In addition, 106 legacy bridge rows are still non-terminal in
production, so legacy reconcilers cannot be removed.

The remaining gate is therefore explicit: implement the harness and sanitized
fixture corpus as code, run dry preflights, obtain separate approval for any
tiny-value live action, reconcile/classify the 106 legacy rows, then record the
results here. No product route is activated by this evidence pack.

## Artifacts

- [WP0A evidence report](wp0a-evidence-report.md)
- [Legacy Exit Matrix](legacy-exit-matrix.md)
- [Live Rehearsal Harness](live-rehearsal-harness.md)
- [Functional Parity Matrix](functional-parity-matrix.md)
- [User Data Lifecycle Matrix](user-data-lifecycle-matrix.md)
- [Deterministic duplication baseline](duplication-baseline.md)

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
