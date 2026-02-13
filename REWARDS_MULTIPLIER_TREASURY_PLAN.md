# Rewards + Fees + Treasury System Plan (KISS, Code-Grounded)

## Objective
- Make rewards points work exactly as product intent (`$1` volume -> points via tier multiplier).
- Keep progression based on `points_awarded` (multiplied points), not raw volume.
- Keep claimability math correct and auditable across chains.
- Define what is claim liability vs what is treasury-owned capital.
- Add safe automation to move platform-owned capital from hot wallets to cold treasury wallets.
- Normalize env naming and wallet ownership mapping to reduce operational mistakes.

## Current System Map (Validated)

### A) Fee collection by venue
| Venue | Where fee is produced | Who writes `fee_events` | Chain in DB | Status lifecycle | Main env |
|---|---|---|---|---|---|
| Polymarket | On-chain `collectFee` call on fee collector contract | `apps/api/src/collect-fees.ts` (and prod `fee-collector` service loop) | `137` | `collected` only (on confirmed tx) | `HUNCH_FEE_COLLECTOR_ADDRESS`, `HUNCH_FEE_COLLECTOR_PRIVATE_KEY`, `HUNCH_FEE_BPS_POLYMARKET` |
| Kalshi (via DFlow) | Execution callback ingestion (`/dflow/private`) + signature reconciliation | `apps/api/src/routes/dflow-private.ts`, `apps/api/src/services/fee-reconcile.ts` | `solana` | `pending -> collected/failed` | `HUNCH_FEE_BPS_KALSHI`, `HUNCH_FEE_SCALE_KALSHI`, `DFLOW_USDC_FEE_ACCOUNT`, `DFLOW_USDC_MINT` |
| Limitless | No rewards fee ingestion path today | N/A | N/A | N/A | N/A |
| Bridge (deBridge affiliate) | Configured separately for swap affiliate routing | `apps/api/src/routes/bridge.ts` (config), not in `fee_events` pipeline | mixed | N/A | `DEBRIDGE_*` |

### B) Rewards claim creation and payout
| Step | Component | Notes |
|---|---|---|
| Claim requested | `apps/api/src/routes/rewards.ts` | Validates linked wallet and chain-wallet type compatibility. Inserts `reward_claims(status='pending')`. |
| Claimability computed | `apps/api/src/services/rewards.ts` | `claimable = max(0, collected_liability - claimed_non_failed)` per chain. |
| Payout execution | `apps/api/src/rewards-payout.ts` | Confirms submitted txs, reserves pending claims, sends token transfer, finalizes `confirmed/failed`. |
| Payout scheduler | Not in prod compose | Currently manual/ops-driven (`remote-exec.sh rewards:payout`), unlike fee collector loop. |

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
- Effective multiplier is resolved per event with deterministic precedence:
  1. per-user override
  2. referral-derived multiplier rule
  3. tier-derived multiplier rule
  4. global default multiplier
- The selected multiplier and source must be persisted on the event for auditability.
- If tier-derived multiplier is enabled, evaluate multiplier from the pre-event tier snapshot (before adding the event) to avoid circular ambiguity.

### Why this matters for treasury math
- Cashback bps comes from tier.
- Tier comes from points.
- Points come from multiplied events.
- Therefore multiplier policy changes alter future tier migration speed and future liabilities, so reserve analytics must include this dynamic.

## Financial Model (Liability vs Platform-Owned)

### Current model note (as-is)
- Liability computation today is based on current tier + aggregated fees, not fee-event-time frozen tier/bps snapshots.
- This is retained initially for compatibility unless explicitly changed in a later phase.

### Target per-chain definitions (post Phase 1)
- `grossCollectedFees = sum(fee_events.fee_usd where status='collected')`
- `userProgressPoints = sum(volume_events.points_awarded)` (or equivalent derived value)
- `userTier = resolveTier(userProgressPoints, rewards_policy.tiers)`
- `liabilityCollected = cashbackCollected + referralCollected` using active policy and collected fees, where cashback bps is from `userTier`.
- `liabilityPending = cashbackPending + referralPending` using pending fees, where cashback bps is from `userTier`.
- `claimedNonFailed = sum(reward_claims.amount_usdc where status <> 'failed')`
- `claimableNow = max(0, liabilityCollected - claimedNonFailed)`
- `reserveFloor = liabilityCollected + liabilityPending + safetyBuffer`
- `controlledHotBalance = on-chain USDC balance in wallet/key that actually signs payouts`
- `protocolReceivableBalance = fee balances economically owned but not directly controlled by payout signer`
- `deficitNow = max(0, reserveFloor - controlledHotBalance)`
- `economicSurplus = max(0, controlledHotBalance + protocolReceivableBalance - reserveFloor)`
- `sweepableNow = max(0, controlledHotBalance - reserveFloor)`

### Interpretation
- Theoretical claimable now: `claimableNow`.
- Potentially movable to cold treasury now: `sweepableNow`.
- Payout safety is based on `controlledHotBalance` only.
- `protocolReceivableBalance` improves economic position but does not make payouts liquid.
- If `controlledHotBalance < reserveFloor`, sweeping must be blocked and deficit alert raised.
- Because progression is points-based, multiplier policy affects liabilities indirectly via tier acceleration.

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

### 3) Scope mismatch across fee systems
- Rewards liability uses `fee_events` (Polymarket + DFlow/Kalshi).
- Bridge affiliate fees are configured separately and not part of rewards liability flow.
- This is acceptable if intentional, but must be explicit in docs and treasury accounting.

