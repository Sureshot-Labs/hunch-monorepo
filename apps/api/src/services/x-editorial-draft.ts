import { createHash } from "node:crypto";

import { z } from "zod";

export const X_EDITORIAL_CONTENT_PROFILE = "x_editorial_draft_v1" as const;
export const X_EDITORIAL_PROMPT_VERSION = "x_editorial_prompt_v7" as const;

export type XEditorialComposerFailureCode =
  | "missing_content"
  | "provider_error"
  | "schema_mismatch";

export class XEditorialComposerError extends Error {
  readonly code: XEditorialComposerFailureCode;
  readonly issues: string[];

  constructor(input: {
    code: XEditorialComposerFailureCode;
    issues?: string[];
    message: string;
  }) {
    super(input.message);
    this.name = "XEditorialComposerError";
    this.code = input.code;
    this.issues = [...new Set(input.issues ?? [])];
  }
}

export function readXEditorialComposerFailure(error: unknown): {
  code: XEditorialComposerFailureCode;
  issues: string[];
  message: string;
} {
  if (error instanceof XEditorialComposerError) {
    return {
      code: error.code,
      issues: error.issues,
      message: error.message,
    };
  }
  return {
    code: "provider_error",
    issues: [],
    message: error instanceof Error ? error.message : String(error),
  };
}

export type XEditorialMessageKind =
  | "followthrough_stats"
  | "initial"
  | "research_update"
  | "resolved_loss"
  | "resolved_win";

export type XEditorialStoryFamily =
  | "case_study"
  | "followthrough"
  | "fresh_bet"
  | "resolution"
  | "trader_profile";

export type XEditorialFact = {
  id: string;
  label: string;
  value: unknown;
};

export type XEditorialFormattingSpan = {
  style: "bold" | "italic";
  text: string;
};

export type XEditorialDraftSource = {
  facts: XEditorialFact[];
  kind: XEditorialMessageKind;
  marketId: string;
  noteId: string;
  recentOpenings?: string[];
  selectedSide: "NO" | "YES";
};

export type XEditorialDraftV1 = {
  characterCount: number;
  formatting: XEditorialFormattingSpan[];
  generatedAt: string;
  marketId: string;
  model: string;
  postText: string | null;
  promptVersion: typeof X_EDITORIAL_PROMPT_VERSION;
  safetyFlags: string[];
  selectedSide: "NO" | "YES";
  sourceDigest: string;
  status: "blocked" | "ready";
  storyFamily: XEditorialStoryFamily;
  usedFactIds: string[];
  version: 1;
};

export type XEditorialDraftComposer = (input: {
  source: XEditorialDraftSource;
}) => Promise<XEditorialDraftV1>;

export type XEditorialComposerConfig = {
  enabled: boolean;
  maxCharacters: number;
  maxOutputTokens: number;
  maxParagraphs: number;
  model: string;
};

const modelOutputSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["ready", "blocked"]),
    marketId: z.string().trim().min(1).max(500),
    selectedSide: z.enum(["NO", "YES"]),
    postText: z.string().trim().min(1).max(4_096).nullable(),
    formatting: z
      .array(
        z
          .object({
            style: z.enum(["bold", "italic"]),
            text: z.string().trim().min(2).max(180),
          })
          .strict(),
      )
      .max(3),
    storyFamily: z.enum([
      "case_study",
      "followthrough",
      "fresh_bet",
      "resolution",
      "trader_profile",
    ]),
    usedFactIds: z.array(z.string().trim().min(1).max(120)).max(40),
    safetyFlags: z.array(z.string().trim().min(1).max(120)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "ready" && !value.postText) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ready drafts require postText.",
        path: ["postText"],
      });
    }
    if (value.status === "ready" && value.formatting.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ready drafts require at least one formatting span.",
        path: ["formatting"],
      });
    }
    if (value.status === "blocked" && value.postText != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Blocked drafts must not include postText.",
        path: ["postText"],
      });
    }
    if (value.status === "blocked" && value.formatting.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Blocked drafts must not include formatting spans.",
        path: ["formatting"],
      });
    }
  });

