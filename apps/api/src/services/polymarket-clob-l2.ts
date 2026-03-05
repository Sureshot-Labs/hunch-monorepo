import crypto from "crypto";
import { BuilderSigner, type BuilderApiKeyCreds } from "@polymarket/builder-signing-sdk";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchWithWalletIntelRetry,
  type WalletIntelRetryTelemetry,
} from "./wallet-intel-retry.js";

export type PolymarketL2Credentials = {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
};

export type PolymarketBuilderCredentials = BuilderApiKeyCreds;

const STRIP_QUERY_FROM_SIGNATURE = true;

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

function createPolymarketBuilderHeaders(inputs: {
  creds?: PolymarketBuilderCredentials;
  method: string;
  requestPath: string;
  body?: string;
  timestampSec?: number;
}): Record<string, string> | null {
  if (!inputs.creds) return null;
  const key = inputs.creds.key?.trim();
  const secret = inputs.creds.secret?.trim();
  const passphrase = inputs.creds.passphrase?.trim();
  if (!key || !secret || !passphrase) return null;
  const signer = new BuilderSigner({ key, secret, passphrase });
  return signer.createBuilderHeaderPayload(
    inputs.method,
    inputs.requestPath,
    inputs.body ?? "",
    inputs.timestampSec,
  );
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
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<number | null> {
  try {
    const res = await fetchWithWalletIntelRetry({
      url: `${inputs.baseUrl}/time`,
      init: {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "Hunch-API/1.0" },
      },
      timeoutMs: inputs.timeoutMs,
      allowRetry: true,
      telemetry: inputs.telemetry ?? null,
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
  }
}

export async function polymarketL2Request(inputs: {
  baseUrl: string;
  timeoutMs: number;
  address: string;
  creds: PolymarketL2Credentials;
  builderCreds?: PolymarketBuilderCredentials;
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  body?: unknown;
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; payload: unknown }> {
  const baseUrl = normalizeBaseUrl(inputs.baseUrl);
  const requestPath = inputs.requestPath.startsWith("/")
    ? inputs.requestPath
    : `/${inputs.requestPath}`;
  const requestPathForSignature =
    STRIP_QUERY_FROM_SIGNATURE && requestPath.includes("?")
      ? requestPath.split("?")[0] ?? requestPath
      : requestPath;

  const bodyString =
    inputs.body === undefined ? undefined : JSON.stringify(inputs.body);

  const remoteTime = await fetchClobTime({
    baseUrl,
    timeoutMs: inputs.timeoutMs,
    telemetry: inputs.telemetry ?? null,
  });

  const headers = new Headers({
    accept: "application/json",
    "user-agent": "Hunch-API/1.0",
    ...createPolymarketL2Headers({
      address: inputs.address,
      creds: inputs.creds,
      method: inputs.method,
      requestPath: requestPathForSignature,
      body: bodyString,
      ...(remoteTime != null ? { timestampSec: remoteTime } : {}),
    }),
    ...(createPolymarketBuilderHeaders({
      creds: inputs.builderCreds,
      method: inputs.method,
      requestPath: requestPathForSignature,
      body: bodyString,
      ...(remoteTime != null ? { timestampSec: remoteTime } : {}),
    }) ?? {}),
  });
  if (bodyString !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  /*console.log("!!! Polymarket L2 Request:", {
    method: inputs.method,
    requestPath,
    hasBuilderCreds: Boolean(inputs.builderCreds?.key),
  });
  console.log("!!! Polymarket L2 Request Headers:", Object.fromEntries(headers.entries()));
  console.log("!!! Polymarket inputs.builderCreds :", inputs.builderCreds);*/
  const res = await fetchWithWalletIntelRetry({
    url: `${baseUrl}${requestPath}`,
    init: {
      method: inputs.method,
      headers,
      body: bodyString,
    },
    timeoutMs: inputs.timeoutMs,
    allowRetry: inputs.method === "GET",
    telemetry: inputs.telemetry ?? null,
  });

  const payload = await readJsonOrText(res);
  if (!res.ok) {
    return { ok: false, status: res.status, payload };
  }
  return { ok: true, payload };
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

export type PolymarketOpenOrder = {
  associateTrades: string[];
  id: string | null;
  status: string | null;
  market: string | null;
  originalSize: string | null;
  outcome: string | null;
  makerAddress: string | null;
  owner: string | null;
  price: string | null;
  side: string | null;
  sizeMatched: string | null;
  assetId: string | null;
  expiration: string | null;
  type: string | null;
  createdAt: string | null;
};

export type PolymarketMakerOrder = {
  orderId: string | null;
  makerAddress: string | null;
  owner: string | null;
  matchedAmount: string | null;
  feeRateBps: string | null;
  price: string | null;
  assetId: string | null;
  outcome: string | null;
  side: string | null;
};

export type PolymarketTrade = {
  id: string | null;
  takerOrderId: string | null;
  market: string | null;
  assetId: string | null;
  side: string | null;
  size: string | null;
  feeRateBps: string | null;
  price: string | null;
  status: string | null;
  matchTime: string | null;
  lastUpdate: string | null;
  outcome: string | null;
  makerAddress: string | null;
  owner: string | null;
  transactionHash: string | null;
  bucketIndex: number | null;
  makerOrders: PolymarketMakerOrder[];
  type: string | null;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function extractSingleOrder(payload: unknown): unknown | null {
  if (!isRecord(payload)) return null;
  const order = payload.order ?? payload.data ?? payload.result ?? null;
  return isRecord(order) ? order : null;
}

export function normalizeOpenOrder(order: unknown): PolymarketOpenOrder | null {
  if (!isRecord(order)) return null;
  const associateTrades = Array.isArray(order.associate_trades)
    ? order.associate_trades
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  return {
    associateTrades,
    id: readString(order.id ?? order.order_id),
    status: readString(order.status),
    market: readString(order.market),
    originalSize: readString(order.original_size),
    outcome: readString(order.outcome),
    makerAddress: readString(order.maker_address ?? order.maker),
    owner: readString(order.owner),
    price: readString(order.price),
    side: readString(order.side),
    sizeMatched: readString(order.size_matched),
    assetId: readString(order.asset_id ?? order.token_id),
    expiration: readString(order.expiration),
    type: readString(order.type),
    createdAt: readString(order.created_at),
  };
}

export function extractTradeArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const candidates = [
    payload.trades,
    payload.data,
    payload.results,
    payload.items,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeMakerOrder(order: unknown): PolymarketMakerOrder | null {
  if (!isRecord(order)) return null;

  return {
    orderId: readString(order.order_id ?? order.orderId),
    makerAddress: readString(order.maker_address ?? order.maker),
    owner: readString(order.owner),
    matchedAmount: readString(order.matched_amount ?? order.matchedAmount),
    feeRateBps: readString(order.fee_rate_bps ?? order.feeRateBps),
    price: readString(order.price),
    assetId: readString(order.asset_id ?? order.assetId),
    outcome: readString(order.outcome),
    side: readString(order.side),
  };
}

export function normalizeTrade(trade: unknown): PolymarketTrade | null {
  if (!isRecord(trade)) return null;
  const makerOrdersRaw = Array.isArray(trade.maker_orders)
    ? trade.maker_orders
    : [];
  const makerOrders = makerOrdersRaw
    .map((order) => normalizeMakerOrder(order))
    .filter((order): order is PolymarketMakerOrder => Boolean(order));
  const bucketIndex = readNumber(trade.bucket_index ?? trade.bucketIndex);

  return {
    id: readString(trade.id),
    takerOrderId: readString(trade.taker_order_id ?? trade.takerOrderId),
    market: readString(trade.market),
    assetId: readString(trade.asset_id ?? trade.assetId),
    side: readString(trade.side),
    size: readString(trade.size),
    feeRateBps: readString(trade.fee_rate_bps ?? trade.feeRateBps),
    price: readString(trade.price),
    status: readString(trade.status),
    matchTime: readString(trade.match_time ?? trade.matchTime),
    lastUpdate: readString(trade.last_update ?? trade.lastUpdate),
    outcome: readString(trade.outcome),
    makerAddress: readString(trade.maker_address ?? trade.maker),
    owner: readString(trade.owner),
    transactionHash: readString(trade.transaction_hash ?? trade.transactionHash),
    bucketIndex,
    makerOrders,
    type: readString(trade.type),
  };
}

export async function fetchPolymarketOrderByHash(inputs: {
  baseUrl: string;
  timeoutMs: number;
  address: string;
  creds: PolymarketL2Credentials;
  builderCreds?: PolymarketBuilderCredentials;
  orderHash: string;
}): Promise<
  | { ok: true; payload: unknown; order: PolymarketOpenOrder | null }
  | { ok: false; status: number; payload: unknown }
> {
  const requestPath = `/data/order/${inputs.orderHash}`;
  const upstream = await polymarketL2Request({
    baseUrl: inputs.baseUrl,
    timeoutMs: inputs.timeoutMs,
    address: inputs.address,
    creds: inputs.creds,
    builderCreds: inputs.builderCreds,
    method: "GET",
    requestPath,
  });

  if (!upstream.ok) return upstream;

  const orderRaw = extractSingleOrder(upstream.payload);
  return {
    ok: true,
    payload: upstream.payload,
    order: normalizeOpenOrder(orderRaw),
  };
}

export async function fetchPolymarketTrades(inputs: {
  baseUrl: string;
  timeoutMs: number;
  address: string;
  creds: PolymarketL2Credentials;
  builderCreds?: PolymarketBuilderCredentials;
  query?: {
    id?: string;
    taker?: string;
    maker?: string;
    market?: string;
    before?: string | number;
    after?: string | number;
  };
}): Promise<
  | { ok: true; payload: unknown; trades: PolymarketTrade[] }
  | { ok: false; status: number; payload: unknown }
> {
  const params = new URLSearchParams();
  const query = inputs.query ?? {};

  if (query.id) params.set("id", String(query.id));
  if (query.taker) params.set("taker", query.taker);
  if (query.maker) params.set("maker", query.maker);
  if (query.market) params.set("market", query.market);
  if (query.before != null) params.set("before", String(query.before));
  if (query.after != null) params.set("after", String(query.after));

  const requestPath = params.toString().length
    ? `/data/trades?${params.toString()}`
    : "/data/trades";

  const upstream = await polymarketL2Request({
    baseUrl: inputs.baseUrl,
    timeoutMs: inputs.timeoutMs,
    address: inputs.address,
    creds: inputs.creds,
    builderCreds: inputs.builderCreds,
    method: "GET",
    requestPath,
  });

  if (!upstream.ok) return upstream;

  const tradesRaw = extractTradeArray(upstream.payload);
  const trades = tradesRaw
    .map((trade) => normalizeTrade(trade))
    .filter((trade): trade is PolymarketTrade => Boolean(trade));

  return { ok: true, payload: upstream.payload, trades };
}
