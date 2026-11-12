import { randomUUID } from "node:crypto";
import { walletRecentCloses } from "./wallet-recent-closes-runtime.js";
import { pool } from "../db.js";
import { deflateRaw, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import {
  advanceLocalCalc,
  startLocalCalc,
  localEvidence,
  type LocalCalc,
} from "./trader-collection-local.js";
import { discardDedicatedRedis, getDedicatedRedis } from "../redis.js";
import { TraderRepository } from "../repos/trader-collections.js";
import { GlobalMoveRepository } from "../repos/trader-global-moves.js";
import { buildGlobalMoves } from "./trader-global-moves.js";
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
  SNAPSHOT_TTL,
  HANDOFF_SECONDS,
  TRADER_START,
  TRADER_SAVE_CALC,
  servingWindow,
  NORMAL_INTERVAL,
  SLICE_SECONDS,
  TICK_SECONDS,
  delayNewSweep,
  expediteNextSweep,
  replacementDue,
  TRADER_PUBLISH,
  shortlistPublication,
  TRADER_CHECKPOINT,
  traderRedisCommand,
  traderSliceAction,
} from "./trader-collection-service.js";

const prefix = "intel:trader-collections:local-v2:",
  movesPrefix = "intel:trader-collections:all-moves-v1:",
  lock = prefix + "lease",
  leaseMs = 60000;
const redisFor = (lane: string) =>
  getDedicatedRedis(lane, { connectDeadlineMs: 850 });
export async function loadTraderCollection(k: Collection) {
  const name = "trader-collections-read",
    redis = await redisFor(name);
  if (!redis) return null;
  const [raw, marker] = await traderRedisCommand(
    () =>
      redis.mGet(
        k === "big-moves"
          ? [movesPrefix + "ranked", movesPrefix + "preparing"]
          : [prefix + k, prefix + "preparing"],
      ),
    () => discardDedicatedRedis(name, redis),
    850,
  );
  return servingWindow(
    raw ? collectionSchema.parse(JSON.parse(raw)) : null,
    Number(marker),
    k,
    Math.floor(Date.now() / 1000),
  );
}
const progressKey = prefix + "build";
const pack = promisify(deflateRaw),
  unpack = promisify(inflateRaw);
let timer: ReturnType<typeof setInterval> | null = null,
  movesRunning: Promise<void> | null = null,
  ongoing: Promise<void> | null = null,
  stopper: AbortController | null = null,
  next = 0,
  rotation = 0;
