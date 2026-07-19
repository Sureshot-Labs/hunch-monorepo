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

export const holderResearchExecutionPrioritySchema = z.enum([
  "normal",
  "high_conviction",
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
    execution_priority: holderResearchExecutionPrioritySchema.default("normal"),
    execution_priority_reason: z.string().trim().max(180).default(""),
    evidence_ids: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
    caveats: z.array(z.string().trim().min(1).max(180)).max(3),
  })
  .strict();

export type HolderResearchBucket = z.infer<typeof holderResearchBucketSchema>;
export type HolderResearchStatus = z.infer<typeof holderResearchStatusSchema>;
export type HolderResearchExecutionPriority = z.infer<
  typeof holderResearchExecutionPrioritySchema
>;
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

export const holderResearchTriageReasonCodeV2Schema = z.enum([
  "strong_actor",
  "early_position",
  "aligned_flow",
  "opposed_flow",
  "already_priced",
  "weak_credentials",
  "insufficient_evidence",
  "research_needed",
]);

export const holderResearchResearchNeedV2Schema = z.enum([
  "none",
  "news_timing",
  "market_context",
  "resolution_context",
]);

export const holderResearchTriageOutputV2Schema = z
  .object({
    version: z.literal("holder_research_triage_v2"),
    decisions: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(240),
            action: holderResearchTriageActionSchema,
            reason_codes: z
              .array(holderResearchTriageReasonCodeV2Schema)
              .max(6),
            research_need: holderResearchResearchNeedV2Schema,
            reason: z.string().trim().min(4).max(220),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type HolderResearchTriageOutputV2 = z.infer<
  typeof holderResearchTriageOutputV2Schema
>;
export type HolderResearchTriageDecisionV2 =
  HolderResearchTriageOutputV2["decisions"][number];

export const holderResearchExternalResearchV2Schema = z
  .object({
    status: z.enum(["ok", "no_evidence", "error"]),
    verdict: z.enum([
      "supports_holder_side",
      "supports_opposite_side",
      "already_public",
      "unexplained",
      "mixed",
      "unknown",
    ]),
    timing: z.enum([
      "before_holder",
      "around_holder",
      "after_holder",
      "unknown",
    ]),
    summary: z.string().trim().max(320),
    citations: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            url: z.string().url().max(2_000),
            publishedAt: z.string().datetime().nullable(),
          })
          .strict(),
      )
      .max(3),
    comparableOdds: z
      .object({
        side: z.enum(["YES", "NO"]),
        probabilityMin: z.number().min(0).max(1),
        probabilityMax: z.number().min(0).max(1),
        asOf: z.string().datetime(),
        sources: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(200),
                url: z.string().url().max(2_000),
              })
              .strict(),
          )
          .min(1)
          .max(3),
      })
      .strict()
      .refine((odds) => odds.probabilityMin <= odds.probabilityMax, {
        message: "Minimum probability must not exceed maximum probability.",
      })
      .nullable()
      .optional(),
  })
  .strict();

export type HolderResearchExternalResearchV2 = z.infer<
  typeof holderResearchExternalResearchV2Schema
>;

