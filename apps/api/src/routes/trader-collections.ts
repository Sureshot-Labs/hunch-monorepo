import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  collections,
  collectionSchema,
  querySchema,
} from "../schemas/trader-collections.js";
import {
  readCollection,
  type LoadCollection,
} from "../services/trader-collection-service.js";
export function createTraderCollectionRoutes(
  load: LoadCollection,
  now = Date.now,
): FastifyPluginAsync {
  return async (app) => {
    for (const k of collections)
      app.withTypeProvider<ZodTypeProvider>().get(
        "/intel/traders/" + k,
        {
          schema: {
            tags: ["Intel"],
            summary: "Prepared Polymarket trader collection: " + k,
            querystring: querySchema,
            response: {
              200: collectionSchema,
              304: z.null().optional(),
              503: z.object({
                code: z.literal("intel_snapshot_unavailable"),
                error: z.string(),
              }),
            },
          },
        },
        async (req, reply) => {
          const page = await readCollection(
            load,
            k,
            req.query.category,
            Math.floor(now() / 1000),
          ).catch(() => null);
          if (!page)
            return reply
              .header("Cache-Control", "no-store")
              .header("Retry-After", "30")
              .code(503)
              .send({
                code: "intel_snapshot_unavailable",
                error: "No usable trader snapshot.",
              });
          reply
            .header("ETag", page.etag)
            .header("Cache-Control", "public, max-age=0, must-revalidate");
          if (
            req.headers["if-none-match"]
              ?.split(",")
              .some(
                (tag) =>
                  tag.trim() === "*" ||
                  tag.trim().replace(/^W\//, "") === page.etag,
              )
          )
            return reply.code(304).send(undefined);
          return page.response;
        },
      );
  };
}
