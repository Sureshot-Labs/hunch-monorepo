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
    closeTime: string | null;
    venue: string;
    activityVolume: number;
    depthProxy: number;
    openInterest: number | null;
    affinityScore: number;
    contractMatchScore: number;
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
          `  close_time: ${item.closeTime ?? "-"}`,
          `  activity_volume: ${item.activityVolume.toFixed(2)}`,
          `  depth_proxy: ${item.depthProxy.toFixed(2)}`,
          `  open_interest: ${item.openInterest == null ? "-" : item.openInterest.toFixed(2)}`,
          `  affinity_score: ${item.affinityScore.toFixed(6)}`,
          `  contract_match: ${item.contractMatchScore.toFixed(6)}`,
          `  affinity_rank: ${item.affinityRank}`,
        ].join("\n"),
    )
    .join("\n");
}

export function buildMapSignalsSystemPromptV2(): string {
  return [
    "You are a market-signal routing agent for a prediction market product.",
    "Return exactly one JSON object and nothing else.",
    "Do not output markdown, code fences, comments, or additional prose.",
    "Goal: convert node evidence into one actionable market signal candidate.",
    "Write like a concise trader-facing product card: factual, sharp, plain-English, and fast to scan.",
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
    "- activity_volume is the best recent-activity metric available for this market; for Limitless it may use total volume because the venue does not expose a true 24h volume field.",
    "- depth_proxy is the best available market depth proxy, preferring liquidity and falling back to open interest when liquidity is unavailable.",
    "Writing contract:",
    "- headline: 4-10 words when possible. It should read like a sharp signal headline, not a taxonomy label, tag list, or internal note.",
    "- summary: exactly 1-2 short sentences in plain English. Explain what changed and why it matters to this market.",
    "- rationale: exactly 1 short sentence. Explain why this target market is the best fit versus the other candidates.",
    "- Keep the language trader-useful, human-readable, and natural in a small UI card.",
    "- Make the trigger concrete. If the evidence includes a named company, team, player, official event, result, or explicit update, use at least one of those in the headline or first summary sentence when relevant.",
    "- Prefer this structure: sentence 1 says what happened; sentence 2 says why this exact contract is affected.",
    "- If the evidence is mainly a price check, scoreboard result, standings update, or odds/state snapshot, describe the underlying state directly instead of presenting the publisher or source check as the cause.",
    '- For example, prefer "Bitcoin traded around $68.5k" over "CoinDesk reported Bitcoin at $68.5k" unless the report itself is the news.',
    "- Do not use internal pipeline terms in user-facing copy.",
    '- Avoid phrases like "affinity score", "affinity rank", "depth proxy", "candidate market", "node evidence", or "market-level implication".',
    "- Do not cite source domains or publication names in headline/summary unless the source itself is central to the event.",
    "- If you need to mention tradability, say things like 'more liquid', 'deeper market', or 'easier to trade' instead of raw field names.",
    "- Avoid compressed analyst shorthand, newsroom-style hedging, academic phrasing, and generic filler.",
    '- Avoid vague market-commentary phrasing like "moves into focus", "gets a boost", "at risk", "momentum builds", or "back in play" unless it is immediately tied to a concrete fact.',
    "Good style example:",
    '- headline: "Fed cut odds firm after soft CPI"',
    "- summary: \"A softer inflation read strengthens the case for easier policy and gives next-meeting cut markets a clearer catalyst. This market is the closest direct read-through from that update.\"",
    '- rationale: "This market maps most directly to the confirmed evidence and is easier to trade than close alternatives."',
    "More good style examples:",
    '- headline: "MARA sale pressures $68.7K line"',
    '- summary: "MARA said it sold $1.1B in Bitcoin for a debt buyback and BTC slid back into the high-$68Ks. That puts the $68,700 by 5pm EDT contract under pressure into the close."',
    '- headline: "BTC tests $68.45K close line"',
    '- summary: "Bitcoin traded around the mid-$68Ks in the latest confirmed checks. That makes the $68,450 by 5pm EDT contract the closest direct read on spot into the close."',
    '- headline: "Miami win lifts rematch odds"',
    '- summary: "Miami beat Cleveland 120-103 in the latest head-to-head result. That gives this rematch market a fresh, direct catalyst in Miami\'s favor."',
    "Bad style examples:",
    '- headline: "Macro catalyst for April Fed node"',
    '- summary: "Corroborated evidence indicates a market-level implication for rate-cut probabilities."',
    '- rationale: "Highest-affinity candidate with sufficient depth_proxy."',
    '- summary: "Bitcoin was reported at $68,899 on CoinGecko and $68,450 on CoinDesk."',
    '- headline: "Sinner and Tiafoe move into focus"',
    '- summary: "This market becomes more live and gains momentum."',
    "Before returning JSON, verify that headline sounds natural, summary is plain English, rationale is explicit and readable, and none of the user-facing fields sound like internal routing metadata.",
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
    "- Consider affinity_score/affinity_rank strongly; when close, prefer higher depth_proxy/open_interest markets.",
    "- Consider contract_match strongly when several candidates belong to the same event.",
    "- When several candidates belong to the same event, prefer the contract whose wording, numbers, and timing best match the evidence instead of defaulting to the broadest or deepest sibling market.",
    "- Use close_time to distinguish today/this week/this month or date-window contracts when the titles are otherwise similar.",
    "- If target is unclear or evidence weak, return CONTEXT or SKIP.",
    "- Keep headline concise and concrete.",
    "- Keep summary and rationale in plain English.",
    "- In the headline or first summary sentence, name the concrete trigger when possible: company, team, player, official result, report, or event.",
    "- If the evidence is just a current price, score, standings line, or status check, describe that state directly instead of saying a site 'reported' it.",
    "- Prefer 'X happened, so this contract moves' over generic market color.",
    "- Keep rationale short and explicit.",
    "- Do not mention internal field names like affinity_score, affinity_rank, depth_proxy, candidate market, or confirmation labels in headline, summary, or rationale.",
    "- If comparing tradability, use plain phrases like 'more liquid' or 'easier to trade'.",
    "- Avoid tag-list headlines, compressed analyst shorthand, generic filler, and vague cliche phrasing like 'moves into focus' unless tied to a specific fact.",
  ].join("\n");
}
