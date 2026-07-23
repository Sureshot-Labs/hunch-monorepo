# Funding WP0 evidence pack

Status: **WP0 contract/evidence gate is sufficient to begin WP1. The route
activation gate is not passed.**

WP0A was captured on 2026-07-23 without changing production, Privy
configuration, code, branches, or deployment state. A subsequent explicitly
authorized local step added the sanitized Relay fixture corpus and its unit
tests. A later quote-only capture created six Relay request/log records using
non-owned fixture addresses. Finally, an explicitly authorized bounded
dedicated-burner rehearsal executed six tiny Relay routes across Polygon, Base,
and Solana. No Deposit Address mode, production/Privy configuration, branch,
commit, or deployment change occurred.

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
- The guarded runner is executable, defaults to preflight, requires exact live
  confirmation and fee/output bounds, uses Alchemy RPCs from local environment,
  persists only ignored raw reports, and has EVM/Solana negative mutation tests.
- Six wallet routes settled above their authorized minimums:
  Polygon POL → Base ETH, Polygon pUSD → Base USDC, partial Base USDC → Polygon
  pUSD, Polygon POL → Solana SOL, Polygon pUSD → Solana USDC, and partial Solana
  USDC → Polygon pUSD.
- All nine broadcasts succeeded; both remaining ERC-20 allowances are zero.
  Gross initial inputs were 3 POL and 1.5 pUSD, below the authorized 10 POL /
  3 pUSD limits.
- Deterministic clone baselines were captured.
- The four mandatory WP0 matrices/runbook exist with accountable owner roles
  and current rows.

## What still blocks activation, not WP1

The completed wallet rehearsal proves only bounded burner execution and owned
destination settlement at the captured amount bands. It does not prove:

- strict Relay Deposit Address under/overpayment, child correlation, wrong
  asset, timeout, or refund recovery;
- Polymarket/Limitless venue-visible collateral and readiness;
- Privy delegated policy/sponsorship execution;
- external-wallet setup, withdrawal, redemption, or ambiguous-timeout recovery.

Those scenarios remain off and must be implemented and rehearsed before their
individual activation. The 106 non-terminal legacy bridge rows at the WP0A
snapshot also require their existing reconcilers to remain; they do not block
WP1 domain/policy implementation, but they do block legacy reconciler removal.
No product route is activated by this evidence pack.

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