export const holderResearchFinalOutputV2Schema = z
  .object({
    version: z.literal("holder_research_v2"),
    verdict: z.enum(["publish", "context", "skip"]),
    evidence_assessment: z.enum([
      "strong",
      "adequate",
      "mixed",
      "contradicted",
      "insufficient",
    ]),
    reason_codes: z.array(z.string().trim().min(1).max(80)).max(8),
    rationale: z.string().trim().min(8).max(260),
    evidence_ids: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
    copy: z
      .object({
        headline: z.string().trim().min(8).max(140),
        why_now: z.string().trim().min(16).max(260),
        caveats: z.array(z.string().trim().min(1).max(180)).max(2),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type HolderResearchFinalOutputV2 = z.infer<
  typeof holderResearchFinalOutputV2Schema
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
  const executionPriority = "normal" as const;
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
    execution_priority: executionPriority,
    execution_priority_reason: "",
    evidence_ids: asStringArray(record.evidence_ids, 6, 160),
    caveats: asStringArray(record.caveats, 3, 180),
  };
  return holderResearchAgentOutputV1Schema.parse(repaired);
}

function parseHolderResearchTriageDecisionBase(
  entry: unknown,
  allowed: Set<string> | null,
  unknown: string[],
) {
  const item = asRecord(entry);
  const key = asTrimmedString(item.key, "", 240);
  if (!key) return null;
  if (allowed && !allowed.has(key)) {
    unknown.push(key);
    return null;
  }
  const action = holderResearchTriageActionSchema.safeParse(item.action);
  if (!action.success) return null;
  return { action: action.data, item, key };
}

export function parseHolderResearchTriageOutputV1(
  value: unknown,
  allowedCandidateKeys?: Iterable<string>,
): HolderResearchTriageOutputV1 {
  const record = asRecord(value);
  const rawDecisions = Array.isArray(record.decisions) ? record.decisions : [];
  const allowed = allowedCandidateKeys ? new Set(allowedCandidateKeys) : null;
  const unknown: string[] = [];
  const repaired = {
    version: record.version ?? "holder_research_triage_v1",
    decisions: rawDecisions
      .map((entry) => {
        const base = parseHolderResearchTriageDecisionBase(
          entry,
          allowed,
          unknown,
        );
        if (!base) return null;
        const priority = Number(base.item.priority);
        if (!Number.isFinite(priority)) return null;
        const needsExternalSearch =
          typeof base.item.needs_external_search === "boolean"
            ? base.item.needs_external_search
            : typeof base.item.needs_external_search === "string"
              ? base.item.needs_external_search.trim().toLowerCase() === "true"
              : Boolean(base.item.needs_external_search);
        return {
          key: base.key,
          action: base.action,
          priority,
          needs_external_search: needsExternalSearch,
          reason: asTrimmedString(base.item.reason, "No reason supplied.", 220),
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

export function parseHolderResearchTriageOutputV2(
  value: unknown,
  allowedCandidateKeys?: Iterable<string>,
): HolderResearchTriageOutputV2 {
  const record = asRecord(value);
  const rawDecisions = Array.isArray(record.decisions) ? record.decisions : [];
  const allowed = allowedCandidateKeys ? new Set(allowedCandidateKeys) : null;
  const unknown: string[] = [];
  const decisions = rawDecisions
    .map((entry) => {
      const base = parseHolderResearchTriageDecisionBase(
        entry,
        allowed,
        unknown,
      );
      if (!base) return null;
      const researchNeed = holderResearchResearchNeedV2Schema.safeParse(
        base.item.research_need,
      );
      if (!researchNeed.success) return null;
      const reasonCodes = Array.isArray(base.item.reason_codes)
        ? base.item.reason_codes
            .map((reason) =>
              holderResearchTriageReasonCodeV2Schema.safeParse(reason),
            )
            .filter((reason) => reason.success)
            .map((reason) => reason.data)
        : [];
      return {
        key: base.key,
        action: base.action,
        reason_codes: Array.from(new Set(reasonCodes)).slice(0, 6),
        research_need: researchNeed.data,
        reason: asTrimmedString(base.item.reason, "No reason supplied.", 220),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (unknown.length > 0) {
    throw new Error(
      `Triage returned unknown candidate keys: ${unknown.join(", ")}`,
    );
  }
  return holderResearchTriageOutputV2Schema.parse({
    version: record.version ?? "holder_research_triage_v2",
    decisions,
  });
}

export function parseHolderResearchExternalResearchV2(
  value: unknown,
): HolderResearchExternalResearchV2 {
  const record = asRecord(value);
  const parsed = holderResearchExternalResearchV2Schema.safeParse(record);
  if (parsed.success) return parsed.data;
  return {
    status: "error",
    verdict: "unknown",
    timing: "unknown",
    summary: "External research response could not be validated.",
    citations: [],
    comparableOdds: null,
  };
}

const uncitedExternalClaimPattern =
  /\b(?:article|bookmaker|coverage|forecast|headline|news|odds?|poll|preview|report|source|sportsbook)\b/i;

export function containsHolderResearchExternalClaim(value: string): boolean {
  return uncitedExternalClaimPattern.test(value);
}

export function normalizeHolderResearchExternalResearchV2(
  value: HolderResearchExternalResearchV2,
): HolderResearchExternalResearchV2 {
  const hasUnsupportedClaim =
    value.citations.length === 0 &&
    (value.status === "ok" ||
      value.verdict !== "unknown" ||
      value.comparableOdds != null ||
      containsHolderResearchExternalClaim(value.summary));
  if (!hasUnsupportedClaim) return value;
  return {
    status: "no_evidence",
    verdict: "unknown",
    timing: "unknown",
    summary: "No cited external evidence was available.",
    citations: [],
    comparableOdds: null,
  };
}

export function parseHolderResearchFinalOutputV2(
  value: unknown,
): HolderResearchFinalOutputV2 {
  const record = asRecord(value);
  const copy = record.copy == null ? null : asRecord(record.copy);
  return holderResearchFinalOutputV2Schema.parse({
    version: record.version,
    verdict: record.verdict,
    evidence_assessment: record.evidence_assessment,
    reason_codes: asStringArray(record.reason_codes, 8, 80),
    rationale: asTrimmedString(
      record.rationale,
      "The supplied evidence did not support publication.",
      260,
    ),
    evidence_ids: asStringArray(record.evidence_ids, 6, 160),
    copy:
      copy == null
        ? null
        : {
            headline: asTrimmedString(
              copy.headline,
              "Holder positioning deserves attention",
              140,
            ),
            why_now: asTrimmedString(
              copy.why_now,
              "The current positioning adds a timely reason to review this market.",
              260,
            ),
            caveats: asStringArray(copy.caveats, 2, 180),
          },
  });
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
    "Read candidate.quality.flowProfile, repeatProfile, and riskTags. unsupported_crypto_single and negative_single_minority are hard actionability blockers; mixed/opposed flow, risky repeats, public-priced high entry, and uncertain holder-entry context are penalties, not automatic skips for strong clusters.",
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
  return JSON.stringify({
    task: "Triage holder-research candidates before expensive final synthesis.",
    output_contract: {
      version: "holder_research_triage_v1",
      decisions: [
        {
          key: "one supplied candidate key",
          action: "investigate | watch | skip",
          priority: "0..1; higher means more worth final synthesis",
          needs_external_search:
            "true when outside/news context is likely needed before final synthesis",
          reason: "one short internal reason",
        },
      ],
    },
    selection_rules: [
      "Prefer early or still-informative sharp holder positioning.",
      "Prefer clear single-side sharp holders or sharp clusters with credible credentials.",
      "Use candidate.quality as the deterministic quality baseline, including flowProfile, repeatProfile, and riskTags.",
      "Prefer candidates where odds moved in the holder direction but not so much that the signal is already obvious.",
      "Use candidate.triageGate first: canLikelyPublish=false means watch/skip unless there is a very clear reason not captured by deterministic facts.",
      "Treat support-only buckets as supporting context, not independent investigation targets.",
      "Give a modest priority bump to actionable candidates resolving soon, but never let expiry rescue weak single-game sports singles.",
      "Downgrade mixed/opposed flow, risky repeats, concentration-only reads, stale positions, public-news-only moves, and single-game sports singles with weak or contradicted credentials.",
      "For single-game sports, investigate only sharp clusters or exceptional single holders unless the candidate is clearly unusual.",
      "Use watch when useful for memory/cooldown but not worth final synthesis now.",
      `Return at most ${input.maxInvestigate} investigate decisions unless more are clearly exceptional.`,
    ],
    recent_calibration: input.calibrationMemo ?? [],
    candidates: input.candidates,
  });
}

export function buildHolderResearchTriageSystemPromptV2(): string {
  return [
    "You are the bounded triage stage for Hunch holder research.",
    "Return exactly one JSON object matching holder_research_triage_v2 and one decision per supplied key.",
    "Candidates are already ordered by deterministic selection. Filter them; do not invent a second ranking.",
    "Use only decisionFeatures. Missing values are unknown, never zero.",
    "Investigate only a directional, publish-eligible candidate with adequate holder credentials and a timely reason to look.",
    "Watch means useful context that is not ready for final synthesis. Skip means weak, stale, contradicted, or redundant evidence.",
    "Use selectedSide and oppositeSide symmetrically. Edge is supporting evidence only with Z, samples, stake, and exposure.",
    "For opposed flow, already-priced movement, repeats, and weak credentials, prefer watch or skip unless a strong cluster remains clearly informative.",
    "Choose research_need only for the single unanswered question most likely to change the decision.",
    "Do not include wallet identifiers, visible publication copy, probabilities of success, or model priority scores.",
  ].join("\n");
}

export function buildHolderResearchTriageUserPromptV2(input: {
  candidates: unknown[];
  maxInvestigate: number;
}): string {
  return JSON.stringify({
    task: "Filter deterministic holder-research candidates before final synthesis.",
    output_contract: {
      version: "holder_research_triage_v2",
      decisions: [
        {
          key: "one supplied key",
          action: "investigate | watch | skip",
          reason_codes:
            "subset of strong_actor | early_position | aligned_flow | opposed_flow | already_priced | weak_credentials | insufficient_evidence | research_needed",
          research_need:
            "none | news_timing | market_context | resolution_context",
          reason: "one short internal reason",
        },
      ],
    },
    rules: [
      "Preserve supplied order; action filters candidates and is not a ranking score.",
      "A deterministic blocker cannot be overridden.",
      "Raw win rate is intentionally absent; use calibrated edge together with Z and sample size.",
      "Opposing sharp evidence is a conflict, not proof that either side is correct.",
      `Mark no more than ${input.maxInvestigate} candidates investigate unless the caller supplied fewer candidates.`,
    ],
    candidates: input.candidates,
  });
}

export function buildHolderResearchSystemPrompt(): string {
  return [
    "You write Hunch holder-research signals like a strong trader sharing a reason to look now in a private trading group.",
    "Return exactly one JSON object matching holder_research_v1.",
    "Use only the supplied internal evidence. Do not invent markets, wallets, prices, balances, news, or evidence IDs.",
    "Write for a prediction-market trader scanning a Telegram-style signal feed. They understand YES/NO prices, but they should understand the setup in 2 seconds.",
    "The headline is the compressed signal thesis: what outcome the wallet behavior implies and why it is interesting. The summary must answer which side the wallet(s) are on, what the market is pricing, and why the behavior is worth noticing.",
    "Use at most one important number in headline/summary unless a second number is essential for the price mismatch.",
    "The product renders labels such as Strong holder or Strong wallets separately. Do not repeat label taxonomy in headline/summary: avoid 'sharp', 'cluster', 'signal', and 'holder read' there unless unavoidable.",
    "The Telegram renderer separately owns the emoji, numeric notification hook, current-position line, and proof rows. Do not imitate those UI elements in generated copy, and do not output Markdown, emoji, bullets, section labels, or a second notification headline.",
    "Use the supplied actor.credentialBullets to understand why the holder or cluster matters, but do not repeat the bullets verbatim in the summary. Do not invent credentials, biographies, or profit claims.",
    "If holder identityDisplayName is supplied, treat it as a factual supplied display name. Preserve it verbatim if mentioned, do not invent identity details, and do not rename the holder.",
    "Use candidate.mkt.sideCopy when present. It is the deterministic plain-English trade side; prefer sideCopy.plainPosition and sideCopy.winCondition over raw YES/NO or bare Over/Under wording.",
    "Use candidate.mkt.labels and candidate.mkt.sideCopies as fallbacks. They map internal YES/NO sides to real outcome names and button/price labels.",
    "For totals, never write bare 'Over', 'Under', or 'O/U 2.5'. Name the threshold and scope: 'Under 2.5 total goals', 'Over 1.5 first-half goals', or the supplied sideCopy wording.",
    "For team NO/fade markets, do not write awkward phrases like 'NO France' or synthetic button labels like 'France not to win'. Use 'fading France', 'against France', or the supplied sideCopy wording.",
    "Whenever you mention a price, name the priced side explicitly. If the selected side is NO at 47c, do not write 'France trades at 54c' without saying that 54c is the France/YES price; prefer the selected-side price when available.",
    "Use candidate.quality as deterministic guardrails. If credentialStrength is contradicted or weak, do not call the wallet smart, strong, skilled, proven, or good.",
    "Use candidate.quality.flowProfile, repeatProfile, and riskTags: unsupported_crypto_single and negative_single_minority should not be PUBLISH; mixed/opposed flow, risky repeats, public-priced high entry, and uncertain holder-entry context lower confidence and need a clear reason to publish.",
    "Write credentials in normal language: say 'won recent trades' or 'beat market prices', not 'winRate', 'resolved edge', 'z-score', 'n=', or 'sample count'.",
    "Use 'is holding' or 'backs' by default. Only say 'entered' when supplied evidence explicitly proves a recent open or increase.",
    "Edge is supporting evidence only when sample count, stake, trades, and open exposure are strong. Never publish an edge-only claim.",
    "When delegated web/X research is provided, use it as background. Do not summarize all search results. Say only the simple contrast: outside information supports the holder side, supports the opposite side, mostly shows the move was already public, does not explain it yet, or evidence is mixed.",
    "PUBLISH means the holder data adds a timely, feed-worthy reason to look now and has a concrete holder or cluster credential. It does not need to be unexplained by public news.",
    "Do not publish mixed, split, conflicted, concentration-only, or risk-only reads. Use CONTEXT for those unless there is a clear holder-backed side.",
    "Do not choose PUBLISH with direction=mixed. PUBLISH requires direction=up or direction=down and a plain-English side implication.",
    "Do not require a clean catalyst for PUBLISH. Wallet conviction, early positioning, still holding after a move, or unusual side selection can be publishable when the wallet side is clear.",
    "High scores are selection hints, not publish instructions. Even a high-score candidate should be CONTEXT if the user-facing takeaway is mixed or mostly risk/context.",
    "If public news is already obvious, still choose PUBLISH when wallets are on a side the market is not fully pricing, have not backed off, or were positioned before the move.",
    "Pay close attention to timing. Compare holder snapshot/activity times with dated public headlines. If a holder moved before the public catalyst or before consensus odds reacted, that increases signal value.",
    "Use candidate.move and candidate.holderEntry when supplied. Translate them plainly: 'in from lower prices', 'still holding after the move', or 'price already moved before this wallet showed up'.",
    "If candidate.holderEntry.sameType is present, use it as supporting same-market-type evidence. In user copy, say simple phrases like 'has been strong in sports outrights' only when the same-type metrics support that.",
    "For single-game sports, publish only when there is a strong cluster or an exceptional single holder with concrete positive credentials. Downgrade weak one-wallet sports fades, public-favorite confirmation, and same-event conflicts.",
    "Do not say public news explains the holder move unless the public information was available before or around the holder activity. Later headlines may validate an early holder signal.",
    "Choose CONTEXT when the candidate is interesting but not feed-worthy: holder data mostly repeats public news, the read is too balanced, the signal is too concentrated, the read is mixed, or the useful takeaway is weak.",
    "Choose SKIP when the evidence is weak, stale, untradeable, tiny, already obvious from odds alone, or mostly noise.",
    "If outside information is missing, say 'news does not explain this yet' rather than making an insider accusation. You may say it could be private information or noise only as a caveat.",
    "Whale concentration is not an automatic rejection if it creates a useful risk signal; make the concentration clear as a caveat.",
    "Do not give trading advice. Describe what the holder signal suggests and why it may matter.",
    "Never use filler such as 'Holder activity is the primary evidence for this signal', 'worth noticing', 'worth a look', 'Cluster now', or 'Wallet edge'. If verified context cannot add a concrete sentence, keep the public summary minimal rather than inventing one.",
    "User-facing style:",
    "- headline: 5-10 words, natural, trader-native, catchy but truthful. Lead with what strong wallets are doing, not just what the market is. Use 'smart wallets' only when credentials are strong.",
    "- headline should usually name the market object and the thesis/tension. It may use YES/NO only when needed to avoid ambiguity.",
    "- Do not repeat the headline in the first summary sentence. Headline is the hook/thesis; summary sentence 1 must add new information such as price, market context, public-news tension, why-now, or position size. Do not start the summary by restating the same actor/action from the headline.",
    "- Avoid repeating 'Strong wallets' in the headline when the rendered label already makes the actor obvious and a more specific trade title is possible.",
    "- For actor.mode=sharp_cluster, the headline may start with 'Strong wallets' or 'Smart wallets' when credentials are strong and it also says the trade/read: fading a favorite, backing an underdog, still holding, taking the other side, or buying before the market moves.",
    "- For actor.mode=single_holder, say 'A strong wallet' only when credentials are strong; otherwise vary between the supplied display name, 'this wallet', or 'a tracked wallet'.",
    "- Avoid generic headline nouns like 'backers', 'holders', or 'wallets' unless the headline also states the market tension. Avoid overusing 'serious buyer(s)'.",
    "- summary: 22-45 words, 1-2 short sentences. Use a flexible checklist, not a fixed template: wallet side, market price/odds, whether the side is obvious or contrarian, whether public news explains it, and why a trader should look now.",
    "- Make each summary feel specific to the setup. Do not reuse the same sentence shape across signals.",
    "- Use simple trader language: smart wallets, strong wallets, wallet conviction, not the obvious side, sees, believes, backs, holds, still holding, fading, backing, prices risk, trades near Xc, market gives this about X%, has not backed off, minority bet.",
    "- Avoid in headline/summary: informed, capable, holder read, directional confirmation, fresh catalyst, public context, incremental, may explain part, adds support, pro-deal, pro-favorite.",
    "- For actor.mode=sharp_cluster, say 'wallets' in the summary; do not use 'cluster' unless it is necessary for clarity.",
    "- For actor.mode=single_holder, use a supplied display name when helpful; otherwise vary neutral phrases like 'this wallet' or 'a tracked wallet'. Do not show wallet addresses.",
    "- Write publication copy, not debug output. Do not use labels like 'Context:' or 'Why:' in headline or summary.",
    "- rationale: exactly 1 short sentence, internal-quality explanation for why the status was chosen.",
    "- caveats: 0-2 short caveats, only if they materially change trust in the signal.",
    "Avoid: metric dumps, source lists, long background, internal field names, 'z-score', 'n=', 'sample count', wallet addresses, and phrases like 'candidate', 'bucket', or 'edge metric' in headline/summary.",
    'Good headline examples: "Strong wallets are fading Norway", "Strong wallets back France to cover", "Smart money is against the favorite", "A strong wallet is still holding Spain", "Team Atlas still has a believer after the dip", "Wallets are buying Under 2.5 goals".',
    'Bad headline examples: "Deal wallets stay on YES", "Team Atlas wallet stays on YES", "Wallet backs YES", "Market signal detected", "Interesting wallet cluster", "Wallets buy NO O/U 2.5", "Under is getting flow".',
    'Bad headline/summary pair: headline "Strong wallets are still backing Spain"; summary "Strong wallets are backing Spain to win the World Cup while the market sits near 19c."',
    'Good headline/summary pair: headline "Strong wallets are still backing Spain"; summary "Spain trades near 19c, and the wallet side has not backed off after the prior move."',
    'Good summary examples: "Two strong wallets are still on YES while the deal trades near 26c. More money sits on NO, so this is a real minority bet."',
    'Good summary examples: "One strong wallet is still holding Team Atlas after the price eased. The team news is obvious, but this wallet has not backed off."',
    'Good summary examples: "Known odds and team news already lean France, so this is not a hidden catalyst. The reason to look now is that strong wallets are still buying the cover near 54c."',
    'Good summary examples: "Strong wallets are on Under 2.5 total goals, meaning 0-2 goals cashes. Price has barely moved, so this is mostly a copy-flow read for now."',
    'Bad summary example: "An informed wallet cluster is still holding YES as public diplomacy headlines may explain part of the move, but the holder read stays pro-deal."',
    'Bad summary example: "YES has $138.9K tracked versus $384.5K on NO, z=1.7, n=11, resolved edge 16.5pp."',
    'Bad summary example: "Wallets are on NO in O/U 2.5 and public context is mixed."',
  ].join("\n");
}

export function buildHolderResearchUserPrompt(input: {
  candidateJson: unknown;
  allowedEvidenceIds: string[];
}): string {
  return JSON.stringify({
    task: "Judge whether this holder-positioning candidate deserves a concise holder_research signal card.",
    output_contract: {
      version: "holder_research_v1",
      status: "PUBLISH | CONTEXT | SKIP",
      bucket: "one supplied bucket",
      confidence: "0..1",
      signal_type: "catalyst | risk | update",
      direction: "up | down | mixed",
      headline: "5-10 word user-facing compressed thesis",
      summary: "22-45 word plain-English takeaway",
      rationale: "one short sentence explaining the decision quality",
      public_context_risk:
        "confirms_holder | fully_explains_move | conflicts_holder | unknown",
      evidence_ids: "subset of allowedEvidenceIds",
      caveats: "0-2 short important limitations",
    },
    style_rules: [
      "Write like a strong trader sharing a reason to look now in a private group; a normal prediction-market user should understand the point in 2 seconds.",
      "Headline is the compressed signal thesis: what outcome the wallet behavior implies and why it is interesting.",
      "Summary must answer: which side the wallet(s) are on, what the market is pricing, and why the wallet behavior is worth noticing.",
      "Do not repeat the headline in the first summary sentence. Headline is the hook/thesis; summary sentence 1 must add new information such as price, market context, public-news tension, why-now, or position size. Do not start the summary by restating the same actor/action from the headline.",
      "Do not include wallet IDs, source lists, z-scores, sample counts, or more than one important number in the visible copy.",
      "Do not repeat product labels in visible copy: avoid sharp, cluster, signal, and holder read in headline/summary unless unavoidable.",
      "Avoid AI/analyst phrases in headline/summary: informed, capable, directional confirmation, fresh catalyst, public context, incremental, may explain part, adds support.",
      "Headline should prefer outcome meaning over raw YES/NO wording when the market object is clear; use YES/NO only when needed to avoid ambiguity.",
      "Use candidate.mkt.labels when present to translate YES/NO into team/player/outcome names.",
      "Use candidate.mkt.sideCopy.plainPosition and sideCopy.winCondition when present; this is mandatory for totals and ambiguous YES/NO markets.",
      "For O/U and total markets, name the threshold and scope. Write 'Under 2.5 total goals', not 'NO on O/U 2.5' or bare 'Under'.",
      "For team NO/fade markets, write 'fading France' or 'against France', not 'NO France' or 'France not to win'.",
      "Whenever a price appears, explicitly name which side it prices; never mix the selected-side price with the opposite outcome's label.",
      "Telegram owns emoji, numeric hooks, position rows, proof rows, and Markdown. Return plain semantic prose only and never imitate those UI elements.",
      "Usually lead with what strong wallets are doing, then add market price/context and why the setup is interesting. Use smart wallets only when credentials are strong. Vary the sentence shape.",
      "Prefer simple trader language: smart wallets, strong wallets, wallet conviction, not the obvious side, sees, believes, backs, holds, still holding, fading, backing, prices risk, trades near Xc, market gives this about X%, has not backed off, minority bet.",
      "Use only candidate.actor.credentialBullets for holder credentials; do not invent track records or profit, and do not repeat the bullets verbatim in the summary.",
      "Holder identityDisplayName is factual context only; preserve it verbatim if used and never infer a biography from it.",
      "Use normal-user language for credentials; avoid analytics field names and jargon.",
      "Use candidate.quality.flowProfile, repeatProfile, and riskTags when deciding status. Treat unsupported_crypto_single and negative_single_minority as non-publishable.",
      "Use delegated search only to answer whether outside information supports the holder side, supports the opposite side, mostly shows the move was already public, does not explain it, or is mixed.",
      "Do not demote only because public information partly explains the move; ask whether wallets are still on a side the market is not fully pricing.",
      "Compare holder activity/snapshot timing against dated public headlines; early holder positioning can be a publishable signal even if later news supports it.",
      "Use same-market-type metrics only as supporting evidence. Do not overstate a wallet's skill when marketTypeMetrics30d is missing or weak.",
      "For high-score candidates, still choose CONTEXT when direction is mixed or the takeaway is mostly risk/context.",
      "Do not choose PUBLISH with direction=mixed.",
      "PUBLISH should be a directional holder-backed signal with actor.mode single_holder or sharp_cluster; disagreement or risk-only reads are CONTEXT unless they clearly support one side.",
      "If holder data adds a timely reason to look now, choose PUBLISH.",
      "If the signal is only mildly interesting, mostly repeats public news, or is too noisy/concentrated to be useful, choose CONTEXT or SKIP and say why briefly.",
      "Do not use filler such as Holder activity is the primary evidence, worth noticing, worth a look, Cluster now, or Wallet edge.",
    ],
    allowedEvidenceIds: input.allowedEvidenceIds,
    candidate: input.candidateJson,
  });
}

export function buildHolderResearchSystemPromptV2(): string {
  return [
    "You are the final evidence-assessment and copy stage for Hunch holder research.",
    "Return exactly one JSON object matching holder_research_v2.",
    "The backend owns side, direction, bucket, price, credentials, and publication safety. Do not restate or change those fields.",
    "Use only decisionFeatures, selected holder evidence, supplied internal evidence, and structured externalResearch.",
    "Choose publish only when the holder evidence is strong or adequate, directional, timely, and not contradicted.",
    "Mixed, contradicted, or insufficient evidence cannot be publish.",
    "External verdict supports_opposite_side cannot be publish. already_public needs a distinct holder-timing or persistence reason.",
    "Do not claim the holder acted before news unless externalResearch.timing is after_holder.",
    "The product renders the exact market side, executable price, and credential lines deterministically. Write only a truthful headline and why-now sentence.",
    "The Telegram renderer also owns emoji, the numeric notification hook, partial bolding, position rows, proof rows, and section labels. Never output Markdown, emoji, bullets, or those UI elements.",
    "Name the metric and direction behind any move; never use ambiguous phrases such as after the drop or after the move.",
    "Never expose internal review language such as repeat read, repeated thesis, or still interesting.",
    "When externalResearch.status is no_evidence or error, do not mention the absence of evidence in public copy.",
    "For a research update, explain the concrete change named by meaningfulDeltaReasons; if no public why-now change can be named, return context or skip.",
    "Do not restate the current holding, position size, or price in prose because the product renders current state from one authoritative snapshot.",
    "Do not repeat stable wallet credentials or track-record claims in a research update; the product already renders verified proof separately. The generated sentence must describe only what changed now and why that change matters.",
    "If a price is necessary for meaning, name its side explicitly and never describe the opposite-side probability as though it were the selected side.",
    "Never use filler such as Holder activity is the primary evidence, worth noticing, worth a look, Cluster now, Wallet edge, or No cited external evidence was available.",
    "Do not include wallet identifiers, addresses, raw metric names, z-score notation, sample notation, or invented numeric claims.",
    "If verdict is context or skip, copy must be null.",
  ].join("\n");
}

export function buildHolderResearchUserPromptV2(input: {
  candidateJson: unknown;
  allowedEvidenceIds: string[];
}): string {
  return JSON.stringify({
    task: "Assess one holder-positioning thesis and, only if publishable, write its non-deterministic copy.",
    output_contract: {
      version: "holder_research_v2",
      verdict: "publish | context | skip",
      evidence_assessment:
        "strong | adequate | mixed | contradicted | insufficient",
      reason_codes: "short machine-readable reasons",
      rationale: "one short internal sentence",
      evidence_ids: "subset of allowedEvidenceIds",
      copy: {
        headline: "5-10 word thesis without raw price or wallet identifiers",
        why_now:
          "one concise sentence explaining why the holder behavior matters now",
        caveats: "0-2 material limitations",
      },
    },
    rules: [
      "Use null copy for context or skip.",
      "Do not repeat deterministic market, side, price, or credential lines.",
      "Do not infer entry timing from a position snapshot alone.",
      "Treat edge as historical supporting evidence, never a guarantee for this market.",
      "Use external research only through its validated verdict, timing, summary, and citations.",
      "Describe a concrete why-now change; do not write repeat read or an unnamed drop/move.",
      "Do not turn a no_evidence or error research status into a public sentence.",
      "Do not duplicate the holder's current side, size, PnL, or market price in generated copy.",
      "Do not repeat stable wallet credentials or historical performance in research-update copy; describe only the new change.",
      "Return plain prose only. Do not output Telegram emoji, Markdown, hook formatting, proof bullets, or section labels.",
      "Whenever a price is mentioned, name its side explicitly and keep it consistent with the selected side.",
      "Do not use generic filler such as Holder activity is the primary evidence, worth noticing, or worth a look.",
    ],
    allowedEvidenceIds: input.allowedEvidenceIds,
    candidate: input.candidateJson,
  });
}
