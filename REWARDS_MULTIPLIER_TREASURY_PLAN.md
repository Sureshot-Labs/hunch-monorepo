# Rewards + Fees + Treasury System Plan (KISS, Code-Grounded)

## Objective

- Make rewards points work exactly as product intent (`$1` volume -> points via effective multiplier policy).
- Keep progression based on `points_awarded` (multiplied points), not raw volume.
- Keep claimability math correct and auditable across chains.
- Define what is claim liability vs what is treasury-owned capital.
- Add safe automation to move platform-owned capital from hot wallets to cold treasury wallets.
- Normalize env naming and wallet ownership mapping to reduce operational mistakes.

## Current System Map (Validated)

### A) Fee collection by venue

| Venue                       | Where fee is produced                                                                                      | Who writes `fee_events`                                                          | Chain in DB | Status lifecycle                   | Main env                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Polymarket                  | On-chain `collectFee` call on fee collector contract                                                       | `apps/api/src/collect-fees.ts` (and prod `fee-collector` service loop)           | `137`       | `collected` only (on confirmed tx) | `HUNCH_FEE_COLLECTOR_ADDRESS`, `HUNCH_FEE_COLLECTOR_PRIVATE_KEY`, `HUNCH_FEE_BPS_POLYMARKET`  |
| Kalshi (via DFlow)          | Execution callback ingestion (mounted under `/trade/kalshi` and `/trade/dflow`) + signature reconciliation | `apps/api/src/routes/dflow-private.ts`, `apps/api/src/services/fee-reconcile.ts` | `solana`    | `pending -> collected/failed`      | `HUNCH_FEE_BPS_KALSHI`, `HUNCH_FEE_SCALE_KALSHI`, `DFLOW_USDC_FEE_ACCOUNT`, `DFLOW_USDC_MINT` |
| Limitless                   | No rewards fee ingestion path today                                                                        | N/A                                                                              | N/A         | N/A                                | N/A                                                                                           |
| Bridge (deBridge affiliate) | Configured separately for swap affiliate routing                                                           | `apps/api/src/routes/bridge.ts` (config), not in `fee_events` pipeline           | mixed       | N/A                                | `DEBRIDGE_*`                                                                                  |

### B) Rewards claim creation and payout

| Step                  | Component                          | Notes                                                                                                   |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Claim requested       | `apps/api/src/routes/rewards.ts`   | Validates linked wallet and chain-wallet type compatibility. Inserts `reward_claims(status='pending')`. |
| Claimability computed | `apps/api/src/services/rewards.ts` | `claimable = max(0, collected_liability - claimed_non_failed)` per chain.                               |
| Payout execution      | `apps/api/src/rewards-payout.ts`   | Confirms submitted txs, reserves pending claims, sends token transfer, finalizes `confirmed/failed`.    |
| Payout scheduler      | Not in prod compose                | Currently manual/ops-driven (`remote-exec.sh rewards:payout`), unlike fee collector loop.               |

### C) Wallet custody reality today

- Polymarket fee collector signer key (`HUNCH_FEE_COLLECTOR_PRIVATE_KEY`) is an operator key for tx submission; collected USDC is transferred to contract `treasury` address.
- Reward payouts use payout keys:
  - EVM (Polygon + Base): single key `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY`.
  - Solana: `HUNCH_REWARDS_SOLANA_SECRET_KEY`.
- This means fee custody wallet and payout wallet may differ and must be modeled explicitly.

### D) Points/tier/rewards behavior today (as-is)

- `volume_events` stores only `notional_usd` (no multiplier columns yet).
- User points are currently `sum(volume_events.notional_usd)`.
- Tier progression is currently based on those points.
- Cashback liability uses current tier bps (and referral bonus bps) applied to aggregated fee totals.
- Result: historical fee liability can move when user tier changes (retroactive effect by current design).

## Points Model (Updated Product Decision / Target)

### Required behavior

- Each `volume_event` must carry the multiplier used at that event time.
- `points_awarded = notional_usd * effective_multiplier`.
- Progression/tier is based on `sum(points_awarded)` (current product intent).
- Multipliers apply forward-only (new events), not historical rewrite.

### Multiplier control model

- Effective multiplier is resolved per event with deterministic logic:
  1. if active per-user override exists, use it (hard override),
  2. otherwise use the maximum of:
     - global default multiplier,
     - matched referral multiplier,
     - matched tier multiplier.
- No multiplicative stacking between referral/tier/global in default policy mode.
- The selected multiplier and source must be persisted on the event for auditability.
- Source labeling for `max(...)` path:
  - if max came from referral rule -> `multiplier_source='referral'`,
  - if max came from tier rule -> `multiplier_source='tier'`,
  - if all matched values are equal to global default -> `multiplier_source='global'`.
- Deterministic tie-breaker for equal non-global values: `referral` > `tier` > `global`.
- If tier-derived multiplier is enabled, evaluate multiplier from the pre-event tier snapshot (before adding the event) to avoid circular ambiguity.

### Why this matters for treasury math

- Cashback bps comes from tier.
- Tier comes from points.
- Points come from multiplied events.
- Therefore multiplier policy changes alter future tier migration speed and future liabilities, so reserve analytics must include this dynamic.

## Financial Model (Liability vs Platform-Owned)

### Current model note (as-is)

- Liability computation today is based on current tier + aggregated fees, not fee-event-time frozen tier/bps snapshots.
- MVP decision: do not keep temporary compatibility mode as default.
- Target/default implementation is `event_time_frozen`; keep `current_tier_aggregate` only as optional diagnostic comparator.

### Authoritative event-time data model (required for `event_time_frozen`)

- Extend `fee_events` with per-event liability snapshot fields:
  - `cashback_bps_applied`,
  - `referral_bps_applied`,
  - `cashback_earned_usdc`,
  - `referral_earned_usdc`,
  - `liability_snapshot_source` (`event_time_frozen|bootstrap_aggregate`).
- Snapshot write rule:
  - on fee-event creation, resolve tier/referral bps at write-time and persist both bps + earned amounts on that row,
  - on status transitions (`pending -> collected|failed`), keep snapshot values immutable.
- `event_time_frozen` decision mode uses only rows where `liability_snapshot_source='event_time_frozen'`.
- `bootstrap_aggregate` rows are diagnostic-only (comparator/backfill visibility), never used for claim/reserve decisions.

### Target per-chain definitions (post Phase 1)

- `grossCollectedFees = sum(fee_events.fee_usd where status='collected')`
- `userProgressPoints = sum(volume_events.points_awarded)` (or equivalent derived value)
- `liabilitySnapshotSource = 'event_time_frozen'` (authoritative set for liability decisions)
- `liabilityCollected = sum(coalesce(fee_events.cashback_earned_usdc, 0) + coalesce(fee_events.referral_earned_usdc, 0) where status='collected' and liability_snapshot_source=liabilitySnapshotSource)`
- `liabilityPending = sum(coalesce(fee_events.cashback_earned_usdc, 0) + coalesce(fee_events.referral_earned_usdc, 0) where status='pending' and liability_snapshot_source=liabilitySnapshotSource)`
- `liabilityCollectedComparator = cashbackCollected + referralCollected` using `current_tier_aggregate` over `fee_events.fee_usd` (debug only; never decision logic)
- `claimedConfirmed = sum(reward_claims.amount_usdc where status='confirmed')`
- `claimedOpenNonFailed = sum(reward_claims.amount_usdc where status in ('pending','submitted'))`
- `claimedNonFailed = claimedConfirmed + claimedOpenNonFailed`
- `claimableNow = max(0, liabilityCollected - claimedNonFailed)` (claim issuance gate)
- `outstandingCollectedPayable = max(0, liabilityCollected - claimedConfirmed)` (economic amount still owed, including open claims)
- `includePending = HUNCH_REWARDS_TREASURY_INCLUDE_PENDING`
- `reserveFloor = outstandingCollectedPayable + (includePending ? liabilityPending : 0) + safetyBuffer`
- `controlledHotBalance = on-chain USDC balance in wallet/key that actually signs payouts`
- `protocolReceivableBalance = fee balances economically owned but not directly controlled by payout signer`
- `deficitNow = max(0, reserveFloor - controlledHotBalance)`
- `economicSurplus = max(0, controlledHotBalance + protocolReceivableBalance - reserveFloor)`
- `sweepableNow = max(0, controlledHotBalance - reserveFloor)`

