import { setTimeout as delay } from "node:timers/promises";
import { parseEmbeddingVector, type EmbeddingGeneration } from "./contracts.js";
import { countEmbeddingTokens, embeddingTokenLimit } from "./text.js";

// Live admission probes observed E5 at $0.01/M and Qwen routes at $0.01–$0.04/M.
// Reserve twice the observed upper rate for accounting/routing differences.
// This is an estimate, not a provider price cap: higher actual charges still
// pause the worker through its cost-drift guard. Reserve before every attempt.
export const EMBEDDING_INPUT_USD_PER_MILLION = {
  "intfloat/e5-large-v2": 0.01,
  "qwen/qwen3-embedding-8b": 0.04,
} as const;
export function estimateEmbeddingCostUsd(
  texts: string[],
  generation: EmbeddingGeneration,
): number {
  return (
    (texts.reduce(
      (total, text) => total + countEmbeddingTokens(text, generation),
      0,
    ) *
      EMBEDDING_INPUT_USD_PER_MILLION[generation.model] *
      2) /
    1_000_000
  );
}
export class EmbeddingProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly breaker: boolean,
    public readonly retryAfterMs = 0,
    public readonly diagnostics: EmbeddingErrorDiagnostics = {},
  ) {
    super(`Embedding provider ${code}${status == null ? "" : ` (${status})`}`);
    this.name = "EmbeddingProviderError";
  }
}
export type EmbeddingErrorDiagnostics = {
  provider?: string;
  providerCode?: string;
  limitSource?: string;
  requestId?: string;
  rateLimit?: string;
  rateRemaining?: string;
  rateReset?: string;
  transportStatus?: number;
  errorType?: string;
  responseKind?: "json" | "non_json" | "truncated" | "unreadable";
  edgeTrace?: string;
};
function diagnostic(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-zA-Z0-9_. /:-]{1,100}$/.test(value) &&
    !value.includes("://")
    ? value
    : undefined;
}
function responseDiagnostics(
  body: Record<string, unknown> | null,
  response: Response,
  responseKind: EmbeddingErrorDiagnostics["responseKind"],
): { diagnostics: EmbeddingErrorDiagnostics; retryAfterMs: number } {
  const error = object(body?.error);
  const metadata = object(error?.metadata);
  const nestedHeaders = object(metadata?.headers);
  const header = (name: string): string | null => {
    const direct = response.headers.get(name);
    if (direct != null) return direct;
    const nested = Object.entries(nestedHeaders ?? {}).find(
      ([key]) => key.toLowerCase() === name,
    )?.[1];
    return typeof nested === "string" || typeof nested === "number"
      ? String(nested)
      : null;
  };
  return {
    retryAfterMs: retryAfter(header("retry-after")),
    diagnostics: {
      provider: diagnostic(metadata?.provider_name),
      providerCode: diagnostic(
        String(metadata?.provider_code ?? metadata?.provider_error_code ?? ""),
      ),
      limitSource: diagnostic(metadata?.limit_source),
      requestId: diagnostic(
        header("x-request-id") ??
          error?.request_id ??
          body?.request_id ??
          body?.id,
      ),
      rateLimit: diagnostic(header("x-ratelimit-limit")),
      rateRemaining: diagnostic(header("x-ratelimit-remaining")),
      rateReset: diagnostic(header("x-ratelimit-reset")),
      transportStatus: response.status,
      errorType: diagnostic(metadata?.error_type ?? error?.type),
      responseKind,
      edgeTrace: diagnostic(header("cf-ray")),
    },
  };
}
async function responseError(
  response: Response,
): Promise<EmbeddingProviderError> {
  let body: Record<string, unknown> | null = null;
  let kind: EmbeddingErrorDiagnostics["responseKind"] = "unreadable";
  const reader = response.body?.getReader();
  if (reader) {
    try {
      let text = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16384) break;
        text += decoder.decode(next.value, { stream: true });
      }
      if (bytes > 16384) kind = "truncated";
      else {
        try {
          body = object(JSON.parse(text + decoder.decode()));
          kind = body ? "json" : "non_json";
        } catch {
          kind = "non_json";
        }
      }
    } catch {
      /* Unreadable metadata must never hide the real HTTP status. */
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const normalized = responseDiagnostics(body, response, kind);
  return statusError(
    response.status,
    normalized.retryAfterMs,
    normalized.diagnostics,
  );
}
export type EmbeddingBatchResult = {
  embeddings: number[][];
  usage: { inputTokens: number | null; costUsd: number | null };
  attempts: number;
};
export type EmbeddingBatchOptions = {
  generation: EmbeddingGeneration;
  texts: string[];
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  maxAttempts?: number;
  beforeAttempt?: (info: {
    attempt: number;
    estimatedCostUsd: number;
  }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  // Metadata only. Observer failures must never retry or change paid execution.
  onAttempt?: (summary: {
    attempt: number;
    items: number;
    inputTokens: number;
    elapsedMs: number;
    outcome: "success" | "error";
    status: number | null;
    code?: string;
    diagnostics: EmbeddingErrorDiagnostics;
  }) => void;
};
function retryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  // Long Retry-After suspends the attempt rather than sleeping unboundedly.
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
function statusError(
  status: number,
  retryAfterMs = 0,
  diagnostics: EmbeddingErrorDiagnostics = {},
): EmbeddingProviderError {
  return new EmbeddingProviderError(
    "http_error",
    status,
    status === 408 || status === 429 || status >= 500,
    [401, 402, 403].includes(status),
    retryAfterMs,
    diagnostics,
  );
}
function malformed(): never {
  throw new EmbeddingProviderError("invalid_response", null, false, false);
}
function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function decodeResponse(
  value: unknown,
  generation: EmbeddingGeneration,
  count: number,
  retryAfterMs = 0,
  diagnostics: EmbeddingErrorDiagnostics = {},
): Omit<EmbeddingBatchResult, "attempts"> {
  const body = object(value);
  const bodyError = object(body?.error);
  if (bodyError) {
    const code = bodyError.code;
    if (
      typeof code === "number" &&
      Number.isInteger(code) &&
      code >= 400 &&
      code <= 599
    )
      throw statusError(code, retryAfterMs, diagnostics);
    malformed();
  }
  // Equal dimensions do not imply equal vector spaces. An omitted model is
  // supported for older provider responses; an explicit identity must match.
  // OpenRouter's Qwen embedding response uses the upstream canonical identity
  // (verified by the one-text adapter probe). This is an exact allowlist entry,
  // not case folding or permission to accept arbitrary revisions/model aliases.
  const matchesModel =
    body?.model === generation.model ||
    (generation.model === "qwen/qwen3-embedding-8b" &&
      body?.model === "Qwen/Qwen3-Embedding-8B");
  if (body && Object.hasOwn(body, "model") && !matchesModel) {
    throw new EmbeddingProviderError("model_mismatch", null, false, false);
  }
  if (!Array.isArray(body?.data) || body.data.length !== count) malformed();
  const embeddings = new Array<number[]>(count);
  const indices = new Set<number>();
  for (const item of body.data) {
    const row = object(item);
    const index = row?.index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      indices.has(index)
    )
      malformed();
    const vector = parseEmbeddingVector(row?.embedding, generation);
    if (!vector) malformed();
    const norm = Math.hypot(...vector);
    embeddings[index] = vector.map((value) => value / norm);
    indices.add(index);
  }
  const usage = object(body.usage);
  return {
    embeddings,
    usage: {
      inputTokens:
        nonnegative(usage?.prompt_tokens) ??
        nonnegative(usage?.input_tokens) ??
        nonnegative(usage?.total_tokens),
      costUsd: nonnegative(usage?.cost),
    },
  };
}

