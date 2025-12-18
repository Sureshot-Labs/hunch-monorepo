import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { eventRoutes } from "./events.js";
import { feedRoutes } from "./feed.js";
import { healthRoutes } from "./health.js";
import { marketRoutes } from "./markets.js";
import { metaRoutes } from "./meta.js";
import { metricsRoutes } from "./metrics.js";
import { orderRoutes } from "./orders.js";
import { pricesSseRoutes } from "./prices-sse.js";
import { polymarketProxyRoutes } from "./polymarket-proxy.js";
import { watchlistRoutes } from "./watchlist.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(metricsRoutes);
  await app.register(healthRoutes);
  await app.register(metaRoutes);
  await app.register(authRoutes);
  await app.register(polymarketProxyRoutes);
  await app.register(pricesSseRoutes);
  await app.register(feedRoutes);
  await app.register(marketRoutes);
  await app.register(eventRoutes);
  await app.register(orderRoutes);
  await app.register(watchlistRoutes);
}
