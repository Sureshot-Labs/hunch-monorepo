#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { pool } from "./db.js";
import { env } from "./env.js";
import {
  extractProviderCostUsd,
  resolveAiCost,
  type ResolvedCost,
} from "./lib/ai-cost.js";
import { getOpenRouterModelPricingPerM } from "./lib/ai-pricing.js";
import {
  buildHolderResearchSystemPrompt,
  buildHolderResearchUserPrompt,
  parseHolderResearchAgentOutputV1,
  type HolderResearchAgentOutputV1,
} from "./schemas/holder-research.js";
import {
  buildDeterministicHolderResearchDecision,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchDecisionCacheKey,
  buildHolderResearchDecisionCacheRecord,
  buildHolderResearchExternalSearchInput,
  enrichHolderResearchHolderContext,
  enrichHolderResearchLivePositions,
  evaluateHolderResearchDecisionCache,
  loadHolderResearchCandidates,
  parseHolderResearchCachedDecision,
  persistHolderResearchNotes,
  selectHolderResearchCandidates,
  type HolderResearchCandidate,
  type HolderResearchDecisionCacheEvaluation,
  type HolderResearchPersistDecision,
} from "./services/holder-research.js";
import {
  resolveHolderResearchPolicy,
  type HolderResearchPolicy,
} from "./services/runtime-policies.js";

export type HolderResearchRunArgs = {
  dryRun: boolean | null;
  callModel: boolean;
  externalSearch: boolean | null;
  persistNotes: boolean | null;
  model: string | null;
  limit: number | null;
  maxAgentCalls: number | null;
  maxOutputTokens: number | null;
  outPath: string | null;
  verbose: boolean;
};

type HolderResearchModelDecision = {
  candidate: HolderResearchCandidate;
  output: HolderResearchAgentOutputV1;
  modelMeta: Record<string, unknown>;
  cost: ResolvedCost;
};

type HolderResearchDecisionCacheRedis = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; NX?: boolean },
  ): Promise<unknown>;
};

export type HolderResearchRunOptions = {
  decisionCacheRedis?: HolderResearchDecisionCacheRedis | null;
};

type ExternalResearchResult = {
  status: "skipped" | "dry_run" | "ok" | "no_public_context" | "error";
  summary: string | null;
  citations: Array<{
    title: string | null;
    url: string | null;
    source: string | null;
  }>;
  costUsd: number;
  toolCalls: number;
  error: string | null;
};

type HolderResearchRunReport = {
  runId: string;
  dryRun: boolean;
  callModel: boolean;
  persistNotes: boolean;
  model: string;
  policy: {
    enabled: boolean;
    source: "env" | "db";
    maxAgentCallsPerRun: number;
    maxPublishPerRun: number;
    maxCandidatePool: number;
    externalSearchEnabled: boolean;
    maxExternalSearchCallsPerRun: number;
    decisionCacheEnabled: boolean;
  };
  totals: {
    candidatesLoaded: number;
    selected: number;
    published: number;
    context: number;
    skipped: number;
    persisted: number;
    estimatedCostUsd: number;
    chargedCostUsd: number;
    externalSearchEstimatedCostUsd: number;
    externalSearchChargedCostUsd: number;
    totalEstimatedCostUsd: number;
    totalChargedCostUsd: number;
    providerReportedCostUsd: number | null;
    durationMs: number;
  };
  toolCalls: Array<{
    name: string;
    count: number;
    status: "ok" | "skipped" | "error";
    detail?: string;
  }>;
  decisionCache: {
    enabled: boolean;
    status: "ok" | "skipped" | "error";
    checked: number;
    skipped: number;
    rechecked: number;
    written: number;
    errors: number;
    dryRun: boolean;
  };
  decisionCacheSkipped: Array<{
    key: string;
    status: string | null;
    reason: "decision_cache";
    lastCheckedAt: string | null;
    nextEligibleAt: string | null;
    meaningfulDeltaReasons: string[];
  }>;
  decisionCacheRechecked: Array<{
    key: string;
    status: string | null;
    reason: string;
    lastCheckedAt: string | null;
    nextEligibleAt: string | null;
    meaningfulDeltaReasons: string[];
  }>;
  selected: Array<{
    key: string;
    bucket: string;
    score: number;
    marketId: string;
    eventId: string | null;
    title: string;
    side: string | null;
    reasons: string[];
  }>;
  decisions: Array<{
    key: string;
    status: string;
    confidence: number;
    userCard: {
      headline: string;
      summary: string;
      caveats: string[];
    };
    rationale: string;
    evidenceIds: string[];
    costUsd: number;
    costSource: string;
    externalSearchStatus: string;
    externalSearchSummary: string | null;
    externalSearchCitations: ExternalResearchResult["citations"];
  }>;
  persistence: Awaited<ReturnType<typeof persistHolderResearchNotes>> | null;
};

