import {
  Connection,
  type Commitment,
  type ConnectionConfig,
  type FetchFn,
} from "@solana/web3.js";
import {
  FetchRequest,
  JsonRpcProvider,
  type JsonRpcApiProviderOptions,
  type Networkish,
} from "ethers";

import {
  captureRpcDiagnosticSource,
  recordRpcAttempt,
  rpcDiagnosticOutcomeFromError,
} from "./rpc-diagnostics.js";

function rpcMethodLabel(body: unknown): string {
  let text: string | null = null;
  if (typeof body === "string") text = body;
  if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  if (!text) return "unknown";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      const methods = parsed.flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        "method" in entry &&
        typeof entry.method === "string"
          ? [entry.method]
          : [],
      );
      if (methods.length === 1) return methods[0] ?? "unknown";
      return `batch:${methods.length}`;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "method" in parsed &&
      typeof parsed.method === "string"
    ) {
      return parsed.method;
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

export function createEvmRpcProvider(
  rpcUrl: string,
  network?: Networkish,
  options?: JsonRpcApiProviderOptions,
  source = captureRpcDiagnosticSource(),
): JsonRpcProvider {
  const request = new FetchRequest(rpcUrl);
  const getUrl = FetchRequest.createGetUrlFunc();
  request.getUrlFunc = async (outgoing, signal) => {
    const startedAt = performance.now();
    const method = rpcMethodLabel(outgoing.body);
    try {
      const response = await getUrl(outgoing, signal);
      recordRpcAttempt({
        protocol: "evm",
        rpcUrl,
        method,
        source,
        outcome:
          response.statusCode === 429
            ? "http_429"
            : response.statusCode >= 400
              ? "http_error"
              : "ok",
        durationMs: performance.now() - startedAt,
      });
      return response;
    } catch (error) {
      recordRpcAttempt({
        protocol: "evm",
        rpcUrl,
        method,
        source,
        outcome: rpcDiagnosticOutcomeFromError(error),
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  };
  return new JsonRpcProvider(request, network, options);
}

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  return null;
}

export function createSolanaRpcConnection(
  rpcUrl: string,
  commitmentOrConfig?: Commitment | ConnectionConfig,
  source = captureRpcDiagnosticSource(),
): Connection {
  const baseConfig: ConnectionConfig =
    typeof commitmentOrConfig === "string"
      ? { commitment: commitmentOrConfig }
      : { ...(commitmentOrConfig ?? {}) };
  const configuredFetch = baseConfig.fetch;
  const instrumentedFetch: FetchFn = async (input, init) => {
    const startedAt = performance.now();
    const method = rpcMethodLabel(requestBody(init));
    try {
      const response = configuredFetch
        ? await configuredFetch(input, init)
        : await fetch(input, init);
      recordRpcAttempt({
        protocol: "solana",
        rpcUrl,
        method,
        source,
        outcome:
          response.status === 429
            ? "http_429"
            : response.status >= 400
              ? "http_error"
              : "ok",
        durationMs: performance.now() - startedAt,
      });
      return response;
    } catch (error) {
      recordRpcAttempt({
        protocol: "solana",
        rpcUrl,
        method,
        source,
        outcome: rpcDiagnosticOutcomeFromError(error),
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  };
  return new Connection(rpcUrl, { ...baseConfig, fetch: instrumentedFetch });
}
