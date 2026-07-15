# Backend Task: Notification-First Signal Headlines

Status: ready for backend implementation  
Priority: P0 before the next public-channel copy rollout  
Depends on: normalized market identity and current follow-through metrics

## Goal

Make the first line of every public Telegram signal post read like a useful,
compelling news alert. Before opening Telegram, a user should understand:

1. which exact market proposition this is about;
2. what happened to it;
3. how large or relevant the move is.

The headline must sell the significance of a verified fact. It must not tease
without context, abbreviate the market into ambiguity, imply causation that the
data does not prove, or present aggregate estimated PnL as realized profit.

## Research Basis

Telegram's documented `CHANNEL_MESSAGE_TEXT` push template is `{channel name}:
{message body}`. Hunch does not control a separate APNs title/body for a normal
channel post, so the beginning of the Telegram message is the notification
lead:

- [Telegram push notification structure](https://core.telegram.org/api/push-updates#possible-notifications)

Apple recommends concise, informative notifications that provide enough
context to be useful without opening them. Apple also notes that display and
truncation vary by surface and device:

- [Apple notification design guidance](https://developer.apple.com/design/human-interface-guidelines/notifications/)
- [Apple abbreviated notification layout](https://developer.apple.com/documentation/usernotificationsui/customizing-the-appearance-of-notifications)

Newsroom research favors informative alerts with additional context over
generic headlines or information-withholding teasers:

- [Columbia Journalism Review: mobile alerts and newsroom voice](https://www.cjr.org/tow_center_reports/push-mobile-alerts-brand-breaking-news.php)

## Current State

`SIGNAL_BOT_COPY_FLOW_HEADLINES` contains hooks such as:

- `More wallets are moving into this trade`;
- `This call is starting to get copied`;
- `People are quietly joining this side`.

Cooling and flat-price cases have some semantic selection, but most positive
hooks are selected from a stable hash for variety. The exact market and the
actual movement appear later. A notification may therefore show excitement
without telling the user what market moved or by how much.

The current copy version is `signal_bot_copy_v3`.

## Editorial Model: Market, Event, Result

The market proposition is the subject of the headline. The first line follows
normal news syntax:

```text
{market proposition} + {change verb} + {verified result}
```

For the example:

```text
Event: Fed Decision in July?
Outcome: No change
Entry: 80¢
Current: 91¢
Net copy flow: +$1.1M
```

Recommended headline:

```text
🔥 July Fed “no change” jumps 11¢ to 91¢
```

The market is recognizable, the outcome is explicit, and the user sees both
the move and current level. `+$1.1M net copy flow` remains the first supporting
fact in the evidence block.

If price is flat and flow is the actual news:

```text
🔥 July Fed “no change” draws $1.1M in net copy flow
```

Do not write:

```text
🔥 YES +11¢ on Fed: No change
🔥 +$1.1M copy flow into Fed: No change
```

Those versions expose internal market syntax, reduce the market to the generic
word `Fed`, and force the reader to reconstruct what YES means.

## Market Proposition Contract

Do not build the notification subject by blindly truncating event and market
titles. Add a structured `notificationSubject`/`telegramSubject` to the neutral
signal view, sourced from normalized market metadata.

Examples:

| Raw market identity                          | Side | Notification subject                        |
| -------------------------------------------- | ---- | ------------------------------------------- |
| `Fed Decision in July? · No change`          | YES  | `July Fed “no change”`                      |
| `President Trump to Attend World Cup Final?` | YES  | `Trump attending the World Cup final`       |
| `President Trump to Attend World Cup Final?` | NO   | `NO on Trump attending the World Cup final` |
| `Total goals · Under 2.5`                    | YES  | `Under 2.5 total goals`                     |
| `Bitcoin above $150K by December 31?`        | YES  | `Bitcoin above $150K by Dec. 31`            |
| `Bitcoin above $150K by December 31?`        | NO   | `NO on Bitcoin above $150K by Dec. 31`      |

Rules:

- preserve the distinguishing subject, outcome/threshold, and deadline;
- for a multi-outcome event, lead with the selected outcome plus enough event
  context;
- for a YES position on a natural proposition, omit redundant `YES`;
- for NO, use `NO on ...` unless a verified normalized complementary
  proposition exists;
- never invent the logical opposite of a complex market at render time;
- never shorten to a generic entity such as `Fed`, `Trump`, `Bitcoin`, or a
  team name without the contract-defining predicate;
- if a safe compact subject is unavailable, use `YES/NO on “shortened full
market title”` and retain the distinguishing tail;
- runtime LLM output must not become an unaudited notification subject.

Prefer storing the normalized subject with provenance/version when the signal
or market metadata is created. If AI assists generation, validate it against
structured event, outcome, threshold, and deadline fields before activation.

## Story Selection

Select the headline from the strongest understandable story, not merely the
largest formatted number.

### 1. Material price move

Price is the clearest outcome for a general reader. Include both delta and
current price:

```text
🔥 July Fed “no change” jumps 11¢ to 91¢
📈 Trump attendance rises 6¢ to 72¢
👀 Trump attendance edges up 2¢ to 95¢
```

Verb intensity must correspond to configured, tested movement bands and the
measurement horizon. Do not call every positive tick a surge.

### 2. Flow before price

When price has not moved materially but net flow is strong:

```text
🔥 July Fed “no change” draws $1.1M in net copy flow
👀 Under 2.5 goals draws $380K while holding at 70¢
```

Use `with`, `while`, or `draws`; avoid causal phrasing such as `because of`
unless causality is actually established.

### 3. Participation is the story

When neither price nor flow meets the stronger threshold but wallet breadth is
meaningful:

```text
👀 32 wallets build July Fed “no change” positions
```

This template is lower priority because `wallets joined` is less immediately
valuable than a verified market move.

### 4. Divergence or cooling

Do not force every notification to sound positive:

```text
⚠️ July Fed “no change” slips 6¢ despite $420K inflow
⚠️ July Fed “no change” flow cools at 91¢
```

A credible negative update protects long-term trust and makes positive alerts
more believable.

### 5. Resolution

```text
🏁 July Fed “no change” wins
🏁 Trump attendance loses
```

Exact payout or realized PnL may appear only with
`accountingComplete = true` from
`backend-position-resolution-accounting.md`.

### 6. Initial signal

An initial signal has no since-call performance. Lead with the proposition,
call, and executable/current entry:

```text
🔥 Hunch calls July Fed “no change” at 80¢
👀 Hunch flags Trump attendance at 93¢
```

## PnL Policy

Do not use estimated tracked-wallet open PnL as the primary v4 headline. A
large value such as `+$208K` is compelling but can be mistaken for user profit,
realized profit, or verified wallet accounting.

It may remain in the evidence block as:

```text
Tracked wallets’ est. open PnL  +$208K
```

If product later tests it in a headline, the text must include both `Est.` and
`tracked-wallet`, and it must rank below verified price movement and net flow.

## Preview-Length Strategy

Do not choose a universal hard character cap from an assumed iPhone width.
Telegram prefixes the channel name, and iOS display varies by device, font
size, notification surface, preview settings, and OS version.

Instead:

- keep the headline to one source line;
- put the complete market proposition and result before optional supporting
  clauses;
- use 80 visible grapheme clusters as an initial lint target, not as permission
  to make an ambiguous substring;
- compact/rewrite the proposition semantically rather than cutting its tail;
- let the OS perform final visual truncation;
- establish the release budget from actual device fixtures, then record it as
  a versioned renderer constraint.

If a safe proposition cannot fit the tested budget, remove the secondary
metric first. Never remove the contract-defining outcome, threshold, or date.

## Implementation Shape

Introduce two typed builders before Telegram Markdown rendering:

```text
buildSignalNotificationSubject(market) -> {
  text
  source
  preservedFields
  version
}

