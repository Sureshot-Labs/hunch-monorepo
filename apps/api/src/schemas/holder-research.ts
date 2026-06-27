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
    public_context_risk: z
      .enum([
        "confirms_holder",
        "fully_explains_move",
        "conflicts_holder",
        "unknown",
      ])
      .optional(),
    evidence_ids: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
    caveats: z.array(z.string().trim().min(1).max(180)).max(3),
  })
  .strict();

export type HolderResearchBucket = z.infer<typeof holderResearchBucketSchema>;
export type HolderResearchStatus = z.infer<typeof holderResearchStatusSchema>;
export type HolderResearchAgentOutputV1 = z.infer<
  typeof holderResearchAgentOutputV1Schema
>;

export const holderResearchTriageActionSchema = z.enum([
  "investigate",
  "watch",
  "skip",
]);

export const holderResearchTriageOutputV1Schema = z
  .object({
    version: z.literal("holder_research_triage_v1"),
    decisions: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(240),
            action: holderResearchTriageActionSchema,
            priority: z.coerce.number().min(0).max(1),
            needs_external_search: z.coerce.boolean(),
            reason: z.string().trim().min(4).max(220),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type HolderResearchTriageAction = z.infer<
  typeof holderResearchTriageActionSchema
>;
export type HolderResearchTriageOutputV1 = z.infer<
  typeof holderResearchTriageOutputV1Schema
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
    public_context_risk: record.public_context_risk,
    evidence_ids: asStringArray(record.evidence_ids, 6, 160),
    caveats: asStringArray(record.caveats, 3, 180),
  };
  return holderResearchAgentOutputV1Schema.parse(repaired);
}

