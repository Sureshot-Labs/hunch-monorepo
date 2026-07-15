# Backend Task: Trusted Cross-Venue Market Mappings

Status: ready for backend design and implementation  
Priority: P1  
Depends on: unified market ingestion and candidate matching sources

## Goal

Persist an auditable set of market equivalence mappings, including outcome-side
orientation, that is safe enough for personal signal subscriptions and other
user-specific automation.

## Why This Is Required

The current Telegram portfolio-signal fan-out matches only one exact
`unified_tokens.market_id`. This is safe but misses the case where a user holds
the same real-world contract on another venue.

The repository has runtime cross-venue discovery and an AGG-backed
`/markets/:marketId/alternatives` route. Runtime alternatives are useful for
discovery and price comparison, but they are not a durable authorization-grade
mapping for proactive user notifications. A temporary API response, title
similarity, embedding cluster, or AI match can be wrong, change later, or omit
side inversion.

Sending a signal about the wrong market or telling a user that a signal
supports the wrong side is a trust failure. Personal fan-out must therefore use
only persisted mappings that meet an explicit trust policy.

## Equivalence Definition

Markets may share an equivalence group only when they represent the same
payoff proposition for the relevant outcomes. Review must consider:

- subject and event;
- threshold or candidate/outcome;
- time window and deadline;
- resolution source and edge cases;
- void/cancellation behavior;
- scalar versus binary settlement;
- whether YES on one member corresponds to YES or NO on another.

Related markets, overlapping markets, mutually exclusive outcomes, and markets
with different deadlines are not exact equivalents. They may belong in a
discovery cluster, but not in a notification equivalence group.

## Suggested Data Model

Names are illustrative; follow repository naming conventions in the final
migration.

```text
trusted_market_equivalence_groups
  id uuid primary key
  status candidate | active | rejected | retired
  canonical_label text
  equivalence_kind exact_binary | exact_scalar
  source text
  reviewed_by uuid/null
  reviewed_at timestamptz/null
  review_notes text/null
  created_at, updated_at

trusted_market_equivalence_members
  group_id uuid references groups
  market_id text
  venue text
  side_orientation direct | inverted
  confidence numeric/null
  source_reference jsonb
  valid_from timestamptz
  valid_until timestamptz/null
  created_at, updated_at
```

Required constraints:

- unique active membership for `(venue, market_id)` within the exact
  equivalence namespace;
- known venue values;
- `side_orientation` required for binary groups;
- an active group must have at least two active members;
- only reviewed/active groups may be read by personal notification fan-out;
- membership retirement is historical, not destructive deletion.

If multi-outcome mappings are needed later, add an explicit outcome map per
member. Do not overload binary `direct/inverted` with ambiguous strings.

## Candidate and Review Workflow

1. Ingest candidates from AGG alternatives, deterministic matching, or AI
   clustering with source and confidence metadata.
2. Store candidates separately or with `status = candidate`.
3. Present exact contract text, deadline, venue, resolution rules, and proposed
   side orientation to an authorized reviewer.
4. Activate only after review or after a separately approved deterministic
   policy with equivalent guarantees.
5. Record reviewer, timestamp, source versions, and notes.
6. Retire or replace mappings when a venue edits rules or ingestion identifies
   a material contract change.

An AI confidence threshold alone must not activate personal-notification
mappings.

## Read Contract

Provide a repository/service method that returns active equivalents for a
source market at a specific time:

```text
resolveTrustedEquivalentMarkets(sourceMarketId, asOf)
```

The result must include:

- equivalence group ID;
- source and target market IDs and venues;
- source and target side orientation;
- review/version metadata required for observability.

Consumers should store the mapping group/version or member IDs in generated
outbox payloads. This makes a misdelivery auditable even if the mapping is later
retired.

## Side Transformation

For a binary signal side and held position side:

- `direct`: YES -> YES and NO -> NO;
- `inverted`: YES -> NO and NO -> YES.

Apply orientation exactly once in a shared function with exhaustive tests. The
source signal side should come from normalized structured signal data; the held
side should come from token metadata. Never infer either side from titles.

If either side or orientation is unknown, the consumer may say only “New signal
for a related market” or, preferably for the first release, skip personal
delivery and record the reason.

## Integration with Telegram Signals

Recipient selection becomes:

```text
signal target market
  -> active trusted equivalence group at signal time
  -> active member markets
  -> token side with orientation applied
  -> visible owned positions
  -> Telegram signal preference and overrides
  -> one deduped outbox event per user and signal
```

Aggregate multiple equivalent positions for the same user before enqueue. A
user holding the same proposition on two venues receives one message, not two.

Exact source-market matching must continue to work when no trusted mapping
exists.

## Operations

Add metrics and review tooling for:

- candidate, active, rejected, and retired mapping counts;
- active members by venue pair;
- fan-out recipients from exact match versus mapped match;
- skipped signals due to missing side/orientation;
- mapping ID attached to each mapped outbox event;
- a kill switch that disables mapped fan-out while leaving exact matching on.

## Acceptance Criteria

- Only active trusted mappings affect personal recipient selection.
- Every mapped delivery records which reviewed mapping produced it.
- Direct and inverted side transformations are exhaustively tested.
- Deadline/rules mismatches cannot be activated accidentally.
- Retiring a mapping stops future mapped fan-out without mutating historical
  deliveries.
- A user with equivalent positions on multiple venues receives one signal.
- Exact-market delivery remains available independently and can be the
  production fallback.
- Candidate-source outages do not delete or silently rewrite active mappings.

## Out of Scope

- general discovery clusters and loosely related market recommendations;
- automatic trading across mapped venues;
- price normalization or best-execution routing;
- per-user signal controls, which are covered in
  `backend-telegram-signal-subscriptions.md`.
