import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { env } from "../env.js";
import { discardDedicatedRedis, getDedicatedRedis } from "../redis.js";
import { TraderRepository } from "../repos/trader-collections.js";
import { discoveryReadOnly } from "../repos/discovery.js";
import {
  collections,
  collectionSchema,
  type Collection,
  type SourceFailure,
} from "../schemas/trader-collections.js";
import { resolveWalletIntelRefreshPolicy } from "./runtime-policies.js";
import {
  renewHolderResearchRunLock,
  releaseHolderResearchRunLock,
} from "./holder-research-run-lock.js";
import { evaluateTrader } from "./trader-collection-ranking.js";
import {
  createSweep,
  decodeSweep,
  encodeSweep,
  progress,
  recordEvaluation,
  visitSweepSlice,
  sweepExpired,
  sweepSnapshots,
  walletFailure,
} from "./trader-collection-sweep.js";
import {
  collectEvidence,
  providerPages,
  type ActivityCache,
} from "./trader-collection-source.js";
import {
  SNAPSHOT_TTL,
  NORMAL_INTERVAL,
  SLICE_SECONDS,
  TICK_SECONDS,
  delayNewSweep,
  expediteNextSweep,
  replacementDue,
  TRADER_PUBLISH,
  TRADER_CHECKPOINT,
  traderRedisCommand,
  traderSliceAction,
} from "./trader-collection-service.js";
import { PolymarketDataApiV2Error } from "./polymarket-data-api-v2.js";

const prefix = "intel:trader-collections:v1:",
  lock = prefix + "lease",
  leaseMs = 60000;
const redisFor = (lane: string) =>
  getDedicatedRedis(lane, { connectDeadlineMs: 850 });
export async function loadTraderCollection(k: Collection) {
  const name = "trader-collections-read",
    redis = await redisFor(name);
  if (!redis) return null;
  const raw = await traderRedisCommand(
    () => redis.get(prefix + k),
    () => discardDedicatedRedis(name, redis),
    850,
  );
  return raw ? collectionSchema.parse(JSON.parse(raw)) : null;
}
const activities = new Map<string, ActivityCache>();
const progressKey = prefix + "build:v2";
function trimActivityCache() {
  // Oldest wallet first. Eviction loses only a speed-up, never published facts.
  let rows = 0;
  for (const [key, c] of [...activities].reverse()) {
    rows +=
      c.rows.length +
      (c.pending?.rows.length ?? 0) +
      [...(c.carry?.values() ?? [])].reduce((n, v) => n + v.rows.length, 0);
    if (rows > 60000) activities.delete(key);
  }
}
let timer: ReturnType<typeof setInterval> | null = null,
  ongoing: Promise<void> | null = null,
  stopper: AbortController | null = null,
  next = 0,
  rotation = 0;
