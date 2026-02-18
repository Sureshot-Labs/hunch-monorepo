# Rewards Multiplier + Treasury Plan

Status: **pre-MVP single-mode architecture** (updated)

Owner scope:
- API rewards logic (`apps/api`)
- Finance scheduler runtime (`apps/finance-worker`)
- DB schema/migrations (`packages/db`)
- Ops env/compose wiring (`ops`)

---

## 1) Objective

Ship a rewards + treasury system that is financially coherent, auditable, and simple to operate in pre-MVP.

Locked decisions:
1. Use a **single liability mode**: `event_time_frozen`.
2. Eliminate `current_tier_aggregate` from runtime decision logic.
3. Compute liability at **fee write time** and persist immutable snapshots.
4. Compute claimability/reserve/sweep decisions with **micro-USDC integer math**.
5. Keep payout execution controlled (prepare/confirm automation allowed; full send remains explicit/manual policy).

---

## 2) Current Architecture (Code-Grounded)

### 2.1 Fee ingestion paths

- Polymarket fee collection:
  - `apps/api/src/collect-fees.ts`
  - writes `fee_events` with frozen snapshot fields
- Kalshi/DFlow fee ingestion:
  - `apps/api/src/routes/dflow-private.ts`
  - writes `fee_events` with frozen snapshot fields
- Solana pending reconciliation:
  - `apps/api/src/reconcile-fees.ts`

Shared snapshot resolver used by both writers:
- `apps/api/src/services/rewards-fee-snapshot.ts`

### 2.2 Volume/points ingestion paths

Writers use shared multiplier insert service:
- `apps/api/src/services/rewards-multiplier.ts`

Callers include:
- `apps/api/src/services/positions-sync.ts`
- `apps/api/src/routes/dflow-private.ts`
- `apps/api/src/admin-points.ts`
- `apps/api/src/routes/admin.ts`

### 2.3 User-facing rewards API

- Claim/summary/referrals/leaderboard routes:
  - `apps/api/src/routes/rewards.ts`
- Reward math/business logic:
  - `apps/api/src/services/rewards.ts`
- Rewards DB query layer:
  - `apps/api/src/repos/rewards.ts`

### 2.4 Payout + treasury ops

- Payout runner:
  - `apps/api/src/rewards-payout.ts`
- Treasury report math:
  - `apps/api/src/services/rewards-treasury.ts`
- Treasury sweep job/CLI:
  - `apps/api/src/rewards-treasury-sweep.ts`

### 2.5 Scheduled finance runtime

- Worker app:
  - `apps/finance-worker/src/main.ts`
- Job wrappers:
  - `apps/api/src/jobs/finance-jobs.ts`

Jobs:
- `fees_collect`
- `fees_reconcile`
- `treasury_sweep` (execute path enabled with on-chain transfer + pre/post checks)
- `payout_prepare`

Global execute hard gate:
- `HUNCH_FINANCE_EXECUTE`

---

## 3) Product + Accounting Model

### 3.1 Points model

For each `volume_events` row:
- `points_awarded = notional_usd * multiplier_applied`

Multiplier selection (max model, deterministic source):
- sources considered: global, referral-rule, tier-rule
- user override can hard-set multiplier
- source stored as `global|user|referral|tier`

Progression:
- tier progression is based on accumulated `points_awarded`

### 3.2 Liability model (single mode)

Liability source is always fee-event snapshot fields:
- `cashback_earned_usdc`
- `referral_earned_usdc`
- `liability_snapshot_source = 'event_time_frozen'`

There is no fallback/override accounting mode in runtime decisions.

### 3.3 Referral qualification (event-time)

At fee write time (`resolveFeeEventSnapshotAtWrite`):
- referral link must exist
- referred points at event >= observer threshold
- referrer points at event >= observer threshold
- qualified count for referrer evaluated at event time
- resulting referral bps frozen into the fee event snapshot

This avoids retroactive liability changes from future status flips.

### 3.4 Why two policy surfaces remain

- `rewards_policy` controls cashback/referral **liability rates**.
- `rewards_multiplier_policy` controls points **progression speed**.

They are intentionally separate so growth experiments on points multipliers do not implicitly change liability payout rates.

---

## 4) Monetary Precision Contract

Canonical unit for decision logic:
- **micro-USDC integer** (`1 USDC = 1_000_000 micros`)

Rules:
1. Parse incoming money as decimal strings.
2. Convert to micro-USDC at boundaries.
3. Decision comparisons and reserve formulas are integer-based.
4. DB checks enforce 6-decimal USDC scale for persisted snapshot/claim fields.
5. Output formatting can convert back to decimal string/number for API responses.

Claim ingress precision policy:
- rejects scale > 6 decimals
- rejects invalid/negative values

---

## 5) Treasury Formulas (Per Chain)

Definitions:
- `liabilityCollected`
  - sum of `cashback_earned_usdc + referral_earned_usdc` where `fee_events.status='collected'`
- `liabilityPending`
  - sum of `cashback_earned_usdc + referral_earned_usdc` where `fee_events.status='pending'`
