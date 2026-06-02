import assert from "node:assert/strict";

import {
  extractDflowRentReclaimCandidateAccounts,
  reclaimSolanaSponsorshipRentAccounts,
  type DflowSponsorRentAccountInfo,
  type DflowSponsorRentCloseResult,
} from "./services/solana-sponsorship-rent-reclaim.js";

const SPONSOR = "B2oU6ZDdb3dk4GMJepKiWiBVVzF46vuW12RcKpQ5sGTX";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`[dflow-sponsorship-rent-reclaim-tests] ok ${name}`);
  } catch (error) {
    console.error(`[dflow-sponsorship-rent-reclaim-tests] failed ${name}`);
    throw error;
  }
}

function metadata(accounts: string[]) {
  return {
    sponsorshipReconciliation: {
      transactions: [
        {
          nonSponsorLamportDeltas: accounts.map((account, index) => ({
            account,
            deltaLamports: String(1_000 + index),
          })),
        },
      ],
    },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    user_id: crypto.randomUUID(),
    intent_id: `solsp_${crypto.randomUUID()}`,
    wallet_address: "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ",
    sponsor_address: SPONSOR,
    market_id: "kalshi:TEST",
    input_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    output_mint: "FrYpcm2JAS7tqLMgJV4hMJQMgEhBwuAPBqQVfN5biutt",
    amount_raw: "1000000",
    message_digest: null,
    transaction_digest: null,
    tx_signature: "5HcKhfeV6CzX5uD18tyjTdRPieGdXan7S78HJvV7raw2CuqdgVaeiNNsGjbSy76nqJy6yVA1E1mxuYbQkE1EskH2",
    estimated_sponsor_lamports: "5000",
    actual_sponsor_lamports: "4128395",
    rent_status: "lost",
    metadata: metadata(["Acct1111111111111111111111111111111111111"]),
    ...overrides,
  };
}

function tokenAccountInfo(inputs: {
  account: string;
  lamports?: bigint;
  tokenProgramId?: string | null;
  tokenOwner?: string | null;
  closeAuthority?: string | null;
  tokenAmount?: bigint | null;
}): DflowSponsorRentAccountInfo {
  return {
    account: inputs.account,
    exists: true,
    lamports: inputs.lamports ?? 2_039_280n,
    tokenProgramId:
      inputs.tokenProgramId === undefined ? TOKEN_PROGRAM : inputs.tokenProgramId,
    tokenOwner: inputs.tokenOwner === undefined ? SPONSOR : inputs.tokenOwner,
    closeAuthority:
      inputs.closeAuthority === undefined ? null : inputs.closeAuthority,
    tokenAmount: inputs.tokenAmount === undefined ? 0n : inputs.tokenAmount,
    mint: "Mint11111111111111111111111111111111111111",
  };
}

function missingAccount(account: string): DflowSponsorRentAccountInfo {
  return {
    account,
    exists: false,
    lamports: 0n,
    tokenProgramId: null,
    tokenOwner: null,
    closeAuthority: null,
    tokenAmount: null,
    mint: null,
  };
}

