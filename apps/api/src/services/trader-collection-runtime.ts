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
} from "../schemas/trader-collections.js";
import { resolveWalletIntelRefreshPolicy } from "./runtime-policies.js";
import {
  renewHolderResearchRunLock,
  releaseHolderResearchRunLock,
} from "./holder-research-run-lock.js";
import {
  assemble,
  candidates,
  priorityOrder,
  type CandidateMap,
  type Owner,
} from "./trader-collection-ranking.js";
import {
  collectEvidence,
  providerPages,
  type ActivityCache,
} from "./trader-collection-source.js";
import {
  SNAPSHOT_TTL,
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
type Build = {
  end: number;
  owners: Owner[];
  queue: number[];
  sets: CandidateMap[];
  categories: string[];
  attempts: number;
};
const progressKey = prefix + "build";
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
    AbortSignal.timeout(150000),
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
    let state: Build | null = raw
      ? JSON.parse(raw, (k, v) =>
          k === "priority" && Array.isArray(v) ? v.map(BigInt) : v,
        )
      : null;
    if (!state || now - state.end >= 600) {
      const last = await command(() => redis.get(prefix + collections[0]));
      if (last && Date.now() - Date.parse(JSON.parse(last).generatedAt) < 90000)
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
      state = {
        end: now,
        owners: shortlist,
        queue: shortlist.map((_, i) => (offset + i) % shortlist.length),
        sets: [],
        categories: [],
        attempts: 0,
      };
    }
    const { end, owners, sets } = state,
      cats = new Set(state.categories),
      retry: number[] = [];
    const addresses = new Set(owners.map((o) => o.address));
    for (const a of activities.keys())
      if (!addresses.has(a)) activities.delete(a);
    const queue = state.queue;
    let index = 0,
      errors = 0,
      providerRequests = 0;
    const reasons: Record<string, number> = {};
    const transport = providerPages(env.polymarketDataApiBase);
    const read: typeof transport = (...args) => {
      if (providerRequests >= 128) throw Error("cycle_request_budget");
      providerRequests++;
      return transport(...args);
    };
    async function consume() {
      while (!stop.aborted && providerRequests < 128 && index < queue.length) {
        const ordinal = queue[index++],
          o = owners[ordinal];
        const old = activities.get(o.address);
        if (old) {
          activities.delete(o.address);
          activities.set(o.address, old);
        }
        try {
          const e = await collectEvidence(
            o,
            end,
            read,
            (a, t, s) => repo.markets(a, t, s),
            AbortSignal.any([stop, AbortSignal.timeout(45000)]),
            activities,
          );
          for (const v of e.ledgers) cats.add(v.market.category);
          for (const v of e.supplemental ?? []) cats.add(v.category);
          for (const g of e.gaps)
            if (g !== "*" && g !== "outside_catalog") cats.add(g);
          // Position/activity windows are frozen across slices. Latest quotes
          // are observed separately and age against the actual observation time.
          const cs = candidates(
            e,
            end,
            undefined,
            Math.floor(Date.now() / 1000),
          );
          // Only one card per owner/segment can win. Bound the checkpoint, not the
          // number of source fills or the evidence used to choose that card.
          for (const k of collections) {
            const byCategory = new Map<string, (typeof cs)[typeof k][number]>();
            for (const choice of cs[k]) {
              const old = byCategory.get(choice.category);
              if (!old || priorityOrder(choice.priority, old.priority) < 0)
                byCategory.set(choice.category, choice);
            }
            cs[k] = [...byCategory.values()];
          }
          sets.push(cs);
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
          if (
            reason === "activity_checkpoint" ||
            reason === "cycle_request_budget" ||
            stop.aborted
          )
            retry.push(ordinal);
        } finally {
          trimActivityCache();
        }
      }
    }
    await Promise.all([consume(), consume()]);
    rotation = (rotation + index) % Math.max(1, owners.length);
    state.queue = [...queue.slice(index), ...retry];
    state.attempts += index;
    state.categories = [...cats];
    const action = traderSliceAction({
      stopped: signal.aborted,
      lostLease: lost.signal.aborted,
      cooling: cooldown.signal.aborted,
      remaining: state.queue.length,
      ageSeconds: Date.now() / 1000 - end,
      attempts: state.attempts,
      selected: owners.length,
      observed: sets.length,
    });
    if (action === "checkpoint") {
      const saved = await command(() =>
        redis.eval(TRADER_CHECKPOINT, {
          keys: [lock, progressKey],
          arguments: [
            owner,
            JSON.stringify(state, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
          ],
        }),
      );
      if (Number(saved) === 1 && !cooldown.signal.aborted)
        next = Date.now() + 15000;
      return;
    }
    // Explicit coverage on budget expiry. An actual provider cooldown, service
    // stop, empty observation or lost lease cannot replace a good snapshot.
    if (action === "retain") {
      console.warn(
        "[trader-collections] incomplete build; retaining previous version",
        { selected: owners.length, observed: sets.length, errors, reasons },
      );
      return;
    }
    const snapshots = assemble(
      sets,
      end,
      owner,
      owners.length,
      cats,
      Math.floor(Date.now() / 1000),
    );
    const published = await command(() =>
      redis.eval(TRADER_PUBLISH, {
        keys: [lock, ...collections.map((k) => prefix + k), progressKey],
        arguments: [
          owner,
          ...collections.map((k) => JSON.stringify(snapshots[k])),
          String(SNAPSHOT_TTL),
        ],
      }),
    );
    if (Number(published) === 1)
      console.info("[trader-collections] snapshot", {
        selected: owners.length,
        observed: sets.length,
        errors,
        reasons,
      });
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
      next = Date.now() + 90000;
      ongoing = cycle(signal)
        .catch(() => {
          console.warn("[trader-collections] refresh unavailable");
        })
        .finally(() => {
          ongoing = null;
        });
    }
  };
  timer = setInterval(run, 15000);
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