buildSignalNotificationHeadline(input) -> {
  text
  storyKind
  templateKey
  primaryMetric
  supportingMetric
  subjectVersion
  visibleLength
}
```

The input uses structured side, event, outcome, threshold, deadline, price
move, current price, copy flow, wallet counts, resolution state, horizon, and
data-quality flags. Do not parse rendered message strings back into facts.

Store story kind, template, subject version/source, metrics, rendered length,
and copy version in the existing message copy audit. Increment the copy version
for rollout and analytics.

## Device Preview and Metrics

Add preview fixtures for:

- positive 1¢, 5¢, and 10¢+ moves;
- large flow with flat price;
- wallet participation without material price movement;
- adverse price move despite positive flow;
- cooling flow;
- resolved win/loss;
- YES and NO sides;
- long deadlines, thresholds, candidate names, sports outcomes, and Unicode;
- estimated PnL present and absent.

Review fixtures on iOS Lock Screen, Notification Center, banner, Android, and
Telegram Desktop. Capture channel name length, device, font size, Telegram
preview setting, and copy version.

Track:

- story/template distribution;
- subject fallback and ambiguity rate;
- preview lint failures;
- message views where available;
- body-link and CTA click-through by copy version;
- Buy initiation/completion by story kind.

## Acceptance Criteria

- A user can identify the exact proposition and what changed from the first
  line without reading the body.
- Headline syntax is market subject -> event/change -> result.
- Generic/hash-selected hooks are removed when structured facts exist.
- No subject collapses to a generic entity or loses outcome, threshold, or
  deadline meaning.
- Price-move stories show delta and current price.
- Flow stories distinguish net copy flow from price and do not claim causation.
- Estimated open PnL is not a primary v4 headline.
- Headline source contains no link and no newline.
- Snapshot tests cover story priority, both sides, negative values, duplicate
  titles, long propositions, Unicode, and safe fallbacks.
- Device QA confirms that the market and result appear in the notification
  preview under representative channel-name and font-size conditions.
- Copy audit and analytics distinguish the new version from v3.

## Out of Scope

- controlling how iOS hides notification previews for a user's privacy
  settings;
- changing the Telegram channel name shown by the operating system;
- fabricating urgency, causation, or gains not supported by structured facts;
- exact user payout/PnL before settlement accounting is complete.
