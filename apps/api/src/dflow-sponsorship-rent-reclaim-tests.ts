import assert from "node:assert/strict";

import {
  extractDflowRentReclaimCandidateAccounts,
  reclaimSolanaSponsorshipRentAccounts,
  type DflowSponsorRentAccountInfo,
  type DflowSponsorRentCloseResult,
} from "./services/solana-sponsorship-rent-reclaim.js";
import { parseReconcileKalshiExecutionsArgs } from "./reconcile-kalshi-executions.js";

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

function metadata(
  accounts: string[],
  inputs: { currentNonFeeCostLamports?: string } = {},
) {
  return {
    sponsorshipReconciliation: {
      currentNonFeeCostLamports: inputs.currentNonFeeCostLamports,
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
    tx_signature:
      "5HcKhfeV6CzX5uD18tyjTdRPieGdXan7S78HJvV7raw2CuqdgVaeiNNsGjbSy76nqJy6yVA1E1mxuYbQkE1EskH2",
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
      inputs.tokenProgramId === undefined
        ? TOKEN_PROGRAM
        : inputs.tokenProgramId,
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

await test("kalshi reconcile defaults rent reclaim to same-job age gate", () => {
  const defaults = parseReconcileKalshiExecutionsArgs([]);
  assert.equal(defaults.minAgeSec, 15);
  assert.equal(defaults.rentReclaimMinAgeSec, 0);

  const parsed = parseReconcileKalshiExecutionsArgs([
    "--min-age-sec",
    "30",
    "--rent-reclaim-min-age-sec",
    "7",
  ]);
  assert.equal(parsed.minAgeSec, 30);
  assert.equal(parsed.rentReclaimMinAgeSec, 7);
});

await test("closes empty sponsor-owned SPL and Token-2022 accounts once", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000001",
      metadata: metadata(["A", "B"]),
    }),
    row({
      id: "00000000-0000-0000-0000-000000000002",
      metadata: metadata(["A"]),
    }),
  ];
  const db = fakePool(rows);
  const closeCalls: string[][] = [];
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
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
  });

  assert.deepEqual(closeCalls, [["A", "B"]]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.closed, 2);
  assert.equal(summary.reclaimedLamports, "4113360");
  assert.equal(db.updates.length, 2);
  assert.equal(db.updates[0]?.[1], "0");
  assert.equal(db.updates[0]?.[2], "returned");
  assert.equal(db.updates[0]?.[3], null);
  assert.equal(db.updates[1]?.[1], "0");
  assert.equal(db.updates[1]?.[2], "returned");
  assert.equal(db.updates[1]?.[3], null);
  const firstMetadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  assert.equal(
    firstMetadataUpdate.sponsorshipRentReclaim.reclaimedLamports,
    "4113360",
  );
  assert.equal(
    firstMetadataUpdate.sponsorshipRentReclaim.grossActualSponsorLamports,
    "4128395",
  );
  assert.equal(
    firstMetadataUpdate.sponsorshipRentReclaim.closeFeeLamports,
    "5000",
  );
  assert.equal(
    firstMetadataUpdate.sponsorshipRentReclaim.netActualSponsorLamports,
    "20035",
  );
  assert.deepEqual(
    firstMetadataUpdate.sponsorshipRentReclaim.closeTransactions[0].accounts,
    ["A", "B"],
  );
  assert.equal(
    firstMetadataUpdate.sponsorshipRentReclaim.closeTransactions[0].feeLamports,
    "5000",
  );
  const secondMetadataUpdate = JSON.parse(String(db.updates[1]?.[4]));
  assert.equal(
    secondMetadataUpdate.sponsorshipRentReclaim.reclaimedLamports,
    "0",
  );
  assert.equal(
    secondMetadataUpdate.sponsorshipRentReclaim.grossActualSponsorLamports,
    "4128395",
  );
  assert.equal(
    secondMetadataUpdate.sponsorshipRentReclaim.netActualSponsorLamports,
    "4128395",
  );
  assert.deepEqual(
    secondMetadataUpdate.sponsorshipRentReclaim.closeTransactions,
    [],
  );
});

