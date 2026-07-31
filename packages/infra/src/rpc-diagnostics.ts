import {
  createRedisClient,
  ensureRedis,
  type RedisClientType,
} from "./redis.js";

export type RpcDiagnosticProtocol = "evm" | "solana";
export type RpcDiagnosticOutcome =
  | "ok"
  | "http_429"
  | "http_error"
  | "rpc_429"
  | "rpc_error"
  | "timeout"
  | "transport_error";

type RpcDiagnosticMetric = "attempt" | "dedup" | "duration_ms" | "logical";

export type RpcDiagnosticDimensions = Readonly<{
  service: string;
  network: string;
  method: string;
  source: string;
  metric: RpcDiagnosticMetric;
  outcome: string;
}>;

type PendingCounter = Readonly<{
  redisKey: string;
  redisField: string;
}>;

const REDIS_KEY_PREFIX = "rpc:diag:v1";
const REDIS_TTL_SECONDS = 30 * 60 * 60;
const FLUSH_INTERVAL_MS = 10_000;
const REDIS_RETRY_DELAY_MS = 60_000;
const MAX_PENDING_COUNTERS = 1_024;
const MAX_SOURCE_LENGTH = 180;

const pendingCounters = new Map<string, number>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushPromise: Promise<void> | null = null;
let redisPromise: Promise<RedisClientType | null> | null = null;
let redisRetryAfter = 0;
let lastWarningAt = 0;

function diagnosticsEnabled(): boolean {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return false;
  if (!diagnosticServiceName()) return false;
  const configured =
    process.env.HUNCH_RPC_DIAGNOSTICS_ENABLED?.trim().toLowerCase();
  return !configured || !["0", "false", "no", "off"].includes(configured);
}

function diagnosticServiceName(): string | null {
  return inferRpcDiagnosticService({
    configured: process.env.HUNCH_RPC_DIAGNOSTICS_SERVICE,
    argv: process.argv,
    cwd: process.cwd(),
  });
}

export function inferRpcDiagnosticService(
  input: Readonly<{
    configured?: string | null;
    argv: readonly string[];
    cwd: string;
  }>,
): string | null {
  const configured = input.configured?.trim();
  if (configured) return configured.slice(0, 64);
  const normalizedArgv = input.argv.map((entry) =>
    entry.replace(/\\/gu, "/").toLowerCase(),
  );
  const argv = normalizedArgv.join(" ");
  const cwd = input.cwd.replace(/\\/gu, "/").toLowerCase();
  if (argv.includes("finance-worker") || cwd.endsWith("/apps/finance-worker")) {
    return "finance-worker";
  }
  if (
    argv.includes("indexer-limitless") ||
    cwd.endsWith("/apps/indexer-limitless")
  ) {
    return "indexer-limitless";
  }
  if (
    argv.includes("indexer-polymarket") ||
    cwd.endsWith("/apps/indexer-polymarket")
  ) {
    return "indexer-polymarket";
  }
  if (argv.includes("indexer-dflow") || cwd.endsWith("/apps/indexer-dflow")) {
    return "indexer-dflow";
  }
  const apiServerEntrypoint = normalizedArgv.some(
    (entry) =>
      /(?:^|\/)apps\/api\/(?:src|dist)\/server\.[^/]+$/u.test(entry) ||
      (cwd.endsWith("/apps/api") &&
        /(?:^|\/)(?:src|dist)\/server\.[^/]+$/u.test(entry)),
  );
  if (apiServerEntrypoint) {
    return "api";
  }
  return null;
}

export function rpcDiagnosticsHourKey(at: Date): string {
  return `${REDIS_KEY_PREFIX}:${at.toISOString().slice(0, 13).replace(/[-T]/gu, "")}`;
}

export function encodeRpcDiagnosticField(
  dimensions: RpcDiagnosticDimensions,
): string {
  return JSON.stringify([
    dimensions.service,
    dimensions.network,
    dimensions.method,
    dimensions.source,
    dimensions.metric,
    dimensions.outcome,
  ]);
}

export function decodeRpcDiagnosticField(
  field: string,
): RpcDiagnosticDimensions | null {
  try {
    const value = JSON.parse(field) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 6 ||
      value.some((entry) => typeof entry !== "string")
    ) {
      return null;
    }
    const [service, network, method, source, metric, outcome] = value as [
      string,
      string,
      string,
      string,
      RpcDiagnosticMetric,
      string,
    ];
    if (
      metric !== "attempt" &&
      metric !== "dedup" &&
      metric !== "duration_ms" &&
      metric !== "logical"
    ) {
      return null;
    }
    return { service, network, method, source, metric, outcome };
  } catch {
    return null;
  }
}

