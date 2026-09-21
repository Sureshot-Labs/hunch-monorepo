# Embedding quality evidence — 2026-09-21

## Method and cost

- Frozen public snapshot: 873 event cards, generated 2026-09-20 13:45 UTC.
- Fixed queries: 36 English and 12 Russian, labelled before observing results.
- Separate Similar fixture: 12 synthetic queries against 36 closely related
  contracts, including dates, amounts, directions and first-five-innings/full-game
  distinctions. These are not production users' searches or trades.
- Fresh vectors for **every** tested variant; existing production vectors were
  not reused. Both initial variants and all ablations used OpenRouter
  `intfloat/e5-large-v2`, reported explicitly in every provider response.
- Actual E5 comparison cost: **$0.00101643** (initial $0.00042357 + ablations
  $0.00059286), within the $0.05 maximum. The two separate one-text Qwen adapter
  probes below cost $0.00000050. The subsequently authorized full Qwen comparison
  cost $0.00027808 against its additional $0.02 cap. Cumulative paid cost is
  **$0.00129501**.

Reports contain per-query top-three candidates, target rank, target-vs-best-other
margin, token usage, cost, latency and reported model:

- `fixtures/public-quality-v1-result.json`
- `fixtures/public-quality-v1-ablation-result.json`
- `fixtures/public-quality-v1-qwen-result.json`

## Results

Counts below use the original exact target IDs, unchanged across variants.

| Variant                                            | English @1 / 36 | English @3 / 36 | Russian @1 / 12 | Russian @3 / 12 | Similar @1 / 12 | Similar @3 / 12 |
| -------------------------------------------------- | --------------: | --------------: | --------------: | --------------: | --------------: | --------------: |
| Legacy fields / passage, plain news query          |              29 |              34 |               1 |               2 |               2 |              10 |
| Proposed clean fields / query, query-prefixed news |              25 |              34 |               0 |               0 |               2 |              11 |
| Diagnostic old fields / query                      |              29 |              34 |               1 |               1 |               2 |              12 |
| Diagnostic clean fields / passage                  |              29 |              35 |               1 |               1 |               2 |              11 |
| Diagnostic minimal title + outcomes / query        |              29 |              35 |               1 |               2 |               2 |              11 |
| Qwen clean-v1 / production task query              |              32 |              36 |               9 |              11 |               3 |              11 |

Diagnostic news queries retain the proposed `query:` prefix. The document variant
also formats the synthetic Similar query as a market, matching the market-to-market
comparison rather than treating it as an unrelated search document.

There is one exact-title cross-venue tie in the changed results (2026 Senate party
winner). Counting titles equal after case/whitespace normalization changes English
@1 to 29, 26, 30, 30, 30 respectively. It does **not** remove the semantic regressions
below. No fuzzy equivalence, changed labels or post-hoc query rewording was used.

## Manual review of changed results

The proposed clean-v1 format has genuine regressions, not merely alternative IDs:

- French runoff qualification: target rank 1 → 2; the first result becomes the
  general presidential election, which has a different condition.
- Democratic VP nomination 2028: rank 1 → 4; first result becomes presidential
  nomination, not vice president.
- Texas Senate winner: rank 1 → 2; first result becomes races finishing within 5%,
  not the winner.
- Number of Fed hikes: rank 1 → 3; first result becomes whether another hike occurs,
  not the requested count.

Ablations recover aggregate metrics, but do not uniformly dominate legacy:

- Minimal title/query: VP nomination falls from rank 1 to 5.
- Clean fields/passage: Fed **cuts** falls from rank 1 to 3, with a **hike** event on
  top. This opposite-direction error cannot be counted as an equivalent result.
- Old fields/query: French runoff and VP nomination lose their first position.
- There are also improvements: Brazil presidential winner, some sports goal
  conditions and October versus November Korean rate decisions, depending on the
  variant. They do not erase the regressions elsewhere.

