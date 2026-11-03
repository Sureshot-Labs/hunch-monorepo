import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type DataApiLane = "interactive" | "background";
const lanes = new AsyncLocalStorage<DataApiLane>();
export const currentDataApiLane = (): DataApiLane =>
  lanes.getStore() ?? "interactive";
export const withDataApiLane = <T>(lane: DataApiLane, run: () => T): T =>
  lanes.run(lane, run);
export type DataApiPermit = {
  id: string;
  origin: string;
  family: string;
  epoch: number;
  expiresAt: number;
};
export type DataApiAdmissionReply =
  | { kind: "admitted"; epoch: number }
  | { kind: "wait"; retryAfterMs: number }
  | { kind: "cooldown"; retryAfterMs: number; basis: "upstream" | "probe" };
export type DataApiFeedback = {
  kind: "success" | "limited" | "other";
  retryAfterMs: number;
  jitter: number;
};
export interface DataApiAdmissionBackend {
  acquire(
    input: DataApiPermit & { lane: DataApiLane; now: number },
  ): Promise<DataApiAdmissionReply>;
  finish(
    permit: DataApiPermit,
    feedback: DataApiFeedback,
    now: number,
  ): Promise<number>;
  extendCooldown?(
    permit: DataApiPermit,
    retryAfterMs: number,
    now: number,
  ): Promise<void>;
}

/** Cancellation must not wait for a Redis command or a reconnect deadline. The
 * caller still owns completion/late-permit cleanup for the underlying task.
 */
export function awaitDataApiTask<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** Half the published positions allowance leaves headroom for other clients.
 * Four in-flight requests per endpoint, at most two background requests, leave
 * capacity for interactive reads. These are admission limits, not trade limits.
 */
export const DATA_API_ADMISSION = {
  generalSpacingMs: 20,
  endpointSpacingMs: 100,
  concurrency: 4,
  backgroundConcurrency: 2,
  baseBackoffMs: 1000,
  maxBackoffMs: 60000,
  stateTtlMs: 86400000,
} as const;

export class DataApiAdmissionError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly reason:
      | "shared_cooldown"
      | "admission_deadline"
      | "coordination_unavailable",
  ) {
    super(`Polymarket Data API admission: ${reason}`);
    this.name = "DataApiAdmissionError";
  }
}

export interface DataApiAdmission {
  acquire(
    url: URL,
    signal: AbortSignal,
    lane: DataApiLane,
    leaseMs: number,
  ): Promise<DataApiPermit>;
  finish(
    permit: DataApiPermit,
    feedback: Omit<DataApiFeedback, "jitter">,
  ): Promise<number>;
}