async function cycle(signal: AbortSignal) {
  const name = "trader-collections-writer",
    redis = await redisFor(name);
  if (!redis || signal.aborted) return;
  const command = <T>(work: () => Promise<T>) =>
    traderRedisCommand(work, () => discardDedicatedRedis(name, redis));
  const owner = randomUUID();
  if (
    (await command(() => redis.set(lock, owner, { NX: true, PX: leaseMs }))) !==
    "OK"
  )
    return;
  const lost = new AbortController();
  const cooldown = new AbortController();
  const stop = AbortSignal.any([
    signal,
    lost.signal,
    cooldown.signal,
    AbortSignal.timeout(SLICE_SECONDS * 1000),
  ]);
  const renewal = setInterval(() => {
    void command(() =>
      renewHolderResearchRunLock({
        redis,
        key: lock,
        owner,
        ttlMs: leaseMs,
      }),
    ).then(
      (ok) => {
        if (!ok) lost.abort();
      },
      () => lost.abort(),
    );
  }, 15000);
  try {
    const repo = new TraderRepository(pool),
      now = Math.floor(Date.now() / 1000);
    const raw = await command(() => redis.get(progressKey));
    const previous = raw ? decodeSweep(raw) : undefined;
    const save = (encoded: string) =>
      command(() =>
        redis.eval(TRADER_CHECKPOINT, {
          keys: [lock, progressKey],
          arguments: [owner, encoded],
        }),
      );
    let state = previous;
    if (!state || sweepExpired(state, now)) {
      const last = await command(() => redis.get(prefix + collections[0]));
      const prior = last ? JSON.parse(last) : null;
      const expiresAt = prior
        ? Date.parse(prior.windowEnd) / 1000 + SNAPSHOT_TTL
        : 0;
      if (
        !state &&
        prior &&
        delayNewSweep(Date.parse(prior.generatedAt) / 1000, expiresAt, now)
      )
        return;
      stop.throwIfAborted();
      const whale = await discoveryReadOnly(
        pool,
        async (c) =>
          (await resolveWalletIntelRefreshPolicy(c)).effective.whaleUsd,
      );
      stop.throwIfAborted();
      const shortlist = await repo.owners(now, whale),
        offset = rotation % Math.max(1, shortlist.length);
      state = createSweep(shortlist, now, offset, previous);
      state.previousSnapshotExpiresAt = expiresAt;
      if (Number(await save(encodeSweep(state))) !== 1) return;
    }
    const sweep = state;
    const { end, owners } = sweep,
      cats = new Set(state.categories);
    const addresses = new Set(owners.map((o) => o.address));
    for (const a of activities.keys())
      if (!addresses.has(a)) activities.delete(a);
    let errors = 0,
      providerRequests = 0;
    const reasons: Record<string, number> = {};
    const transport = providerPages(env.polymarketDataApiBase);
    const read: typeof transport = (...args) => {
      if (providerRequests >= 128) throw Error("cycle_request_budget");
      providerRequests++;
      return transport(...args);
    };
    const index = await visitSweepSlice(
      sweep,
      () => !stop.aborted && providerRequests < 128,
      async (ordinal) => {
        const o = owners[ordinal];
        const old = activities.get(o.address);
        if (old) {
          activities.delete(o.address);
          activities.set(o.address, old);
        }
        const walletTimer = AbortSignal.timeout(45000);
        try {
          const e = await collectEvidence(
            o,
            end,
            read,
            (a, t, s) => repo.markets(a, t, s),
            AbortSignal.any([stop, walletTimer]),
            activities,
          );
          for (const v of e.ledgers) cats.add(v.market.category);
          for (const v of e.supplemental ?? []) cats.add(v.category);
          for (const g of e.gaps)
            if (g !== "*" && g !== "outside_catalog") cats.add(g);
          // Position/activity windows are frozen across slices. Latest quotes
          // are observed separately and age against the actual observation time.
          const evaluation = evaluateTrader(
            e,
            end,
            undefined,
            Math.floor(Date.now() / 1000),
          );
          // Only one card per owner/segment can win. Bound the checkpoint, not the
          // number of source fills or the evidence used to choose that card.
          recordEvaluation(sweep, ordinal, evaluation);
          return "done";
        } catch (err) {
          errors++;
          const reason =
            err instanceof PolymarketDataApiV2Error
              ? `provider_${err.status}`
              : err instanceof Error &&
                  /^(activity_checkpoint|wallet_activity_capacity|incomplete_pages|repeated_cursor|owner_mismatch|wallet_request_budget|cycle_request_budget)$/.test(
                    err.message,
                  )
                ? err.message
                : "unavailable";
          reasons[reason] = (reasons[reason] ?? 0) + 1;
          if (
            err instanceof PolymarketDataApiV2Error &&
            err.reason === "invalid_cursor"
          ) {
            const entry = activities.get(o.address);
            if (entry) delete entry.pending;
          }
          if (
            err instanceof PolymarketDataApiV2Error &&
            (err.status === 429 ||
              (err.status === 503 && err.retryAfterMs !== null) ||
              err.reason === "coordination_unavailable")
          ) {
            next = Math.max(
              next,
              Date.now() + Math.max(30000, err.retryAfterMs ?? 0),
            );
            cooldown.abort();
          }
          if (reason === "cycle_request_budget" || stop.aborted) {
            return reason === "cycle_request_budget"
              ? "shared_budget"
              : "retry";
          } else {
            const why: SourceFailure = walletTimer.aborted
              ? "wallet_timeout"
              : err instanceof PolymarketDataApiV2Error
                ? err.reason === "invalid_cursor"
                  ? "invalid_cursor"
                  : "provider_error"
                : reason === "incomplete_pages" ||
                    reason === "owner_mismatch" ||
                    reason === "repeated_cursor" ||
                    reason === "wallet_request_budget" ||
                    reason === "wallet_activity_capacity"
                  ? reason
                  : "source_unavailable";
            const transient =
              why === "wallet_timeout" ||
              why === "invalid_cursor" ||
              why === "source_unavailable" ||
              (err instanceof PolymarketDataApiV2Error && err.retryable);
            return walletFailure(sweep, ordinal, why, transient)
              ? "retry"
              : "done";
          }
        } finally {
          trimActivityCache();
        }
      },
    );
    rotation = (rotation + index) % Math.max(1, owners.length);
    state.categories = [...cats];
    const finishedAt = Math.floor(Date.now() / 1000);
    const observed = Object.keys(state.evaluated).length;
    const decision = traderSliceAction({
      stopped: signal.aborted,
      lostLease: lost.signal.aborted,
      cooling: cooldown.signal.aborted,
      remaining: state.queue.length,
      sincePublication: finishedAt - (state.publishedAt || end),
      replaceExpiring:
        !state.publishedAt &&
        replacementDue(state.previousSnapshotExpiresAt, finishedAt),
      selected: owners.length,
      observed,
    });
    const action =
      decision === "publish" && sweepExpired(state, finishedAt)
        ? state.queue.length
          ? "checkpoint"
          : "finish_without_publication"
        : decision;
    if (action === "checkpoint") {
      const saved = await save(encodeSweep(state));
      if (Number(saved) === 1 && !cooldown.signal.aborted)
        next = Date.now() + 15000;
      return;
    }
    // Explicit coverage on budget expiry. An actual provider cooldown, service
    // stop, empty observation or lost lease cannot replace a good snapshot.
    if (action === "retain") {
      return;
    }
    if (action === "finish_without_publication") {
      if (Number(await save("")) === 1) {
        if (expediteNextSweep(observed, end, finishedAt)) next = Date.now();
        console.warn(
          "[trader-collections] sweep finished without a servable observation",
          { ...progress(state), errors, reasons },
        );
      }
      return;
    }
    const snapshots = sweepSnapshots(state, owner, finishedAt);
    state.publishedAt = finishedAt;
    const published = await command(() =>
      redis.eval(TRADER_PUBLISH, {
        keys: [lock, ...collections.map((k) => prefix + k), progressKey],
        arguments: [
          owner,
          ...collections.map((k) => JSON.stringify(snapshots[k])),
          String(SNAPSHOT_TTL),
          state.queue.length ? encodeSweep(state) : "",
        ],
      }),
    );
    if (Number(published) === 1) {
      if (state.queue.length) next = Date.now() + TICK_SECONDS * 1000;
      else if (expediteNextSweep(observed, end, finishedAt)) next = Date.now();
      console.info("[trader-collections] snapshot", {
        selected: owners.length,
        observed,
        coverage: progress(state),
        errors,
        reasons,
      });
    }
  } finally {
    clearInterval(renewal);
    await command(() =>
      releaseHolderResearchRunLock({ redis, key: lock, owner }),
    );
  }
}
export function startTraderCollections() {
  if (timer) return;
  stopper = new AbortController();
  const signal = stopper.signal;
  const run = () => {
    if (!ongoing && Date.now() >= next) {
      next = Date.now() + NORMAL_INTERVAL * 1000;
      ongoing = cycle(signal)
        .catch(() => {
          console.warn("[trader-collections] refresh unavailable");
        })
        .finally(() => {
          ongoing = null;
        });
    }
  };
  timer = setInterval(run, TICK_SECONDS * 1000);
  timer.unref();
  run();
}
export async function stopTraderCollections() {
  if (timer) clearInterval(timer);
  timer = null;
  stopper?.abort();
  await ongoing;
  activities.clear();
}