### Interpretation

- Theoretical claimable now: `claimableNow`.
- Potentially movable to cold treasury now: `sweepableNow`.
- Claimability and reserve are intentionally separate:
  - `claimableNow` blocks duplicate claim creation,
  - `reserveFloor` protects payout solvency and does not double-count already confirmed payouts.
- Payout safety is based on `controlledHotBalance` only.
- `protocolReceivableBalance` improves economic position but does not make payouts liquid.
- If `controlledHotBalance < reserveFloor`, sweeping must be blocked and deficit alert raised.
- Because progression is points-based, multiplier policy affects liabilities indirectly via tier acceleration.

### Financial invariants (must hold)

- Claim status sets:
  - `confirmed` -> paid and final; included in `claimedConfirmed`.
  - `pending|submitted` -> open claims; included in `claimedOpenNonFailed`.
  - `failed` -> excluded from payable and claim gate math.
- Invariant formulas:
  - when `liability_mode='event_time_frozen'`, `liabilityCollected` and `liabilityPending` are computed only from `fee_events` rows with `liability_snapshot_source='event_time_frozen'`.
  - when `liability_mode='event_time_frozen'`, `current_tier_aggregate` outputs are comparator-only and cannot drive claim/sweep/payout decisions.
  - exceptional override mode (`liability_mode='current_tier_aggregate'`) is temporary, explicitly approved, and time-boxed.
  - `claimedNonFailed = claimedConfirmed + claimedOpenNonFailed`
  - `claimableNow = max(0, liabilityCollected - claimedNonFailed)`
  - `outstandingCollectedPayable = max(0, liabilityCollected - claimedConfirmed)`
  - `reserveBase = outstandingCollectedPayable + (includePending ? liabilityPending : 0)`
  - `safetyBufferRaw = max(bufferUsd, reserveBase * bufferPct)`
  - `safetyBuffer = quantizeUpMicroUsdc(safetyBufferRaw)` (round up to protect solvency)
  - `reserveFloor = reserveBase + safetyBuffer`
  - `sweepableNow = max(0, controlledHotBalance - reserveFloor)`
- Consistency invariant: `sweepableNow > 0` implies `deficitNow = 0`; `deficitNow > 0` implies `sweepableNow = 0`.

## Inconsistencies and Risks Found

### 1) Env naming/ownership ambiguity

- Existing names are mixed in granularity:
  - Good: `HUNCH_REWARDS_USDC_ADDRESS_POLYGON`, `HUNCH_REWARDS_USDC_ADDRESS_BASE`.
  - Less clear: single `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY` for both EVM chains.
  - Less clear: Solana payout key name differs from EVM naming (`HUNCH_REWARDS_SOLANA_SECRET_KEY`).
  - Solana rewards token mint is implicitly `DFLOW_USDC_MINT` instead of rewards-specific key.

### 2) Operational asymmetry

- Fee collection is scheduled in prod compose (`fee-collector` loop).
- Rewards payout is not scheduled in compose; it is manual/ops-run.
- No automated hot->cold sweep mechanism exists.
- Fee custody and payout custody can differ by chain, requiring split liquidity accounting.
- Finance runtime is shell/cron-oriented today, which is harder to audit and harder to make idempotent across all finance operations.

### 3) Scope mismatch across fee systems

- Rewards liability uses `fee_events` (Polymarket + DFlow/Kalshi).
- Bridge affiliate fees are configured separately and not part of rewards liability flow.
- This is acceptable if intentional, but must be explicit in docs and treasury accounting.

### 4) Input hardening gap

- `rewardsClaimBodySchema.chainId` is a free string, while runtime supports a limited set.
- This can cause operator/user confusion and makes validation less strict than needed.

### 5) Secrets hygiene risk

- `ops/.env.prod.local` currently contains non-empty private-key-like values.
- `hunch-monorepo/.gitignore` excludes `.env.*.local`, so this is operational exposure risk rather than a committed-template-by-default risk.
- Treat this file as sensitive, verify key rotation policy, and avoid copying live secrets into tracked docs/templates.

### 6) Progression reflexivity is intentional now

- With progression on multiplied points, higher multipliers can accelerate tier upgrades.
- This is now a product feature, not a bug, but requires liability monitoring and guardrails.

### 7) Referral qualification staleness risk (current code path)

- Referral bonus calculations rely on `referrals.status='qualified'`.
- Qualification updates are currently triggered per referrer in rewards-read paths (`markQualifiedReferralsForUser`), not as a global background process.
- Impact: user-level summary is usually corrected when user opens rewards, but platform-wide treasury liability can be understated if qualification status is stale for inactive referrers.

### 8) Monetary precision risk for payouts (critical)

- Reward monetary values are currently computed in JS number math and can carry more than 6 decimal places.
- Payout execution converts `reward_claims.amount_usdc` via `ethers.parseUnits(value, 6)`, which rejects values with more than 6 decimals.
- Impact: mathematically valid claims can fail in payout execution purely due precision/scale mismatch.
- Required rule: all monetary amounts persisted/paid in USDC path must be normalized to 6 decimals (deterministic rounding policy, recommended `floor` for safety).

### 9) Sweep vs payout execution/confirmation race

- Sweep and payout execution both consume controlled hot balance and can run close in time.
- Impact: without shared chain-level lock discipline, sweep can over-transfer while payout is reserving/sending claims.
- Mitigation: shared chain-level advisory lock strategy across payout/sweep flows, plus reserve buffer guardrails (`HUNCH_REWARDS_TREASURY_BUFFER_*`).

### 10) Pre-event tier snapshot needs concurrency control

- Multiplier resolution depends on a pre-event tier snapshot.
- With multiple concurrent writers (`positions-sync`, `dflow-private`, admin/manual volume paths), per-user event ordering can become nondeterministic without serialization.
- Mitigation: resolve multiplier + insert volume event in one transaction under per-user advisory lock (or equivalent single-writer guarantee).

## Env Consistency Plan (Backward Compatible)

### Keep existing envs working, add canonical names

| Domain                 | Current                            | Canonical (new)                                  | Action                                                   |
| ---------------------- | ---------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| EVM payout key         | `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY` | `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_EVM`           | Add canonical; fallback to current.                      |
| Solana payout key      | `HUNCH_REWARDS_SOLANA_SECRET_KEY`  | `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_SOLANA`        | Add canonical; fallback to current.                      |
| Solana rewards mint    | `DFLOW_USDC_MINT` (implicit)       | `HUNCH_REWARDS_USDC_MINT_SOLANA`                 | Add rewards-specific key; fallback to `DFLOW_USDC_MINT`. |
| Payout source addr map | implicit from private key          | `HUNCH_REWARDS_HOT_ADDRESS_POLYGON/BASE/SOLANA`  | Optional explicit sanity checks/logging.                 |
| Cold destination       | none                               | `HUNCH_REWARDS_COLD_ADDRESS_POLYGON/BASE/SOLANA` | Required for sweep execution.                            |
| Sweep controls         | none                               | `HUNCH_REWARDS_SWEEP_*`                          | Add feature flag + thresholds.                           |

### Key resolution precedence (required)

