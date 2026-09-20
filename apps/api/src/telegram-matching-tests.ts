import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { DbQuery } from "./db.js";
import { env } from "./env.js";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import type { AggMarketAlternativesResponse } from "./services/agg-market-clusters.js";

test("Telegram native enrichment refreshes matched prices and never calls AGG on results, empty responses or errors", async () => {
  const previousFetch = globalThis.fetch,
    previousAppId = env.aggMarketAppId;
  let requests = 0,
    mode: "matched" | "empty" | "error" | "inverse" | "partial" = "matched";
  const refreshed: string[][] = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  try {
    env.aggMarketAppId = "must-not-be-used";
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("No external calls");
    }) as typeof fetch;
    await app.register(
      createTelegramBotTradingRoutes({
        db: {
          query: async (_sql: string, values: unknown[]) => ({
            rows:
              values?.[0] === "market_matching"
                ? [{ payload: { telegramEnabled: true } }]
                : [],
          }),
        } as unknown as DbQuery,
        internalPreHandler: async () => {},
        reconciliationEnabled: false,
        requestMatchedPriceRefresh: ({ marketIds }) => {
          refreshed.push((marketIds ?? []).filter((id): id is string => !!id));
        },
        getMatchedAlternatives: async () => {
          if (mode === "error") throw new Error("Native unavailable");
          if (mode === "empty") return null;
          const market = {
            marketId: "limitless:target",
            eventId: "limitless:event",
            marketTitle: "Alice",
            eventTitle: "Election",
            venue: "limitless",
            active: true,
            orderable: true,
            yesAsk: 0.43,
            yesMid: 0.42,
            outcomeMapping:
              mode === "partial"
                ? null
                : { sourceYesTo: mode === "inverse" ? "NO" : "YES" },
            verifiedOutcomeMapping:
              mode === "partial" ? { YES: "YES", NO: null } : undefined,
          };
          return {
            markets: [market],
            alternatives: [market],
          } as unknown as AggMarketAlternativesResponse;
        },
        searchMarkets: async ({ resolveCrossVenueAlternatives }) => {
          assert(resolveCrossVenueAlternatives);
          // Production search keeps base results via allSettled if enrichment fails.
          const [result] = await Promise.allSettled([
            resolveCrossVenueAlternatives({
              marketId: "polymarket:source",
              venues: ["limitless"],
            }),
          ]);
          return result.status === "fulfilled" ? result.value : [];
        },
      }),
    );
    for (const next of [
      "matched",
      "empty",
      "error",
      "inverse",
      "partial",
    ] as const) {
      mode = next;
      const response = await app.inject({
        method: "POST",
        url: "/internal/telegram-bot/trading/market-search",
        payload: { query: "Alice" },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().length, mode === "matched" ? 1 : 0);
    }
    assert.deepEqual(refreshed, [
      ["limitless:target"],
      ["limitless:target"],
      ["limitless:target"],
    ]);
    assert.equal(requests, 0);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    env.aggMarketAppId = previousAppId;
  }
});
