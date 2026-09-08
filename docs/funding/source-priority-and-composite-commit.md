# Funding source priority and composite commit

## Incidents

- The September 8 $20 plan selected whole capped SOL and USDC contributions by
  minimum excess, without a stable/native or internal/external preference.
- The subsequent $18 commit failed with PostgreSQL `23514`: a versioned
  preparation step followed a provider step, but the validator incorrectly
  required preparation-local ordinals to start at global ordinal zero.

## Selection

Implicit funding uses internal stable assets, internal non-stable assets,
connected external stable assets, then connected external non-stable assets.
Existing venue preparation (including an internally controlled legacy Safe)
precedes Relay within its ownership group. A Safe is classified by its
controller, not by being legacy. Existing ownership, connection, sponsorship,
receipt, gas-reserve and fee checks still apply.

Each provider contribution is quoted against the remaining **minimum** output.
The planner never edits signed calldata or scales an existing provider quote.
If an internal-only plan is insufficient, it rebuilds one bounded venue
preparation plan with external sources permitted; it does not concatenate
Router plans sharing a nonce. Components already allocated to provider legs
are excluded from that rebuild. Recommendations compare source preference
costs before execution convenience.

Repeated provider discoveries share request-local promises and the bounded
Relay planning deadline. Explicit source amounts, exact withdrawal component
selection and capacity previews retain their existing quote scope. Max is not
an execution authorization; Buy still requires fresh executable quotes.

## Migration and rollout

`0254_funding_composite_preparation_ordinals.sql` replaces the validator only.
It checks the preparation subset's ordering and exact preceding dependencies,
while retaining global contiguous ordinals and the other existing checks.
It does not scan, modify, requeue or resume historical operations at deployment.
The failed commit rolled back and needs no manual completion.

No frontend contract or signing-policy change is required.

## Verification after deployment

1. Prepare a mixed Polygon/Solana Buy: internal stables, including an owned
   legacy Safe, precede internal SOL; external funds follow internal funds.
2. With external USDC and SOL, USDC contributes first and SOL is quoted only
   for the remaining deficit. The native gas reserve must remain excluded.
3. Prepare a mixed provider-first / Polymarket-preparation plan: commit must
   succeed without making independent steps depend on each other.
4. Disconnect an external controller: neither its wallet nor its Safe may
   enter the plan. Repeat with a different internal controller's owned Safe.
5. Verify explicit Convert/withdrawal source amounts and account Max separately.
   Preparation does not submit a Buy during this read-only smoke check.

Local coverage includes ordered residual contribution selection, recommendation
priority, internal versus external Safe eligibility, source reuse exclusion,
and PostgreSQL 16 composite validation with both step orders.
