# Backend Design: Human X Drafts in a Private Telegram Channel

Status: V1 implemented locally; production channel setup and live editorial QA remain

Scope: holder-research signal copy and Telegram delivery
Decision: no database migration is required for the first production version

## Product Decision

Hunch must not publish to X/Twitter automatically and must not send these drafts
to a personal Telegram account. The existing signal bot will publish them to one
separate private Telegram channel. A manager will review each draft, optionally
edit it, copy it, and publish it to X manually.

The channel is an editorial inbox, not another public signal feed. Its message
text must therefore be a ready-to-paste human post, not a Telegram signal card
with different spacing.

Non-negotiable behavior:

- the normal Telegram channels keep their current V11 copy and presentation;
- the private editorial channel receives a separate X editorial copy profile;
- the bot still sends through Telegram only;
- there is no X API transport, scheduled X post, or personal DM in this flow;
- the manager remains the final human reviewer and publisher;
- copy must sound like a human analyst, but it must not invent a first-person
  experience, identity, trade, source, or opinion that Hunch cannot support;
- a failed or unavailable X composer must fail closed. It must never fall back
  to the normal Telegram card in the editorial channel.

## Executive Answer on Database Migrations

The first implementation can and should be shipped **without a new database
migration**.

The current storage already provides the required primitives:

1. `ai_notes.metrics` and `ai_notes.model_meta` are JSONB. The producer already
   stores versioned signal contracts, evidence, market identity, price snapshot,
   holder credentials, external-research metadata, and copy inputs there.
2. `signal_bot_messages.metrics` is JSONB and can store the generated editorial
   draft, model/prompt version, fact digest, validation result, retry status, and
   delivery audit.
3. Delivery dedupe is already `unique (chat_id, note_id, message_kind)`. The new
   editorial destination has its own `chat_id`, so the same note can go once to
   a normal signal channel and once to the private editorial channel without a
   new key or constraint.
4. Channel configuration is currently a schemaless Redis hash. Adding a
   backward-compatible `contentProfile` field does not require a migration.
5. V1 composer settings are environment configuration. They add no database
   state, and the channel ID remains runtime channel state rather than an env
   variable or secret.

This decision is intentionally narrower than the separate reliability task in
`docs/telegram/backend-signal-channel-registry.md`. Moving channel registration,
profiles, and cursors from Redis to Postgres does require a migration, but that
work is not caused by X drafts and must not block their first rollout.

A dedicated `signal_editorial_drafts` table becomes justified later if product
needs an approval workflow, multiple saved revisions, editor identity and edits,
regeneration history, multiple editorial profiles for one destination, or a
standalone editorial UI. It is unnecessary for a single private channel where
the manager edits and publishes outside Hunch.

## Reference Review: What “Human” Means Here

The manager reference `Twitter format .docx` contains 52 embedded screenshots
of existing X accounts. It is a visual mood/reference collection rather than a
machine-readable copy specification. The useful recurring patterns are:

- open with one concrete event, action, amount, price, or result;
- identify the actor naturally and explain why that actor is interesting;
- use only the few numbers that make the story, not an analytics dump;
- move from fact to interpretation and end on a memorable implication;
- use short paragraphs and varied sentence length;
- treat evidence screenshots or links as proof, not as a substitute for prose;
- avoid hashtags and promotional/affiliate calls to action;
- use emoji rarely and semantically, not as a fixed signal template;
- write a self-contained story instead of exposing internal labels such as
  `holder_research`, `sharp_cluster`, `bucket`, `z-score`, or `signal detected`.

The screenshots suggest four useful editorial story families:

1. **Fresh bet:** a trader or group has just taken or built a meaningful
   position.
2. **Trader profile:** the present bet is interesting because a verified track
   record or prior behavior gives it context.
3. **Strategy/case study:** enough history exists to explain a repeatable
   behavior rather than one isolated position.
4. **Receipt/result:** the market moved, wallets added/exited, or the thesis
   resolved and there is a concrete outcome to report.

These are story choices, not templates whose wording should repeat. The
composer should select one primary story and omit facts that do not help it.

