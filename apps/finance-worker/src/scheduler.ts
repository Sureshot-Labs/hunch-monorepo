import type { InMemoryLockManager, LockKey } from "./locks.js";

export type ScheduledJob = {
  name: string;
  enabled: boolean;
  intervalSec: number;
  run: () => Promise<unknown>;
  lockKey?: LockKey;
  timeoutSec: number;
  maxRetries: number;
  retryBackoffSec: number;
  jitterSec: number;
};

export type SchedulerLogger = (
  event: string,
  fields?: Record<string, unknown>,
) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutSec: number): Promise<T> {
  if (timeoutSec <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`job timeout after ${timeoutSec}s`));
      }, timeoutSec * 1000);
      promise
        .finally(() => clearTimeout(timer))
        .catch(() => clearTimeout(timer));
    }),
  ]);
}

export class IntervalScheduler {
  private readonly timers = new Set<NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(
    private readonly logger: SchedulerLogger,
    private readonly lockManager: InMemoryLockManager,
  ) {}

  schedule(job: ScheduledJob): void {
    if (!job.enabled) {
      this.logger("job_disabled", { job: job.name });
      return;
    }

    let running = false;

    const scheduleNext = () => {
      if (this.shuttingDown) return;
      const jitterMs =
        job.jitterSec > 0
          ? Math.floor(Math.random() * job.jitterSec * 1000)
          : 0;
      const delayMs = job.intervalSec * 1000 + jitterMs;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void tick();
      }, delayMs);
      this.timers.add(timer);
    };

    const tick = async () => {
      if (this.shuttingDown) return;

      if (running) {
        this.logger("job_skip_running", { job: job.name });
        scheduleNext();
        return;
      }

      if (job.lockKey && !this.lockManager.tryAcquire(job.lockKey)) {
        this.logger("job_skip_locked", { job: job.name, lockKey: job.lockKey });
        scheduleNext();
        return;
      }

      running = true;
      const startedAt = Date.now();
      this.logger("job_start", { job: job.name });

      try {
        let attempt = 0;
        while (true) {
          attempt += 1;
          try {
            const result = await withTimeout(job.run(), job.timeoutSec);
            this.logger("job_done", {
              job: job.name,
              durationMs: Date.now() - startedAt,
              attempt,
              result,
            });
            break;
          } catch (error) {
            if (attempt > job.maxRetries) {
              throw error;
            }
            this.logger("job_retry", {
              job: job.name,
              attempt,
              maxRetries: job.maxRetries,
              retryBackoffSec: job.retryBackoffSec,
              error: error instanceof Error ? error.message : String(error),
            });
            await delay(job.retryBackoffSec * 1000);
          }
        }
      } catch (error) {
        this.logger("job_error", {
          job: job.name,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running = false;
        if (job.lockKey) this.lockManager.release(job.lockKey);
        scheduleNext();
      }
    };

    void tick();
    this.logger("job_scheduled", {
      job: job.name,
      intervalSec: job.intervalSec,
      lockKey: job.lockKey ?? null,
      timeoutSec: job.timeoutSec,
      maxRetries: job.maxRetries,
      retryBackoffSec: job.retryBackoffSec,
      jitterSec: job.jitterSec,
    });
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
