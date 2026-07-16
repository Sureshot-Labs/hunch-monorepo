# Backend Task: Complete and Roll Out Signal Post V4

Status: renderer implemented locally; backend data contract and live QA remain  
Priority: P0 before the next public-channel copy rollout  
Owner: backend / signal platform

## Goal

Ship public Telegram signal posts that read as useful market alerts in the
notification preview and remain internally consistent after opening the post.
The locally implemented V4 renderer is the baseline. This task is not a request
to rebuild its formatting from scratch.

## Implemented Baseline

The current worktree contains:

- `signal_bot_copy_v4` and `signal_notification_subject_v2` copy audits;
- notification-first headlines with money, momentum, confluence,
  participation, cooling/divergence, research, and resolution stories;
- `💰` for material capital, `📈`/`📉` for price, `🎯` for strong-wallet
  alignment, `👀` for early evidence, `⚠️` for deterioration, and `🔥` only
  when strong price and capital evidence agree without contrary breadth;
- natural Bitcoin price-target and total-market subjects plus safe generic
  fallbacks that do not invent the opposite of a NO contract;
- one standalone, non-linked headline with no duplicate `📍` market block;
- structured `Since the call`, `Wallet edge`, and `The edge` blockquotes with
  a blank quote line below the section label and highlighted values;
- context-aware follow-through conclusions that acknowledge mixed breadth,
  exits, adverse moves, or thin evidence;
- contextual Mini App links on natural market/wallet mentions, with no generic
  `Market details` or `Wallet context` footer;
- Buy-only CTA behavior when trading is available and Open-market fallback when
  it is not;
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

## Post Grammar

Follow-through:

```text
💰 $67.7K net flow backs NO on BTC hitting $57.5K in July

> Since the call
>
> Net flow  +$67.7K
> Wallets  5 added · 8 trimmed · 15 holding
> NO price  87¢ → 89¢  +2¢
> Est. PnL  +$1.6K

NO at 89¢ moved with the call; net flow stays positive, but more wallets
trimmed than added.
```

Initial signal:

```text
🎯 4 strong wallets back Bilibili Gaming at 46¢

<one concise thesis; natural market/wallet phrases may be Mini App links>

<one concise current-position sentence when it adds information>

> The edge
>
> ▸ Track record  +$340K · 30d
> ▸ Conviction  4 strong wallets · same side
> ▸ Capital tracked  $29.4K
```

The body must not reprint the market title immediately below the headline. It
must not end with generic navigation chrome. If a market or wallet link has no
natural body location, omit the body link; the CTA may still provide the route.

## Remaining Backend Work

### 1. Canonical Telegram market identity

Add a reviewed, versioned presentation contract to normalized market metadata:

```text
telegramSubject
telegramShortPosition
canonicalOutcomeLabel
displayAliases[]
predicate
threshold
deadline
provenance
version
reviewStatus
```

This is required for cases the renderer cannot safely infer, including `BGL`
versus `BLG`, abbreviated team names, event-specific outcomes, and complex NO
contracts. Runtime title similarity or free-form LLM text must not silently
become canonical copy.

Acceptance:

- one reviewed label is used in headline, thesis, evidence, button, and audit;
- aliases from outside research are normalized before rendering;
- unknown/conflicting aliases fail to a safe raw proposition and emit a metric;
- threshold, direction marker, and deadline cannot disappear during compaction.

### 2. Structured evidence instead of prose parsing

Expose typed evidence rows rather than only `credentialBullets` and external
summary prose:

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

The local formatter recognizes a small set of legacy credential sentences for
backward compatibility. That parser is not the long-term data contract.

Acceptance:

- `+$5.2K representative position` and `$29.4K cluster capital` cannot be shown
  as if they were the same measure;
- `46¢ Hunch price` and `56–60% external implied probability` carry explicit
  sources and comparable units;
- outside context appears once: integrated into the thesis or as one evidence
  row, never repeated as an unstructured footer sentence;
- evidence with stale/unknown scope is omitted rather than embellished.

### 3. Versioned materiality policy

Review the local starting thresholds (`$10K` material net flow and `5¢` strong
price move) against production distributions. Move approved thresholds into a
typed runtime policy by market segment if needed. Persist the effective policy
version in the copy audit.

Do not tune for click-through alone. Guardrails must track misleading-headline,
cooling, divergence, and correction rates.

### 4. Live device and channel QA

Send fixtures to a private test channel and review iOS Lock Screen,
Notification Center, banner, Android, and Telegram Desktop in light/dark mode.
Cover:

- the three examples above;
- long market subjects, Unicode, named outcomes, totals, and complex NO;
- initial single wallet and wallet cluster;
- mixed breadth, exits, negative flow, adverse price, and thin evidence;
- research update and resolved win/loss;
- Mini App configured, missing, and oversized payload;
- Buy available and Open-market fallback.

Capture device, channel-name length, font size, Telegram preview setting, copy
version, and screenshot. Record whether the proposition and primary fact
survive the preview.

### 5. Rollout telemetry

Track by copy/policy version:

- story/template distribution;
- subject source, fallback, conflict, and over-80 lint rates;
- body-link and CTA click-through;
- Buy initiation and completion;
- delivery failures and Markdown parse failures;
- cooling/divergence frequency after positive initial alerts.

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
- Device fixtures pass and rollout telemetry distinguishes V4 from older copy.

## Out of Scope

- inventing urgency, causation, aliases, or profit claims;
- user realized PnL before settlement accounting is complete;
- trusted cross-venue equivalence, owned by
  `backend-trusted-market-mappings.md`;
- persistent channel destinations, owned by
  `backend-signal-channel-registry.md`.