Some reference accounts use claims such as “insider”, “AI bot”, or “cheat code”
as facts. Hunch must not copy that behavior. Unless independently verified, the
safe version is an attributed observation or an explicitly marked inference:
“the timing stands out”, “the position appeared before the move”, or “there is
no evidence that proves access to non-public information.” The post must never
upgrade correlation into knowledge, causation, or an accusation.

The desired target length and whether the target X account supports long posts
still need to be confirmed before the prompt is frozen. The implementation must
therefore use a configurable character limit and produce one standalone draft.
The configured limit must also stay within Telegram's message limit used by the
current transport. Thread generation can be added later only if product asks
for it explicitly.

## Current Signal Lifecycle

The current flow has three distinct stages. They must stay distinct after this
feature is added.

```text
market/wallet data
  -> holder-research candidates
  -> live position, price, holder and market-type enrichment
  -> triage and optional external research
  -> final LLM assessment/copy
  -> deterministic publication-quality gate
  -> ai_notes + targets + evidence
  -> per-channel publisher
  -> Telegram-specific renderer
  -> Telegram transport
  -> signal_bot_messages delivery audit
```

### 1. Candidate creation and publication decision

`runHolderResearch` in `apps/api/src/ai-holder-research-run.ts` loads and ranks
candidates, enriches live state, optionally performs external research, calls
the model, and then applies the deterministic publication gate. It persists
only when the run is not dry, persistence is enabled, and the model path is in
use.

`buildHolderResearchCandidatesFromMarket` in
`apps/api/src/services/holder-research.ts` derives several evidence buckets,
including sharp-side/minority reads, clean disagreement, recent flow, event
bridges, concentration risk, and meaningful follow-ups.

`applyHolderResearchPublishQualityGate` is the final authority. Among other
checks, it blocks stale or missing prices, unusable horizons, non-directional
or context-only reads, weak actors, unsupported single-holder crypto stories,
conflicting public context, and changes that are already fully explained.

The existing holder-research prompts already ask for concise, natural trader
language and forbid Markdown, emoji, analytics labels, invented credentials,
and unsupported public claims. However, their output is deliberately only a
short headline plus one or two short “why now” sentences because Telegram owns
the final hook, tables, proof rows, links, and CTA. That output is source
material for the X composer, not a complete X post.

### 2. Signal persistence

`persistHolderResearchNotes` writes accepted signals to `ai_notes`, determines
whether the note is `initial` or `research_update`, prevents duplicate updates,
and stores versioned contracts. The useful X inputs already include:

- canonical selected-side market identity;
- a fresh selected-side price snapshot;
- initial or research-update lineage and meaningful deltas;
- holder actor mode and verified credential evidence;
- position size, open PnL, cluster totals, and market context;
- validated external-research verdict, timing, summary, and citations;
- publication decision, quality flags, and evidence identifiers.

These values live in normal columns plus `metrics` and `model_meta`. The X
composer must consume these structured facts. It must not parse the rendered
Telegram message, because that would preserve Telegram's hook/table/CTA shape
and lose the distinction between facts, inference, and presentation.

### 3. Per-channel Telegram delivery

`loadSignalBotNotes` reads eligible active holder-research notes and materializes
a rich `SignalBotNote`. `publishSignalBotTick` then iterates the enabled Redis
chat set. Every chat currently passes through the same
`prepareSignalBotDelivery` and `buildSignalBotMessage` path.

`buildSignalBotMessage` is a Telegram renderer. It adds the notification hook,
Markdown/rich-message blocks, price and credential proof, market links, and CTA.
It also treats any non-private Telegram chat as a public destination for one of
its quality checks. A private Telegram channel still has chat type `channel`,
so privacy cannot be inferred from `chatType` and cannot select the new format.

Channel registration and cursors currently live in Redis:

```text
tg:signal_bot:v1:enabled_chats
tg:signal_bot:v1:chat:{chat_id}
```

Before this implementation, the hash stored title/type, enable metadata, cursor,
and destination-venue policy. V1 adds one backward-compatible content-profile
field; old hashes still parse as the normal Telegram profile.

`publishSignalBotFollowthroughTick` is a separate path for
`followthrough_stats`, `resolved_win`, and `resolved_loss`. It has its own
Telegram renderer. Supporting only `publishSignalBotTick` would therefore leak
standard Telegram result cards into the editorial channel later.