await test("marks partially_reclaimed when only some sponsor rent can close", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000020",
      metadata: metadata(["reclaimable", "notClosable"], {
        currentNonFeeCostLamports: "4113360",
      }),
    }),
  ];
  const db = fakePool(rows);
  const closeCalls: string[][] = [];
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) =>
      account === "notClosable"
        ? tokenAccountInfo({ account, closeAuthority: "OtherAuthority" })
        : tokenAccountInfo({ account }),
    closeAccounts: async (accounts): Promise<DflowSponsorRentCloseResult> => {
      closeCalls.push(accounts.map((entry) => entry.account));
      return {
        accountResults: new Map(
          accounts.map((entry) => [
            entry.account,
            {
              status: "closed" as const,
              signature: "partialCloseSig",
              reclaimedLamports: entry.lamports,
            },
          ]),
        ),
        closeTransactions: [
          {
            signature: "partialCloseSig",
            accounts: accounts.map((entry) => entry.account),
            feeLamports: "5000",
            status: "closed",
          },
        ],
      };
    },
  });

  assert.deepEqual(closeCalls, [["reclaimable"]]);
  assert.equal(summary.closed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.reclaimedLamports, "2039280");
  assert.equal(db.updates[0]?.[1], "2074080");
  assert.equal(db.updates[0]?.[2], "partially_reclaimed");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.reclaimedLamports, "2039280");
  assert.equal(reclaim.remainingSponsorLossLamports, "2074080");
  assert.equal(reclaim.candidates[1].reason, "close_authority_not_sponsor");
});

await test("closes empty user-owned token account when sponsor is close authority", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000010",
      metadata: metadata(["closeAuthorityAccount"]),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
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
  });

  assert.equal(summary.closed, 1);
  assert.equal(summary.reclaimedLamports, "2039280");
  assert.equal(db.updates[0]?.[2], "returned");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const candidate = metadataUpdate.sponsorshipRentReclaim.candidates[0];
  assert.equal(candidate.tokenOwner, "UserOwner");
  assert.equal(candidate.closeAuthority, SPONSOR);
  assert.equal(candidate.closeStatus, "closed");
});

await test("records submitted close signatures without marking reclaimed", async () => {
  const submittedAt = "2026-06-02T12:00:00.000Z";
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000012",
      metadata: metadata(["pendingClose"]),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => tokenAccountInfo({ account }),
    closeAccounts: async (accounts): Promise<DflowSponsorRentCloseResult> => ({
      accountResults: new Map(
        accounts.map((entry) => [
          entry.account,
          {
            status: "submitted" as const,
            signature: "submittedCloseSig",
            error: "close_account_confirmation_submitted",
          },
        ]),
      ),
      closeTransactions: [
        {
          signature: "submittedCloseSig",
          accounts: accounts.map((entry) => entry.account),
          feeLamports: null,
          status: "submitted",
          error: "close_account_confirmation_submitted",
          submittedAt,
        },
      ],
    }),
  });

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates[0]?.[1], "2039280");
  assert.equal(db.updates[0]?.[2], "locked");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const candidate = metadataUpdate.sponsorshipRentReclaim.candidates[0];
  assert.equal(candidate.closeStatus, "submitted");
  assert.equal(candidate.closeSignature, "submittedCloseSig");
  assert.equal(candidate.reclaimedLamports, null);
  assert.equal(
    metadataUpdate.sponsorshipRentReclaim.closeTransactions[0].signature,
    "submittedCloseSig",
  );
  assert.equal(
    metadataUpdate.sponsorshipRentReclaim.closeTransactions[0].status,
    "submitted",
  );
  assert.equal(
    metadataUpdate.sponsorshipRentReclaim.closeTransactions[0].submittedAt,
    submittedAt,
  );
});

await test("skips fresh submitted close without submitting a duplicate", async () => {
  const submittedAt = new Date().toISOString();
  const existingMetadata = {
    ...metadata(["freshPendingClose"]),
    sponsorshipRentReclaim: {
      reclaimedAt: submittedAt,
      dryRun: false,
      remainingOpenLamports: "2039280",
      reclaimedLamports: "0",
      candidates: [
        {
          account: "freshPendingClose",
          eligible: true,
          reason: null,
          lamports: "2039280",
          tokenProgramId: TOKEN_PROGRAM,
          closeStatus: "submitted",
          closeSignature: "submittedCloseSig",
          closeError: "close_account_confirmation_submitted",
          reclaimedLamports: null,
        },
      ],
      closeTransactions: [
        {
          signature: "submittedCloseSig",
          accounts: ["freshPendingClose"],
          feeLamports: null,
          status: "submitted",
          error: "close_account_confirmation_submitted",
          submittedAt,
        },
      ],
    },
  };
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000015",
      metadata: existingMetadata,
    }),
  ];
  const db = fakePool(rows);
  let closeCalled = false;
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => tokenAccountInfo({ account }),
    closeAccounts: async () => {
      closeCalled = true;
      throw new Error("should not close fresh submitted account");
    },
  });

  assert.equal(closeCalled, false);
  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates[0]?.[1], "2039280");
  assert.equal(db.updates[0]?.[2], "locked");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.candidates[0].closeStatus, "submitted");
  assert.equal(reclaim.candidates[0].closeSignature, "submittedCloseSig");
  assert.equal(reclaim.closeTransactions[0].signature, "submittedCloseSig");
  assert.equal(reclaim.closeTransactions[0].submittedAt, submittedAt);
});

