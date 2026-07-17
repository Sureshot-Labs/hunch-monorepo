# Backend Task: Roll Out Signal Post V6

Status: V6 renderer and producer/delivery contracts implemented locally; live device QA remains
Priority: P0 before the next public-channel copy rollout
Owner: backend / signal platform

The filename is retained so existing handoff links do not break. V6 supersedes
the V5 grammar documented in earlier revisions.

## Goal

Ship public Telegram signal posts that read as useful market alerts in the
notification preview and remain internally consistent after opening the post.
The locally implemented V6 renderer is the baseline. This task is not a request
to rebuild its formatting from scratch.

## Implemented Baseline

The current worktree contains:

- `signal_bot_copy_v6`, `signal_notification_subject_v3`,
  `telegram_market_presentation_v1`, and `signal_evidence_v1` copy audits;
- notification-first headlines with money, momentum, confluence,
  participation, cooling/divergence, research, and resolution stories;
- `💰` for material capital, `📈`/`📉` for price, `🎯` for strong-wallet
  alignment, `👀` for early evidence, `⚠️` for deterioration, and `🔥` only
  when strong price and capital evidence agree without contrary breadth;
- natural Bitcoin price-target and total-market subjects plus safe generic
  fallbacks that do not invent the opposite of a NO contract;
- one standalone, non-linked headline with no duplicate `📍` market block;
- structured `Since the call`, `Wallet edge`, and `The edge` blockquotes with
  a forced visual blank line below the section label and highlighted values;
- a centralized `U+2800 BRAILLE PATTERN BLANK` separator because Telegram
  clients collapse raw empty MarkdownV2 lines around blockquotes;
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
- research updates omit stable wallet credentials and use a plain `Wallet now`
  or `Cluster now` line only as current context;
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

## Headline Contract

The first source line is the Telegram/iOS notification lead. Select the
strongest verified story, not the most dramatic word.

Priority and examples:

```text
💰 $67.7K net flow backs NO on BTC hitting $57.5K in July
📈 NO on BTC hitting $70K in July rises 6¢ to 81¢
🎯 4 strong wallets back Bilibili Gaming at 46¢
🔥 $45K backs YES on <proposition> after a 7¢ move
⚠️ <proposition> is losing wallet support
⚠️ 3 wallets exit <proposition>
🏁 <proposition> wins
```

Rules:

- lead with capital when net flow is material and the price move is small;
- lead with price when the price move is strong and flow is small;
- use `🔥` only for two independent strong confirmations and no contrary
  wallet breadth;
- keep the side, predicate, threshold/outcome, and deadline needed to identify
  the contract;
- never infer a complementary NO proposition without a verified mapping;
- show whole cents consistently in headline and body;
- do not headline estimated open PnL;
- do not link the headline;
- keep 80 visible graphemes as a lint target, not a destructive truncation
  rule.
- never use unchanged current state (`still holds`, position size, or stable
  credentials) as the event in a research-update headline.

## Post Grammar

Follow-through:

```text
💰 $67.7K net flow backs NO on BTC hitting $57.5K in July

> Since the call
>
> Net tracked flow  +$67.7K
> Wallets  5 added · 8 trimmed · 15 holding
> NO price  87¢ → 89¢  +2¢
> Est. open PnL  +$1.6K

Read: NO at 89¢ moved with the call; net flow stays positive, but more wallets
trimmed than added.
```

Initial signal:

```text
🎯 4 strong wallets back Bilibili Gaming at 46¢

<one concise thesis; natural market/wallet phrases may be Mini App links>

> The edge
>
> ▸ PnL  +$340K · 30d
> ▸ Conviction  4 strong wallets · same side
> ▸ Capital tracked  $29.4K
```

Research update:

```text
📈 NO on BTC hitting $70K in July rises 8¢ to 83¢

<one concise explanation of what changed and why it matters>

Wallet now: $7.5K on NO at 83¢ · Est. open PnL +$829
```

Do not repeat `Wallet edge` in a reply to the original signal: the wallet's
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

## V6 Backend Contract

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

`/test_signal [channel_id] [latest|initial|update|note_uuid]` uses the same
delivery preparation as the public publisher, returns a concrete diagnostic
reason when rejected, and does not move Redis cursors, write
`signal_bot_messages`, or set a send cooldown.

### 5. Live device and channel QA

Send fixtures to a private test channel and review iOS Lock Screen,
Notification Center, banner, Android, and Telegram Desktop in light/dark mode.
Cover:

- the three examples above;
- long market subjects, Unicode, named outcomes, totals, and complex NO;
- initial single wallet and wallet cluster;
- mixed breadth, exits, negative flow, adverse price, and thin evidence;
- the `U+2800` row before/inside/after a blockquote, including copying the
  rendered post to confirm that no visible placeholder glyph appears;
- research update and resolved win/loss;
- Mini App configured, missing, and oversized payload;
- Buy available and Open-market fallback.

Capture device, channel-name length, font size, Telegram preview setting, copy
version, and screenshot. Record whether the proposition and primary fact
survive the preview.

### 6. Rollout telemetry

V6 records the following by copy/policy version; production validation is
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
- Market-wide activity cannot masquerade as selected-side flow.
- Open follow-through posts end in `Read:` and terminal posts end in `Result`.
- Device fixtures pass and rollout telemetry distinguishes V6 from older copy.

## Out of Scope

- inventing urgency, causation, aliases, or profit claims;
- user realized PnL before settlement accounting is complete;
- trusted cross-venue equivalence, owned by
  `backend-trusted-market-mappings.md`;
- persistent channel destinations, owned by
  `backend-signal-channel-registry.md`.
