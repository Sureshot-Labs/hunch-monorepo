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

export async function acrossRequest(inputs: {
  baseUrl: string;
  timeoutMs: number;
  method: "GET" | "POST";
  requestPath: string;
  apiKey?: string;
  integratorId?: string;
  includeIntegratorId?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}): Promise<
  { ok: true; payload: unknown } | { ok: false; status: number; payload: unknown }
> {
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
  if (
    inputs.includeIntegratorId !== false &&
    inputs.integratorId?.trim() &&
    !params.has("integratorId")
  ) {
    params.set("integratorId", inputs.integratorId.trim());
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
  if (inputs.apiKey?.trim()) {
    headers.set("authorization", `Bearer ${inputs.apiKey.trim()}`);
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

export function extractAcrossErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim().length) {
    return payload.trim();
  }
  if (!isRecord(payload)) return null;

  const direct = payload.error ?? payload.message ?? payload.reason;
  if (typeof direct === "string" && direct.trim().length) {
    return direct.trim();
  }

  if (Array.isArray(payload.errors)) {
    const first = payload.errors.find(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    );
    if (typeof first === "string") return first.trim();
  }

  return null;
}

export function isAcrossFallbackableError(inputs: {
  status: number;
  payload: unknown;
}): boolean {
  const code =
    isRecord(inputs.payload) && typeof inputs.payload.code === "string"
      ? inputs.payload.code.trim().toLowerCase()
      : "";
  if (
    code.includes("app_fee") ||
    code.includes("integrator") ||
    code.includes("invalid_request")
  ) {
    return false;
  }

  if (inputs.status === 429 || inputs.status >= 500) return true;

  const message = (extractAcrossErrorMessage(inputs.payload) ?? "")
    .trim()
    .toLowerCase();
  const haystack = `${code} ${message}`;

  if (inputs.status === 404) return true;
  if (inputs.status !== 400 && inputs.status !== 409 && inputs.status !== 422) {
    return false;
  }

  return [
    "amount_too_low",
    "amount_too_high",
    "insufficient_liquidity",
    "liquidity",
    "no quote",
    "no route",
    "route",
    "unsupported",
    "unavailable",
    "not enabled",
    "limit",
  ].some((needle) => haystack.includes(needle));
}