await test("stale submitted close allows a retry with a new signature", async () => {
  const existingMetadata = {
    ...metadata(["stalePendingClose"]),
    sponsorshipRentReclaim: {
      reclaimedAt: "2026-06-02T11:00:00.000Z",
      dryRun: false,
      remainingOpenLamports: "2039280",
      reclaimedLamports: "0",
      candidates: [
        {
          account: "stalePendingClose",
          eligible: true,
          reason: null,
          lamports: "2039280",
          tokenProgramId: TOKEN_PROGRAM,
          closeStatus: "submitted",
          closeSignature: "oldSubmittedCloseSig",
          closeError: "close_account_confirmation_submitted",
          reclaimedLamports: null,
        },
      ],
      closeTransactions: [
        {
          signature: "oldSubmittedCloseSig",
          accounts: ["stalePendingClose"],
          feeLamports: null,
          status: "submitted",
          error: "close_account_confirmation_submitted",
          submittedAt: "2026-06-02T11:00:00.000Z",
        },
      ],
    },
  };
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000016",
      metadata: existingMetadata,
    }),
  ];
  const db = fakePool(rows);
  const closeCalls: string[][] = [];
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => tokenAccountInfo({ account }),
    closeAccounts: async (accounts): Promise<DflowSponsorRentCloseResult> => {
      closeCalls.push(accounts.map((entry) => entry.account));
      return {
        accountResults: new Map(
          accounts.map((entry) => [
            entry.account,
            {
              status: "submitted" as const,
              signature: "newSubmittedCloseSig",
              error: "close_account_confirmation_submitted",
            },
          ]),
        ),
        closeTransactions: [
          {
            signature: "newSubmittedCloseSig",
            accounts: accounts.map((entry) => entry.account),
            feeLamports: null,
            status: "submitted",
            error: "close_account_confirmation_submitted",
            submittedAt: "2026-06-02T12:30:00.000Z",
          },
        ],
      };
    },
  });

  assert.deepEqual(closeCalls, [["stalePendingClose"]]);
  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates[0]?.[1], "2039280");
  assert.equal(db.updates[0]?.[2], "locked");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.candidates[0].closeStatus, "submitted");
  assert.equal(reclaim.candidates[0].closeSignature, "newSubmittedCloseSig");
  assert.deepEqual(
    reclaim.closeTransactions.map((tx: { signature: string }) => tx.signature),
    ["oldSubmittedCloseSig", "newSubmittedCloseSig"],
  );
});

await test("later missing account resolves prior submitted close as reclaimed", async () => {
  const existingMetadata = {
    ...metadata(["A"]),
    sponsorshipRentReclaim: {
      reclaimedAt: "2026-06-01T00:00:00.000Z",
      dryRun: false,
      remainingOpenLamports: "2039280",
      reclaimedLamports: "0",
      candidates: [
        {
          account: "A",
          eligible: true,
          reason: null,
          lamports: "2039280",
          tokenProgramId: TOKEN_PROGRAM,
          mint: "Mint11111111111111111111111111111111111111",
          closeStatus: "submitted",
          closeSignature: "submittedCloseSig",
          closeError: "close_account_confirmation_submitted",
          reclaimedLamports: null,
        },
      ],
      closeTransactions: [
        {
          signature: "submittedCloseSig",
          accounts: ["A"],
          feeLamports: null,
          status: "submitted",
          error: "close_account_confirmation_submitted",
          submittedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    },
  };
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000013",
      metadata: existingMetadata,
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => missingAccount(account),
    closeAccounts: async () => {
      throw new Error("should not close");
    },
  });

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates[0]?.[1], "0");
  assert.equal(db.updates[0]?.[2], "returned");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.reclaimedLamports, "2039280");
  assert.equal(reclaim.candidates[0].closeStatus, "closed");
  assert.equal(reclaim.candidates[0].closeSignature, "submittedCloseSig");
  assert.equal(reclaim.candidates[0].closeError, null);
  assert.equal(reclaim.candidates[0].reclaimedLamports, "2039280");
  assert.equal(reclaim.closeTransactions[0].status, "closed");
  assert.equal(reclaim.closeTransactions[0].error, null);
  assert.equal(reclaim.remainingSponsorLossLamports, "0");
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
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => missingAccount(account),
    closeAccounts: async () => {
      throw new Error("should not close");
    },
  });

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0]?.[1], "0");
  assert.equal(db.updates[0]?.[2], "returned");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.reclaimedLamports, "2039280");
  assert.equal(reclaim.closeTransactions[0].signature, "closeSig");
  assert.equal(
    reclaim.candidates[0].reason,
    "account_missing_or_already_closed",
  );
  assert.equal(reclaim.candidates[0].closeStatus, "closed");
  assert.equal(reclaim.candidates[0].closeSignature, "closeSig");
  assert.equal(reclaim.candidates[0].reclaimedLamports, "2039280");
});