function parseBool(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const asInt = Math.trunc(parsed);
  return asInt > 0 ? asInt : null;
}

function parseArgs(argv: string[]): HolderResearchRunArgs {
  return {
    dryRun: hasFlag(argv, "--dry-run")
      ? true
      : hasFlag(argv, "--no-dry-run")
        ? false
        : parseBool(parseFlag(argv, "--dry-run")),
    callModel: hasFlag(argv, "--call-model"),
    externalSearch: hasFlag(argv, "--external-search")
      ? true
      : hasFlag(argv, "--no-external-search")
        ? false
        : parseBool(parseFlag(argv, "--external-search")),
    persistNotes: hasFlag(argv, "--persist")
      ? true
      : hasFlag(argv, "--no-persist")
        ? false
        : parseBool(parseFlag(argv, "--persist")),
    model: parseFlag(argv, "--model")?.trim() || null,
    limit: parsePositiveInt(parseFlag(argv, "--limit")),
    maxAgentCalls: parsePositiveInt(parseFlag(argv, "--max-agent-calls")),
    maxOutputTokens: parsePositiveInt(parseFlag(argv, "--max-output-tokens")),
    outPath: parseFlag(argv, "--out")?.trim() || null,
    verbose: hasFlag(argv, "--verbose"),
  };
}

function withPolicyOverrides(
  policy: HolderResearchPolicy,
  args: HolderResearchRunArgs,
): HolderResearchPolicy {
  const maxAgentCallsPerRun =
    args.maxAgentCalls ?? args.limit ?? policy.maxAgentCallsPerRun;
  const maxCandidatesPerRun =
    args.limit ?? Math.min(policy.maxCandidatesPerRun, maxAgentCallsPerRun);
  return {
    ...policy,
    dryRun: args.dryRun ?? policy.dryRun,
    persistNotes: args.persistNotes ?? policy.persistNotes,
    externalSearchEnabled: args.externalSearch ?? policy.externalSearchEnabled,
    model: args.model ?? policy.model,
    maxOutputTokens: args.maxOutputTokens ?? policy.maxOutputTokens,
    maxAgentCallsPerRun,
    maxCandidatesPerRun,
  };
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function extractResponseText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const direct = record.output_text ?? record.text;
  if (typeof direct === "string") return direct;
  const chunks: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      if (value.trim().length > 0) chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") chunks.push(obj.text);
    if (typeof obj.content === "string") chunks.push(obj.content);
    if (Array.isArray(obj.content)) visit(obj.content, depth + 1);
    if (Array.isArray(obj.output)) visit(obj.output, depth + 1);
  };
  visit(record.output ?? record.choices ?? record, 0);
  return chunks.join("\n").trim();
}

