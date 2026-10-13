import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  validatorCompiler,
  serializerCompiler,
} from "fastify-type-provider-zod";
import {
  positionsReadQuerySchema,
  positionsByTokenReadQuerySchema,
  positionsQuerySchema,
  positionVisibilitySchema,
} from "./schemas/positions.js";
import {
  positionReadSchema,
  positionReadRouteSchemas,
} from "./schemas/position-read.js";
import {
  positionReadScope,
  mergePositionPnlSummary,
  unavailableHip4PositionRead,
  EMPTY_LEGACY_POSITION_PNL,
} from "./services/position-read-scope.js";
import type { Hip4PortfolioRead } from "./services/hip4-portfolio-positions.js";

test("HIP is a read venue, not an implicit sync/hide/trade venue", () => {
  assert.equal(
    positionsReadQuerySchema.parse({ venue: "HYPERLIQUID" }).venue,
    "hyperliquid",
  );
  assert.deepEqual(
    positionsReadQuerySchema.parse({
      venues: ["Hyperliquid,limitless", "hyperliquid"],
    }).venues,
    ["hyperliquid", "limitless"],
  );
  assert.equal(
    positionsByTokenReadQuerySchema.parse({
      venue: "hyperliquid",
      tokenIds: "a,b",
    }).venue,
    "hyperliquid",
  );
  assert.equal(
    positionsQuerySchema.safeParse({ venue: "hyperliquid" }).success,
    false,
  );
  assert.equal(
    positionVisibilitySchema.safeParse({
      venue: "hyperliquid",
      walletAddress: "a",
      tokenId: "b",
    }).success,
    false,
  );
});

test("read OpenAPI keeps venue selection optional and shares the real route contracts", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  try {
    await app.register(swagger, {
      openapi: { info: { title: "Positions", version: "1" } },
      transform: jsonSchemaTransform,
    });
    for (const [path, schema] of Object.entries(positionReadRouteSchemas))
      app.get(path, { schema }, async () => {
        throw new Error("schema_only");
      });
    await app.ready();
    const document = app.swagger();
    for (const path of Object.keys(positionReadRouteSchemas)) {
      const operation = document.paths?.[path]?.get;
      assert.ok(operation);
      const parameters = operation.parameters ?? [];
      for (const name of ["venue", "venues"]) {
        const parameter = parameters.find(
          (value) => "name" in value && value.name === name,
        );
        assert.ok(parameter && "name" in parameter);
        assert.notEqual(
          parameter.required,
          true,
          `${path}: ${name} must be optional`,
        );
      }
    }
    assert.equal(positionsReadQuerySchema.parse({}).venue, undefined);
    assert.equal(positionsReadQuerySchema.parse({}).venues, undefined);
  } finally {
    await app.close();
  }
});

test("HIP-only scope cannot become all legacy venues; existing list precedence survives", () => {
  assert.deepEqual(positionReadScope({ venue: "hyperliquid" }), {
    legacyVenues: [],
    hyperliquid: true,
  });
  assert.deepEqual(
    positionReadScope({ venue: "limitless", venues: ["hyperliquid"] }),
    { legacyVenues: [], hyperliquid: true },
  );
  assert.deepEqual(
    positionReadScope({ venues: ["hyperliquid", "polymarket"] }),
    { legacyVenues: ["polymarket"], hyperliquid: true },
  );
  assert.deepEqual(positionReadScope({}), {
    legacyVenues: ["polymarket", "kalshi", "limitless"],
    hyperliquid: true,
  });
});

test("legacy dates, optional fields and frozen asset metadata survive the read schema", () => {
  const at = new Date("2026-10-13T12:00:00Z");
  const result = positionReadSchema.parse({
    id: "p",
    userId: "u",
    walletAddress: null,
    venue: "polymarket",
    tokenId: "1",
    side: "LONG",
    size: 2,
    sizeRaw: "2.000000",
    unrealizedPnl: 0,
    realizedPnl: 1,
    lastUpdatedAt: at,
    createdAt: at,
    updatedAt: at,
    positionContract: "frozen-contract",
    assetContext: { ledger: "frozen-generation" },
  });
  assert.equal(result.lastUpdatedAt, at.toISOString());
  assert.equal(result.averagePrice, undefined);
  assert.equal(result.venue, "polymarket");
  assert.equal(
    "positionContract" in result && result.positionContract,
    "frozen-contract",
  );
  assert.deepEqual("assetContext" in result && result.assetContext, {
    ledger: "frozen-generation",
  });
});

test("partial HIP accounting never makes mixed-venue PnL look complete or flat", () => {
  const legacy = {
    ...EMPTY_LEGACY_POSITION_PNL,
    positionsCount: 1,
    realizedPnlAllTime: 5,
    unrealizedPnlCurrent: 2,
    unrealizedCostBasisCurrent: 10,
    unrealizedPnlPercentCurrent: 20,
  };
  const hip4: Hip4PortfolioRead = {
    positions: [],
    coverage: {
      ...unavailableHip4PositionRead().coverage,
      state: "ready",
      accounts: 1,
    },
  };
  const emptyObserved = mergePositionPnlSummary(legacy, hip4);
  assert.equal(emptyObserved.realizedPnlAllTime, null);
  assert.equal(emptyObserved.unrealizedPnlCurrent, 2);
  for (const flag of [
    "missingAccounts",
    "staleAccounts",
    "unresolvedBalances",
    "missingCostBasis",
  ] as const) {
    const result = mergePositionPnlSummary(legacy, {
      ...hip4,
      coverage: { ...hip4.coverage, [flag]: 1 },
    });
    assert.equal(result.unrealizedPnlCurrent, null);
    assert.equal(result.unrealizedPnlPercentCurrent, null);
    assert.equal(result.unrealizedCostBasisCurrent, null);
  }
  assert.equal(
    mergePositionPnlSummary(legacy, unavailableHip4PositionRead())
      .realizedPnlAllTime,
    null,
  );
  assert.deepEqual(
    mergePositionPnlSummary(legacy, {
      ...hip4,
      coverage: { ...hip4.coverage, state: "disabled" },
    }),
    legacy,
  );
  assert.deepEqual(mergePositionPnlSummary(legacy), legacy);
});
