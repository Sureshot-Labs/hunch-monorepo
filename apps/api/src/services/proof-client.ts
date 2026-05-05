import { env } from "../env.js";

const PROOF_API_BASE = "https://proof.dflow.net";
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_RETRIES = 1;

type ProofCacheEntry = {
  verified: boolean;
  expiresAt: number;
};

const proofCache = new Map<string, ProofCacheEntry>();
const proofInflight = new Map<string, Promise<ProofVerifyResult>>();

export type ProofVerifyResult =
  | {
      ok: true;
      verified: boolean;
      status: number;
      source: "cache" | "live";
    }
  | {
      ok: false;
      status?: number;
      error: string;
    };

function normalizeAddress(address: string): string {
  return address.trim();
}

function getCacheTtlMs(verified: boolean): number {
  return verified
    ? env.kalshiProofCacheVerifiedTtlMs
    : env.kalshiProofCacheUnverifiedTtlMs;
}

function readCache(address: string): ProofVerifyResult | null {
  const key = normalizeAddress(address);
  const entry = proofCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    proofCache.delete(key);
    return null;
  }
  return {
    ok: true,
    verified: entry.verified,
    status: 200,
    source: "cache",
  };
}

function writeCache(address: string, verified: boolean): void {
  const ttlMs = getCacheTtlMs(verified);
  if (ttlMs <= 0) return;
  proofCache.set(normalizeAddress(address), {
    verified,
    expiresAt: Date.now() + ttlMs,
  });
}

function clearCache(address: string): void {
  proofCache.delete(normalizeAddress(address));
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
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object")
    return "Proof verification failed";
  const record = payload as Record<string, unknown>;
  const message =
    (typeof record.error === "string" && record.error) ||
    (typeof record.message === "string" && record.message) ||
    "Proof verification failed";
  return message;
}

function parseVerified(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return typeof record.verified === "boolean" ? record.verified : null;
}

async function fetchProofVerify(args: {
  address: string;
  timeoutMs: number;
}): Promise<ProofVerifyResult> {
  const url = `${PROOF_API_BASE}/verify/${encodeURIComponent(args.address)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Hunch-API/1.0",
      },
      signal: controller.signal,
    });
    const payload = await readJsonOrText(res);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: extractErrorMessage(payload),
      };
    }
    const verified = parseVerified(payload);
    if (verified == null) {
      return {
        ok: false,
        status: res.status,
        error: "Proof verify response missing verified boolean",
      };
    }
    return {
      ok: true,
      verified,
      status: res.status,
      source: "live",
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Proof verification failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyProofAddress(args: {
  address: string;
  forceRefresh?: boolean;
  timeoutMs?: number;
  retries?: number;
}): Promise<ProofVerifyResult> {
  const address = normalizeAddress(args.address);
  if (!address) {
    return { ok: false, error: "Missing wallet address" };
  }

  if (args.forceRefresh) {
    clearCache(address);
  } else {
    const cached = readCache(address);
    if (cached) return cached;
  }

  const inflightKey = address;
  const existingInflight = proofInflight.get(inflightKey);
  if (existingInflight) return existingInflight;

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, args.retries ?? DEFAULT_RETRIES);

  const requestPromise = (async (): Promise<ProofVerifyResult> => {
    let latestResult: ProofVerifyResult = {
      ok: false,
      error: "Proof verification failed",
    };
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await fetchProofVerify({
        address,
        timeoutMs,
      });
      latestResult = result;
      if (result.ok) {
        writeCache(address, result.verified);
        return result;
      }
    }
    return latestResult;
  })();

  proofInflight.set(inflightKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    proofInflight.delete(inflightKey);
  }
}