- Per-chain signer selection precedence:
  1. chain-specific hot key (`HUNCH_REWARDS_HOT_PRIVATE_KEY_<CHAIN>` / `HUNCH_REWARDS_HOT_SECRET_KEY_SOLANA`) when set,
  2. canonical payout key fallback (`HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_EVM` or `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_SOLANA`),
  3. legacy fallback (`HUNCH_REWARDS_PAYOUT_PRIVATE_KEY` / `HUNCH_REWARDS_SOLANA_SECRET_KEY`) during migration only.
- Conflict handling:
  - if multiple key sources are set and resolve to different signer addresses for the same chain, fail fast at startup,
  - require explicit resolved hot address match when `HUNCH_REWARDS_HOT_ADDRESS_<CHAIN>` is provided.
- Execution scope:
  - `treasury_sweep` and payout use the same resolved per-chain signer source unless explicitly separated in a later phase.

### Proposed sweep envs

- `HUNCH_REWARDS_LIABILITY_MODE=event_time_frozen`
- `HUNCH_REWARDS_REQUIRE_FROZEN_SNAPSHOTS=false` (set `true` before enabling `event_time_frozen` decisions)
- `HUNCH_REWARDS_FROZEN_CUTOVER_AT=` (UTC timestamp; required when `HUNCH_REWARDS_REQUIRE_FROZEN_SNAPSHOTS=true`)
- `HUNCH_REWARDS_SWEEP_ENABLED=false`
- `HUNCH_REWARDS_SWEEP_MIN_USD=100`
- `HUNCH_REWARDS_SWEEP_MAX_USD_PER_RUN=10000`
- `HUNCH_REWARDS_TREASURY_BUFFER_USD=0`
- `HUNCH_REWARDS_TREASURY_BUFFER_PCT=0`
- `HUNCH_REWARDS_TREASURY_INCLUDE_PENDING=true`
- `HUNCH_REWARDS_COLD_ADDRESS_POLYGON=`
- `HUNCH_REWARDS_COLD_ADDRESS_BASE=`
- `HUNCH_REWARDS_COLD_ADDRESS_SOLANA=`
- Optional dedicated source keys:
  - `HUNCH_REWARDS_HOT_PRIVATE_KEY_POLYGON=`
  - `HUNCH_REWARDS_HOT_PRIVATE_KEY_BASE=`
  - `HUNCH_REWARDS_HOT_SECRET_KEY_SOLANA=`
- Safety buffer computation (exact):
  - `reserveBase = outstandingCollectedPayable + (HUNCH_REWARDS_TREASURY_INCLUDE_PENDING ? liabilityPending : 0)`
  - `HUNCH_REWARDS_TREASURY_BUFFER_PCT` is a ratio in `[0,1]` (example: `0.05` means 5%).
  - `safetyBufferRaw = max(HUNCH_REWARDS_TREASURY_BUFFER_USD, reserveBase * HUNCH_REWARDS_TREASURY_BUFFER_PCT)`
  - `safetyBuffer = ceil_to_6_decimals(safetyBufferRaw)`

### Finance-worker runtime envs (new, backward-compatible)

- `HUNCH_FINANCE_WORKER_ENABLED=false`
- `HUNCH_FINANCE_EXECUTE=false` (hard gate for state-changing actions; keep false in local dev)
- `HUNCH_FINANCE_COLLECT_ENABLED=false`
- `HUNCH_FINANCE_COLLECT_INTERVAL_SEC=600`
- `HUNCH_FINANCE_RECONCILE_ENABLED=true`
- `HUNCH_FINANCE_RECONCILE_INTERVAL_SEC=1800`
- `HUNCH_FINANCE_SWEEP_ENABLED=false`
- `HUNCH_FINANCE_SWEEP_INTERVAL_SEC=3600`
- `HUNCH_FINANCE_PAYOUT_PREPARE_ENABLED=false`
- `HUNCH_FINANCE_PAYOUT_PREPARE_INTERVAL_SEC=3600`
- `HUNCH_FINANCE_JOB_TIMEOUT_SEC=300`
- `HUNCH_FINANCE_MAX_RETRIES=1`
- `HUNCH_FINANCE_RETRY_BACKOFF_SEC=5`
- `HUNCH_FINANCE_JITTER_SEC=30`

## Finance Runtime Model (v1, KISS)

- Add dedicated service `apps/finance-worker` and make it the canonical runtime for finance automation.
- Keep a fixed in-code job set (no DB job registry in v1):
  - `fees_collect`
  - `fees_reconcile`
  - `treasury_sweep`
  - `payout_prepare`
- Schedule each job by env interval and enabled flag.
- Use per-job, per-chain lock discipline (advisory lock preferred) and idempotent run keys.
- Keep AI/data jobs on their current cron/ai-worker paths; finance-worker is finance-only.
- Do not auto-execute payout sends in v1:
  - `payout_prepare` can be scheduled,
  - `payout_execute` remains explicit/manual approval path.
- Continue to support existing scripts/commands; finance-worker calls the same core services.

### Local dev behavior (`pnpm dev`)

- `pnpm dev` at monorepo root runs `turbo run dev --parallel`, so any workspace under `apps/*` with a `dev` script will start automatically.
- Therefore, once `apps/finance-worker` is added with a `dev` script, it will run in local dev by default.
- Required safety defaults for local/dev:
  - `HUNCH_FINANCE_WORKER_ENABLED=false` by default (worker boots in idle/no-op mode),
  - `HUNCH_FINANCE_EXECUTE=false` by default (state-changing jobs blocked),
  - `HUNCH_FINANCE_SWEEP_ENABLED=false` and `HUNCH_FINANCE_PAYOUT_PREPARE_ENABLED=false` unless explicitly enabled.
- Production enablement must require explicit env flip + deploy review; never rely on defaults drifting between environments.

## Monetary Precision Contract (USDC)

- Canonical payout precision is 6 decimals for all chains.
- Canonical decision type is `micro_usdc` integer for all claim/liability/sweep comparisons.
- DB/API representation may remain `numeric(20,6)`/decimal strings, but decision logic must convert to `micro_usdc` first.
- Claim lifecycle amounts (`claimableNow`, requested claim amount, stored `reward_claims.amount_usdc`, payout transfer amount) must be normalized to the same 6-decimal scale.
- Rounding policy for user-claimable amounts in v1: `floor` to 6 decimals.
- Rounding policy for solvency buffers in v1: `ceil` to 6 decimals.
- Reject sub-micro amounts after normalization (`<= 0.000000`).
- Keep high-precision internal diagnostics only in admin/debug outputs, never as direct payout inputs.
- No JS binary float is allowed for decision logic (claim gating, reserve checks, sweep eligibility, payout amount checks).
- API ingress contract for monetary inputs (required):
  - external monetary fields are accepted as decimal strings (not JS numbers),
  - convert to canonical `micro_usdc` integer at route boundary before any decision arithmetic,
  - reject invalid scale (>6 decimals) at schema boundary,
  - avoid `z.coerce.number` for monetary claim/treasury decision inputs.

## Chain ID Allowlist + Normalization Policy

- Allowed chain IDs for claims/payouts in v1: `137`, `8453`, `solana`.
- Input aliases normalize before validation:
  - `polygon -> 137`
  - `base -> 8453`
  - `sol -> solana`
- Enforcement pipeline (required): `raw input -> alias normalization -> canonical enum validation -> persist canonical`.
- Reject unknown chain IDs at schema/runtime boundary after normalization.
- Persist canonical normalized value only.

## Finance Scheduling, Observability, and Runbooks (v1)

- Scheduling spec:
  - fixed interval per job from env,
  - jitter to avoid synchronized bursts,
  - bounded retries/backoff,
  - per-job timeout with explicit failure status.