function extractCitations(
  payload: unknown,
): ExternalResearchResult["citations"] {
  if (!payload || typeof payload !== "object") return [];
  const citations: ExternalResearchResult["citations"] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const url =
      typeof obj.url === "string"
        ? obj.url
        : typeof obj.uri === "string"
          ? obj.uri
          : null;
    if (url && !seen.has(url)) {
      seen.add(url);
      citations.push({
        title:
          typeof obj.title === "string"
            ? obj.title
            : typeof obj.name === "string"
              ? obj.name
              : null,
        url,
        source:
          typeof obj.source === "string"
            ? obj.source
            : typeof obj.domain === "string"
              ? obj.domain
              : null,
      });
    }
    for (const key of [
      "citations",
      "annotations",
      "sources",
      "output",
      "content",
      "results",
    ]) {
      visit(obj[key], depth + 1);
    }
  };
  visit(payload, 0);
  return citations.slice(0, 8);
}

function extractMarkdownCitations(
  text: string,
): ExternalResearchResult["citations"] {
  const citations: ExternalResearchResult["citations"] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const title = match[1]?.trim() || null;
    const url = match[2]?.trim() || null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let source: string | null = null;
    try {
      source = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      source = null;
    }
    citations.push({ title, url, source });
    if (citations.length >= 6) break;
  }
  return citations;
}

function compactExternalResearchSummary(text: string): string {
  const cleaned = text
    .replace(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "No public context found.";
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const first = sentences[0] ?? cleaned;
  const second =
    sentences.find((sentence) =>
      /\b(explain|unexplained|public|news|source|catalyst|mixed|risk)\b/i.test(
        sentence,
      ),
    ) ?? sentences[1];
  const summary = [first, second]
    .filter(
      (sentence, index, all) => sentence && all.indexOf(sentence) === index,
    )
    .join(" ");
  return summary.length <= 360 ? summary : `${summary.slice(0, 340).trim()}...`;
}

function extractServerToolCallCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const record = payload as Record<string, unknown>;
  const direct = Number(record.num_server_side_tools_used);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const details = record.server_side_tool_usage_details;
  if (details && typeof details === "object") {
    const obj = details as Record<string, unknown>;
    const web = Number(obj.web_search_calls ?? 0);
    const x = Number(obj.x_search_calls ?? 0);
    return Math.max(
      0,
      (Number.isFinite(web) ? web : 0) + (Number.isFinite(x) ? x : 0),
    );
  }
  return 0;
}