Finally, `apps/api/src/services/signal-delivery.ts` contains
`renderXSignalDelivery`, but it only breaks the generic delivery view into
length-limited chunks. It is not wired to publish and it does not create the
human editorial style from the reference. It should not be used for this
feature.

## Target Architecture

```text
                                      +-> telegram_signal_v11 renderer
ai_notes -> common fact/eligibility --|
                                      +-> x_editorial_draft_v1 composer
                                            -> factual/style validation
                                            -> durable draft in existing
                                               signal_bot_messages.metrics
                                            -> copyable Telegram draft package
                                            -> manager review/copy/edit
                                            -> manual X publication
```

### Explicit channel content profile

V1 extends `SignalBotChatState` with:

```ts
type SignalBotContentProfile = "telegram_signal_v11" | "x_editorial_draft_v1";

type SignalBotChatState = {
  // existing fields
  contentProfile: SignalBotContentProfile;
};
```

Parsing old Redis hashes must default to `telegram_signal_v11`. Writing the hash
adds one `contentProfile` string. Never infer this value from `chatType`, channel
title, username, or whether the channel is public/private.

V1 adds the authorized admin command:

```text
/signal_profile x_editorial_draft_v1 <channel_id>
/signal_profile telegram_signal_v11 <channel_id>
```

`/status [channel_id]` must display the effective profile. Enabling a channel
continues to start its cursor at `now`, so the editorial channel does not dump
historical signals on first enable.

A channel has one active profile. Changing the profile affects new notes only;
it is not a historical replay mechanism.

### Separate editorial composer

V1 uses a service separate from `buildSignalBotMessage`:

```text
apps/api/src/services/x-editorial-draft.ts
```

The service accepts a normalized, allowlisted fact packet rather than the
entire database row. Its input families are:

- `initial` and `research_update`: `SignalBotNote`, canonical identity, price
  snapshot, research delta, verified actor evidence, and safe citations;
- `followthrough_stats`, `resolved_win`, and `resolved_loss`: the existing
  follow-through candidate plus the computed `SignalBotFollowthroughStats`;
- policy: language, character limit, supported message kinds, prompt version,
  and style guard settings;
- recent editorial openings: a small set used only to discourage repetitive
  hooks and phrasing.

The model returns strict JSON, not free-form transport markup:

```ts
type XEditorialDraftV1 = {
  version: 1;
  status: "ready" | "blocked";
  marketId: string;
  selectedSide: "YES" | "NO";
  postText: string | null;
  formatting: Array<{
    style: "bold" | "italic";
    text: string;
  }>;
  storyFamily:
    | "fresh_bet"
    | "trader_profile"
    | "case_study"
    | "followthrough"
    | "resolution";
  usedFactIds: string[];
  safetyFlags: string[];
  characterCount: number;
  generatedAt: string;
  model: string;
  promptVersion: "x_editorial_prompt_v2";
  sourceDigest: string;
};
```

`postText` is the only body text the manager should copy. `formatting` contains
one to three exact, unique snippets to select and format in the X Premium editor
after pasting. The snippets remain outside `postText`, because X rich-text
entities cannot be encoded in a plain Telegram code-block copy operation.

### Composition rules

The prompt and deterministic validators must enforce all of the following:

- choose one story and one point of tension;
- start from the strongest supported human detail, not a fixed template;
- use natural English and short paragraphs;
- preserve the canonical proposition and selected side;
- keep every amount, price, count, PnL, timeframe, and result consistent with
  the fact packet;
- distinguish a position snapshot from a proved buy, add, exit, or entry time;
- distinguish market movement since signal from the trader's lifetime PnL;
- describe public information only through validated verdict/timing/citations;
- use verified track record only with its exact scope and horizon;
- never claim “insider”, coordinated behavior, private knowledge, an AI bot, or
  causation without direct evidence;
- never invent first-person experience such as “I found”, “I bought”, “we
  called”, or “our trader”;
- no Markdown markers inside `postText`, Telegram section labels, proof tables,
  Buy/Open CTA, affiliate language, hashtags, or generic engagement bait;
