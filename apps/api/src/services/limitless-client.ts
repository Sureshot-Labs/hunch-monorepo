import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchWithWalletIntelRetry,
  type WalletIntelRetryTelemetry,
} from "./wallet-intel-retry.js";

type LimitlessResult =
  | { ok: true; payload: unknown; sessionCookie?: string }
  | { ok: false; status: number; payload: unknown; sessionCookie?: string };

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function extractSessionCookie(headers: Headers): string | null {
  const raw = headers.get("set-cookie");
  if (!raw) return null;
  const match = raw.match(/limitless_session=([^;]+)/i);
  return match?.[1] ?? null;
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

export function extractLimitlessMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim().length) {
    return payload.trim();
  }
  if (isRecord(payload) && typeof payload.message === "string") {
    const message = payload.message.trim();
    return message.length ? message : null;
  }
  return null;
}

export async function limitlessRequest(inputs: {
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  sessionCookie?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  captureSessionCookie?: boolean;
  timeoutMs?: number;
  baseUrl?: string;
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<LimitlessResult> {
  const baseUrl = normalizeBaseUrl(inputs.baseUrl ?? env.limitlessApiBase);
  const requestPath = inputs.requestPath.startsWith("/")
    ? inputs.requestPath
    : `/${inputs.requestPath}`;

  const bodyString =
    inputs.body === undefined ? undefined : JSON.stringify(inputs.body);

  const headers = new Headers({
    accept: "application/json",
    "user-agent": "Hunch-API/1.0",
    ...(inputs.headers ?? {}),
  });

  if (env.limitlessApiVersion) {
    headers.set("X-API-Version", env.limitlessApiVersion);
  }

  if (inputs.sessionCookie) {
    headers.set("Cookie", `limitless_session=${inputs.sessionCookie}`);
  }

  if (bodyString !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  const res = await fetchWithWalletIntelRetry({
    url: `${baseUrl}${requestPath}`,
    init: {
      method: inputs.method,
      headers,
      body: bodyString,
    },
    timeoutMs: inputs.timeoutMs ?? env.limitlessApiTimeoutMs,
    allowRetry: inputs.method === "GET",
    telemetry: inputs.telemetry ?? null,
  });

  const payload = await readJsonOrText(res);
  const sessionCookie = inputs.captureSessionCookie
    ? extractSessionCookie(res.headers)
    : null;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      payload,
      ...(sessionCookie ? { sessionCookie } : {}),
    };
  }

  return {
    ok: true,
    payload,
    ...(sessionCookie ? { sessionCookie } : {}),
  };
}
