# Backend Task: Roll Out Signal Post V10

Status: V10 editorial-headline pass and producer/delivery contracts implemented locally; live device QA remains
Priority: P0 before the next public-channel copy rollout
Owner: backend / signal platform

The filename is retained so existing handoff links do not break. V10 turns the
first line into editorial “cover copy”: it chooses the strongest verified human
tension instead of forcing every signal through the same metric-first card.

## Goal

Ship public Telegram signal posts that read as useful market alerts in the
notification preview and remain internally consistent after opening the post.
The locally implemented V10 renderer is the baseline. This task is not a request
to rebuild its formatting from scratch.

## Implemented Baseline

The current worktree contains:

- `signal_bot_copy_v10`, `signal_notification_subject_v3`,
  `telegram_market_presentation_v1`, and `signal_evidence_v1` copy audits;
- a typed two-part first line: `emoji + bold cover hook + regular payoff`; the
  LLM does not control emoji, Markdown, or story priority;
- an editorial angle selector for low-probability bets, crowd-versus-wallet
  disagreement, favourite-versus-contrarian matchups, unusually large
  positions, losing positions that credible wallets have not left, late-stage
  cash-outs, and adverse price-target moves;
- `📈`/`📉` only for actual price direction; initial stories may use `🏆`,
  `⚽`, `🪙`, `🌐`, or `🗳️` for recognisable winner, matchup, price-target,
  geopolitical, or election context; `🔥` marks a strong fade/against angle,
  and `🏁` marks resolution;
- natural Bitcoin price-target and total-market subjects plus safe generic
  fallbacks that do not invent the opposite of a NO contract;
- one standalone, non-linked headline with no duplicate `📍` market block;
- native Rich Message delivery with a two-part headline paragraph, contextual
  inline links, bordered striped `Since the call`, `Why it matters`, and
  `Result` tables, plus a native divider before a follow-through `Read:`;
- no quote/pull-quote blocks and no invisible separators in the primary rich
  output; the existing MarkdownV2 renderer remains an automatic fallback;
- contextual named-outcome headlines such as `Spain over Argentina` and
  `Beta Team over Alpha Team in Game 1`, instead of notification leads that
  contain only the selected outcome;
- deterministic removal of generated initial-copy sentences that merely repeat
  the current price, holding state, or a generic `worth a look` recommendation;
- follow-through materiality gates that suppress tiny contradictory updates
  such as `+$345`, two adds, one trim, one exit, and an adverse one-cent move;
- divergence-safe headline selection: adverse price or mixed wallet breadth
  cannot produce `backs` / `builds behind` copy;
- message-family-specific endings: proof card for initial signals, `Read:` for
  follow-through, and `Result` for resolution;
- research updates rendered from producer-owned `holderResearchUpdateV1`, with
  fail-closed suppression when no supported change can be proved;
- research updates omit stable wallet credentials and distinguish a single
  `Wallet position` from aggregate `Strong-wallet support`;
- research delta rendering preserves producer-owned `before`, `after`, and
  `scope`, so a lower strong-wallet count is never described as a proved sale
  or exit;
- totals are normalized idempotently: an already canonical `Under 2.5 total
goals` cannot become `Under 2.5 total goals 2.5 total goals`;
- internal sports collection suffixes such as `- More Markets` are removed from
  all public title and body paths;
- public team subjects prefer the actual proposition (`Spain to win the World
Cup`) over the internal contract side (`YES on Spain`);
- literal `No summary.` is never persisted or rendered; totals receive a safe
  deterministic win-condition sentence when generated prose is unavailable;
- a verified positive recent PnL may lead or qualify an initial single-wallet
  or sharp-cluster hook; the exact value remains available in `Why it matters`
  because the rounded headline is the promise and the body is the proof;
- cluster NO headlines state the complete proposition and qualify the displayed
  price as `NO at 92¢`, rather than attaching `92¢` ambiguously to the event;
- incomplete entity-only subjects such as `NO on Argentina` fail closed until
  winner/event context can produce a complete proposition;
- near-resolution moves can lead with early-holder behaviour instead of a raw
  confluence card: `Mbappé reached 99¢ ... 22 early wallets are already cashing
out`; “early” counts only wallets that had a baseline position at the call;
- cluster “down but still holding” headlines use a cluster-scoped open-PnL
  aggregate, not the open PnL of all wallets on the side;
