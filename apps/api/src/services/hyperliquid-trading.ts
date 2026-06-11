import { ethers } from "ethers";
import { env } from "../env.js";

export const HYPERLIQUID_TOKEN_PREFIX = "hyperliquid:";
export const HYPERLIQUID_OFFICIAL_OUTCOME_ASSET_OFFSET = 100_000_000;
const HYPERLIQUID_CLOID_RE = /^0x[0-9a-fA-F]{32}$/;

export type HyperliquidOrderSide = "BUY" | "SELL";
export type HyperliquidOrderTif = "Gtc" | "Ioc";

export type HyperliquidTypedData = {
  domain: {
    name: "Exchange";
    version: "1";
    chainId: 1337;
    verifyingContract: "0x0000000000000000000000000000000000000000";
  };
  types: {
    EIP712Domain: Array<{ name: string; type: string }>;
    Agent: Array<{ name: string; type: string }>;
  };
  primaryType: "Agent";
  message: {
    source: "a" | "b";
    connectionId: string;
  };
};

export type HyperliquidSignature = {
  r: string;
  s: string;
  v: number;
};

export type HyperliquidOrderAction = {
  type: "order";
  orders: HyperliquidOrderWire[];
  grouping: "na";
};

export type HyperliquidCancelAction = {
  type: "cancel";
  cancels: Array<{ a: number; o: number }>;
};

export type HyperliquidCancelByCloidAction = {
  type: "cancelByCloid";
  cancels: Array<{ asset: number; cloid: string }>;
};

export type HyperliquidAction =
  | HyperliquidOrderAction
  | HyperliquidCancelAction
  | HyperliquidCancelByCloidAction;

export type HyperliquidOrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: {
    limit: {
      tif: HyperliquidOrderTif;
    };
  };
  c?: string;
};

export type HyperliquidSpotBalance = {
  coin: string;
  tokenId: string | null;
  total: string;
  hold: string | null;
  entryNtl: string | null;
};

export type HyperliquidSpotState = {
  user: string;
  usdcBalanceRaw: string;
  usdcBalance: string;
  balances: HyperliquidSpotBalance[];
  raw: unknown;
};

export type HyperliquidCanonicalOrderIdInput = {
  cloid?: string | null;
  oid?: string | number | null;
  venueOrderId?: string | null;
};

