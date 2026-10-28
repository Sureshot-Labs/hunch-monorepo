# Hunch Holder-Driven Market Research Agent Prompt

**Implementation update:** the [activity-first public-copy rules](#activity-first-public-copy--october-2026-update)
below supersede the older headline/copy discussion. The code’s V1/V2 prompts are
the executable source of truth; research selection and publication gates are unchanged.

Use this prompt when an agent should search Hunch for interesting markets based on tracked holder positioning, recent wallet activity, and wallet quality metrics. This is a read-only research workflow. Do not place trades, request secrets, sign transactions, or perform account actions.

## Goal

Find markets or events where tracked holders reveal something useful:

- real two-sided disagreement;
- sharp wallets taking a minority side;
- a large whale creating concentration risk;
- recent meaningful flow from wallets that still hold exposure;
- event-level structure where wallets bridge multiple markets.

Return both market findings and tool-quality feedback.

## Required Tooling

Use Hunch Agent Tools MCP first. Use compact mode by default. Prefer narrow calls over broad calls because holder payloads can become large.

Recommended calls:

- `hunch_get_tracked_positioning`
- `hunch_get_market_wallet_activity`
- `hunch_get_wallet_leaderboard`
- `hunch_get_wallet_positions`
- `hunch_get_wallet_intel`
- `hunch_get_market_detail`
- `hunch_get_event_detail`

## Discovery Workflow

1. Start with positioning rollups.
   - Markets:
     - `rollup=markets`
     - `sort=balanced_disagreement`
     - `includeHolders=true`
     - `holdersLimit=2-3`
     - `includePositionPnl=true`
     - `responseMode=compact`
   - Events:
     - `rollup=events`
     - `sort=event_disagreement_score`
     - `includeHolders=true`
     - `holdersLimit=1-2`
     - `includePositionPnl=true`
     - `responseMode=compact`

2. For each promising market, validate recent flow.
   - Call `hunch_get_market_wallet_activity`.
   - Use `minSizeUsd` to avoid noise.
   - Prefer rows where `positionNow` confirms the wallet still holds exposure.

3. Check holder quality.
   - Use holder edge fields from positioning first.
   - If needed, call `hunch_get_wallet_intel` or `hunch_get_wallet_leaderboard`.
   - Treat high edge with tiny sample size as watchlist signal, not proof.

4. Separate signal types.
   - Clean disagreement: both sides have material dollars and multiple wallets.
   - Sharp minority: smaller side has stronger holder quality.
   - Whale concentration: one wallet dominates; useful but riskier.
   - Recent flow: large recent additions, especially if still held.
   - Event bridge: same wallets active across multiple markets in one event.

## Scoring Heuristics

Prefer markets with:

- tracked position over roughly `$100K`;
- both YES and NO represented;
- minority side at least roughly `10%` of tracked dollars, or at least `$25K`;
- at least `2` wallets on the minority side;
- largest holder below roughly `80%` unless the point is concentration risk;
- recent wallet activity above roughly `$5K`;
- holder edge backed by resolved sample count and stake.

Penalize:

- one-wallet domination when presenting as disagreement;
- stale activity where the wallet no longer holds exposure;
- approximate/unreliable PnL when exact PnL matters;
- markets where all interesting data is from tiny sample wallets.

## Report Format

Return 5-8 candidates. For each:

- title;
- Hunch link;
- `eventId` and `marketId`;
- odds;
- tracked dollars and side split;
- key holders or recent movers;
- why it is interesting;
- caveats.

Then add:

- best overall candidates;
- best graph-visualization candidates;
- tool-quality notes;
- missing API/tool improvements.

## Caveats To State

- This is research, not a trade recommendation.
- PnL may be approximate when the tool marks it as snapshot-derived or unreliable.
- `edge_z_score` and related edge metrics need sample/stake context.
- A whale-dominated market is not the same as broad disagreement.

## Tool QA Checklist

While researching, explicitly note:

- whether compact output was actually compact;
- whether holder data was easy to scan;
- whether links and IDs were sufficient;
- whether market/event/wallet names were clear;
- whether PnL reliability was obvious;
- whether more filters or sorts would have improved the workflow.

# Activity-first public copy — October 2026 update

The implementation in `apps/api/src/schemas/holder-research.ts` now imports shared
`INTEL_ACTIVITY_COPY_RULES` for both final V1 and V2 prompts. Assessment and
publication gates are unchanged: editorial copy describes **who holds or changed
what**, rather than leading with a speculative event forecast.

Each compact holder has an `observedActivity` record with a safe display name,
marked position value, shares and observation time. It is explicitly a holding
snapshot, not a confirmed purchase. Exact-side history comparisons remain the
source for share-change claims; amounts from different cohorts, shares, current
value and trade notional must not be conflated. Approximate PnL is not realized
profit. A negative overall record cannot be relabeled profitable using a small
thematic subset.

Headline: actor + observation + exact outcome + meaningful size; normally 8–16
words within the existing 140-character schema. Explanation: the decisive
verified reason it matters and a material limitation, without repeating the
headline or inventing motives. CTA/navigation is exclusively interface-owned.
The V2 `why_now` is returned directly, without a forced side/price prefix.

See `telegram/backend-signal-post-copy-v4.md` for the V12 renderer integration and
bounded paid evaluation. The older prompt discussion below is historical where
it conflicts with these public-copy rules. This is not a change to ingestion,
research selection, model budgets, execution or publication eligibility.