- follow-through estimated PnL is labeled `Est. PnL since call`; research state
  uses `Wallet open PnL` and explains that wallet entry and signal publication
  are different starting prices when the two measures point in opposite
  directions;
- zero price deltas and rounded-zero estimated PnL are omitted instead of being
  rendered as `+0¢` / `$0` evidence;
- follow-through reuses the initial message's persisted canonical market
  identity, including named outcomes and spread labels;
- context-aware follow-through conclusions that acknowledge mixed breadth,
  exact exits, adverse moves, or thin evidence;
- contextual Mini App links on natural market/wallet mentions, with no generic
  `Market details` or `Wallet context` footer;
- Buy-only CTA behavior when trading is available; neutral/negative research
  updates use Open market, and positive research updates still pass the normal
  execution/price guard before Buy;
- deterministic tests for the renderer and story priority.

Primary files:

- `apps/api/src/services/signal-notification-headline.ts`;
- `apps/api/src/services/signal-bot.ts`;
- `apps/api/src/signal-notification-headline-tests.ts`;
- `apps/api/src/signal-bot-tests.ts`.

V10 itself requires no database migration. `emoji`, `hook`, `continuation`,
`primaryEvidenceId`, `evidenceKindsUsed`, story/template, and copy version are
persisted inside the existing JSON copy audit. Existing
notification/preferences migrations are a separate rollout concern. New
Holder Research notes also persist `clusterOpenPnlUsd` inside existing target
metadata JSON; older notes safely fall back to another headline angle.

## Headline Contract

The first source line is the Telegram/iOS notification lead. It is structured,
not one generated bold string:

```text
<semantic emoji> **<clickbait cover hook>.** <plain payoff>.
```

Select the strongest verified story. FOMO comes from a recognisable market,
credible money, a low probability, disagreement, persistence, or a real exit —
not from invented urgency. The title is allowed to compress scope editorially;
the body must immediately provide the exact actor, value, timeframe, and side.

Priority and examples:

```text
⚽ **+$542K in 30 days.** This wallet is backing Spain over Argentina with $20.5K.
🏆 **Argentina has just a 17% chance of winning the World Cup.** Four wallets
up nearly $1M are still backing Argentina.
🔥 **Messi has only an 8% chance of winning the Golden Boot.** Two profitable
wallets are betting against Messi.
⚠️ **Mbappé reached 99¢ to win the Golden Boot.** 22 early wallets are already
cashing out.
📉 **Bitcoin is moving closer to $67.5K.** This wallet still refuses to flip.
📉 **+$43K bought. −1¢ anyway.** Spain and tracked wallets still disagree.
🔥 **+$45K bought. +7¢.** Spain is moving with tracked wallets.
⚠️ **3 exits. $31K sold.** Tracked support for Spain is weakening.
📈 **+8¢ to 67¢.** Spain is moving with the call.
🏁 **Spain won.**
```

Rules:

- treat the bold hook like YouTube thumbnail copy: maximise the desire to open
  the post, while staying faithful to structured facts;
- prefer a strong number at the front when it is the best hook, but do not let
  that mechanical rule suppress a stronger human event such as early wallets
  cashing out or a wallet refusing to flip;
- keep only the hook bold; the continuation stays regular weight;
- lead a strong single-wallet or verified sharp-cluster initial signal with
  recent performance when it is more attention-worthy than position size;
- abbreviate cover metrics for impact (`$967.8K` → `nearly $1M`) and repeat the
  exact value and combined/single-wallet scope in the body;
- lead with capital when net flow is material and price is secondary;
- lead with price when price movement is the actual story;
- vary semantic emoji by story and market; never use one emoji as a literal
  synonym for “attention” across every post;
- reserve `📈`/`📉` for actual price movement, not buys/sells;
- keep the side, predicate, threshold/outcome, and deadline needed to identify
  the contract;
- never infer a complementary NO proposition without a verified mapping;
- never ship an entity-only side such as `NO on Argentina`; require enough
  context to say what Argentina is not expected to do;
- show whole cents consistently in headline and body;
- do not headline estimated open PnL;
- do not link the headline;
- keep 80 visible graphemes as a lint target, not a destructive truncation
  rule;
- never use unchanged current state (`still holds`, position size, or stable
  credentials) as the event in a research-update headline.
- never use `📈` to mean buying or `📉` to mean selling. That collides with the
  price meaning and can produce a visually false `📈 … −1¢` headline.