Both formats remain poor on the Russian probes: this is English E5, not proof of
adequate multilingual retrieval. Both also often prefer a near-duplicate date or
condition in the deliberately difficult synthetic Similar corpus. These similarities
must not be used as proof of identical settlement conditions or matching contracts.

## Audit of the actual cleaning

The frozen corpus has 873 titles and 873 representative outcomes. Applying just
the HTML/entity/whitespace cleaner changes **two titles and zero outcomes**:

- A non-breaking space in the Bosnia and Herzegovina chairman title becomes an
  ordinary space.
- Two spaces after `Dota 2:` become one space.

All defining words in the lower-ranked French runoff, Democratic VP, Texas Senate
and Fed cuts/hikes examples survive verbatim, including `2nd round`, `VP`, `2028`,
`cuts`, `hikes`, `2026` and the named outcomes. These examples now have exact-text
regression tests. The changed rankings in this corpus are therefore not explained
by HTML cleaning erasing those words. Ablations implicate interactions between
field wrappers, document prefixes and query formatting; they do not establish a
single universal cause or a universally better replacement.

The broader cleaner audit did find a real bug outside this corpus: an unspaced
comparison such as `Will BTC<ETH in 2026?` could be parsed as an incomplete HTML
tag and lose its defining condition. The cleaner now preserves literal angle
comparisons while still parsing recognized HTML, dropping script/style text and
decoding entities. Tests cover negative temperatures, numeric inequalities,
Unicode, malformed ordinary HTML and spacing around removed script blocks.

This correction does not change any rendered input in the paid E5 fixture: its
fingerprint remains
`426a3c66c72599e47c8852c3568fbc48342e421f2736d06d3939919f8b773513`.
The measurements above therefore still describe the current fixture inputs.

## Qwen adapter smoke, not a quality comparison

A single public text, `Market: Bitcoin above $100,000 on September 30, 2026?`, was
sent with model `qwen/qwen3-embedding-8b`, dimensions 1024 and one permitted
attempt. OpenRouter returned HTTP 200, 1024 dimensions, 25 input tokens and cost
$0.00000025. Its explicit response model was `Qwen/Qwen3-Embedding-8B`.

The initial exact-string identity check rejected that response as
`model_mismatch`. An explicit alias now accepts only `Qwen/Qwen3-Embedding-8B`
when the requested model is `qwen/qwen3-embedding-8b`; it does not perform broad
case folding or accept unknown aliases/revision suffixes. The generation's model
identifier remains the OpenRouter request slug. Unit tests also reject this Qwen
response when the requested generation is E5.

A second identical one-text call through the shared provider adapter passed all
validation: HTTP 200, `Qwen/Qwen3-Embedding-8B`, 1024 dimensions, 25 tokens, one
attempt, $0.00000025. Neither test changed any policy or activated Qwen, and one
text is not evidence of Qwen retrieval quality. Sanitized metadata is recorded in
`fixtures/qwen-adapter-smoke-result.json`.

## Full Qwen comparison on the same corpus

After the adapter smoke, the user authorized the identical 873 documents, 48 map
queries and 12 Similar cases for Qwen. All 969 vectors were freshly generated by
`qwen/qwen3-embedding-8b`, explicitly requesting 1024 dimensions. All eight
responses reported `Qwen/Qwen3-Embedding-8B` and passed the shared adapter's count,
index, dimension, finite-value and nonzero-norm checks. No labels, query wording
or relevant documents changed. The fingerprint was
`503e9d4976d05f46093d07ee956a54ad31b340c8b3c2550ad0b166c6534b7e0b`.

The adapter was the production one: plain clean-v1 documents and the fixed
task-instructed news/search query. Similar used document-to-document embeddings,
not an artificial search-query instruction added to improve this fixture.

