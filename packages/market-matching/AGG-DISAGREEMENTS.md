# AGG comparison: why decisions differ

Captured September 20, 2026. AGG is a comparator, **not ground truth**. A missed
AGG pair is neither automatically our error nor evidence that AGG is unsafe.
These judgments inspect supplied catalog rules; they do not independently settle
the venues' legal/oracle precedence. Model probabilities are not calibrated error rates.

Of 31 AGG pairs overlapping the 1,000-seed cohort, retrieval finds 26. Initially
five passed automatic approval. After fixing presentation normalization and
explicit flat/group binding, seven passed. The final source-link correction gives
ten approved pairs; the remaining 16 retrieved pairs are **review**, not an
assertion that all 16 are different contracts.

## Reviewed disagreements

IDs below use `limitless:<id>`; paired Polymarket IDs remain in the local raw
`agg-comparison.json` and recorded evaluations.

| Group / Limitless IDs                    | Evidence in supplied rules                                                                                                                                            | Interpretation / final behavior                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ground beef $10 — 104307                 | Identical conditions; spaces around the same FRED URL. Jev relation .97/.96 and both outcomes passed.                                                                 | Our normalization defect; fixed and approved.                                                                                                               |
| Ground beef $9/$8 — 104308, 104309       | Same substantive terms.                                                                                                                                               | Initially failed thresholds; final href-preserving input passes one outcome each. Links are informational under the complete-binary execution adapter.      |
| Ballon d'Or — 115069, 115074, 115075     | Same year, winner, deadline, fallback and France Football source; URL whitespace and a terminal sentence period differ.                                               | Likely equivalent from supplied terms. Literal-rule comparison and .93–.94 model probabilities retain review; punctuation is not globally stripped.         |
| Ostium — 27633                           | Poly parent says December 2025; its selected child/question says December 2026.                                                                                       | Unresolved source precedence. Do not assume either that AGG is wrong or that parent text can be silently discarded.                                         |
| Theo $700M — 33149                       | Same FDV threshold, following-day 16:00 ET observation and launch deadline.                                                                                           | Final href-preserving input gives .95/.94 and both outcomes pass. Other Theo thresholds are evaluated independently.                                        |
| Pacifica launch — 33508                  | Same rules, full question versus one-slot event template plus December 31 child; formatting differences only.                                                         | Our binding/normalization loss; fixed. New separate YES/NO evaluation passes; approved.                                                                     |
| Democratic nominee — 36746, 36747, 36748 | Identical candidate-specific nomination rules, including acceptance and replacement provisions.                                                                       | Coverage loss from model gates. AOC relation .95/.93 passes but outcomes .94/.93 fail; this does not prove different payouts.                               |
| Gavin Newsom election — 36775            | Child rules agree. Poly parent adds “Otherwise ... No.” to the event wording.                                                                                         | Likely redundant binary language, but current parent-conflict handling is too coarse to prove this. Review; do not silently discard all parent differences. |
| F1 — 37224, 37228, 37229                 | Poly adds early NO resolution for eliminated drivers. Its parent deadline is February 28, 2027, while its child and Limitless say March 31.                           | Real settlement-timing difference plus inconsistent parent/child dates. Automatic substitution is not established.                                          |
| Israel PM — 37651, 37654                 | Same appointment, swearing-in, early-election and caretaker exclusions; event titles differ in wording.                                                               | Likely equivalent from supplied terms; literal event context and model confidence retain review. Not evidence that AGG is wrong.                            |
| Dubai index — 75398, 75399               | Poly adds official daily-value fallback and a 72-hour missing-data rule; Limitless describes only TradingView. Both refer to market creation without a shared anchor. | Material differences/missing evidence. Refusal is justified; title/threshold similarity is insufficient for exact replacement.                              |
| Bitcoin ATH — 82511                      | Same explicit start, Binance candle source and deadline; `11:59 PM` versus `11:59PM`.                                                                                 | Formatting defect fixed; .94 relation/.93 YES probability still requires review.                                                                            |

The five pairs not retrieved are three inactive counterparts (two archived, one
closed), one incompatible November/December deadline, and Anthropic: our candidate
is the existing standalone Poly `676846`, while AGG chooses grouped `700397`.
Anthropic therefore already had an alternative; it was not a missing-company
retrieval failure. The actual flat/group gaps fixed were Ostium, Theo and Pacifica.

## What was changed and what remains open

Normalization now ignores only proven presentation whitespace around URL
parentheses and AM/PM. A single explicit event placeholder can be filled with the
child selection and compared with the original full question. Dates/operators/
source URLs remain material; generic questions cannot erase year or office.

We did **not** lower .95/.90 thresholds or reroll weak answers until approval.
On the same 380-pair cohort, total contract approvals changed 62 → 86: 25 added,
one removed for an unanchored “creation of this market” start. New approvals were
reviewed by event group; this is developer inspection, not independent adjudication.

Independent review then found a source-evidence bug: HTML hrefs were discarded.
Preserving them changed 109 requests, evaluated once each. Contract approvals became
92 (ten added, four removed), including ten of the 31 AGG pairs. The four removals
are Theo $300M, Pacifica $500M/$300M and Baltimore 2027: their new relation
probabilities are .92–.94, below the unchanged .95 gate. These threshold flips on
changed inputs are not proof of a real settlement difference or improved precision.

Further coverage work should separately label parent-rule precedence, harmless
wording differences and model-threshold losses using fresh event-group holdouts.
Treating AGG as perfect would reward reproducing stale/ambiguous links. Treating
every strict rejection as correct would hide our genuine false negatives.
