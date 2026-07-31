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
import { isRpcRateLimit } from "@hunch/shared";

import {
  captureRpcDiagnosticSource,
  recordRpcAttempt,
  rpcDiagnosticOutcomeFromError,
  type RpcDiagnosticOutcome,
} from "./rpc-diagnostics.js";

function rpcErrorIsRateLimited(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 429
  ) {
    return true;
  }
  try {
    return isRpcRateLimit(JSON.stringify(error));
  } catch {
    return false;
  }
}

function jsonRpcEntryOutcome(entry: unknown): "ok" | "rpc_429" | "rpc_error" {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "rpc_error";
  }
  if ("error" in entry && entry.error != null) {
    return rpcErrorIsRateLimited(entry.error) ? "rpc_429" : "rpc_error";
  }
  return "result" in entry ? "ok" : "rpc_error";
}

export function rpcDiagnosticOutcomeFromJsonRpcResponse(
  status: number,
  payload: unknown,
): RpcDiagnosticOutcome {
  if (status === 429) return "http_429";
  if (status < 200 || status >= 300) return "http_error";
  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length === 0) return "rpc_error";
  const outcomes = entries.map(jsonRpcEntryOutcome);
  if (outcomes.includes("rpc_429")) return "rpc_429";
  if (outcomes.includes("rpc_error")) return "rpc_error";
  return "ok";
}

function evmResponseOutcome(
  response: Readonly<{
    statusCode: number;
    body: null | Uint8Array;
  }>,
): RpcDiagnosticOutcome {
  if (response.statusCode === 429) return "http_429";
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return "http_error";
  }
  try {
    return rpcDiagnosticOutcomeFromJsonRpcResponse(
      response.statusCode,
      JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())),
    );
  } catch {
    return "rpc_error";
  }
}

async function solanaResponseOutcome(
  response: Response,
): Promise<RpcDiagnosticOutcome> {
  if (response.status === 429) return "http_429";
  if (response.status < 200 || response.status >= 300) return "http_error";
  try {
    return rpcDiagnosticOutcomeFromJsonRpcResponse(
      response.status,
      await response.clone().json(),
    );
  } catch {
    return "rpc_error";
  }
}

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
        outcome: evmResponseOutcome(response),
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
        outcome: await solanaResponseOutcome(response),
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
