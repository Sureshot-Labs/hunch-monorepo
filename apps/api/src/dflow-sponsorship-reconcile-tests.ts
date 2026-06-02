#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  calculateDflowSponsorshipReconciliation,
  collectDflowSponsorshipSignatures,
} from "./services/solana-sponsorship-reconcile.js";
import type { SolanaFinalizedTransactionBalanceDeltas } from "./services/solana-rpc.js";

const SPONSOR = "B2oU6ZDdb3dk4GMJepKiWiBVVzF46vuW12RcKpQ5sGTX";
const PROD = "ProdD7SB4T5h7rwSHU6jJEUtm69rEooTzuguwndpNQc";

function tx(inputs: {
  signature: string;
  feePayer: string;
  feeLamports: bigint;
  sponsorDeltaLamports: bigint;
  err?: unknown;
}): SolanaFinalizedTransactionBalanceDeltas {
  return {
    signature: inputs.signature,
    slot: 1,
    blockTime: 1_780_352_000,
    err: inputs.err ?? null,
    feeLamports: inputs.feeLamports,
    feePayer: inputs.feePayer,
    accountDeltas: [
      {
        account: SPONSOR,
        preLamports: 0n,
        postLamports: inputs.sponsorDeltaLamports,
        deltaLamports: inputs.sponsorDeltaLamports,
      },
    ],
  };
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`[dflow-sponsorship-reconcile-tests] ok ${name}`);
  } catch (error) {
    console.error(`[dflow-sponsorship-reconcile-tests] failed ${name}`);
    throw error;
  }
}

await test("collects submit, fill, and revert signatures", () => {
  assert.deepEqual(
    collectDflowSponsorshipSignatures({
      submitSignature: "submit",
      executionRaw: {
        settlement: {
          fills: [{ signature: "fill" }],
          reverts: [{ signature: "revert" }],
        },
      },
    }),
    ["submit", "fill", "revert"],
  );
});

await test("computes observed sponsored buy net cost", () => {
  const result = calculateDflowSponsorshipReconciliation({
    sponsorAddress: SPONSOR,
    submitSignature: "buy-submit",
    relatedSignatures: ["buy-submit", "buy-fill"],
    settlementClosed: true,
    transactions: new Map([
      [
        "buy-submit",
        tx({
          signature: "buy-submit",
          feePayer: SPONSOR,
          feeLamports: 10_035n,
          sponsorDeltaLamports: -5_334_435n,
        }),
      ],
      [
        "buy-fill",
        tx({
          signature: "buy-fill",
          feePayer: PROD,
          feeLamports: 5_022n,
          sponsorDeltaLamports: 1_206_040n,
        }),
      ],
    ]),
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.actualSponsorLamports, "4128395");
  assert.equal(result.rentLamports, "4118360");
  assert.equal(result.rentStatus, "lost");
});

await test("computes observed sponsored sell net cost", () => {
  const result = calculateDflowSponsorshipReconciliation({
    sponsorAddress: SPONSOR,
    submitSignature: "sell-submit",
    relatedSignatures: ["sell-submit", "sell-fill"],
    settlementClosed: true,
    transactions: new Map([
      [
        "sell-submit",
        tx({
          signature: "sell-submit",
          feePayer: SPONSOR,
          feeLamports: 10_178n,
          sponsorDeltaLamports: -3_295_298n,
        }),
      ],
      [
        "sell-fill",
        tx({
          signature: "sell-fill",
          feePayer: PROD,
          feeLamports: 5_032n,
          sponsorDeltaLamports: 3_280_120n,
        }),
      ],
    ]),
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.actualSponsorLamports, "15178");
  assert.equal(result.rentLamports, "5000");
  assert.equal(result.rentStatus, "lost");
});

await test("observed buy plus sell cost matches round trip total", () => {
  const buy = 4_128_395n;
  const sell = 15_178n;
  assert.equal((buy + sell).toString(), "4143573");
});

await test("missing settlement transaction leaves row submitted and unknown", () => {
  const result = calculateDflowSponsorshipReconciliation({
    sponsorAddress: SPONSOR,
    submitSignature: "submit",
    relatedSignatures: ["submit", "missing-fill"],
    settlementClosed: true,
    transactions: new Map([
      [
        "submit",
        tx({
          signature: "submit",
          feePayer: SPONSOR,
          feeLamports: 5_000n,
          sponsorDeltaLamports: -2_000_000n,
        }),
      ],
      ["missing-fill", null],
    ]),
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.actualSponsorLamports, null);
  assert.equal(result.rentLamports, null);
  assert.equal(result.rentStatus, "unknown");
});

await test("open settlement keeps final cost unset and rent locked", () => {
  const result = calculateDflowSponsorshipReconciliation({
    sponsorAddress: SPONSOR,
    submitSignature: "submit",
    relatedSignatures: ["submit"],
    settlementClosed: false,
    transactions: new Map([
      [
        "submit",
        tx({
          signature: "submit",
          feePayer: SPONSOR,
          feeLamports: 5_000n,
          sponsorDeltaLamports: -2_000_000n,
        }),
      ],
    ]),
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.actualSponsorLamports, null);
  assert.equal(result.rentLamports, "1995000");
  assert.equal(result.rentStatus, "locked");
});

console.log("[dflow-sponsorship-reconcile-tests] ok");
