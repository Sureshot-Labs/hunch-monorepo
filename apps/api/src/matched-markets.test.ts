import type { DbQuery } from "./db.js";
import type { Pool } from "@hunch/infra";
import { DEFAULT_MARKET_MATCHING_POLICY } from "@hunch/shared";
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { marketRoutes } from "./routes/markets.js";
import { buildClusterExecution } from "./services/cluster-execution.js";
import {
  buildMarketSummary,
  computeClusterMetrics,
} from "./services/clusters.js";
import type { AggMarketAlternativesResponse } from "./services/agg-market-clusters.js";
import { getMatchedClusters } from "./services/matched-markets.js";

const policyDb = {
  query: async <T>() => ({
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [
      {
        payload: {
          ...DEFAULT_MARKET_MATCHING_POLICY,
          workerEnabled: true,
          lazyEnabled: true,
          alternativesEnabled: true,
        },
      },
    ] as T[],
  }),
} as DbQuery;

test("matched clusters require the API-owned verifier and propagate its failure", async () => {
  const db = {
    query: async () => ({ rows: [] }),
  } as unknown as Pool;
  let verificationCalls = 0;
  const result = await getMatchedClusters(db, {}, async (receivedDb, items) => {
    verificationCalls++;
    assert.equal(receivedDb, db);
    assert.deepEqual(items, []);
    return items;
  });
  assert.equal(verificationCalls, 1);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.coverage, {
    complete: true,
    nextCursor: null,
    pagesFetched: 1,
    sourceMarkets: 0,
  });

  const failure = new Error("execution_verification_unavailable");
  await assert.rejects(
    getMatchedClusters(db, {}, async () => {
      verificationCalls++;
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(verificationCalls, 2);
});

test("public matching configuration follows runtime policy without restart and never exposes the budget", async () => {
  let payload: unknown = {};
  const db = {
    query: async () => ({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ payload }],
    }),
  } as DbQuery;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  let aggCalls = 0;
  await app.register(marketRoutes, {
    aggMarketAlternativesDb: db,
    createAggMarketClient: () => {
      aggCalls++;
      throw new Error("Unexpected AGG");
    },
  });
  try {
    const config = () => app.inject({ method: "GET", url: "/matching/config" });
    assert.deepEqual((await config()).json(), {
      lazyEnabled: false,
      clusterSource: "agg",
      agentClusterSource: "agg",
    });
    payload = {
      workerEnabled: true,
      lazyEnabled: true,
      alternativesEnabled: true,
      clustersEnabled: true,
      dailyBudgetUsd: 0.1,
    };
    assert.deepEqual((await config()).json(), {
      lazyEnabled: true,
      clusterSource: "hunch_matcher",
      agentClusterSource: "agg",
    });
    payload = { workerEnabled: false, clustersEnabled: true };
    assert.deepEqual((await config()).json(), {
      lazyEnabled: false,
      clusterSource: "hunch_matcher",
      agentClusterSource: "agg",
    });
    payload = { agentsEnabled: true, clustersEnabled: false };
    assert.deepEqual((await config()).json(), {
      lazyEnabled: false,
      clusterSource: "agg",
      agentClusterSource: "hunch_matcher",
    });
    payload = { unknown: true };
    assert.equal((await config()).statusCode, 500);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/markets/polymarket:test/alternatives",
        })
      ).statusCode,
      500,
    );
    assert.equal(aggCalls, 0);
  } finally {
    await app.close();
  }
});

