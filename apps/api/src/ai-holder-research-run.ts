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
import {
  buildHolderResearchSystemPrompt,
  buildHolderResearchTriageSystemPrompt,
  buildHolderResearchTriageUserPrompt,
  buildHolderResearchUserPrompt,
  parseHolderResearchAgentOutputV1,
  parseHolderResearchTriageOutputV1,
  type HolderResearchAgentOutputV1,
  type HolderResearchTriageOutputV1,
} from "./schemas/holder-research.js";
import {
  applyHolderResearchPreviousDecisionContext,
  applyHolderResearchLivePriceChecks,
  applyHolderResearchPublishQualityGate,
  buildDeterministicHolderResearchDecision,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchDecisionCacheKey,
  buildHolderResearchDecisionCacheRecord,
  buildHolderResearchExternalSearchInput,
  buildHolderResearchSelectionDiagnostics,
  buildHolderResearchTriageCandidatePromptJson,
  enrichHolderResearchHolderContext,
  enrichHolderResearchLivePositions,
  enrichHolderResearchMarketTypeMetrics,
  evaluateResolvedHolderResearchNotes,
  evaluateHolderResearchDecisionCache,
  loadHolderResearchCalibrationMemo,
  loadHolderResearchCandidates,
  parseHolderResearchCachedDecision,
  persistHolderResearchNotes,
  selectHolderResearchCandidates,
  type HolderResearchCandidate,
  type HolderResearchDecisionCacheEvaluation,
  type HolderResearchPersistDecision,
  type HolderResearchSelectionDiagnostics,
} from "./services/holder-research.js";
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