- `claimedConfirmed`
  - sum of `reward_claims.amount_usdc` where status `confirmed`
- `claimedOpenNonFailed`
  - sum where status in `pending|submitted`
- `claimedNonFailed = claimedConfirmed + claimedOpenNonFailed`

Derived:
- `claimableNow = max(0, liabilityCollected - claimedNonFailed)`
- `outstandingCollectedPayable = max(0, liabilityCollected - claimedConfirmed)`
- `reserveBase = outstandingCollectedPayable + (includePending ? liabilityPending : 0)`
- `bufferApplied = max(bufferUsd, reserveBase * bufferPct)` (ceil at 6-dec)
- `reserveFloor = reserveBase + bufferApplied`
- `deficitNow = max(0, reserveFloor - controlledHotBalance)`
- `sweepableNow = deficitNow > 0 ? 0 : max(0, controlledHotBalance - reserveFloor)`
- `economicSurplus = max(0, controlledHotBalance + protocolReceivableBalance - reserveFloor)`

Invariant:
- `deficitNow > 0` implies `sweepableNow = 0`

---

## 6) DB Schema Plan (Squashed)

Because migrations are unapplied, we keep a single mutable migration:
- `packages/db/migrations/0073_rewards_points_awarded.sql`

This migration now contains all required schema work previously split across 0073..0078.

### 6.1 `volume_events`
Adds/backs/finalizes:
- `multiplier_applied`
- `points_awarded`
- `multiplier_source`
- trigger `set_volume_event_points_awarded`
- constraints and indexes for consistency/perf

### 6.2 Multiplier policy tables
Creates:
- `rewards_multiplier_policy`
- `rewards_multiplier_user_overrides`
- indexes + updated_at triggers

### 6.3 Treasury ledger tables
Creates:
- `reward_treasury_runs`
- (no per-sweep detail table in pre-MVP; keep runtime lean)

### 6.4 Claims scale hardening
Creates audit table:
- `reward_claims_scale_adjustments`

Normalizes existing claims to 6 decimals and enforces:
- nonnegative amount
- 6-decimal scale check

### 6.5 Frozen snapshot fields on `fee_events`
Adds/finalizes:
- `cashback_bps_applied`
- `referral_bps_applied`
- `cashback_earned_usdc`
- `referral_earned_usdc`
- `liability_snapshot_source`

Hardens:
- defaults to `event_time_frozen`
- backfills existing rows to fully populated frozen rows
- bps bounds and cap
- formula consistency checks
- earned <= fee cap
- snapshot immutability trigger

Note:
- Migration forces `liability_snapshot_source` constraint to only `event_time_frozen`.

---

## 7) Runtime/Env Contract (Simplified)

### 7.1 Removed envs
These are intentionally removed from model/config surface:
- `HUNCH_REWARDS_LIABILITY_MODE`
- `HUNCH_REWARDS_REQUIRE_FROZEN_SNAPSHOTS`
- `HUNCH_REWARDS_FROZEN_CUTOVER_AT`

### 7.2 Active rewards/treasury envs
Core:
- `HUNCH_REWARDS_TREASURY_BUFFER_USD`
- `HUNCH_REWARDS_TREASURY_BUFFER_PCT` (ratio [0,1])
- `HUNCH_REWARDS_TREASURY_INCLUDE_PENDING`
- `HUNCH_REWARDS_TREASURY_MIN_SWEEP_USD`

Payout credentials:
- `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY[_POLYGON|_BASE]`
- `HUNCH_REWARDS_SOLANA_SECRET_KEY`
- `HUNCH_REWARDS_USDC_ADDRESS_POLYGON`
- `HUNCH_REWARDS_USDC_ADDRESS_BASE`
- `HUNCH_REWARDS_TREASURY_COLD_ADDRESS_POLYGON`
- `HUNCH_REWARDS_TREASURY_COLD_ADDRESS_BASE`
- `HUNCH_REWARDS_TREASURY_COLD_ADDRESS_SOLANA`

### 7.3 Finance worker controls
Canonical namespace:
- `HUNCH_FINANCE_*`

Global execute gate:
- if `HUNCH_FINANCE_EXECUTE=false`, state-changing jobs run dry-run/read-only paths

---

## 8) Locking + Concurrency Contract

### 8.1 User-level locks
Use namespaced advisory locks for:
- claim creation
- multiplier write paths
- fee snapshot qualification updates

### 8.2 Chain-level locks
Use namespaced advisory locks for:
- payout flows
- treasury sweep flows

Purpose:
- avoid sweep/payout races per chain

---

## 9) API Behavior Contract

### 9.1 Summary/claimability
- Reads frozen snapshot amounts only.
- No aggregate fallback path.
- No fee reconciliation side effects in read endpoints.
- Fee reconciliation runs only via finance runtime and explicit jobs/CLI.

### 9.2 Claim creation
- chain normalized via schema transform (`137|8453|solana`)
- wallet-chain compatibility checks
- amount precision and bounds checks
- claim row inserted as `pending` only if <= claimable