function normalizeSourceFrame(frame: string): string | null {
  const trimmed = frame.trim();
  if (!trimmed.startsWith("at ")) return null;
  if (
    trimmed.includes("node:internal") ||
    trimmed.includes("node_modules") ||
    trimmed.includes("rpc-diagnostics.") ||
    trimmed.includes("rpc-client-factory.") ||
    trimmed.includes("services/polygon-rpc.") ||
    trimmed.includes("services/solana-rpc.")
  ) {
    return null;
  }
  const pathMatch =
    /(?:file:\/\/)?([^()\s]+\.(?:[cm]?[jt]s)):(\d+):\d+\)?$/u.exec(trimmed);
  if (!pathMatch?.[1] || !pathMatch[2]) return null;
  const path = pathMatch[1].replace(/\\/gu, "/");
  const workspaceMarker = path.lastIndexOf("/apps/");
  const packageMarker = path.lastIndexOf("/packages/");
  const marker = Math.max(workspaceMarker, packageMarker);
  const relativePath =
    marker >= 0 ? path.slice(marker + 1) : path.split("/").at(-1);
  if (!relativePath) return null;
  return `${relativePath}:${pathMatch[2]}`.slice(0, MAX_SOURCE_LENGTH);
}

export function captureRpcDiagnosticSource(): string {
  const stack = new Error().stack;
  if (!stack) return "unknown";
  for (const frame of stack.split("\n").slice(1)) {
    const source = normalizeSourceFrame(frame);
    if (source) return source;
  }
  return "unknown";
}

export function classifyRpcNetwork(
  protocol: RpcDiagnosticProtocol,
  rpcUrl: string,
): string {
  if (protocol === "solana") return "solana:mainnet";
  const known: ReadonlyArray<readonly [string, string]> = [
    ["POLYGON_RPC_URL", "evm:137"],
    ["BASE_RPC_URL", "evm:8453"],
    ["ETHEREUM_RPC_URL", "evm:1"],
    ["OPTIMISM_RPC_URL", "evm:10"],
    ["BSC_RPC_URL", "evm:56"],
    ["ARBITRUM_RPC_URL", "evm:42161"],
    ["AVALANCHE_RPC_URL", "evm:43114"],
    ["LINEA_RPC_URL", "evm:59144"],
  ];
  for (const [envName, network] of known) {
    const configured = process.env[envName]?.trim();
    if (configured && configured === rpcUrl) return network;
  }
  const defaults: ReadonlyArray<readonly [string, string]> = [
    ["https://ethereum-rpc.publicnode.com", "evm:1"],
    ["https://mainnet.optimism.io", "evm:10"],
    ["https://bsc-dataseed.binance.org", "evm:56"],
    ["https://polygon-rpc.com", "evm:137"],
    ["https://mainnet.base.org", "evm:8453"],
    ["https://arb1.arbitrum.io/rpc", "evm:42161"],
    ["https://api.avax.network/ext/bc/C/rpc", "evm:43114"],
    ["https://rpc.linea.build", "evm:59144"],
  ];
  for (const [configured, network] of defaults) {
    if (configured === rpcUrl) return network;
  }
  for (const entry of (process.env.EVM_RPC_URLS_BY_CHAIN ?? "").split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const chainId = entry.slice(0, separator).trim();
    const configured = entry.slice(separator + 1).trim();
    if (/^\d+$/u.test(chainId) && configured === rpcUrl) {
      return `evm:${chainId}`;
    }
  }
  return "evm:unknown";
}

function pendingCounter(
  dimensions: RpcDiagnosticDimensions,
  at: Date,
): PendingCounter {
  return {
    redisKey: rpcDiagnosticsHourKey(at),
    redisField: encodeRpcDiagnosticField(dimensions),
  };
}