Compared with legacy E5, Qwen improves English exact-ID top-one from 29/36 to
32/36, top-three from 34/36 to 36/36, and Russian top-one from 1/12 to 9/12.
Compared with clean E5, English top-one improves from 25/36 and Russian from
0/12. Exact-title equivalence, using only the same case/whitespace normalization
for every variant, gives English top-one 29/26/33 and Russian 1/0/10 for legacy
E5 / clean E5 / Qwen respectively. This supplementary number does not assert
that same-title cross-venue contracts have identical resolution rules.

Material exceptions remain:

- MrBeast **day-one** views falls from rank 1 with both E5 variants to rank 2;
  Qwen narrowly prefers **week-one** views (cosine difference about 0.00019).
- Texas Senate **winner** is rank 2 behind the close-race event, worse than
  legacy E5 and unchanged from clean E5.
- The Russian Leeds query places **Crystal Palace** winning by two goals first;
  the correct Leeds result is second. Its rank is much better than E5 but the
  direction error is still real.
- The Democratic presidential nominee target ranks third in English and fifth
  in Russian, but a different venue's exact same-title event is first. This is
  why exact-ID and exact-title metrics are reported separately.
- Synthetic Similar improves only modestly: 3/12 first and 11/12 top-three. It
  still often prioritizes lexical resemblance over the exact date or condition.
  UK election and Nvidia examples move from rank 2 to 3; ETH ETF net flows falls
  from legacy rank 3 to 4. September-versus-December, day-of-game and
  launch-versus-landing errors remain. Neither of the two legacy top-one Similar
  cases is lost, but this is not an exact-contract matcher.

### Cost and latency

Qwen used 19,819 actual input tokens and cost **$0.00027808**: about 44% more than
the clean E5 run ($0.00019260), and 20% more than legacy E5 ($0.00023097).
The observed unit price was not constant: the first 2,663-token batch charged
**$0.04 per million**, while the remaining batches charged **$0.01 per million**.
The response does not identify why the routing price differed. The initial
preflight used $0.01/M with a 2x reserve; its total reserve covered this run, but
that reserve was inadequate for the first batch alone. Worker accounting now
reserves Qwen using the observed $0.04/M maximum with the same 2x safety factor,
retaining the fail-stop if actual cost exceeds the reserved amount. For these
same inputs the revised estimate is **$0.00158552**, below the $0.02 test cap.
The raw report retains the original preflight rather than rewriting history.

Eight sequential batch latencies were:

| Variant   | Median batch | Total provider time | Slowest batch |
| --------- | -----------: | ------------------: | ------------: |
| Legacy E5 |      2.251 s |            17.754 s |       2.468 s |
| Clean E5  |      2.177 s |            16.718 s |       2.354 s |
| Qwen      |      1.126 s |            13.892 s |       5.025 s |

These are small, non-concurrent runs at different moments, not an SLA or a
controlled provider-latency benchmark. Cosine score scales also differ by model;
raw margin values should not be compared as calibrated probabilities.

## Acceptance conclusion

The queue/reliability work and text cleanup have separate acceptance criteria.
The E5 measurements **do not establish clean-v1 E5 as a quality-preserving or
universally better change**. The later same-corpus Qwen test supports preparing
Qwen directly as the first new generation for discovery/retrieval: top-three
English coverage does not fall, English top-one improves, multilingual retrieval
improves substantially, and Similar does not decline in aggregate. The user
explicitly authorized this direction if the comparison was acceptable. An
intermediate E5-clean generation is not required by this quality evidence.

This is a qualified recommendation, not zero regression: the condition/direction
exceptions above remain, and raw similarity must not authorize trading or claim
equivalent settlement rules. Generation-readiness checks, isolated vector spaces
and legacy service during preparation remain necessary. No query-specific
exceptions, hand-picked replacements or altered labels were added. The quality
tests themselves did not change a production policy or activate either model.

This corpus contains public card titles and one representative outcome, not full
production descriptions/resolution rules. It can reveal a regression but cannot
prove production-wide quality or a zero-risk rollout. Cleaning HTML and preserving
numbers/dates/negations are separately covered by deterministic unit tests.