- Locking spec:
  - chain-level advisory lock for `treasury_sweep`, `payout_prepare`, and payout execution.
  - per-user advisory lock for multiplier resolution event writes.
  - claim-create claimability checks stay on per-user lock (no chain-wide lock in that path).
  - canonical lock key namespaces:
    - `lock:rewards:chain:<chainId>` for treasury/payout critical sections,
    - `lock:rewards:user:<userId>` for multiplier + volume-event critical sections.
  - all lock keys are hashed with stable namespace prefix before advisory lock calls to prevent cross-feature collisions.
- Metrics/logs:
  - run status, duration, blocked reason, sweep attempted/executed amount, reserve coverage ratio, deficit amount, payout queue depth.
- Alerts:
  - persistent deficit (`deficitNow > 0` for >= 3 consecutive runs or >= 15 minutes),
  - reserve coverage deterioration (`coverageRatio = controlledHotBalance / reserveFloor`; warn `< 1.05`, critical `< 1.00`),
  - repeated sweep blocks/failures (>= 3 consecutive blocked/failed sweep runs per chain),
  - payout precision/validation failures.
- Runbooks:
  - deficit top-up,
  - RPC outage fallback,
  - blocked sweep diagnosis,
  - manual payout execution path.

## Implementation Plan

### Phase 0: Safety blockers (before full rollout)

1. Chain allowlist + normalization in claims path (`137|8453|solana` + aliases) using strict pipeline:
   - `raw -> normalize alias -> validate canonical enum -> persist canonical`.
2. USDC precision normalization at claim create + payout preflight guard with canonical `micro_usdc` decision arithmetic (no JS float decision path).
3. Add true read-only mode for collect-fees shadow runs (`--dry-run` today is not no-write).
4. Migration safety protocol for `0073` (single migration path, pre-MVP scale):
   - use one executable migration (`0073_rewards_points_awarded.sql`) with additive columns, trigger, full backfill, null-gate check, constraints, and indexes.
   - keep a preflight guard before deploy:
     - verify `volume_events` exact row count <= `100000`,
     - verify `pg_total_relation_size('volume_events')` <= `268435456` bytes (256 MiB),
     - verify rollback window and recent backup/snapshot availability.
   - if any preflight gate fails, pause and split back to staged runbook before rollout.
5. Enforce DB-level USDC scale on `reward_claims.amount_usdc` (6 decimals):
   - run preflight delta report (`affected_rows`, `total_delta_usdc`, top impacted claims) and approve,
   - persist adjustment audit rows during normalization,
   - normalize historical rows to 6-decimals first,
   - then apply constraint/type enforcement so non-API paths cannot store invalid precision.
6. Migration safety protocol for `0077` (single migration path, pre-MVP scale):
   - use one executable migration (`0077_fee_events_frozen_liability_snapshot.sql`) with additive columns, bootstrap update, null-gate checks, constraints, and index creation.
   - keep preflight guard:
     - verify `fee_events` exact row count <= `100000`,
     - verify `pg_total_relation_size('fee_events')` <= `268435456` bytes (256 MiB),
     - validate no unexpected long-running writes on `fee_events` during rollout window.
7. Frozen-liability cutover guard (required before `HUNCH_REWARDS_LIABILITY_MODE=event_time_frozen`):
   - deploy writer changes that emit full frozen snapshot fields first,
   - verify fee writer `ON CONFLICT` clauses no longer update frozen economic fields,
   - set `HUNCH_REWARDS_REQUIRE_FROZEN_SNAPSHOTS=true`,
   - set `HUNCH_REWARDS_FROZEN_CUTOVER_AT=<UTC timestamp>`,
   - run cutover migration artifact `0078_fee_events_frozen_cutover_default.sql`,
   - block mode switch if query returns non-zero:
     - `count(*) from fee_events where created_at >= HUNCH_REWARDS_FROZEN_CUTOVER_AT and liability_snapshot_source <> 'event_time_frozen'`.
   - explicit ownership + checklist gate:
     - owner A (backend): signs off writer rollout in `collect-fees` and DFlow paths,
     - owner B (ops): signs off 0078 migration applied + cutover query is zero,
     - rollout ticket must include both approvals before enabling `event_time_frozen`.
8. Test harness enforceability before rollout:
   - add `test:rewards` script in `apps/api/package.json`,
   - wire root CI gate to execute `pnpm -C hunch-monorepo -F api run test:rewards`,
   - block rollout until this gate is green.

### Phase 1: Event-level multipliers + progression on points

1. Extend `volume_events` to persist:
   - `multiplier_applied`,
   - `points_awarded`,
   - `multiplier_source` (`global|user|referral|tier`).
2. Introduce multiplier config primitives:
   - global default multiplier,
   - per-user override multiplier,
   - rule slots for referral-based and tier-based multiplier.
3. Resolve multiplier at event write-time using precedence:
   - user override else `max(global, referral, tier)`.
4. Store resolved values on each new event (forward-only).
5. Switch progression points to `sum(points_awarded)`.
6. Keep API exposing both:
   - `clout.points` (progression points),
   - `clout.volumeUsd` (raw volume).
7. Keep liability decision formulas in `event_time_frozen` mode:
   - cashback/referral liability reads per-event snapshot amounts from `fee_events`,
   - tier/progression affects future liability only via snapshot values written on new fee events.
8. Update all `volume_events` writers to set multiplier fields consistently:
   - `apps/api/src/services/positions-sync.ts`
   - `apps/api/src/routes/dflow-private.ts`
   - `apps/api/src/routes/admin.ts`
   - `apps/api/src/admin-points.ts`
9. Update all points consumers from `sum(notional_usd)` to `sum(points_awarded)` where intended:
   - rewards summary,
   - referrals views,
   - leaderboard `points` metric,
   - admin points/volume reporting endpoints,
   - admin/ops points utilities that currently equate volume to points.
10. Add explicit multiplier resolution tests (required):

- user override beats all,
- `max(global, referral, tier)` path,
- all-equal case resolves source to `global`,
- non-global tie resolves source with `referral > tier > global`,
- tier rule uses pre-event tier snapshot.

11. Enforce deterministic write ordering:

- resolve multiplier + insert volume event inside one transaction,
- use per-user advisory lock around that critical section.

12. Prevent `points_awarded` drift:

- default contract: `volume_events.notional_usd`, `multiplier_applied`, and `points_awarded` are immutable after insert,
- if an admin repair updates `notional_usd` or `multiplier_applied`, recompute `points_awarded` in the same write and audit-log the reason.

### Phase 1.1: Historical baseline initialization

1. Initialize existing events with:
   - `multiplier_applied = 1.0`,
   - `points_awarded = notional_usd`,
   - `multiplier_source = 'global'`.
2. Do not rewrite historical points during later policy edits.

### Phase 1.2: Fee-event frozen liability snapshots (authoritative model)

1. Extend `fee_events` schema with:
   - `cashback_bps_applied`,
   - `referral_bps_applied`,
   - `cashback_earned_usdc`,
   - `referral_earned_usdc`,
   - `liability_snapshot_source` (`event_time_frozen|bootstrap_aggregate`).
