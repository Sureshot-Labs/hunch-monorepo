import type { FastifyInstance } from "fastify";
import { analyticsRoutes } from "./analytics.js";
import { accountValueRoutes } from "./account-value.js";
import { authRoutes } from "./auth.js";
import { bridgeRoutes } from "./bridge.js";
import { clustersRoutes } from "./clusters.js";
import { dflowPrivateRoutes } from "./dflow-private.js";
import { embeddedWalletRoutes } from "./embedded-wallets.js";
import { adminAuthRoutes } from "./admin-auth.js";
import { adminRoutes } from "./admin.js";
import { eventRoutes } from "./events.js";
import { executionsRoutes } from "./executions.js";
import { feesRoutes } from "./fees.js";
import { feedRoutes } from "./feed.js";
import { healthRoutes } from "./health.js";
import { holdersRoutes } from "./holders.js";
import { marketRoutes } from "./markets.js";
import { marketMapRoutes } from "./market-map.js";
import { metaRoutes } from "./meta.js";
import { metricsRoutes } from "./metrics.js";
import { notificationsRoutes } from "./notifications.js";
import { ordersRoutes } from "./orders.js";
import { positionsRoutes } from "./positions.js";
import { pricesSseRoutes } from "./prices-sse.js";
import { privyWebhookRoutes } from "./privy-webhooks.js";
import { fundingRelayWebhookRoutes } from "./funding-relay-webhook.js";
import { tradesRoutes } from "./trades.js";
import { limitlessPrivateRoutes } from "./limitless-private.js";
import { polymarketPrivateRoutes } from "./polymarket-private.js";
import { polymarketProxyRoutes } from "./polymarket-proxy.js";
import { rewardsRoutes } from "./rewards.js";
import { signalsRoutes } from "./signals.js";
import { sharesRoutes } from "./shares.js";
import { solanaRoutes } from "./solana.js";
import { specialRoutes } from "./special.js";
import { telegramRoutes } from "./telegram.js";
import { telegramBotTradingRoutes } from "./telegram-bot-trading.js";
import { tradePolicyRoutes } from "./trade-policies.js";
import { walletsRoutes } from "./wallets.js";
import { walletIntelRoutes } from "./wallet-intel.js";
import { watchlistRoutes } from "./watchlist.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(metricsRoutes);
  await app.register(healthRoutes);
  await app.register(privyWebhookRoutes);
  await app.register(fundingRelayWebhookRoutes);
  await app.register(metaRoutes);
  await app.register(analyticsRoutes);
  await app.register(tradePolicyRoutes);
  await app.register(clustersRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminRoutes);
  await app.register(feesRoutes);
  await app.register(bridgeRoutes);
  await app.register(authRoutes);
  await app.register(telegramRoutes);
  await app.register(telegramBotTradingRoutes);
  await app.register(embeddedWalletRoutes);
  await app.register(polymarketPrivateRoutes, { prefix: "/trade/polymarket" });
  await app.register(limitlessPrivateRoutes, { prefix: "/trade/limitless" });
  await app.register(dflowPrivateRoutes, {
    prefix: "/trade/kalshi",
    strictKalshiSubmit: true,
  });
  await app.register(dflowPrivateRoutes, {
    prefix: "/trade/dflow",
    strictKalshiSubmit: false,
  });
  await app.register(polymarketProxyRoutes);
  await app.register(solanaRoutes);
  await app.register(pricesSseRoutes);
  await app.register(notificationsRoutes);
  await app.register(feedRoutes);
  await app.register(specialRoutes);
  await app.register(marketMapRoutes);
  await app.register(holdersRoutes);
  await app.register(marketRoutes);
  await app.register(eventRoutes);
  await app.register(executionsRoutes);
  await app.register(ordersRoutes);
  await app.register(tradesRoutes);
  await app.register(rewardsRoutes);
  await app.register(sharesRoutes);
  await app.register(signalsRoutes);
  await app.register(positionsRoutes);
  await app.register(walletsRoutes);
  await app.register(accountValueRoutes);
  await app.register(walletIntelRoutes);
  await app.register(watchlistRoutes);
}
