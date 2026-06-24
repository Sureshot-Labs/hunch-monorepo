import { z } from "zod";

export const holderResearchBucketSchema = z.enum([
  "followup_existing",
  "sharp_minority",
  "sharp_side",
  "sharp_split",
  "clean_disagreement",
  "recent_flow",
  "event_bridge",
  "concentration_risk",
]);

export const holderResearchStatusSchema = z.enum([
  "PUBLISH",
  "CONTEXT",
  "SKIP",
]);

export const holderResearchAgentOutputV1Schema = z
  .object({
    version: z.literal("holder_research_v1"),
    status: holderResearchStatusSchema,
    bucket: holderResearchBucketSchema,
    confidence: z.coerce.number().min(0).max(1),
    signal_type: z.enum(["catalyst", "risk", "update"]),
    direction: z.enum(["up", "down", "mixed"]),
    headline: z.string().trim().min(8).max(140),
    summary: z.string().trim().min(24).max(320),
    rationale: z.string().trim().min(8).max(260),
    evidence_ids: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
    caveats: z.array(z.string().trim().min(1).max(180)).max(3),
  })
  .strict();

export type HolderResearchBucket = z.infer<typeof holderResearchBucketSchema>;
export type HolderResearchStatus = z.infer<typeof holderResearchStatusSchema>;
export type HolderResearchAgentOutputV1 = z.infer<
  typeof holderResearchAgentOutputV1Schema
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asTrimmedString(
  value: unknown,
  fallback: string,
  max: number,
): string {
  const text = typeof value === "string" ? value.trim() : fallback;
  return truncateAtBoundary(text.replace(/\s+/g, " "), max);
}

function truncateAtBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const boundary = Math.max(
    clipped.lastIndexOf(". "),
    clipped.lastIndexOf("; "),
    clipped.lastIndexOf(": "),
  );
  if (boundary >= Math.floor(max * 0.55)) return clipped.slice(0, boundary + 1);
  const space = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, space >= 0 ? space : Math.max(0, max - 3)).trimEnd()}...`;
}

function asStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => truncateAtBoundary(entry.replace(/\s+/g, " "), maxChars))
    .slice(0, maxItems);
}

export function parseHolderResearchAgentOutputV1(
  value: unknown,
): HolderResearchAgentOutputV1 {
  const record = asRecord(value);
  const repaired = {
    version: record.version,
    status: record.status,
    bucket: record.bucket,
    confidence: record.confidence,
    signal_type: record.signal_type,
    direction: record.direction,
    headline: asTrimmedString(record.headline, "Holder research signal", 140),
    summary: asTrimmedString(
      record.summary,
      "Holder research found an evidence-backed positioning signal.",
      320,
    ),
    rationale: asTrimmedString(
      record.rationale,
      "Internal holder evidence passed the configured research gates.",
      260,
    ),
    evidence_ids: asStringArray(record.evidence_ids, 6, 160),
    caveats: asStringArray(record.caveats, 3, 180),
  };
  return holderResearchAgentOutputV1Schema.parse(repaired);
}

export function buildHolderResearchSystemPrompt(): string {
  return [
    "You are a holder-research signal writer for Hunch, a prediction market product.",
    "Return exactly one JSON object matching holder_research_v1.",
    "Use only the supplied internal evidence. Do not invent markets, wallets, prices, balances, news, or evidence IDs.",
    "Write like a concise trader-facing product card: factual, plain-English, useful in one glance, no hype.",
    "The audience is a normal Hunch user. Do not overwhelm them with wallet IDs, z-scores, sample counts, every dollar figure, or source recaps.",
    "Use at most one important number in headline/summary unless a second number is essential.",
    "Mention 'sharp' only if it helps the user understand the read. Prefer simple phrases like 'informed wallets', 'unusual holder interest', or 'public news does not explain it'.",
    "Edge is supporting evidence only when sample count, stake, trades, and open exposure are strong. Never publish an edge-only claim.",
    "When delegated web/X research is provided, use it as background. Do not summarize all search results. Say the simple conclusion: public news explains the move, does not explain it, or evidence is mixed.",
    "PUBLISH means the holder data adds a useful, timely, feed-worthy read for users. It does not need to be unexplained by public news.",
    "Do not require a clean catalyst for PUBLISH. Confirmation, disagreement, side conviction, early positioning, or a clear risk caveat can all be publishable.",
    "High-score candidates have already passed upstream internal gates. For scores around 0.85 or higher, default to PUBLISH unless there is a concrete reason the user would learn almost nothing from the holder data.",
    "If public news partly explains the move, still choose PUBLISH when holder data adds incremental information: informed confirmation, unusual side selection, meaningful disagreement, fresh flow, or a useful risk caveat.",
    "Pay close attention to timing. Compare holder snapshot/activity times with dated public headlines. If a holder moved before the public catalyst or before consensus odds reacted, that increases signal value.",
    "Do not say public news explains the holder move unless the public information was available before or around the holder activity. Later headlines may validate an early holder signal.",
    "Choose CONTEXT when the candidate is interesting but not feed-worthy: holder data mostly repeats public news, the read is too balanced, the signal is too concentrated, or the incremental takeaway is weak.",
    "Choose SKIP when the evidence is weak, stale, untradeable, tiny, already obvious from odds alone, or mostly noise.",
    "If public context is missing, say 'public news does not explain this yet' rather than making an insider accusation. You may say it could be private information or noise only as a caveat.",
    "Whale concentration is not an automatic rejection if it creates a useful risk signal; make the concentration clear as a caveat.",
    "Do not give trading advice. Describe what the holder signal suggests and why it may matter.",
    "User-facing style:",
    "- headline: 4-8 words, natural, market-facing, no tag list.",
    "- summary: 18-40 words, 1-2 short sentences, explain the takeaway and why it matters now.",
    "- Write publication copy, not debug output. Do not use labels like 'Context:' or 'Why:' in headline or summary.",
    "- rationale: exactly 1 short sentence, internal-quality explanation for why the status was chosen.",
    "- caveats: 0-2 short caveats, only if they materially change trust in the signal.",
    "Avoid: metric dumps, source lists, long background, internal field names, 'z-score', 'n=', 'sample count', wallet addresses, and phrases like 'candidate', 'bucket', or 'edge metric' in headline/summary.",
    'Good headline examples: "Hormuz YES lacks public catalyst", "Croatia lean looks already priced", "Sharp holders split on Portugal total".',
    'Good summary examples: "A capable wallet is leaning YES, but public news still points to slow Hormuz recovery. Treat it as watchlist context, not a clean signal yet."',
    'Bad summary example: "YES has $138.9K tracked versus $384.5K on NO, z=1.7, n=11, resolved edge 16.5pp."',
  ].join("\n");
}

export function buildHolderResearchUserPrompt(input: {
  candidateJson: unknown;
  allowedEvidenceIds: string[];
}): string {
  return JSON.stringify(
    {
      task: "Judge whether this holder-positioning candidate deserves a concise holder_research signal card.",
      output_contract: {
        version: "holder_research_v1",
        status: "PUBLISH | CONTEXT | SKIP",
        bucket: "one supplied bucket",
        confidence: "0..1",
        signal_type: "catalyst | risk | update",
        direction: "up | down | mixed",
        headline: "4-8 word user-facing title",
        summary: "18-40 word plain-English takeaway",
        rationale: "one short sentence explaining the decision quality",
        evidence_ids: "subset of allowedEvidenceIds",
        caveats: "0-2 short important limitations",
      },
      style_rules: [
        "Write for a normal user scanning a signal feed.",
        "Do not include wallet IDs, source lists, z-scores, sample counts, or more than one important number in the visible copy.",
        "Use delegated search only to answer: does public information explain this holder move?",
        "Do not demote only because public information partly explains the move; ask whether holder data adds something useful.",
        "Compare holder activity/snapshot timing against dated public headlines; early holder positioning can be a publishable signal even if later news supports it.",
        "For high-score candidates, prefer PUBLISH unless holder data adds almost no incremental information.",
        "PUBLISH can be a confirmation, disagreement, or risk signal; it does not need to be a clean unexplained catalyst.",
        "If holder data adds a timely incremental read, choose PUBLISH.",
        "If the signal is only mildly interesting, mostly repeats public news, or is too noisy/concentrated to be useful, choose CONTEXT or SKIP and say why briefly.",
      ],
      allowedEvidenceIds: input.allowedEvidenceIds,
      candidate: input.candidateJson,
    },
    null,
    2,
  );
}
