#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  createRedisClient,
  ensureRedis,
  requestFreshMarketPrices,
  type PriceRefreshRedis,
} from "@hunch/infra";

import { pool } from "./db.js";
import { env } from "./env.js";
import {
  extractProviderCostUsd,
  resolveAiCost,
  type ResolvedCost,
} from "./lib/ai-cost.js";
import { getOpenRouterModelPricingPerM } from "./lib/ai-pricing.js";
import { stripSourceMarkup } from "./lib/source-markup.js";
import {
  buildHolderResearchSystemPrompt,
  buildHolderResearchSystemPromptV2,
  buildHolderResearchTriageSystemPrompt,
  buildHolderResearchTriageSystemPromptV2,
  buildHolderResearchTriageUserPrompt,
  buildHolderResearchTriageUserPromptV2,
  buildHolderResearchUserPrompt,
  buildHolderResearchUserPromptV2,
  parseHolderResearchAgentOutputV1,
  parseHolderResearchExternalResearchV2,
  parseHolderResearchFinalOutputV2,
  parseHolderResearchTriageOutputV1,
  parseHolderResearchTriageOutputV2,
  type HolderResearchAgentOutputV1,
  type HolderResearchExternalResearchV2,
  type HolderResearchTriageDecisionV2,
  type HolderResearchTriageOutputV1,
} from "./schemas/holder-research.js";
import {
  adaptHolderResearchFinalOutputV2,
  applyHolderResearchPreviousDecisionContext,
  applyHolderResearchLivePriceChecks,
  applyHolderResearchPublishQualityGate,
  buildDeterministicHolderResearchDecision,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchCandidatePromptJsonV2,
  buildHolderResearchDecisionCacheKey,
  buildHolderResearchDecisionCacheRecord,
  buildHolderResearchExternalSearchInput,
  buildHolderResearchExternalSearchInputV2,
  buildHolderResearchSelectionDiagnostics,
  buildHolderResearchObservationPool,
  buildHolderResearchTriageCandidatePromptJson,
  buildHolderResearchTriageCandidatePromptJsonV2,
  enrichHolderResearchHolderContext,
  enrichHolderResearchFirstObservedActivity,
  enrichHolderResearchLivePositions,
  enrichHolderResearchMarketTypeMetrics,
  evaluateResolvedHolderResearchNotes,
  evaluateHolderResearchDecisionCache,
  HOLDER_RESEARCH_EXTERNAL_SEARCH_SPORTS_WORDING,
  loadHolderResearchCalibrationMemo,
  loadHolderResearchCandidates,
  listHolderResearchPromptEvidenceIdsV2,
  parseHolderResearchCachedDecision,
  persistHolderResearchNotes,
  selectHolderResearchCandidates,
  type HolderResearchCandidate,
  type HolderResearchDecisionCacheEvaluation,
  type HolderResearchPersistDecision,
  type HolderResearchObservationCandidate,
  type HolderResearchSelectionDiagnostics,
} from "./services/holder-research.js";
import {
  linkHolderResearchObservationNotes,
  loadHolderResearchSupplyHealth,
  persistHolderResearchCandidateObservations,
  pruneHolderResearchCandidateObservations,
  updateHolderResearchObservationStages,
  type HolderResearchObservationStageUpdate,
} from "./services/holder-research-observations.js";
import {
  auditHolderResearchSignalPerformance,
  type HolderResearchPerformanceAuditResult,
} from "./services/holder-research-performance.js";
import {
  resolveHolderResearchPolicy,
  resolveWalletIntelRefreshPolicy,
  type HolderResearchPolicy,
} from "./services/runtime-policies.js";

export type HolderResearchRunArgs = {
  dryRun: boolean | null;
  callModel: boolean;
  externalSearch: boolean | null;
  persistNotes: boolean | null;
  model: string | null;
  triageModel: string | null;
  limit: number | null;
  maxAgentCalls: number | null;
  maxOutputTokens: number | null;
  outPath: string | null;
  triageBatchSize: number | null;
  triageMaxBatches: number | null;
  includePerformanceReport: boolean;
  verbose: boolean;
};

type HolderResearchRunPerformanceAuditReport =
  | (Pick<
      HolderResearchPerformanceAuditResult,
      | "considered"
      | "correct"
      | "errors"
      | "evaluated"
      | "missingEntry"
      | "open"
      | "resolved"
      | "unchanged"
      | "unknown"
      | "written"
      | "wrong"
    > & {
      aggregates?: HolderResearchPerformanceAuditResult["aggregates"];
      items?: HolderResearchPerformanceAuditResult["items"];
    })
  | null;

type HolderResearchModelDecision = {
  candidate: HolderResearchCandidate;
  output: HolderResearchAgentOutputV1;
  modelMeta: Record<string, unknown>;
  cost: ResolvedCost;
};

type HolderResearchTriageDecision = HolderResearchTriageDecisionV2 & {
  legacyPriority?: number;
};

type HolderResearchTriageModelResult = {
  decisions: HolderResearchTriageDecision[];
  cost: ResolvedCost;
  modelMeta: Record<string, unknown>;
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
  priceRefreshRedis?: PriceRefreshRedis | null;
};

const CLI_REDIS_CONNECT_TIMEOUT_MS = 5_000;
const HOLDER_RESEARCH_LIVE_PRICE_MAX_FRESH_AGE_MS = 15 * 60 * 1_000;

type ExternalResearchResult = Omit<
  HolderResearchExternalResearchV2,
  "status" | "summary"
> & {
  status: HolderResearchExternalResearchV2["status"] | "skipped" | "dry_run";
  summary: string | null;
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
  triageModel: string;
  policy: {
    enabled: boolean;
    source: "env" | "db";
    pipelineV2Mode: HolderResearchPolicy["pipelineV2Mode"];
    maxAgentCallsPerRun: number;
    maxPublishPerRun: number;
    maxCandidatePool: number;
    externalSearchEnabled: boolean;
    maxExternalSearchCallsPerRun: number;
    forceExternalSearchForInvestigations: boolean;
    triageEnabled: boolean;
    triageModel: string;
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
    triageEstimatedCostUsd: number;
    triageChargedCostUsd: number;
    totalEstimatedCostUsd: number;
    totalChargedCostUsd: number;
    providerReportedCostUsd: number | null;
    durationMs: number;
  };
  selection: HolderResearchSelectionDiagnostics;
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
  triage: {
    enabled: boolean;
    status: "ok" | "skipped" | "error";
    calls: number;
    investigate: number;
    watch: number;
    skip: number;
    errors: number;
    fallback: number;
  };
  triageErrors: Array<{
    batchIndex: number;
    error: string;
    contentLength: number | null;
    finishReason: string | null;
    fallback: number;
  }>;
  triageDecisions: Array<{
    key: string;
    action: string;
    priority: number | null;
    reasonCodes: string[];
    researchNeed: string;
    reason: string;
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
    executionPriority: string;
    executionPriorityReason: string;
    externalSearchStatus: string;
    externalSearchSummary: string | null;
    externalSearchCitations: ExternalResearchResult["citations"];
  }>;
  persistence: Awaited<ReturnType<typeof persistHolderResearchNotes>> | null;
  resolvedEvaluation: Awaited<
    ReturnType<typeof evaluateResolvedHolderResearchNotes>
  > | null;
  performanceAudit: HolderResearchRunPerformanceAuditReport;
};

type HolderResearchDecisionCacheStats =
  HolderResearchRunReport["decisionCache"];

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

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function connectHolderResearchCliRedis(): Promise<ReturnType<
  typeof createRedisClient
