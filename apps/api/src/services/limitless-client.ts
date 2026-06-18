import { createHmac } from "node:crypto";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchWithWalletIntelRetry,
  type WalletIntelRetryTelemetry,
} from "./wallet-intel-retry.js";

type LimitlessResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: number; payload: unknown };

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

export function extractLimitlessMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim().length) {
    return payload.trim();
  }
  if (isRecord(payload)) {
    const rawMessage =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : null;
    if (!rawMessage) return null;
    const message = rawMessage.trim();
    return message.length ? message : null;
  }
  return null;
}

export function isLimitlessPartnerHmacConfigured(): boolean {
  return Boolean(env.limitlessHmacTokenId && env.limitlessHmacSecret);
}

function buildLimitlessCanonicalMessage(inputs: {
  timestamp: string;
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  bodyString?: string;
}): string {
  return `${inputs.timestamp}\n${inputs.method}\n${inputs.requestPath}\n${inputs.bodyString ?? ""}`;
}

function buildLimitlessPartnerHmacHeaders(inputs: {
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  bodyString?: string;
}): Record<string, string> {
  if (!isLimitlessPartnerHmacConfigured()) {
    throw new Error("Limitless partner HMAC is not configured.");
  }

  const timestamp = new Date().toISOString();
  const message = buildLimitlessCanonicalMessage({
    timestamp,
    method: inputs.method,
    requestPath: inputs.requestPath,
    bodyString: inputs.bodyString,
  });
  const signature = createHmac(
    "sha256",
    Buffer.from(env.limitlessHmacSecret, "base64"),
  )
    .update(message)
    .digest("base64");

  return {
    "lmts-api-key": env.limitlessHmacTokenId,
    "lmts-timestamp": timestamp,
    "lmts-signature": signature,
  };
}

export async function limitlessRequest(inputs: {
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  auth?: "none" | "partner_hmac";
  allowRetry?: boolean;
  headers?: Record<string, string>;
  body?: unknown;
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

  if (inputs.auth === "partner_hmac") {
    if (!isLimitlessPartnerHmacConfigured()) {
      return {
        ok: false,
        status: 503,
        payload: {
          error: "Limitless partner HMAC is not configured.",
        },
      };
    }
    const authHeaders = buildLimitlessPartnerHmacHeaders({
      method: inputs.method,
      requestPath,
      bodyString,
    });
    for (const [key, value] of Object.entries(authHeaders)) {
      headers.set(key, value);
    }
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
    allowRetry: inputs.allowRetry ?? inputs.method === "GET",
    telemetry: inputs.telemetry ?? null,
  });

  const payload = await readJsonOrText(res);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      payload,
    };
  }

  return {
    ok: true,
    payload,
  };
}

export type LimitlessRequestAuthInputs = { auth: "partner_hmac" };
