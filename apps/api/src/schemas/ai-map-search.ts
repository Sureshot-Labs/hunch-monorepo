import { z } from "zod";

const zIsoDatetime = z
  .string()
  .min(1)
  .refine(value => !Number.isNaN(Date.parse(value)), {
    message: "Expected ISO datetime string",
  });

const zNormalizedPublishedAt = z.preprocess(
  value => {
    if (value == null) return null;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return null;
  },
  zIsoDatetime.nullable(),
);

const zProb = z.number().min(0).max(1);

const zConfirmation = z.enum(["confirmed", "developing", "unconfirmed"]);
const zSourceTier = z.enum([
  "official",
  "wire",
  "major_media",
  "specialist",
  "social",
]);

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSummaryTooCloseToHeadline(summary: string, headline: string): boolean {
  const s = normalizeForComparison(summary);
  const h = normalizeForComparison(headline);
  if (!s || !h) return false;
  if (s === h) return true;
  const sTokens = new Set(s.split(" ").filter(token => token.length > 2));
  const hTokens = new Set(h.split(" ").filter(token => token.length > 2));
  if (sTokens.size === 0 || hTokens.size === 0) return false;
  let overlap = 0;
  for (const token of hTokens) {
    if (sTokens.has(token)) overlap += 1;
  }
  const overlapOnHeadline = overlap / hTokens.size;
  const overlapOnSummary = overlap / sTokens.size;
  return overlapOnHeadline >= 0.98 && overlapOnSummary >= 0.98;
}

export const mapSearchEvidenceItemV2Schema = z
  .object({
    headline: z.string().min(1).max(240),
    summary: z.string().min(24).max(300),
    source_url: z.string().url(),
    source_domain: z.string().min(1).max(120),
    published_at: zNormalizedPublishedAt,
    author_handle: z.string().min(1).max(120).nullable(),
    confirmation: zConfirmation,
    source_tier: zSourceTier,
    relevance: zProb,
    confidence: zProb,
  })
  .superRefine((value, ctx) => {
    if (isSummaryTooCloseToHeadline(value.summary, value.headline)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary"],
        message:
          "Summary must add factual context and impact beyond headline restatement.",
      });
    }
    if (value.source_tier === "social" && value.confirmation === "confirmed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message:
          "Social-only evidence cannot be marked confirmed without primary corroboration.",
      });
    }
  })
  .strict();

export const mapSearchAgentOutputV2Schema = z
  .object({
    version: z.literal("map_search_v2"),
    status: z.enum(["OK", "PARTIAL", "NO_EVIDENCE"]),
    summary: z.string().min(1).max(260),
    next_focus: z.array(z.string().min(1).max(120)).max(8).default([]),
    evidence: z.array(mapSearchEvidenceItemV2Schema).max(12),
    notes: z.string().max(400).optional(),
  })
  .strict();

export type MapSearchEvidenceItemV2 = z.infer<
  typeof mapSearchEvidenceItemV2Schema
>;
export type MapSearchAgentOutputV2 = z.infer<typeof mapSearchAgentOutputV2Schema>;

export const MAP_SEARCH_AGENT_OUTPUT_V2_JSON_SCHEMA = z.toJSONSchema(
  mapSearchAgentOutputV2Schema,
);

export function parseMapSearchAgentOutputV2(
  payload: unknown,
): MapSearchAgentOutputV2 {
  return mapSearchAgentOutputV2Schema.parse(payload);
}

export type MapSearchPromptConfig = {
  maxEvidence: number;
  windowHours: number;
  recentHoursHint: number;
  includeWebTool: boolean;
  includeXTool: boolean;
  requireDistinctDomains: boolean;
  disallowedSourceDomains?: string[];
};

export type MapSearchPromptInput = {
  runId: string;
  level: number;
  nodeId: string;
  nodeLabel: string;
  nodeRepresentative: string;
  parentLabel: string | null;
  siblingLabels: string[];
  childLabels: string[];
  sampleEventTitles: string[];
  sampleEventMarketTitles: string[];
  priorHeadlines: string[];
  softToolCapThisCall: number;
  windowHoursForThisCall: number;
};

function formatList(values: string[], maxItems: number): string {
  if (values.length === 0) return "- none";
  return values
    .slice(0, maxItems)
    .map((value, index) => `${index + 1}. ${trimForPrompt(value, 180)}`)
    .join("\n");
}

