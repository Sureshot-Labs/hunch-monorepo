#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  PositionActionVenueRegistry,
  type PositionActionVenueDriver,
} from "../../position-actions/venue-driver.js";
import { positionActionInspectRequestSchema } from "../../../schemas/position-actions.js";

function futureVenueDriver(
  venueId = "future_venue",
): PositionActionVenueDriver {
  return {
    adapterId: `${venueId}-redemption-v1`,
    venueId,
    buildMarketContext: () => {
      throw new Error("not exercised by registry test");
    },
    buildPlan: async () => {
      throw new Error("not exercised by registry test");
    },
    conditionalTokensAddress: () =>
      "0x0000000000000000000000000000000000000001",
    inspectOperatorApproval: async () => true,
    observeReceipt: async () => null,
    refreshPositions: async () => undefined,
    resolveExecutionProfile: () => ({
      topologySupported: true,
      unsupportedReason: "unsupported_wallet_topology",
      externalHandoff: null,
    }),
  };
}

const future = futureVenueDriver();
const registry = new PositionActionVenueRegistry([future]);

assert.equal(registry.has("future_venue"), true);
assert.equal(registry.require("future_venue"), future);
assert.equal(
  positionActionInspectRequestSchema.parse({
    action: "redeem",
    venueId: "future_venue",
    positionRef: "20000000-0000-4000-8000-000000000002",
    ownerBindingId: "binding_future_venue_12345678",
  }).venueId,
  "future_venue",
);
assert.throws(
  () => registry.require("polymarket"),
  /unsupported position-action venue/,
);
assert.throws(
  () => new PositionActionVenueRegistry([future, futureVenueDriver()]),
  /duplicate position-action venue driver/,
);
assert.throws(
  () => new PositionActionVenueRegistry([futureVenueDriver("Future Venue")]),
  /invalid position-action venue ID/,
);

console.log(
  "[position-action-venue-registry-tests] future venue registration is core-independent",
);