2. Update fee writers (`collect-fees`, DFlow/Kalshi trade path) to persist snapshot fields on insert:
   - resolve user tier/referral bonus at write-time with explicit qualification snapshot rules:
   - resolve referral link first to obtain `referrer_user_id` (if any) for the given `referred_user_id`,
   - use shared helper `resolveReferralQualificationAtEvent(referrerUserId, referredUserId, eventTime)` in the same transaction,
   - helper must refresh qualification deterministically before snapshot write (not read stale `referrals.status` blindly),
   - qualification predicate (v1, aligned with current semantics): `isQualified = referral_link_exists AND referrer_points_at_event >= OBSERVER_THRESHOLD AND referred_points_at_event >= OBSERVER_THRESHOLD`,
   - freeze result into `referral_bps_applied`/`referral_earned_usdc` for that fee row.
   - if product decides to relax this predicate later (for example referred-only threshold), treat it as explicit policy change with separate liability impact review.
   - compute earned amounts with canonical micro-USDC quantization,
   - write `liability_snapshot_source='event_time_frozen'`.
   - idempotent upsert rule for frozen mode:
     - economic fields (`fee_usd`, `cashback_bps_applied`, `referral_bps_applied`, `cashback_earned_usdc`, `referral_earned_usdc`, `liability_snapshot_source`) are immutable on conflict update,
     - conflict-update path may only update operational fields (`status`, `collected_at`, `tx_hash`, `updated_at`, retry/error metadata),
     - if incoming economic fields differ from stored row, reject write and alert (do not overwrite).
   - lock/order rule:
   - acquire two user locks in deterministic order (`min(referrer_user_id, referred_user_id)` then `max(...)`) during qualification + snapshot write,
   - this avoids deadlocks and keeps event-time qualification deterministic across concurrent writers.
   - when there is no referral link, acquire only the single referred-user lock.
   - implementation targets:
     - `apps/api/src/collect-fees.ts`
     - `apps/api/src/routes/dflow-private.ts`
3. Snapshot immutability rule:
   - status transitions may update `status`, `collected_at`, `tx_hash`,
   - snapshot bps/amount/source fields must remain unchanged after insert,
   - enforce at DB layer with update-guard trigger (migration `0077`).
4. Legacy rows bootstrap:
   - one-off backfill marks pre-existing rows as `liability_snapshot_source='bootstrap_aggregate'`,
   - bootstrap rows are excluded from claim/reserve decisions by default.
5. Decision guardrail:
   - if `liability_mode='event_time_frozen'`, claim/reserve queries must filter `liability_snapshot_source='event_time_frozen'` only.
6. Hard cutover rule (no silent bootstrap drift):
   - once writer rollout is complete, new rows must not remain `bootstrap_aggregate`,
   - execute hardening DDL at cutover:
     - `alter table fee_events alter column liability_snapshot_source set default 'event_time_frozen';`
   - enforce runtime reject path when `HUNCH_REWARDS_REQUIRE_FROZEN_SNAPSHOTS=true`:
     - reject fee-event writes that do not include frozen snapshot fields,
     - reject writes where `liability_snapshot_source <> 'event_time_frozen'`.
   - bootstrap default is legacy/backfill-only and must be removed at cutover.
7. Acceptance checks:
   - zero new `fee_events` rows with null snapshot fields after writer rollout,
   - zero new `fee_events` rows with >6-decimal snapshot amounts,
   - zero new `bootstrap_aggregate` rows at/after `HUNCH_REWARDS_FROZEN_CUTOVER_AT`,
   - zero conflict updates that mutate frozen economic fields,
   - no claim/reserve SQL path may read comparator aggregate as authoritative source.
   - implementation targets:
     - `apps/api/src/repos/rewards.ts`
     - `apps/api/src/services/rewards.ts`

### Phase 2: Liability + treasury analytics (read-only)

1. Add shared service for per-chain liability math.
   - decision path: read frozen snapshot amounts from `fee_events` (`liability_snapshot_source='event_time_frozen'`),
   - comparator path (optional): compute `current_tier_aggregate` from live tier + `fee_usd` for debugging only.
2. Add admin endpoint `GET /admin/rewards/treasury` returning:
   - `grossCollectedFees`, `liabilityCollected`, `liabilityPending`,
   - `claimedConfirmed`, `claimedOpenNonFailed`, `claimedNonFailed`, `claimableNow`,
   - `outstandingCollectedPayable`,
   - `includePending` and `safetyBuffer` components (`bufferUsd`, `bufferPct`, `bufferApplied`),
   - `reserveFloor`, `controlledHotBalance`, `protocolReceivableBalance`,
   - `deficitNow`, `economicSurplus`, `sweepableNow`.
3. Include explicit sources in response:
   - rewards-liability venues,
   - excluded fee streams (for transparency).
   - controlled payout wallet addresses per chain,
   - receivable accounts per chain (e.g. protocol fee accounts).
4. Add multiplier-aware diagnostics:
   - current average effective multiplier by cohort,
   - projected tier migration velocity (simple short-horizon estimate),
   - weighted effective cashback bps by chain.
5. Add explicit mode field in report:
   - `liabilityMode = event_time_frozen` (default decision mode).
   - `current_tier_aggregate` may be returned only as optional comparator/debug output, never for claim/reserve decisions.
6. Remove qualification staleness from treasury numbers by choosing one:
   - decision path: never recompute referral qualification at read-time for immutable snapshot rows,
   - qualification is frozen at fee-event write-time and reflected by `referral_bps_applied`/`referral_earned_usdc`,
   - add mismatch diagnostics only (e.g., rows where current policy would differ) without altering liability decisions.
7. Monetary precision discipline for analytics payloads:
   - quantize all USDC outputs to 6 decimals at API boundary,
   - expose raw/internal precision only in debug fields (if needed), not in payout inputs.

### Phase 3: Payout hardening

1. Ensure chain allowlist hardening is fully enforced (if partially shipped in Phase 0):
   - schema enum + alias normalization,
   - runtime canonicalization before DB write.
2. Add canonical env names with fallback resolution.
3. Add startup/config diagnostics to log resolved payout wallet per chain.
4. Ensure USDC amount normalization is fully enforced across claim lifecycle:
   - on claim create: normalize `amount_usdc` to 6 decimals with deterministic rounding (recommended `floor`),
   - reject amounts below one micro-USDC after normalization,
   - keep comparison against normalized claimable amount on the same scale.
5. Add payout preflight guard:
   - assert `amount_usdc` has <= 6 decimals before submission,
   - mark claim `failed` with explicit reason if malformed historical data is encountered.
6. Harden API ingress types for monetary fields:
   - migrate reward claim input schemas from numeric coercion to decimal-string parsing,
   - convert to `micro_usdc` at route boundary and pass normalized value into services.

### Phase 4: Auto sweep hot -> cold

1. Add script `apps/api/src/rewards-treasury-sweep.ts`:
   - `--dry-run` (default), `--execute`, `--chain`, `--max-usd`.
2. Sweep flow:
   - load treasury report,
   - block if `sweepableNow <= minSweep`,
   - transfer capped amount to cold wallet from controlled payout wallet only,
   - verify confirmation.
3. Use advisory lock per chain to avoid concurrent sweep/payout races.
4. Add optional runbook helper to top up controlled payout wallet when deficit exists but receivables are positive.
5. Add minimum retained buffer enforcement after sweep:
   - `postSweepHotBalance >= reserveFloor` must hold in the same transaction window,
   - if not, abort and record blocked reason.
6. Wire sweep execution into `finance-worker` (env-gated), not cron.

### Phase 5: Ledger + ops safety

1. Add tables:
   - `reward_treasury_runs`,
   - `reward_treasury_sweeps`.
2. Add admin visibility for last run, blocked reason, deficits.
3. Replace shell loop/cron for finance flows with `finance-worker`:
   - `fees_collect` and `fees_reconcile` run continuously by interval,
   - `treasury_sweep` runs by interval when enabled,
   - `payout_prepare` runs by interval when enabled.
4. Add guardrails for multiplier-induced liability growth:
   - alert on rapid increase in weighted cashback bps,
   - alert on reserve coverage ratio deterioration.

### Phase 5.1: Runtime cutover (safe migration)

1. Implement `apps/finance-worker` with `--dry-run` mode and structured logs.
2. Before shadow-run, add explicit `collect-fees --read-only` mode:
   - guarantee zero DB writes in shadow mode,
   - do not rely on current `--dry-run` path (it still mutates order error/archive fields in some branches).