type HolderResearchTriageDecision =
  HolderResearchTriageOutputV1["decisions"][number];

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
  triageModel: string;
  policy: {
    enabled: boolean;
    source: "env" | "db";
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
    priority: number;
    needsExternalSearch: boolean;
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
  for (const match of text.matchAll(
    /\[(\[?\d+\]?|[^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
  )) {
    const rawTitle =
      match[1]?.replaceAll("[", "").replaceAll("]", "").trim() || null;
    const title = rawTitle && !/^\d+$/.test(rawTitle) ? rawTitle : null;
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

function stripExternalResearchSourceMarkup(text: string): string {
  return text
    .replace(/\[\[?\d+\]?\]\([^)]*$/g, "")
    .replace(/\[[^\]]+\]\(https?:\/\/[^)\s]*$/gi, "")
    .replace(/\[\[?\d+\]?\]\([^)]+\)/g, "")
    .replace(/\[(\d+)\]\(https?:\/\/[^)]+\)/gi, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[\[?\d+\]?\]?/g, "")
    .replace(/[*_`~>#]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function compactExternalResearchSummary(text: string): string {
  const cleaned = stripExternalResearchSourceMarkup(text);
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
              "You investigate public context for prediction-market holder signals. Use web_search and x_search. The holder data is intentionally redacted; do not ask for wallet identities. Return one short, plain sentence for a signal feed, not a news memo. Compare dated headlines/posts to the supplied holder activity/snapshot timing. Answer only: was the news already known, did it support the move, did it conflict with the move, or did it not explain it? Do not start with phrases like 'Public info', 'Public context', or 'Public news'. Do not use markdown, footnotes, bracket citations, or raw URLs in the text. Do not invent a catalyst.",
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
  choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const triageFallbackBucketRank = new Map<HolderResearchCandidate["bucket"], number>(
  [
    ["sharp_minority", 0],
    ["sharp_side", 1],
    ["followup_existing", 2],
  ],
);

const triageFallbackExcludedBuckets = new Set<HolderResearchCandidate["bucket"]>([
  "concentration_risk",
  "event_bridge",
  "recent_flow",
]);

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

async function callHolderResearchTriageModel(params: {
  candidates: HolderResearchCandidate[];
  policy: HolderResearchPolicy;
  maxInvestigate: number;
  calibrationMemo: string[];
}): Promise<HolderResearchTriageModelResult> {
  const candidateJson = params.candidates.map((candidate) =>
    buildHolderResearchTriageCandidatePromptJson(candidate, params.policy),
  );
  const systemPrompt = buildHolderResearchTriageSystemPrompt();
  const userPrompt = buildHolderResearchTriageUserPrompt({
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
    let output: HolderResearchTriageOutputV1;
    try {
      output = parseHolderResearchTriageModelContent(
        content,
        params.candidates.map((candidate) => candidate.key),
      );
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
      decisions: output.decisions,
      cost,
      modelMeta: {
        model: params.policy.triageModel,
        mode: "openrouter_triage",
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
}): Promise<HolderResearchModelDecision> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const candidateJson = {
    ...buildHolderResearchCandidatePromptJson(params.candidate, params.policy),
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
}): Promise<HolderResearchModelDecision> {
  if (params.callModel) {
    try {
      return await callHolderResearchModel({
        candidate: params.candidate,
        policy: params.policy,
        externalResearch: params.externalResearch,
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

  const candidateJson = {
    ...buildHolderResearchCandidatePromptJson(params.candidate, params.policy),
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
      marketIds: candidatesToCheck.map((candidate) => candidate.market.marketId),
      maxBuyPrice: params.policy.livePriceMaxBuyPrice,
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
        candidate.market.livePriceCheck?.blockersBySide[candidate.side]
          .length ?? 0
      ) > 0;
    }).length;
    return {
      candidates,
      detail: [
        `requested=${result.requestedTokenIds.length}`,
        `fresh=${result.freshTokenIds.length}`,
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
      buildHolderResearchDecisionCacheKey(params.candidate.key),
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
  args: HolderResearchRunArgs = parseHolderResearchRunArgs(process.argv.slice(2)),
  options: HolderResearchRunOptions = {},
): Promise<HolderResearchRunReport> {
  const startedAt = Date.now();
  const runId = `holder_research:${new Date().toISOString()}:${randomUUID()}`;
  const policyResult = await resolveHolderResearchPolicy(pool);
  const walletIntelPolicyResult = await resolveWalletIntelRefreshPolicy(pool);
  const policy = withPolicyOverrides(policyResult.effective, args);
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
    const selectedWithTypeMetrics =
      await enrichHolderResearchMarketTypeMetrics(client, selectedWithContext);
    const priceCheck = await applyFreshPriceChecksToCandidates({
      candidates: selectedWithTypeMetrics,
      client,
      policy,
      redis: options.priceRefreshRedis,
    });
    const selectedWithFreshPrices = priceCheck.candidates;
    const selectionDiagnostics = buildHolderResearchSelectionDiagnostics(
      candidates,
      selectedWithFreshPrices,
      selectionPolicy,
    );
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
      count: selectedWithFreshPrices.length,
      status: priceCheck.status,
      detail: priceCheck.detail,
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
              priority: 1,
              needs_external_search: true,
              reason: "Deterministic fallback after triage error.",
            };
            triageByKey.set(candidate.key, triageDecision);
            triageDecisions.push({
              key: triageDecision.key,
              action: triageDecision.action,
              priority: triageDecision.priority,
              needsExternalSearch: triageDecision.needs_external_search,
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
            priority: triageDecision.priority,
            needsExternalSearch: triageDecision.needs_external_search,
            reason: triageDecision.reason,
          });
          if (
            triageDecision.action === "investigate" &&
            triageDecision.priority >= policy.minTriageInvestigatePriority
          ) {
            eligibleInvestigations.push({ candidate, decision: triageDecision });
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
        const selectedInvestigations = eligibleInvestigations
          .sort((left, right) => right.decision.priority - left.decision.priority)
          .slice(0, remainingBudget);
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
      let externalResearch: ExternalResearchResult | null = null;
      if (
        policy.externalSearchEnabled &&
        externalSearchCalls < policy.maxExternalSearchCallsPerRun &&
        (policy.forceExternalSearchForInvestigations ||
          triageDecision == null ||
          triageDecision.needs_external_search)
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

      const rawDecision = await synthesizeCandidate({
        candidate,
        policy,
        callModel: args.callModel,
        externalResearch,
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