- return one to three exact non-overlapping snippets for intentional bold or
  italic formatting in X; do not bold the whole post;
- no internal product vocabulary or raw wallet addresses in visible text;
- do not repeat the same hook pattern across consecutive drafts;
- do not imitate one referenced author. Reuse the editorial principles, not a
  recognisable person's exact phrasing or persona;
- return `blocked` when a coherent post requires a fact that is not supplied.

Human-like copy should come from story selection, rhythm, and judgment, not
from fake typos, slang injection, random emoji, or pretending to be a person
who placed the trade.

### Deterministic validation after the model

The model is not the publication authority. Validate before Telegram send:

1. strict schema parse;
2. non-empty, normalized text and configured character limit;
3. no Markdown, hashtags, CTA, addresses, internal labels, or banned claim
   patterns;
4. all `usedFactIds` exist in the supplied packet;
5. numeric tokens are traceable to facts declared in `usedFactIds`, including
   compact currency and probability representations such as `$56.4K` and
   `19%`;
6. the returned market ID and selected side exactly match the source contract;
7. every bold/italic snippet occurs exactly once in `postText`, is single-line,
   and does not overlap another formatting span;
8. initial/update/follow-through semantics match the actual message kind;
9. recent successful openings are supplied to discourage repetition without
   changing the persisted source digest.

If validation fails, one constrained repair call is acceptable. If the repair
also fails, persist a blocked audit and send nothing. Do not substitute the
short holder-research summary or normal Telegram renderer.

### Generate once and reuse on retry

Generating inside every send attempt would make retries non-deterministic and
waste model calls. The editorial profile persists `editorialDraftV1` in the
existing `signal_bot_messages` row before Telegram send. A retry loads that row
and reuses the exact text when the prompt version and source digest match.

Persisted metrics shape:

```json
{
  "status": "prepared",
  "contentProfile": "x_editorial_draft_v1",
  "editorialDraftV1": {
    "version": 1,
    "postText": "...",
    "formatting": [{ "style": "bold", "text": "..." }],
    "promptVersion": "x_editorial_prompt_v2",
    "sourceDigest": "..."
  }
}
```

On success, update the same row to `status: sent` and retain the exact draft.
On Telegram failure, retain it as `send_failed`; the next attempt reuses the
same text when prompt version and source digest match. The existing unique key
and the runner's Redis singleton lock protect the normal duplicate-tick path.
As with the existing Telegram sender, a process crash after Telegram accepts a
message but before the success audit is committed remains an unavoidable narrow
at-least-once delivery window.

The draft belongs in `signal_bot_messages.metrics`, not in
`ai_notes.metrics`, for v1: it is destination-profile copy, generated after the
canonical note exists, and its delivery/retry lifecycle is per channel. The
canonical signal note should remain channel-agnostic.

### Telegram representation for the editorial channel

Send one standalone MarkdownV2 editorial package:

1. `postText` inside a Telegram preformatted code block, which gives the manager
   the native one-tap copy affordance without copying operational metadata;
2. one line per X formatting span, showing the exact snippet rendered as bold
   or italic so the manager knows what to select in the X Premium editor;
3. a visible `🌐 Website` deep link to the market on `app.hunch.trade` with X
   campaign attribution;
4. a visible `📱 Telegram Mini App` deep link to the same market.

Do not use an inline keyboard, normal signal card, Buy/Open CTA, reply thread,
evidence table, or disclaimer. Website and Mini App URLs stay outside the
copyable code block so the manager can long-press and copy whichever link is
appropriate for the final post.

### All message families must be routed explicitly

The profile branch must exist in both publishers:

- `publishSignalBotTick`: `initial`, `research_update`;
- `publishSignalBotFollowthroughTick`: `followthrough_stats`, `resolved_win`,
  `resolved_loss`.

Preferred implementation is one composer with story-family-specific fact
packets and prompts for all five kinds. If initial rollout intentionally covers
only initial/update drafts, the follow-through worker must explicitly exclude
`x_editorial_draft_v1` channels. Silently sending the current Telegram
follow-through renderer is a release blocker.

## Runtime Configuration

V1 uses service environment configuration:

