#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  calculateDflowSponsorshipReconciliation,
  collectDflowSponsorshipSignatures,
  reconcileSolanaSponsorshipLedger,
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

function genericLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "10000000-0000-0000-0000-000000000001",
    venue: "wallet",
    flow: "directTransfer",
    status: "intent_created",
    intent_id: "solsp_generic",
    wallet_address: "Wallet111111111111111111111111111111111111",
    sponsor_address: SPONSOR,
    market_id: null,
    input_mint: null,
    output_mint: null,
    amount_raw: null,
    message_digest: null,
    transaction_digest: null,
    tx_signature: null,
    estimated_sponsor_lamports: "5000",
    actual_sponsor_lamports: null,
    rent_lamports: null,
    metadata: {},
    ...overrides,
  };
}

function lossReclaimLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "10000000-0000-0000-0000-000000000001",
    venue: "kalshi",
    flow: "dflow",
    status: "submitted",
    intent_id: "solsp_loss_reclaim",
    wallet_address: "Wallet111111111111111111111111111111111111",
    sponsor_address: SPONSOR,
    market_id: "kalshi:TEST",
    input_mint: "Mint11111111111111111111111111111111111111",
    output_mint: "Mint11111111111111111111111111111111111111",
    amount_raw: "1",
    message_digest: "messageDigest",
    transaction_digest: "transactionDigest",
    tx_signature: "loss-reclaim-submit",
    estimated_sponsor_lamports: "5000",
    actual_sponsor_lamports: null,
    rent_lamports: "2039280",
    metadata: {
      purpose: "loss_reclaim",
      rentRecipient: SPONSOR,
    },
    ...overrides,
  };
}

function fakeSponsorshipPool(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const upserts: Array<Record<string, unknown>> = [];
  return {
    calls,
    upserts,
    pool: {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (/select[\s\S]*from solana_sponsorship_ledger/i.test(sql)) {
          return { rows };
        }
        if (/insert into solana_sponsorship_ledger/i.test(sql)) {
          upserts.push({ params: params ?? [] });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
  };
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

await test("failed finalized DFlow transaction records sponsor spend", () => {
  const result = calculateDflowSponsorshipReconciliation({
    sponsorAddress: SPONSOR,
    submitSignature: "failed-submit",
    relatedSignatures: ["failed-submit"],
    settlementClosed: false,
    transactions: new Map([
      [
        "failed-submit",
        tx({
          signature: "failed-submit",
          feePayer: SPONSOR,
          feeLamports: 10_000n,
          sponsorDeltaLamports: -10_000n,
          err: { InstructionError: [1, "Custom"] },
        }),
      ],
    ]),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.actualSponsorLamports, "10000");
  assert.equal(result.rentLamports, "0");
  assert.equal(result.rentStatus, "returned");
  const reconciliation = result.metadata.sponsorshipReconciliation as {
    erroredSignatures: string[];
    transactions: Array<{ err: unknown; feeLamports: string }>;
  };
  assert.deepEqual(reconciliation.erroredSignatures, ["failed-submit"]);
  assert.equal(reconciliation.transactions[0]?.feeLamports, "10000");
  assert.deepEqual(reconciliation.transactions[0]?.err, {
    InstructionError: [1, "Custom"],
  });
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

await test("generic intent_created rows need durable signature metadata", async () => {
  const db = fakeSponsorshipPool([genericLedgerRow()]);
  let fetched = false;
  const summary = await reconcileSolanaSponsorshipLedger(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchTransaction: async () => {
      fetched = true;
      return tx({
        signature: "generic-submit",
        feePayer: SPONSOR,
        feeLamports: 5000n,
        sponsorDeltaLamports: -5000n,
      });
    },
  });

  assert.equal(summary.checked, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.confirmed, 0);
  assert.equal(fetched, false);
  assert.equal(db.upserts.length, 0);
});

await test("generic intent_created rows reconcile durable metadata signature", async () => {
  const db = fakeSponsorshipPool([
    genericLedgerRow({
      metadata: {
        submission: {
          signature: "generic-submit",
        },
      },
    }),
  ]);
  const summary = await reconcileSolanaSponsorshipLedger(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    upsertLedger: async (inputs) => {
      db.upserts.push(inputs);
    },
    fetchTransaction: async (signature) =>
      tx({
        signature,
        feePayer: SPONSOR,
        feeLamports: 5000n,
        sponsorDeltaLamports: -5000n,
      }),
  });

  assert.equal(summary.checked, 1);
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0]?.txSignature, "generic-submit");
  assert.equal(db.upserts[0]?.actualSponsorLamports, "5000");
});

await test("loss_reclaim DFlow rows reconcile from submit transaction finality", async () => {
  const db = fakeSponsorshipPool([lossReclaimLedgerRow()]);
  const summary = await reconcileSolanaSponsorshipLedger(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    upsertLedger: async (inputs) => {
      db.upserts.push(inputs);
    },
    fetchTransaction: async (signature) =>
      tx({
        signature,
        feePayer: SPONSOR,
        feeLamports: 5000n,
        sponsorDeltaLamports: 2_034_280n,
      }),
  });

  assert.equal(summary.checked, 1);
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0]?.status, "confirmed");
  assert.equal(db.upserts[0]?.txSignature, "loss-reclaim-submit");
  assert.equal(db.upserts[0]?.actualSponsorLamports, "5000");
  assert.equal(db.upserts[0]?.rentLamports, "2039280");
  assert.equal(db.upserts[0]?.rentStatus, "returned");
});

await test("failed rows with actual cost and reconciliation are filtered by query", async () => {
  const db = fakeSponsorshipPool([]);
  await reconcileSolanaSponsorshipLedger(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
  });

  const query = db.calls[0]?.sql ?? "";
  assert.match(query, /status = 'failed'/);
  assert.match(query, /actual_sponsor_lamports is null/);
  assert.match(query, /sponsorshipReconciliation/);
  assert.match(query, /genericSponsorshipReconciliation/);
});

console.log("[dflow-sponsorship-reconcile-tests] ok");