const persistedDraftSchema = z
  .object({
    characterCount: z.number().int().min(0).max(4_096),
    formatting: z
      .array(
        z
          .object({
            style: z.enum(["bold", "italic"]),
            text: z.string().min(2).max(180),
          })
          .strict(),
      )
      .max(3)
      .default([]),
    generatedAt: z.string().datetime(),
    marketId: z.string().trim().min(1).max(500),
    model: z.string().trim().min(1).max(200),
    postText: z.string().min(1).max(4_096).nullable(),
    promptVersion: z.literal(X_EDITORIAL_PROMPT_VERSION),
    safetyFlags: z.array(z.string()).max(20),
    selectedSide: z.enum(["NO", "YES"]),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["blocked", "ready"]),
    storyFamily: z.enum([
      "case_study",
      "followthrough",
      "fresh_bet",
      "resolution",
      "trader_profile",
    ]),
    usedFactIds: z.array(z.string()).max(40),
    version: z.literal(1),
  })
  .strict();

type XEditorialModelOutput = z.infer<typeof modelOutputSchema>;

type OpenRouterResponse = {
  choices?: Array<{
    error?: { code?: string | number; message?: string } | null;
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: {
      content?: Array<{ text?: string; type?: string }> | string | null;
      refusal?: string | null;
    };
  }>;
  error?: { code?: string | number; message?: string } | null;
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

const X_EDITORIAL_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    formatting: {
      items: {
        additionalProperties: false,
        properties: {
          style: { enum: ["bold", "italic"], type: "string" },
          text: { type: "string" },
        },
        required: ["style", "text"],
        type: "object",
      },
      type: "array",
    },
    marketId: { type: "string" },
    postText: { type: ["string", "null"] },
    safetyFlags: { items: { type: "string" }, type: "array" },
    selectedSide: { enum: ["NO", "YES"], type: "string" },
    status: { enum: ["ready", "blocked"], type: "string" },
    storyFamily: {
      enum: [
        "case_study",
        "followthrough",
        "fresh_bet",
        "resolution",
        "trader_profile",
      ],
      type: "string",
    },
    usedFactIds: { items: { type: "string" }, type: "array" },
    version: { enum: [1], type: "integer" },
  },
  required: [
    "version",
    "status",
    "marketId",
    "selectedSide",
    "postText",
    "formatting",
    "storyFamily",
    "usedFactIds",
    "safetyFlags",
  ],
  type: "object",
} as const;

