import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  discoveryErrorSchema,
  discoveryQuerySchema,
  discoveryQuickQuerySchema,
  discoveryResponseSchema,
  discoverySections,
  type DiscoveryQuery,
  type DiscoveryResponse,
  type DiscoverySection,
} from "../schemas/discovery.js";
import { DiscoveryError } from "../services/discovery-domain.js";
import { z } from "zod";

/** Public, read-only discovery. No auth/session creation, inference, or order side effects. */
export function createDiscoveryRoutes(service: {
  read(
    section: DiscoverySection,
    query: DiscoveryQuery,
  ): Promise<DiscoveryResponse>;
}): FastifyPluginAsync {
  return async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    for (const section of discoverySections) {
      typed.get(
        `/discovery/${section}`,
        {
          schema: {
            tags: ["Discovery"],
            summary: `Prepared ${section} markets with live eligibility checks`,
            querystring:
              section === "quick-wins"
                ? discoveryQuickQuerySchema
                : discoveryQuerySchema,
            response: {
              200: discoveryResponseSchema,
              400: z.object({ error: z.string(), code: z.string().optional() }),
              409: discoveryErrorSchema,
              503: discoveryErrorSchema,
            },
          },
        },
        async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          try {
            return await service.read(section, request.query);
          } catch (error) {
            if (!(error instanceof DiscoveryError)) throw error;
            if (error.statusCode === 503) reply.header("Retry-After", "15");
            return reply
              .code(error.statusCode)
              .send({ error: error.message, code: error.code });
          }
        },
      );
    }
  };
}
