import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  HUNCH_VENUES,
  getVenueLifecycleCapabilities,
  getVenueLifecycleCapabilityMatrix,
  venueLifecycleCapabilitiesSchema,
} from "@hunch/shared";
import { venueMetadataRouteSchema } from "./schemas/venue-metadata.js";

test("admin draft capabilities exactly match runtime capabilities for every venue/state", () => {
  const matrix = getVenueLifecycleCapabilityMatrix();
  for (const venue of HUNCH_VENUES) {
    for (const lifecycle of ["active", "exit-only", "unreleased"] as const) {
      const policy = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
      policy.venues[venue].lifecycle = lifecycle;
      const actual = getVenueLifecycleCapabilities(policy, venue);
      assert.deepEqual(matrix[venue][lifecycle], actual);
      assert.ok(venueLifecycleCapabilitiesSchema.safeParse(actual).success);
      if (lifecycle === "unreleased")
        assert.ok(Object.values(actual!).every((value) => !value));
    }
  }
  assert.equal(matrix.polymarket.active.increaseExposure, true);
  assert.equal(matrix.limitless.active.walletWithdrawal, true);
  assert.equal(matrix.kalshi["exit-only"].increaseExposure, false);
  assert.equal(matrix.kalshi["exit-only"].reduceExposure, true);
  assert.equal(matrix.hyperliquid.active.discovery, true);
  assert.equal(matrix.hyperliquid.active.walletAccess, true);
  assert.equal(matrix.hyperliquid["exit-only"].accountRead, true);
  for (const field of [
    "increaseExposure",
    "reduceExposure",
    "cancel",
    "redeem",
    "fundTrading",
    "fundMaintenance",
    "walletWithdrawal",
    "automation",
    "signalSource",
    "signalDelivery",
  ] as const) {
    assert.equal(matrix.hyperliquid.active[field], false, field);
  }
});

test("public metadata serialization preserves the authoritative policy and capabilities", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const payload = {
    total: 0,
    generatedAt: new Date(0).toISOString(),
    coverageStatus: "pending",
    coverageAsOf: null,
    venues: [],
    policy: {
      source: "default",
      effectiveAt: null,
      invalidOverride: false,
      revision: "fixture-v1",
      venues: Object.fromEntries(
        HUNCH_VENUES.map((venue) => [
          venue,
          {
            ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues[venue],
            capabilities: getVenueLifecycleCapabilities(
              DEFAULT_VENUE_LIFECYCLE_POLICY,
              venue,
            ),
            ...(venue === "hyperliquid" ? { readEnvironment: "testnet" } : {}),
          },
        ]),
      ),
    },
  };
  app.get(
    "/meta/venues",
    { schema: venueMetadataRouteSchema },
    async () => payload,
  );
  try {
    const response = await app.inject("/meta/venues");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), payload);
  } finally {
    await app.close();
  }
});
