import { isRecord } from "../lib/type-guards.js";

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }
  try {
    const text = await res.text();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

export async function dflowRequest(inputs: {
  baseUrl: string;
  timeoutMs: number;
  method: "GET" | "POST";
  requestPath: string;
  apiKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; payload: unknown }> {
  const baseUrl = normalizeBaseUrl(inputs.baseUrl);
  const requestPath = inputs.requestPath.startsWith("/")
    ? inputs.requestPath
    : `/${inputs.requestPath}`;

  const params = new URLSearchParams();
  if (inputs.query) {
    for (const [key, value] of Object.entries(inputs.query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
  }

  const url = params.toString().length
    ? `${baseUrl}${requestPath}?${params.toString()}`
    : `${baseUrl}${requestPath}`;

  const bodyString =
    inputs.body === undefined ? undefined : JSON.stringify(inputs.body);

  const headers = new Headers({
    accept: "application/json",
    "user-agent": "Hunch-API/1.0",
  });

  if (inputs.apiKey && inputs.apiKey.trim().length > 0) {
    headers.set("x-api-key", inputs.apiKey.trim());
  }

  if (bodyString !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

  try {
    const res = await fetch(url, {
      method: inputs.method,
      headers,
      body: bodyString,
      signal: controller.signal,
    });

    const payload = await readJsonOrText(res);
    if (!res.ok) {
      return { ok: false, status: res.status, payload };
    }

    return { ok: true, payload };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractDflowErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const raw = payload.error ?? payload.message ?? payload.msg;
  if (typeof raw === "string" && raw.trim().length) return raw.trim();
  return null;
}

export function extractDflowErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const raw = payload.code ?? payload.errorCode ?? payload.error_code;
  if (typeof raw === "string" && raw.trim().length) return raw.trim();
  return null;
}

export function formatDflowUserMessage(payload: unknown): string | null {
  const code = extractDflowErrorCode(payload);
  if (code === "route_not_found") {
    return "No route available for this market right now. It may be closed or have no liquidity.";
  }

  const rawMessage = extractDflowErrorMessage(payload);
  if (!rawMessage) return null;
  if (rawMessage.toLowerCase().includes("route not found")) {
    return "No route available for this market right now. It may be closed or have no liquidity.";
  }
  return null;
}
