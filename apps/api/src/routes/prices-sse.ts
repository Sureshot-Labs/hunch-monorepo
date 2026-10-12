import type { FastifyPluginAsync } from "fastify";
import { isHip4CanaryId } from "@hunch/shared";
import { createAdminMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { readHip4Policy } from "../services/hip4-repository.js";
import { hip4KnownStreamTokensAllowed } from "../services/hip4-stream-access.js";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../env.js";
import { getRedisStatus } from "../redis.js";
import {
  acquireDistributedSlot,
  checkRateLimit,
  releaseDistributedSlot,
} from "../lib/rate-limit.js";
import { resolveSecurityClientIp } from "../lib/request-ip.js";
import { markHotTokens, markStreamHotTokens } from "../lib/hot-tokens.js";
import { pricesStreamQuerySchema } from "../schemas/prices-sse.js";
import {
  subscribeToMarketStates,
  subscribeToMarketUpdates,
  subscribeToPriceTicks,
} from "../lib/prices-stream-manager.js";

/**
 * GET /prices/stream
 * Query:
 *  - token_id: string | comma-separated list | repeated param
 * Streams initial snapshots (if any) + live ticks from Redis pub/sub.
 */
export const pricesSseRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const authorizeHip = createAdminMiddleware({
    requiredAdminPermission: "analytics:read",
  });
  const contexts = new WeakMap<
    object,
    Awaited<ReturnType<typeof readHip4Policy>>
  >();

  const parseJson = (raw: string): unknown | null => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  z.get(
    "/prices/stream",
    {
      schema: { querystring: pricesStreamQuerySchema },
      preHandler: async (request, reply) => {
        if (!request.query.token_id.some(isHip4CanaryId)) return;
        reply.header("Cache-Control", "private, no-store");
        await authorizeHip(request, reply);
        if (reply.sent) return;
        try {
          const context = await readHip4Policy(pool);
          if (
            !(await hip4KnownStreamTokensAllowed(
              pool,
              request.query.token_id,
              context.policy,
            ))
          )
            return reply.code(404).send({ error: "hip4_stream_unavailable" });
          contexts.set(request, context);
        } catch {
          return reply.code(503).send({ error: "hip4_read_unavailable" });
        }
      },
    },
    async (request, reply) => {
      const clientIp = resolveSecurityClientIp(request);
      const maxDurationSec = Math.max(30, env.pricesSseMaxDurationSec);
      const slotTtlMs = (maxDurationSec + 120) * 1000;
      const activeSlotKey = `sse:prices:active:${clientIp}`;

      const connectsPerMinuteLimit = env.pricesSseConnectsPerMinute;
      const canConnect = await checkRateLimit(
        `sse:prices:connect:${clientIp}`,
        connectsPerMinuteLimit,
        60_000,
        { onError: "fail_closed" },
      );
      if (!canConnect) {
        reply.code(429);
        return reply.send({
          error: "Too many stream connection attempts. Please retry later.",
        });
      }

      const maxConnectionsPerIp = env.pricesSseMaxConnectionsPerIp;
      const hasSlot = await acquireDistributedSlot(
        activeSlotKey,
        maxConnectionsPerIp,
        slotTtlMs,
        { onError: "fail_closed" },
      );
      if (!hasSlot) {
        reply.code(429);
        return reply.send({
          error: `Too many active price streams for this IP (max ${maxConnectionsPerIp}).`,
        });
      }

      const { redis: r, status } = await getRedisStatus();
      if (!r) {
        await releaseDistributedSlot(activeSlotKey, slotTtlMs);
        reply.code(503);
        return reply.send({
          error:
            status === "loading" ? "Redis loading, retry" : "Redis unavailable",
        });
      }

      let cleanedUp = false;
      let hb: NodeJS.Timeout | null = null;
      let sticky: NodeJS.Timeout | null = null;
      let sessionTimeout: NodeJS.Timeout | null = null;
      let hipPolicyTimer: NodeJS.Timeout | null = null;
      let hipAllowed = true;
      const hipContext = contexts.get(request);
      let unsubscribeTicks: (() => void) | null = null;
      let unsubscribeMarketState: (() => void) | null = null;
      let unsubscribeMarketUpdate: (() => void) | null = null;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (hb) clearInterval(hb);
        if (sticky) clearInterval(sticky);
        if (sessionTimeout) clearTimeout(sessionTimeout);
        if (hipPolicyTimer) clearTimeout(hipPolicyTimer);
        unsubscribeTicks?.();
        unsubscribeMarketState?.();
        unsubscribeMarketUpdate?.();
        void releaseDistributedSlot(activeSlotKey, slotTtlMs);
      };

      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);

      const ids = request.query.token_id;
      void markHotTokens({ tokenIds: ids });
      void markStreamHotTokens({ tokenIds: ids });

      // SSE headers
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader(
        "Cache-Control",
        hipContext ? "private, no-store" : "no-cache",
      );
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders();

      let writable = true;
      const send = (evt: string, data: unknown) => {
        if (request.raw.destroyed || !hipAllowed) return;
        if (!writable) return;
        try {
          const ok =
            reply.raw.write(`event: ${evt}\n`) &&
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          if (!ok) {
            writable = false;
            reply.raw.once("drain", () => {
              writable = true;
            });
          }
        } catch {
          /* client closed mid-write */
        }
      };

      if (hipContext) {
        const checkHipPolicy = async () => {
          try {
            const latest = await readHip4Policy(pool);
            hipAllowed =
              latest.revision === hipContext.revision &&
              (await hip4KnownStreamTokensAllowed(pool, ids, latest.policy));
          } catch {
            hipAllowed = false;
          }
          if (!hipAllowed) {
            reply.raw.end();
            cleanup();
          } else if (!cleanedUp)
            hipPolicyTimer = setTimeout(
              () => void checkHipPolicy(),
              hipContext.policy.policyCheckMs,
            );
        };
        hipPolicyTimer = setTimeout(
          () => void checkHipPolicy(),
          hipContext.policy.policyCheckMs,
        );
      }

      // Send current cached tops/snapshots if present.
      await Promise.all(
        ids.map(async (id) => {
          try {
            const top = await r.get(`top:${id}`);
            if (top) {
              const parsed = parseJson(top);
              if (parsed) send("tick", parsed);
            }
          } catch {
            // ignore malformed cache entries
          }

          try {
            const snap = await r.get(`book:${id}`);
            if (snap) send("snapshot", JSON.parse(snap));
          } catch {
            // ignore malformed cache entries
          }

          try {
            const state = await r.get(`market_state:${id}`);
            if (state) {
              const parsed = parseJson(state);
              if (parsed) send("market_state", parsed);
            }
          } catch {
            // ignore malformed cache entries
          }

          try {
            const update = await r.get(`market_update:${id}`);
            if (update) {
              const parsed = parseJson(update);
              if (parsed) send("market_update", parsed);
            }
          } catch {
            // ignore malformed cache entries
          }
        }),
      );

      try {
        unsubscribeTicks = await subscribeToPriceTicks(ids, (payload) => {
          send("tick", payload);
        });
      } catch (err) {
        request.log.warn({ err }, "prices SSE subscribe failed");
        send("error", { error: "Prices stream unavailable" });
        try {
          reply.raw.end();
        } catch {
          // ignore; connection may already be closed
        }
        cleanup();
        return;
      }

      try {
        unsubscribeMarketState = await subscribeToMarketStates(
          ids,
          (payload) => {
            send("market_state", payload);
          },
        );
      } catch (err) {
        request.log.warn({ err }, "market-state SSE subscribe failed");
      }

      try {
        unsubscribeMarketUpdate = await subscribeToMarketUpdates(
          ids,
          (payload) => {
            send("market_update", payload);
          },
        );
      } catch (err) {
        request.log.warn({ err }, "market-update SSE subscribe failed");
      }

      // Flush a body byte after subscriptions are ready. With an empty cache,
      // streaming proxies otherwise wait for the first 20-second heartbeat
      // before the browser observes an open canary connection.
      if (hipContext && !cleanedUp) reply.raw.write(":hip4-connected\n\n");

      // heartbeat so proxies don’t kill idle streams
      hb = setInterval(() => {
        try {
          reply.raw.write(":keepalive\n\n");
        } catch {
          // client closed; ignore
        }
      }, 20000);

      // Keep currently subscribed tokens sticky while the stream is open.
      const stickyMarkIntervalMs =
        Math.max(5, env.hotStreamMarkIntervalSec) * 1000;
      sticky = setInterval(() => {
        void markStreamHotTokens({ tokenIds: ids });
      }, stickyMarkIntervalMs);

      const maxDurationMs = maxDurationSec * 1000;
      sessionTimeout = setTimeout(() => {
        send("error", { error: "Stream session expired" });
        try {
          reply.raw.end();
        } catch {
          // best-effort close
        }
      }, maxDurationMs);
      if (typeof sessionTimeout.unref === "function") {
        sessionTimeout.unref();
      }
    },
  );
};
