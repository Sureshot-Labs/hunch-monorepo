import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getRedis } from "../redis.js";
import { pricesStreamQuerySchema } from "../schemas/prices-sse.js";

/**
 * GET /prices/stream
 * Query:
 *  - token_id: string | comma-separated list | repeated param
 * Streams initial snapshots (if any) + live ticks from Redis pub/sub.
 */
export const pricesSseRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

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

      const sub = r.duplicate();
      await sub.connect();

      const channels = ids.map((id) => `prices:${id}`);
      const send = (evt: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${evt}\n`);
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client closed mid-write */
        }
      };

      // send current snapshots if present
      for (const id of ids) {
        try {
          const snap = await r.get(`book:${id}`);
          if (snap) send("snapshot", JSON.parse(snap));
        } catch {
          // ignore malformed cache entries
        }
      }

      // subscribe to live ticks
      for (const ch of channels) {
        await sub.subscribe(ch, (message: string) => {
          try {
            send("tick", JSON.parse(message));
          } catch {
            // ignore malformed pubsub events
          }
        });
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
      request.raw.on("close", async () => {
        clearInterval(hb);
        try {
          for (const ch of channels) await sub.unsubscribe(ch);
        } catch {
          // ignore; best-effort cleanup
        }
        try {
          await sub.quit();
        } catch {
          sub.disconnect();
        }
      });
    },
  );
};
