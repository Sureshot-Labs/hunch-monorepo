import { createClient } from "redis";
import { registerRuntimeResourceCleanup } from "../runtime-resource-cleanup.js";
import {
  DataApiAdmissionError,
  LocalDataApiAdmissionBackend,
  PolymarketDataApiAdmission,
  type DataApiAdmission,
  type DataApiAdmissionBackend,
  type DataApiFeedback,
  type DataApiLane,
  type DataApiPermit,
} from "./polymarket-data-api-admission.js";
import { RedisDataApiAdmissionBackend } from "./polymarket-data-api-admission-redis.js";

// Sidecar-safe: intentionally no API env/db imports or connection at import time.
export class RuntimeDataApiAdmissionBackend implements DataApiAdmissionBackend {
  constructor(
    private readonly testCoordinator?: () => Promise<DataApiAdmissionBackend | null>,
    private readonly configured = () => !!process.env.REDIS_URL?.trim(),
    private readonly now = Date.now,
  ) {}
  private client: ReturnType<typeof createClient> | null = null;
  private connecting: Promise<RedisDataApiAdmissionBackend | null> | null =
    null;
  private retryAt = 0;
  private readonly local = new LocalDataApiAdmissionBackend();
  private readonly owners = new Map<string, DataApiAdmissionBackend>();
  private readonly knownCooldowns = new Map<string, number>();
  private async coordinator(): Promise<DataApiAdmissionBackend | null> {
    if (this.testCoordinator) return this.testCoordinator();
    const url = process.env.REDIS_URL?.trim();
    if (!url || Date.now() < this.retryAt) return null;
    if (this.client?.isReady)
      return new RedisDataApiAdmissionBackend(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = createClient({
        url,
        socket: { connectTimeout: 500, reconnectStrategy: false },
        disableOfflineQueue: true,
      });
      client.on("error", () => {});
      try {
        await this.bounded(client.connect());
        this.client = client;
        registerRuntimeResourceCleanup(
          "polymarket-data-api-admission",
          async () => {
            if (client.isOpen) client.destroy();
          },
        );
        return new RedisDataApiAdmissionBackend(client);
      } catch {
        if (client.isOpen) client.destroy();
        this.retryAt = Date.now() + 1000;
        return null;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("data_api_coordinator_timeout")),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async acquire(input: DataApiPermit & { lane: DataApiLane; now: number }) {
    const redis = await this.coordinator();
    const key = input.origin + "|" + input.family;
    const known = this.knownCooldowns.get(key) ?? 0;
    if (known > this.now()) {
      if (redis?.extendCooldown)
        try {
          await this.bounded(
            redis.extendCooldown(input, known - this.now(), this.now()),
          );
        } catch {
          // Retain the local deadline even if reconnect feedback is unavailable.
        }
      if (known > this.now())
        return {
          kind: "cooldown" as const,
          retryAfterMs: known - this.now(),
          basis: "upstream" as const,
        };
    }
    this.knownCooldowns.delete(key);
    if (redis) {
      try {
        const result = await this.bounded(redis.acquire(input));
        if (result.kind === "admitted") this.owners.set(input.id, redis);
        if (result.kind === "cooldown" && result.basis === "upstream") {
          // Any process that learned an actual shared Retry-After must retain
          // it during an outage, not only the process that received the 429.
          const observedNow = this.now();
          this.knownCooldowns.set(key, observedNow + result.retryAfterMs);
          await this.local.extendCooldown(
            input,
            result.retryAfterMs,
            observedNow,
          );
        }
        return result;
      } catch {
        if (this.client?.isOpen) this.client.destroy();
        this.client = null;
        this.retryAt = Date.now() + 1000;
      }
    }
    // Do not let a background fanout amplify an outage of shared coordination.
    // Interactive reads have a bounded local fallback; reconnect is attempted
    // again after one second, never cached as permanent unavailability.
    if (input.lane === "background" && this.configured())
      throw new DataApiAdmissionError(1000, "coordination_unavailable");
    const result = await this.local.acquire(input);
    if (result.kind === "admitted") this.owners.set(input.id, this.local);
    return result;
  }
  async finish(
    permit: DataApiPermit,
    feedback: DataApiFeedback,
    now: number,
  ): Promise<number> {
    const backend = this.owners.get(permit.id);
    this.owners.delete(permit.id);
    let wait =
      feedback.kind === "limited" ? Math.max(feedback.retryAfterMs, 1000) : 0;
    try {
      if (backend)
        wait = Math.max(
          wait,
          await this.bounded(backend.finish(permit, feedback, now)),
        );
    } catch {
      if (this.client?.isOpen) this.client.destroy();
      this.client = null;
      this.retryAt = Date.now() + 1000;
      // An unacknowledged 429 must still get a conservative local delay.
    } finally {
      if (feedback.kind === "limited") {
        const key = permit.origin + "|" + permit.family;
        const observedNow = Math.max(now, this.now());
        this.knownCooldowns.set(
          key,
          Math.max(this.knownCooldowns.get(key) ?? 0, observedNow + wait),
        );
        await this.local.extendCooldown(permit, wait, observedNow);
      }
    }
    return wait;
  }
}
let override: DataApiAdmission | undefined;
const admission = new PolymarketDataApiAdmission(
  new RuntimeDataApiAdmissionBackend(),
);
export function getDataApiAdmission(): DataApiAdmission {
  return override ?? admission;
}
/** Explicit dependency boundary for offline tests; never inferred from NODE_ENV. */
export function replaceDataApiAdmissionForTests(
  value?: DataApiAdmission,
): DataApiAdmission | undefined {
  const previous = override;
  override = value;
  return previous;
}
