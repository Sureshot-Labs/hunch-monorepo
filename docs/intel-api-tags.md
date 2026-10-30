# Intel API tags (v1)

Additive display metadata for existing Intel posts. Tags do not select signals,
create posts, change feed order, permit trades, or trigger notifications/models.
Telegram follow-ups are not new application feed entries in this release.

## Endpoints and client rendering

- `GET /hunches`: `items[].tags`, `primaryTag`, `tagsVersion`.
- `GET /hunches/:noteId`: the same fields on `item`.
- `GET /social/feed`: the same fields on `kind: "hunch"` items, not user theses.
- The shared social response schema also documents these fields wherever it is
  reused. Existing user/market thesis-only routes stay thesis-only; no new Intel
  records are added to them.

`tags` is a discriminated union by `code`; labels are stable English display
labels. Clients may localize by code. Show `primaryTag` as the main badge;
additional tags are optional UI. Unknown codes should be ignored by older clients.
An empty array with `primaryTag: null` is valid; do not invent a fallback badge.
`tagsVersion` is `1`. Older servers/responses without these fields should render
without badges. Existing filters, pagination, `strength`, `selectedSideResult`,
comments and `canCopy` retain their meanings.

Priority: `winning_bet`; otherwise a validated tag corresponding to the saved
update's primary reason; otherwise `wallet_activity`, `new_evidence`,
`price_update`, `top_trader`. Each code appears at most once. The primary tag is
first; the remaining tags follow that stable fallback order.

## Meanings and evidence

| Code / label                        | Required evidence                                                                                                                 | What it does **not** mean                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `top_trader` / Top Trader           | Positive same-side shares and saved historical `strong` qualification for the featured holder or qualified cluster at publication | Verified identity, realized profit, guaranteed smart trade, or a fresh purchase                           |
| `wallet_activity` / Wallet Activity | Material share-quantity changes between exact, comparable saved publication snapshots; saved thresholds                           | USD repricing, inferred trade execution, a missing row as an exit, or changed qualification as a purchase |
| `winning_bet` / Winning Bet         | Canonical YES/NO winner matching the published signal side and instrument generation                                              | Price reaching 100%, a proposal, fractional/void settlement, or proof the trader held until payout        |
| `price_update` / Price Update       | Saved, validated material price change for the selected side                                                                      | A wallet transaction or realized PnL                                                                      |
| `new_evidence` / New Evidence       | Validated new external fact and its source present in the public citation serializer                                              | Any new link, repeated story, AI rephrasing, or an independently verified forecast                        |

Historical tags describe **this revision**, not the wallet's current activity.
Current wallet metrics never retroactively turn an old post into Top Trader.
Winning Bet is checked against current canonical resolution, subject to the
existing short list cache. A losing outcome remains `selectedSideResult: "LOSS"`;
it is not filtered out. Context and legacy posts without adequate structured
evidence legitimately have no tags. No backfill or cache flush is needed.

### Top Trader

```json
{
  "code": "top_trader",
  "label": "Top Trader",
  "basis": {
    "side": "NO",
    "scope": "representative_wallet",
    "qualifiedWalletCount": 1,
    "atPublication": "2026-10-29T12:00:00.000Z",
    "qualification": "saved_historical_qualification"
  }
}
```

`scope` can also be `wallet_cluster`; the count is wallets, not verified distinct
owners. It is not a new ranking. `atPublication` is the saved evaluation time
(or note creation time for an initial post), not today's metrics timestamp.

### Wallet Activity

```json
{
  "code": "wallet_activity",
  "label": "Wallet Activity",
  "basis": {
    "source": "observed_position_quantity_change",
    "baselineAt": "2026-10-28T12:00:00.000Z",
    "observedThrough": "2026-10-29T12:00:00.000Z",
    "sides": [
      {
        "side": "NO",
        "increasedWallets": 4,
        "reducedWallets": 3,
        "exitedWallets": 2
      },
      {
        "side": "YES",
        "increasedWallets": 1,
        "reducedWallets": 0,
        "exitedWallets": 0
      }
    ]
  }
}
```