await test("does not count user system-wallet lamports as reclaimable rent", async () => {
  const wallet = "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ";
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000014",
      wallet_address: wallet,
      actual_sponsor_lamports: "15101",
      metadata: metadata([wallet], { currentNonFeeCostLamports: "5000" }),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => ({
      account,
      exists: true,
      lamports: 7_217_242n,
      tokenProgramId: "11111111111111111111111111111111",
      tokenOwner: null,
      closeAuthority: null,
      tokenAmount: null,
      mint: null,
    }),
    closeAccounts: async () => {
      throw new Error("should not close");
    },
  });

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates[0]?.[1], "5000");
  assert.equal(db.updates[0]?.[2], "lost");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  const reclaim = metadataUpdate.sponsorshipRentReclaim;
  assert.equal(reclaim.openCandidateLamports, "0");
  assert.equal(reclaim.remainingOpenLamports, "5000");
  assert.equal(reclaim.remainingSponsorLossLamports, "5000");
  assert.equal(reclaim.candidates[0].reason, "not_token_account");
  assert.equal(reclaim.candidates[0].lamports, "7217242");
});

await test("skips non-empty, wrong-owner, missing, and non-token accounts", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000003",
      metadata: metadata(["nonEmpty", "wrongOwner", "missing", "nonToken"]),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
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
  });

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 4);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0]?.[1], "2039280");
  assert.equal(db.updates[0]?.[2], "locked");
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  assert.equal(
    metadataUpdate.sponsorshipRentReclaim.openCandidateLamports,
    "2039280",
  );
  assert.equal(
    metadataUpdate.sponsorshipRentReclaim.remainingSponsorLossLamports,
    "2039280",
  );
  const candidates = metadataUpdate.sponsorshipRentReclaim.candidates;
  assert.deepEqual(
    candidates.map((entry: { reason: string | null }) => entry.reason),
    [
      "token_balance_not_zero",
      "close_authority_not_sponsor",
      "account_missing_or_already_closed",
      "not_token_account",
    ],
  );
});

await test("skips sponsor-owned token account when close authority is not sponsor", async () => {
  const rows = [
    row({
      id: "00000000-0000-0000-0000-000000000011",
      metadata: metadata(["delegatedClose"]),
    }),
  ];
  const db = fakePool(rows);
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: false,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) =>
      tokenAccountInfo({
        account,
        tokenOwner: SPONSOR,
        closeAuthority: "OtherCloseAuthority",
      }),
    closeAccounts: async () => {
      throw new Error("should not close");
    },
  });

  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  const metadataUpdate = JSON.parse(String(db.updates[0]?.[4]));
  assert.equal(
    metadataUpdate.sponsorshipRentReclaim.candidates[0].reason,
    "close_authority_not_sponsor",
  );
});

await test("dry run verifies but does not close or update", async () => {
  const rows = [row()];
  const db = fakePool(rows);
  let closeCalled = false;
  const summary = await reclaimSolanaSponsorshipRentAccounts(db.pool as never, {
    dryRun: true,
    limit: 10,
    minAgeSec: 0,
    fetchAccount: async (account) => tokenAccountInfo({ account }),
    closeAccounts: async () => {
      closeCalled = true;
      throw new Error("should not close");
    },
  });

  assert.equal(closeCalled, false);
  assert.equal(summary.checked, 1);
  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.updates.length, 0);
});

console.log("[dflow-sponsorship-rent-reclaim-tests] ok");