export async function fetchEmbeddingBatch(
  options: EmbeddingBatchOptions,
): Promise<EmbeddingBatchResult> {
  const { generation, texts } = options;
  if (!texts.length)
    return {
      embeddings: [],
      usage: { inputTokens: 0, costUsd: 0 },
      attempts: 0,
    };
  if (!options.apiKey.trim())
    throw new EmbeddingProviderError("missing_credentials", 401, false, true);
  if (
    texts.length > 128 ||
    texts.some(
      (text) =>
        !text.trim() ||
        countEmbeddingTokens(text, generation) >
          embeddingTokenLimit(generation),
    )
  ) {
    throw new EmbeddingProviderError("invalid_input", null, false, false);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error("Invalid embedding timeout");
  const attempts = options.maxAttempts ?? 4;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4)
    throw new Error("Embedding retries must be between one and four attempts");
  const estimatedCostUsd = estimateEmbeddingCostUsd(texts, generation);
  const inputTokens = texts.reduce(
    (n, text) => n + countEmbeddingTokens(text, generation),
    0,
  );
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Budget/lease errors must escape immediately, not become provider retries.
    await options.beforeAttempt?.({ attempt, estimatedCostUsd });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = Date.now();
    let responseInfo: EmbeddingErrorDiagnostics = {};
    const observe = (
      outcome: "success" | "error",
      attemptError?: EmbeddingProviderError,
    ) => {
      try {
        options.onAttempt?.({
          attempt,
          items: texts.length,
          inputTokens,
          elapsedMs: Date.now() - startedAt,
          outcome,
          status: attemptError?.status ?? responseInfo.transportStatus ?? null,
          code: attemptError?.code,
          diagnostics: { ...responseInfo, ...attemptError?.diagnostics },
        });
      } catch {
        /* Telemetry is never an execution or accounting dependency. */
      }
    };
    let error: EmbeddingProviderError;
    try {
      const response = await (options.fetch ?? fetch)(
        "https://openrouter.ai/api/v1/embeddings",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: generation.model,
            input: texts,
            encoding_format: "float",
            ...(generation.model === "qwen/qwen3-embedding-8b"
              ? {
                  dimensions: generation.dimensions,
                  provider: { require_parameters: true },
                }
              : {}),
          }),
        },
      );
      responseInfo = responseDiagnostics(
        null,
        response,
        "unreadable",
      ).diagnostics;
      if (!response.ok) {
        throw await responseError(response);
      }
      const body: unknown = await response.json();
      const normalized = responseDiagnostics(object(body), response, "json");
      responseInfo = normalized.diagnostics;
      const decoded = decodeResponse(
        body,
        generation,
        texts.length,
        normalized.retryAfterMs,
        normalized.diagnostics,
      );
      observe("success");
      return { ...decoded, attempts: attempt };
    } catch (caught) {
      error =
        caught instanceof EmbeddingProviderError
          ? caught
          : controller.signal.aborted
            ? new EmbeddingProviderError("timeout", null, true, false)
            : caught instanceof SyntaxError
              ? new EmbeddingProviderError(
                  "invalid_response",
                  null,
                  false,
                  false,
                )
              : new EmbeddingProviderError("network_error", null, true, false);
    } finally {
      clearTimeout(timeout);
    }
    observe("error", error);
    if (
      !error.retryable ||
      error.status === 429 ||
      attempt === attempts ||
      error.retryAfterMs > 30000
    )
      throw error;
    const sleepMs = Math.max(
      error.retryAfterMs,
      Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5),
    );
    await (options.sleep ?? delay)(sleepMs);
  }
  throw new Error("Unreachable embedding retry state");
}