async function runExternalResearch(params: {
  candidate: HolderResearchCandidate;
  policy: HolderResearchPolicy;
  dryRun: boolean;
}): Promise<ExternalResearchResult> {
  if (!params.policy.externalSearchEnabled) {
    return {
      status: "skipped",
      summary: null,
      citations: [],
      costUsd: 0,
      toolCalls: 0,
      error: null,
    };
  }
  if (params.candidate.score < params.policy.externalSearchMinScore) {
    return {
      status: "skipped",
      summary: null,
      citations: [],
      costUsd: 0,
      toolCalls: 0,
      error: "below_external_search_score_gate",
    };
  }
  if (params.dryRun) {
    return {
      status: "dry_run",
      summary:
        "Dry-run: external web/X search would run for this shortlisted candidate.",
      citations: [],
      costUsd: params.policy.estimatedExternalSearchCostUsd,
      toolCalls: 0,
      error: null,
    };
  }

  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: "error",
      summary: null,
      citations: [],
      costUsd: 0,
      toolCalls: 0,
      error: "XAI_API_KEY missing",
    };
  }

  const now = new Date();
  const from = new Date(
    now.getTime() - params.policy.externalSearchWindowHours * 3_600_000,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const baseUrl = (
    process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1"
  ).replace(/\/+$/, "");

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.policy.externalSearchModel,
        max_output_tokens: params.policy.externalSearchMaxOutputTokens,
        input: [
          {
            role: "system",
            content:
              "You investigate public context for prediction-market holder signals. Use web_search and x_search. The holder data is intentionally redacted; do not ask for wallet identities. Return a very compact public-context read, not a news memo. Compare dated headlines/posts to the supplied holder activity/snapshot timing. Answer only: did public information precede the holder move, coincide with it, follow it, or not explain it? Include at most 2 short sentences and a few source links. Do not invent a catalyst.",
          },
          {
            role: "user",
            content: JSON.stringify(
              buildHolderResearchExternalSearchInput(params.candidate),
            ),
          },
        ],
        tools: [
          { type: "web_search" },
          {
            type: "x_search",
            from_date: dateOnly(from),
            to_date: dateOnly(now),
          },
        ],
      }),
    });

    const rawText = await response.text();
    let payload: unknown = rawText;
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      payload = rawText;
    }
    const text = extractResponseText(payload);
    if (!response.ok) {
      return {
        status: "error",
        summary: null,
        citations: [],
        costUsd: 0,
        toolCalls: extractServerToolCallCount(payload),
        error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
      };
    }
    const summary = compactExternalResearchSummary(text);
    const payloadCitations = extractCitations(payload);
    const markdownCitations = extractMarkdownCitations(text);
    return {
      status:
        summary.length > 0 &&
        !summary.toLowerCase().includes("no public context")
          ? "ok"
          : "no_public_context",
      summary: summary || "No public context found.",
      citations:
        payloadCitations.length > 0 ? payloadCitations : markdownCitations,
      costUsd: params.policy.estimatedExternalSearchCostUsd,
      toolCalls: extractServerToolCallCount(payload),
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      summary: null,
      citations: [],
      costUsd: 0,
      toolCalls: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function zeroCost(): ResolvedCost {
  return resolveAiCost({
    inputTokens: 0,
    outputTokens: 0,
    priceInputPerM: 0,
    priceOutputPerM: 0,
  });
}

function estimateDryRunCost(params: {
  systemPrompt: string;
  userPrompt: string;
  policy: HolderResearchPolicy;
}): ResolvedCost {
  const pricing = getOpenRouterModelPricingPerM(params.policy.model);
  if (!pricing) {
    return {
      ...zeroCost(),
      estimatedCostUsd: params.policy.estimatedCallCostUsd,
      chargedCostUsd: params.policy.estimatedCallCostUsd,
      costSource: "estimated",
    };
  }
  return resolveAiCost({
    inputTokens: estimateTokens(params.systemPrompt + params.userPrompt),
    outputTokens: params.policy.maxOutputTokens,
    priceInputPerM: pricing.inputPerM,
    priceOutputPerM: pricing.outputPerM,
  });
}

function parseModelJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  const objectText =
    firstBrace >= 0 && lastBrace > firstBrace
      ? unfenced.slice(firstBrace, lastBrace + 1)
      : unfenced;

  try {
    return JSON.parse(objectText) as unknown;
  } catch {
    const repaired = objectText
      .replace(/,\s*([}\]])/g, "$1")
      .split("")
      .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
      .join("");
    return JSON.parse(repaired) as unknown;
  }
}

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

