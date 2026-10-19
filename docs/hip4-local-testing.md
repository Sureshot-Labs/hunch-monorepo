# Local Hyperliquid testing

The local stand runs the ordinary API, finance-worker and Hyperliquid,
Polymarket and Limitless indexers. It preserves the existing `hip4_local`
database, login, admin, positions, policies and history. Market synchronization
refreshes the catalog; it does not reset the database or create a test allowlist.

## Prepare and refresh

From `hunch-monorepo`, with Docker running and dependencies already installed:

```bash
pnpm hip:prepare
pnpm hip:sync
```

`hip:prepare` inspects and starts only the existing
`hunch-hip4-local-pg16` and `hunch-hip4-local-redis` containers. It builds the full
backend and applies missing migrations only to loopback `55436/hip4_local`,
after saving a private PG16 dump under `untracked/`. It refuses a conflicting
migration history. Stop the API before schema preparation. No containers or
data volumes are deleted or replaced. This command restores the existing stand;
it does not provision a different machine or overwrite its credentials.

The private Receive key in `untracked/hip4-local.env` is preserved. Explicit
preparation creates it only if the file is absent; an existing broken or unsafe
file must be restored, never silently rotated. Check/start do not create keys.

`hip:sync` performs bounded provider reads and local catalog writes for all three
venues. It reports per-venue coverage; a successful command may still report a
partial catalog, which is not “all markets loaded.” Polymarket resumes its saved
checkpoint on the next run. Limitless reports a page cap or failed pages and can
be rerun. The normal indexers continue catalog discovery and live prices while
the backend is running. Runtime venue/resource policies still apply; no policy
is silently enabled or rewritten.

## Run

Keep two terminals open:

```bash
# Terminal 1 — from hunch-monorepo
pnpm dev:hip
```

```bash
# Terminal 2 — from Hunch_App
bun run dev:hip
```

Open <http://localhost:3000/>. Use the normal app, not `fixture=1`.

| Service       | Local address                            |
| ------------- | ---------------------------------------- |
| Frontend      | `http://localhost:3000`                  |
| API           | `http://127.0.0.1:4014`                  |
| PostgreSQL 16 | `127.0.0.1:55436`, database `hip4_local` |
| Redis         | `127.0.0.1:55437`                        |

`Ctrl+C` in each terminal stops its own app processes. Backend shutdown includes
all three indexers and the worker, including indexers that retain timers after
SIGTERM. Database/Redis containers and saved data remain available. An occupied
API/frontend port is not fixed by killing another process or choosing a random
port. Stop the earlier command yourself, then restart.

After changing backend code or updating the branch, stop the app processes and
rerun `hip:prepare`; `dev:hip` uses the compiled backend. Ordinary restarts do not
need another build or synchronization. The frontend uses real Node, prefers an
installed compatible Node 20, and preserves normal Next/Privy `.env` settings.
`HUNCH_HIP_NODE_BINARY` can select another compatible real Node executable.

Read-only diagnostics:

```bash
# Backend
pnpm hip:status
# Frontend
bun run dev:hip --check
```

Missing provider keys are reported by name, never by value. Backend credentials
come from the existing root `.env` allowlist. Ambient/root `.env` database URLs,
production secrets bootstrap and autonomous execution flags cannot retarget this
stand. If the local pnpm shim tries to download another version, the equivalent
commands are `node ops/hip4-local-stack.mjs prepare|sync|start|status` (choose one).
No dependency installation runs automatically.

For manual Polymarket setup, the API receives
`POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_API_SECRET` and
`POLYMARKET_BUILDER_API_PASSPHRASE` from the backend `.env`. These service
credentials are not forwarded to indexers or the finance-worker. The ordinary
funding path also receives `POLYMARKET_FUNDING_ROUTER_ADDRESS`; its existing
canonical-address validation remains in force. Delegated Privy signing and
relayer private keys are not enabled by the launcher.

`hip:status` and startup output report missing relayer/router configuration
separately from healthy API/schema checks. Missing settings do not disable
read-only markets or unrelated venues. Configuration presence is not proof of
wallet readiness: the normal app still checks the owned funder, policy,
approvals and user-provided authorization. No venue credentials or wallet
permissions are created by a status check.

After changing launcher settings, stop the backend terminal with `Ctrl+C`, run
`pnpm dev:hip` again, then refresh the app. No database reset, migration, catalog
sync or repeat deposit is needed for this configuration-only change. Do not
blindly create a different funder to recover a missing balance; use the existing
account's verified wallet and ordinary setup/recovery flow.

