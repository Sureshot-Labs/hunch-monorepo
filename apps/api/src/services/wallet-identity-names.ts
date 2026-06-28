import { JsonRpcProvider, ethers } from "ethers";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";

export type WalletIdentityNameSource = "polymarket" | "ens";

export type WalletIdentityPrimaryName = {
  name: string;
  source: WalletIdentityNameSource;
  profileUrl?: string;
  resolvedAt: string;
};

export type PolymarketIdentityName = {
  error?: string;
  errorCheckedAt?: string;
  username?: string;
  pseudonym?: string;
  profileUrl?: string;
  verifiedBadge?: boolean;
  status?: "error" | "ok" | "not_found";
  resolvedAt?: string;
  checkedAt?: string;
};

export type EnsIdentityName = {
  name?: string;
  status?: "ok" | "not_found";
  resolvedAt?: string;
  checkedAt?: string;
};

export type WalletIdentityNamesMetadata = {
  primary?: WalletIdentityPrimaryName;
  polymarket?: PolymarketIdentityName;
  ens?: EnsIdentityName;
};

export type WalletIdentityDisplayFields = {
  identityDisplayName: string | null;
  identityDisplayNameSource: WalletIdentityNameSource | null;
  identityProfileUrl: string | null;
  label?: string | null;
};

type IdentityNameResolutionStatus =
  | "resolved"
  | "not_found"
  | "fresh"
  | "skipped"
  | "error";
type EthereumRpcSkipReason = "forbidden" | "wrong_chain" | "network_error";

export type WalletIdentityNameResolutionReport = {
  identityNames: WalletIdentityNamesMetadata | null;
  changed: boolean;
  polymarketError?: string;
  polymarketStatus: IdentityNameResolutionStatus;
  ensStatus: IdentityNameResolutionStatus;
  ensSkipReason?: EthereumRpcSkipReason;
};

type FetchLike = typeof fetch;

type EnsLookupClient = {
  lookupAddress(address: string): Promise<string | null>;
  resolveName(name: string): Promise<string | null>;
};

type EthereumRpcCheckResult =
  | { ok: true }
  | { ok: false; reason: EthereumRpcSkipReason };

const POLYMARKET_PROFILE_BASE_URL = "https://polymarket.com";
const IDENTITY_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTITY_NO_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const IDENTITY_ERROR_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_IDENTITY_FETCH_TIMEOUT_MS = 5_000;
const POLYMARKET_DISPLAY_NAME_MAX_LENGTH = 32;
const ADDRESS_LIKE_HANDLE_RE = /0x[0-9a-fA-F]{30,}(?:-\d{8,})?/;

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const normalized = ethers.getAddress(value).toLowerCase();
    return normalized === ethers.ZeroAddress.toLowerCase() ? null : normalized;
  } catch {
    return null;
  }
}

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFreshTimestamp(
  value: unknown,
  nowMs: number,
  ttlMs: number,
): boolean {
  const parsed = parseIsoTime(value);
  return parsed != null && nowMs - parsed < ttlMs;
}

function isPolymarketFresh(
  source: PolymarketIdentityName | undefined,
  nowMs: number,
): boolean {
  if (!source) return false;
  if (
    source.status === "error" &&
    isFreshTimestamp(
      source.errorCheckedAt ?? source.checkedAt,
      nowMs,
      IDENTITY_ERROR_TTL_MS,
    )
  ) {
    return true;
  }
  if (
    source.status !== "error" &&
    source.username &&
    isFreshTimestamp(source.resolvedAt, nowMs, IDENTITY_SUCCESS_TTL_MS)
  ) {
    return true;
  }
  return (
    source.status === "not_found" &&
    isFreshTimestamp(
      source.checkedAt ?? source.resolvedAt,
      nowMs,
      IDENTITY_NO_NAME_TTL_MS,
    )
  );
}