### 4) Input hardening gap
- `rewardsClaimBodySchema.chainId` is a free string, while runtime supports a limited set.
- This can cause operator/user confusion and makes validation less strict than needed.

### 5) Secrets hygiene risk
- `ops/.env.prod.local` currently contains non-empty private-key-like values.
- Treat this file as sensitive, verify key rotation policy, and avoid committing live secrets in repo-managed env templates.

### 6) Progression reflexivity is intentional now
- With progression on multiplied points, higher multipliers can accelerate tier upgrades.
- This is now a product feature, not a bug, but requires liability monitoring and guardrails.

## Env Consistency Plan (Backward Compatible)

### Keep existing envs working, add canonical names
| Domain | Current | Canonical (new) | Action |
|---|---|---|---|
| EVM payout key | `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY` | `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_EVM` | Add canonical; fallback to current. |
| Solana payout key | `HUNCH_REWARDS_SOLANA_SECRET_KEY` | `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_SOLANA` | Add canonical; fallback to current. |
| Solana rewards mint | `DFLOW_USDC_MINT` (implicit) | `HUNCH_REWARDS_USDC_MINT_SOLANA` | Add rewards-specific key; fallback to `DFLOW_USDC_MINT`. |
| Payout source addr map | implicit from private key | `HUNCH_REWARDS_HOT_ADDRESS_POLYGON/BASE/SOLANA` | Optional explicit sanity checks/logging. |
| Cold destination | none | `HUNCH_REWARDS_COLD_ADDRESS_POLYGON/BASE/SOLANA` | Required for sweep execution. |
| Sweep controls | none | `HUNCH_REWARDS_SWEEP_*` | Add feature flag + thresholds. |

### Proposed sweep envs
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

## Implementation Plan

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
   - user override > referral rule > tier rule > global default.
4. Store resolved values on each new event (forward-only).
5. Switch progression points to `sum(points_awarded)`.
6. Keep API exposing both:
   - `clout.points` (progression points),
   - `clout.volumeUsd` (raw volume).
7. Keep cashback/claim formulas unchanged structurally, but tier input now comes from progression points.
8. Update all `volume_events` writers to set multiplier fields consistently:
   - `apps/api/src/services/positions-sync.ts`
   - `apps/api/src/routes/dflow-private.ts`
   - `apps/api/src/routes/admin.ts`
   - `apps/api/src/admin-points.ts`
9. Update all points consumers from `sum(notional_usd)` to `sum(points_awarded)` where intended:
   - rewards summary,
   - referrals views,
   - leaderboard `points` metric.

### Phase 1.1: Historical baseline initialization
1. Initialize existing events with:
   - `multiplier_applied = 1.0`,
   - `points_awarded = notional_usd`,
   - `multiplier_source = 'global'`.
2. Do not rewrite historical points during later policy edits.

### Phase 2: Liability + treasury analytics (read-only)
1. Add shared service for per-chain liability math.
2. Add admin endpoint `GET /admin/rewards/treasury` returning:
   - `grossCollectedFees`, `liabilityCollected`, `liabilityPending`,
   - `claimedNonFailed`, `claimableNow`,
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
5. Add explicit compatibility flag in report:
   - `liabilityMode = current_tier_aggregate | event_time_frozen` (initially `current_tier_aggregate`).

### Phase 3: Payout hardening
1. Enforce chain allowlist in claim schema (enum `137|8453|solana` + aliases if needed).
2. Add canonical env names with fallback resolution.
3. Add startup/config diagnostics to log resolved payout wallet per chain.

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

### Phase 5: Ledger + ops safety
1. Add tables:
   - `reward_treasury_runs`,
   - `reward_treasury_sweeps`.
2. Add admin visibility for last run, blocked reason, deficits.
3. Add optional cron/loop service for sweep (disabled by default).
4. Add guardrails for multiplier-induced liability growth:
   - alert on rapid increase in weighted cashback bps,
   - alert on reserve coverage ratio deterioration.

## SQL Sketch (Shared Liability Service)
1. `fees_user_chain`: `fee_events` grouped by user+chain+status.
2. `referral_fees_user_chain`: qualified referrals joined to `fee_events`.
3. `user_points`: `sum(volume_events.points_awarded)` per user (progression basis).
4. `user_tier_effective_bps`: tier from points + referral cap logic.
5. `liability_chain`: aggregate collected/pending liabilities.
6. `claims_chain`: non-failed claimed totals from `reward_claims`.
7. `treasury_chain`: merge with on-chain balances to compute reserve/deficit/sweepable.
8. `treasury_chain_liquidity_split`: compute `controlledHotBalance`, `protocolReceivableBalance`, `deficitNow`, `economicSurplus`.

## Non-Goals (Initial KISS)
- Cross-chain rebalancing/bridging automation.
- Historical policy snapshot replay engine.
- Contract redesign.

## Readiness and Open Questions
- Ready to implement in phases with backward compatibility.
- Open product decision (single knob): should bridge affiliate fees be included in rewards liability scope now, or kept separate as platform revenue stream?
- Open policy decision: initial default values for global multiplier and referral/tier multiplier ladders (system supports all; choose rollout preset).
- Open anti-abuse decision: referral multiplier qualification thresholds (min base volume, min fills, minimum account age, optional sybil checks).
- Open accounting decision: keep retroactive current-tier liability model or introduce event-time frozen earned bps later.
