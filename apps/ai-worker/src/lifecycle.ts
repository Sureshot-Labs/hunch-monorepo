import { setTimeout as sleep } from "node:timers/promises";
import { isRedisRetryableError } from "@hunch/infra";

// Docker can start an existing container before Redis finishes loading its RDB.
// Production took over four minutes; do not change the shared Redis default.
export const EMBEDDING_REDIS_STARTUP_MS = 10 * 60_000;

type FailureCode =
  | "redis_startup_timeout"
  | "redis_startup_failed"
  | "lease_acquisition_failed"
  | "lease_renewal_failed"
  | "initialization_failed"
  | "processing_failed"
  | "cleanup_failed";

class WorkerFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

type WorkerDependencies = {
  redis: {
    readonly isOpen: boolean;
    connect(): Promise<unknown>;
    ping(): Promise<string>;
    destroy(): void;
  };
  acquireLease(): Promise<boolean>;
  renewLease(): Promise<void>;
  releaseLease(): Promise<void>;
  closeDatabase(): Promise<void>;
  initialize(): Promise<() => Promise<void>>;
  log(message: string): void;
};

async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  code: FailureCode,
  parent?: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const signal = parent
    ? AbortSignal.any([parent, deadline.signal])
    : deadline.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => deadline.abort(new WorkerFailure(code)), ms);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([
      Promise.resolve().then(() => run(signal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runEmbeddingWorker(
  deps: WorkerDependencies,
  shutdown: AbortSignal,
  {
    startupMs = EMBEDDING_REDIS_STARTUP_MS,
    redisPollMs = 1_000,
    leaseRenewMs = 10_000,
    cleanupMs = 2_000,
  } = {},
): Promise<void> {
  let stage: FailureCode = "redis_startup_failed";
  let failure: WorkerFailure | undefined;
  let acquired = false;
  let renewal: Promise<void> | undefined;
  let leaseLost = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await bounded(
      async (signal) => {
        signal.throwIfAborted();
        if (!deps.redis.isOpen) await deps.redis.connect();
        let nextNotice = 0;
        while (true) {
          signal.throwIfAborted();
          try {
            if ((await deps.redis.ping()) === "PONG") return;
          } catch (error) {
            if (!isRedisRetryableError(error)) throw error;
          }
          if (Date.now() >= nextNotice) {
            deps.log("Waiting for Redis to finish startup");
            nextNotice = Date.now() + 30_000;
          }
          await sleep(redisPollMs, undefined, { signal });
        }
      },
      startupMs,
      "redis_startup_timeout",
      shutdown,
    );

    stage = "lease_acquisition_failed";
    while (!shutdown.aborted && !(acquired = await deps.acquireLease()))
      await sleep(1_000, undefined, { signal: shutdown });

    if (!shutdown.aborted) {
      heartbeat = setInterval(() => {
        if (renewal || leaseLost) return;
        renewal = deps
          .renewLease()
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, leaseRenewMs);
      stage = "initialization_failed";
      const tick = await deps.initialize();
      if (!shutdown.aborted && !leaseLost)
        deps.log("generation-aware worker ready");
      stage = "processing_failed";
      while (!shutdown.aborted && !leaseLost) {
        await tick();
        if (!shutdown.aborted && !leaseLost)
          await sleep(250, undefined, { signal: shutdown });
      }
      if (leaseLost) throw new WorkerFailure("lease_renewal_failed");
    }
  } catch (error) {
    // SIGTERM during the startup wait or a poll is expected. A work/lease error
    // must still fail the process rather than leaving a live, idle container.
    const cancelled =
      shutdown.aborted &&
      (error === shutdown.reason ||
        (error instanceof Error &&
          error.name === "AbortError" &&
          error.cause === shutdown.reason));
    if (!cancelled)
      failure =
        error instanceof WorkerFailure ? error : new WorkerFailure(stage);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (acquired) {
      try {
        await bounded(() => deps.releaseLease(), cleanupMs, "cleanup_failed");
      } catch {
        // Release is fenced, and if Redis is unavailable the lease expires.
        deps.log("Could not release the embedding lease; it will expire");
      }
    }
    try {
      if (deps.redis.isOpen) deps.redis.destroy();
    } catch {
      failure ??= new WorkerFailure("cleanup_failed");
    }
    try {
      await bounded(() => deps.closeDatabase(), cleanupMs, "cleanup_failed");
    } catch {
      failure ??= new WorkerFailure("cleanup_failed");
    }
  }
  if (failure) throw failure;
}

export function exitAfterEmbeddingFailure(error: unknown): never {
  const code = error instanceof WorkerFailure ? error.code : "startup_failed";
  // Never log Redis URLs, credentials, or provider response bodies here.
  console.error(
    `[ai-worker] stopped (${code}); check embedding status diagnostics`,
  );
  // Assigning exitCode alone does not terminate when a socket or timer is open.
  process.exit(1);
}