function isEnsFresh(
  source: EnsIdentityName | undefined,
  nowMs: number,
): boolean {
  if (!source) return false;
  if (
    source.name &&
    isFreshTimestamp(source.resolvedAt, nowMs, IDENTITY_SUCCESS_TTL_MS)
  ) {
    return true;
  }
  return (
    source.status === "not_found" &&
    isFreshTimestamp(
      source.checkedAt ?? source.resolvedAt,
      nowMs,
      IDENTITY_NO_NAME_TTL_MS,
    )
  );
}

function parsePolymarketSource(
  value: unknown,
): PolymarketIdentityName | undefined {
  if (!isRecord(value)) return undefined;
  const username = trimNonEmpty(value.username);
  const pseudonym = trimNonEmpty(value.pseudonym);
  const profileUrl = trimNonEmpty(value.profileUrl);
  const status =
    value.status === "error" ||
    value.status === "ok" ||
    value.status === "not_found"
      ? value.status
      : undefined;
  const resolvedAt = trimNonEmpty(value.resolvedAt);
  const checkedAt = trimNonEmpty(value.checkedAt);
  const error = trimNonEmpty(value.error);
  const errorCheckedAt = trimNonEmpty(value.errorCheckedAt);
  const verifiedBadge =
    typeof value.verifiedBadge === "boolean" ? value.verifiedBadge : undefined;
  return {
    ...(error ? { error } : {}),
    ...(errorCheckedAt ? { errorCheckedAt } : {}),
    ...(username ? { username } : {}),
    ...(pseudonym ? { pseudonym } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(verifiedBadge != null ? { verifiedBadge } : {}),
    ...(status ? { status } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(checkedAt ? { checkedAt } : {}),
  };
}

function parseEnsSource(value: unknown): EnsIdentityName | undefined {
  if (!isRecord(value)) return undefined;
  const name = trimNonEmpty(value.name);
  const status =
    value.status === "ok" || value.status === "not_found"
      ? value.status
      : undefined;
  const resolvedAt = trimNonEmpty(value.resolvedAt);
  const checkedAt = trimNonEmpty(value.checkedAt);
  return {
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(checkedAt ? { checkedAt } : {}),
  };
}

function parsePrimarySource(
  value: unknown,
): WalletIdentityPrimaryName | undefined {
  if (!isRecord(value)) return undefined;
  const name = trimNonEmpty(value.name);
  const source =
    value.source === "polymarket" || value.source === "ens"
      ? value.source
      : undefined;
  const resolvedAt = trimNonEmpty(value.resolvedAt);
  if (!name || !source || !resolvedAt) return undefined;
  const profileUrl = trimNonEmpty(value.profileUrl);
  return {
    name,
    source,
    resolvedAt,
    ...(profileUrl ? { profileUrl } : {}),
  };
}

export function parseWalletIdentityNamesMetadata(
  metadata: unknown,
): WalletIdentityNamesMetadata | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata.identityNames;
  if (!isRecord(raw)) return null;
  const polymarket = parsePolymarketSource(raw.polymarket);
  const ens = parseEnsSource(raw.ens);
  const primary =
    buildPrimaryIdentityName({ polymarket, ens }) ??
    parsePrimarySource(raw.primary);
  if (!polymarket && !ens && !primary) return null;
  return {
    ...(primary ? { primary } : {}),
    ...(polymarket ? { polymarket } : {}),
    ...(ens ? { ens } : {}),
  };
}

export function extractWalletIdentityDisplayFields(
  metadata: unknown,
  labelFallback?: string | null,
): WalletIdentityDisplayFields {
  const identityNames = parseWalletIdentityNamesMetadata(metadata);
  const primary = buildDisplayIdentityName(identityNames);
  const fields: WalletIdentityDisplayFields = {
    identityDisplayName: primary?.name ?? null,
    identityDisplayNameSource: primary?.source ?? null,
    identityProfileUrl: primary?.profileUrl ?? null,
  };
  if (arguments.length > 1) {
    const existingLabel = trimNonEmpty(labelFallback);
    fields.label = existingLabel ?? primary?.name ?? null;
  }
  return fields;
}

function isSafePolymarketDisplayName(value: string | null): value is string {
  if (!value) return false;
  if (value.length > POLYMARKET_DISPLAY_NAME_MAX_LENGTH) return false;
  return !ADDRESS_LIKE_HANDLE_RE.test(value);
}

function buildDisplayIdentityName(
  identityNames: WalletIdentityNamesMetadata | null,
): WalletIdentityPrimaryName | undefined {
  const polymarket = identityNames?.polymarket;
  const username = trimNonEmpty(polymarket?.username);
  if (username) {
    const handle = `@${username.replace(/^@+/, "")}`;
    const resolvedAt =
      trimNonEmpty(polymarket?.resolvedAt) ?? new Date().toISOString();
    const profileUrl =
      trimNonEmpty(polymarket?.profileUrl) ??
      `${POLYMARKET_PROFILE_BASE_URL}/@${encodeURIComponent(username)}`;
    if (isSafePolymarketDisplayName(handle)) {
      return {
        name: handle,
        source: "polymarket",
        profileUrl,
        resolvedAt,
      };
    }
    const pseudonym = trimNonEmpty(polymarket?.pseudonym);
    if (isSafePolymarketDisplayName(pseudonym)) {
      return {
        name: pseudonym,
        source: "polymarket",
        profileUrl,
        resolvedAt,
      };
    }
  }

  const ensName = trimNonEmpty(identityNames?.ens?.name);
  if (ensName) {
    return {
      name: ensName,
      source: "ens",
      resolvedAt:
        trimNonEmpty(identityNames?.ens?.resolvedAt) ??
        new Date().toISOString(),
    };
  }
  const primary = identityNames?.primary;
  const primaryName = trimNonEmpty(primary?.name);
  if (
    primaryName &&
    (primary?.source === "ens" ||
      (primary?.source === "polymarket" &&
        isSafePolymarketDisplayName(primaryName)))
  ) {
    return {
      name: primaryName,
      source: primary.source,
      ...(primary.profileUrl ? { profileUrl: primary.profileUrl } : {}),
      resolvedAt: primary.resolvedAt,
    };
  }
  return undefined;
}

export function buildPrimaryIdentityName(input: {
  polymarket?: PolymarketIdentityName | null;
  ens?: EnsIdentityName | null;
}): WalletIdentityPrimaryName | undefined {
  const polymarketUsername = trimNonEmpty(input.polymarket?.username);
  if (polymarketUsername) {
    const resolvedAt =
      trimNonEmpty(input.polymarket?.resolvedAt) ?? new Date().toISOString();
    const profileUrl =
      trimNonEmpty(input.polymarket?.profileUrl) ??
      `${POLYMARKET_PROFILE_BASE_URL}/@${encodeURIComponent(polymarketUsername)}`;
    return {
      name: `@${polymarketUsername.replace(/^@+/, "")}`,
      source: "polymarket",
      profileUrl,
      resolvedAt,
    };
  }

  const ensName = trimNonEmpty(input.ens?.name);
  if (ensName) {
    return {
      name: ensName,
      source: "ens",
      resolvedAt:
        trimNonEmpty(input.ens?.resolvedAt) ?? new Date().toISOString(),
    };
  }
  return undefined;
}

export function buildIdentityNamesMetadataPatch(input: {
  existingMetadata: unknown;
  polymarket?: PolymarketIdentityName | null;
  ens?: EnsIdentityName | null;
}): WalletIdentityNamesMetadata | null {
  const existing =
    parseWalletIdentityNamesMetadata(input.existingMetadata) ?? {};
  const polymarket =
    input.polymarket === undefined
      ? existing.polymarket
      : (input.polymarket ?? undefined);
  const ens = input.ens === undefined ? existing.ens : (input.ens ?? undefined);
  const primary = buildPrimaryIdentityName({ polymarket, ens });
  if (!primary && !polymarket && !ens) return null;
  return {
    ...(primary ? { primary } : {}),
    ...(polymarket ? { polymarket } : {}),
    ...(ens ? { ens } : {}),
  };
}

export async function fetchPolymarketIdentityName(input: {
  address: string;
  nowIso?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<
  | { status: "ok"; source: PolymarketIdentityName }
  | { status: "not_found"; source: PolymarketIdentityName }
  | { status: "error"; error: string; source: PolymarketIdentityName }
> {
  const address = normalizeEvmAddress(input.address);
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!address) {
    return {
      status: "error",
      error: "invalid_evm_address",
      source: {
        status: "error",
        error: "invalid_evm_address",
        errorCheckedAt: nowIso,
        checkedAt: nowIso,
      },
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_IDENTITY_FETCH_TIMEOUT_MS;
  const url = `${POLYMARKET_PROFILE_BASE_URL}/api/profile/userData?address=${encodeURIComponent(address)}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Hunch-API/1.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      return {
        status: "not_found",
        source: { status: "not_found", checkedAt: nowIso },
      };
    }
    if (!res.ok) {
      return {
        status: "error",
        error: `http_${res.status}`,
        source: {
          status: "error",
          error: `http_${res.status}`,
          errorCheckedAt: nowIso,
          checkedAt: nowIso,
        },
      };
    }
    const payload = (await res.json()) as unknown;
    if (!isRecord(payload)) {
      return {
        status: "not_found",
        source: { status: "not_found", checkedAt: nowIso },
      };
    }
    const username = trimNonEmpty(payload.name);
    if (!username || payload.displayUsernamePublic === false) {
      return {
        status: "not_found",
        source: { status: "not_found", checkedAt: nowIso },
      };
    }
    return {
      status: "ok",
      source: {
        status: "ok",
        username,
        ...(trimNonEmpty(payload.pseudonym)
          ? { pseudonym: trimNonEmpty(payload.pseudonym) as string }
          : {}),
        ...(typeof payload.verifiedBadge === "boolean"
          ? { verifiedBadge: payload.verifiedBadge }
          : {}),
        profileUrl: `${POLYMARKET_PROFILE_BASE_URL}/@${encodeURIComponent(username)}`,
        resolvedAt: nowIso,
        checkedAt: nowIso,
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message.slice(0, 160) : String(error);
    return {
      status: "error",
      error: errorMessage,
      source: {
        status: "error",
        error: errorMessage,
        errorCheckedAt: nowIso,
        checkedAt: nowIso,
      },
    };
  }
}

async function checkEthereumRpc(input: {
  rpcUrl: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<EthereumRpcCheckResult> {
  try {
    const res = await input.fetchImpl(input.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (res.status === 403) return { ok: false, reason: "forbidden" };
    if (!res.ok) return { ok: false, reason: "network_error" };
    const payload = (await res.json()) as unknown;
    if (!isRecord(payload) || typeof payload.result !== "string") {
      return { ok: false, reason: "network_error" };
    }
    const chainId = Number.parseInt(payload.result, 16);
    if (chainId !== 1) return { ok: false, reason: "wrong_chain" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export async function resolveEnsIdentityName(input: {
  address: string;
  nowIso?: string;
  rpcUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  client?: EnsLookupClient;
}): Promise<
  | { status: "ok"; source: EnsIdentityName }
  | { status: "not_found"; source: EnsIdentityName }
  | { status: "skipped"; reason: EthereumRpcSkipReason }
> {
  const address = normalizeEvmAddress(input.address);
  if (!address) return { status: "skipped", reason: "network_error" };
  const nowIso = input.nowIso ?? new Date().toISOString();
  const rpcUrl = input.rpcUrl ?? env.ethereumRpcUrl;
  const timeoutMs = input.timeoutMs ?? env.ethereumRpcTimeoutMs;
  const fetchImpl = input.fetchImpl ?? fetch;
  const rpcCheck = await checkEthereumRpc({ rpcUrl, fetchImpl, timeoutMs });
  if (!rpcCheck.ok) return { status: "skipped", reason: rpcCheck.reason };

  try {
    const client =
      input.client ??
      new JsonRpcProvider(rpcUrl, 1, {
        staticNetwork: true,
      });
    const name = await Promise.race([
      client.lookupAddress(address),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
    if (!name) {
      return {
        status: "not_found",
        source: { status: "not_found", checkedAt: nowIso },
      };
    }
    const resolved = await Promise.race([
      client.resolveName(name),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
    const resolvedAddress = normalizeEvmAddress(resolved);
    if (resolvedAddress !== address) {
      return {
        status: "not_found",
        source: { status: "not_found", checkedAt: nowIso },
      };
    }
    return {
      status: "ok",
      source: { status: "ok", name, resolvedAt: nowIso, checkedAt: nowIso },
    };
  } catch {
    return { status: "skipped", reason: "network_error" };
  }
}

export async function resolveWalletIdentityNames(input: {
  address: string;
  chain: "polygon" | "base" | "solana";
  venue?: string | null;
  metadata: unknown;
  now?: Date;
  fetchImpl?: FetchLike;
  ensClient?: EnsLookupClient;
  ethereumRpcUrl?: string;
  skipEns?: boolean;
}): Promise<WalletIdentityNameResolutionReport> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const existing = parseWalletIdentityNamesMetadata(input.metadata) ?? {};
  let polymarket = existing.polymarket;
  let ens = existing.ens;
  let polymarketStatus: IdentityNameResolutionStatus = "skipped";
  let ensStatus: IdentityNameResolutionStatus = "skipped";
  let polymarketError: string | undefined;
  let changed = false;

  const evmAddress = normalizeEvmAddress(input.address);
  if (!evmAddress || input.chain === "solana") {
    return {
      identityNames: existing.primary ? existing : null,
      changed: false,
      polymarketStatus,
      ensStatus,
    };
  }

  if (input.chain === "polygon" && input.venue === "polymarket") {
    if (isPolymarketFresh(polymarket, nowMs)) {
      polymarketStatus = "fresh";
    } else {
      const resolved = await fetchPolymarketIdentityName({
        address: evmAddress,
        nowIso,
        fetchImpl: input.fetchImpl,
      });
      polymarketStatus =
        resolved.status === "ok" ? "resolved" : resolved.status;
      if (resolved.status === "error") {
        polymarketError = resolved.error;
        polymarket = {
          ...polymarket,
          ...resolved.source,
          ...(polymarket?.username ? { username: polymarket.username } : {}),
          ...(polymarket?.pseudonym ? { pseudonym: polymarket.pseudonym } : {}),
          ...(polymarket?.profileUrl
            ? { profileUrl: polymarket.profileUrl }
            : {}),
          ...(polymarket?.verifiedBadge != null
            ? { verifiedBadge: polymarket.verifiedBadge }
            : {}),
          ...(polymarket?.resolvedAt
            ? { resolvedAt: polymarket.resolvedAt }
            : {}),
        };
        changed = true;
      } else {
        polymarket = resolved.source;
        changed = true;
      }
    }
  }

  let ensSkipReason: EthereumRpcSkipReason | undefined;
  if (input.skipEns) {
    ensStatus = "skipped";
  } else if (isEnsFresh(ens, nowMs)) {
    ensStatus = "fresh";
  } else {
    const resolved = await resolveEnsIdentityName({
      address: evmAddress,
      nowIso,
      fetchImpl: input.fetchImpl,
      client: input.ensClient,
      rpcUrl: input.ethereumRpcUrl,
    });
    ensStatus = resolved.status === "ok" ? "resolved" : resolved.status;
    if (resolved.status === "skipped") ensSkipReason = resolved.reason;
    if (resolved.status !== "skipped") {
      ens = resolved.source;
      changed = true;
    }
  }

  const identityNames = buildIdentityNamesMetadataPatch({
    existingMetadata: input.metadata,
    polymarket,
    ens,
  });
  return {
    identityNames,
    changed,
    ...(polymarketError ? { polymarketError } : {}),
    polymarketStatus,
    ensStatus,
    ...(ensSkipReason ? { ensSkipReason } : {}),
  };
}