async function globalMovesCycle(signal: AbortSignal) {
  const name = "trader-global-moves",
    redis = await redisFor(name);
  if (!redis || signal.aborted) return;
  const command = <T>(work: () => Promise<T>) =>
    traderRedisCommand(work, () => discardDedicatedRedis(name, redis));
  const owner = randomUUID(),
    key = movesPrefix + "lease",
    end = Math.floor(Date.now() / 1000);
  if (
    (await command(() => redis.set(key, owner, { NX: true, PX: 120000 }))) !==
    "OK"
  )
    return;
  const stop = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
  try {
    const prior = Number(
      await command(() => redis.get(movesPrefix + "preparing")),
    );
    if (prior > 0 && end - prior < NORMAL_INTERVAL) return;
    const save = (target: string, value: string) =>
      command(() =>
        redis.eval(TRADER_SAVE_CALC, {
          keys: [key, movesPrefix + target],
          arguments: [
            owner,
            String(end + SNAPSHOT_TTL + HANDOFF_SECONDS),
            value,
          ],
        }),
      );
    if (!Number(await save("preparing", String(end)))) return;
    const whale = await discoveryReadOnly(
      pool,
      async (c) =>
        (await resolveWalletIntelRefreshPolicy(c)).effective.whaleUsd,
    );
    const body = await buildGlobalMoves(
      new GlobalMoveRepository(pool),
      new TraderRepository(pool),
      end,
      owner,
      whale,
      stop,
    );
    stop.throwIfAborted();
    if (Number(await save("ranked", JSON.stringify(body))))
      console.info("[trader-global-moves] snapshot", {
        wallets: body.diagnostics?.selectedWallets,
        qualified: body.diagnostics?.qualifiedWallets,
        cards: body.groups.reduce((s, g) => s + g.items.length, 0),
        seconds: Date.now() / 1000 - end,
      });
  } finally {
    await command(() => releaseHolderResearchRunLock({ redis, key, owner }));
  }
}
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

  const stop = AbortSignal.any([
    signal,
    lost.signal,

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
    const retired = new Set<string>();
    const save = (encoded: string) =>
      command(() =>
        redis.eval(TRADER_CHECKPOINT, {
          keys: [lock, progressKey, ...retired],
          arguments: [owner, encoded],
        }),
      );
    let state = previous;
    if (!state || sweepExpired(state, now)) {
      const last = await command(() => redis.get(prefix + "top-earners-today"));
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
      const shortlist = await repo.owners(now, whale, 100),
        offset = rotation % Math.max(1, shortlist.length);
      state = createSweep(shortlist, now, offset, previous);
      state.previousSnapshotExpiresAt = expiresAt;
      const starting = encodeSweep(state);
      if (
        Number(
          await command(() =>
            redis.eval(TRADER_START, {
              keys: [lock, progressKey, prefix + "preparing"],
              arguments: [owner, starting, String(now), String(SNAPSHOT_TTL)],
            }),
          ),
        ) !== 1
      )
        return;
    }
    const sweep = state;
    const { end, owners } = sweep,
      cats = new Set(state.categories);
    let errors = 0,
      pages = 0;
    const reasons: Record<string, number> = {};
    const index = await visitSweepSlice(
      sweep,
      () => !stop.aborted && pages < 128,
      async (ordinal) => {
        const o = owners[ordinal],
          key = prefix + "calc:" + end + ":" + o.id;
        let scanning = true;
        try {
          const raw = await command(() => redis.get(key));
          const calc: LocalCalc = raw
            ? JSON.parse(
                (
                  await unpack(Buffer.from(raw, "base64"), {
                    maxOutputLength: 24 * 1024 * 1024,
                  })
                ).toString(),
              )
            : startLocalCalc(end);
          if (calc.end !== end) throw Error("wrong_local_window");
          for (let n = 0; n < 8 && !stop.aborted && pages < 128; n++) {
            pages++;
            const rows = await repo.localPage(o.id, calc.stamp, calc.id, end);
            advanceLocalCalc(calc, rows);
            if (rows.length < 1000) {
              scanning = false;
              const e = await localEvidence(calc, o, repo, stop);
              for (const leg of e.ledgers) cats.add(leg.market.category);
              recordEvaluation(
                sweep,
                ordinal,
                evaluateTrader(
                  e,
                  end,
                  undefined,
                  Math.floor(Date.now() / 1000),
                ),
              );
              retired.add(key);
              return "done";
            }
          }
          const body = JSON.stringify(calc);
          if (Buffer.byteLength(body) > 24 * 1024 * 1024)
            throw Error("wallet_page_capacity");
          const encoded = (await pack(body, { level: 1 })).toString("base64");
          if (encoded.length > 4 * 1024 * 1024)
            throw Error("wallet_page_capacity");
          if (
            !Number(
              await command(() =>
                redis.eval(TRADER_SAVE_CALC, {
                  keys: [lock, key],
                  arguments: [owner, String(end + SNAPSHOT_TTL), encoded],
                }),
              ),
            )
          )
            lost.abort();
          return "retry";
        } catch (err) {
          if (stop.aborted) return "retry";
          const why =
            err instanceof Error && err.message === "wallet_page_capacity"
              ? "wallet_page_capacity"
              : err instanceof Error && "code" in err && err.code === "57014"
                ? scanning
                  ? "local_activity_timeout"
                  : "market_lookup_timeout"
                : "source_unavailable";
          if (
            walletFailure(sweep, ordinal, why, why !== "wallet_page_capacity")
          )
            return "retry";
          errors++;
          reasons[why] = (reasons[why] ?? 0) + 1;
          retired.add(key);
          return "done";
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
      cooling: false,
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
      if (Number(saved) === 1 && pages > 0)
        console.info("[trader-collections] checkpoint", {
          pages,
          reasons,
          pending: sweep.queue.length,
        });
      if (Number(saved) === 1) next = Date.now() + 15000;
      return;
    }
    // Explicit coverage on budget expiry. An actual provider cooldown, service
    // stop, empty observation or lost lease cannot replace a good snapshot.
    if (action === "retain") {
      return;
    }
    if (action === "finish_without_publication") {
      retired.add(prefix + "preparing");
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
    if (!state.queue.length) retired.add(prefix + "preparing");
    state.publishedAt = finishedAt;
    const published = await command(() =>
      redis.eval(TRADER_PUBLISH, {
        keys: [
          lock,
          ...collections.map((k) => prefix + k),
          progressKey,
          ...retired,
        ],
        arguments: [
          owner,
          ...collections.map((k) => shortlistPublication(snapshots[k])),
          String(SNAPSHOT_TTL + HANDOFF_SECONDS),
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
        pages,
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
    if (!movesRunning && Date.now() >= nextMoves) {
      nextMoves = Date.now() + NORMAL_INTERVAL * 1000;
      movesRunning = globalMovesCycle(signal)
        .catch((e: unknown) =>
          console.warn("[trader-global-moves] refresh unavailable", {
            reason:
              e instanceof Error && "code" in e
                ? String(e.code)
                : "refresh_failed",
          }),
        )
        .finally(() => {
          movesRunning = null;
        });
    }
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
  let nextMoves = 0;
  timer = setInterval(run, TICK_SECONDS * 1000);
  timer.unref();
  run();
}
export async function stopTraderCollections() {
  if (timer) clearInterval(timer);
  timer = null;
  stopper?.abort();
  await Promise.all([ongoing, movesRunning, walletRecentCloses.stop()]);
}