## Post Grammar

Follow-through:

```text
⚠️ **+$67.7K bought. 8 wallets cut.** Tracked wallets remain split on NO on
BTC hitting $57.5K in July.

> Since the call
>
> Net tracked flow  +$67.7K
> Wallets  5 added · 8 trimmed · 15 holding
> NO price  87¢ → 89¢  +2¢
> Est. PnL since call  +$1.6K

Read: More money went into NO at 89¢, but wallet support thinned and the price
barely moved.
```

Initial signal:

```text
⚽ **+$542K in 30 days.** This wallet is backing Spain over Argentina with
$20.5K.

<one concise thesis; natural market/wallet phrases may be Mini App links>

> Why it matters
>
> ▸ Recent results  +18.4 pts vs market · 24 resolved bets
> ▸ PnL  +$542K · 30d
> ▸ Traded  $2.9M · 30d
```

The body intentionally repeats the exact PnL. The rounded headline earns the
open; the proof card establishes precise scope and prevents a phrase such as
“four wallets up nearly $1M” from being read as $1M per wallet.

Research update:

```text
📉 **Bitcoin is moving closer to $67.5K.** This wallet still refuses to flip.

<one concise explanation of what changed and why it matters>

The wallet entered before this signal, so its open PnL and the −11¢ move since
the call use different starting prices.

Wallet position: $5.8K on NO · 61¢ now · Wallet open PnL +$1.5K
```

Do not repeat `Why it matters` in a reply to the original signal: the wallet's
track record is stable context, not the update. A research update without a
supported comparable price, selected-side position, or selected-side strong
wallet-count delta is not rendered. Market-wide `recentActivityUsd` is not a
directional flow contract and cannot produce `backs YES/NO` copy or a Buy CTA.

Resolution:

```text
🏁 NO on <proposition> wins

> Result
>
> Entry  83¢
> Resolution  NO $1.00
> Move  +17¢
```

Do not append another sentence saying the call “closed green/red”; the result
card already completes the story.

The body must not reprint the market title immediately below the headline. It
must not end with generic navigation chrome. If a market or wallet link has no
natural body location, omit the body link; the CTA may still provide the route.

## V10 Backend Contract

### 1. Canonical Telegram market identity

The reviewed presentation contract is stored in
`unified_markets.metadata.hunch.telegramPresentationV1`:

```text
subject
predicate
threshold
deadline
positions.YES|NO.canonicalLabel
positions.YES|NO.shortLabel
positions.YES|NO.aliases[]
provenance
version
reviewStatus
```

This is required for cases the renderer cannot safely infer, including `BGL`
versus `BLG`, abbreviated team names, event-specific outcomes, and complex NO
contracts. Runtime title similarity or free-form LLM text must not silently
become canonical copy.

At Holder Research persistence, the reviewed presentation (when complete) or
a self-contained canonical market identity is frozen as
`metrics.telegramMarketIdentityV1`. Compact child labels require parent event
context. Delivery validates this frozen identity against the exact source
market and selected side; it does not reconstruct a parent using similarity or
an LLM.

Acceptance:

- one reviewed label is used in headline, thesis, evidence, button, and audit;
- aliases from outside research are normalized before rendering;
- unknown/conflicting aliases fail to a safe raw proposition and emit a metric;
- threshold, direction marker, and deadline cannot disappear during compaction.

### 2. Structured evidence instead of prose parsing

New notes persist typed evidence rows rather than relying on
`credentialBullets` and external summary prose:

```text
kind: track_record | pricing_edge | volume | conviction | capital | outside_odds
value
unit
horizon
sampleSize
scope: representative_wallet | wallet_cluster | external_market
source
asOf
quality
```

The isolated `legacy-signal-evidence` adapter recognizes a small set of old
credential sentences only when a stored note has no typed evidence contract.
Versioned new notes, including an intentionally empty evidence array, never
fall back to prose parsing.

Acceptance:

- `+$5.2K representative position` and `$29.4K cluster capital` cannot be shown
  as if they were the same measure;
- `46¢ Hunch price` and `56–60% external implied probability` carry explicit
  sources and comparable units;
- outside context appears once: integrated into the thesis or as one evidence
  row, never repeated as an unstructured footer sentence;
- evidence with stale/unknown scope is omitted rather than embellished.