test("Hunch market alternatives never call AGG, including not-found", async () => {
  const previous = process.env.MATCHING_ALTERNATIVES_ENABLED;
  process.env.MATCHING_ALTERNATIVES_ENABLED = "true";
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  let calls = 0;
  try {
    await app.register(marketRoutes, {
      aggMarketAlternativesDb: policyDb,
      createAggMarketClient: () => {
        calls++;
        throw new Error("AGG must not run");
      },
      getMatchedAlternatives: async () => null,
    });
    const response = await app.inject({
      method: "GET",
      url: "/markets/polymarket:test/alternatives",
    });
    assert.equal(response.statusCode, 404);
    assert.equal(calls, 0);
  } finally {
    await app.close();
    if (previous === undefined)
      delete process.env.MATCHING_ALTERNATIVES_ENABLED;
    else process.env.MATCHING_ALTERNATIVES_ENABLED = previous;
  }
});
test("agent and app alternatives select their own policy independently", async () => {
  let payload = { agentsEnabled: true, alternativesEnabled: false };
  const db = {
    query: async () => ({ rows: [{ payload }] }),
  } as unknown as DbQuery;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  let nativeCalls = 0;
  await app.register(marketRoutes, {
    aggMarketAlternativesDb: db,
    aggMarketAppId: "",
    getMatchedAlternatives: async () => {
      nativeCalls++;
      return null;
    },
  });
  try {
    const get = (consumer: "agents" | "alternatives") =>
      app.inject({
        method: "GET",
        url: `/markets/polymarket:test/alternatives?consumer=${consumer}`,
      });
    assert.equal((await get("agents")).statusCode, 404);
    assert.equal((await get("alternatives")).statusCode, 503);
    payload = { agentsEnabled: false, alternativesEnabled: true };
    assert.equal((await get("agents")).statusCode, 503);
    assert.equal((await get("alternatives")).statusCode, 404);
    assert.equal(nativeCalls, 2);
  } finally {
    await app.close();
  }
});
test("matched reads hand visible IDs to price refresh without inference or AGG", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  let refreshed: Array<string | null | undefined> = [];
  await app.register(marketRoutes, {
    aggMarketAlternativesDb: policyDb,
    createAggMarketClient: () => {
      throw new Error("Unexpected AGG");
    },
    registerMatchingInterest: async () => {
      throw new Error("GET must not enqueue Jev");
    },
    requestMatchedPriceRefresh: ({ marketIds }) => {
      refreshed = marketIds ?? [];
    },
    getMatchedAlternatives: async () =>
      ({
        source: "hunch_matcher",
        status: "matched",
        alternatives: [],
        markets: [
          { marketId: "polymarket:test" },
          { marketId: "limitless:test" },
          { marketId: "limitless:test" },
        ],
      }) as unknown as AggMarketAlternativesResponse,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/markets/polymarket:test/alternatives",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(refreshed, ["polymarket:test", "limitless:test"]);
  } finally {
    await app.close();
  }
});
test("matched execution never infers outcome alignment from equal titles", () => {
  const make = (id: string) => ({
    ...buildMarketSummary({
      id,
      event_id: id,
      venue: id.split(":")[0],
      title: "Same",
      event_title: "Same",
      market_type: "binary",
      best_bid: 0.4,
      best_ask: 0.5,
      last_price: null,
      volume_24h: 0,
      volume_total: 0,
      liquidity: 100,
      open_interest: 0,
      close_time: null,
      expiration_time: null,
    }),
    source: "hunch_matcher" as const,
    outcomeMapping: null,
  });
  const a = make("polymarket:a"),
    b = make("limitless:b");
  const result = buildClusterExecution({
    cluster: {
      id: "test",
      seedMarketId: a.marketId,
      markets: [a, b],
      priceSpread: 0.1,
    },
    nativeQuotesByMarketId: new Map(),
    now: new Date(),
  });
  assert(result.markets.every((m) => m.outcomeMapping === null));
  assert.equal(computeClusterMetrics([a, b]).priceSpread, null);
  const metrics = computeClusterMetrics([
    {
      ...a,
      yesMid: 0.2,
      noMid: 0.8,
      outcomeMapping: {
        confidence: 1,
        method: "verified_outcome_link",
        sourceYesTo: "YES",
      },
    },
    {
      ...b,
      yesMid: 0.7,
      noMid: 0.3,
      outcomeMapping: {
        confidence: 1,
        method: "verified_outcome_link",
        sourceYesTo: "NO",
      },
    },
  ]);
  assert(Math.abs((metrics.priceSpread ?? 0) - 0.1) < 1e-9);
});

test("lazy demand requires identity, fails closed on rate limits, ignores source spoofing; GET never queues", async () => {
  const oldLazy = process.env.MATCHING_LAZY_ENABLED,
    oldAlternatives = process.env.MATCHING_ALTERNATIVES_ENABLED;
  process.env.MATCHING_LAZY_ENABLED = "true";
  process.env.MATCHING_ALTERNATIVES_ENABLED = "true";
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const actors: string[] = [];
  let permitted = true;
  try {
    await app.register(marketRoutes, {
      aggMarketAlternativesDb: policyDb,
      matchingAuthenticate: async (req, reply) => {
        if (req.headers.authorization !== "test") {
          reply.code(401).send({ error: "Unauthorized" });
          return;
        }
        req.user = { id: "trusted-user" } as NonNullable<typeof req.user>;
      },
      matchingRateLimit: async (_key, _max, _ms, options) => {
        assert.equal(options?.onError, "fail_closed");
        return permitted;
      },
      registerMatchingInterest: async (_pool, _id, actor) => {
        actors.push(actor);
        return "pending";
      },
      getMatchedAlternatives: async () => null,
    });
    const path = "/markets/polymarket:test/alternatives";
    assert.equal(
      (await app.inject({ method: "GET", url: path })).statusCode,
      404,
    );
    assert.equal(actors.length, 0);
    assert.equal(
      (await app.inject({ method: "POST", url: path + "/discovery" }))
        .statusCode,
      401,
    );
    assert.equal(actors.length, 0);
    permitted = false;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path + "/discovery",
          headers: { authorization: "test" },
        })
      ).statusCode,
      429,
    );
    assert.equal(actors.length, 0);
    permitted = true;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path + "/discovery",
          headers: { authorization: "test" },
          payload: { actorId: "attacker", source: "warm" },
        })
      ).statusCode,
      202,
    );
    assert.deepEqual(actors, ["trusted-user"]);
    process.env.MATCHING_LAZY_ENABLED = "false";
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path + "/discovery",
          headers: { authorization: "test" },
        })
      ).statusCode,
      503,
    );
    assert.equal(actors.length, 1);
  } finally {
    await app.close();
    if (oldLazy === undefined) delete process.env.MATCHING_LAZY_ENABLED;
    else process.env.MATCHING_LAZY_ENABLED = oldLazy;
    if (oldAlternatives === undefined)
      delete process.env.MATCHING_ALTERNATIVES_ENABLED;
    else process.env.MATCHING_ALTERNATIVES_ENABLED = oldAlternatives;
  }
});
