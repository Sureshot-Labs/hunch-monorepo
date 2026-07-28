import assert from "node:assert/strict";
import test from "node:test";

import { collectDestinationInspectionCoverage } from "../../preparation/destination-inspection-coverage.js";

await test("rejects a snapshot when every internal inspection for a venue failed", () => {
  const coverage = collectDestinationInspectionCoverage([
    {
      venueId: "polymarket",
      internalWallet: true,
      outcome: { status: "fulfilled", value: "polymarket-option" },
    },
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: { status: "rejected", reason: new Error("temporary failure") },
    },
  ]);

  assert.deepEqual(coverage.values, ["polymarket-option"]);
  assert.deepEqual(coverage.incompleteVenueIds, ["limitless"]);
});

await test("accepts a venue when one internal wallet inspection succeeds", () => {
  const coverage = collectDestinationInspectionCoverage([
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: { status: "rejected", reason: new Error("wallet unavailable") },
    },
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: { status: "fulfilled", value: "limitless-option" },
    },
  ]);

  assert.deepEqual(coverage.values, ["limitless-option"]);
  assert.deepEqual(coverage.incompleteVenueIds, []);
});

await test("an external success cannot conceal a failed internal destination", () => {
  const coverage = collectDestinationInspectionCoverage([
    {
      venueId: "limitless",
      internalWallet: false,
      outcome: { status: "fulfilled", value: "external-option" },
    },
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: {
        status: "rejected",
        reason: new Error("internal unavailable"),
      },
    },
  ]);

  assert.deepEqual(coverage.values, ["external-option"]);
  assert.deepEqual(coverage.incompleteVenueIds, ["limitless"]);
});