3. Shadow-run `fees_collect` in finance-worker while existing fee-collector loop remains active, using strict read-only mode.
4. Switch write ownership to finance-worker for `fees_collect`, then remove old fee-collector loop.
5. Enable `fees_reconcile` in finance-worker and retire any equivalent ad-hoc schedulers.
6. Enable `treasury_sweep` only after reserve/deficit dashboards and alerts are verified.
7. Keep `payout_execute` manual until explicit approval workflow is implemented and tested.

## SQL Sketch (Shared Liability Service)

1. `fee_event_snapshot_chain`: aggregate `fee_events.cashback_earned_usdc + fee_events.referral_earned_usdc` by chain+status with `liability_snapshot_source='event_time_frozen'`.
2. `liability_chain`: authoritative collected/pending liabilities from `fee_event_snapshot_chain` (decision path).
3. `liability_chain_current_tier_aggregate`: optional comparator view using current tier/referral bps over `fee_events.fee_usd` (debug only).
4. `claims_chain`: split claim totals from `reward_claims` by status (`confirmed`, `pending/submitted`, `failed`).
5. `treasury_chain`: compute `claimableNow` from non-failed totals and `reserveFloor` from confirmed/open split, then merge balances for reserve/deficit/sweepable.
6. `treasury_chain_liquidity_split`: compute `controlledHotBalance`, `protocolReceivableBalance`, `deficitNow`, `economicSurplus`.
7. `user_points`: `sum(volume_events.points_awarded)` per user (progression basis; independent from frozen liability math).
8. `referral_snapshot_diagnostics`: compare frozen referral snapshot bps to current-policy-derived bps for monitoring only (no read-time mutation of liabilities).

## Exact Migration Drafts (Static-Validated)

### `0073_rewards_points_awarded.sql`

```sql
-- Single migration path (pre-MVP table size): add event multipliers + points on volume_events.

ALTER TABLE volume_events
ADD COLUMN IF NOT EXISTS multiplier_applied numeric;

ALTER TABLE volume_events
ADD COLUMN IF NOT EXISTS points_awarded numeric;

ALTER TABLE volume_events
ADD COLUMN IF NOT EXISTS multiplier_source text;

CREATE OR REPLACE FUNCTION set_volume_event_points_awarded()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.multiplier_applied IS NULL THEN
    NEW.multiplier_applied := 1.0;
  END IF;

  IF NEW.multiplier_source IS NULL OR btrim(NEW.multiplier_source) = '' THEN
    NEW.multiplier_source := 'global';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.notional_usd IS DISTINCT FROM OLD.notional_usd
       OR NEW.multiplier_applied IS DISTINCT FROM OLD.multiplier_applied THEN
      NEW.points_awarded := NEW.notional_usd * NEW.multiplier_applied;
    ELSIF NEW.points_awarded IS DISTINCT FROM OLD.points_awarded THEN
      NEW.points_awarded := OLD.points_awarded;
    END IF;
  END IF;

  IF NEW.points_awarded IS NULL THEN
    NEW.points_awarded := NEW.notional_usd * NEW.multiplier_applied;
  END IF;

  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'set_volume_events_points_awarded'
  ) THEN
    CREATE TRIGGER set_volume_events_points_awarded
    BEFORE INSERT OR UPDATE ON volume_events
    FOR EACH ROW
    EXECUTE FUNCTION set_volume_event_points_awarded();
  END IF;
END
$$;

UPDATE volume_events
SET multiplier_applied = 1.0
WHERE multiplier_applied IS NULL;

UPDATE volume_events
SET points_awarded = notional_usd * coalesce(multiplier_applied, 1.0)
WHERE points_awarded IS NULL;

UPDATE volume_events
SET multiplier_source = 'global'
WHERE multiplier_source IS NULL;

DO $$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM volume_events
  WHERE multiplier_applied IS NULL
     OR points_awarded IS NULL
     OR multiplier_source IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'volume_events backfill incomplete: % rows still null', unresolved_count;
  END IF;
END
$$;

ALTER TABLE volume_events
ALTER COLUMN multiplier_applied SET DEFAULT 1.0;

ALTER TABLE volume_events
ALTER COLUMN multiplier_source SET DEFAULT 'global';

ALTER TABLE volume_events
ALTER COLUMN multiplier_applied SET NOT NULL;

ALTER TABLE volume_events
ALTER COLUMN points_awarded SET NOT NULL;

ALTER TABLE volume_events
ALTER COLUMN multiplier_source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_multiplier_applied_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_multiplier_applied_check
      CHECK (multiplier_applied > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_points_awarded_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_points_awarded_check
      CHECK (points_awarded >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_multiplier_source_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_multiplier_source_check
      CHECK (multiplier_source IN ('global', 'user', 'referral', 'tier'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_points_consistency_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_points_consistency_check
      CHECK (points_awarded = notional_usd * multiplier_applied);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_volume_events_user_created_points
  ON volume_events(user_id, created_at DESC, points_awarded);

CREATE INDEX IF NOT EXISTS idx_volume_events_created_user_points
  ON volume_events(created_at DESC, user_id, points_awarded);
```

### `0074_rewards_multiplier_policy.sql`

```sql
-- Multiplier policy config tables (global effective policy + per-user overrides).

CREATE TABLE IF NOT EXISTS rewards_multiplier_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_at timestamptz NOT NULL,
  global_multiplier numeric NOT NULL DEFAULT 1.0,
  referral_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rewards_multiplier_policy_effective_at
  ON rewards_multiplier_policy(effective_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rewards_multiplier_policy_global_multiplier_check'
  ) THEN
    ALTER TABLE rewards_multiplier_policy
      ADD CONSTRAINT rewards_multiplier_policy_global_multiplier_check
      CHECK (global_multiplier > 0);
  END IF;
END
$$;

INSERT INTO rewards_multiplier_policy (effective_at, global_multiplier, referral_rules, tier_rules)
SELECT now(), 1.0, '[]'::jsonb, '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM rewards_multiplier_policy);

CREATE TABLE IF NOT EXISTS rewards_multiplier_user_overrides (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  multiplier numeric NOT NULL,
  reason text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rewards_multiplier_user_overrides_multiplier_check'
  ) THEN
    ALTER TABLE rewards_multiplier_user_overrides
      ADD CONSTRAINT rewards_multiplier_user_overrides_multiplier_check
      CHECK (multiplier > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rewards_multiplier_user_overrides_window_check'
  ) THEN
    ALTER TABLE rewards_multiplier_user_overrides
      ADD CONSTRAINT rewards_multiplier_user_overrides_window_check
      CHECK (expires_at IS NULL OR expires_at > effective_at);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_rewards_multiplier_user_overrides_expires_at
  ON rewards_multiplier_user_overrides(expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_rewards_multiplier_policy_updated_at'
  ) THEN
    CREATE TRIGGER update_rewards_multiplier_policy_updated_at
    BEFORE UPDATE ON rewards_multiplier_policy
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_rewards_multiplier_user_overrides_updated_at'
  ) THEN
    CREATE TRIGGER update_rewards_multiplier_user_overrides_updated_at
    BEFORE UPDATE ON rewards_multiplier_user_overrides
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;
```

### `0075_rewards_treasury_sweep_ledger.sql`

