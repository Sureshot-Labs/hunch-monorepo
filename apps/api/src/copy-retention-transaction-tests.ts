import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import {
  copyPayloadHash,
  retainCopyBeforeSubmission,
  retainCopyBeforeSubmissionInTransaction,
  type CopyRetentionInput,
} from "./services/social-copy.js";
import type { PreparedTrade } from "./services/trading-types.js";

const userId = "10000000-0000-4000-8000-000000000001";
const prepared: PreparedTrade = {
  preparedId: "prepared-copy",
  venue: "polymarket",
  quote: null,
  authorizationMode: "client_signed_order",
  authorizationRequests: [],
  reconcileKeys: {},
  venuePayload: {},
  expiresAt: null,
  intent: {
    actor: { kind: "web_app", userId },
    venue: "polymarket",
    sourceRef: {
      kind: "hunch",
      id: "10000000-0000-4000-8000-000000000002",
    },
    walletAddress: `0x${"1".repeat(40)}`,
    action: "BUY",
    outcome: "YES",
    amount: { type: "usd", value: "1" },
    idempotencyKey: "retained-copy",
    target: {
      venue: "polymarket",
      marketId: "polymarket:fixture",
      tokenId: "123",
      outcome: "YES",
      eventId: null,
      venueMarketId: null,
      title: null,
    },
  },
};
const input: CopyRetentionInput = {
  prepared,
  providerReference: `polymarket:137:0x${"2".repeat(40)}:0x${"3".repeat(64)}`,
  preparedFingerprint: "prepared-fingerprint",
};

function fixture(
  options: {
    active?: boolean;
    state?: string;
    started?: boolean;
    conflict?: boolean;
    transactions?: boolean;
  } = {},
) {
  const statements: string[] = [];
  let connections = 0;
  let releases = 0;
  const query = async (text: string) => {
    const sql = text.replace(/\s+/gu, " ").trim();
    statements.push(sql);
    let rows: unknown[];
    if (["begin", "commit", "rollback"].includes(sql)) {
      assert.ok(
        options.transactions,
        "retention must use the caller's transaction",
      );
      rows = [];
    } else if (sql.startsWith("select id,is_active from users")) {
      rows = [{ id: userId, is_active: options.active ?? true }];
    } else if (sql.startsWith("select pg_advisory_xact_lock")) {
      rows = [];
    } else if (sql.startsWith("select id,payload_hash")) {
      rows = [
        {
          id: "copy-row",
          payload_hash: options.conflict
            ? "different"
            : copyPayloadHash(prepared),
          provider_reference: input.providerReference,
          prepared_fingerprint: input.preparedFingerprint,
          state: options.state ?? "pending",
          submission_started_at: options.started ? new Date(0) : null,
        },
      ];
    } else if (sql.startsWith("update copy_attributions")) {
      rows = [{ submission_attempt_token: "fresh-attempt-token" }];
    } else {
      throw new Error(`Unexpected retention SQL: ${sql}`);
    }
    return { rows, rowCount: rows.length };
  };
  const client = {
    query,
    release() {
      releases++;
    },
  };
  const pool = {
    query,
    async connect() {
      connections++;
      return client;
    },
  } as unknown as Pool;
  return {
    client: pool,
    pool,
    statements,
    counts: () => ({ connections, releases }),
  };
}

test("executor retention uses its supplied transaction without borrowing a connection", async () => {
  const f = fixture({ started: true });
  const attempt = await retainCopyBeforeSubmissionInTransaction(
    f.client,
    input,
  );
  assert.equal(attempt.created, false);
  assert.equal(attempt.priorSubmissionUncertain, true);
  assert.equal(attempt.attemptToken, "fresh-attempt-token");
  assert.deepEqual(f.counts(), { connections: 0, releases: 0 });
  assert.equal(f.statements.length, 4);
});

test("ordinary wrapper retains the same single transaction and release lifecycle", async () => {
  const f = fixture({ transactions: true });
  const attempt = await retainCopyBeforeSubmission(f.pool, input);
  assert.equal(attempt.priorSubmissionUncertain, false);
  assert.equal(f.statements[0], "begin");
  assert.equal(f.statements.at(-1), "commit");
  assert.deepEqual(f.counts(), { connections: 1, releases: 1 });
});

test("idempotent retention precedes new policy/visibility checks and preserves uncertainty", async () => {
  for (const state of ["pending", "confirmed", "revoked"]) {
    const f = fixture({ state, started: true });
    assert.equal(
      (await retainCopyBeforeSubmissionInTransaction(f.client, input))
        .priorSubmissionUncertain,
      true,
    );
    assert.ok(f.statements.every((sql) => !sql.includes("runtime_policies")));
  }
});

test("proven failed pre-submit retention can retry without inheriting uncertainty", async () => {
  const f = fixture({ state: "failed", started: true });
  assert.equal(
    (await retainCopyBeforeSubmissionInTransaction(f.client, input))
      .priorSubmissionUncertain,
    false,
  );
});

test("conflicting replay never updates the retained attribution", async () => {
  const f = fixture({ conflict: true });
  await assert.rejects(
    retainCopyBeforeSubmissionInTransaction(f.client, input),
    /copy_idempotency_conflict/u,
  );
  assert.ok(f.statements.every((sql) => !sql.startsWith("update")));
});

test("ordinary wrapper rolls back and releases on retention failure", async () => {
  const f = fixture({ transactions: true, active: false });
  await assert.rejects(
    retainCopyBeforeSubmission(f.pool, input),
    /social_account_unavailable/u,
  );
  assert.equal(f.statements.at(-1), "rollback");
  assert.deepEqual(f.counts(), { connections: 1, releases: 1 });
});

test("missing Copy source does not open a transaction or issue SQL", async () => {
  const f = fixture();
  const missing = {
    ...input,
    prepared: {
      ...prepared,
      intent: { ...prepared.intent, sourceRef: undefined },
    },
  };
  await assert.rejects(
    retainCopyBeforeSubmission(f.pool, missing),
    /copy_source_required/u,
  );
  await assert.rejects(
    retainCopyBeforeSubmissionInTransaction(f.client, missing),
    /copy_source_required/u,
  );
  assert.equal(f.statements.length, 0);
  assert.deepEqual(f.counts(), { connections: 0, releases: 0 });
});