function trimForPrompt(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

export function buildMapSearchSystemPromptV2(
  config: MapSearchPromptConfig,
): string {
  const toolsMode =
    config.includeWebTool && config.includeXTool
      ? "Use both web_search and x_search when possible."
      : config.includeWebTool
        ? "Use web_search only."
        : config.includeXTool
          ? "Use x_search only."
          : "No server-side tools are available.";
  const domainRule = config.requireDistinctDomains
    ? "Prefer evidence from multiple distinct source domains."
    : "Domain diversity is preferred but not required.";
  const disallowedDomains = (config.disallowedSourceDomains ?? [])
    .map(value => value.trim().toLowerCase())
    .filter(value => value.length > 0);
  const disallowedRule =
    disallowedDomains.length > 0
      ? `Do not use prediction-market/operator pages as evidence. Disallowed source domains: ${disallowedDomains.join(", ")}.`
      : "Do not use prediction-market/operator pages as evidence.";
  return [
    "You are a market-map news retrieval agent.",
    "Return exactly one JSON object and nothing else.",
    "Do not output markdown, code fences, explanations, or prose outside JSON.",
    toolsMode,
    domainRule,
    disallowedRule,
    "Primary objective: fetch the most recent reliable context for this cluster.",
    "Before using tools, rank up to 3 search directions by expected freshness, reliability, and specificity to this node.",
    "Start with the highest-ranked direction.",
    "After at most 2 tool attempts without acceptable in-window evidence, pivot to another direction.",
    "If no acceptable in-window evidence is found by the soft tool cap provided in user context, stop and return PARTIAL or NO_EVIDENCE.",
    "Prefer search directions grounded in child labels and event|market samples over broad parent themes.",
    "Prefer pages with explicit publication time and concrete updates.",
    "Reliability priority: official > wire > major_media > specialist > social.",
    "Avoid rumor/gossip/opinion as evidence unless tied to a concrete verifiable update.",
    "Never use prediction-market/operator pages or exchange-marketing posts as evidence.",
    "If fast-breaking but not fully confirmed, keep it only when source is reliable and mark confirmation=developing or unconfirmed.",
    "For confirmed evidence, prefer corroboration from non-social sources.",
    "Use concise factual summaries that include why it matters for market direction.",
    `Target evidence count: up to ${config.maxEvidence}.`,
    `Favor evidence published within the last ${config.windowHours} hours, and prefer very recent updates within ${config.recentHoursHint} hours when available.`,
    "If evidence is weak or missing, set status=NO_EVIDENCE and keep evidence empty.",
    "If some evidence is relevant but incomplete, set status=PARTIAL.",
    "Never fabricate URLs, summaries, timestamps, or handles.",
    "Output must validate this JSON Schema:",
    JSON.stringify(MAP_SEARCH_AGENT_OUTPUT_V2_JSON_SCHEMA),
  ].join("\n");
}

export function buildMapSearchUserPromptV2(
  input: MapSearchPromptInput,
  config: MapSearchPromptConfig,
): string {
  return [
    "Find fresh evidence for this market-map cluster.",
    "",
    `run_id: ${input.runId}`,
    `level: ${input.level}`,
    `node_id: ${input.nodeId}`,
    `node_label: ${trimForPrompt(input.nodeLabel, 180)}`,
    `node_representative: ${trimForPrompt(input.nodeRepresentative, 180)}`,
    `parent_label: ${trimForPrompt(input.parentLabel ?? "-", 180)}`,
    `window_hours_for_this_call: ${input.windowHoursForThisCall}`,
    `soft_tool_cap_this_call: ${input.softToolCapThisCall}`,
    "",
    "Sibling labels (for disambiguation):",
    formatList(input.siblingLabels, 10),
    "",
    "Child labels (for drill-down direction):",
    formatList(input.childLabels, 12),
    "",
    "Sample event titles in this node:",
    formatList(input.sampleEventTitles, 16),
    "",
    "Sample event | representative market titles in this node:",
    formatList(input.sampleEventMarketTitles, 16),
    "",
    "Previously seen headlines (avoid duplicates):",
    formatList(input.priorHeadlines, 10),
    "",
    "Instructions:",
    `- Query tightly around this node and return at most ${config.maxEvidence} evidence items.`,
    "- Before tool calls, rank up to 3 candidate directions and pick the best one first.",
    "- If direction quality is weak after 2 tool attempts (stale/weak), pivot to the next direction.",
    "- Prioritize concrete, recent updates and avoid broad evergreen explainers.",
    "- Prefer query terms built from child labels and event|market pairs.",
    "- Respect soft_tool_cap_this_call as a hard per-node tool budget.",
    "- Focus on newest relevant context first (latest concrete updates).",
    "- Avoid prediction-market/operator pages; use external reporting and primary sources.",
    "- Keep each summary brief, factual, and market-relevant (1 sentence, max 300 chars).",
    "- summary must explain the factual update and why it matters for this cluster.",
    "- Set confirmation to: confirmed | developing | unconfirmed.",
    "- Set source_tier to one of: official | wire | major_media | specialist | social.",
    "- Use source_domain normalized from source_url host.",
    "- Fill next_focus with concise follow-up subtopics for deeper search.",
    "- Keep top-level summary short and concrete.",
  ].join("\n");
}