```sql
-- Ledger tables for treasury analytics and sweep execution.

CREATE TABLE IF NOT EXISTS reward_treasury_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('dry_run', 'execute')),
  chain_id text,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'partial', 'failed', 'skipped')),
  liability_mode text NOT NULL DEFAULT 'event_time_frozen'
    CHECK (liability_mode IN ('current_tier_aggregate', 'event_time_frozen')),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_treasury_runs_started
  ON reward_treasury_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_treasury_runs_status
  ON reward_treasury_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS reward_treasury_sweeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reward_treasury_runs(id) ON DELETE CASCADE,
  chain_id text NOT NULL,
  source_address text NOT NULL,
  destination_address text NOT NULL,
  amount_usdc numeric NOT NULL CHECK (amount_usdc >= 0),
  reserve_floor numeric,
  controlled_hot_balance numeric,
  protocol_receivable_balance numeric,
  sweepable_now numeric,
  deficit_now numeric,
  economic_surplus numeric,
  tx_hash text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'submitted', 'confirmed', 'failed', 'skipped')),
  reason text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_treasury_sweeps_run
  ON reward_treasury_sweeps(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_treasury_sweeps_chain_status
  ON reward_treasury_sweeps(chain_id, status, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_reward_treasury_runs_updated_at'
  ) THEN
    CREATE TRIGGER update_reward_treasury_runs_updated_at
    BEFORE UPDATE ON reward_treasury_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_reward_treasury_sweeps_updated_at'
  ) THEN
    CREATE TRIGGER update_reward_treasury_sweeps_updated_at
    BEFORE UPDATE ON reward_treasury_sweeps
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;
```

### `0076_rewards_claims_usdc_scale.sql`

```sql
-- Enforce 6-decimal USDC scale for payout safety.

-- Preflight report (run and review before apply):
-- select
--   count(*) as affected_rows,
--   coalesce(sum(amount_usdc - trunc(amount_usdc, 6)), 0) as total_delta_usdc
-- from reward_claims
-- where amount_usdc IS DISTINCT FROM trunc(amount_usdc, 6);

CREATE TABLE IF NOT EXISTS reward_claims_scale_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES reward_claims(id) ON DELETE CASCADE,
  old_amount_usdc numeric NOT NULL,
  new_amount_usdc numeric NOT NULL,
  delta_usdc numeric NOT NULL,
  reason text NOT NULL DEFAULT 'normalize_to_6_decimals',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_claims_scale_adjustments_claim
  ON reward_claims_scale_adjustments(claim_id, created_at DESC);

-- Normalize historical rows first (matches app policy: floor/trunc to 6 decimals)
-- and audit every changed row.
WITH affected AS (
  SELECT
    id as claim_id,
    amount_usdc as old_amount_usdc,
    trunc(amount_usdc, 6) as new_amount_usdc
  FROM reward_claims
  WHERE amount_usdc IS DISTINCT FROM trunc(amount_usdc, 6)
),
audited AS (
  INSERT INTO reward_claims_scale_adjustments (
    claim_id,
    old_amount_usdc,
    new_amount_usdc,
    delta_usdc
  )
  SELECT
    claim_id,
    old_amount_usdc,
    new_amount_usdc,
    old_amount_usdc - new_amount_usdc
  FROM affected
  RETURNING claim_id
)
UPDATE reward_claims rc
SET amount_usdc = a.new_amount_usdc
FROM affected a
WHERE rc.id = a.claim_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reward_claims_amount_usdc_scale_check'
  ) THEN
    ALTER TABLE reward_claims
      ADD CONSTRAINT reward_claims_amount_usdc_scale_check
      CHECK (amount_usdc = trunc(amount_usdc, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reward_claims_amount_usdc_nonnegative_check'
  ) THEN
    ALTER TABLE reward_claims
      ADD CONSTRAINT reward_claims_amount_usdc_nonnegative_check
      CHECK (amount_usdc >= 0);
  END IF;
END
$$;
```

### `0077_fee_events_frozen_liability_snapshot.sql`

```sql
-- Single migration path (pre-MVP table size): add frozen liability snapshot fields on fee_events.

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS cashback_bps_applied integer;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS referral_bps_applied integer;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS cashback_earned_usdc numeric;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS referral_earned_usdc numeric;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS liability_snapshot_source text;

ALTER TABLE fee_events
ALTER COLUMN liability_snapshot_source SET DEFAULT 'bootstrap_aggregate';

UPDATE fee_events
SET liability_snapshot_source = 'bootstrap_aggregate'
WHERE liability_snapshot_source IS NULL;

ALTER TABLE fee_events
ALTER COLUMN liability_snapshot_source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_bps_applied_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_bps_applied_check
      CHECK (
        cashback_bps_applied IS NULL
        OR (cashback_bps_applied >= 0 AND cashback_bps_applied <= 10000)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_bps_applied_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_bps_applied_check
      CHECK (
        referral_bps_applied IS NULL
        OR (referral_bps_applied >= 0 AND referral_bps_applied <= 10000)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_total_bps_cap_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_total_bps_cap_check
      CHECK (
        liability_snapshot_source <> 'event_time_frozen'
        OR (cashback_bps_applied + referral_bps_applied <= 10000)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_fee_usd_nonnegative_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_fee_usd_nonnegative_check
      CHECK (fee_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_earned_usdc_nonnegative_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_earned_usdc_nonnegative_check
      CHECK (cashback_earned_usdc IS NULL OR cashback_earned_usdc >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_earned_usdc_scale_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_earned_usdc_scale_check
      CHECK (cashback_earned_usdc IS NULL OR cashback_earned_usdc = trunc(cashback_earned_usdc, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_earned_usdc_nonnegative_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_earned_usdc_nonnegative_check
      CHECK (referral_earned_usdc IS NULL OR referral_earned_usdc >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_earned_usdc_scale_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_earned_usdc_scale_check
      CHECK (referral_earned_usdc IS NULL OR referral_earned_usdc = trunc(referral_earned_usdc, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_liability_snapshot_source_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_liability_snapshot_source_check
      CHECK (liability_snapshot_source IN ('event_time_frozen', 'bootstrap_aggregate'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_event_time_snapshot_required_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_event_time_snapshot_required_check
      CHECK (
        liability_snapshot_source <> 'event_time_frozen'
        OR (
          cashback_bps_applied IS NOT NULL
          AND referral_bps_applied IS NOT NULL
          AND cashback_earned_usdc IS NOT NULL
          AND referral_earned_usdc IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_formula_consistency_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_formula_consistency_check
      CHECK (
        liability_snapshot_source <> 'event_time_frozen'
        OR cashback_earned_usdc = trunc((fee_usd * cashback_bps_applied) / 10000.0, 6)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_formula_consistency_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_formula_consistency_check
      CHECK (
        liability_snapshot_source <> 'event_time_frozen'
        OR referral_earned_usdc = trunc((fee_usd * referral_bps_applied) / 10000.0, 6)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_total_earned_cap_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_total_earned_cap_check
      CHECK (
        liability_snapshot_source <> 'event_time_frozen'
        OR (cashback_earned_usdc + referral_earned_usdc <= fee_usd)
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION guard_fee_event_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cashback_bps_applied IS DISTINCT FROM OLD.cashback_bps_applied
     OR NEW.referral_bps_applied IS DISTINCT FROM OLD.referral_bps_applied
     OR NEW.cashback_earned_usdc IS DISTINCT FROM OLD.cashback_earned_usdc
     OR NEW.referral_earned_usdc IS DISTINCT FROM OLD.referral_earned_usdc
     OR NEW.liability_snapshot_source IS DISTINCT FROM OLD.liability_snapshot_source THEN
    RAISE EXCEPTION 'fee_events snapshot fields are immutable after insert';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'guard_fee_events_snapshot_immutable'
  ) THEN
    CREATE TRIGGER guard_fee_events_snapshot_immutable
    BEFORE UPDATE ON fee_events
    FOR EACH ROW
    EXECUTE FUNCTION guard_fee_event_snapshot_immutable();
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_fee_events_chain_status_snapshot_created
  ON fee_events(chain_id, status, liability_snapshot_source, created_at DESC);
```

### `0078_fee_events_frozen_cutover_default.sql` (required cutover migration)

