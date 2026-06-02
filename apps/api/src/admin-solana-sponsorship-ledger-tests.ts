#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { DbQuery } from "./db.js";
import {
  buildAdminSolanaSponsorshipLedgerFilters,
  getAdminSolanaSponsorshipLedgerSummary,
  listAdminSolanaSponsorshipLedgerRows,
  mapAdminSolanaSponsorshipLedgerRow,
} from "./services/admin-solana-sponsorship-ledger.js";

type QueryCall = { sql: string; params?: unknown[] };

const now = new Date("2026-06-02T12:00:00.000Z");

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    created_at: now,
    updated_at: now,
    user_id: "10000000-0000-0000-0000-000000000001",
    user_email: "user@example.com",
    user_username: "user",
    user_display_name: "User",
    venue: "kalshi",
    flow: "dflow",
    status: "confirmed",
    intent_id: "solsp_intent",
    wallet_address: "Wallet111111111111111111111111111111111111",
    sponsor_address: "Sponsor11111111111111111111111111111111111",
    market_id: "kalshi:TEST",
    input_mint: "InputMint111111111111111111111111111111111",
    output_mint: "OutputMint11111111111111111111111111111111",
    amount_raw: "1000000",
    message_digest: "message-digest",
    transaction_digest: "transaction-digest",
    tx_signature: "5Sig111111111111111111111111111111111111111111111111",
    estimated_sponsor_lamports: "5000",
    actual_sponsor_lamports: "1000",
    rent_lamports: "200",
    rent_status: "returned",
    error: null,
    metadata: {
      adminPredictionMarketInit: true,
      sponsorshipReconciliation: {
        reconciledAt: "2026-06-02T12:05:00.000Z",
      },
      sponsorshipRentReclaim: {
        reclaimedAt: "2026-06-02T12:10:00.000Z",
        reclaimedLamports: "100",
        remainingOpenLamports: "0",
        netActualSponsorLamports: "777",
        closeTransactions: [
          { signature: "close-1", feeLamports: "10" },
          { signature: "close-2", feeLamports: 10 },
          { signature: "close-bad", feeLamports: "bad" },
        ],
      },
    },
    ...overrides,
  };
}