### Repeated Hyperliquid quote requests

Quotes, destination checks and background indexing share the same rolling
provider budget. `hip4_quote_rate_limited` means this read budget is exhausted,
not that the account has no funds. Retry the ordinary quote after capacity
recovers; do not repeat a deposit, alter wallet permissions or raise the budget
to hide the cause. Server diagnostics record a fixed failure reason without
provider URLs, addresses or signatures.

`hip4_read.quotePreviewCacheEntries` bounds reuse of successful preview-only
account/fee facts (default 64 total entries; zero disables reuse). BUY USDC
capacity can be shared across the owner's market/YES-NO previews; fee facts
remain bound to their market and economic generation, and SELL inventory stays
exact-token scoped. Successful independent facts survive another read's failure.
Original observation
deadlines and current policies still apply. Books and request-bound amounts
are recalculated on every market quote. An updated stored account observation,
including a successful post-funding refresh, invalidates the old preview facts.
Preparation and submission never consume this preview cache. A quote retry can
reuse fresh exact-destination spendability; unknown/expired evidence and the
post-funding continuation still require an authoritative destination refresh.
Fees and cash share one fresh `spotMeta` read within each individual
quote/preparation/submission bundle, not across strict financial calls. The
600-weight limit is unchanged: fresh default-mode preparation and submission
still cost 202 weight each, so prior background/account work can require ordinary
rolling-window recovery. Preview reuse does not promise every immediate sequence
will fit; it must never bypass fresh financial admission to do so.

### Reviewing first-transfer costs

The compact `funding_control_plane` policy accepts optional `fees` overrides:
`maximumFeeUsd`, `maximumFeeBps`, and `maximumReviewedFeeBps`. Omitted values
preserve the backend defaults: a hard $10 fee cap, an automatic 2,000 bps cap,
and no reviewed exception. `maximumReviewedFeeBps: null` disables the exception.
The admin Funding policy editor exposes these settings; do not raise provider
budgets or change wallet permissions to work around an economic rejection.

An enabled reviewed cap only admits an interactive trade-shortfall quote above
the automatic percentage cap. It forces the existing explicit Funding review
with every source debit, fees, and minimum destination amount. The user's
`maxFeeUsd`, hard USD cap, source balance, slippage and exact destination checks
still apply. Server execution profiles, capacity previews and unattended
funding cannot use this exception. Consent remains bound to the exact quote,
plan and policy revision; changed or expired economics require a new review.

Quotes inspected on 2026-10-18 for a previously unactivated HyperCore recipient
required approximately 4.229318 Polygon pUSD for 3.008363 expected USDC, with
2.978580 minimum USDC. The conservative fee estimate was about $1.225, exceeding
the unchanged 20% automatic cap. An already active recipient had a much smaller
quoted cost. These are observations, not fixed fees or completed transfers:
always inspect the current route. Relay fees already included in the input
must not be added to the source debit again; separately denominated source gas
is disclosed separately.

## Test in order

1. Check each venue in the normal feed. Open an active market and verify fresh
   quotes, chart and trades. Missing history is not zero volume. The full catalog
   and hot price subset are different: a cold market may need an ordinary demand
   refresh before a quote becomes executable.
2. Check the connected account's real HyperCore cash, positions and executions.
   Native trading requires the supported Standard account mode, owned controller
   and fresh verified cash; readable balances alone do not prove spendability.
3. Perform a deliberately small direct BUY, then SELL/cancel using the normal
   ticket. Check actual fills/fees, Portfolio and History. The BUY floor is $1
   before fees, subject to whole-share rounding; publication needs $10 of
   confirmed gross BUY notional.
4. For shortfall, keep destination trading cash below the reviewed requirement
   and select an advertised source with sufficient funds, fees and gas. Test
   Base USDC, Polygon USDC and pUSD → HyperCore, then an advertised exit route.
   Verify the exact destination asset/amount and one linked BUY. Direct
   Solana ↔ HyperCore is not an implemented route.
5. Exercise rejection before signing, Back/Close, reload/timeout and Check after
   submission. An unknown result stays recoverable; Check must not silently pay
   again or submit a second BUY. Then test qualifying publication and Copy from
   a second account, including self-Copy rejection and unique copier counts.

Only the user signs and submits financial actions. The finance-worker can
reconcile and advance already user-authorized funding operations; global
autonomous execution remains off. Telegram automation, AI research, fee
collection, payouts, sweeps and production changes are not started. Unsupported
or unknown native exit fees remain a route-level refusal, not a deduction hidden
from the reviewed amount.
