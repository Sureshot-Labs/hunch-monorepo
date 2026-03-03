import { z } from "zod";

export const mapSignalDirectionSchema = z.enum(["up", "down", "mixed"]);
export const mapSignalTypeSchema = z.enum(["catalyst", "risk", "update"]);
export const mapSignalStatusSchema = z.enum(["PUBLISH", "CONTEXT", "SKIP"]);

const mapSearchConfirmationSchema = z.enum([
  "confirmed",
  "developing",
  "unconfirmed",
]);
const mapSearchSourceTierSchema = z.enum([
  "official",
  "wire",
  "major_media",
  "specialist",
  "social",
]);
const mapSearchRouteReasonSchema = z.enum([
  "assigned_child",
  "below_threshold",
  "below_min_similarity",
  "low_margin",
  "no_candidate",
  "leaf_self",
]);

const mapSignalsInputRunSchema = z
  .object({
    runId: z.string().min(1),
    mapGeneratedAt: z.string().min(1),
  })
  .passthrough();

const mapSignalsInputTotalsSchema = z
  .object({
    callsExecuted: z.coerce.number().finite(),
    evidenceTotal: z.coerce.number().finite(),
    estimatedTotalCostUsd: z.coerce.number().finite(),
    chargedTotalCostUsd: z.coerce.number().finite().optional(),
    providerReportedCostUsd: z.coerce.number().finite().optional(),
    providerReportedCostCalls: z.coerce.number().finite().optional(),
  })
  .passthrough();

const mapSignalsInputCallSchema = z
  .object({
    callIndex: z.coerce.number().int().nonnegative(),
    nodeId: z.string().min(1),
    nodeLabel: z.string().min(1),
    level: z.coerce.number().int().nonnegative(),
  })
  .passthrough();

const mapSignalsInputEvidenceSchema = z
  .object({
    id: z.string().min(1),
    headline: z.string().min(1).max(240),
    summary: z.string().min(1).max(320),
    sourceUrl: z.string().url(),
    sourceDomain: z.string().min(1).max(120),
    publishedAt: z.string().min(1).nullable(),
    confirmation: mapSearchConfirmationSchema,
    sourceTier: mapSearchSourceTierSchema,
    relevance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    nodeId: z.string().min(1),
    callIndex: z.coerce.number().int().nonnegative(),
    assignedNodeId: z.string().min(1).nullable(),
    assignedSimilarity: z.number().nullable(),
    routeReason: mapSearchRouteReasonSchema.nullable(),
  })
  .passthrough();

export const mapSignalsInputArtifactSchema = z
  .object({
    run: mapSignalsInputRunSchema,
    totals: mapSignalsInputTotalsSchema,
    calls: z.array(mapSignalsInputCallSchema),
    evidence: z.array(mapSignalsInputEvidenceSchema),
  })
  .passthrough();

export type MapSignalsInputArtifact = z.infer<typeof mapSignalsInputArtifactSchema>;

export function parseMapSignalsInputArtifactV1(
  payload: unknown,
): MapSignalsInputArtifact {
  return mapSignalsInputArtifactSchema.parse(payload);
}

export const mapSignalsAgentOutputV2Schema = z
  .object({
    version: z.literal("map_signals_v2"),
    status: mapSignalStatusSchema,
    signal_type: mapSignalTypeSchema,
    direction: mapSignalDirectionSchema,
    confidence: z.number().min(0).max(1),
    headline: z.string().min(8).max(140),
    summary: z.string().min(24).max(320),
    rationale: z.string().min(12).max(260),
    target_market_id: z.string().min(1).nullable(),
    target_event_id: z.string().min(1).nullable(),
    evidence_ids: z.array(z.string().min(1)).min(1).max(6),
  })
  .strict();

export type MapSignalsAgentOutputV2 = z.infer<
  typeof mapSignalsAgentOutputV2Schema
>;

export const MAP_SIGNALS_AGENT_OUTPUT_V2_JSON_SCHEMA = z.toJSONSchema(
  mapSignalsAgentOutputV2Schema,
);

export function parseMapSignalsAgentOutputV2(
  payload: unknown,
): MapSignalsAgentOutputV2 {
  return mapSignalsAgentOutputV2Schema.parse(payload);
}