function createLedgerDb(inputs: {
  rows?: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
  byStatus?: Array<Record<string, unknown>>;
  byFlow?: Array<Record<string, unknown>>;
  byRentStatus?: Array<Record<string, unknown>>;
}): DbQuery & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    calls.push({ sql, params });
    if (/with filtered as/i.test(sql)) {
      return {
        rows: [
          {
            count: "3",
            estimated_sponsor_lamports: "15000",
            actual_sponsor_lamports: "7000",
            rent_lamports: "400",
            reclaimed_lamports: "120",
            close_fee_lamports: "30",
            net_actual_sponsor_lamports: "6910",
            ...inputs.totals,
          } as unknown as T,
        ],
      };
    }
    if (/select l\.status as key/i.test(sql)) {
      return {
        rows: (inputs.byStatus ?? [
          { key: "confirmed", count: "2" },
          { key: "failed", count: "1" },
        ]) as T[],
      };
    }
    if (/select l\.flow as key/i.test(sql)) {
      return {
        rows: (inputs.byFlow ?? [{ key: "dflow", count: "3" }]) as T[],
      };
    }
    if (/select l\.rent_status as key/i.test(sql)) {
      return {
        rows: (inputs.byRentStatus ?? [
          { key: "returned", count: "1" },
          { key: "lost", count: "2" },
        ]) as T[],
      };
    }
    if (/select count\(\*\)::text as count/i.test(sql)) {
      return {
        rows: [
          { count: String(inputs.rows?.length ?? 0) } as unknown as T,
        ],
      };
    }
    if (/from solana_sponsorship_ledger l/i.test(sql)) {
      return { rows: (inputs.rows ?? []) as T[] };
    }
    throw new Error(`Unexpected sponsorship ledger query: ${sql}`);
  };

  return { query: query as DbQuery["query"], calls };
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-solana-sponsorship-ledger-tests] ok ${name}`);
}

await test("builds bounded row filters and maps display fields", async () => {
  const db = createLedgerDb({ rows: [ledgerRow()] });
  const result = await listAdminSolanaSponsorshipLedgerRows(db, {
    q: "TEST",
    venue: "kalshi",
    flow: "dflow",
    status: "confirmed",
    rentStatus: "returned",
    wallet: "Wallet111111111111111111111111111111111111",
    sponsor: "Sponsor11111111111111111111111111111111111",
    intentId: "solsp_intent",
    txSignature: "5Sig111111111111111111111111111111111111111111111111",
    userId: "10000000-0000-0000-0000-000000000001",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-03T00:00:00.000Z",
    limit: 500,
    offset: -1,
  });

  assert.equal(result.total, 1);
  assert.equal(result.limit, 100);
  assert.equal(result.offset, 0);
  assert.equal(result.items[0]?.adminPredictionMarketInit, true);
  assert.equal(result.items[0]?.reclaimedLamports, "100");
  assert.equal(result.items[0]?.closeFeeLamports, "20");
  assert.equal(result.items[0]?.netActualSponsorLamports, "777");
  assert.equal(
    result.items[0]?.txSolscanUrl,
    "https://solscan.io/tx/5Sig111111111111111111111111111111111111111111111111",
  );
  assert.deepEqual(db.calls[0]?.params, [
    "kalshi",
    "dflow",
    "confirmed",
    "returned",
    "Wallet111111111111111111111111111111111111",
    "Sponsor11111111111111111111111111111111111",
    "solsp_intent",
    "5Sig111111111111111111111111111111111111111111111111",
    "10000000-0000-0000-0000-000000000001",
    "2026-06-01T00:00:00.000Z",
    "2026-06-03T00:00:00.000Z",
    "%TEST%",
  ]);
  assert.deepEqual(db.calls[1]?.params?.slice(-2), [100, 0]);
});

await test("summary maps totals and uses defensive metadata aggregation", async () => {
  const db = createLedgerDb({});
  const summary = await getAdminSolanaSponsorshipLedgerSummary(db, {
    status: "failed",
  });

  assert.deepEqual(summary.totals, {
    count: 3,
    estimatedSponsorLamports: "15000",
    actualSponsorLamports: "7000",
    rentLamports: "400",
    reclaimedLamports: "120",
    closeFeeLamports: "30",
    netActualSponsorLamports: "6910",
  });
  assert.deepEqual(summary.byStatus, [
    { status: "confirmed", count: 2 },
    { status: "failed", count: 1 },
  ]);
  assert.match(db.calls[0]?.sql ?? "", /jsonb_typeof/);
  assert.match(db.calls[0]?.sql ?? "", /sponsorshipRentReclaim/);
  assert.match(db.calls[0]?.sql ?? "", /netActualSponsorLamports/);
  assert.deepEqual(db.calls[0]?.params, ["failed"]);
});

await test("metadata parsing tolerates malformed optional blocks", () => {
  const mapped = mapAdminSolanaSponsorshipLedgerRow(
    ledgerRow({
      actual_sponsor_lamports: null,
      metadata: {
        sponsorshipRentReclaim: "bad",
        sponsorshipReconciliation: { reconciledAt: 123 },
        genericSponsorshipReconciliation: {
          reconciledAt: "2026-06-02T13:00:00.000Z",
        },
      },
    }) as never,
  );

  assert.equal(mapped.reclaimedLamports, "0");
  assert.equal(mapped.closeFeeLamports, "0");
  assert.equal(mapped.netActualSponsorLamports, null);
  assert.equal(mapped.reconciledAt, "2026-06-02T13:00:00.000Z");
});

await test("filter builder covers sponsorship ledger fields", () => {
  const filters = buildAdminSolanaSponsorshipLedgerFilters({
    flow: "directTransfer",
    rentStatus: "locked",
    wallet: "Wallet",
    txSignature: "Signature",
  });

  assert.match(filters.clauses.join("\n"), /l\.flow/);
  assert.match(filters.clauses.join("\n"), /l\.rent_status/);
  assert.match(filters.clauses.join("\n"), /l\.wallet_address/);
  assert.match(filters.clauses.join("\n"), /l\.tx_signature/);
  assert.deepEqual(filters.params, [
    "directTransfer",
    "locked",
    "Wallet",
    "Signature",
  ]);
});

await test("admin routes are read-only finance endpoints", () => {
  const source = readFileSync(new URL("./routes/admin.ts", import.meta.url), "utf8");
  for (const route of [
    "/admin/solana-sponsorship/ledger/summary",
    "/admin/solana-sponsorship/ledger/rows",
  ]) {
    const start = source.indexOf(route);
    assert.notEqual(start, -1, `${route} route is present`);
    const excerpt = source.slice(start, start + 900);
    assert.match(excerpt, /requiredAdminPermission: "finance:read"/);
    assert.doesNotMatch(excerpt, /sponsorship:write/);
  }
});