> | null> {
  if (!env.redisUrl) return null;
  const redis = createRedisClient({ url: env.redisUrl });
  redis.on("error", () => undefined);
  try {
    await withTimeout(
      ensureRedis(redis, {
        logLabel: "holder-research-run",
        maxWaitMs: CLI_REDIS_CONNECT_TIMEOUT_MS,
        waitForReady: true,
      }),
      CLI_REDIS_CONNECT_TIMEOUT_MS,
      "Redis connection",
    );
    return redis;
  } catch (error) {
    console.warn("[holder-research] Redis unavailable for CLI run", {
      error: error instanceof Error ? error.message : String(error),
    });
    await redis.quit().catch(() => undefined);
    return null;
  }
}

export function parseHolderResearchRunArgs(
  argv: string[],
): HolderResearchRunArgs {
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
    triageModel: parseFlag(argv, "--triage-model")?.trim() || null,
    limit: parsePositiveInt(parseFlag(argv, "--limit")),
    maxAgentCalls: parsePositiveInt(parseFlag(argv, "--max-agent-calls")),
    maxOutputTokens: parsePositiveInt(parseFlag(argv, "--max-output-tokens")),
    outPath: parseFlag(argv, "--out")?.trim() || null,
    triageBatchSize: parsePositiveInt(parseFlag(argv, "--triage-batch-size")),
    triageMaxBatches: parsePositiveInt(parseFlag(argv, "--triage-max-batches")),
    includePerformanceReport: hasFlag(argv, "--include-performance-report"),
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
    triageModel: args.triageModel ?? policy.triageModel,
    maxOutputTokens: args.maxOutputTokens ?? policy.maxOutputTokens,
    maxAgentCallsPerRun,
    maxCandidatesPerRun,
    triageBatchSize: args.triageBatchSize ?? policy.triageBatchSize,
    triageMaxBatchesPerRun:
      args.triageMaxBatches ?? policy.triageMaxBatchesPerRun,
  };
}