async function callHolderResearchModel(params: {
  candidate: HolderResearchCandidate;
  policy: HolderResearchPolicy;
  externalResearch: ExternalResearchResult | null;
}): Promise<HolderResearchModelDecision> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const candidateJson = {
    ...buildHolderResearchCandidatePromptJson(params.candidate),
    externalResearch: params.externalResearch,
  };
  const allowedEvidenceIds = params.candidate.evidence.map(
    (evidence) => evidence.id,
  );
  const systemPrompt = buildHolderResearchSystemPrompt();
  const userPrompt = buildHolderResearchUserPrompt({
    candidateJson,
    allowedEvidenceIds,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.openRouterKey}`,
        },
        body: JSON.stringify({
          model: params.policy.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: params.policy.maxOutputTokens,
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

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter response missing content");

    const parsedJson = parseModelJsonObject(content);
    const output = parseHolderResearchAgentOutputV1(parsedJson);
    const invalidEvidenceIds = output.evidence_ids.filter(
      (id) => !allowedEvidenceIds.includes(id),
    );
    if (invalidEvidenceIds.length > 0) {
      throw new Error(
        `Model returned unknown evidence ids: ${invalidEvidenceIds.join(", ")}`,
      );
    }

    const pricing = getOpenRouterModelPricingPerM(params.policy.model);
    const provider = extractProviderCostUsd(payload);
    const promptTokens =
      payload.usage?.prompt_tokens ?? estimateTokens(systemPrompt + userPrompt);
    const completionTokens =
      payload.usage?.completion_tokens ?? estimateTokens(content);
    const cost = resolveAiCost({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      priceInputPerM: pricing?.inputPerM ?? 0,
      priceOutputPerM: pricing?.outputPerM ?? 0,
      providerCostUsd: provider.providerCostUsd,
      providerCostField: provider.providerCostField,
      providerCostUsdTicks: provider.providerCostUsdTicks,
    });

    return {
      candidate: params.candidate,
      output,
      cost,
      modelMeta: {
        model: params.policy.model,
        external_research: params.externalResearch,
        mode: "openrouter",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: payload.usage?.total_tokens ?? null,
        cost_source: cost.costSource,
        charged_cost_usd: cost.chargedCostUsd,
        estimated_cost_usd: cost.estimatedCostUsd,
        provider_cost_usd: cost.providerCostUsd,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeCandidate(params: {
  candidate: HolderResearchCandidate;
  policy: HolderResearchPolicy;
  callModel: boolean;
  externalResearch: ExternalResearchResult | null;
}): Promise<HolderResearchModelDecision> {
  if (params.callModel) {
    return callHolderResearchModel({
      candidate: params.candidate,
      policy: params.policy,
      externalResearch: params.externalResearch,
    });
  }

  const candidateJson = {
    ...buildHolderResearchCandidatePromptJson(params.candidate),
    externalResearch: params.externalResearch,
  };
  const systemPrompt = buildHolderResearchSystemPrompt();
  const userPrompt = buildHolderResearchUserPrompt({
    candidateJson,
    allowedEvidenceIds: params.candidate.evidence.map(
      (evidence) => evidence.id,
    ),
  });
  const cost = params.policy.dryRun
    ? estimateDryRunCost({
        systemPrompt,
        userPrompt,
        policy: params.policy,
      })
    : zeroCost();
  return {
    candidate: params.candidate,
    output: buildDeterministicHolderResearchDecision(
      params.candidate,
      params.policy,
    ),
    cost,
    modelMeta: {
      model: params.policy.model,
      external_research: params.externalResearch,
      mode: "deterministic_dry_run",
      estimated_cost_usd: cost.estimatedCostUsd,
      charged_cost_usd: 0,
      pricing_known: getOpenRouterModelPricingPerM(params.policy.model) != null,
    },
  };
}

function buildSelectionPolicy(policy: HolderResearchPolicy): HolderResearchPolicy {
  if (!policy.decisionCacheEnabled) return policy;
  const lookaheadLimit = Math.min(
    policy.maxCandidatePool,
    policy.maxCandidatesPerRun + policy.maxAgentCallsPerRun * 2,
  );
  return {
    ...policy,
    maxAgentCallsPerRun: lookaheadLimit,
    maxCandidatesPerRun: lookaheadLimit,
  };
}

function decisionCacheReportEntry(
  candidate: HolderResearchCandidate,
  evaluation: HolderResearchDecisionCacheEvaluation,
) {
  return {
    key: candidate.key,
    status: evaluation.cachedStatus,
    lastCheckedAt: evaluation.lastCheckedAt,
    nextEligibleAt: evaluation.nextEligibleAt,
    meaningfulDeltaReasons: evaluation.meaningfulDeltaReasons,
  };
}

export async function runHolderResearch(
  args: HolderResearchRunArgs = parseArgs(process.argv.slice(2)),
  options: HolderResearchRunOptions = {},
): Promise<HolderResearchRunReport> {
  const startedAt = Date.now();
  const runId = `holder_research:${new Date().toISOString()}:${randomUUID()}`;
  const policyResult = await resolveHolderResearchPolicy(pool);
  const policy = withPolicyOverrides(policyResult.effective, args);
  const selectionPolicy = buildSelectionPolicy(policy);
  const toolCalls: HolderResearchRunReport["toolCalls"] = [];
  const decisionCache = {
    enabled: policy.decisionCacheEnabled,
    status: (policy.decisionCacheEnabled && options.decisionCacheRedis
      ? "ok"
      : "skipped") as "ok" | "skipped" | "error",
    checked: 0,
    skipped: 0,
    rechecked: 0,
    written: 0,
    errors: 0,
    dryRun: policy.dryRun,
  };
  const decisionCacheSkipped: HolderResearchRunReport["decisionCacheSkipped"] =
    [];
  const decisionCacheRechecked: HolderResearchRunReport["decisionCacheRechecked"] =
    [];

  const client = await pool.connect();
  try {
    const candidates = await loadHolderResearchCandidates(client, policy);
    toolCalls.push({
      name: "candidate_scan",
      count: candidates.length,
      status: "ok",
    });

    const selection = selectHolderResearchCandidates(
      candidates,
      selectionPolicy,
    );
    const selectedWithLive = await enrichHolderResearchLivePositions(
      client,
      selection.selected,
      policy,
    );
    toolCalls.push({
      name: "live_position_check",
      count: Math.min(
        policy.maxLiveChecksPerRun,
        selection.selected.reduce(
          (sum, candidate) => sum + candidate.market.holders.length,
          0,
        ),
      ),
      status: policy.maxLiveChecksPerRun > 0 ? "ok" : "skipped",
    });
    const selectedWithContext = await enrichHolderResearchHolderContext(
      client,
      selectedWithLive,
      policy,
    );
    toolCalls.push({
      name: "holder_context",
      count:
        policy.maxHolderContextHoldersPerCandidate > 0 &&
        policy.maxHolderContextPositionsPerHolder > 0
          ? selectedWithContext.reduce(
              (sum, candidate) =>
                sum +
                candidate.market.holders.filter(
                  (holder) => holder.relatedOpenPositions.length > 0,
                ).length,
              0,
            )
          : 0,
      status:
        policy.maxHolderContextHoldersPerCandidate > 0 &&
        policy.maxHolderContextPositionsPerHolder > 0
          ? "ok"
          : "skipped",
    });

    const decisions: HolderResearchModelDecision[] = [];
    const externalResearchByKey = new Map<string, ExternalResearchResult>();
    let externalSearchCalls = 0;
    let publishCount = 0;
    let consecutiveSkips = 0;
    for (const candidate of selectedWithContext) {
      if (decisions.length >= policy.maxAgentCallsPerRun) break;
      if (publishCount >= policy.maxPublishPerRun) break;
      if (consecutiveSkips >= policy.maxConsecutiveSkips) break;

      let cacheEvaluation: HolderResearchDecisionCacheEvaluation | null = null;
      if (policy.decisionCacheEnabled && options.decisionCacheRedis) {
        decisionCache.checked += 1;
        const cacheKey = buildHolderResearchDecisionCacheKey(candidate.key);
        try {
          const rawCached = await options.decisionCacheRedis.get(cacheKey);
          const cachedDecision = parseHolderResearchCachedDecision(rawCached);
          cacheEvaluation = evaluateHolderResearchDecisionCache({
            candidate,
            cachedDecision,
            policy,
          });
          if (rawCached && !cachedDecision) {
            decisionCache.errors += 1;
            cacheEvaluation = {
              ...cacheEvaluation,
              reason: "cache_parse_error",
            };
          }
          if (cacheEvaluation.action === "skip") {
            decisionCache.skipped += 1;
            decisionCacheSkipped.push({
              ...decisionCacheReportEntry(candidate, cacheEvaluation),
              reason: "decision_cache",
            });
            continue;
          }
          if (
            cacheEvaluation.cachedStatus === "SKIP" ||
            cacheEvaluation.cachedStatus === "CONTEXT"
          ) {
            decisionCache.rechecked += 1;
            decisionCacheRechecked.push({
              ...decisionCacheReportEntry(candidate, cacheEvaluation),
              reason: cacheEvaluation.reason,
            });
          }
        } catch (error) {
          decisionCache.status = "error";
          decisionCache.errors += 1;
          console.warn("[holder-research] decision_cache skipped", {
            key: candidate.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let externalResearch: ExternalResearchResult | null = null;
      if (
        policy.externalSearchEnabled &&
        externalSearchCalls < policy.maxExternalSearchCallsPerRun
      ) {
        externalResearch = await runExternalResearch({
          candidate,
          policy,
          dryRun: policy.dryRun,
        });
        if (
          externalResearch.status !== "skipped" ||
          externalResearch.costUsd > 0
        ) {
          externalSearchCalls += 1;
        }
        externalResearchByKey.set(candidate.key, externalResearch);
      }

      const decision = await synthesizeCandidate({
        candidate,
        policy,
        callModel: args.callModel,
        externalResearch,
      });
      decisions.push(decision);
      if (
        policy.decisionCacheEnabled &&
        options.decisionCacheRedis &&
        !policy.dryRun &&
        args.callModel
      ) {
        try {
          const cacheRecord = buildHolderResearchDecisionCacheRecord({
            candidate,
            output: decision.output,
            model: policy.model,
            policy,
          });
          await options.decisionCacheRedis.set(
            buildHolderResearchDecisionCacheKey(candidate.key),
            JSON.stringify(cacheRecord),
            { EX: policy.decisionCacheTtlHours * 3_600 },
          );
          decisionCache.written += 1;
        } catch (error) {
          decisionCache.status = "error";
          decisionCache.errors += 1;
          console.warn("[holder-research] decision_cache write skipped", {
            key: candidate.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (decision.output.status === "PUBLISH") {
        publishCount += 1;
        consecutiveSkips = 0;
      } else if (decision.output.status === "SKIP") {
        consecutiveSkips += 1;
      } else {
        consecutiveSkips = 0;
      }
    }
    toolCalls.push({
      name: "decision_cache",
      count: decisionCache.checked,
      status: decisionCache.status,
      detail: policy.decisionCacheEnabled
        ? options.decisionCacheRedis
          ? `skipped=${decisionCache.skipped} rechecked=${decisionCache.rechecked} written=${decisionCache.written} errors=${decisionCache.errors}`
          : "redis unavailable"
        : "policy disabled",
    });
    toolCalls.push({
      name: "external_research",
      count: externalSearchCalls,
      status:
        policy.externalSearchEnabled && policy.maxExternalSearchCallsPerRun > 0
          ? "ok"
          : "skipped",
      detail: policy.externalSearchEnabled
        ? "delegated xAI web_search/x_search"
        : "policy disabled",
    });
    toolCalls.push({
      name: args.callModel ? "llm_synthesis" : "deterministic_synthesis",
      count: decisions.length,
      status: "ok",
      detail: args.callModel ? "OpenRouter" : "no network call",
    });

    let persistence: HolderResearchRunReport["persistence"] = null;
    const shouldPersist =
      !policy.dryRun && policy.persistNotes && args.callModel;
    if (shouldPersist) {
      persistence = await persistHolderResearchNotes(client, {
        runnerRunId: runId,
        decisions: decisions.map<HolderResearchPersistDecision>((decision) => ({
          candidate: decision.candidate,
          output: decision.output,
          modelMeta: decision.modelMeta,
        })),
      });
    }
    toolCalls.push({
      name: "note_persistence",
      count: persistence?.persisted ?? 0,
      status: shouldPersist ? "ok" : "skipped",
      detail: shouldPersist
        ? undefined
        : "dry-run, persistNotes=false, or callModel=false",
    });

    const estimatedCostUsd = decisions.reduce(
      (sum, decision) => sum + decision.cost.estimatedCostUsd,
      0,
    );
    const externalSearchEstimatedCostUsd = Array.from(
      externalResearchByKey.values(),
    ).reduce((sum, result) => sum + result.costUsd, 0);
    const chargedCostUsd = args.callModel
      ? decisions.reduce(
          (sum, decision) => sum + decision.cost.chargedCostUsd,
          0,
        )
      : 0;
    const externalSearchChargedCostUsd =
      policy.dryRun || !policy.externalSearchEnabled
        ? 0
        : externalSearchEstimatedCostUsd;
    const providerReportedCosts = decisions
      .map((decision) => decision.cost.providerCostUsd)
      .filter((cost): cost is number => cost != null);

    const report: HolderResearchRunReport = {
      runId,
      dryRun: policy.dryRun,
      callModel: args.callModel,
      persistNotes: policy.persistNotes,
      model: policy.model,
      policy: {
        enabled: policy.enabled,
        source: policyResult.source,
        maxAgentCallsPerRun: policy.maxAgentCallsPerRun,
        maxPublishPerRun: policy.maxPublishPerRun,
        maxCandidatePool: policy.maxCandidatePool,
        externalSearchEnabled: policy.externalSearchEnabled,
        maxExternalSearchCallsPerRun: policy.maxExternalSearchCallsPerRun,
        decisionCacheEnabled: policy.decisionCacheEnabled,
      },
      totals: {
        candidatesLoaded: candidates.length,
        selected: selectedWithContext.length,
        published: decisions.filter(
          (decision) => decision.output.status === "PUBLISH",
        ).length,
        context: decisions.filter(
          (decision) => decision.output.status === "CONTEXT",
        ).length,
        skipped: decisions.filter(
          (decision) => decision.output.status === "SKIP",
        ).length,
        persisted: persistence?.persisted ?? 0,
        estimatedCostUsd,
        chargedCostUsd,
        externalSearchEstimatedCostUsd,
        externalSearchChargedCostUsd,
        totalEstimatedCostUsd:
          estimatedCostUsd + externalSearchEstimatedCostUsd,
        totalChargedCostUsd: chargedCostUsd + externalSearchChargedCostUsd,
        providerReportedCostUsd:
          providerReportedCosts.length > 0
            ? providerReportedCosts.reduce((sum, cost) => sum + cost, 0)
            : null,
        durationMs: Date.now() - startedAt,
      },
      toolCalls,
      decisionCache,
      decisionCacheSkipped,
      decisionCacheRechecked,
      selected: selectedWithContext.map((candidate) => ({
        key: candidate.key,
        bucket: candidate.bucket,
        score: candidate.score,
        marketId: candidate.market.marketId,
        eventId: candidate.market.eventId,
        title: candidate.market.marketTitle,
        side: candidate.side,
        reasons: candidate.reasons,
      })),
      decisions: decisions.map((decision) => ({
        key: decision.candidate.key,
        status: decision.output.status,
        confidence: decision.output.confidence,
        userCard: {
          headline: decision.output.headline,
          summary: decision.output.summary,
          caveats: decision.output.caveats,
        },
        rationale: decision.output.rationale,
        evidenceIds: decision.output.evidence_ids,
        costUsd: args.callModel
          ? decision.cost.chargedCostUsd
          : decision.cost.estimatedCostUsd,
        costSource: args.callModel ? decision.cost.costSource : "estimated",
        externalSearchStatus:
          externalResearchByKey.get(decision.candidate.key)?.status ??
          "skipped",
        externalSearchSummary:
          externalResearchByKey.get(decision.candidate.key)?.summary ?? null,
        externalSearchCitations:
          externalResearchByKey.get(decision.candidate.key)?.citations ?? [],
      })),
      persistence,
    };

    if (args.outPath) {
      await writeFile(args.outPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (args.verbose || !args.outPath) {
      console.log(JSON.stringify(report, null, 2));
    }
    return report;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runHolderResearch();
  } finally {
    await pool.end();
  }
}
