import { createHash, randomUUID } from "node:crypto";

const DEFAULT_EMBEDDED_EXECUTION_SETTLED_TTL_MS = 30_000;
const DEFAULT_EMBEDDED_EXECUTION_REDIS_LOCK_TTL_MS = 120_000;
const DEFAULT_EMBEDDED_EXECUTION_REDIS_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_EMBEDDED_EXECUTION_REDIS_POLL_MS = 100;

export type EmbeddedExecutionSingleFlightRedis = {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    options?: { EX?: number; NX?: true },
  ) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  eval?: (
    script: string,
    options: { keys: string[]; arguments: string[] },
  ) => Promise<unknown>;
};

type EmbeddedExecutionSettledEntry = {
  expiresAt: number;
  value: unknown;
};

type RedisSettledValue<T> =
  | { found: true; value: T }
  | { found: false; value?: never };

const embeddedExecutionInFlight = new Map<string, Promise<unknown>>();
const embeddedExecutionSettled = new Map<
  string,
  EmbeddedExecutionSettledEntry
>();

function pruneExpiredEmbeddedExecutionSettledEntries(now = Date.now()) {
  for (const [key, entry] of embeddedExecutionSettled.entries()) {
    if (entry.expiresAt <= now) {
      embeddedExecutionSettled.delete(key);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ttlMsToRedisSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function getSettledTtlMs(inputTtlMs: number | undefined): number {
  return inputTtlMs ?? DEFAULT_EMBEDDED_EXECUTION_SETTLED_TTL_MS;
}

function setLocalSettledValue(key: string, value: unknown, ttlMs: number) {
  embeddedExecutionSettled.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function buildRedisSingleFlightKey(key: string, suffix: "lock" | "result") {
  const digest = createHash("sha256").update(key).digest("hex");
  return `embedded-execution:singleflight:v1:${suffix}:${digest}`;
}

async function readRedisSettledValue<T>(
  redis: EmbeddedExecutionSingleFlightRedis,
  resultKey: string,
): Promise<RedisSettledValue<T>> {
  const raw = await redis.get(resultKey);
  if (!raw) return { found: false };
  const parsed = JSON.parse(raw) as { value: T };
  return { found: true, value: parsed.value };
}

async function writeRedisSettledValue<T>(input: {
  redis: EmbeddedExecutionSingleFlightRedis;
  resultKey: string;
  ttlMs: number;
  value: T;
}): Promise<void> {
  await input.redis.set(
    input.resultKey,
    JSON.stringify({ value: input.value }),
    {
      EX: ttlMsToRedisSeconds(input.ttlMs),
    },
  );
}

async function releaseRedisLock(input: {
  redis: EmbeddedExecutionSingleFlightRedis;
  lockKey: string;
  owner: string;
}): Promise<void> {
  if (input.redis.eval) {
    await input.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [input.lockKey], arguments: [input.owner] },
    );
    return;
  }

  const currentOwner = await input.redis.get(input.lockKey);
  if (currentOwner === input.owner) {
    await input.redis.del(input.lockKey);
  }
}

async function waitForRedisSettledValue<T>(input: {
  redis: EmbeddedExecutionSingleFlightRedis;
  resultKey: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<RedisSettledValue<T>> {
  const deadline = Date.now() + input.timeoutMs;
  do {
    const settled = await readRedisSettledValue<T>(
      input.redis,
      input.resultKey,
    );
    if (settled.found) return settled;
    await sleep(input.pollMs);
  } while (Date.now() < deadline);

  return { found: false };
}

export class EmbeddedExecutionInProgressError extends Error {
  readonly responseStatus = 409;
  readonly responsePayload = {
    code: "embedded_execution_in_progress",
  };

  constructor() {
    super("Embedded execution is already in progress. Retry shortly.");
    this.name = "EmbeddedExecutionInProgressError";
  }
}

export function isEmbeddedExecutionInProgressError(
  error: unknown,
): error is EmbeddedExecutionInProgressError {
  return error instanceof EmbeddedExecutionInProgressError;
}

export function buildEmbeddedExecutionSingleFlightKey(
  ...parts: Array<string | number | null | undefined>
): string {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("|");
}

export function getEmbeddedExecutionSingleFlightPromise<T>(
  key: string,
): Promise<T> | null {
  return (embeddedExecutionInFlight.get(key) as Promise<T> | undefined) ?? null;
}

export async function runEmbeddedExecutionSingleFlight<T>(inputs: {
  key: string;
  redis?: EmbeddedExecutionSingleFlightRedis | null;
  redisLockTtlMs?: number;
  redisPollMs?: number;
  redisWaitTimeoutMs?: number;
  run: () => Promise<T>;
  settledTtlMs?: number;
}): Promise<T> {
  const now = Date.now();
  pruneExpiredEmbeddedExecutionSettledEntries(now);
  const settledTtlMs = getSettledTtlMs(inputs.settledTtlMs);

  const settled = embeddedExecutionSettled.get(inputs.key);
  if (settled && settled.expiresAt > now) {
    return settled.value as T;
  }

  const existing = embeddedExecutionInFlight.get(inputs.key) as
    | Promise<T>
    | undefined;
  if (existing) {
    return existing;
  }

  const redis = inputs.redis ?? null;
  const resultKey = redis
    ? buildRedisSingleFlightKey(inputs.key, "result")
    : null;
  const lockKey = redis ? buildRedisSingleFlightKey(inputs.key, "lock") : null;
  let redisLockOwner: string | null = null;
  let redisLockAcquired = false;
  let redisPeerLocked = false;

  if (redis && resultKey && lockKey) {
    try {
      const redisSettled = await readRedisSettledValue<T>(redis, resultKey);
      if (redisSettled.found) {
        setLocalSettledValue(inputs.key, redisSettled.value, settledTtlMs);
        return redisSettled.value;
      }

      redisLockOwner = randomUUID();
      const locked = await redis.set(lockKey, redisLockOwner, {
        NX: true,
        EX: ttlMsToRedisSeconds(
          inputs.redisLockTtlMs ?? DEFAULT_EMBEDDED_EXECUTION_REDIS_LOCK_TTL_MS,
        ),
      });
      if (locked !== "OK") {
        redisPeerLocked = true;
        const waitedSettled = await waitForRedisSettledValue<T>({
          redis,
          resultKey,
          timeoutMs:
            inputs.redisWaitTimeoutMs ??
            DEFAULT_EMBEDDED_EXECUTION_REDIS_WAIT_TIMEOUT_MS,
          pollMs:
            inputs.redisPollMs ?? DEFAULT_EMBEDDED_EXECUTION_REDIS_POLL_MS,
        });
        if (waitedSettled.found) {
          setLocalSettledValue(inputs.key, waitedSettled.value, settledTtlMs);
          return waitedSettled.value;
        }
        throw new EmbeddedExecutionInProgressError();
      }
      redisLockAcquired = true;
    } catch (error) {
      if (
        error instanceof EmbeddedExecutionInProgressError ||
        redisLockAcquired ||
        redisPeerLocked
      ) {
        throw error;
      }
    }
  }

  const executionPromise = (async () => {
    const result = await inputs.run();
    setLocalSettledValue(inputs.key, result, settledTtlMs);
    if (redis && resultKey && redisLockOwner) {
      await writeRedisSettledValue({
        redis,
        resultKey,
        ttlMs: settledTtlMs,
        value: result,
      }).catch(() => {});
    }
    return result;
  })();

  embeddedExecutionInFlight.set(inputs.key, executionPromise);

  try {
    return await executionPromise;
  } finally {
    if (embeddedExecutionInFlight.get(inputs.key) === executionPromise) {
      embeddedExecutionInFlight.delete(inputs.key);
    }
    if (redis && lockKey && redisLockOwner) {
      await releaseRedisLock({ redis, lockKey, owner: redisLockOwner }).catch(
        () => {},
      );
    }
  }
}

export function clearEmbeddedExecutionSingleFlightState() {
  embeddedExecutionInFlight.clear();
  embeddedExecutionSettled.clear();
}