Counts are disjoint per side: `reducedWallets` excludes `exitedWallets` (explicit
zero shares). A wallet can occur on both sides; do not sum them as unique owners.
An omitted side has no qualifying **observed** change, not proof of no activity.
The counts cover comparable saved holders, not every wallet or trade in a market.
Use “observed position changes”, not “confirmed buys/sells” or “net inflow”.
The comparison also preserves reductions by formerly qualified holders.

### Winning Bet

```json
{
  "code": "winning_bet",
  "label": "Winning Bet",
  "basis": {
    "side": "NO",
    "result": "WIN",
    "source": "canonical_market_resolution"
  }
}
```

No settlement timestamp is invented. The badge says the highlighted outcome won,
not that a trader or follower realized a particular return.

### Price Update

```json
{
  "code": "price_update",
  "label": "Price Update",
  "basis": {
    "side": "NO",
    "before": 0.5,
    "after": 0.6,
    "baselineAt": "2026-10-28T12:00:00.000Z",
    "observedAt": "2026-10-29T12:00:00.000Z",
    "direction": "with_thesis"
  }
}
```

Values are probabilities for the named side, not percentages. The example is
50¢ → 60¢ (+10 percentage points); it is not the current executable ask.
`direction` can be `against_thesis`.

### New Evidence

```json
{
  "code": "new_evidence",
  "label": "New Evidence",
  "basis": {
    "side": "NO",
    "eventAt": "2026-10-29T10:00:00.000Z",
    "sourcePublishedAt": "2026-10-29T10:05:00.000Z",
    "source": {
      "id": "https://example.org/official-update",
      "headline": "Official update",
      "url": "https://example.org/official-update"
    }
  }
}
```

Render text as text, never model HTML. The source is from the same public-safe
citation list as research, not raw model metadata. Dates describe the evidence,
not a future market catalyst.

## Combinations, compatibility and operations

A post may have Top Trader + Wallet Activity + Price Update. A saved price-first
reason makes Price Update primary, even if activity is also present. Once its
selected outcome officially wins, Winning Bet becomes primary; historical tags
remain. An unchanged holding with no qualified history can return:

```json
{ "tags": [], "primaryTag": null, "tagsVersion": 1 }
```

The read path uses bounded, batched PK lookups of already selected notes and exact
baseline IDs. It does not query position history, change policies or write to
PostgreSQL. Failures in optional enrichment preserve the post; failed enrichment
is not retained in the hunch list cache. Missing evidence is not an API error.
No raw snapshots, internal wallet IDs, model prompts or private relationships
are returned in tag bases. No tag-specific filtering is added in v1.

## Verification

- `node --import tsx src/intel-tags-tests.ts` (also Bun).
- `node --import tsx src/intel-tags-route-tests.ts` (also Bun).
- `node --import tsx src/intel-tags-openapi-tests.ts --compare` (also Bun).
- The full local `apps/api/openapi.json` is gitignored. Use the same contract test
  with `--write` to generate/update these operations before `--compare`; ordinary
  contract verification also works without a pre-existing generated file.
- `intel-tags-integration-tests.ts`: explicitly fenced disposable PG16 database
  `hunch_intel_test_20261029`, local Redis on port 6380, transaction-scoped temp
  tables and a unique expiring Redis key. `INTEL_TAG_TEST_SCALE=1000000` exercises
  exact SQL custom/generic plans for 0/1/20/50/100 cards against unrelated history.
  It tests actual hunch list/detail and SocialService hydration, cursor stability,
  transient recovery, and preservation of all non-tag response fields.

Run full workspace build/typecheck/lint and independent review before release.
Synthetic local query measurements are not production p95 measurements.

Local validation on 2026-10-30: PG16, one million unrelated notes, markets and
tokens, existing primary-key index shapes. Custom and generic plans for all five
batch sizes used indexed lookups (no full table scans). For 100 notes, the main
tag-input SQL took 2.1–2.4 ms and baseline SQL 0.6–0.8 ms. End-to-end 100-card tag
hydration p95 in the local test was 11.6 ms under Node and 8.8 ms under Bun 1.4.4.
These measure the added enrichment, not the entire feed endpoint.
