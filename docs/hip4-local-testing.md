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
