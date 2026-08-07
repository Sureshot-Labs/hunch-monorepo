import { createHash } from "node:crypto";

import { z } from "zod";

export const X_EDITORIAL_CONTENT_PROFILE = "x_editorial_draft_v1" as const;
export const X_EDITORIAL_PROMPT_VERSION = "x_editorial_prompt_v3" as const;

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
  miniAppUrl?: string;
  noteId: string;
  recentOpenings?: string[];
  selectedSide: "NO" | "YES";
  websiteUrl?: string;
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
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

const FORBIDDEN_COPY_PATTERNS: Array<{
  code: string;
  pattern: RegExp;
}> = [
  { code: "hashtag", pattern: /(^|\s)#[\p{L}\p{N}_]+/u },
  {
    code: "markdown",
    pattern:
      /`|\*\*|__|\[[^\]]+\]\([^)]+\)|(^|\n)\s*(?:>|#{1,6}\s|[-*+]\s|\d+\.\s)/,
  },
  {
    code: "internal_language",
    pattern:
      /\b(?:holder[_ -]?research|sharp[_ -]?cluster|z[- ]?score|signal detected|publication decision|evidence id)\b/i,
  },
  {
    code: "unsupported_accusation",
    pattern:
      /\b(?:insider|inside information|non[- ]public information|ai bot|cheat code|guaranteed)\b/i,
  },
  {
    code: "fake_first_person",
    pattern:
      /\b(?:i(?:['’](?:m|ve|d|ll))?|me|my|mine|we(?:['’](?:re|ve|d|ll))?|our|ours)\b/i,
  },
  { code: "fake_first_person", pattern: /\bus\b/ },
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

function compactRecentOpenings(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => cleanText(value).split("\n")[0]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 20)
    .map((value) => Array.from(value).slice(0, 180).join(""));
}

export function buildXEditorialDraftSystemPrompt(input: {
  maxCharacters: number;
  maxParagraphs: number;
}): string {
  return [
    "You are the editorial writer for a prediction-market intelligence account on X.",
    "Write one ready-to-paste English post from the supplied allowlisted facts.",
    "It must read like a sharp human analyst noticed a real story, not like a signal card, dashboard, press release, or AI summary.",
    "Choose one primary tension: a fresh meaningful bet, a verified trader profile, a real behavior change, market-versus-trader disagreement, follow-through, or a resolved receipt.",
    "Open with the strongest concrete action, amount, probability, price move, or result. Then explain who is involved and why it matters.",
    "Use short natural paragraphs and varied sentence rhythm. Omit facts that do not strengthen the story.",
    "Use only supplied facts. Preserve side, proposition, scope, amount, price, count, PnL, timeframe, and result exactly.",
    "A position snapshot proves a position, not when or how it was entered. Do not turn a snapshot into a fresh buy unless a supplied fact explicitly proves the change.",
    "Do not claim insider access, coordination, private information, causation, certainty, an AI bot, or a cheat code.",
    "Never invent first-person experience or pretend the account placed the trade. Avoid I, we, my, and our.",
    "Do not expose wallet addresses, internal labels, evidence IDs, raw schema names, or analytics jargon.",
    "No Markdown markers inside postText, headings, tables, hashtags, affiliate language, product CTA, or engagement bait.",
    "Select one to three exact, non-overlapping snippets for X Premium formatting. Use bold for the strongest hook, amount, probability, or result; use italic only for a genuinely useful interpretive line. Return those snippets in formatting and keep postText itself plain.",
    'Every formatting item must be exactly {"style":"bold"|"italic","text":"an exact substring of postText"}. The field name is text, never snippet.',
    "Emoji are optional and should be rare. Do not use an emoji as a fixed template.",
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
    recentOpeningsToAvoidRepeating: compactRecentOpenings(
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
    for (const nested of Object.values(value)) {
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
          response_format: { type: "json_object" },
          temperature: 0.45,
          max_tokens: input.config.maxOutputTokens,
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
    const content = choice?.message?.content;
    if (!content) {
      throw new XEditorialComposerError({
        code: "missing_content",
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
