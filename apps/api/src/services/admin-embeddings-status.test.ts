import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdminEmbeddingStatus } from "./admin-embeddings-status.js";

test("scoped costs and separate live/reconciliation status survive the API parser", () => {
  const payload = {
    state: "active",
    reconciliation: {
      state: "paused",
      reason: "memory",
      startedAt: "2026-09-22T03:37:37.000Z",
    },
    live: { completed: true, lag: 0, pending: 0 },
    budget: {
      accountingVersion: 2,
      limitUsd: 10,
      spentUsd: 0,
      reservedUsd: 0,
      actualUsd: 0,
      knownActualUsd: 0,
      unknownUsd: 0,
      maintenance: {
        spentUsd: 1.2,
        reservedUsd: 0.1,
        actualUsd: null,
        knownActualUsd: 1,
        unknownUsd: 0.2,
      },
      legacy: {
        estimatedUsd: 29.81,
        knownActualUsd: 4.27,
        hasUnknown: true,
        attributedToBuildUsd: 0,
      },
    },
  };
  assert.deepEqual(parseAdminEmbeddingStatus(JSON.stringify(payload)), {
    error: null,
    status: payload,
  });
  assert.equal(
    parseAdminEmbeddingStatus(
      JSON.stringify({
        ...payload,
        budget: {
          ...payload.budget,
          maintenance: { ...payload.budget.maintenance, unknownUsd: -1 },
        },
      }),
    ).status,
    null,
  );
});