### 3. Versioned materiality policy

The local starting thresholds (`$10K` material net flow, `$1K` single-wallet
position, `2¢` minimum move, `5¢` strong move, and `80`-grapheme lint target)
live in the full-snapshot `signal_post_copy` runtime policy. The effective
revision is persisted in copy audit. Operator review against production
distributions remains required before public rollout.

Do not tune for click-through alone. Guardrails must track misleading-headline,
cooling, divergence, and correction rates.

### 4. Typed research-update delta

New Holder Research notes now persist one versioned typed delta carrying the
baseline, before/after values, selected side, unit, `as_of`, fingerprint, CTA
intent, and deterministic materiality-policy revision. The renderer consumes
that contract and no longer reconstructs business materiality from two
decision snapshots.

Legacy updates without the contract, `force_recheck`,
`related_position_changed`, holder-set rotation, market-wide `fresh_flow`, and
external-evidence-only changes fail closed. See
`backend-holder-research-update-contract.md`.

`/test_signal [channel_id] [latest|initial|update|note_uuid]` uses the same copy
contracts and renderer as the public publisher, returns a concrete diagnostic
reason when rejected, and does not move Redis cursors, write
`signal_bot_messages`, or set a send cooldown. For layout QA only, it may render
an otherwise valid old signal with a stale price snapshot. That bypass is
scoped to the test command and always removes `Buy` in favor of `Open market`;
the public publisher still fails closed on the same stale snapshot.

### 5. Live device and channel QA

Send fixtures to a private test channel and review iOS Lock Screen,
Notification Center, banner, Android, and Telegram Desktop in light/dark mode.
Cover:

- the editorial headline examples above;
- long market subjects, Unicode, named outcomes, totals, and complex NO;
- initial single wallet and wallet cluster;
- mixed breadth, exits, negative flow, adverse price, and thin evidence;
- table captions, borders, striping, wrapping, alignment, and divider spacing;
- confirmation that the primary rich output contains no visible quotation
  glyph and no invisible placeholder row;
- deliberate Rich Message rejection to confirm automatic MarkdownV2 fallback
  and `fallbackToMarkdown` delivery telemetry;
- research update and resolved win/loss;
- Mini App configured, missing, and oversized payload;
- Buy available and Open-market fallback.

Capture device, channel-name length, font size, Telegram preview setting, copy
version, and screenshot. Record whether the proposition and primary fact
survive the preview.

### 6. Rollout telemetry

V10 records the following by copy/policy version; production validation is
still required:

- story/template distribution;
- subject source, fallback, conflict, and over-80 lint rates;
- body-link and CTA click-through;
- Buy initiation and completion;
- delivery failures and Markdown parse failures;
- cooling/divergence frequency after positive initial alerts.

Mini App market and Buy payloads may carry the opaque
`signal_bot_messages.id` as `deliveryRef`. Frontend analytics expose it as
`signal_delivery_ref`; chat IDs are never included.

## Acceptance Criteria

- The notification preview identifies the market and the verified event.
- Money, momentum, confluence, and cooling examples select the intended story.
- `🔥` never represents an isolated 2¢ tick or unsupported initial opinion.
- No post contains a duplicate market identity block or generic link footer.
- Headline and evidence use one canonical outcome label and compatible units.
- Representative-wallet and aggregate-cluster values have explicit scopes.
- External evidence is structured, sourced, fresh, and rendered at most once.
- Production posts and buttons contain Mini App links, not direct
  `app.hunch.trade` links.
- Research updates with no supported meaningful delta produce no notification.
- Stable wallet credentials are not repeated in research-update replies.
- Public posts never expose `- More Markets`, literal `No summary.`, or a
  duplicated total label.
- A wallet-count change reports only the count change and remaining support;
  it does not invent a sale or exit event.
- Aggregate cluster support and one-wallet position state have different
  labels and keep their producer-owned scope.
- Market-wide activity cannot masquerade as selected-side flow.
- Open follow-through posts end in `Read:` and terminal posts end in `Result`.
- Device fixtures pass and rollout telemetry distinguishes V10 from older copy.

## Out of Scope

- inventing urgency, causation, aliases, or profit claims;
- user realized PnL before settlement accounting is complete;
- trusted cross-venue equivalence, owned by
  `backend-trusted-market-mappings.md`;
- persistent channel destinations, owned by
  `backend-signal-channel-registry.md`.