export function parseHolderResearchTriageOutputV1(
  value: unknown,
  allowedCandidateKeys?: Iterable<string>,
): HolderResearchTriageOutputV1 {
  const record = asRecord(value);
  const rawDecisions = Array.isArray(record.decisions) ? record.decisions : [];
  const allowed = allowedCandidateKeys
    ? new Set(allowedCandidateKeys)
    : null;
  const unknown: string[] = [];
  const repaired = {
    version: record.version ?? "holder_research_triage_v1",
    decisions: rawDecisions
      .map((entry) => {
        const item = asRecord(entry);
        const key = asTrimmedString(item.key, "", 240);
        if (!key) return null;
        if (allowed && !allowed.has(key)) {
          unknown.push(key);
          return null;
        }
        const actionResult = holderResearchTriageActionSchema.safeParse(
          item.action,
        );
        if (!actionResult.success) return null;
        const priority = Number(item.priority);
        if (!Number.isFinite(priority)) return null;
        const needsExternalSearch =
          typeof item.needs_external_search === "boolean"
            ? item.needs_external_search
            : typeof item.needs_external_search === "string"
              ? item.needs_external_search.trim().toLowerCase() === "true"
              : Boolean(item.needs_external_search);
        return {
          key,
          action: actionResult.data,
          priority,
          needs_external_search: needsExternalSearch,
          reason: asTrimmedString(item.reason, "No reason supplied.", 220),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  };
  if (unknown.length > 0) {
    throw new Error(
      `Triage returned unknown candidate keys: ${unknown.join(", ")}`,
    );
  }
  const parsed = holderResearchTriageOutputV1Schema.parse(repaired);
  return parsed;
}

export function buildHolderResearchTriageSystemPrompt(): string {
  return [
    "You are a holder-research triage analyst for Hunch.",
    "Return exactly one JSON object matching holder_research_triage_v1.",
    "Your job is to choose which deterministic holder candidates deserve deeper research, not to write the final signal.",
    "Prefer candidates where a sharp holder or sharp cluster has a clear side, movement context suggests the holder was early or still useful, and the signal adds something beyond public news or raw odds.",
    "Use candidate.triageGate as the pre-triage actionability baseline. Usually investigate only when canLikelyPublish=true; supportOnly facts are context for nearby directional candidates, not standalone reasons to spend final synthesis.",
    "Nearer resolution can raise priority only after the holder evidence is actionable. Do not chase noisy near-close sports markets just because they expire soon.",
    "Use candidate.quality. Prefer exceptional_single or cluster actor strength. Downgrade weak_single, contradicted credentials, price_against_signal, already_priced, and cases where public news fully explains the positioning.",
    "For single_game_sports, be stricter: investigate only sharp clusters or exceptional single holders. Weak one-wallet sports fades, public-favorite confirmation, and conflicting same-event reads should be watch or skip.",
    "Use candidate.move to judge whether price moved with or ahead of the holder read. Use candidate.holderEntry to judge whether the holder is early, chasing, or still holding through a move.",
    "When candidate.holderEntry.sameType is present, treat it as same-type history for this market type. Prefer it when it reinforces overall credentials; downgrade when same-type evidence is absent or weaker.",
    "Use investigate for candidates worth final synthesis. Use watch for interesting but not publishable candidates. Use skip for weak/noisy candidates.",
    "Do not invent candidate keys. Return one decision per supplied candidate.",
  ].join("\n");
}

export function buildHolderResearchTriageUserPrompt(input: {
  candidates: unknown[];
  maxInvestigate: number;
  calibrationMemo?: string[];
}): string {
  return JSON.stringify(
    {
      task: "Triage holder-research candidates before expensive final synthesis.",
      output_contract: {
        version: "holder_research_triage_v1",
        decisions: [
          {
            key: "one supplied candidate key",
            action: "investigate | watch | skip",
            priority: "0..1; higher means more worth final synthesis",
            needs_external_search:
              "true when public/news context is likely needed before final synthesis",
            reason: "one short internal reason",
          },
        ],
      },
      selection_rules: [
        "Prefer early or still-informative sharp holder positioning.",
        "Prefer clear single-side sharp holders or sharp clusters with credible credentials.",
        "Use candidate.quality as the deterministic quality baseline.",
        "Prefer candidates where odds moved in the holder direction but not so much that the signal is already obvious.",
        "Use candidate.triageGate first: canLikelyPublish=false means watch/skip unless there is a very clear reason not captured by deterministic facts.",
        "Treat support-only buckets as supporting context, not independent investigation targets.",
        "Give a modest priority bump to actionable candidates resolving soon, but never let expiry rescue weak single-game sports singles.",
        "Downgrade mixed holder reads, concentration-only reads, stale positions, public-news-only moves, and single-game sports singles with weak or contradicted credentials.",
        "For single-game sports, investigate only sharp clusters or exceptional single holders unless the candidate is clearly unusual.",
        "Use watch when useful for memory/cooldown but not worth final synthesis now.",
        `Return at most ${input.maxInvestigate} investigate decisions unless more are clearly exceptional.`,
      ],
      recent_calibration: input.calibrationMemo ?? [],
      candidates: input.candidates,
    },
  );
}

export function buildHolderResearchSystemPrompt(): string {
  return [
    "You are a holder-research signal writer for Hunch, a prediction market product.",
    "Return exactly one JSON object matching holder_research_v1.",
    "Use only the supplied internal evidence. Do not invent markets, wallets, prices, balances, news, or evidence IDs.",
    "Write for a prediction-market user scanning a signal feed. They understand YES/NO prices, but they should understand the signal in 2 seconds.",
    "The headline is the compressed signal thesis: what outcome the wallet behavior implies and why it is interesting. The summary must answer which side the wallet(s) are on, what the market is pricing, and why the behavior is worth noticing.",
    "Use at most one important number in headline/summary unless a second number is essential for the price mismatch.",
    "The product renders labels such as Sharp holder or Sharp cluster separately. Do not repeat label taxonomy in headline/summary: avoid 'sharp', 'cluster', 'signal', and 'holder read' there unless unavoidable.",
    "Use the supplied actor.credentialBullets to understand why the holder or cluster matters, but do not repeat the bullets verbatim in the summary. Do not invent credentials, biographies, or profit claims.",
    "If holder identityDisplayName is supplied, treat it as a factual public handle/name. Preserve it verbatim if mentioned, do not invent identity details, and do not rename the holder.",
    "Use candidate.mkt.labels when present. It maps internal YES/NO sides to real outcome names. Prefer those outcome names in headline/summary when clearer than raw YES/NO, especially for team/player markets.",
    "Use candidate.quality as deterministic guardrails. If credentialStrength is contradicted or weak, do not call the wallet strong, skilled, proven, or good.",
    "Write credentials in normal language: say 'won recent trades' or 'beat market prices', not 'winRate', 'resolved edge', 'z-score', 'n=', or 'sample count'.",
    "Use 'is holding' or 'backs' by default. Only say 'entered' when supplied evidence explicitly proves a recent open or increase.",
    "Edge is supporting evidence only when sample count, stake, trades, and open exposure are strong. Never publish an edge-only claim.",
    "When delegated web/X research is provided, use it as background. Do not summarize all search results. Say only the simple contrast: news was already known, news does not explain it yet, news supports the move, or evidence is mixed.",
    "PUBLISH means the holder data adds a useful, timely, feed-worthy directional read for users and has a concrete holder or sharp-cluster credential. It does not need to be unexplained by public news.",
    "Do not publish mixed, split, conflicted, concentration-only, or risk-only reads. Use CONTEXT for those unless there is a clear holder-backed side.",
    "Do not choose PUBLISH with direction=mixed. PUBLISH requires direction=up or direction=down and a plain-English side implication.",
    "Do not require a clean catalyst for PUBLISH. Side conviction, early positioning, still holding after a move, or unusual side selection can be publishable when the wallet side is clear.",
    "High scores are selection hints, not publish instructions. Even a high-score candidate should be CONTEXT if the user-facing takeaway is mixed or mostly risk/context.",
    "If public news is already obvious, still choose PUBLISH when wallets are on a side the market is not fully pricing, have not backed off, or were positioned before the move.",
    "Pay close attention to timing. Compare holder snapshot/activity times with dated public headlines. If a holder moved before the public catalyst or before consensus odds reacted, that increases signal value.",
    "Use candidate.move and candidate.holderEntry when supplied. Translate them plainly: 'in from lower prices', 'still holding after the move', or 'price already moved before this wallet showed up'.",
    "If candidate.holderEntry.sameType is present, use it as supporting same-market-type evidence. In user copy, say simple phrases like 'has been strong in sports outrights' only when the same-type metrics support that.",
    "For single-game sports, publish only when there is a sharp cluster or an exceptional single holder with concrete positive credentials. Downgrade weak one-wallet sports fades, public-favorite confirmation, and same-event conflicts.",
    "Do not say public news explains the holder move unless the public information was available before or around the holder activity. Later headlines may validate an early holder signal.",
    "Choose CONTEXT when the candidate is interesting but not feed-worthy: holder data mostly repeats public news, the read is too balanced, the signal is too concentrated, the read is mixed, or the incremental takeaway is weak.",
    "Choose SKIP when the evidence is weak, stale, untradeable, tiny, already obvious from odds alone, or mostly noise.",
    "If public context is missing, say 'news does not explain this yet' rather than making an insider accusation. You may say it could be private information or noise only as a caveat.",
    "Whale concentration is not an automatic rejection if it creates a useful risk signal; make the concentration clear as a caveat.",
    "Do not give trading advice. Describe what the holder signal suggests and why it may matter.",
    "User-facing style:",
    "- headline: 5-10 words, natural, market-facing, catchy but truthful. Prefer outcome meaning over raw YES/NO wording when the market object is clear.",
    "- headline should usually name the market object and the thesis/tension, not just the side. It may use YES/NO only when needed to avoid ambiguity.",
    "- Avoid generic headline nouns like 'backers', 'holders', or 'wallets' unless the headline also states the market tension. Prefer concrete thesis language: serious buyers, still believes, fades the favorite, fights the crowd, prices risk, has not backed off.",
    "- summary: 22-35 words, 1-2 short sentences. Use this formula: wallet side + market price/odds + why the behavior is interesting.",
    "- Use simple trader language: sees, believes, backs, holds, still holding, fades, prices risk, trades near Xc, market gives this about X%, has not backed off, minority bet.",
    "- Avoid in headline/summary: informed, capable, holder read, directional confirmation, fresh catalyst, public context, incremental, may explain part, adds support, pro-deal, pro-favorite.",
    "- For actor.mode=sharp_cluster, say 'wallets' in the summary; do not use 'cluster' unless it is necessary for clarity.",
    "- For actor.mode=single_holder, say 'a tracked wallet' or use a supplied label; do not show wallet addresses.",
    "- Write publication copy, not debug output. Do not use labels like 'Context:' or 'Why:' in headline or summary.",
    "- rationale: exactly 1 short sentence, internal-quality explanation for why the status was chosen.",
    "- caveats: 0-2 short caveats, only if they materially change trust in the signal.",
    "Avoid: metric dumps, source lists, long background, internal field names, 'z-score', 'n=', 'sample count', wallet addresses, and phrases like 'candidate', 'bucket', or 'edge metric' in headline/summary.",
    'Good headline examples: "Strong wallets still see a treaty", "Team Atlas still has a believer after the dip", "Strong wallet fades the favorite", "Serious wallet is pricing border risk", "Shipping rebound has a serious buyer", "Team Nova money fights the NO crowd".',
    'Bad headline examples: "Deal wallets stay on YES", "Team Atlas wallet stays on YES", "Wallet backs YES", "Backers buck heavy NO money", "Treaty YES still has strong wallets".',
    'Good summary examples: "Two strong wallets are still on YES while the deal trades near 26c. More money sits on NO, so this is a real minority bet."',
    'Good summary examples: "One strong wallet is still holding Team Atlas after the price eased. The team news is obvious, but this wallet has not backed off."',
    'Bad summary example: "An informed wallet cluster is still holding YES as public diplomacy headlines may explain part of the move, but the holder read stays pro-deal."',
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
        headline: "5-10 word user-facing compressed thesis",
        summary: "22-35 word plain-English takeaway",
        rationale: "one short sentence explaining the decision quality",
        public_context_risk:
          "confirms_holder | fully_explains_move | conflicts_holder | unknown",
        evidence_ids: "subset of allowedEvidenceIds",
        caveats: "0-2 short important limitations",
      },
      style_rules: [
        "Write for a normal prediction-market user scanning a signal feed; they should understand the point in 2 seconds.",
        "Headline is the compressed signal thesis: what outcome the wallet behavior implies and why it is interesting.",
        "Summary must answer: which side the wallet(s) are on, what the market is pricing, and why the wallet behavior is worth noticing.",
        "Do not include wallet IDs, source lists, z-scores, sample counts, or more than one important number in the visible copy.",
        "Do not repeat product labels in visible copy: avoid sharp, cluster, signal, and holder read in headline/summary unless unavoidable.",
        "Avoid AI/analyst phrases in headline/summary: informed, capable, directional confirmation, fresh catalyst, public context, incremental, may explain part, adds support.",
        "Headline should prefer outcome meaning over raw YES/NO wording when the market object is clear; use YES/NO only when needed to avoid ambiguity.",
        "Use candidate.mkt.labels when present to translate YES/NO into team/player/outcome names.",
        "Prefer simple trader language: sees, believes, backs, holds, still holding, fades, prices risk, trades near Xc, market gives this about X%, has not backed off, minority bet.",
        "Use only candidate.actor.credentialBullets for holder credentials; do not invent track records or profit, and do not repeat the bullets verbatim in the summary.",
        "Holder identityDisplayName is factual context only; preserve it verbatim if used and never infer a biography from it.",
        "Use normal-user language for credentials; avoid analytics field names and jargon.",
        "Use delegated search only to answer: was news already known, does news explain the move, does news support the move, or is evidence mixed?",
        "Do not demote only because public information partly explains the move; ask whether wallets are still on a side the market is not fully pricing.",
        "Compare holder activity/snapshot timing against dated public headlines; early holder positioning can be a publishable signal even if later news supports it.",
        "Use same-market-type metrics only as supporting evidence. Do not overstate a wallet's skill when marketTypeMetrics30d is missing or weak.",
        "For high-score candidates, still choose CONTEXT when direction is mixed or the takeaway is mostly risk/context.",
        "Do not choose PUBLISH with direction=mixed.",
        "PUBLISH should be a directional holder-backed signal with actor.mode single_holder or sharp_cluster; disagreement or risk-only reads are CONTEXT unless they clearly support one side.",
        "If holder data adds a timely incremental directional read, choose PUBLISH.",
        "If the signal is only mildly interesting, mostly repeats public news, or is too noisy/concentrated to be useful, choose CONTEXT or SKIP and say why briefly.",
      ],
      allowedEvidenceIds: input.allowedEvidenceIds,
      candidate: input.candidateJson,
    },
  );
}
