import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getRedis } from "../redis.js";
import { pricesStreamQuerySchema } from "../schemas/prices-sse.js";
import { subscribeToPriceTicks } from "../lib/prices-stream-manager.js";

/**
 * GET /prices/stream
 * Query:
 *  - token_id: string | comma-separated list | repeated param
 * Streams initial snapshots (if any) + live ticks from Redis pub/sub.
 */
export const pricesSseRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const parseJson = (raw: string): unknown | null => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  z.get(
    "/prices/stream",
    { schema: { querystring: pricesStreamQuerySchema } },
    async (request, reply) => {
      const r = await getRedis();
      if (!r) {
        reply.code(503);
        return reply.send({ error: "Redis not configured" });
      }

      const ids = request.query.token_id;

      // SSE headers
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders();

      let writable = true;
      const send = (evt: string, data: unknown) => {
        if (request.raw.destroyed) return;
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
        }),
      );

      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = await subscribeToPriceTicks(ids, (payload) => {
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
        return;
      }

      // heartbeat so proxies don’t kill idle streams
      const hb = setInterval(() => {
        try {
          reply.raw.write(":keepalive\n\n");
        } catch {
          // client closed; ignore
        }
      }, 20000);

      // cleanup
      request.raw.on("close", () => {
        clearInterval(hb);
        unsubscribe?.();
      });
    },
  );
};
