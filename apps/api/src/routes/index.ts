import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { dflowPrivateRoutes } from "./dflow-private.js";
import { eventRoutes } from "./events.js";
import { executionsRoutes } from "./executions.js";
import { feedRoutes } from "./feed.js";
import { healthRoutes } from "./health.js";
import { kalshiPrivateRoutes } from "./kalshi-private.js";
import { marketRoutes } from "./markets.js";
import { metaRoutes } from "./meta.js";
import { metricsRoutes } from "./metrics.js";
import { orderRoutes } from "./orders.js";
import { positionsRoutes } from "./positions.js";
import { pricesSseRoutes } from "./prices-sse.js";
import { polymarketPrivateRoutes } from "./polymarket-private.js";
import { polymarketProxyRoutes } from "./polymarket-proxy.js";
import { solanaRoutes } from "./solana.js";
import { watchlistRoutes } from "./watchlist.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(metricsRoutes);
  await app.register(healthRoutes);
  await app.register(metaRoutes);
  await app.register(authRoutes);
  await app.register(dflowPrivateRoutes);
  await app.register(kalshiPrivateRoutes);
  await app.register(polymarketPrivateRoutes);
  await app.register(polymarketProxyRoutes);
  await app.register(solanaRoutes);
  await app.register(pricesSseRoutes);
  await app.register(feedRoutes);
  await app.register(marketRoutes);
  await app.register(eventRoutes);
  await app.register(executionsRoutes);
  await app.register(positionsRoutes);
  await app.register(orderRoutes);
  await app.register(watchlistRoutes);
}
