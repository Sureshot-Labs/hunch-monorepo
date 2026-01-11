import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { env } from "../env.js";
import {
  evaluateGeoFence,
  type GeoFenceConfig,
} from "../lib/geo-fence.js";

export const tradePolicyRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const geoFenceConfig: GeoFenceConfig = {
    enabled: env.dflowGeoBlockEnabled,
    blockedCountries: env.dflowGeoBlockCountries,
    defaultPolicy: env.dflowGeoBlockDefault,
    trustProxy: env.trustProxy,
    proxySecret: env.proxySecret,
  };

  z.get("/trade/policies", async (request, reply) => {
    const kalshiDecision = evaluateGeoFence(request, geoFenceConfig);
    const kalshiBlocked = !kalshiDecision.allowed;
    const kalshiReason = kalshiBlocked
      ? kalshiDecision.reason
      : null;

    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      ok: true,
      policies: {
        kalshi: {
          tradingAllowed: !kalshiBlocked,
          reason: kalshiReason,
          country: kalshiDecision.country,
          source: geoFenceConfig.enabled ? "geo" : "disabled",
        },
      },
    });
  });
};