```sql
-- Apply only after writer rollout is live and validated.
-- This migration hardens post-cutover behavior so new rows default to frozen snapshots.
ALTER TABLE fee_events
ALTER COLUMN liability_snapshot_source SET DEFAULT 'event_time_frozen';
```

### Cutover runbook gate (required, owned)

- Owner A (backend):
  - verify current writers always send frozen snapshot fields in:
    - `apps/api/src/collect-fees.ts`
    - `apps/api/src/routes/dflow-private.ts`
- Owner B (ops):
  - apply `0078_fee_events_frozen_cutover_default.sql`,
  - set `HUNCH_REWARDS_REQUIRE_FROZEN_SNAPSHOTS=true`,
  - set `HUNCH_REWARDS_FROZEN_CUTOVER_AT=<UTC timestamp>`,
  - run and capture:
    - `SELECT count(*) AS unexpected_bootstrap_rows FROM fee_events WHERE created_at >= :frozen_cutover_at AND liability_snapshot_source <> 'event_time_frozen';`
  - only enable `HUNCH_REWARDS_LIABILITY_MODE=event_time_frozen` when `unexpected_bootstrap_rows = 0`.

## Static Validation of Draft Migrations

- Migration filenames are lexicographically ordered after existing latest (`0072_*`) and match project runner behavior (`packages/db/src/migrate.ts` sorts file names).
- Planned migration set for this rollout: `0073`, `0074`, `0075`, `0076`, `0077`, `0078`.
- SQL style is consistent with existing migrations:
  - idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`,
  - guarded constraint additions via `DO $$ ... pg_constraint ...`,
  - guarded trigger creation via `information_schema.triggers`.
- New columns/tables do not conflict with existing schema names in `0041_rewards_core.sql`.
- `volume_events.source_type` is unchanged (`order|execution`), so existing writers remain valid until code migrates to new fields.
- Backfill logic in `0073` is forward-safe:
  - existing rows get deterministic baseline (`1.0`, `notional_usd`, `'global'`),
  - no historical multiplier replay required.
- `0073` includes a compatibility trigger so pre-migration writers that omit new columns still produce correct `points_awarded` values, and creates it before backfill to remove migration race windows.
- `0073` adds explicit null-gate validation before `SET NOT NULL`.
- Migrations are intentionally single-path for current pre-MVP data size and can be executed atomically in one deploy window.
- Numeric preflight gates for single-path rollout:
  - `volume_events` exact rows <= `100000` and table size <= `268435456` bytes (256 MiB),
  - `fee_events` exact rows <= `100000` and table size <= `268435456` bytes (256 MiB).
- If any gate fails, fallback path is to split into staged operational runbook before applying in production.
- Index strategy is split for both query shapes:
  - user-scoped reads (`user_id, created_at`),
  - global time-window scans (`created_at, user_id`).
- `0076` enforces `reward_claims.amount_usdc` scale safety at DB layer, preventing invalid precision rows from non-API write paths.
- `0077` adds event-time liability snapshot fields plus:
  - source amount nonnegative guard (`fee_usd >= 0`),
  - explicit nonnegative + 6-decimal scale checks for frozen earned amounts,
  - total bps cap (`cashback_bps_applied + referral_bps_applied <= 10000`) in frozen mode,
  - formula-consistency checks between `fee_usd`, bps, and earned fields in frozen mode,
  - DB trigger enforcing snapshot-field immutability after insert.
- Writer compatibility requirement with 0077 strict checks:
  - once frozen mode is enabled, fee writers must treat economic fields as idempotent and immutable on conflict updates.
- `0078` is a tracked cutover hardening migration (default -> `event_time_frozen`) and is applied only after writer-rollout signoff under the cutover runbook gate.
- Treasury ledger tables are append-friendly and keyed for the planned admin/sweeper query paths (`run_id`, `chain_id`, `status`, time ordering).

## Acceptance Criteria and Required Tests

- Test harness placement and CI gate (required):
  - add finance/rewards tests under `apps/api/src/tests/rewards/*.test.ts` (or equivalent dedicated rewards test folder),
  - add script `pnpm -C hunch-monorepo -F api run test:rewards`,
  - wire `apps/api/package.json` with `"test:rewards"` and root CI workflow to call it,
  - enforce CI gate: `test:rewards` must pass before deploy.
- Precision and money-type tests:
  - claimable/reserve/sweep decisions use canonical `micro_usdc` arithmetic only,
  - no JS-float branch controls monetary eligibility decisions,
  - normalization/rounding rules (`floor` claim, `ceil` safety buffer) are verified on boundary values.
  - API monetary ingress accepts decimal strings and rejects number-coerced inputs for claim amount.
- Chain normalization tests:
  - `raw -> alias normalize -> canonical enum validate -> persist canonical` path enforced,
  - unknown chains rejected after normalization.
- Concurrency/lock tests:
  - chain lock contention between payout and sweep prevents unsafe interleavings,
  - claim-create per-user lock remains isolated from chain-wide payout/sweep locks,
  - user lock contention for multiplier writes preserves deterministic pre-event tier behavior,
  - referral qualification path acquires two-user locks in deterministic order and avoids deadlocks.
- Migration safety-gate tests:
  - trigger-first + backfill path produces zero nulls before `SET NOT NULL`,
  - single-migration preflight checks validate numeric row/size thresholds and rollback readiness,
  - rollback/fallback path keeps production reads safe when gate checks fail.
- Event-time liability tests:
  - `event_time_frozen` mode reads only `fee_events.liability_snapshot_source='event_time_frozen'`,
  - at/after `HUNCH_REWARDS_FROZEN_CUTOVER_AT`, count of `bootstrap_aggregate` rows is zero,
  - changing current tier after an event does not change that event's liability contribution,
  - frozen rows satisfy DB invariants:
    - `fee_usd >= 0`,
    - `cashback_bps_applied + referral_bps_applied <= 10000`,
    - earned fields equal formula-derived values from `fee_usd` and bps (with trunc(6)),
  - comparator aggregate output can diverge from frozen mode but is never used in claim/sweep decisions.
- Cutover governance gate:
  - 0078 migration execution is recorded in rollout ticket,
  - backend + ops dual approval is present,
  - captured SQL evidence for `unexpected_bootstrap_rows = 0` is attached before mode switch.
- Drift/immutability tests:
  - direct update attempts to monetary event fields are blocked or recomputed consistently,
  - direct update attempts to `fee_events` frozen snapshot fields fail via immutability trigger,
  - conflict-update write path cannot mutate frozen economic fields on existing fee rows,
  - `points_awarded` consistency invariant remains true after admin repair operations.

## Non-Goals (Initial KISS)

- Cross-chain rebalancing/bridging automation.
- Historical policy snapshot replay engine.
- Contract redesign.

## Readiness and Open Questions

- Ready to implement in phases with backward compatibility.
- Pre-MVP assumption (explicit): `bootstrap_aggregate` rows are excluded from claim/reserve decisions; acceptable only if there are no material legacy liabilities to honor.
- Exceptional override only: if material legacy liabilities must be honored before snapshot backfill policy is defined, temporarily set `HUNCH_REWARDS_LIABILITY_MODE=current_tier_aggregate` with explicit ops approval and expiry window, then revert to `event_time_frozen`.
- Open product decision (single knob): should bridge affiliate fees be included in rewards liability scope now, or kept separate as platform revenue stream?
- Open policy decision: initial default values for global multiplier and referral/tier multiplier ladders (system supports all; choose rollout preset).
- Open anti-abuse decision: referral multiplier qualification thresholds (min base volume, min fills, minimum account age, optional sybil checks).
- Accounting decision (closed): use `event_time_frozen` as default/authoritative liability model from MVP start; keep `current_tier_aggregate` as optional diagnostic comparator only.