```text
HUNCH_SIGNAL_BOT_X_EDITORIAL_ENABLED=false
HUNCH_SIGNAL_BOT_X_EDITORIAL_MODEL=openai/gpt-5.5
HUNCH_SIGNAL_BOT_X_EDITORIAL_MAX_CHARACTERS=1000
HUNCH_SIGNAL_BOT_X_EDITORIAL_MAX_PARAGRAPHS=5
HUNCH_SIGNAL_BOT_X_EDITORIAL_MAX_OUTPUT_TOKENS=700
```

The model provider uses the existing `OPENROUTER_API_KEY`; that key is secret.
The editorial Telegram channel ID is not secret and does not belong in the
environment. It is registered at runtime with `/enable_signals` and
`/signal_profile twitter`.

In the current production topology, non-secret settings are read from
`/opt/hunch/.env`. Runtime secrets for the `signal-bot` container come from
`HUNCH_SECRET_BUNDLES_SIGNAL_BOT`, which loads the shared, signal-bot, ops, and
AI AWS Secrets Manager bundles. `OPENROUTER_API_KEY` is supplied by
`/hunch/prod/ai`; it is not a GitHub Actions channel setting. No channel ID is
hardcoded or stored as a deployment secret.

After deployment, an authorized bot admin configures the destination from a
private bot chat:

```text
/enable_signals <channel_id>
/signal_profile twitter <channel_id>
/status <channel_id>
```

The 1,000-character default is a rollout starting point, not a permanent
product limit. Confirm the target account's desired post length during live QA.
The model and prompt version are stored with every generated draft. A database
runtime policy can replace env settings later if non-developer live tuning
becomes necessary; it is not needed for V1.

## Common Eligibility Versus Channel Presentation

Do not duplicate or weaken the holder-research publish gate. The editorial
channel must receive only the same accepted directional signals that are
eligible for normal publishing.

The following remain common prerequisites:

- accepted holder-research publication decision;
- complete canonical market identity;
- selected-side consistency;
- fresh price snapshot at signal creation/delivery;
- valid research-update delta when the kind is `research_update`;
- no disabled source venue;
- material follow-through thresholds for follow-through posts.

Destination trade routing, cheaper-alternative selection, Buy CTA eligibility,
and Mini App presentation are Telegram-product concerns. They must not rewrite
the editorial story or add a trade CTA. Refactor the common identity/freshness
checks out of `prepareSignalBotDelivery` if necessary, then let each profile
perform its own presentation-specific preparation.

## Implemented File-Level Changes

1. `apps/api/src/services/signal-bot.ts`
   - add and validate `SignalBotContentProfile`;
   - round-trip `contentProfile` in Redis with the Telegram default;
   - add the profile admin command and show it in `/status`;
   - branch both initial/update and follow-through publishers;
   - add editorial reservation/load/update helpers using
     `signal_bot_messages.metrics`;
   - send a copyable MarkdownV2 draft package with no inline keyboard;
   - include visible website and Mini App market deep links below the body;
   - keep current V11 paths byte-for-byte behaviorally unchanged for the
     default profile.
2. `apps/api/src/services/x-editorial-draft.ts`
   - define strict model output and versioned persisted contract schemas;
   - implement prompts, OpenRouter/repair calls, numeric and style validation,
     source digest, and persisted-draft parsing;
   - consume story-family-specific fact packets built by the publisher for
     initial, update, follow-through, and resolution.
3. `apps/api/src/signal-bot-command-parsers.ts`
   - parse `/signal_profile <telegram|twitter> [channel_id]` and aliases.
4. `apps/api/src/signal-bot-runner.ts`
   - wire the real composer dependency and feature flag;
   - expose counters and normalized errors without logging the full draft when
     logs are not an approved content store.
5. `.env.example` and `ops/.env.prod.example`
   - document non-secret composer settings and the existing provider key.
6. Tests
   - cover composer/schema validation, formatting spans, repair, Redis profile
     compatibility, copy-block delivery, both links, persistence, and retry
     reuse.

## Test Coverage and Remaining QA

Implemented deterministic tests cover:

- old Redis channel hashes parse as `telegram_signal_v11`;
- both profiles parse and round-trip, unauthorized users cannot switch them,
  and `/status` reports the active profile and composer state;
