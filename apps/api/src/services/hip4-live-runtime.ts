// Sidecar-safe: no API env/auth/Redis singleton imports.
import { createClient } from "redis";
import type { Pool } from "pg";
import { DEFAULT_HIP4_READ_POLICY, type Hip4ReadMarket } from "@hunch/shared";
import { readHip4Policy, readHip4LiveOutcomes } from "./hip4-repository.js";
import { createHip4LiveBuffer, flushHip4Live } from "./hip4-live.js";
import { watchHip4Metadata } from "./hip4-metadata-stream.js";

export function startHip4LiveRuntime(
  pool: Pool,
  wake: () => void,
  redisUrl?: string,
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
  const diagnostics = {
    flushErrors: 0,
    publishErrors: 0,
    configuredRedis: Boolean(redisUrl),
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
  const tick = async () => {
    let nextMs = DEFAULT_HIP4_READ_POLICY.policyCheckMs;
    try {
      const current = await readHip4Policy(pool, "indexer");
      const { policy } = current;
      nextMs = Math.min(policy.streamFlushMs, policy.policyCheckMs);
      if (revision !== current.revision) {
        stream?.close();
        stream = undefined;
        buffer = undefined;
        revision = current.revision;
        selectedAt = 0;
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
                  policy.maxLiveOutcomes * 2 - 1,
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
        const selected = await readHip4LiveOutcomes(pool, policy, hot);
        buffer?.select(selected);
        stream?.setOutcomes(selected);
        selectedAt = Date.now();
      }
      const publish = async (market: Hip4ReadMarket) => {
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
        await flushHip4Live(pool, policy, current.revision, batch, publish);
        interruptedSince = undefined;
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
  active = tick();
  return {
    diagnostics,
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
