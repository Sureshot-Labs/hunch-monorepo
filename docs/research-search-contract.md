# Research search handoff

## Contract rules and internal briefs

Holder research preserves complete market/event descriptions and resolution
sources from the loaded database row through V1/V2 triage, search and final
prompts. Search V2 carries the rules once under `contract`; the `market`
object contains identifiers/presentation context, not a second clipped copy.

`externalResearch.summary` is an **internal research brief**, not public feed
copy. The Grok generation schema permits up to 2048 characters and three
citations. The ingestion parser preserves complete older/overlong briefs and
valid citation records; it does not silently cut a contrary fact or throw away
a source solely because its title exceeds the generation limit. Deviations
are recorded in schema diagnostics. Provider-source matching still applies.
The public signal summary remains limited to 320 characters.

Selected background summaries reach holder triage/search/final intact, with
their existing provenance and caution labels. Maps retains the complete
selected prior-evidence briefs between searches. Holder search now defaults
to 8 turns and 2400 output tokens; explicit runtime-policy overrides still
take precedence. Maps limits, reasoning effort, item-count limits,
provider-call limits, spend controls and publication gates are unchanged.
Full rules and deeper search can increase token usage and cost.

## Shared Grok boundary

Both holder research and Maps use `buildXaiSearchResponseFormat`:

- Responses API `text.format` with `json_schema` and `strict: true`;
- `include: ["no_inline_citations"]`, leaving provider source metadata intact;
- existing local schema/semantic validation after generation.

Provider-constrained JSON is not factual verification. Source matching means
the URL appeared in the provider's retrieved-source metadata; it does not
prove that every generated claim is entailed by that page. Same-page fragments
and equivalent X post IDs are accepted; unrelated query strings/pages are not.
Maps reports source-match counts diagnostically; this change does not add a
new publication or evidence-acceptance veto to Maps.

Diagnostic metadata records HTTP status, response/request IDs, actual model,
completion/incomplete reason, provider error code/type/parameter, token/cost
usage, found/parsed/source-matched citation counts, schema issue paths/codes,
and rejected optional-field reasons. Null counts mean not parsed, not zero
sources. Holder failures retain encountered provider URLs. Diagnostics do not
record raw prompts, reasoning, generated claims or provider error bodies.

The prompts request direct article/statement links, honest date precision,
and explicitly distinguish “not found in searched sources” from proof that
an event never occurred. These are model instructions, not deterministic
truth guarantees.

## Persistence reporting

Run totals now distinguish:

- `persistedPublished`: committed directional notes;
- `persistedContext`: committed context notes;
- `persisted`: their sum.

`published` remains the directional persisted count for compatibility;
`publishDecisions` and `context` remain decision counts, not persistence
counts. `persistence` retains detailed directional outcomes and
`contextPersistence` exposes considered/persisted/unchanged/invalid/error
counts separately. Context does not consume the directional publication cap.

## Verification

Regression coverage lives in `holder-research-tests.ts`,
`holder-research-prompt-contract-tests.ts`,
`holder-research-publication-progress-tests.ts`,
`research-search-contract-tests.ts` and `ai-provider-support-tests.ts`.
It covers rules beyond old clipping boundaries, full briefs into the actual
final-model request, source verification before display limits, partial/error
responses, intact URL recovery, and public-copy length limits.

Provider formats follow the [xAI structured-output contract](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
and [citation controls](https://docs.x.ai/developers/tools/citations).
The OpenAI Docs check confirmed the existing final-stage required-property
and strict-object mapping against [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs);
the existing final provider format was retained.
