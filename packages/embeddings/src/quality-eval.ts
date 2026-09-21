/** Manual public-only embedding acceptance probe. No network or credentials are used without --execute. */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_EMBEDDING_POLICY,
  LEGACY_EMBEDDING_GENERATION,
  generationForPolicy,
  embeddingTextHash,
  type EmbeddingGeneration,
  type EmbeddingSource,
} from "./contracts.js";
import {
  buildEmbeddingText,
  buildLegacyEmbeddingText,
  buildNewsEmbeddingText,
  cleanEmbeddingText,
  countEmbeddingTokens,
} from "./text.js";
import { estimateEmbeddingCostUsd, fetchEmbeddingBatch } from "./provider.js";

type QualityFixture = {
  version: number;
  provenance: Record<string, unknown>;
  events: Array<{
    id: string;
    title: string;
    venue: string;
    topMarkets: string[];
  }>;
  queries: Array<{ targetId: string; text: string; language: string }>;
  similarCases: Array<{
    id: string;
    query: string;
    positive: string;
    negatives: string[];
  }>;
};
type Document = { id: string; title: string };
const HARD_CAP_USD = 0.05;
const QWEN_ADDITIONAL_CAP_USD = 0.02;
const BATCH_SIZE = 128;

function source(
  kind: "market" | "event",
  doc: Document,
  extra: Partial<EmbeddingSource> = {},
): EmbeddingSource {
  return {
    kind,
    id: doc.id,
    title: doc.title,
    venue: "public-fixture",
    status: "ACTIVE",
    eligible: true,
    ...extra,
  };
}
function rankQuery(
  query: number[],
  docs: Document[],
  vectors: number[][],
  targetId: string,
) {
  const ranked = docs
    .map((doc, index) => ({
      ...doc,
      score: query.reduce(
        (sum, value, dimension) =>
          sum + value * (vectors[index]?.[dimension] ?? 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const target = ranked.find((row) => row.id === targetId);
  if (!target) throw new Error("Quality fixture target missing");
  return {
    targetId,
    rank: ranked.findIndex((row) => row.id === targetId) + 1,
    margin:
      target.score -
      (ranked.find((row) => row.id !== targetId)?.score ?? target.score),
    top: ranked.slice(0, 3),
    targetTitle: target.title,
  };
}
function aggregate(rows: Array<{ rank: number; margin: number }>) {
  return {
    queries: rows.length,
    rank1: rows.filter((row) => row.rank === 1).length,
    rank3: rows.filter((row) => row.rank <= 3).length,
    recall1: rows.filter((row) => row.rank === 1).length / rows.length,
    recall3: rows.filter((row) => row.rank <= 3).length / rows.length,
    mrr: rows.reduce((total, row) => total + 1 / row.rank, 0) / rows.length,
    meanMargin:
      rows.reduce((total, row) => total + row.margin, 0) / rows.length,
  };
}
export async function runPublicEmbeddingQuality(args: string[]) {
  const qwenOnly = args.includes("--qwen");
  if (qwenOnly && args.includes("--ablation"))
    throw new Error("Choose either the Qwen comparison or E5 ablations");
  const budgetCapUsd = qwenOnly ? QWEN_ADDITIONAL_CAP_USD : HARD_CAP_USD;
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/public-quality-v1.json", import.meta.url),
      "utf8",
    ),
  ) as QualityFixture;
  const mapDocs: Document[] = fixture.events.map(({ id, title }) => ({
    id,
    title,
  }));
  const similarDocs = fixture.similarCases.flatMap((row) =>
    [row.positive, ...row.negatives].map((title, index) => ({
      id: `${row.id}:${index}`,
      title,
    })),
  );
  // Pin the evaluation models independently of the currently shipped default.
  const cleanGeneration = generationForPolicy({
    ...DEFAULT_EMBEDDING_POLICY,
    model: "intfloat/e5-large-v2",
  });
  const renderVariants: Array<{
    name: string;
    generation: EmbeddingGeneration;
    render?: (source: EmbeddingSource) => string;
  }> = qwenOnly
    ? [
        {
          name: "clean-qwen",
          generation: generationForPolicy({
            ...DEFAULT_EMBEDDING_POLICY,
            model: "qwen/qwen3-embedding-8b",
          }),
        },
      ]
    : args.includes("--ablation")
      ? [
          {
            name: "diagnostic-oldfields-query",
            generation: cleanGeneration,
            render: (source) =>
              buildLegacyEmbeddingText(source).replace(/^passage:/, "query:"),
          },
          {
            name: "diagnostic-cleanfields-passage",
            generation: cleanGeneration,
            render: (source) =>
              buildEmbeddingText(source, cleanGeneration).replace(
                /^query:/,
                "passage:",
              ),
          },
          {
            name: "diagnostic-minimal-query",
            generation: cleanGeneration,
            render: (source) => {
              const title = cleanEmbeddingText(source.title);
              const outcomes = [
                ...new Set(
                  (source.topMarkets ?? source.outcomes ?? []).map((value) =>
                    cleanEmbeddingText(value),
                  ),
                ),
              ]
                .sort()
                .filter(
                  (value) =>
                    value &&
                    value.toLowerCase() !== title.toLowerCase() &&
                    !/^(yes|no|true|false)$/i.test(value),
                )
                .slice(0, 8);
              return `query: ${title}${outcomes.length ? `; ${outcomes.join("; ")}` : ""}`;
            },
          },
        ]
      : [
          { name: "legacy-e5", generation: LEGACY_EMBEDDING_GENERATION },
          {
            name: "clean-e5",
            generation: cleanGeneration,
          },
        ];
  const definitions = renderVariants.map((variant) => {
    const render =
      variant.render ??
      ((source: EmbeddingSource) =>
        buildEmbeddingText(source, variant.generation));
    const texts = [
      ...fixture.events.map((row) =>
        render(
          source("event", row, {
            venue: row.venue,
            topMarkets: row.topMarkets,
          }),
        ),
      ),
      ...fixture.queries.map((row) =>
        buildNewsEmbeddingText(row.text, null, variant.generation),
      ),
      ...similarDocs.map((row) => render(source("market", row))),
      ...fixture.similarCases.map((row) =>
        render(source("market", { id: row.id, title: row.query })),
      ),
    ];
    return {
      ...variant,
      texts,
      tokens: texts.reduce(
        (sum, text) => sum + countEmbeddingTokens(text, variant.generation),
        0,
      ),
      estimatedCostUsd: estimateEmbeddingCostUsd(texts, variant.generation),
    };
  });
  const fingerprint = embeddingTextHash(
    JSON.stringify(
      definitions.map(({ name, generation, texts }) => ({
        name,
        generation,
        texts,
      })),
    ),
  );
  const priorChargedUsd = args.includes("--ablation")
    ? Number(
        (
          JSON.parse(
            readFileSync(
              new URL(
                "../fixtures/public-quality-v1-result.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ) as { chargedUsd: number }
        ).chargedUsd,
      )
    : 0;
  if (!Number.isFinite(priorChargedUsd) || priorChargedUsd < 0)
    throw new Error("Invalid prior budget evidence");
  const preflight = {
    mode: "dry-run",
    fingerprint,
    model: qwenOnly ? "qwen/qwen3-embedding-8b" : "intfloat/e5-large-v2",
    publicEvents: mapDocs.length,
    mapQueries: fixture.queries.length,
    syntheticSimilarDocs: similarDocs.length,
    syntheticSimilarQueries: fixture.similarCases.length,
    budgetUsd: budgetCapUsd,
    priorChargedUsd,
    maxAttemptsPerBatch: 1,
    variants: definitions.map(({ name, tokens, estimatedCostUsd, texts }) => ({
      name,
      texts: texts.length,
      tokens,
      estimatedCostUsd,
      requests: Math.ceil(texts.length / BATCH_SIZE),
    })),
    totalEstimatedCostUsd: definitions.reduce(
      (sum, row) => sum + row.estimatedCostUsd,
      0,
    ),
    provenance: fixture.provenance,
  };
  console.log(JSON.stringify({ preflight }));
  if (!args.includes("--execute")) return preflight;
  const confirmation = args[args.indexOf("--confirm-sha") + 1];
  if (!args.includes("--confirm-sha") || confirmation !== fingerprint)
    throw new Error(
      "Run dry-run first; --confirm-sha must match current preflight",
    );
  if (priorChargedUsd + preflight.totalEstimatedCostUsd > budgetCapUsd)
    throw new Error("Quality fixture exceeds the fixed maximum budget");
  const allowed = new Set([
    "--execute",
    "--confirm-sha",
    "--ablation",
    "--qwen",
    fingerprint,
  ]);
  if (args.some((arg) => !allowed.has(arg)))
    throw new Error("Unknown quality-evaluation flag");
  const apiKey =
    process.env.OPENROUTER_API_KEY ||
    parseEnv(readFileSync(new URL("../../../.env", import.meta.url), "utf8"))
      .OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No local OpenRouter key");
  let reservedUsd = 0;
  let chargedUsd = 0;
  const variants = [];
  for (const variant of definitions) {
    const vectors: number[][] = [];
    const batches: Array<{
      model: unknown;
      inputTokens: number | null;
      costUsd: number | null;
      elapsedMs: number;
    }> = [];
    for (let offset = 0; offset < variant.texts.length; offset += BATCH_SIZE) {
      let responseModel: unknown = null;
      const started = Date.now();
      const fetchWithMetadata: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (response.ok) {
          const raw = (await response.clone().json()) as Record<
            string,
            unknown
          >;
          responseModel = raw.model ?? null;
        }
        return response;
      };
      const result = await fetchEmbeddingBatch({
        generation: variant.generation as EmbeddingGeneration,
        texts: variant.texts.slice(offset, offset + BATCH_SIZE),
        apiKey,
        timeoutMs: 30000,
        maxAttempts: 1,
        fetch: fetchWithMetadata,
        beforeAttempt: async ({ estimatedCostUsd }) => {
          if (
            priorChargedUsd +
              Math.max(reservedUsd, chargedUsd) +
              estimatedCostUsd >
            budgetCapUsd
          )
            throw new Error("Quality evaluation budget exhausted");
          reservedUsd += estimatedCostUsd;
        },
      });
      if (result.usage.costUsd == null)
        throw new Error(
          "Provider omitted cost; stopping bounded quality evaluation",
        );
      chargedUsd += result.usage.costUsd;
      batches.push({
        model: responseModel,
        ...result.usage,
        elapsedMs: Date.now() - started,
      });
      vectors.push(...result.embeddings);
      console.log(
        JSON.stringify({
          progress: {
            variant: variant.name,
            completed: vectors.length,
            total: variant.texts.length,
            chargedUsd,
            reservedUsd,
          },
        }),
      );
      if (priorChargedUsd + chargedUsd > budgetCapUsd)
        throw new Error("Provider pricing exceeded fixed budget; stopping");
    }
    const queryOffset = mapDocs.length;
    const similarOffset = queryOffset + fixture.queries.length;
    const similarQueryOffset = similarOffset + similarDocs.length;
    const mapRows = fixture.queries.map((row, index) => ({
      ...row,
      ...rankQuery(
        vectors[queryOffset + index] ?? [],
        mapDocs,
        vectors.slice(0, queryOffset),
        row.targetId,
      ),
    }));
    const similarRows = fixture.similarCases.map((row, index) => ({
      query: row.query,
      ...rankQuery(
        vectors[similarQueryOffset + index] ?? [],
        similarDocs,
        vectors.slice(similarOffset, similarQueryOffset),
        `${row.id}:0`,
      ),
    }));
    variants.push({
      name: variant.name,
      generation: variant.generation,
      batches,
      mapSummary: aggregate(mapRows),
      mapEnglishSummary: aggregate(
        mapRows.filter((row) => row.language === "en"),
      ),
      mapRussianSummary: aggregate(
        mapRows.filter((row) => row.language === "ru"),
      ),
      similarSummary: aggregate(similarRows),
      mapRows,
      similarRows,
    });
  }
  const report = {
    preflight,
    completedAt: new Date().toISOString(),
    reservedUsd,
    chargedUsd,
    variants,
    limitations: [
      "Frozen public titles plus representative outcomes, not full production descriptions.",
      "Exact target-ID ranks can penalize equivalent cross-venue event titles; inspect top-three results.",
      "Controlled Similar fixtures are synthetic, not user history.",
      qwenOnly
        ? "Qwen uses the production document and task-instructed query adapters; this is retrieval evidence, not trading/settlement equivalence."
        : "This measures format+prefix changes on E5, not Qwen quality or trading/settlement equivalence.",
    ],
  };
  console.log(`QUALITY_RESULT ${JSON.stringify(report)}`);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPublicEmbeddingQuality(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Quality evaluation failed",
    );
    process.exitCode = 1;
  });
}