const FORBIDDEN_COPY_PATTERNS: Array<{
  code: string;
  pattern: RegExp;
}> = [
  { code: "hashtag", pattern: /(^|\s)#[\p{L}\p{N}_]+/u },
  { code: "url", pattern: /\b(?:https?:\/\/|www\.)\S+/i },
  {
    code: "markdown",
    pattern: /`|\*\*|__|\[[^\]]+\]\([^)]+\)|(^|\n)\s*(?:>|#{1,6}\s)/,
  },
  {
    code: "internal_language",
    pattern:
      /\b(?:holder[_ -]?research|sharp[_ -]?cluster|z[- ]?score|signal detected|publication decision|evidence id|tracked money)\b/i,
  },
  {
    code: "dashboard_voice",
    pattern:
      /\b(?:the important part is|market update|quality[- ]gated|worth following)\b/i,
  },
  {
    code: "raw_numeric_format",
    pattern:
      /(?:\$\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{3,}|\b0\.\d{2,}\b)/,
  },
  {
    code: "editorial_scaffolding",
    pattern:
      /(?:^|\n)(?:the trader has (?:some )?receipts|receipts|the credential stack is the story|my read)\s*:/im,
  },
  {
    code: "analyst_jargon",
    pattern:
      /\b(?:credentialed (?:fade|trade)|credibility check|making that lean concrete|worth respecting)\b/i,
  },
  {
    code: "unsupported_accusation",
    pattern:
      /\b(?:insider|inside information|non[- ]public information|ai bot|cheat code|guaranteed)\b/i,
  },
  {
    code: "fake_first_person",
    pattern:
      /\b(?:(?:i|we)\s+(?:bought|sold|bet|traded|entered|exited|hedged|made|earned|lost|won|called|predicted|spoke|talked|messaged|contacted|know|have\s+(?:an?\s+)?(?:source|insider|contact)|(?:was|were)\s+told)|(?:my|our)\s+(?:bet|trade|position|wallet|profit|loss|source|insider|contact|call|prediction|track record))\b/i,
  },
  {
    code: "promotional_cta",
    pattern:
      /\b(?:buy now|join now|sign up|use (?:my|our) code|open in hunch|click the link)\b/i,
  },
  { code: "raw_evm_address", pattern: /\b0x[0-9a-f]{16,}\b/i },
];

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function visibleCharacterCount(value: string): number {
  return Array.from(value).length;
}

function paragraphCount(value: string): number {
  return value
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
}

function extractJsonObject(content: string): unknown {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  return JSON.parse(
    firstBrace >= 0 && lastBrace > firstBrace
      ? unfenced.slice(firstBrace, lastBrace + 1)
      : unfenced,
  ) as unknown;
}

function normalizeXEditorialModelOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const output = { ...(value as Record<string, unknown>) };
  if (!Array.isArray(output.formatting)) return output;
  output.formatting = output.formatting.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const span = { ...(value as Record<string, unknown>) };
    if (typeof span.text !== "string" && typeof span.snippet === "string") {
      span.text = span.snippet;
      delete span.snippet;
    }
    return span;
  });
  return output;
}

function sourceDigest(source: XEditorialDraftSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        facts: source.facts,
        kind: source.kind,
        marketId: source.marketId,
        noteId: source.noteId,
        selectedSide: source.selectedSide,
      }),
    )
    .digest("hex");
}

function compactRecentDrafts(values: string[] | undefined): string[] {
  return (values ?? [])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 10)
    .map((value) => Array.from(value).slice(0, 600).join(""));
}

export function buildXEditorialDraftSystemPrompt(input: {
  maxCharacters: number;
  maxParagraphs: number;
}): string {
  return [
    "You write human, high-signal English posts for a prediction-market intelligence account on X.",
    "Write one ready-to-paste post from the supplied allowlisted facts. It should feel like a sharp trader-story post written after noticing something worth sharing, never a signal card, dashboard, press release, or AI summary.",
    "Choose the strongest supported story: a fresh meaningful bet, a trader with a credible track record, a repeatable strategy, a contradiction between positions, a market-versus-trader disagreement, follow-through, or a resolved receipt.",
    "Scale the post to the evidence. With thin facts, write a compact 3-5 line post. With a rich track record or several connected positions, build a fuller case study. Never pad a weak story.",
    "Use this editorial arc when the facts support it, but do not force every stage:",
    "HOOK — lead with the most surprising verified amount, result, action, probability, or contradiction. Prefer a direct claim over scene-setting.",
    "CHARACTER — make the trader, wallet, or group concrete. Use a supplied display name and verified credentials when available.",
    "PROOF — weave in only the one or two facts that best prove the hook. Short standalone lines or → bullets are welcome only when several connected facts genuinely scan better than prose.",
    "READ — explain the tension or pattern: conviction, concentration, hedging, disagreement, changed behavior, asymmetric payoff, or what the result says about the strategy. Clearly frame interpretation as analysis, not fact.",
    "FINISH — end with a crisp punchline, contrast, question, or forward-looking tension. Do not end by merely repeating the market title or summarizing the data.",
    "Use short natural paragraphs, clipped sentences where they add rhythm, and varied sentence length. Prefer specific nouns and active verbs. Omit facts that do not strengthen the story. One current position plus track-record facts is usually a compact three- or four-paragraph post, not a case study.",
    "Avoid generic openings such as 'Market update', 'Tracked wallets are moving', 'A signal appeared', or '[probability] is now [probability]' when a concrete trader, amount, or result is available.",
    "Use only supplied facts. Preserve side, proposition, scope, count, timeframe, and result. For amounts, prices, and PnL, use the supplied editorial display strings verbatim; never print raw database decimals or add precision.",
    "A position snapshot proves a position, not when or how it was entered. Do not turn a snapshot into a fresh buy unless a supplied fact explicitly proves the change.",
    "Do not claim insider access, coordination, private information, causation, certainty, an AI bot, or a cheat code.",
    "A light first-person editorial voice is allowed for a fact-grounded observation or opinion, such as 'I found', 'I am watching', or 'I think'. Never invent a personal trade, profit, prediction record, conversation, private source, or firsthand access.",
    "Do not expose wallet addresses, internal labels, evidence IDs, raw schema names, or analytics jargon.",
    "Never announce your structure with labels such as 'Receipts:', 'The trader has receipts:', 'The credential stack is the story:', or 'My read:'. Make the observation directly.",
    "Avoid investment-memo phrases such as 'credentialed fade', 'credibility check', 'base case', 'making the lean concrete', or 'worth respecting'. Use ordinary language a real market blogger would use.",
    "Do not mechanically repeat 'The market already...' or 'This is X, not Y'. Vary the structure, transitions, and ending as well as the opening.",
    "Never assume an acronym or outcome label is self-explanatory. Pair it with the supplied event or market context.",
    "No Markdown markers inside postText, headings, pipe-delimited stat tables, URLs, links, hashtags, affiliate language, product CTA, or generic engagement bait.",
    "Select one to three exact, non-overlapping snippets for intentional Telegram/X formatting. Usually bold the hook or strongest result; use italic only for a genuinely useful interpretive line. Return those snippets in formatting and keep postText itself plain.",
    'Every formatting item must be exactly {"style":"bold"|"italic","text":"an exact substring of postText"}. The field name is text, never snippet.',
    "Emoji and → bullets are optional. Use a topical emoji only when it improves scanning or tone; never force a fixed emoji template.",
    "Vary the hook, structure, transitions, and ending against recentDraftsToAvoidImitating. Reuse the reference collection's editorial principles, never one author's exact wording or persona.",
    "These style-only examples show the target rhythm. Never reuse their people, markets, numbers, or claims unless they are present in the supplied facts:",
    "STYLE EXAMPLE — compact conviction:\nA new wallet just put $1.6M on Spain to win the World Cup.\n\nOne position. No hedge.\n\nEither serious conviction or a very expensive fan bet.",
    "STYLE EXAMPLE — apparent contradiction:\nOne trader is fading England tonight — and backing them to win the World Cup.\n\nThose bets describe a narrow path: stumble now, peak later.\n\nThat is not indecision. It is a tournament script.",
    "STYLE EXAMPLE — repeatable strategy:\nThis weather trader has made $5,287 in 30 days.\n\n1,618 forecasts across four continents. The same small edge, repeated.\n\nBoring market. Serious consistency.",
    "Do not write phrases such as 'the important part is', 'tracked money', 'worth following', or 'market update'. Do not restate the research headline and description as two report-like paragraphs.",
    `Hard limit: ${input.maxCharacters} visible characters and ${input.maxParagraphs} paragraphs.`,
    "Return exactly one JSON object. Use status=blocked and postText=null if the facts do not support a coherent, safe post.",
  ].join("\n");
}

function buildUserPrompt(input: {
  previousAttempt?: unknown;
  repairIssues?: string[];
  source: XEditorialDraftSource;
}): string {
  return JSON.stringify({
    task: input.repairIssues
      ? "Repair the prior draft using the same facts and return the full corrected object."
      : "Write one editorial X post.",
    outputContract: {
      version: 1,
      status: "ready | blocked",
      marketId: "copy the supplied marketId exactly",
      selectedSide: "copy the supplied selectedSide exactly",
      postText: "ready-to-paste text or null when blocked",
      formatting: [
        {
          style: "bold | italic",
          text: "exact unique substring of postText; the field name must be text, never snippet",
        },
      ],
      formattingRules:
        "Return one to three items when ready and an empty array only when blocked.",
      storyFamily:
        "fresh_bet | trader_profile | case_study | followthrough | resolution",
      usedFactIds: "IDs of every fact used in visible copy",
      safetyFlags: "short machine-readable flags, empty when safe",
    },
    marketId: input.source.marketId,
    messageKind: input.source.kind,
    selectedSide: input.source.selectedSide,
    facts: input.source.facts,
    recentDraftsToAvoidImitating: compactRecentDrafts(
      input.source.recentOpenings,
    ),
    ...(input.repairIssues
      ? {
          repairIssues: input.repairIssues,
          previousAttempt: input.previousAttempt,
        }
      : {}),
  });
}

const NUMERIC_TOKEN_RE =
  /(?<![\p{L}\p{N}_])(?:[$€£]\s*)?[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:[kmb]|%|¢)?(?![\p{L}\p{N}_])/giu;

function parseNumericToken(raw: string): number | null {
  const normalized = raw
    .trim()
    .replace(/[$€£,\s]/g, "")
    .replace("−", "-")
    .toLowerCase();
  const suffix = normalized.at(-1);
  const multiplier =
    suffix === "k"
      ? 1_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "b"
          ? 1_000_000_000
          : 1;
  const numberText =
    suffix === "k" || suffix === "m" || suffix === "b"
      ? normalized.slice(0, -1)
      : suffix === "%" || suffix === "¢"
        ? normalized.slice(0, -1)
        : normalized;
  const parsed = Number(numberText);
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function numericValuesFromString(value: string): number[] {
  if (
    /^https?:\/\//i.test(value.trim()) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value.trim()) ||
    /^0x[0-9a-f]+$/i.test(value.trim())
  ) {
    return [];
  }
  return [...value.matchAll(NUMERIC_TOKEN_RE)]
    .map((match) => parseNumericToken(match[0]))
    .filter((number): number is number => number != null);
}

function collectAllowedNumericValues(value: unknown, output: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    output.push(value, Math.abs(value));
    if (Math.abs(value) <= 1) {
      output.push(value * 100, Math.abs(value * 100));
    }
    return;
  }
  if (typeof value === "string") {
    for (const number of numericValuesFromString(value)) {
      output.push(number, Math.abs(number));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAllowedNumericValues(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      for (const match of key.matchAll(/\d+(?:\.\d+)?/g)) {
        const fieldScope = Number(match[0]);
        if (Number.isFinite(fieldScope)) output.push(fieldScope);
      }
      collectAllowedNumericValues(nested, output);
    }
  }
}

function numbersApproximatelyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-6;
}

function findUnsupportedNumericClaims(input: {
  factIds: string[];
  postText: string;
  source: XEditorialDraftSource;
}): string[] {
  const usedIds = new Set(input.factIds);
  const allowed: number[] = [];
  for (const fact of input.source.facts) {
    if (usedIds.has(fact.id)) collectAllowedNumericValues(fact.value, allowed);
  }
  return [...input.postText.matchAll(NUMERIC_TOKEN_RE)]
    .map((match) => ({
      raw: match[0].trim(),
      value: parseNumericToken(match[0]),
    }))
    .filter(
      (claim): claim is { raw: string; value: number } => claim.value != null,
    )
    .filter(
      (claim) =>
        !allowed.some((value) => numbersApproximatelyEqual(value, claim.value)),
    )
    .map((claim) => `unsupported_number:${claim.raw}`);
}

function validateFormattingSpans(input: {
  formatting: XEditorialFormattingSpan[];
  postText: string;
}): string[] {
  const issues: string[] = [];
  const ranges: Array<{ end: number; start: number }> = [];
  const seen = new Set<string>();
  for (const [index, span] of input.formatting.entries()) {
    if (span.text.includes("\n")) {
      issues.push(`formatting_multiline:${index}`);
      continue;
    }
    const key = `${span.style}:${span.text}`;
    if (seen.has(key)) issues.push(`formatting_duplicate:${index}`);
    seen.add(key);
    const start = input.postText.indexOf(span.text);
    if (start < 0) {
      issues.push(`formatting_text_missing:${index}`);
      continue;
    }
    if (input.postText.indexOf(span.text, start + span.text.length) >= 0) {
      issues.push(`formatting_text_ambiguous:${index}`);
      continue;
    }
    const end = start + span.text.length;
    if (ranges.some((range) => start < range.end && end > range.start)) {
      issues.push(`formatting_overlap:${index}`);
      continue;
    }
    ranges.push({ end, start });
  }
  return issues;
}

export function validateXEditorialModelOutput(input: {
  config: Pick<XEditorialComposerConfig, "maxCharacters" | "maxParagraphs">;
  output: XEditorialModelOutput;
  source: XEditorialDraftSource;
}): { issues: string[]; postText: string | null } {
  if (input.output.status === "blocked") {
    return { issues: [], postText: null };
  }
  const postText = cleanText(input.output.postText ?? "");
  const issues: string[] = [];
  if (input.output.marketId !== input.source.marketId) {
    issues.push("market_id_mismatch");
  }
  if (input.output.selectedSide !== input.source.selectedSide) {
    issues.push("selected_side_mismatch");
  }
  if (!postText) issues.push("empty_post");
  if (visibleCharacterCount(postText) > input.config.maxCharacters) {
    issues.push("over_character_limit");
  }
  if (paragraphCount(postText) > input.config.maxParagraphs) {
    issues.push("over_paragraph_limit");
  }
  for (const forbidden of FORBIDDEN_COPY_PATTERNS) {
    if (forbidden.pattern.test(postText)) issues.push(forbidden.code);
  }
  const allowedFactIds = new Set(input.source.facts.map((fact) => fact.id));
  if (input.output.usedFactIds.length === 0) issues.push("missing_fact_ids");
  for (const factId of input.output.usedFactIds) {
    if (!allowedFactIds.has(factId)) issues.push(`unknown_fact_id:${factId}`);
  }
  issues.push(
    ...validateFormattingSpans({
      formatting: input.output.formatting,
      postText,
    }),
  );
  issues.push(
    ...findUnsupportedNumericClaims({
      factIds: input.output.usedFactIds,
      postText,
      source: input.source,
    }),
  );
  return { issues: [...new Set(issues)], postText };
}

function blockedDraft(input: {
  flags: string[];
  generatedAt: string;
  model: string;
  source: XEditorialDraftSource;
  storyFamily?: XEditorialStoryFamily;
}): XEditorialDraftV1 {
  return {
    characterCount: 0,
    formatting: [],
    generatedAt: input.generatedAt,
    marketId: input.source.marketId,
    model: input.model,
    postText: null,
    promptVersion: X_EDITORIAL_PROMPT_VERSION,
    safetyFlags: [...new Set(input.flags)].slice(0, 20),
    selectedSide: input.source.selectedSide,
    sourceDigest: sourceDigest(input.source),
    status: "blocked",
    storyFamily: input.storyFamily ?? "fresh_bet",
    usedFactIds: [],
    version: 1,
  };
}

async function callOpenRouter(input: {
  apiKey: string;
  config: XEditorialComposerConfig;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ content: string; finishReason: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.config.model,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
          max_tokens: input.maxTokens,
          provider: { require_parameters: true },
          reasoning: { effort: "minimal", exclude: true },
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "x_editorial_draft",
              schema: X_EDITORIAL_JSON_SCHEMA,
              strict: true,
            },
          },
        }),
      },
    );
    const payload = (await response
      .json()
      .catch(() => ({}))) as OpenRouterResponse;
    if (!response.ok) {
      throw new Error(
        `OpenRouter ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }
    const choice = payload.choices?.[0];
    const rawContent = choice?.message?.content;
    const content =
      typeof rawContent === "string"
        ? rawContent.trim()
        : Array.isArray(rawContent)
          ? rawContent
              .filter(
                (part) => part.type === "text" || part.type === "output_text",
              )
              .map((part) => part.text?.trim() ?? "")
              .filter(Boolean)
              .join("\n")
          : "";
    if (!content) {
      const providerError = choice?.error ?? payload.error;
      const issues = [
        `finish_reason:${choice?.finish_reason ?? "unknown"}`,
        ...(choice?.native_finish_reason
          ? [`native_finish_reason:${choice.native_finish_reason}`]
          : []),
        ...(typeof payload.usage?.completion_tokens_details
          ?.reasoning_tokens === "number"
          ? [
              `reasoning_tokens:${payload.usage.completion_tokens_details.reasoning_tokens}`,
            ]
          : []),
        ...(typeof payload.usage?.completion_tokens === "number"
          ? [`completion_tokens:${payload.usage.completion_tokens}`]
          : []),
        ...(providerError?.code != null
          ? [`provider_code:${String(providerError.code)}`]
          : []),
        ...(choice?.message?.refusal
          ? [`refusal:${choice.message.refusal.slice(0, 160)}`]
          : []),
      ];
      throw new XEditorialComposerError({
        code: "missing_content",
        issues,
        message: `OpenRouter editorial response missing content (finish_reason=${choice?.finish_reason ?? "unknown"})`,
      });
    }
    return {
      content,
      finishReason: choice?.finish_reason ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createOpenRouterXEditorialDraftComposer(input: {
  apiKey: string;
  config: XEditorialComposerConfig;
}): XEditorialDraftComposer {
  const apiKey = input.apiKey.trim();
  return async ({ source }) => {
    if (!input.config.enabled) {
      throw new Error("X editorial composer is disabled");
    }
    if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
    const generatedAt = new Date().toISOString();
    const systemPrompt = buildXEditorialDraftSystemPrompt(input.config);
    let previousAttempt: unknown = null;
    let repairIssues: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let raw: unknown;
      try {
        const response = await callOpenRouter({
          apiKey,
          config: input.config,
          maxTokens: repairIssues?.includes("missing_content")
            ? Math.min(4_000, Math.max(1_400, input.config.maxOutputTokens * 2))
            : input.config.maxOutputTokens,
          systemPrompt,
          userPrompt: buildUserPrompt({
            previousAttempt,
            repairIssues,
            source,
          }),
        });
        raw = normalizeXEditorialModelOutput(
          extractJsonObject(response.content),
        );
      } catch (error) {
        const repairableFailure =
          error instanceof SyntaxError
            ? new XEditorialComposerError({
                code: "schema_mismatch",
                issues: ["invalid_json"],
                message: "OpenRouter editorial response was not valid JSON",
              })
            : error instanceof XEditorialComposerError
              ? error
              : null;
        if (
          attempt === 0 &&
          repairableFailure &&
          (repairableFailure.code === "missing_content" ||
            repairableFailure.code === "schema_mismatch")
        ) {
          previousAttempt = null;
          repairIssues = [repairableFailure.code, ...repairableFailure.issues];
          continue;
        }
        throw repairableFailure ?? error;
      }
      previousAttempt = raw;
      const parsed = modelOutputSchema.safeParse(raw);
      if (!parsed.success) {
        repairIssues = parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "output"}:${issue.message}`,
        );
        if (attempt === 0) continue;
        throw new XEditorialComposerError({
          code: "schema_mismatch",
          issues: repairIssues,
          message: `OpenRouter editorial output failed schema validation: ${repairIssues.join("; ")}`,
        });
      }
      const validated = validateXEditorialModelOutput({
        config: input.config,
        output: parsed.data,
        source,
      });
      if (validated.issues.length > 0) {
        repairIssues = validated.issues;
        if (attempt === 0) continue;
        throw new XEditorialComposerError({
          code: "schema_mismatch",
          issues: validated.issues,
          message: `OpenRouter editorial output failed contract validation: ${validated.issues.join("; ")}`,
        });
      }
      if (parsed.data.status === "blocked" || !validated.postText) {
        return blockedDraft({
          flags:
            parsed.data.safetyFlags.length > 0
              ? parsed.data.safetyFlags
              : ["model_blocked"],
          generatedAt,
          model: input.config.model,
          source,
          storyFamily: parsed.data.storyFamily,
        });
      }
      return {
        characterCount: visibleCharacterCount(validated.postText),
        formatting: parsed.data.formatting,
        generatedAt,
        marketId: source.marketId,
        model: input.config.model,
        postText: validated.postText,
        promptVersion: X_EDITORIAL_PROMPT_VERSION,
        safetyFlags: parsed.data.safetyFlags,
        selectedSide: source.selectedSide,
        sourceDigest: sourceDigest(source),
        status: "ready",
        storyFamily: parsed.data.storyFamily,
        usedFactIds: [...new Set(parsed.data.usedFactIds)],
        version: 1,
      };
    }
    throw new XEditorialComposerError({
      code: "schema_mismatch",
      issues: ["unexpected_composer_exit"],
      message: "OpenRouter editorial composer exhausted its repair loop",
    });
  };
}

export function parsePersistedXEditorialDraft(
  value: unknown,
): XEditorialDraftV1 | null {
  const parsed = persistedDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildXEditorialSourceDigest(
  source: XEditorialDraftSource,
): string {
  return sourceDigest(source);
}
