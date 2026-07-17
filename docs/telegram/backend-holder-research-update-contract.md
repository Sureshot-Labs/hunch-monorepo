# Backend Task: Make Holder Research Updates Meaningful and Market-Complete

Status: ready for assignment  
Priority: P0 before enabling research updates in public channels  
Owner: backend / holder research / market ingestion

## Problem

A production Telegram research update exposed three upstream contract failures:

- the market reached the renderer as `↑ 70,000` without its parent event,
  although the canonical Polymarket event names Bitcoin and July;
- the note was published as an update without a structured user-facing reason
  for the update, so generated copy called it both "new research" and a
  "repeat read";
- prose mixed an approximately 18% YES probability with an 83¢ NO headline
  without declaring the price side, field, or common snapshot time.

Incident fixture:

```text
event: polymarket:655630
market: polymarket:2758338
side: NO
canonical event title: What price will Bitcoin hit in July?
canonical market question: Will Bitcoin reach $70,000 in July?
group item title: ↑ 70,000
```

The local V5 renderer now defensively:

- compares the persisted current and previous `decision_snapshot`;
- accepts only side-matched `odds_move`, `holder_position_move`,
  `side_exposure_move`, and `sharp_holder_count_changed` reasons;
- derives the notification lead from that verified price, position, or strong
  wallet-count delta;
- suppresses legacy updates without a comparable baseline, unsupported
  reasons, detached no-evidence copy, and repeated wallet credentials;
- renders `Wallet now` / `Cluster now` as current context rather than calling
  unchanged position state news;
- permits a Buy CTA only when the selected-side delta is positive and the
  normal public-channel execution guard also passes.

`recentActivityUsd` is market-wide in the current snapshot. V5 deliberately
does not turn `fresh_flow` into a directional headline or Buy CTA because it
cannot prove which side the flow backed. These safeguards stop misleading
delivery, but they cannot recover missing canonical identity, typed external
evidence, holder entry/exit semantics, or side-attributed flow.

## Goal

Every published holder-research update must identify the complete contract,
state one verified material change, and use a single attributable market-price
snapshot. If those inputs are unavailable, the note must not enter the public
delivery queue.

## Required Backend Work

### 1. Guarantee canonical market identity

At holder-research persistence and again before publication, resolve and store:

```text
venue
event_id
event_title
market_id
market_question
market_group_item_title
side
canonical_telegram_subject
identity_source
identity_as_of
```

For grouped Polymarket thresholds, `group_item_title` is not a standalone
event title. The publish record for market `2758338` must retain enough parent
context to render `NO on BTC hitting $70K in July`.

Fail closed when a compact child label cannot be joined to a canonical parent
event. Emit a diagnostic instead of publishing `NO on ↑ 70,000`.

Audit ingestion and stored rows for event `655630` and market `2758338` to find
whether the loss occurs during Polymarket ingestion, unified-market mapping,
holder-note persistence, or the publication query.

### 2. Persist a structured meaningful delta

Add a versioned research-update reason to the note/publication contract. A
suggested shape is:

```json
{
  "version": 1,
  "primaryReason": "position_increased",
  "reasons": [
    {
      "kind": "position_increased",
      "before": 5200,
      "after": 7500,
      "unit": "usd",
      "asOf": "2026-07-17T00:00:00Z"
    }
  ],
  "baselineNoteId": "uuid",
  "baselineAsOf": "2026-07-16T00:00:00Z"
}
```

Allowed initial reason kinds:

- `position_increased` or `position_reduced`;
- `holder_entered` or `holder_exited`;
- `price_moved_with_thesis` or `price_moved_against_thesis`;
- `holder_persisted_after_material_move`;
- `wallet_confluence_changed`;
- `side_flow_increased` or `side_flow_reversed`, with an explicit side and
  signed before/after values;
- `new_external_evidence`.

Each reason must carry typed before/after values where applicable. Free-form
model copy such as `repeat read`, `still interesting`, or `after the drop` is
not a meaningful delta.

### 3. Gate publication on the delta

Publish a `research_update` only when:

- the canonical market identity is complete;
- at least one allowed reason passes a versioned materiality threshold;
- the change is newer than the previous delivered note;
- the same reason/baseline pair has not already been delivered;
- the generated thesis can name the change in user-facing language.

Position persistence by itself is insufficient. It becomes publishable only
when tied to a material price move, elapsed decision point, or new evidence.

Generic market-wide activity is also insufficient for directional copy.
`fresh_flow` must remain suppressed until the contract carries the affected
side, signed net amount, time window, and source events.

Persist the selected reason and threshold revision in the signal copy audit so
operators can explain every notification.

The final backend delta should replace the renderer's temporary reconstruction
from two snapshots. Do not make Telegram independently reinterpret business
materiality once the versioned typed delta exists.

### 4. Use one price snapshot contract

Persist a single snapshot used by the producer and renderer:

```text
as_of
yes_bid
yes_ask
yes_mark
no_bid
no_ask
no_mark
display_side
display_price
display_price_source: bid | ask | midpoint | last
```

Generated prose must not independently round or reinterpret price. If the
headline shows `NO at 83¢`, body copy should either use the same NO value or
explicitly say `YES trades around 17¢` from the same snapshot.

### 5. Tighten generated-copy inputs

Pass the model the canonical subject and selected structured delta. Require the
summary to explain that delta, not restate the current holding twice.

Reject or regenerate public copy containing:

- `repeat read` or equivalent internal review language;
- ambiguous movement phrases such as `after the drop` without a named metric;
- claims of new research when no `new_external_evidence` reason exists;
- negative evidence boilerplate;
- a child market label without the canonical event context.

## Observability and Repair

Add counters and an audit query for:

- missing parent event identity;
- research updates without meaningful-delta metadata;
- rejected duplicate delta/baseline pairs;
- price snapshot side mismatches;
- generated-copy regeneration reasons.

Backfill complete identity for undelivered notes when the venue mapping is
unambiguous. Do not replay already delivered updates automatically.

## Acceptance Criteria

- The incident fixture renders the complete Bitcoin, `$70K`, July, and NO
  proposition; `NO on ↑ 70,000` cannot reach public delivery.
- Every delivered research update has a persisted primary reason, typed delta,
  baseline, materiality-policy revision, and price snapshot.
- The notification headline communicates that primary reason.
- A repeat holding with no material delta produces no notification.
- `New research` is used only for a sourced `new_external_evidence` reason.
- Market-wide `recentActivityUsd` cannot produce a selected-side flow headline
  or Buy CTA; directional flow requires a signed side-attributed contract.
- Price percentages and cents in headline/body are side-consistent and share
  one `as_of` timestamp.
- Integration tests cover missing event joins, stale baselines, duplicate
  deltas, persistence after a material move, new external evidence, and the
  Bitcoin `$70K in July` incident fixture.

## Dependencies

- `backend-signal-post-copy-v4.md` (filename retained for handoff stability;
  content is V5) for canonical Telegram presentation and
  structured evidence;
- holder-research note lineage and quality-gate ownership;
- Polymarket event/market ingestion ownership.

## Out of Scope

- choosing more aggressive FOMO wording without a verified delta;
- inventing a canonical parent from title similarity alone;
- changing Mini App deep-link payloads.
