import { setImmediate as yieldLoop } from "node:timers/promises";

export type MarketQuote = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  tsMs: number;
  bookPayload?: unknown;
  alreadyPersisted?: boolean;
};
export function mergeMarketQuote(
  previous: MarketQuote,
  next: MarketQuote,
): MarketQuote {
  return {
    ...next,
    bookPayload: next.alreadyPersisted
      ? undefined
      : (next.bookPayload ?? previous.bookPayload),
  };
}

/** Quotes are replaceable state, unlike trades or lifecycle events. Keep one
 * pending latest value per token and serialize writes for each token. */
export class LatestQuoteQueue<T extends { tokenId: string; tsMs: number }> {
  private pending = new Map<string, { value: T; since: number }>();
  private running = new Map<string, number>();
  private scheduled = false;
  private idleWaiters: Array<() => void> = [];
  private coalesced = 0;
  private peak = 0;
  constructor(
    private readonly concurrency: number,
    private readonly write: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly merge: (previous: T, next: T) => T = (_previous, next) =>
      next,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Invalid quote concurrency");
  }
  push(value: T) {
    const previous = this.pending.get(value.tokenId);
    const newestTs = Math.max(
      previous?.value.tsMs ?? -Infinity,
      this.running.get(value.tokenId) ?? -Infinity,
    );
    if (value.tsMs < newestTs) return;
    if (previous) this.coalesced++;
    this.pending.set(value.tokenId, {
      value: previous ? this.merge(previous.value, value) : value,
      since: previous?.since ?? Date.now(),
    });
    this.peak = Math.max(this.peak, this.pending.size);
    this.schedule();
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
    });
  }
  private drain() {
    for (const [key, item] of this.pending) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(key)) continue;
      this.pending.delete(key);
      this.running.set(key, item.value.tsMs);
      void this.write(item.value)
        .catch(this.onError)
        .finally(() => {
          this.running.delete(key);
          if (this.pending.size) this.schedule();
          else if (!this.running.size)
            this.idleWaiters.splice(0).forEach((resolve) => resolve());
        });
    }
  }
  async idle() {
    if (!this.pending.size && !this.running.size) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
  metrics() {
    let oldestAt = Date.now();
    for (const item of this.pending.values())
      oldestAt = Math.min(oldestAt, item.since);
    return {
      pending: this.pending.size,
      running: this.running.size,
      coalesced: this.coalesced,
      peak: this.peak,
      oldestMs: Date.now() - oldestAt,
    };
  }
}

/** One initial frame per connection; dynamic updates wait for the send callback
 * (Bun acknowledges enqueue, not network flush). Yield between chunks so inbound
 * snapshots can be consumed.
 * Desired-set changes during a flush are reconciled, never silently truncated. */
export class MarketSubscriptions {
  readonly subscribed = new Set<string>();
  private desired = new Set<string>();
  private initialized = false;
  private resetting = false;
  private task: Promise<void> | null = null;
  private revision = 0;
  constructor(
    private readonly options: {
      chunkSize: number;
      customFeature: boolean;
      isOpen: () => boolean;
      send: (payload: string) => Promise<void>;
      onError: (error: unknown) => void;
    },
  ) {
    if (!Number.isInteger(options.chunkSize) || options.chunkSize < 1)
      throw new Error("Invalid subscription chunk size");
  }
  update(ids: string[]) {
    this.desired = new Set(ids);
    this.revision++;
    this.kick();
  }
  reset() {
    this.resetting = true;
    this.revision++;
    this.kick();
  }
  private kick() {
    if (this.task) return;
    const revision = this.revision;
    this.task = this.drain()
      .catch(this.options.onError)
      .finally(() => {
        this.task = null;
        if (revision !== this.revision && this.options.isOpen()) this.kick();
      });
  }
  private async drain() {
    while (this.options.isOpen()) {
      const removed = [...this.subscribed]
        .filter((id) => this.resetting || !this.desired.has(id))
        .slice(0, this.options.chunkSize);
      if (!removed.length) this.resetting = false;
      const added = removed.length
        ? []
        : [...this.desired]
            .filter((id) => !this.subscribed.has(id))
            .slice(0, this.options.chunkSize);
      if (!removed.length && !added.length) return;
      const first = !this.initialized && !removed.length;
      await this.options.send(
        JSON.stringify({
          assets_ids: removed.length ? removed : added,
          ...(first
            ? { type: "market" }
            : { operation: removed.length ? "unsubscribe" : "subscribe" }),
          ...(!removed.length
            ? { custom_feature_enabled: this.options.customFeature }
            : {}),
        }),
      );
      if (!this.options.isOpen()) return;
      if (removed.length) removed.forEach((id) => this.subscribed.delete(id));
      else {
        added.forEach((id) => this.subscribed.add(id));
        this.initialized = true;
      }
      await yieldLoop();
    }
  }
  async idle() {
    while (this.task) await this.task;
  }
}

export function reconnectAttempt(attempt: number, connectedMs: number): number {
  // A healthy minute spans six heartbeats and the normal subscription refresh.
  return connectedMs >= 60000 ? 0 : Math.min(attempt + 1, 5);
}

/** Partition the already capped desired set, without moving surviving tokens
 * when volume ranking changes. The per-connection bound is NOT a coverage cap. */
export class MarketSubscriptionShards {
  private owners = new Map<string, number>();
  private nextId = 0;
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("Invalid shard capacity");
  }
  update(ids: string[]): Map<number, string[]> {
    const desired = new Set(ids);
    const groups = new Map<number, string[]>();
    for (const [token, owner] of this.owners) {
      if (!desired.has(token)) {
        this.owners.delete(token);
        continue;
      }
      const group = groups.get(owner) ?? [];
      group.push(token);
      groups.set(owner, group);
    }
    for (const token of desired) {
      if (this.owners.has(token)) continue;
      let target: number | undefined;
      let targetGroup: string[] | undefined;
      for (const [id, group] of groups) {
        if (
          group.length < this.capacity &&
          (!targetGroup || group.length < targetGroup.length)
        ) {
          target = id;
          targetGroup = group;
        }
      }
      if (target === undefined || !targetGroup) {
        target = this.nextId++;
        targetGroup = [];
        groups.set(target, targetGroup);
      }
      targetGroup.push(token);
      this.owners.set(token, target);
    }
    return groups;
  }
}

/** Only exact market-wide lifecycle duplicates, never trades. Share in-flight
 * work; retain successful completions briefly. Failures remain retryable. */
export class MarketEventDeduper {
  private running = new Map<string, Promise<void>>();
  private completed = new Map<string, number>();
  constructor(
    private readonly ttlMs = 60_000,
    private readonly capacity = 4096,
  ) {}
  run(key: string, work: () => Promise<void>): Promise<void> {
    const now = Date.now();
    for (const [oldKey, at] of this.completed) {
      if (now - at < this.ttlMs && this.completed.size <= this.capacity) break;
      this.completed.delete(oldKey);
    }
    if (this.completed.has(key)) return Promise.resolve();
    const pending = this.running.get(key);
    if (pending) return pending;
    const task = Promise.resolve()
      .then(work)
      .then(() => {
        this.completed.set(key, Date.now());
        while (this.completed.size > this.capacity) {
          const oldest = this.completed.keys().next().value;
          if (oldest === undefined) break;
          this.completed.delete(oldest);
        }
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, task);
    return task;
  }
}
