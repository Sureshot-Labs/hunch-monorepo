# Embedding quality acceptance on a frozen public corpus

`fixtures/public-quality-v1.json` freezes 873 public market-map event cards from
2026-09-20, 48 labelled retrieval queries (36 English and 12 Russian), and 12
separately labelled synthetic Similar-market cases. No stored vectors, accounts,
user queries, wallet histories or credentials are included.

Both variants generate **fresh** E5 embeddings for all documents and queries:
legacy `passage:` documents/plain news queries versus the actual clean-v1 builder
and `query:` adapter. Inputs and target labels are frozen before observing results.

Build the package, then run the non-network preflight:

```sh
node packages/embeddings/dist/quality-eval.js
```

Only an explicit `--execute --confirm-sha <printed fingerprint>` performs paid
calls. It reads the local `OPENROUTER_API_KEY` or repository `.env`, sends only the
public fixture to OpenRouter's embedding endpoint, uses E5 by default, one attempt
per batch, and reserves at most $0.05 at the admitted catalog price with a 2x token
safety factor. It stops on unknown actual cost or a pricing overrun. This is a local
manual acceptance tool, never imported by a service or executed during deploy.

The final `QUALITY_RESULT` records actual response model fields, usage, cost,
latency, exact target ranks, top-three candidates and positive-vs-negative margins.
An omitted response model is recorded as null, not invented. Review wrong rankings
manually: cross-venue equivalents may have different IDs. Metrics are not a promise
of semantic equivalence, settlement correctness or production-wide quality. The
fixture has card titles and representative outcomes, not complete resolution rules.

`--ablation` runs three diagnostic-only text variants against the same fixed corpus
and labels; it never changes the production builder. Run its own dry-run first and
confirm its different fingerprint. It counts the saved first run's actual cost
against the same $0.05 ceiling. See `QUALITY-RESULTS.md` for measured limitations;
passing infrastructure tests does not imply a quality improvement.

`--qwen` runs a separate comparison using Qwen's actual clean-v1 document adapter
and task-instructed news/search query adapter, explicitly requesting 1024
dimensions. Similar remains a document-to-document comparison, just as in the
production Similar path. The corpus, target IDs and language labels are identical
to the E5 runs; the historical E5 reports remain unchanged. This mode has an
independent **$0.02 additional** hard cap, eight single-attempt requests for the
current fixture, and its own dry-run/confirmation fingerprint. It cannot be
combined with `--ablation` and does not change the application default or policy.

```sh
node packages/embeddings/dist/quality-eval.js --qwen
```
