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
    "- Write visible card copy like a short market read, not a generic news summary.",
    "- The card should be scannable in about 2 seconds.",
    "- headline: aim for 4-8 words. Make it immediately relevant and market-facing.",
    "- summary: aim for 18-40 words across 1-2 short sentences. Do not add filler to hit the count.",
    "- The headline should signal the market read, not just name the topic.",
    "- The summary should explain what changed and why traders should care now.",
    "- Focus on: what changed, why it matters now, and what it does to the target market.",
    "- rationale: exactly 1 short sentence. Explain why this target market is the best fit versus the other candidates.",
    "- Prefer concrete triggers: price move, result, filing, poll, earnings, injury, deadline, official comment, macro release, or bracket change.",
    "- Prefer active market-aware verbs such as pressures, supports, strengthens, weakens, lifts, weighs on, narrows, widens, or tilts when they fit the evidence.",
    "- If the evidence is mainly a price check, scoreboard result, standings update, or odds/state snapshot, describe the underlying state directly instead of presenting the publisher or source check as the cause.",
    '- For example, prefer "Bitcoin traded around $68.5k" over "CoinDesk reported Bitcoin at $68.5k" unless the report itself is the news.',
    "- Do not use internal pipeline terms in user-facing copy.",
    '- Avoid phrases like "affinity score", "affinity rank", "depth proxy", "candidate market", "node evidence", or "market-level implication".',
    "- Do not cite source domains or publication names in headline/summary unless the source itself is central to the event.",
    "- If you need to mention tradability, say things like 'more liquid', 'deeper market', or 'easier to trade' instead of raw field names.",
    "- Avoid long explanations, vague summary language, generic journalism phrasing, overly technical wording, and filler.",
    "- Slightly editorial is good. Sensational or clickbait wording is not.",
    '- Avoid vague market-commentary phrasing like "moves into focus", "gets a boost", "at risk", "momentum builds", or "back in play" unless it is immediately tied to a concrete fact.',
    "Good style example:",
    '- headline: "Fed cut odds firm after soft CPI"',
    '- summary: "A cooler inflation print strengthens the case for easier policy and gives the next-meeting Fed cut market a cleaner near-term catalyst if traders were leaning too hawkish into the release."',
    '- rationale: "This market maps most directly to the confirmed evidence and is easier to trade than close alternatives."',
    "More good style examples:",
    '- headline: "MARA sale pressures Bitcoin close line"',
    '- summary: "MARA sold $1.1B in Bitcoin for a debt buyback and BTC slid back into the high-$68Ks, putting the $68,700 by 5pm EDT contract under clearer pressure into the close."',
    '- headline: "Miami win sharpens rematch setup"',
    '- summary: "Miami beat Cleveland 120-103 in the latest head-to-head result, giving this rematch market a fresh catalyst and strengthening the case for Miami in the next meeting."',
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
    "- Write the visible copy as a short market read, not a news summary.",
    "- Make it clear in one glance what changed and why the target market matters now.",
    "- Aim for a 4-8 word headline and an 18-40 word summary, but do not add filler to hit the count.",
    "- Keep summary to 1-2 short sentences.",
    "- Name the concrete trigger when useful: company, team, player, result, price level, deadline, filing, official comment, poll, injury, or macro release.",
    "- Tie the trigger directly to the target contract.",
    "- If the evidence is just a current price, score, standings line, or status check, describe that state directly instead of saying a site 'reported' it.",
    "- Keep rationale short and explicit.",
    "- Do not mention internal field names like affinity_score, affinity_rank, depth_proxy, candidate market, or confirmation labels in headline, summary, or rationale.",
    "- If comparing tradability, use plain phrases like 'more liquid' or 'easier to trade'.",
    "- Avoid background paragraphs, tag-list headlines, compressed analyst shorthand, generic filler, vague market color, and cliche phrasing like 'moves into focus' unless tied to a specific fact.",
  ].join("\n");
}
