import {
  isAbortError,
  isRetryableHttpStatus,
  parseRetryAfterMs,
  sleep,
} from "@hunch/shared";

type Environment = Readonly<Record<string, string | undefined>>;

function intInRange(
  source: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(source[key]?.trim() ?? "");
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function loadWalletIntelRetryConfig(
  source: Environment = process.env,
): Readonly<{
  baseBackoffMs: number;
  maxAttempts: number;
  maxBackoffMs: number;
}> {
  return {
    maxAttempts: intInRange(source, "WALLET_INTEL_RETRY_MAX_ATTEMPTS", 3, 1, 6),
    baseBackoffMs: intInRange(
      source,
      "WALLET_INTEL_RETRY_BASE_BACKOFF_MS",
      250,
      10,
      60_000,
    ),
    maxBackoffMs: intInRange(
      source,
      "WALLET_INTEL_RETRY_MAX_BACKOFF_MS",
      2_000,
      10,
      120_000,
    ),
  };
}

export const walletIntelRetryConfig = loadWalletIntelRetryConfig();

export type WalletIntelRetryTelemetry = {
  source: string;
  attempted: number;
  succeeded: number;
  skipped: number;
  retried: number;
  failed: number;
  rateLimited: number;
  aborted: number;
  otherErrors: number;
  estimatedCalls: number;
  actualCalls: number;
};

export function createWalletIntelRetryTelemetry(
  source: string,
): WalletIntelRetryTelemetry {
  return {
    source,
    attempted: 0,
    succeeded: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
    rateLimited: 0,
    aborted: 0,
    otherErrors: 0,
    estimatedCalls: 0,
    actualCalls: 0,
  };
}

export function computeWalletIntelBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
): number {
  if (
    retryAfterMs != null &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return Math.min(
      retryAfterMs,
      Math.max(
        walletIntelRetryConfig.baseBackoffMs,
        walletIntelRetryConfig.maxBackoffMs,
      ),
    );
  }
  const exponential =
    walletIntelRetryConfig.baseBackoffMs *
    Math.max(1, 2 ** Math.max(0, attempt));
  return Math.min(exponential, walletIntelRetryConfig.maxBackoffMs);
}

export async function fetchWithWalletIntelRetry(inputs: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  allowRetry?: boolean;
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<Response> {
  const telemetry = inputs.telemetry ?? null;
  const maxAttempts = Math.max(1, walletIntelRetryConfig.maxAttempts);
  const allowRetry = inputs.allowRetry ?? true;

  if (telemetry) telemetry.attempted += 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);
    try {
      if (telemetry) telemetry.actualCalls += 1;
      const response = await fetch(inputs.url, {
        ...inputs.init,
        signal: controller.signal,
      });
      if (response.ok) {
        if (telemetry) telemetry.succeeded += 1;
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      const retryable =
        allowRetry &&
        attempt < maxAttempts - 1 &&
        isRetryableHttpStatus(response.status);
      if (response.status === 429 && telemetry) {
        telemetry.rateLimited += 1;
      }
      if (retryable) {
        if (telemetry) telemetry.retried += 1;
        await sleep(computeWalletIntelBackoffMs(attempt, retryAfterMs));
        continue;
      }
      if (telemetry) telemetry.failed += 1;
      return response;
    } catch (error) {
      const aborted = isAbortError(error);
      const retryable = allowRetry && attempt < maxAttempts - 1 && aborted;
      if (aborted && telemetry) {
        telemetry.aborted += 1;
      }
      if (retryable) {
        if (telemetry) telemetry.retried += 1;
        await sleep(computeWalletIntelBackoffMs(attempt, null));
        continue;
      }
      if (telemetry) {
        telemetry.failed += 1;
        if (!aborted) telemetry.otherErrors += 1;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("wallet-intel retry exhausted without result");
}