export function dataApiFamily(path: string): string {
  if (/^\/v2\/positions(?:\/|$)/.test(path)) return "positions";
  if (/^\/v2\/activity(?:\/|$)/.test(path)) return "activity";
  return path.split("/")[2] || "other";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export class PolymarketDataApiAdmission implements DataApiAdmission {
  constructor(
    private readonly backend: DataApiAdmissionBackend,
    private readonly now = Date.now,
    private readonly delay = abortableDelay,
    private readonly random = Math.random,
  ) {}
  async acquire(
    url: URL,
    signal: AbortSignal,
    lane: DataApiLane,
    leaseMs: number,
  ): Promise<DataApiPermit> {
    const permit = {
      id: randomUUID(),
      origin: url.origin,
      family: dataApiFamily(url.pathname),
      epoch: 0,
      expiresAt: this.now() + Math.min(120000, Math.max(1, leaseMs)) + 1000,
    };
    for (;;) {
      signal.throwIfAborted();
      const pending = this.backend.acquire({
        ...permit,
        lane,
        now: this.now(),
      });
      let reply: DataApiAdmissionReply;
      try {
        reply = await awaitDataApiTask(pending, signal);
      } catch (error) {
        void pending
          .then((late) =>
            late.kind === "admitted"
              ? this.finish(
                  { ...permit, epoch: late.epoch },
                  { kind: "other", retryAfterMs: 0 },
                )
              : undefined,
          )
          .catch(() => {});
        throw error;
      }
      if (reply.kind === "admitted") {
        const admitted = { ...permit, epoch: reply.epoch };
        if (signal.aborted) {
          void this.finish(admitted, { kind: "other", retryAfterMs: 0 }).catch(
            () => {},
          );
          signal.throwIfAborted();
        }
        return admitted;
      }
      if (reply.kind === "cooldown")
        throw new DataApiAdmissionError(reply.retryAfterMs, "shared_cooldown");
      if (this.now() >= permit.expiresAt)
        throw new DataApiAdmissionError(
          reply.retryAfterMs,
          "admission_deadline",
        );
      await this.delay(Math.max(1, Math.min(reply.retryAfterMs, 100)), signal);
    }
  }
  finish(
    permit: DataApiPermit,
    feedback: Omit<DataApiFeedback, "jitter">,
  ): Promise<number> {
    return this.backend.finish(
      permit,
      {
        ...feedback,
        jitter: Math.floor(Math.max(0, Math.min(1, this.random())) * 250),
      },
      this.now(),
    );
  }
}

type FamilyState = {
  epoch: number;
  failures: number;
  until: number;
  next: number;
  probe: string | null;
  leases: Map<string, { expiresAt: number; background: boolean }>;
};
/** Bounded process-local fallback. Redis-backed admission is used in production;
 * an unavailable coordinator must not become a permanent application outage.
 */
export class LocalDataApiAdmissionBackend implements DataApiAdmissionBackend {
  private readonly origins = new Map<
    string,
    { next: number; families: Map<string, FamilyState> }
  >();
  private state(origin: string, family: string) {
    let host = this.origins.get(origin);
    if (!host) {
      if (this.origins.size >= 32)
        this.origins.delete(this.origins.keys().next().value ?? "");
      host = { next: 0, families: new Map() };
      this.origins.set(origin, host);
    }
    let state = host.families.get(family);
    if (!state) {
      if (host.families.size >= 32)
        host.families.delete(host.families.keys().next().value ?? "");
      state = {
        epoch: 0,
        failures: 0,
        until: 0,
        next: 0,
        probe: null,
        leases: new Map(),
      };
      host.families.set(family, state);
    }
    return { host, state };
  }
  async acquire(
    input: DataApiPermit & { lane: DataApiLane; now: number },
  ): Promise<DataApiAdmissionReply> {
    const { host, state } = this.state(input.origin, input.family);
    for (const [id, lease] of state.leases)
      if (lease.expiresAt <= input.now) state.leases.delete(id);
    if (state.probe && !state.leases.has(state.probe)) state.probe = null;
    if (state.until > input.now)
      return {
        kind: "cooldown",
        retryAfterMs: state.until - input.now,
        basis: "upstream",
      };
    if (state.probe)
      return {
        kind: "cooldown",
        basis: "probe",
        retryAfterMs: Math.max(
          1,
          (state.leases.get(state.probe)?.expiresAt ?? input.now + 1000) -
            input.now,
        ),
      };
    const wait = Math.max(host.next, state.next) - input.now;
    if (wait > 0) return { kind: "wait", retryAfterMs: wait };
    const background = [...state.leases.values()].filter(
      (lease) => lease.background,
    ).length;
    if (
      state.leases.size >= DATA_API_ADMISSION.concurrency ||
      (input.lane === "background" &&
        background >= DATA_API_ADMISSION.backgroundConcurrency)
    )
      return { kind: "wait", retryAfterMs: 50 };
    state.leases.set(input.id, {
      expiresAt: input.expiresAt,
      background: input.lane === "background",
    });
    if (state.failures > 0) state.probe = input.id;
    host.next = input.now + DATA_API_ADMISSION.generalSpacingMs;
    state.next = input.now + DATA_API_ADMISSION.endpointSpacingMs;
    return { kind: "admitted", epoch: state.epoch };
  }
  async finish(
    permit: DataApiPermit,
    feedback: DataApiFeedback,
    now: number,
  ): Promise<number> {
    const { state } = this.state(permit.origin, permit.family);
    if (!state.leases.delete(permit.id)) return Math.max(0, state.until - now);
    if (feedback.kind === "limited") {
      if (permit.epoch === state.epoch || state.failures === 0)
        state.failures = Math.min(16, state.failures + 1);
      // Every actual 429 invalidates any older recovery probe, but concurrent
      // failures from one wave do not exponentially multiply the backoff.
      state.epoch++;
      const backoff = Math.min(
        DATA_API_ADMISSION.maxBackoffMs,
        DATA_API_ADMISSION.baseBackoffMs * 2 ** (state.failures - 1),
      );
      state.until = Math.max(
        state.until,
        now +
          Math.max(
            feedback.retryAfterMs,
            Math.ceil(backoff * (1 + feedback.jitter / 1000)),
          ),
      );
    } else if (permit.epoch === state.epoch && state.probe === permit.id) {
      if (feedback.kind === "success") {
        state.failures = 0;
        state.until = 0;
        state.epoch++;
      } else state.until = now + DATA_API_ADMISSION.baseBackoffMs;
    }
    if (state.probe === permit.id) state.probe = null;
    return Math.max(0, state.until - now);
  }
  async extendCooldown(
    permit: DataApiPermit,
    retryAfterMs: number,
    now: number,
  ): Promise<void> {
    const { state } = this.state(permit.origin, permit.family);
    if (now + retryAfterMs > state.until) {
      state.until = now + retryAfterMs;
      state.failures = Math.max(1, state.failures);
      state.epoch++;
    }
  }
}
