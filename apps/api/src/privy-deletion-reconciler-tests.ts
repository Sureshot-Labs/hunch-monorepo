import assert from "node:assert/strict";

import { PrivyUserNotFoundError } from "./privy-service.js";
import { reconcilePendingPrivyDeletions } from "./services/privy-deletion-reconciler.js";

function lifecycleRow(input: { active: boolean; protected: boolean }) {
  return {
    active_funding_movement: input.active,
    active_legacy_bridge: false,
    active_position_action: false,
    active_preparation: false,
    active_receive_session: false,
    active_telegram_intent: false,
    deposit_evidence: false,
    funding_evidence: input.protected,
    legacy_bridge_evidence: false,
    position_action_evidence: false,
    preparation_run_count: "0",
    receive_evidence: false,
    trading_evidence: false,
  };
}

function createDb(input: { active?: boolean; protected?: boolean } = {}) {
  const state: {
    exists: boolean;
    pending: boolean;
    privyUserId: string | null;
  } = {
    exists: true,
    pending: true,
    privyUserId: "did:privy:test",
  };
  const query = async (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.includes("information_schema.columns")) {
      return { rows: [{ ready: true }] };
    }
    if (
      normalized.startsWith("select id from users") &&
      normalized.includes("privy_deletion_pending = true")
    ) {
      return { rows: state.exists && state.pending ? [{ id: "user-1" }] : [] };
    }
    if (normalized.includes("pg_try_advisory_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (normalized.includes("pg_advisory_unlock")) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    if (
      normalized.startsWith(
        "select privy_user_id, privy_deletion_pending from users",
      )
    ) {
      return {
        rows:
          state.exists && state.pending
            ? [
                {
                  privy_deletion_pending: state.pending,
                  privy_user_id: state.privyUserId,
                },
              ]
            : [],
      };
    }
    if (normalized.includes("as active_preparation")) {
      return {
        rows: [
          lifecycleRow({
            active: input.active === true,
            protected: input.protected === true,
          }),
        ],
      };
    }
    if (normalized.startsWith("delete from users")) {
      state.exists = false;
      return { rowCount: 1, rows: [] };
    }
    if (
      normalized.startsWith("update users") &&
      normalized.includes("set privy_user_id = null")
    ) {
      state.pending = false;
      state.privyUserId = null;
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };
  return {
    db: {
      query,
      connect: async () => ({ query, release: () => undefined }),
    },
    state,
  };
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "Privy deletion hard-deletes a user without protected evidence",
    run: async () => {
      const fixture = createDb();
      let calls = 0;
      const summary = await reconcilePendingPrivyDeletions(
        fixture.db as never,
        { userId: "user-1" },
        {
          deletePrivyUser: async () => {
            calls += 1;
          },
        },
      );
      assert.equal(calls, 1);
      assert.equal(summary.completed, 1);
      assert.equal(summary.hardDeleted, 1);
      assert.equal(fixture.state.exists, false);
    },
  },
  {
    name: "Privy deletion retains financial evidence and treats remote 404 as success",
    run: async () => {
      const fixture = createDb({ protected: true });
      const summary = await reconcilePendingPrivyDeletions(
        fixture.db as never,
        { userId: "user-1" },
        {
          deletePrivyUser: async () => {
            throw new PrivyUserNotFoundError();
          },
        },
      );
      assert.equal(summary.completed, 1);
      assert.equal(summary.retained, 1);
      assert.equal(fixture.state.exists, true);
      assert.equal(fixture.state.pending, false);
      assert.equal(fixture.state.privyUserId, null);
    },
  },
  {
    name: "Privy deletion never calls the provider while movement is active",
    run: async () => {
      const fixture = createDb({ active: true, protected: true });
      let calls = 0;
      const summary = await reconcilePendingPrivyDeletions(
        fixture.db as never,
        { userId: "user-1" },
        {
          deletePrivyUser: async () => {
            calls += 1;
          },
        },
      );
      assert.equal(calls, 0);
      assert.equal(summary.activeMovement, 1);
      assert.equal(fixture.state.pending, true);
    },
  },
  {
    name: "Privy provider failure leaves the durable pending marker",
    run: async () => {
      const fixture = createDb();
      const summary = await reconcilePendingPrivyDeletions(
        fixture.db as never,
        { userId: "user-1" },
        {
          deletePrivyUser: async () => {
            throw new Error("provider unavailable");
          },
        },
      );
      assert.equal(summary.failed, 1);
      assert.equal(summary.completed, 0);
      assert.equal(fixture.state.exists, true);
      assert.equal(fixture.state.pending, true);
    },
  },
];

for (const test of tests) {
  try {
    await test.run();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    console.error(`✗ ${test.name}`);
    throw error;
  }
}