function addCounter(
  dimensions: Omit<RpcDiagnosticDimensions, "service">,
  value = 1,
  at = new Date(),
): void {
  if (!diagnosticsEnabled() || !Number.isFinite(value) || value <= 0) return;
  const service = diagnosticServiceName();
  if (!service) return;
  const increment = Math.max(1, Math.round(value));
  const fullDimensions = {
    ...dimensions,
    service,
  } satisfies RpcDiagnosticDimensions;
  let counter = pendingCounter(fullDimensions, at);
  let key = `${counter.redisKey}\u0000${counter.redisField}`;
  if (
    !pendingCounters.has(key) &&
    pendingCounters.size >= MAX_PENDING_COUNTERS
  ) {
    counter = pendingCounter({ ...fullDimensions, source: "overflow" }, at);
    key = `${counter.redisKey}\u0000${counter.redisField}`;
    if (
      !pendingCounters.has(key) &&
      pendingCounters.size >= MAX_PENDING_COUNTERS
    ) {
      return;
    }
  }
  pendingCounters.set(key, (pendingCounters.get(key) ?? 0) + increment);
  ensureFlushTimer();
}

export function recordRpcLogicalCall(
  input: Readonly<{
    protocol: RpcDiagnosticProtocol;
    rpcUrl: string;
    method: string;
    source: string;
  }>,
): void {
  addCounter({
    network: classifyRpcNetwork(input.protocol, input.rpcUrl),
    method: input.method,
    source: input.source,
    metric: "logical",
    outcome: "all",
  });
}

export function recordRpcDedupHit(
  input: Readonly<{
    protocol: RpcDiagnosticProtocol;
    rpcUrl: string;
    method: string;
    source: string;
  }>,
): void {
  addCounter({
    network: classifyRpcNetwork(input.protocol, input.rpcUrl),
    method: input.method,
    source: input.source,
    metric: "dedup",
    outcome: "hit",
  });
}

export function recordRpcAttempt(
  input: Readonly<{
    protocol: RpcDiagnosticProtocol;
    rpcUrl: string;
    method: string;
    source: string;
    outcome: RpcDiagnosticOutcome;
    durationMs: number;
  }>,
): void {
  const base = {
    network: classifyRpcNetwork(input.protocol, input.rpcUrl),
    method: input.method,
    source: input.source,
  };
  addCounter({ ...base, metric: "attempt", outcome: input.outcome });
  addCounter(
    { ...base, metric: "duration_ms", outcome: "total" },
    input.durationMs,
  );
}

async function getDiagnosticsRedis(): Promise<RedisClientType | null> {
  if (!diagnosticsEnabled() || Date.now() < redisRetryAfter) return null;
  if (!redisPromise) {
    redisPromise = (async () => {
      const redisUrl = process.env.REDIS_URL?.trim();
      if (!redisUrl) return null;
      const redis = createRedisClient({ url: redisUrl });
      redis.on("error", () => {
        // Flush errors are sampled below. The diagnostics path must stay quiet
        // and must never affect the RPC operation it observes.
      });
      try {
        await ensureRedis(redis);
        return redis;
      } catch {
        await redis.disconnect().catch(() => {});
        redisRetryAfter = Date.now() + REDIS_RETRY_DELAY_MS;
        return null;
      }
    })();
  }
  const redis = await redisPromise;
  if (!redis) redisPromise = null;
  return redis;
}

function sampledWarning(message: string): void {
  const now = Date.now();
  if (now - lastWarningAt < REDIS_RETRY_DELAY_MS) return;
  lastWarningAt = now;
  console.warn(`[rpc-diagnostics] ${message}`);
}

export async function flushRpcDiagnostics(): Promise<void> {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    if (pendingCounters.size === 0) return;
    const snapshot = new Map(pendingCounters);
    pendingCounters.clear();
    const redis = await getDiagnosticsRedis();
    if (!redis) return;
    try {
      const transaction = redis.multi();
      const keys = new Set<string>();
      for (const [composite, value] of snapshot) {
        const separator = composite.indexOf("\u0000");
        if (separator < 0) continue;
        const redisKey = composite.slice(0, separator);
        const redisField = composite.slice(separator + 1);
        transaction.hIncrBy(redisKey, redisField, value);
        keys.add(redisKey);
      }
      for (const key of keys) transaction.expire(key, REDIS_TTL_SECONDS);
      await transaction.exec();
    } catch {
      await redis.disconnect().catch(() => {});
      redisPromise = null;
      redisRetryAfter = Date.now() + REDIS_RETRY_DELAY_MS;
      sampledWarning("Redis flush failed; metrics were dropped");
    }
  })().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushRpcDiagnostics();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export function rpcDiagnosticOutcomeFromError(
  error: unknown,
): RpcDiagnosticOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("429") || normalized.includes("too many requests")) {
    return normalized.includes("rpc") ? "rpc_429" : "http_429";
  }
  if (
    normalized.includes("abort") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out")
  ) {
    return "timeout";
  }
  return "transport_error";
}
