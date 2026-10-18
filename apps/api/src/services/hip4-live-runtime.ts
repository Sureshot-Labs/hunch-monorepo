// Sidecar-safe: no API env/auth/Redis singleton imports.
import { createClient } from "redis";
import { enqueueEmbedItems } from "@hunch/infra";
import type { RedisClientType } from "redis";
import type { Hip4CanonicalChange } from "./hip4-canonical-change.js";
import type { Pool } from "pg";
import { DEFAULT_HIP4_READ_POLICY, type Hip4ReadMarket } from "@hunch/shared";
import { readHip4Policy } from "./hip4-repository.js";
import { createHip4LiveBuffer, flushHip4Live } from "./hip4-live.js";
import { watchHip4Metadata } from "./hip4-metadata-stream.js";
import {
  createHip4VisibleBookDependencies,
  readHip4HotMarkets,
  refreshHip4VisibleBooks,
  selectHip4VisibleLiveOutcomes,
} from "./hip4-visible-books.js";

export function startHip4LiveRuntime(
  pool: Pool,
  wake: () => void,
  redisUrl?: string,
  options: { live?: boolean } = {},
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: ReturnType<typeof watchHip4Metadata> | undefined;
  let buffer: ReturnType<typeof createHip4LiveBuffer> | undefined;
  let revision: string | undefined;
  let redis: ReturnType<typeof createClient> | undefined;
  let active: Promise<void> | undefined;
  let interruptedSince: number | undefined;
  let selectedAt = 0;
  let booksAt = 0;
  let hotMarkets = new Map<number, Hip4ReadMarket>();
  const liveSelectedAt = new Map<number, number>();
  const bookAttemptedAt = new Map<number, number>();
  let requestTimeoutMs = DEFAULT_HIP4_READ_POLICY.requestTimeoutMs;
  const diagnostics = {
    flushErrors: 0,
    publishErrors: 0,
    embedInvalidations: 0,
    embedPublishErrors: 0,
    configuredRedis: Boolean(redisUrl),
    hotOutcomes: 0,
    visibleBooks: {
      cycles: 0,
      attempts: 0,
      refreshed: 0,
      failures: 0,
      budgetDenied: 0,
      deadlineReached: 0,
      policyChanges: 0,
      lastSelected: 0,
    },
    stream: undefined as
      | ReturnType<typeof watchHip4Metadata>["diagnostics"]
      | undefined,
    queue: undefined as
      | ReturnType<typeof createHip4LiveBuffer>["diagnostics"]
      | undefined,
  };
  const getRedis = () => {
    if (!redisUrl) return undefined;
    if (!redis) {
      redis = createClient({
        url: redisUrl,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: DEFAULT_HIP4_READ_POLICY.requestTimeoutMs,
          reconnectStrategy: false,
        },
      });
      redis.on("error", () => {
        diagnostics.publishErrors++;
      });
    }
    return redis;
  };
  const redisRequest = async <T>(
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            if (redis?.isOpen) redis.destroy();
            reject(new Error("redis_timeout"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const invalidateCanonical = async (
    change: Hip4CanonicalChange,
    timeoutMs = requestTimeoutMs,
  ) => {
    if (stopped) return;
    const client = getRedis();
    if (!client) {
      diagnostics.embedPublishErrors++;
      return;
    }
    try {
      if (!client.isOpen) await redisRequest(() => client.connect(), timeoutMs);
      await redisRequest(
        () =>
          enqueueEmbedItems(client as RedisClientType, [
            { entity_type: "market", market_id: change.marketId },
            ...change.eventIds.map((eventId) => ({
              entity_type: "event" as const,
              event_id: eventId,
            })),
          ]),
        timeoutMs,
      );
      diagnostics.embedInvalidations++;
    } catch {
      // Canonical state is already committed. Existing bounded reconciliation
      // is the recovery path; never report the market transaction as failed.
      diagnostics.embedPublishErrors++;
    }
  };
  const tick = async () => {
    let nextMs = DEFAULT_HIP4_READ_POLICY.policyCheckMs;
    try {
      const current = await readHip4Policy(pool, "indexer");
      const { policy } = current;
      requestTimeoutMs = policy.requestTimeoutMs;
      nextMs = Math.min(policy.streamFlushMs, policy.policyCheckMs);
      if (revision !== current.revision) {
        stream?.close();
        stream = undefined;
        buffer = undefined;
        revision = current.revision;
        selectedAt = 0;
        booksAt = 0;
        hotMarkets.clear();
        liveSelectedAt.clear();
        bookAttemptedAt.clear();
        if (
          policy.enabled &&
          (policy.catalogMode === "all" || policy.outcomeAllowlist.length)
        ) {
          buffer = createHip4LiveBuffer(policy, wake, interruptedSince);
          if (interruptedSince !== undefined) buffer.gap("flush_error");
          stream = watchHip4Metadata(policy, wake, undefined, buffer);
          diagnostics.stream = stream.diagnostics;
          diagnostics.queue = buffer.diagnostics;
        }
      }
      if (!policy.enabled || stopped) return;
      let hot: string[] = [];
      const client = getRedis();
      if (client && Date.now() - selectedAt >= policy.subscriptionRefreshMs) {
        try {
          if (!client.isOpen)
            await redisRequest(() => client.connect(), policy.requestTimeoutMs);
          hot = await redisRequest(
            () =>
              client
                .zRangeWithScores(
                  "hot:tokens:stream:hyperliquid",
                  0,
                  policy.maxHotOutcomes * 2 - 1,
                  { REV: true },
                )
                .then((rows) =>
                  rows
                    .filter(
                      (row) =>
                        row.score >= Date.now() - policy.hotDemandMaxAgeMs,
                    )
                    .map((row) => row.value),
                ),
            policy.requestTimeoutMs,
          );
        } catch {
          diagnostics.publishErrors++;
        }
      }
      if (stopped) return;
      if (Date.now() - selectedAt >= policy.subscriptionRefreshMs) {
        hotMarkets = new Map(
          (await readHip4HotMarkets(pool, policy, hot)).map((market) => [
            market.outcome,
            market,
          ]),
        );
        for (const state of [liveSelectedAt, bookAttemptedAt])
          for (const outcome of state.keys())
            if (!hotMarkets.has(outcome)) state.delete(outcome);
        diagnostics.hotOutcomes = hotMarkets.size;
        const selected = selectHip4VisibleLiveOutcomes(
          policy,
          [...hotMarkets.values()],
          liveSelectedAt,
          Date.now(),
        );
        for (const outcome of selected) liveSelectedAt.set(outcome, Date.now());
        buffer?.select(selected);
        stream?.setOutcomes(selected);
        selectedAt = Date.now();
      }
      const publish = async (market: Hip4ReadMarket) => {
        if (hotMarkets.has(market.outcome))
          hotMarkets.set(market.outcome, market);
        if (!client?.isReady) return;
        const latest = await readHip4Policy(pool, "indexer");
        if (stopped || !latest.policy.enabled || latest.revision !== revision)
          return;
        const multi = client.multi();
        for (const side of market.sides) {
          const ts = side.bookAt
            ? Date.parse(side.bookAt)
            : Date.parse(market.fetchedAt);
          const payload = JSON.stringify({
            token_id: side.tokenId,
            best_bid:
              side.bookState === "fresh" && side.bid !== null
                ? Number(side.bid)
                : null,
            best_ask:
              side.bookState === "fresh" && side.ask !== null
                ? Number(side.ask)
                : null,
            ts,
            valid_until: side.bookValidUntil,
            policy_revision: revision,
          });
          multi.set(`top:${side.tokenId}`, payload, {
            PX: policy.bookMaxAgeMs,
          });
          multi.publish(`prices:${side.tokenId}`, payload);
          multi.publish(
            `market_update:${side.tokenId}`,
            JSON.stringify({
              schema_version: 1,
              venue: "hyperliquid",
              token_id: side.tokenId,
              market_id: market.marketId,
              event_id: market.eventId,
              status: market.status,
              accepting_orders: false,
              ts,
            }),
          );
        }
        try {
          await redisRequest(() => multi.exec(), policy.requestTimeoutMs);
        } catch {
          diagnostics.publishErrors++;
        }
      };
      if (buffer && policy.liveEnabled) {
        const batch = buffer.take();
        interruptedSince ??= batch.since;
        await flushHip4Live(
          pool,
          policy,
          current.revision,
          batch,
          publish,
          Date.now(),
          invalidateCanonical,
        );
        interruptedSince = undefined;
      }
      if (
        policy.liveEnabled &&
        Date.now() - booksAt >= policy.visibleBookRefreshMs
      ) {
        booksAt = Date.now();
        const result = await refreshHip4VisibleBooks(
          policy,
          current.revision,
          [...hotMarkets.values()],
          bookAttemptedAt,
          publish,
          createHip4VisibleBookDependencies(pool, policy, invalidateCanonical),
        );
        diagnostics.visibleBooks.cycles++;
        diagnostics.visibleBooks.attempts += result.attempts;
        diagnostics.visibleBooks.refreshed += result.refreshed;
        diagnostics.visibleBooks.failures += result.failures;
        diagnostics.visibleBooks.budgetDenied += result.budgetDenied;
        diagnostics.visibleBooks.deadlineReached += Number(
          result.deadlineReached,
        );
        diagnostics.visibleBooks.policyChanges += Number(result.policyChanged);
        diagnostics.visibleBooks.lastSelected = result.selected;
      }
    } catch {
      diagnostics.flushErrors++;
      interruptedSince ??= Date.now();
      buffer?.gap("flush_error");
      stream?.close();
      stream = undefined;
      revision = undefined;
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          active = tick();
        }, nextMs);
    }
  };
  if (options.live !== false) active = tick();
  return {
    diagnostics,
    invalidateCanonical,
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      stream?.close();
      if (redis?.isOpen) redis.destroy();
      await active;
      if (redis?.isOpen) redis.destroy();
    },
  };
}