### 9.3 Referrals view
- qualification updates still run in service path
- liability itself remains frozen on fee events and is not recomputed from mutable referral status

---

## 10) Finance Runtime Plan

### 10.1 `fees_collect`
- collects fee events and writes immutable snapshots
- read-only/dry-run supported for shadow validation

### 10.2 `fees_reconcile`
- resolves pending fee events against source of truth

### 10.3 `payout_prepare`
- confirm-only prep flow in scheduled runtime
- full payout send policy remains controlled by execute flags/ops process

### 10.4 `treasury_sweep`
- reporting path works
- execute path performs on-chain USDC transfer (hot signer -> cold treasury)
- execute path enforces pre/post token-balance checks and writes run status/errors to ledger

---

## 11) Acceptance Criteria

System is ready for pre-MVP when all pass:

1. Schema checks
   - `pnpm -C hunch-monorepo -F api run rewards:migration:preflight` passes
   - `0073_rewards_points_awarded.sql` applies cleanly on fresh DB
   - no residual references to removed 0074..0078 files
2. Writer invariants
   - new `fee_events` rows always contain frozen snapshot fields
   - immutable upsert policy prevents snapshot drift
3. Claims invariants
   - >6-dec claim amount rejected
   - claim cannot exceed per-chain claimable
4. Treasury invariants
   - reserve math never yields negative claimable/sweepable
   - deficit/sweep mutual exclusivity holds
5. Runtime invariants
   - `HUNCH_FINANCE_EXECUTE=false` forces safe non-mutating operation where expected
6. Validation suite
   - `pnpm -C hunch-monorepo -F api run typecheck`
   - `pnpm -C hunch-monorepo -F api run test:rewards`
   - `pnpm -C hunch-monorepo check`

---

## 12) Operational Runbook (Pre-MVP)

### 12.1 Before applying migration
1. Run migration preflight gate:
   - `pnpm -C hunch-monorepo -F api run rewards:migration:preflight`
2. Confirm target DB has not applied old rewards drafts:
   - no `0073..0078` rows in `schema_migrations`
3. Backup DB
4. Apply migrations

### 12.2 Post-migration verification
1. Validate constraints/triggers exist:
   - `volume_events` points trigger/constraints
   - `fee_events` snapshot constraints + immutability trigger
2. Run rewards test + type/lint checks
3. Run fee collection once in dev and confirm new rows are frozen

### 12.3 Deployment posture
- Keep `HUNCH_FINANCE_EXECUTE=true` in prod only when intended.
- Keep `HUNCH_FINANCE_SWEEP_EXECUTE=false` until cold addresses + signer keys are configured and validated.

---

## 13) Risks + Explicit Non-Goals

### 13.1 Known risks (accepted for now)
1. Treasury report uses on-chain hot balances, but protocol receivable remains placeholder (`0`) until dedicated wiring is added.
2. Sweep execute requires correct cold-address + signer env per chain; misconfig surfaces as skipped/failed actions.
3. Integration-test coverage for DB lock contention and migration gates is still lighter than full production-grade target.

### 13.2 Non-goals in this phase
1. Reintroducing aggregate comparator mode.
2. Historical liability replay from raw chain history.
3. Fully autonomous treasury transfer pipeline.

---

## 14) Implementation Delta vs Old Plan

What changed from older multi-mode plan:
- Removed dual accounting modes and cutover toggles.
- Collapsed migrations into one unapplied mutable migration.
- Enforced frozen snapshot model as the only liability source.
- Simplified env surface and operator decision tree.
- Kept finance-worker structure with execute gating (`HUNCH_FINANCE_EXECUTE` + per-job execute flags).

This is the intended pre-MVP architecture and should be treated as canonical until post-MVP hardening expands scope.

---

## 15) Implementation Status Matrix

| Area | Status | Notes |
|---|---|---|
| Single liability mode (`event_time_frozen`) | Done | Runtime aggregate mode removed from decision paths |
| Frozen snapshot writer on fee ingest | Done | Polymarket + DFlow writers use event-time snapshot resolver |
| Snapshot immutability + formula constraints | In migration | Enforced by squashed `0073` migration |
| Points multiplier persistence | Done | `multiplier_applied`, `points_awarded`, `multiplier_source` path implemented |
| Claim precision ingress (<= 6 decimals) | Done | Route validation + parser checks in place |
| Claimability math (micro-based) | Done | Frozen snapshot read path only |
| Treasury report formulas | Done (logic) | Uses on-chain hot balance where signer/token config exists |
| Treasury sweep execute | Done | On-chain transfer + pre/post balance checks + run-status ledger |
| Migration preflight gate | Done | `rewards:migration:preflight` enforces no prior 0073..0078 in `schema_migrations` |
| Finance worker scheduling | Done | Canonical `HUNCH_FINANCE_*` only |
| Deploy safety gate for rewards tests | Done | Backend deploy workflow includes rewards test step |
| Multi-file rewards migrations (0074..0078) | Removed | Scope squashed into unapplied `0073` |