function compactPerformanceAuditReport(
  result: HolderResearchPerformanceAuditResult,
  includeDetails: boolean,
): Exclude<HolderResearchRunPerformanceAuditReport, null> {
  const compact = {
    considered: result.considered,
    evaluated: result.evaluated,
    written: result.written,
    unchanged: result.unchanged,
    errors: result.errors,
    missingEntry: result.missingEntry,
    open: result.open,
    resolved: result.resolved,
    unknown: result.unknown,
    correct: result.correct,
    wrong: result.wrong,
  };
  if (!includeDetails) return compact;
  return {
    ...compact,
    aggregates: result.aggregates,
    items: [],
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
              : url,
        url,
        publishedAt:
          typeof obj.published_at === "string"
            ? obj.published_at
            : typeof obj.publishedAt === "string"
              ? obj.publishedAt
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
  return citations.slice(0, 3);
}

function extractMarkdownCitations(
  text: string,
): ExternalResearchResult["citations"] {
  const citations: ExternalResearchResult["citations"] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(
    /\[(\[?\d+\]?|[^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
  )) {
    const rawTitle =
      match[1]?.replaceAll("[", "").replaceAll("]", "").trim() || null;
    const url = match[2]?.trim() || null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({
      title: rawTitle && !/^\d+$/.test(rawTitle) ? rawTitle : url,
      url,
      publishedAt: null,
    });
    if (citations.length >= 3) break;
  }
  return citations;
}

function compactExternalResearchSummary(text: string): string {
  const cleaned = stripSourceMarkup(text);
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
  if (summary.length <= 280) return summary;
  const clipped = summary.slice(0, 280);
  const boundary = Math.max(
    clipped.lastIndexOf(". "),
    clipped.lastIndexOf("; "),
  );
  if (boundary >= 160) return clipped.slice(0, boundary + 1).trim();
  const space = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, space > 0 ? space : 277).trimEnd()}...`;
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

export function buildHolderResearchExternalSearchSystemPrompt(): string {
  return [
    "You investigate outside information for prediction-market holder signals.",
    "Use web_search and x_search.",
    "The holder data is intentionally redacted; do not ask for wallet identities.",
    "Return one short, plain sentence for a signal feed, not a news memo.",
    "Compare dated headlines/posts to the supplied holder activity/snapshot timing.",
    "Answer only whether outside information supports the holder side, supports the opposite side, mostly shows the move was already public, does not explain the move, or is mixed.",
    HOLDER_RESEARCH_EXTERNAL_SEARCH_SPORTS_WORDING,
    "Do not start with phrases like 'Public info', 'Public context', or 'Public news'.",
    "Do not use markdown, footnotes, bracket citations, or raw URLs in the text.",
    "Do not invent a catalyst.",
  ].join(" ");
}

export function buildHolderResearchExternalSearchSystemPromptV2(): string {
  return [
    "You investigate one bounded outside-information question for a prediction-market holder candidate.",
    "Use web_search and x_search, then return only one JSON object.",
    "The object must contain status, verdict, timing, summary, citations, and comparableOdds. comparableOdds must be null unless cited sources provide a probability range for the selected side with an asOf timestamp.",
    "Use at most three citations with title, url, and publishedAt (ISO datetime or null).",
    "Compare dated evidence with the supplied first/last holder activity. Use after_holder only when the public evidence clearly appeared after holder activity.",
    "Do not infer wallet identity, skill, exposure, edge, PnL, or a trading recommendation.",
    HOLDER_RESEARCH_EXTERNAL_SEARCH_SPORTS_WORDING,
    "If evidence is absent or timing cannot be established, say so rather than inventing a catalyst.",
  ].join(" ");
}

function emptyExternalResearchResult(input: {
  status: ExternalResearchResult["status"];
  error?: string | null;
  summary?: string | null;
  costUsd?: number;
  toolCalls?: number;
}): ExternalResearchResult {
  return {
    status: input.status,
    verdict: "unknown",
    timing: "unknown",
    summary: input.summary ?? null,
    citations: [],
    comparableOdds: null,
    costUsd: input.costUsd ?? 0,
    toolCalls: input.toolCalls ?? 0,
    error: input.error ?? null,
  };
}

function canonicalExternalResearchV2(
  result: ExternalResearchResult | null,
): HolderResearchExternalResearchV2 {
  if (!result) {
    return {
      status: "no_evidence",
      verdict: "unknown",
      timing: "unknown",
      summary: "External research was not requested for this candidate.",
      citations: [],
      comparableOdds: null,
    };
  }
  return {
    status:
      result.status === "ok" ||
      result.status === "no_evidence" ||
      result.status === "error"
        ? result.status
        : "no_evidence",
    verdict: result.verdict,
    timing: result.timing,
    summary: result.summary ?? "No external evidence was available.",
    citations: result.citations.slice(0, 3),
    comparableOdds: result.comparableOdds ?? null,
  };
}

async function runExternalResearch(params: {
  candidate: HolderResearchCandidate;
  policy: HolderResearchPolicy;
  dryRun: boolean;
  researchNeed: HolderResearchTriageDecisionV2["research_need"];
  useV2: boolean;
}): Promise<ExternalResearchResult> {
  if (!params.policy.externalSearchEnabled) {
    return emptyExternalResearchResult({ status: "skipped" });
  }
  if (params.candidate.score < params.policy.externalSearchMinScore) {
    return emptyExternalResearchResult({
      status: "skipped",
      error: "below_external_search_score_gate",
    });
  }
  if (params.dryRun) {
    return emptyExternalResearchResult({
      status: "dry_run",
      summary:
        "Dry-run: external web/X search would run for this shortlisted candidate.",
      costUsd: params.policy.estimatedExternalSearchCostUsd,
    });
  }

  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    return emptyExternalResearchResult({
      status: "error",
      error: "XAI_API_KEY missing",
    });
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
            content: params.useV2
              ? buildHolderResearchExternalSearchSystemPromptV2()
              : buildHolderResearchExternalSearchSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify(
              params.useV2
                ? buildHolderResearchExternalSearchInputV2(
                    params.candidate,
                    params.policy,
                    params.researchNeed,
                  )
                : buildHolderResearchExternalSearchInput(params.candidate),
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
      return emptyExternalResearchResult({
        status: "error",
        toolCalls: extractServerToolCallCount(payload),
        error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
      });
    }
    if (params.useV2) {
      let structured: HolderResearchExternalResearchV2;
      try {
        structured = parseHolderResearchExternalResearchV2(
          parseModelJsonObject(text),
        );
      } catch {
        structured = parseHolderResearchExternalResearchV2(null);
      }
      const providerCitations = extractCitations(payload);
      return {
        ...structured,
        citations:
          structured.citations.length > 0
            ? structured.citations.slice(0, 3)
            : providerCitations,
        costUsd: params.policy.estimatedExternalSearchCostUsd,
        toolCalls: extractServerToolCallCount(payload),
        error:
          structured.status === "error" ? "invalid_structured_research" : null,
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
          : "no_evidence",
      verdict: "unknown",
      timing: "unknown",
      summary: summary || "No public context found.",
      citations:
        payloadCitations.length > 0 ? payloadCitations : markdownCitations,
      costUsd: params.policy.estimatedExternalSearchCostUsd,
      toolCalls: extractServerToolCallCount(payload),
      error: null,
    };
  } catch (error) {
    return emptyExternalResearchResult({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
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

function addResolvedCosts(
  left: ResolvedCost,
  right: ResolvedCost,
): ResolvedCost {
  const providerCostUsd =
    left.providerCostUsd != null || right.providerCostUsd != null
      ? (left.providerCostUsd ?? 0) + (right.providerCostUsd ?? 0)
      : null;
  const providerCostUsdTicks =
    left.providerCostUsdTicks != null || right.providerCostUsdTicks != null
      ? (left.providerCostUsdTicks ?? 0) + (right.providerCostUsdTicks ?? 0)
      : null;
  return {
    inputCostUsd: left.inputCostUsd + right.inputCostUsd,
    outputCostUsd: left.outputCostUsd + right.outputCostUsd,
    tokenCostUsd: left.tokenCostUsd + right.tokenCostUsd,
    toolCostUsd: left.toolCostUsd + right.toolCostUsd,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd,
    providerCostUsd,
    providerCostField:
      left.providerCostField ?? right.providerCostField ?? null,
    providerCostUsdTicks,
    chargedCostUsd: left.chargedCostUsd + right.chargedCostUsd,
    costSource:
      left.costSource === "provider_reported" ||
      right.costSource === "provider_reported"
        ? "provider_reported"
        : "estimated",
  };
}

function estimatedFailedModelCost(policy: HolderResearchPolicy): ResolvedCost {
  return {
    ...zeroCost(),
    estimatedCostUsd: policy.estimatedCallCostUsd,
    chargedCostUsd: policy.estimatedCallCostUsd,
    costSource: "estimated",
  };
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
  const unfenced = unfenceModelJson(content);
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  const objectText =
    firstBrace >= 0 && lastBrace > firstBrace
      ? unfenced.slice(firstBrace, lastBrace + 1)
      : unfenced;

  try {
    return JSON.parse(objectText) as unknown;
  } catch {
    return JSON.parse(repairJsonText(objectText)) as unknown;
  }
}

function unfenceModelJson(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function repairJsonText(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, "$1")
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("");
}

function parseJsonObjectText(text: string): unknown {
  return JSON.parse(repairJsonText(text)) as unknown;
}

function extractCompleteJsonObjectsFromArray(content: string): unknown[] {
  const source = unfenceModelJson(content);
  const decisionsIndex = source.search(/"decisions"\s*:/);
  if (decisionsIndex < 0) return [];
  const arrayStart = source.indexOf("[", decisionsIndex);
  if (arrayStart < 0) return [];

  const objects: unknown[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;

  for (let index = arrayStart + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const objectText = source.slice(objectStart, index + 1);
        try {
          objects.push(parseJsonObjectText(objectText));
        } catch {
          // Ignore malformed entries. The triage schema parser will still
          // reject unknown candidate keys from complete parsed objects.
        }
        objectStart = -1;
      }
    }
  }

  return objects;
}

export function parseHolderResearchTriageModelContent(
  content: string,
  allowedCandidateKeys: Iterable<string>,
): HolderResearchTriageOutputV1 {
  try {
    return parseHolderResearchTriageOutputV1(
      parseModelJsonObject(content),
      allowedCandidateKeys,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("unknown candidate keys")
    ) {
      throw error;
    }
    const decisions = extractCompleteJsonObjectsFromArray(content);
    if (decisions.length === 0) throw error;
    return parseHolderResearchTriageOutputV1(
      {
        version: "holder_research_triage_v1",
        decisions,
      },
      allowedCandidateKeys,
    );
  }
}

export function parseHolderResearchTriageModelContentV2(
  content: string,
  allowedCandidateKeys: Iterable<string>,
) {
  try {
    return parseHolderResearchTriageOutputV2(
      parseModelJsonObject(content),
      allowedCandidateKeys,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("unknown candidate keys")
    ) {
      throw error;
    }
    const decisions = extractCompleteJsonObjectsFromArray(content);
    if (decisions.length === 0) throw error;
    return parseHolderResearchTriageOutputV2(
      {
        version: "holder_research_triage_v2",
        decisions,
      },
      allowedCandidateKeys,
    );
  }
}

export function assertHolderResearchEvidenceIdsAllowed(
  evidenceIds: string[],
  allowedEvidenceIds: string[],
): void {
  const invalidEvidenceIds = evidenceIds.filter(
    (id) => !allowedEvidenceIds.includes(id),
  );
  if (invalidEvidenceIds.length > 0) {
    throw new Error(
      `Model returned unknown evidence ids: ${invalidEvidenceIds.join(", ")}`,
    );
  }
}

function adaptHolderResearchTriageDecisionV1(
  decision: HolderResearchTriageOutputV1["decisions"][number],
): HolderResearchTriageDecision {
  return {
    key: decision.key,
    action: decision.action,
    reason_codes:
      decision.action === "investigate"
        ? ["research_needed"]
        : ["insufficient_evidence"],
    research_need: decision.needs_external_search ? "market_context" : "none",
    reason: decision.reason,
    legacyPriority: decision.priority,
  };
}

class HolderResearchTriageParseError extends Error {
  contentLength: number | null;
  finishReason: string | null;

  constructor(
    message: string,
    input: {
      contentLength: number | null;
      finishReason: string | null;
      cause: unknown;
    },
  ) {
    super(message);
    this.name = "HolderResearchTriageParseError";
    this.contentLength = input.contentLength;
    this.finishReason = input.finishReason;
    this.cause = input.cause;
  }
}

type OpenRouterResponse = {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const triageFallbackBucketRank = new Map<
  HolderResearchCandidate["bucket"],
  number
>([
  ["sharp_minority", 0],
  ["sharp_side", 1],
  ["followup_existing", 2],
]);

const triageFallbackExcludedBuckets = new Set<
  HolderResearchCandidate["bucket"]
>(["concentration_risk", "event_bridge", "recent_flow"]);

function isClearSideCandidate(candidate: HolderResearchCandidate): boolean {
  return (
    (candidate.side === "YES" || candidate.side === "NO") &&
    candidate.direction !== "mixed"
  );
}

function sortTriageFallbackCandidates(
  candidates: HolderResearchCandidate[],
): HolderResearchCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftRank = triageFallbackBucketRank.get(left.bucket) ?? 100;
    const rightRank = triageFallbackBucketRank.get(right.bucket) ?? 100;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return right.score - left.score;
  });
}

export function selectHolderResearchTriageFallbackCandidates(
  candidates: HolderResearchCandidate[],
  remaining: number,
): HolderResearchCandidate[] {
  if (remaining <= 0) return [];
  const clearSide = candidates.filter(isClearSideCandidate);
  const preferred = clearSide.filter((candidate) =>
    triageFallbackBucketRank.has(candidate.bucket),
  );
  const secondary = clearSide.filter(
    (candidate) => !triageFallbackExcludedBuckets.has(candidate.bucket),
  );
  const pool =
    preferred.length > 0
      ? preferred
      : secondary.length > 0
        ? secondary
        : clearSide;
  return sortTriageFallbackCandidates(pool).slice(0, remaining);
}

export function selectHolderResearchTriageInvestigations(
  eligible: Array<{
    candidate: HolderResearchCandidate;
    decision: HolderResearchTriageDecision;
  }>,
  input: { limit: number; useV2: boolean },
) {
  const ordered = input.useV2
    ? eligible
    : [...eligible].sort(
        (left, right) =>
          (right.decision.legacyPriority ?? 0) -
          (left.decision.legacyPriority ?? 0),
      );
  return ordered.slice(0, Math.max(0, input.limit));
}

async function callHolderResearchTriageModel(params: {
  candidates: HolderResearchCandidate[];
  policy: HolderResearchPolicy;
  maxInvestigate: number;
  calibrationMemo: string[];
  useV2: boolean;
}): Promise<HolderResearchTriageModelResult> {
  const candidateJson = params.candidates.map((candidate) =>
    params.useV2
      ? buildHolderResearchTriageCandidatePromptJsonV2(candidate, params.policy)
      : buildHolderResearchTriageCandidatePromptJson(candidate, params.policy),
  );
  const systemPrompt = params.useV2
    ? buildHolderResearchTriageSystemPromptV2()
    : buildHolderResearchTriageSystemPrompt();
  const userPrompt = params.useV2
    ? buildHolderResearchTriageUserPromptV2({
        candidates: candidateJson,
        maxInvestigate: params.maxInvestigate,
      })
    : buildHolderResearchTriageUserPrompt({
        candidates: candidateJson,
        maxInvestigate: params.maxInvestigate,
        calibrationMemo: params.calibrationMemo,
      });

  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

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
          model: params.policy.triageModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.05,
          max_tokens: params.policy.triageMaxOutputTokens,
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
    if (!content) throw new Error("OpenRouter triage response missing content");
    let decisions: HolderResearchTriageDecision[];
    try {
      const allowedKeys = params.candidates.map((candidate) => candidate.key);
      decisions = params.useV2
        ? parseHolderResearchTriageModelContentV2(content, allowedKeys)
            .decisions
        : parseHolderResearchTriageModelContent(
            content,
            allowedKeys,
          ).decisions.map(adaptHolderResearchTriageDecisionV1);
    } catch (error) {
      throw new HolderResearchTriageParseError(
        error instanceof Error
          ? error.message
          : "Unable to parse triage response",
        {
          contentLength: content.length,
          finishReason: choice?.finish_reason ?? null,
          cause: error,
        },
      );
    }
    const pricing = getOpenRouterModelPricingPerM(params.policy.triageModel);
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
      decisions,
      cost,
      modelMeta: {
        model: params.policy.triageModel,
        mode: params.useV2 ? "openrouter_triage_v2" : "openrouter_triage_v1",
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

async function callHolderResearchModel(params: {
  candidate: HolderResearchCandidate;
  policy: HolderResearchPolicy;
  externalResearch: ExternalResearchResult | null;
  useV2: boolean;
}): Promise<HolderResearchModelDecision> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const externalResearchV2 = canonicalExternalResearchV2(
    params.externalResearch,
  );
  const candidateJson = params.useV2
    ? buildHolderResearchCandidatePromptJsonV2(
        params.candidate,
        params.policy,
        externalResearchV2,
      )
    : {
        ...buildHolderResearchCandidatePromptJson(
          params.candidate,
          params.policy,
        ),
        externalResearch: params.externalResearch,
      };
  const allowedEvidenceIds = params.useV2
    ? listHolderResearchPromptEvidenceIdsV2(params.candidate, params.policy)
    : params.candidate.evidence.map((evidence) => evidence.id);
  const systemPrompt = params.useV2
    ? buildHolderResearchSystemPromptV2()
    : buildHolderResearchSystemPrompt();
  const userPrompt = params.useV2
    ? buildHolderResearchUserPromptV2({ candidateJson, allowedEvidenceIds })
    : buildHolderResearchUserPrompt({ candidateJson, allowedEvidenceIds });
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
    const parsedOutput = params.useV2
      ? parseHolderResearchFinalOutputV2(parsedJson)
      : parseHolderResearchAgentOutputV1(parsedJson);
    assertHolderResearchEvidenceIdsAllowed(
      parsedOutput.evidence_ids,
      allowedEvidenceIds,
    );
    const output = params.useV2
      ? adaptHolderResearchFinalOutputV2({
          candidate: params.candidate,
          output: parsedOutput as ReturnType<
            typeof parseHolderResearchFinalOutputV2
          >,
          externalResearch: externalResearchV2,
          policy: params.policy,
        })
      : (parsedOutput as HolderResearchAgentOutputV1);
    assertHolderResearchEvidenceIdsAllowed(
      output.evidence_ids,
      params.candidate.evidence.map((evidence) => evidence.id),
    );

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
        mode: params.useV2 ? "openrouter_v2" : "openrouter_v1",
        final_v2:
          params.useV2 && "verdict" in parsedOutput
            ? {
                verdict: parsedOutput.verdict,
                evidence_assessment: parsedOutput.evidence_assessment,
                reason_codes: parsedOutput.reason_codes,
              }
            : null,
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

function buildHolderResearchModelErrorDecision(input: {
  candidate: HolderResearchCandidate;
  error: unknown;
  externalResearch: ExternalResearchResult | null;
  policy: HolderResearchPolicy;
}): HolderResearchModelDecision {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  const evidenceId =
    input.candidate.evidence[0]?.id ??
    `market:${input.candidate.market.marketId}`;
  return {
    candidate: input.candidate,
    output: {
      version: "holder_research_v1",
      status: "SKIP",
      bucket: input.candidate.bucket,
      confidence: 0,
      signal_type: "update",
      direction: "mixed",
      headline: "Holder research model failed",
      summary:
        "The model response could not be parsed, so this candidate was skipped instead of publishing an incomplete signal.",
      rationale:
        "Model synthesis failed; candidate skipped without publishing.",
      execution_priority: "normal",
      execution_priority_reason: "",
      evidence_ids: [evidenceId],
      caveats: ["No user-facing signal was produced for this run."],
    },
    cost: estimatedFailedModelCost(input.policy),
    modelMeta: {
      model: input.policy.model,
      external_research: input.externalResearch,
      mode: "openrouter_error",
      error: message.slice(0, 500),
      estimated_cost_usd: input.policy.estimatedCallCostUsd,
      charged_cost_usd: input.policy.estimatedCallCostUsd,
    },
  };
}

async function synthesizeCandidate(params: {
  candidate: HolderResearchCandidate;
  policy: HolderResearchPolicy;
  callModel: boolean;
  externalResearch: ExternalResearchResult | null;
  useV2: boolean;
}): Promise<HolderResearchModelDecision> {
  if (params.callModel) {
    try {
      return await callHolderResearchModel({
        candidate: params.candidate,
        policy: params.policy,
        externalResearch: params.externalResearch,
        useV2: params.useV2,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("OPENROUTER_API_KEY missing") ||
        message.startsWith("OpenRouter 401") ||
        message.startsWith("OpenRouter 403")
      ) {
        throw error;
      }
      console.warn("[holder-research] model synthesis failed", {
        key: params.candidate.key,
        error: message,
      });
      return buildHolderResearchModelErrorDecision({
        candidate: params.candidate,
        error,
        externalResearch: params.externalResearch,
        policy: params.policy,
      });
    }
  }

  const externalResearchV2 = canonicalExternalResearchV2(
    params.externalResearch,
  );
  const candidateJson = params.useV2
    ? buildHolderResearchCandidatePromptJsonV2(
        params.candidate,
        params.policy,
        externalResearchV2,
      )
    : {
        ...buildHolderResearchCandidatePromptJson(
          params.candidate,
          params.policy,
        ),
        externalResearch: params.externalResearch,
      };
  const systemPrompt = params.useV2
    ? buildHolderResearchSystemPromptV2()
    : buildHolderResearchSystemPrompt();
  const allowedEvidenceIds = params.useV2
    ? listHolderResearchPromptEvidenceIdsV2(params.candidate, params.policy)
    : params.candidate.evidence.map((evidence) => evidence.id);
  const userPrompt = params.useV2
    ? buildHolderResearchUserPromptV2({ candidateJson, allowedEvidenceIds })
    : buildHolderResearchUserPrompt({ candidateJson, allowedEvidenceIds });
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
      mode: params.useV2
        ? "deterministic_dry_run_v2_prompt"
        : "deterministic_dry_run_v1_prompt",
      estimated_cost_usd: cost.estimatedCostUsd,
      charged_cost_usd: 0,
      pricing_known: getOpenRouterModelPricingPerM(params.policy.model) != null,
    },
  };
}

function buildSelectionPolicy(
  policy: HolderResearchPolicy,
): HolderResearchPolicy {
  if (!policy.decisionCacheEnabled && !policy.triageEnabled) return policy;
  const triageLookahead = policy.triageEnabled
    ? policy.triageBatchSize * policy.triageMaxBatchesPerRun
    : policy.maxCandidatesPerRun;
  const lookaheadLimit = Math.min(
    policy.maxCandidatePool,
    Math.max(policy.maxCandidatesPerRun, triageLookahead) +
      policy.maxAgentCallsPerRun * 2,
  );
  return {
    ...policy,
    maxAgentCallsPerRun: lookaheadLimit,
    maxCandidatesPerRun: lookaheadLimit,
  };
}

async function applyFreshPriceChecksToCandidates(params: {
  candidates: HolderResearchCandidate[];
  client: {
    query<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
  };
  policy: HolderResearchPolicy;
  redis: PriceRefreshRedis | null | undefined;
}): Promise<{
  candidates: HolderResearchCandidate[];
  detail: string;
  status: "ok" | "skipped" | "error";
}> {
  if (!params.policy.livePriceCheckEnabled) {
    return {
      candidates: params.candidates,
      detail: "policy disabled",
      status: "skipped",
    };
  }
  if (params.candidates.length === 0) {
    return {
      candidates: params.candidates,
      detail: "no candidates",
      status: "skipped",
    };
  }
  const checkedAt = new Date();
  const candidatesToCheck = params.candidates.slice(
    0,
    params.policy.livePriceCheckMaxCandidatesPerRun,
  );
  try {
    const result = await requestFreshMarketPrices({
      db: params.client,
      enqueue: Boolean(params.redis),
      marketIds: candidatesToCheck.map(
        (candidate) => candidate.market.marketId,
      ),
      maxBuyPrice: params.policy.livePriceMaxBuyPrice,
      maxFreshAgeMs: HOLDER_RESEARCH_LIVE_PRICE_MAX_FRESH_AGE_MS,
      maxTokens: candidatesToCheck.length * 2,
      minFreshAt: checkedAt,
      pollMs: params.policy.livePriceCheckPollMs,
      priority: "high",
      redis: params.redis ?? null,
      terminalPp: params.policy.livePriceTerminalPp,
      timeoutMs: params.policy.livePriceCheckTimeoutMs,
    });
    const checkedCandidates = applyHolderResearchLivePriceChecks(
      candidatesToCheck,
      {
        checkedAt,
        marketStates: result.marketStates,
      },
    );
    const checkedByKey = new Map(
      checkedCandidates.map((candidate) => [candidate.key, candidate]),
    );
    const candidates = params.candidates.map(
      (candidate) => checkedByKey.get(candidate.key) ?? candidate,
    );
    const priceGuardBlocked = checkedCandidates.filter((candidate) => {
      if (!candidate.side) return false;
      return (
        (candidate.market.livePriceCheck?.blockersBySide[candidate.side]
          .length ?? 0) > 0
      );
    }).length;
    return {
      candidates,
      detail: [
        `requested=${result.requestedTokenIds.length}`,
        `fresh=${result.freshTokenIds.length}`,
        `maxAgeMs=${HOLDER_RESEARCH_LIVE_PRICE_MAX_FRESH_AGE_MS}`,
        `markets=${result.marketStates.size}`,
        `enqueued=${result.enqueued}`,
        `blocked=${priceGuardBlocked}`,
        `timedOut=${result.timedOut ? 1 : 0}`,
      ].join(" "),
      status: "ok",
    };
  } catch (error) {
    console.warn("[holder-research] live_price_check skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      candidates: params.candidates,
      detail: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }
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

async function maybeWriteDecisionCache(params: {
  redis: HolderResearchDecisionCacheRedis | null | undefined;
  policy: HolderResearchPolicy;
  callModel: boolean;
  candidate: HolderResearchCandidate;
  output: Pick<HolderResearchAgentOutputV1, "rationale" | "status">;
  decisionCache: HolderResearchDecisionCacheStats;
}): Promise<void> {
  if (
    !params.policy.decisionCacheEnabled ||
    !params.redis ||
    params.policy.dryRun ||
    !params.callModel
  ) {
    return;
  }

  try {
    const cacheRecord = buildHolderResearchDecisionCacheRecord({
      candidate: params.candidate,
      output: params.output,
      model: params.policy.model,
      policy: params.policy,
    });
    await params.redis.set(
      buildHolderResearchDecisionCacheKey(params.candidate.thesisKey),
      JSON.stringify(cacheRecord),
      { EX: params.policy.decisionCacheTtlHours * 3_600 },
    );
    params.decisionCache.written += 1;
  } catch (error) {
    params.decisionCache.status = "error";
    params.decisionCache.errors += 1;
    console.warn("[holder-research] decision_cache write skipped", {
      key: params.candidate.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function triageCacheOutput(
  decision: HolderResearchTriageDecision,
): Pick<HolderResearchAgentOutputV1, "rationale" | "status"> {
  return {
    status: decision.action === "skip" ? "SKIP" : "CONTEXT",
    rationale: decision.reason,
  };
}

export async function runHolderResearch(
  args: HolderResearchRunArgs = parseHolderResearchRunArgs(
    process.argv.slice(2),
  ),
  options: HolderResearchRunOptions = {},
): Promise<HolderResearchRunReport> {
  const startedAt = Date.now();
  const observedAt = new Date();
  const runId = `holder_research:${observedAt.toISOString()}:${randomUUID()}`;
  const policyResult = await resolveHolderResearchPolicy(pool);
  const walletIntelPolicyResult = await resolveWalletIntelRefreshPolicy(pool);
  const policy = withPolicyOverrides(policyResult.effective, args);
  const observeV2 = policy.pipelineV2Mode !== "off";
  const useV2Triage =
    policy.pipelineV2Mode === "triage" ||
    policy.pipelineV2Mode === "research" ||
    policy.pipelineV2Mode === "active";
  const useV2Research =
    policy.pipelineV2Mode === "research" || policy.pipelineV2Mode === "active";
  const useV2Final = policy.pipelineV2Mode === "active";
  const mmThresholds = {
    whaleUsd: walletIntelPolicyResult.effective.whaleUsd,
    whaleUsdSolana: walletIntelPolicyResult.effective.whaleUsdSolana,
  };
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
    const candidates = await loadHolderResearchCandidates(
      client,
      policy,
      mmThresholds,
    );
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
    const selectedWithTypeMetrics = await enrichHolderResearchMarketTypeMetrics(
      client,
      selectedWithContext,
    );
    let observationPool: HolderResearchObservationCandidate[] = [];
    let priceCheckCandidates = selectedWithTypeMetrics;
    if (observeV2 && !policy.dryRun) {
      observationPool = buildHolderResearchObservationPool({
        candidates,
        requiredCandidates: selectedWithTypeMetrics.slice(
          0,
          policy.livePriceCheckMaxCandidatesPerRun,
        ),
        policy,
        limit: policy.livePriceCheckMaxCandidatesPerRun,
      });
      let observationCandidates = observationPool.map(
        (entry) => entry.candidate,
      );
      try {
        observationCandidates = await enrichHolderResearchFirstObservedActivity(
          client,
          observationCandidates,
          policy,
          observedAt,
        );
      } catch (error) {
        console.warn(
          "[holder-research] first observed activity enrichment skipped",
          {
            candidates: observationCandidates.length,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      const rankByThesis = new Map(
        observationPool.map((entry) => [
          entry.candidate.thesisKey,
          entry.candidateRank,
        ]),
      );
      observationPool = observationCandidates.map((candidate) => ({
        candidate,
        candidateRank:
          rankByThesis.get(candidate.thesisKey) ?? Number.MAX_SAFE_INTEGER,
      }));
      priceCheckCandidates = observationCandidates;
    }
    const priceCheck = await applyFreshPriceChecksToCandidates({
      candidates: priceCheckCandidates,
      client,
      policy,
      redis: options.priceRefreshRedis,
    });
    const freshByThesis = new Map(
      priceCheck.candidates.map((candidate) => [
        candidate.thesisKey,
        candidate,
      ]),
    );
    const selectedWithFreshPrices = selectedWithTypeMetrics.map(
      (candidate) => freshByThesis.get(candidate.thesisKey) ?? candidate,
    );
    if (observationPool.length > 0) {
      observationPool = observationPool.map((entry) => ({
        ...entry,
        candidate:
          freshByThesis.get(entry.candidate.thesisKey) ?? entry.candidate,
      }));
    }
    const selectionDiagnostics = buildHolderResearchSelectionDiagnostics(
      candidates,
      selectedWithFreshPrices,
      selectionPolicy,
    );
    if (observeV2 && !policy.dryRun) {
      try {
        const observationWrite =
          await persistHolderResearchCandidateObservations(client, {
            runId,
            observedAt,
            observations: observationPool,
            policy,
          });
        const supplyHealth = await loadHolderResearchSupplyHealth(
          client,
          observedAt,
        );
        const pruned = await pruneHolderResearchCandidateObservations(client);
        toolCalls.push({
          name: "candidate_observations_v2",
          count: observationWrite.written,
          status: "ok",
          detail: `mode=${policy.pipelineV2Mode} median7d=${supplyHealth.medianCandidatesPerDay} zeroDays=${supplyHealth.consecutiveZeroDays} healthy=${supplyHealth.healthy} pruned=${pruned.deleted}`,
        });
        if (!supplyHealth.healthy) {
          console.warn("[holder-research] candidate supply health degraded", {
            medianCandidatesPerDay: supplyHealth.medianCandidatesPerDay,
            consecutiveZeroDays: supplyHealth.consecutiveZeroDays,
            days: supplyHealth.days,
          });
        }
      } catch (error) {
        toolCalls.push({
          name: "candidate_observations_v2",
          count: 0,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
        console.warn("[holder-research] candidate observations unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      toolCalls.push({
        name: "candidate_observations_v2",
        count: 0,
        status: "skipped",
        detail: policy.dryRun
          ? "dry-run does not write telemetry"
          : "pipelineV2Mode=off",
      });
    }
    const calibrationMemo = policy.calibrationMemoEnabled
      ? await loadHolderResearchCalibrationMemo(client, policy)
      : [];
    toolCalls.push({
      name: "candidate_selection",
      count: selectionDiagnostics.selectedForTriage,
      status: "ok",
      detail: [
        `primary=${selectionDiagnostics.primaryEligible}/${selectionDiagnostics.loaded}`,
        `supportOnly=${selectionDiagnostics.supportOnly}`,
        `expiryBoosted=${selectionDiagnostics.expiryBoosted}`,
        `blocked=${Object.entries(selectionDiagnostics.blockedByReason)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(",")}`,
      ].join(" "),
    });
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
    toolCalls.push({
      name: "market_type_metrics",
      count: selectedWithFreshPrices.reduce(
        (sum, candidate) =>
          sum +
          candidate.market.holders.filter(
            (holder) => holder.marketTypeMetrics30d != null,
          ).length,
        0,
      ),
      status: "ok",
    });
    toolCalls.push({
      name: "live_price_check",
      count: priceCheckCandidates.length,
      status: priceCheck.status,
      detail: `${priceCheck.detail} selected=${selectedWithFreshPrices.length}`,
    });
    toolCalls.push({
      name: "calibration_memo",
      count: calibrationMemo.length,
      status: policy.calibrationMemoEnabled ? "ok" : "skipped",
      detail:
        calibrationMemo.length > 0
          ? calibrationMemo.join(" ")
          : policy.calibrationMemoEnabled
            ? "no evaluated notes yet"
            : "policy disabled",
    });

    const decisions: HolderResearchModelDecision[] = [];
    const externalResearchByKey = new Map<string, ExternalResearchResult>();
    const triageDecisions: HolderResearchRunReport["triageDecisions"] = [];
    const triageByKey = new Map<string, HolderResearchTriageDecision>();
    const triage = {
      enabled: policy.triageEnabled,
      status: "skipped" as "ok" | "skipped" | "error",
      calls: 0,
      investigate: 0,
      watch: 0,
      skip: 0,
      errors: 0,
      fallback: 0,
    };
    const triageErrors: HolderResearchRunReport["triageErrors"] = [];
    let triageCost = zeroCost();
    let externalSearchCalls = 0;

    const cacheEligibleCandidates: HolderResearchCandidate[] = [];
    for (const candidate of selectedWithFreshPrices) {
      let cacheEvaluation: HolderResearchDecisionCacheEvaluation | null = null;
      if (policy.decisionCacheEnabled && options.decisionCacheRedis) {
        decisionCache.checked += 1;
        const cacheKey = buildHolderResearchDecisionCacheKey(
          candidate.thesisKey,
        );
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
      cacheEligibleCandidates.push(
        applyHolderResearchPreviousDecisionContext(candidate, cacheEvaluation),
      );
    }

    const finalCandidates: HolderResearchCandidate[] = [];
    const triageCanRun =
      policy.triageEnabled &&
      args.callModel &&
      cacheEligibleCandidates.length > 0;
    if (triageCanRun) {
      triage.status = "ok";
      for (
        let batchIndex = 0;
        batchIndex < policy.triageMaxBatchesPerRun &&
        finalCandidates.length < policy.maxAgentCallsPerRun;
        batchIndex += 1
      ) {
        const offset = batchIndex * policy.triageBatchSize;
        const batch = cacheEligibleCandidates.slice(
          offset,
          offset + policy.triageBatchSize,
        );
        if (batch.length === 0) break;

        let result: HolderResearchTriageModelResult;
        try {
          result = await callHolderResearchTriageModel({
            candidates: batch,
            policy,
            maxInvestigate: policy.maxAgentCallsPerRun - finalCandidates.length,
            calibrationMemo,
            useV2: useV2Triage,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            message.includes("OPENROUTER_API_KEY missing") ||
            message.startsWith("OpenRouter ")
          ) {
            throw error;
          }
          triage.status = "error";
          triage.errors += 1;
          const fallbackCandidates =
            selectHolderResearchTriageFallbackCandidates(
              batch,
              policy.maxAgentCallsPerRun - finalCandidates.length,
            );
          for (const candidate of fallbackCandidates) {
            const triageDecision: HolderResearchTriageDecision = {
              key: candidate.key,
              action: "investigate",
              reason_codes: ["research_needed"],
              research_need: "market_context",
              reason: "Deterministic fallback after triage error.",
              legacyPriority: 1,
            };
            triageByKey.set(candidate.key, triageDecision);
            triageDecisions.push({
              key: triageDecision.key,
              action: triageDecision.action,
              priority: triageDecision.legacyPriority ?? null,
              reasonCodes: triageDecision.reason_codes,
              researchNeed: triageDecision.research_need,
              reason: triageDecision.reason,
            });
            finalCandidates.push(candidate);
            triage.investigate += 1;
            triage.fallback += 1;
          }
          triageErrors.push({
            batchIndex,
            error: message,
            contentLength:
              error instanceof HolderResearchTriageParseError
                ? error.contentLength
                : null,
            finishReason:
              error instanceof HolderResearchTriageParseError
                ? error.finishReason
                : null,
            fallback: fallbackCandidates.length,
          });
          console.warn("[holder-research] triage failed", {
            batchIndex,
            error: message,
            contentLength:
              error instanceof HolderResearchTriageParseError
                ? error.contentLength
                : null,
            finishReason:
              error instanceof HolderResearchTriageParseError
                ? error.finishReason
                : null,
            fallback: fallbackCandidates.length,
          });
          continue;
        }
        triage.calls += 1;
        triageCost = addResolvedCosts(triageCost, result.cost);

        const decisionsByKey = new Map(
          result.decisions.map((decision) => [decision.key, decision]),
        );
        const eligibleInvestigations: Array<{
          candidate: HolderResearchCandidate;
          decision: HolderResearchTriageDecision;
        }> = [];
        for (const candidate of batch) {
          const triageDecision = decisionsByKey.get(candidate.key);
          if (!triageDecision) continue;
          triageByKey.set(candidate.key, triageDecision);
          triageDecisions.push({
            key: triageDecision.key,
            action: triageDecision.action,
            priority: triageDecision.legacyPriority ?? null,
            reasonCodes: triageDecision.reason_codes,
            researchNeed: triageDecision.research_need,
            reason: triageDecision.reason,
          });
          if (
            triageDecision.action === "investigate" &&
            (useV2Triage ||
              (triageDecision.legacyPriority ?? 0) >=
                policy.minTriageInvestigatePriority)
          ) {
            eligibleInvestigations.push({
              candidate,
              decision: triageDecision,
            });
            continue;
          }
          if (triageDecision.action === "skip") {
            triage.skip += 1;
          } else {
            triage.watch += 1;
          }
          await maybeWriteDecisionCache({
            redis: options.decisionCacheRedis,
            policy,
            callModel: args.callModel,
            candidate,
            output: triageCacheOutput(triageDecision),
            decisionCache,
          });
        }
        const remainingBudget = Math.max(
          0,
          policy.maxAgentCallsPerRun - finalCandidates.length,
        );
        const selectedInvestigations = selectHolderResearchTriageInvestigations(
          eligibleInvestigations,
          {
            limit: remainingBudget,
            useV2: useV2Triage,
          },
        );
        for (const { candidate } of selectedInvestigations) {
          finalCandidates.push(candidate);
          triage.investigate += 1;
        }
      }
    } else {
      finalCandidates.push(
        ...cacheEligibleCandidates.slice(0, policy.maxAgentCallsPerRun),
      );
    }

    let publishCount = 0;
    let consecutiveSkips = 0;
    for (const selectedCandidate of finalCandidates) {
      if (decisions.length >= policy.maxAgentCallsPerRun) break;
      if (publishCount >= policy.maxPublishPerRun) break;
      if (consecutiveSkips >= policy.maxConsecutiveSkips) break;

      const finalPriceCheck = args.callModel
        ? await applyFreshPriceChecksToCandidates({
            candidates: [selectedCandidate],
            client,
            policy,
            redis: options.priceRefreshRedis,
          })
        : {
            candidates: [selectedCandidate],
            detail: "callModel=false",
            status: "skipped" as const,
          };
      toolCalls.push({
        name: "live_price_final_check",
        count: 1,
        status: finalPriceCheck.status,
        detail: finalPriceCheck.detail,
      });
      const candidate = finalPriceCheck.candidates[0] ?? selectedCandidate;
      const finalPriceBlockers = candidate.side
        ? (candidate.market.livePriceCheck?.blockersBySide[candidate.side] ??
          [])
        : [];
      if (policy.livePriceCheckEnabled && finalPriceBlockers.length > 0) {
        const output = buildDeterministicHolderResearchDecision(
          candidate,
          policy,
        );
        output.status = "SKIP";
        output.rationale = `Skipped before synthesis because current price state is not actionable: ${finalPriceBlockers.join(", ")}.`;
        output.caveats = [
          `Current price state blocked this signal: ${finalPriceBlockers.join(", ")}.`,
        ];
        const decision: HolderResearchModelDecision = {
          candidate,
          cost: zeroCost(),
          modelMeta: {
            live_price_guard: {
              blockers: finalPriceBlockers,
              detail: finalPriceCheck.detail,
            },
          },
          output,
        };
        decisions.push(decision);
        await maybeWriteDecisionCache({
          redis: options.decisionCacheRedis,
          policy,
          callModel: args.callModel,
          candidate,
          output: decision.output,
          decisionCache,
        });
        consecutiveSkips += 1;
        continue;
      }

      const triageDecision = triageByKey.get(candidate.key);
      const researchNeed = triageDecision?.research_need ?? "none";
      let externalResearch: ExternalResearchResult | null = null;
      if (
        policy.externalSearchEnabled &&
        externalSearchCalls < policy.maxExternalSearchCallsPerRun &&
        (policy.forceExternalSearchForInvestigations || researchNeed !== "none")
      ) {
        externalResearch = await runExternalResearch({
          candidate,
          policy,
          dryRun: policy.dryRun,
          researchNeed,
          useV2: useV2Research,
        });
        if (
          externalResearch.status !== "skipped" ||
          externalResearch.costUsd > 0
        ) {
          externalSearchCalls += 1;
        }
        externalResearchByKey.set(candidate.key, externalResearch);
      }

      const rawDecision = await synthesizeCandidate({
        candidate,
        policy,
        callModel: args.callModel,
        externalResearch,
        useV2: useV2Final,
      });
      const gatedOutput = applyHolderResearchPublishQualityGate({
        candidate,
        output: rawDecision.output,
        policy,
        publishedRunDecisions: decisions
          .filter((decision) => decision.output.status === "PUBLISH")
          .map((decision) => ({
            candidate: decision.candidate,
            output: decision.output,
          })),
      });
      const decision: HolderResearchModelDecision = {
        ...rawDecision,
        output: gatedOutput,
        modelMeta:
          gatedOutput === rawDecision.output
            ? {
                ...rawDecision.modelMeta,
                triage: triageDecision ?? null,
              }
            : {
                ...rawDecision.modelMeta,
                triage: triageDecision ?? null,
                publish_quality_gate: {
                  originalStatus: rawDecision.output.status,
                  originalRationale: rawDecision.output.rationale,
                  gatedStatus: gatedOutput.status,
                  gatedRationale: gatedOutput.rationale,
                },
              },
      };
      decisions.push(decision);
      await maybeWriteDecisionCache({
        redis: options.decisionCacheRedis,
        policy,
        callModel: args.callModel,
        candidate,
        output: decision.output,
        decisionCache,
      });
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
      name: "triage",
      count: triage.calls,
      status: triage.status,
      detail: policy.triageEnabled
        ? args.callModel
          ? `investigate=${triage.investigate} watch=${triage.watch} skip=${triage.skip} fallback=${triage.fallback} errors=${triage.errors}`
          : "callModel=false"
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

    if (observeV2 && !policy.dryRun) {
      try {
        const updateByThesis = new Map<
          string,
          HolderResearchObservationStageUpdate
        >();
        const selectedByKey = new Map(
          selectedWithFreshPrices.map((candidate) => [
            candidate.key,
            candidate,
          ]),
        );
        for (const candidate of selectedWithFreshPrices) {
          updateByThesis.set(candidate.thesisKey, {
            thesisKey: candidate.thesisKey,
          });
        }
        for (const [candidateKey, triageDecision] of triageByKey) {
          const candidate = selectedByKey.get(candidateKey);
          if (!candidate) continue;
          updateByThesis.set(candidate.thesisKey, {
            ...updateByThesis.get(candidate.thesisKey),
            thesisKey: candidate.thesisKey,
            triageAction: triageDecision.action,
          });
        }
        for (const [candidateKey, research] of externalResearchByKey) {
          const candidate = selectedByKey.get(candidateKey);
          if (!candidate) continue;
          updateByThesis.set(candidate.thesisKey, {
            ...updateByThesis.get(candidate.thesisKey),
            thesisKey: candidate.thesisKey,
            researchVerdict: research.verdict,
          });
        }
        for (const decision of decisions) {
          updateByThesis.set(decision.candidate.thesisKey, {
            ...updateByThesis.get(decision.candidate.thesisKey),
            thesisKey: decision.candidate.thesisKey,
            finalVerdict:
              decision.output.status === "PUBLISH"
                ? "publish"
                : decision.output.status === "CONTEXT"
                  ? "context"
                  : "skip",
          });
        }
        const stageUpdate = await updateHolderResearchObservationStages(
          client,
          {
            runId,
            updates: Array.from(updateByThesis.values()),
          },
        );
        toolCalls.push({
          name: "candidate_observation_stages_v2",
          count: stageUpdate.updated,
          status: "ok",
        });
      } catch (error) {
        toolCalls.push({
          name: "candidate_observation_stages_v2",
          count: 0,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let persistence: HolderResearchRunReport["persistence"] = null;
    const shouldPersist =
      !policy.dryRun && policy.persistNotes && args.callModel;
    if (shouldPersist) {
      persistence = await persistHolderResearchNotes(client, {
        runnerRunId: runId,
        policy,
        decisions: decisions.map<HolderResearchPersistDecision>((decision) => ({
          candidate: decision.candidate,
          output: decision.output,
          modelMeta: decision.modelMeta,
        })),
      });
      if (observeV2) {
        try {
          await linkHolderResearchObservationNotes(client, runId);
        } catch (error) {
          console.warn("[holder-research] observation note link skipped", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    toolCalls.push({
      name: "note_persistence",
      count: persistence?.persisted ?? 0,
      status: shouldPersist ? "ok" : "skipped",
      detail: shouldPersist
        ? undefined
        : "dry-run, persistNotes=false, or callModel=false",
    });

    let resolvedEvaluation: HolderResearchRunReport["resolvedEvaluation"] =
      null;
    const shouldEvaluateResolved =
      policy.resolvedEvaluationEnabled && shouldPersist;
    if (shouldEvaluateResolved) {
      resolvedEvaluation = await evaluateResolvedHolderResearchNotes(
        client,
        policy,
      );
    }
    toolCalls.push({
      name: "resolved_signal_evaluator",
      count: resolvedEvaluation?.evaluated ?? 0,
      status: shouldEvaluateResolved ? "ok" : "skipped",
      detail: shouldEvaluateResolved
        ? `considered=${resolvedEvaluation?.considered ?? 0} correct=${resolvedEvaluation?.correct ?? 0} wrong=${resolvedEvaluation?.wrong ?? 0} unknown=${resolvedEvaluation?.unknown ?? 0} errors=${resolvedEvaluation?.errors ?? 0}`
        : "dry-run, persistNotes=false, callModel=false, or policy disabled",
    });

    let performanceAudit: HolderResearchRunReport["performanceAudit"] = null;
    const shouldAuditPerformance =
      policy.performanceAuditEnabled && shouldPersist;
    if (shouldAuditPerformance) {
      const auditResult = await auditHolderResearchSignalPerformance(client, {
        lookbackHours: policy.performanceAuditLookbackHours,
        limit: policy.performanceAuditMaxNotesPerRun,
        persist: true,
        includeOpen: policy.performanceAuditIncludeOpen,
        includeResolved: true,
        approxEntryBeforeHours: policy.performanceAuditApproxEntryBeforeHours,
        approxEntryAfterHours: policy.performanceAuditApproxEntryAfterHours,
      });
      performanceAudit = compactPerformanceAuditReport(
        auditResult,
        args.includePerformanceReport,
      );
    }
    toolCalls.push({
      name: "signal_performance_audit",
      count: performanceAudit?.evaluated ?? 0,
      status: shouldAuditPerformance ? "ok" : "skipped",
      detail: shouldAuditPerformance
        ? `considered=${performanceAudit?.considered ?? 0} written=${performanceAudit?.written ?? 0} open=${performanceAudit?.open ?? 0} resolved=${performanceAudit?.resolved ?? 0} correct=${performanceAudit?.correct ?? 0} wrong=${performanceAudit?.wrong ?? 0} missingEntry=${performanceAudit?.missingEntry ?? 0}`
        : "dry-run, persistNotes=false, callModel=false, or policy disabled",
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
    if (triageCost.providerCostUsd != null) {
      providerReportedCosts.push(triageCost.providerCostUsd);
    }

    const report: HolderResearchRunReport = {
      runId,
      dryRun: policy.dryRun,
      callModel: args.callModel,
      persistNotes: policy.persistNotes,
      model: policy.model,
      triageModel: policy.triageModel,
      policy: {
        enabled: policy.enabled,
        source: policyResult.source,
        pipelineV2Mode: policy.pipelineV2Mode,
        maxAgentCallsPerRun: policy.maxAgentCallsPerRun,
        maxPublishPerRun: policy.maxPublishPerRun,
        maxCandidatePool: policy.maxCandidatePool,
        externalSearchEnabled: policy.externalSearchEnabled,
        maxExternalSearchCallsPerRun: policy.maxExternalSearchCallsPerRun,
        forceExternalSearchForInvestigations:
          policy.forceExternalSearchForInvestigations,
        triageEnabled: policy.triageEnabled,
        triageModel: policy.triageModel,
        decisionCacheEnabled: policy.decisionCacheEnabled,
      },
      totals: {
        candidatesLoaded: candidates.length,
        selected: selectedWithTypeMetrics.length,
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
        triageEstimatedCostUsd: triageCost.estimatedCostUsd,
        triageChargedCostUsd: args.callModel ? triageCost.chargedCostUsd : 0,
        totalEstimatedCostUsd:
          estimatedCostUsd +
          externalSearchEstimatedCostUsd +
          triageCost.estimatedCostUsd,
        totalChargedCostUsd:
          chargedCostUsd +
          externalSearchChargedCostUsd +
          (args.callModel ? triageCost.chargedCostUsd : 0),
        providerReportedCostUsd:
          providerReportedCosts.length > 0
            ? providerReportedCosts.reduce((sum, cost) => sum + cost, 0)
            : null,
        durationMs: Date.now() - startedAt,
      },
      selection: selectionDiagnostics,
      toolCalls,
      decisionCache,
      decisionCacheSkipped,
      decisionCacheRechecked,
      triage,
      triageErrors,
      triageDecisions,
      selected: selectedWithTypeMetrics.map((candidate) => ({
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
        executionPriority: decision.output.execution_priority,
        executionPriorityReason: decision.output.execution_priority_reason,
        externalSearchStatus:
          externalResearchByKey.get(decision.candidate.key)?.status ??
          "skipped",
        externalSearchSummary:
          externalResearchByKey.get(decision.candidate.key)?.summary ?? null,
        externalSearchCitations:
          externalResearchByKey.get(decision.candidate.key)?.citations ?? [],
      })),
      persistence,
      resolvedEvaluation,
      performanceAudit,
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
  let redis: ReturnType<typeof createRedisClient> | null = null;
  try {
    redis = await connectHolderResearchCliRedis();
    await runHolderResearch(undefined, {
      decisionCacheRedis: redis,
      priceRefreshRedis: redis,
    });
  } finally {
    if (redis) await redis.quit().catch(() => undefined);
    await pool.end();
  }
}
