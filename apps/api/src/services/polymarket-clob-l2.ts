import crypto from "crypto";
import { isRecord } from "../lib/type-guards.js";

export type PolymarketL2Credentials = {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    // Keep `=` padding to match Polymarket demo + maximize compatibility.
    // Many base64url decoders accept both padded and unpadded inputs.
    ;
}

function decodeBase64OrBase64Url(value: string): Buffer {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${pad}`, "base64");
}

export function createPolymarketL2Headers(inputs: {
  address: string;
  creds: PolymarketL2Credentials;
  method: string;
  requestPath: string;
  body?: string;
  timestampSec?: number;
}): Record<string, string> {
  const timestampSec =
    inputs.timestampSec ?? Math.floor(Date.now() / 1000);
  const method = inputs.method.toUpperCase();
  const requestPath = inputs.requestPath.startsWith("/")
    ? inputs.requestPath
    : `/${inputs.requestPath}`;

  const message =
    `${timestampSec}${method}${requestPath}` + (inputs.body ?? "");

  const key = decodeBase64OrBase64Url(inputs.creds.apiSecret);
  const sig = crypto.createHmac("sha256", key).update(message).digest();

  return {
    POLY_ADDRESS: inputs.address,
    POLY_SIGNATURE: toBase64Url(sig),
    POLY_TIMESTAMP: timestampSec.toString(),
    POLY_API_KEY: inputs.creds.apiKey,
    POLY_PASSPHRASE: inputs.creds.apiPassphrase,
  };
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

async function fetchClobTime(inputs: {
  baseUrl: string;
  timeoutMs: number;
}): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

  try {
    const res = await fetch(`${inputs.baseUrl}/time`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "Hunch-API/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const json = (await res.json()) as unknown;
    if (!isRecord(json)) return null;

    const time = json.time;
    if (typeof time === "number" && Number.isFinite(time)) {
      return Math.trunc(time);
    }
    if (typeof time === "string" && time.trim().length) {
      const n = Number(time.trim());
      if (Number.isFinite(n)) return Math.trunc(n);
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function polymarketL2Request(inputs: {
  baseUrl: string;
  timeoutMs: number;
  address: string;
  creds: PolymarketL2Credentials;
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  body?: unknown;
}): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; payload: unknown }> {
  const baseUrl = normalizeBaseUrl(inputs.baseUrl);
  const requestPath = inputs.requestPath.startsWith("/")
    ? inputs.requestPath
    : `/${inputs.requestPath}`;

  const bodyString =
    inputs.body === undefined ? undefined : JSON.stringify(inputs.body);

  const remoteTime = await fetchClobTime({
    baseUrl,
    timeoutMs: inputs.timeoutMs,
  });

  const headers = new Headers({
    accept: "application/json",
    "user-agent": "Hunch-API/1.0",
    ...createPolymarketL2Headers({
      address: inputs.address,
      creds: inputs.creds,
      method: inputs.method,
      requestPath,
      body: bodyString,
      ...(remoteTime != null ? { timestampSec: remoteTime } : {}),
    }),
  });

  if (bodyString !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

  try {
    const res = await fetch(`${baseUrl}${requestPath}`, {
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

export function extractOrderArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const candidates = [
    payload.orders,
    payload.data,
    payload.results,
    payload.items,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function extractOrderId(order: unknown): string | null {
  if (!isRecord(order)) return null;
  const raw =
    order.orderId ??
    order.order_id ??
    order.orderID ??
    order.id ??
    order.venueOrderId ??
    order.venue_order_id;

  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

export function extractTokenId(order: unknown): string | null {
  if (!isRecord(order)) return null;
  const raw = order.tokenId ?? order.token_id ?? order.asset_id ?? order.assetId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}