export type HyperliquidNormalizedUserFill = {
  txSignature: string;
  quoteId: string | null;
  venueOrderId: string | null;
  tokenId: string;
  side: HyperliquidOrderSide;
  price: number;
  size: number;
  notionalUsd: number;
  executedAt: Date | null;
  raw: unknown;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

type MsgpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | MsgpackValue[]
  | { [key: string]: MsgpackValue };

const HYPERLIQUID_EIP712_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const HYPERLIQUID_AGENT_TYPES = [
  { name: "source", type: "string" },
  { name: "connectionId", type: "bytes32" },
];

const textEncoder = new TextEncoder();

export function hyperliquidAssetIdFromHunchTokenId(tokenId: string): number {
  if (!tokenId.startsWith(HYPERLIQUID_TOKEN_PREFIX)) {
    throw new Error("Expected a Hyperliquid token id.");
  }
  const assetId = Number(tokenId.slice(HYPERLIQUID_TOKEN_PREFIX.length));
  if (!Number.isSafeInteger(assetId) || assetId < 0) {
    throw new Error("Invalid Hyperliquid token id.");
  }
  return assetId;
}

export function hyperliquidCoinFromAssetId(assetId: number): string {
  const coinId = assetId - HYPERLIQUID_OFFICIAL_OUTCOME_ASSET_OFFSET;
  if (!Number.isSafeInteger(coinId) || coinId < 0) {
    throw new Error("Invalid Hyperliquid outcome asset id.");
  }
  return `#${coinId}`;
}

export function hyperliquidCoinFromHunchTokenId(tokenId: string): string {
  return hyperliquidCoinFromAssetId(hyperliquidAssetIdFromHunchTokenId(tokenId));
}

export function hunchTokenIdFromHyperliquidCoin(coin: string): string | null {
  const trimmed = coin.trim();
  if (!/^#\d+$/.test(trimmed)) return null;
  const coinId = Number(trimmed.slice(1));
  if (!Number.isSafeInteger(coinId) || coinId < 0) return null;
  return `${HYPERLIQUID_TOKEN_PREFIX}${HYPERLIQUID_OFFICIAL_OUTCOME_ASSET_OFFSET + coinId}`;
}

export function normalizeHyperliquidClientOrderId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.toLowerCase().startsWith("cloid:")
    ? trimmed.slice("cloid:".length)
    : trimmed;
  if (!HYPERLIQUID_CLOID_RE.test(withoutPrefix)) return null;
  return withoutPrefix.toLowerCase();
}

export function normalizeHyperliquidExchangeOrderId(
  value: string | number | null | undefined,
): string | null {
  const raw =
    typeof value === "number"
      ? String(value)
      : value?.trim().toLowerCase().startsWith("oid:")
        ? value.trim().slice("oid:".length)
        : value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return String(parsed);
}

export function canonicalHyperliquidVenueOrderId(
  input: HyperliquidCanonicalOrderIdInput,
): string | null {
  const cloid =
    normalizeHyperliquidClientOrderId(input.cloid) ??
    normalizeHyperliquidClientOrderId(input.venueOrderId);
  if (cloid) return `cloid:${cloid}`;

  const oid =
    normalizeHyperliquidExchangeOrderId(input.oid) ??
    normalizeHyperliquidExchangeOrderId(input.venueOrderId);
  return oid ? `oid:${oid}` : null;
}

export function hyperliquidVenueOrderIdAliases(
  input: HyperliquidCanonicalOrderIdInput,
): string[] {
  const values = new Set<string>();
  const cloid =
    normalizeHyperliquidClientOrderId(input.cloid) ??
    normalizeHyperliquidClientOrderId(input.venueOrderId);
  if (cloid) {
    values.add(`cloid:${cloid}`);
    values.add(cloid);
  }

  const oid =
    normalizeHyperliquidExchangeOrderId(input.oid) ??
    normalizeHyperliquidExchangeOrderId(input.venueOrderId);
  if (oid) {
    values.add(`oid:${oid}`);
    values.add(oid);
  }

  const canonical = canonicalHyperliquidVenueOrderId(input);
  if (canonical) values.add(canonical);
  if (input.venueOrderId?.trim()) values.add(input.venueOrderId.trim());
  return Array.from(values);
}

function normalizeFiniteNumber(value: string | number, label: string): number {
  const parsed =
    typeof value === "number" ? value : Number(value.trim().replace(/_/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

export function formatHyperliquidDecimal(
  value: string | number,
  options: { maxDecimals: number; maxSigFigs?: number; label?: string },
): string {
  const label = options.label ?? "decimal";
  const parsed = normalizeFiniteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be greater than zero.`);

  const sigFigs = options.maxSigFigs;
  const rounded =
    sigFigs != null && sigFigs > 0
      ? Number(parsed.toPrecision(sigFigs))
      : parsed;
  const fixed = rounded.toFixed(options.maxDecimals);
  const stripped = fixed.replace(/\.?0+$/, "");
  if (!stripped || Number(stripped) <= 0) {
    throw new Error(`${label} is too small for Hyperliquid precision.`);
  }
  return stripped;
}

export function makeHyperliquidClientOrderId(inputs: {
  userId: string;
  walletAddress: string;
  tokenId: string;
  nonce: number;
}): string {
  const digest = ethers.keccak256(
    ethers.toUtf8Bytes(
      [
        "hunch-hyperliquid-cloid-v1",
        inputs.userId,
        inputs.walletAddress.toLowerCase(),
        inputs.tokenId,
        String(inputs.nonce),
      ].join(":"),
    ),
  );
  return `0x${digest.slice(2, 34)}`;
}

export function buildHyperliquidOrderAction(inputs: {
  assetId: number;
  side: HyperliquidOrderSide;
  price: string | number;
  size: string | number;
  tif: HyperliquidOrderTif;
  reduceOnly?: boolean;
  cloid?: string | null;
}): HyperliquidOrderAction {
  const wire: HyperliquidOrderWire = {
    a: inputs.assetId,
    b: inputs.side === "BUY",
    p: formatHyperliquidDecimal(inputs.price, {
      maxDecimals: 6,
      maxSigFigs: 5,
      label: "price",
    }),
    s: formatHyperliquidDecimal(inputs.size, {
      maxDecimals: 8,
      label: "size",
    }),
    r: Boolean(inputs.reduceOnly),
    t: { limit: { tif: inputs.tif } },
  };
  if (inputs.cloid) wire.c = inputs.cloid;
  return { type: "order", orders: [wire], grouping: "na" };
}

export function buildHyperliquidCancelAction(inputs: {
  assetId: number;
  oid?: number | null;
  cloid?: string | null;
}): HyperliquidCancelAction | HyperliquidCancelByCloidAction {
  const cloid = inputs.cloid?.trim();
  if (cloid) {
    if (!/^0x[0-9a-fA-F]{32}$/.test(cloid)) {
      throw new Error("Hyperliquid cancel requires a valid client order id.");
    }
    return { type: "cancelByCloid", cancels: [{ asset: inputs.assetId, cloid }] };
  }
  if (inputs.oid == null || !Number.isSafeInteger(inputs.oid) || inputs.oid <= 0) {
    throw new Error(
      "Hyperliquid cancel requires a positive numeric order id or client order id.",
    );
  }
  return { type: "cancel", cancels: [{ a: inputs.assetId, o: inputs.oid }] };
}

function pushByte(output: number[], value: number) {
  output.push(value & 0xff);
}

function pushUint16(output: number[], value: number) {
  output.push((value >>> 8) & 0xff, value & 0xff);
}

function pushUint32(output: number[], value: number) {
  output.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function pushUint64(output: number[], value: bigint) {
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    output.push(Number((value >> shift) & 0xffn));
  }
}

function encodeMsgpack(value: MsgpackValue, output: number[]) {
  if (value === null) {
    pushByte(output, 0xc0);
    return;
  }
  if (typeof value === "boolean") {
    pushByte(output, value ? 0xc3 : 0xc2);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Hyperliquid action contains an unsupported number.");
    }
    encodePositiveInteger(BigInt(value), output);
    return;
  }
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error("Hyperliquid action contains a negative integer.");
    }
    encodePositiveInteger(value, output);
    return;
  }
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    const length = bytes.length;
    if (length < 32) {
      pushByte(output, 0xa0 | length);
    } else if (length <= 0xff) {
      pushByte(output, 0xd9);
      pushByte(output, length);
    } else if (length <= 0xffff) {
      pushByte(output, 0xda);
      pushUint16(output, length);
    } else {
      pushByte(output, 0xdb);
      pushUint32(output, length);
    }
    output.push(...bytes);
    return;
  }
  if (Array.isArray(value)) {
    const length = value.length;
    if (length < 16) {
      pushByte(output, 0x90 | length);
    } else if (length <= 0xffff) {
      pushByte(output, 0xdc);
      pushUint16(output, length);
    } else {
      pushByte(output, 0xdd);
      pushUint32(output, length);
    }
    for (const item of value) encodeMsgpack(item, output);
    return;
  }

  const entries = Object.entries(value);
  const length = entries.length;
  if (length < 16) {
    pushByte(output, 0x80 | length);
  } else if (length <= 0xffff) {
    pushByte(output, 0xde);
    pushUint16(output, length);
  } else {
    pushByte(output, 0xdf);
    pushUint32(output, length);
  }
  for (const [key, item] of entries) {
    encodeMsgpack(key, output);
    encodeMsgpack(item, output);
  }
}

function encodePositiveInteger(value: bigint, output: number[]) {
  if (value <= 0x7fn) {
    pushByte(output, Number(value));
  } else if (value <= 0xffn) {
    pushByte(output, 0xcc);
    pushByte(output, Number(value));
  } else if (value <= 0xffffn) {
    pushByte(output, 0xcd);
    pushUint16(output, Number(value));
  } else if (value <= 0xffffffffn) {
    pushByte(output, 0xce);
    pushUint32(output, Number(value));
  } else if (value <= 0xffffffffffffffffn) {
    pushByte(output, 0xcf);
    pushUint64(output, value);
  } else {
    throw new Error("Hyperliquid action integer is too large.");
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function actionToMsgpackValue(action: HyperliquidAction): MsgpackValue {
  if (action.type === "order") {
    return {
      type: action.type,
      orders: action.orders.map((order) => {
        const wire: { [key: string]: MsgpackValue } = {
          a: order.a,
          b: order.b,
          p: order.p,
          s: order.s,
          r: order.r,
          t: { limit: { tif: order.t.limit.tif } },
        };
        if (order.c) wire.c = order.c;
        return wire;
      }),
      grouping: action.grouping,
    };
  }
  if (action.type === "cancel") {
    return {
      type: action.type,
      cancels: action.cancels.map((cancel) => ({
        a: cancel.a,
        o: cancel.o,
      })),
    };
  }
  return {
    type: action.type,
    cancels: action.cancels.map((cancel) => ({
      asset: cancel.asset,
      cloid: cancel.cloid,
    })),
  };
}

export function hashHyperliquidAction(inputs: {
  action: HyperliquidAction;
  nonce: number;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
}): string {
  const actionBytes: number[] = [];
  encodeMsgpack(actionToMsgpackValue(inputs.action), actionBytes);

  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(inputs.nonce), false);

  const parts: Uint8Array[] = [new Uint8Array(actionBytes), nonceBytes];
  const vaultAddress = inputs.vaultAddress?.trim() ?? "";
  if (vaultAddress) {
    parts.push(Uint8Array.of(1));
    parts.push(ethers.getBytes(ethers.getAddress(vaultAddress)));
  } else {
    parts.push(Uint8Array.of(0));
  }

  if (inputs.expiresAfter != null) {
    const expiresBytes = new Uint8Array(8);
    new DataView(expiresBytes.buffer).setBigUint64(
      0,
      BigInt(inputs.expiresAfter),
      false,
    );
    parts.push(Uint8Array.of(0), expiresBytes);
  }

  return ethers.keccak256(concatBytes(parts));
}

export function buildHyperliquidTypedData(inputs: {
  action: HyperliquidAction;
  nonce: number;
  isMainnet?: boolean;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
}): HyperliquidTypedData {
  const connectionId = hashHyperliquidAction(inputs);
  return {
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      EIP712Domain: HYPERLIQUID_EIP712_DOMAIN_TYPES,
      Agent: HYPERLIQUID_AGENT_TYPES,
    },
    primaryType: "Agent",
    message: {
      source: inputs.isMainnet === false ? "b" : "a",
      connectionId,
    },
  };
}

export function splitHyperliquidSignature(signature: string): HyperliquidSignature {
  const parsed = ethers.Signature.from(signature);
  const v = parsed.v < 27 ? parsed.v + 27 : parsed.v;
  return { r: parsed.r, s: parsed.s, v };
}

export function recoverHyperliquidSigner(
  typedData: HyperliquidTypedData,
  signature: string,
): string {
  return ethers.verifyTypedData(
    typedData.domain,
    { Agent: typedData.types.Agent },
    typedData.message,
    signature,
  );
}

async function hyperliquidPost(inputs: {
  url: string;
  timeoutMs: number;
  body: unknown;
  fetchFn?: FetchLike;
}): Promise<unknown> {
  const fetchFn = inputs.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);
  try {
    const response = await fetchFn(inputs.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputs.body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(async () => {
      const text = await response.text().catch(() => "");
      return text ? { error: text } : null;
    });
    if (!response.ok) {
      const message =
        payload && typeof payload === "object"
          ? ((payload as Record<string, unknown>).error ??
              (payload as Record<string, unknown>).message ??
              `Hyperliquid request failed (${response.status})`)
          : `Hyperliquid request failed (${response.status})`;
      const error = new Error(String(message));
      (error as { responseStatus?: number; responsePayload?: unknown }).responseStatus =
        response.status;
      (error as { responsePayload?: unknown }).responsePayload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function hyperliquidInfo<T = unknown>(
  body: unknown,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<T> {
  return (await hyperliquidPost({
    url: env.hyperliquidInfoUrl,
    timeoutMs: options.timeoutMs ?? env.hyperliquidInfoTimeoutMs,
    body,
    fetchFn: options.fetchFn,
  })) as T;
}

export async function submitHyperliquidExchangeAction(inputs: {
  action: HyperliquidAction;
  nonce: number;
  signature: string | HyperliquidSignature;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
  fetchFn?: FetchLike;
}): Promise<unknown> {
  const signature =
    typeof inputs.signature === "string"
      ? splitHyperliquidSignature(inputs.signature)
      : inputs.signature;
  return hyperliquidPost({
    url: env.hyperliquidExchangeUrl,
    timeoutMs: env.hyperliquidExchangeTimeoutMs,
    fetchFn: inputs.fetchFn,
    body: {
      action: inputs.action,
      nonce: inputs.nonce,
      signature,
      ...(inputs.vaultAddress ? { vaultAddress: inputs.vaultAddress } : {}),
      ...(inputs.expiresAfter != null ? { expiresAfter: inputs.expiresAfter } : {}),
    },
  });
}

function decimalToUnits(value: string | number | null | undefined, decimals: number): bigint {
  if (value == null) return 0n;
  const raw = String(value).trim();
  if (!raw) return 0n;
  const sign = raw.startsWith("-") ? -1n : 1n;
  const unsigned = raw.replace(/^[+-]/, "");
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  if (!/^\d+$/.test(wholeRaw || "0") || !/^\d*$/.test(fracRaw)) return 0n;
  const whole = BigInt(wholeRaw || "0") * 10n ** BigInt(decimals);
  const frac = BigInt((fracRaw + "0".repeat(decimals)).slice(0, decimals) || "0");
  return sign * (whole + frac);
}

function unitsToDecimal(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function normalizeHyperliquidUserFills(
  payload: unknown,
): HyperliquidNormalizedUserFill[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map((entry): HyperliquidNormalizedUserFill | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const coin = readString(record, ["coin"]);
      const tokenId = coin ? hunchTokenIdFromHyperliquidCoin(coin) : null;
      if (!tokenId) return null;

      const sideRaw = readString(record, ["side"]);
      const side =
        sideRaw === "B" || sideRaw?.toUpperCase() === "BUY"
          ? "BUY"
          : sideRaw === "A" || sideRaw?.toUpperCase() === "SELL"
            ? "SELL"
            : null;
      if (!side) return null;

      const price = normalizeOptionalNumber(readString(record, ["px", "price"]));
      const size = normalizeOptionalNumber(readString(record, ["sz", "size"]));
      if (price == null || size == null || price <= 0 || size <= 0) return null;

      const stableFillId =
        readString(record, ["hash"]) ?? readString(record, ["tid", "tradeId"]);
      if (!stableFillId) return null;

      const oid = normalizeHyperliquidExchangeOrderId(readString(record, ["oid"]));
      const timeRaw = readString(record, ["time", "timestamp"]);
      const executedAt = timeRaw != null ? new Date(Number(timeRaw)) : null;
      return {
        txSignature: `hyperliquid-fill:${stableFillId}`,
        quoteId: readString(record, ["tid", "tradeId"]),
        venueOrderId: canonicalHyperliquidVenueOrderId({ oid }),
        tokenId,
        side,
        price,
        size,
        notionalUsd: price * size,
        executedAt:
          executedAt && Number.isFinite(executedAt.getTime()) ? executedAt : null,
        raw: entry,
      };
    })
    .filter((row): row is HyperliquidNormalizedUserFill => Boolean(row));
}

export async function fetchHyperliquidSpotState(
  userAddress: string,
): Promise<HyperliquidSpotState> {
  const user = ethers.getAddress(userAddress).toLowerCase();
  const payload = await hyperliquidInfo({ type: "spotClearinghouseState", user });
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const balancesRaw = Array.isArray(record.balances) ? record.balances : [];

  let usdcBalanceRaw = 0n;
  const balances: HyperliquidSpotBalance[] = [];
  for (const entry of balancesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const balance = entry as Record<string, unknown>;
    const coin = readString(balance, ["coin", "token", "name"]);
    if (!coin) continue;
    const total = readString(balance, ["total", "balance", "available"]) ?? "0";
    const hold = readString(balance, ["hold", "reserved"]);
    const entryNtl = readString(balance, ["entryNtl", "entry_ntl", "entryNotional"]);
    if (coin.toUpperCase() === "USDC") {
      usdcBalanceRaw += decimalToUnits(total, 6);
    }
    balances.push({
      coin,
      tokenId: hunchTokenIdFromHyperliquidCoin(coin),
      total,
      hold,
      entryNtl,
    });
  }

  return {
    user,
    usdcBalanceRaw: usdcBalanceRaw.toString(),
    usdcBalance: unitsToDecimal(usdcBalanceRaw, 6),
    balances,
    raw: payload,
  };
}

export function extractHyperliquidOrderStatus(payload: unknown): {
  status: "submitted" | "live" | "filled" | "rejected" | "cancelled";
  venueOrderId: string | null;
  errorMessage: string | null;
  filledSize: number | null;
  averageFillPrice: number | null;
} {
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const response = record.response;
  const data =
    response && typeof response === "object"
      ? (response as Record<string, unknown>).data
      : null;
  const statuses =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).statuses)
      ? ((data as Record<string, unknown>).statuses as unknown[])
      : [];
  const first =
    statuses[0] && typeof statuses[0] === "object"
      ? (statuses[0] as Record<string, unknown>)
      : null;
  if (!first) {
    const status = typeof record.status === "string" ? record.status : "";
    return {
      status: status === "ok" ? "submitted" : "rejected",
      venueOrderId: null,
      errorMessage: status === "ok" ? null : "Hyperliquid rejected the action.",
      filledSize: null,
      averageFillPrice: null,
    };
  }
  if (typeof first.error === "string") {
    return {
      status: "rejected",
      venueOrderId: null,
      errorMessage: first.error,
      filledSize: null,
      averageFillPrice: null,
    };
  }
  const resting =
    first.resting && typeof first.resting === "object"
      ? (first.resting as Record<string, unknown>)
      : null;
  if (resting) {
    const oid = readString(resting, ["oid", "orderId"]);
    return {
      status: "live",
      venueOrderId: oid,
      errorMessage: null,
      filledSize: null,
      averageFillPrice: null,
    };
  }
  const filled =
    first.filled && typeof first.filled === "object"
      ? (first.filled as Record<string, unknown>)
      : null;
  if (filled) {
    const oid = readString(filled, ["oid", "orderId"]);
    return {
      status: "filled",
      venueOrderId: oid,
      errorMessage: null,
      filledSize: normalizeOptionalNumber(readString(filled, ["totalSz", "sz"])),
      averageFillPrice: normalizeOptionalNumber(readString(filled, ["avgPx", "px"])),
    };
  }
  return {
    status: "submitted",
    venueOrderId: null,
    errorMessage: null,
    filledSize: null,
    averageFillPrice: null,
  };
}

export function extractHyperliquidCancelStatus(payload: unknown): {
  status: "cancelled" | "rejected";
  errorMessage: string | null;
} {
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const response = record.response;
  const data =
    response && typeof response === "object"
      ? (response as Record<string, unknown>).data
      : null;
  const statuses =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).statuses)
      ? ((data as Record<string, unknown>).statuses as unknown[])
      : [];
  const first =
    statuses[0] && typeof statuses[0] === "object"
      ? (statuses[0] as Record<string, unknown>)
      : null;
  if (first && typeof first.error === "string") {
    return { status: "rejected", errorMessage: first.error };
  }
  if (first && typeof first.status === "string") {
    const status = first.status.toLowerCase();
    if (status.includes("error") || status.includes("reject")) {
      return {
        status: "rejected",
        errorMessage: first.status,
      };
    }
  }

  const topStatus = typeof record.status === "string" ? record.status : "";
  return topStatus.toLowerCase() === "ok" || first
    ? { status: "cancelled", errorMessage: null }
    : {
        status: "rejected",
        errorMessage: "Hyperliquid rejected the cancel request.",
      };
}

function normalizeOptionalNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