export type MapSignalsPromptInput = {
  runId: string;
  nodeId: string;
  nodeLabel: string;
  level: number;
  evidenceCount: number;
  confirmedCount: number;
  evidence: Array<{
    id: string;
    headline: string;
    summary: string;
    sourceDomain: string;
    publishedAt: string | null;
    confirmation: "confirmed" | "developing" | "unconfirmed";
    relevance: number;
    confidence: number;
  }>;
  candidateMarkets: Array<{
    marketId: string;
    eventId: string;
    eventTitle: string;
    marketTitle: string | null;
    venue: string;
    volume24h: number;
    liquidity: number;
    openInterest: number;
    score: number;
    affinityScore: number;
    affinityRank: number;
  }>;
};

function formatEvidenceList(input: MapSignalsPromptInput["evidence"]): string {
  if (input.length === 0) return "- none";
  return input
    .map(
      item =>
        [
          `- id: ${item.id}`,
          `  headline: ${item.headline}`,
          `  summary: ${item.summary}`,
          `  source_domain: ${item.sourceDomain}`,
          `  published_at: ${item.publishedAt ?? "-"}`,
          `  confirmation: ${item.confirmation}`,
          `  relevance: ${item.relevance.toFixed(3)}`,
          `  confidence: ${item.confidence.toFixed(3)}`,
        ].join("\n"),
    )
    .join("\n");
}

function formatMarketList(
  input: MapSignalsPromptInput["candidateMarkets"],
): string {
  if (input.length === 0) return "- none";
  return input
    .map(
      item =>
        [
          `- market_id: ${item.marketId}`,
          `  event_id: ${item.eventId}`,
          `  venue: ${item.venue}`,
          `  event_title: ${item.eventTitle}`,
          `  market_title: ${item.marketTitle ?? "-"}`,
          `  volume_24h: ${item.volume24h.toFixed(2)}`,
          `  liquidity: ${item.liquidity.toFixed(2)}`,
          `  open_interest: ${item.openInterest.toFixed(2)}`,
          `  score: ${item.score.toFixed(6)}`,
          `  affinity_score: ${item.affinityScore.toFixed(6)}`,
          `  affinity_rank: ${item.affinityRank}`,
        ].join("\n"),
    )
    .join("\n");
}

export function buildMapSignalsSystemPromptV2(): string {
  return [
    "You are a market-signal routing agent.",
    "Return exactly one JSON object and nothing else.",
    "Do not output markdown, code fences, comments, or additional prose.",
    "Goal: convert node evidence into one actionable market signal candidate.",
    "Hard constraints:",
    "- If status=PUBLISH then target_market_id must be one of provided candidate market IDs.",
    "- Never invent market IDs, event IDs, evidence IDs, or URLs.",
    "- Use only provided evidence items; evidence_ids must be subset of provided ids.",
    "- Keep summary factual and decision-useful (what changed and why it matters).",
    "- Avoid policy/implementation/internal metadata words.",
    "Decision guidance:",
    "- signal_type must be chosen explicitly:",
    "  - catalyst: new concrete event/update likely to move probabilities in near term.",
    "  - risk: downside/uncertainty or adverse development increasing tail risk.",
    "  - update: informative context with weaker directional edge.",
    "- Do not default to update when catalyst or risk is clearly supported.",
    "- PUBLISH: specific market-level implication with enough confidence and evidence quality.",
    "- CONTEXT: useful context but no single high-confidence market target.",
    "- SKIP: low-quality/noise/insufficient evidence.",
    "Output schema:",
    JSON.stringify(MAP_SIGNALS_AGENT_OUTPUT_V2_JSON_SCHEMA, null, 2),
  ].join("\n");
}

export function buildMapSignalsUserPromptV2(input: MapSignalsPromptInput): string {
  return [
    "Generate one signal for this map node.",
    "",
    `run_id: ${input.runId}`,
    `node_id: ${input.nodeId}`,
    `node_label: ${input.nodeLabel}`,
    `level: ${input.level}`,
    `evidence_count: ${input.evidenceCount}`,
    `confirmed_count: ${input.confirmedCount}`,
    "",
    "Evidence items (use ids in evidence_ids):",
    formatEvidenceList(input.evidence),
    "",
    "Candidate markets (target_market_id must be from this list):",
    formatMarketList(input.candidateMarkets),
    "",
    "Instructions:",
    "- Prefer recent, corroborated evidence.",
    "- Prefer market targets with clear linkage to selected evidence.",
    "- Consider affinity_score/affinity_rank strongly; when close, prefer higher liquidity/open_interest markets.",
    "- If target is unclear or evidence weak, return CONTEXT or SKIP.",
    "- Keep headline concise and concrete.",
    "- Keep rationale short and explicit.",
  ].join("\n");
}