function fakePool(rows: unknown[]) {
  const updates: unknown[][] = [];
  return {
    updates,
    pool: {
      async query(sql: string, params: unknown[]) {
        if (sql.includes("select")) {
          return { rows };
        }
        if (sql.includes("update solana_sponsorship_ledger")) {
          if (sql.includes("returning id")) {
            return {
              rows: rows.map((entry) => ({
                id: (entry as { id: string }).id,
              })),
            };
          }
          updates.push(params);
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
  };
}

await test("extracts unique positive-delta candidate accounts", () => {
  assert.deepEqual(
    extractDflowRentReclaimCandidateAccounts({
      sponsorshipReconciliation: {
        transactions: [
          {
            nonSponsorLamportDeltas: [
              { account: "A", deltaLamports: "10" },
              { account: "A", deltaLamports: "5" },
              { account: "B", deltaLamports: "-1" },
              { account: "C", deltaLamports: "0" },
            ],
          },
        ],
      },
    }),
    ["A"],
  );
});

await test("closes empty sponsor-owned SPL and Token-2022 accounts once", async () => {
  const rows = [
    row({ id: "00000000-0000-0000-0000-000000000001", metadata: metadata(["A", "B"]) }),
    row({ id: "00000000-0000-0000-0000-000000000002", metadata: metadata(["A"]) }),
  ];
  const db = fakePool(rows);
  const closeCalls: string[][] = [];
  const summary = await reclaimSolanaSponsorshipRentAccounts(
    db.pool as never,
    {
      dryRun: false,
      limit: 10,
      minAgeSec: 0,
      fetchAccount: async (account) =>
        tokenAccountInfo({
          account,
          tokenProgramId: account === "B" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
          lamports: account === "B" ? 2_074_080n : 2_039_280n,
        }),
      closeAccounts: async (accounts): Promise<DflowSponsorRentCloseResult> => {
        closeCalls.push(accounts.map((entry) => entry.account));
        return {
          accountResults: new Map(
            accounts.map((entry) => [
              entry.account,
              {
                status: "closed" as const,
                signature: "closeSig",
                reclaimedLamports: entry.lamports,
              },
            ]),
          ),
          closeTransactions: [
            {
              signature: "closeSig",
              accounts: accounts.map((entry) => entry.account),
              feeLamports: "5000",
            },
          ],
        };
      },
    },
  );

  assert.deepEqual(closeCalls, [["A", "B"]]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.closed, 2);
  assert.equal(summary.reclaimedLamports, "4113360");
  assert.equal(db.updates.length, 2);
  assert.equal(db.updates[0]?.[2], "returned");
  assert.equal(db.updates[1]?.[2], "returned");
});

await test("closes empty user-owned token account when sponsor is close authority", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000010",
      metadata: metadata(["closeAuthorityAccount"]),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(
    db.pool as never,
    {
      dryRun: false,
      limit: 10,
      minAgeSec: 0,
      fetchAccount: async (account) =>
        tokenAccountInfo({
          account,
          tokenOwner: "UserOwner",
          closeAuthority: SPONSOR,
        }),
      closeAccounts: async (accounts): Promise<DflowSponsorRentCloseResult> => ({
        accountResults: new Map(
          accounts.map((entry) => [
            entry.account,
            {
              status: "closed" as const,
              signature: "closeByAuthoritySig",
              reclaimedLamports: entry.lamports,
            },
          ]),
        ),
        closeTransactions: [
          {
            signature: "closeByAuthoritySig",
            accounts: accounts.map((entry) => entry.account),
            feeLamports: "5000",
          },
        ],
      }),
    },
  );

  assert.equal(summary.closed, 1);
  assert.equal(summary.reclaimedLamports, "2039280");
  assert.equal(db.updates[0]?.[2], "returned");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const candidate = metadataUpdate.sponsorshipRentReclaim.candidates[0];
  assert.equal(candidate.tokenOwner, "UserOwner");
  assert.equal(candidate.closeAuthority, SPONSOR);
  assert.equal(candidate.closeStatus, "closed");
});

await test("preserves close audit when a later pass sees account already closed", async () => {
  const existingMetadata = {
    ...metadata(["A"]),
    sponsorshipRentReclaim: {
      reclaimedAt: "2026-06-01T00:00:00.000Z",
      dryRun: false,
      remainingOpenLamports: "0",
      reclaimedLamports: "2039280",
      candidates: [
        {
          account: "A",
          eligible: true,
          reason: null,
          lamports: "2039280",
          tokenProgramId: TOKEN_PROGRAM,
          mint: "Mint11111111111111111111111111111111111111",
          closeStatus: "closed",
          closeSignature: "closeSig",
          closeError: null,
          reclaimedLamports: "2039280",
        },
      ],
      closeTransactions: [
        {
          signature: "closeSig",
          accounts: ["A"],
          feeLamports: "5000",
        },
      ],
    },
  };
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000009",
      metadata: existingMetadata,
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(
    db.pool as never,
    {
      dryRun: false,
      limit: 10,
      minAgeSec: 0,
      fetchAccount: async (account) => missingAccount(account),
      closeAccounts: async () => {
        throw new Error("should not close");
      },
    },
  );

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0]?.[1], "0");
  assert.equal(db.updates[0]?.[2], "returned");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.reclaimedLamports, "2039280");
  assert.equal(reclaim.closeTransactions[0].signature, "closeSig");
  assert.equal(reclaim.candidates[0].reason, "account_missing_or_already_closed");
  assert.equal(reclaim.candidates[0].closeStatus, "closed");
  assert.equal(reclaim.candidates[0].closeSignature, "closeSig");
  assert.equal(reclaim.candidates[0].reclaimedLamports, "2039280");
});

await test("skips non-empty, wrong-owner, missing, and non-token accounts", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000003",
      metadata: metadata(["nonEmpty", "wrongOwner", "missing", "nonToken"]),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(
    db.pool as never,
    {
      dryRun: false,
      limit: 10,
      minAgeSec: 0,
      fetchAccount: async (account) => {
        if (account === "nonEmpty") {
          return tokenAccountInfo({ account, tokenAmount: 1n });
        }
        if (account === "wrongOwner") {
          return tokenAccountInfo({ account, tokenOwner: "OtherOwner" });
        }
        if (account === "missing") return missingAccount(account);
        return tokenAccountInfo({ account, tokenProgramId: null });
      },
      closeAccounts: async () => {
        throw new Error("should not close");
      },
    },
  );

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 4);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0]?.[1], "6117840");
  assert.equal(db.updates[0]?.[2], "lost");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const candidates = metadataUpdate.sponsorshipRentReclaim.candidates;
  assert.deepEqual(
    candidates.map((entry: { reason: string | null }) => entry.reason),
    [
      "token_balance_not_zero",
      "token_owner_or_close_authority_not_sponsor",
      "account_missing_or_already_closed",
      "not_token_account",
    ],
  );
});

await test("dry run verifies but does not close or update", async () => {
  const rows = [row()];
  const db = fakePool(rows);
  let closeCalled = false;
  const summary = await reclaimSolanaSponsorshipRentAccounts(
    db.pool as never,
    {
      dryRun: true,
      limit: 10,
      minAgeSec: 0,
      fetchAccount: async (account) => tokenAccountInfo({ account }),
      closeAccounts: async () => {
        closeCalled = true;
        throw new Error("should not close");
      },
    },
  );

  assert.equal(closeCalled, false);
  assert.equal(summary.checked, 1);
  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates.length, 0);
});

console.log("[dflow-sponsorship-rent-reclaim-tests] ok");