- the editorial channel receives exact `postText` inside a copyable block, X
  formatting guidance, both visible links, no inline keyboard, and no trade CTA;
- invalid or unsafe first output receives one constrained repair;
- unsafe claims, fake first-person voice, unsupported numeric claims, market
  mismatch, and side mismatch fail validation;
- a successful draft is persisted, sent using only MarkdownV2 presentation, and
  not composed or sent again on the next tick;
- `insider`, fake first-person experience, raw addresses, internal labels,
  Markdown, hashtags, and generic promotional CTA are rejected;
- recent openings do not change the canonical source digest.

The existing signal-bot suite remains the regression layer for authorization,
normal Telegram formatting, cursor behavior, channel disable behavior, update
contracts, and follow-through policy. Production rollout still requires the
manual editorial QA below.

Manual QA before production:

- collect a representative batch across sports, politics, crypto, totals,
  named outcomes, single traders, and clusters;
- have the manager score factual accuracy, naturalness, edit distance before
  posting, and whether the hook is worth opening;
- inspect every safety flag and every model-repair case;
- compare repeated openings and sentence structures across the batch;
- confirm exact copy/paste behavior from Telegram into the target X account;
- confirm the final length mode and whether one post is always required.

Useful rollout metrics can be stored/read from existing JSONB and logs:

- drafts attempted, ready, blocked, repaired, sent, and retried;
- block reason and validation rule;
- model latency, token use, and cost;
- prompt/policy revision;
- character count and story-family distribution;
- repeated-opening lint rate;
- Telegram send errors by channel;
- later, if the manager provides feedback, edit-distance and rejection reason.

## Rollout

1. Deploy the implemented code with the feature disabled by default.
2. Confirm `OPENROUTER_API_KEY` is loaded from `/hunch/prod/ai` into the
   signal-bot process and enable the non-secret environment feature flag for a
   closed QA period.
3. Create the private Telegram channel, add the bot with post permission, run
   `/enable_signals <channel_id>`, then `/signal_profile twitter <channel_id>`.
   Enabling starts the cursor at the current time and does not backfill.
4. Review a meaningful sample with the manager and tune the prompt/config,
   keeping every generated revision in the delivery audit.
5. Release for normal manager use while preserving manual review and manual X
   publication.
6. Separately schedule the Postgres channel-registry migration if Redis-loss
   reliability is a production concern.

## Acceptance Criteria

- one accepted signal can produce normal Telegram copy and a different human X
  draft in separate channels;
- the X draft is composed from structured facts before Telegram presentation,
  not rewritten from the Telegram card;
- the draft body is immediately copyable and contains no formatting guidance,
  links, or operational metadata inside the copied block;
- the manager, not Hunch, performs the X publish action;
- normal channels are unchanged;
- unsafe or unverifiable copy fails closed;
- retries are stable and do not spend a new model call or change the text;
- no normal follow-through card can leak into the editorial channel;
- all profile, prompt, fact, validation, and delivery versions are auditable in
  existing storage;
- the feature launches without a new database migration.

## When a Migration Should Be Added Later

Add a dedicated editorial-draft table only when at least one of these becomes a
real requirement:

- an in-product approve/reject/edit workflow;
- multiple editors and an audit of who changed what;
- several saved draft revisions or A/B candidates per signal;
- regeneration after delivery while preserving every prior version;
- multiple X brands/languages/personas for the same signal and destination;
- reporting that needs indexed draft fields rather than JSONB scans;
- media/screenshot production with its own asset lifecycle;
- automatic X publication with publish state and external post IDs.

When the planned durable `signal_bot_channels` registry is implemented, include
`content_profile` (or a versioned profile payload) in that migration and import
the current Redis value. That is a reliability migration, not a prerequisite
for the editorial channel described here.

## Out of Scope

- automatic X/Twitter API publishing;
- sending drafts to an individual Telegram DM;
- copying or impersonating one reference account's exact voice;
- generating fake screenshots or unsupported proof;
- weakening signal eligibility to create more social content;
- changing the existing public Telegram V11 format;
- implementing the separate persistent channel-registry task.
