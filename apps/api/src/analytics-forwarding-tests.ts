#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import { forwardedAnalyticsEventNameSchema } from "./schemas/analytics.js";
import {
  collectAnalyticsEvent,
  COLLECTED_ANALYTICS_EVENTS,
  setAnalyticsDeliveryModeForTests,
} from "./services/analytics-forwarding.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

function createMockDbQuery(): DbQuery & {
  dedupeKeys: Set<string>;
  inserts: Array<{
    attemptId: string | null;
    dedupeKey: string | null;
    event: string;
    origin: string;
    status: string | null;
  }>;
} {
  const dedupeKeys = new Set<string>();
  const inserts: Array<{
    attemptId: string | null;
    dedupeKey: string | null;
    event: string;
    origin: string;
    status: string | null;
  }> = [];

  const query = async <T extends Record<string, unknown>>(
    _sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    const values = Array.isArray(params) ? params : [];
    const event = typeof values[1] === "string" ? values[1] : null;
    const status = typeof values[4] === "string" ? values[4] : null;
    const attemptId = typeof values[7] === "string" ? values[7] : null;
    const dedupeKey = typeof values[9] === "string" ? values[9] : null;
    const origin = typeof values[10] === "string" ? values[10] : null;
    if (!event || !origin) {
      throw new Error("MockDbQuery received unexpected insert parameters");
    }

    inserts.push({
      event,
      status,
      attemptId,
      dedupeKey,
      origin,
    });

    if (dedupeKey && dedupeKeys.has(`${event}:${dedupeKey}`)) {
      return { rows: [] };
    }
    if (dedupeKey) {
      dedupeKeys.add(`${event}:${dedupeKey}`);
    }
    return { rows: [{ id: `row_${inserts.length}` } as unknown as T] };
  };

  return {
    query: query as DbQuery["query"],
    dedupeKeys,
    inserts,
  };
}

function assertAccepted(
  result: Awaited<ReturnType<typeof collectAnalyticsEvent>>,
): asserts result is Extract<
  Awaited<ReturnType<typeof collectAnalyticsEvent>>,
  { accepted: true }
> {
  assert.equal(result.accepted, true);
}

const tests: TestCase[] = [
  {
    name: "collector whitelist stays aligned with public forward schema",
    run: () => {
      assert.deepEqual(
        [...COLLECTED_ANALYTICS_EVENTS].sort(),
        [...forwardedAnalyticsEventNameSchema.options].sort(),
      );
    },
  },
  {
    name: "rewards claim collector keeps submit and backend terminal statuses separately",
    run: async () => {
      setAnalyticsDeliveryModeForTests("database");
      const pool = createMockDbQuery();

      try {
        const submit = await collectAnalyticsEvent(pool, {
          event: "hf_rewards_claim_action",
          origin: "browser",
          userId: "user-1",
          payload: {
            analytics_schema_version: "frontend-v1",
            source: "earnings_dialog",
            status: "claim_submit",
            event_slug: "137",
            attempt_id: "claim-1",
          },
        });
        assertAccepted(submit);
        const success = await collectAnalyticsEvent(pool, {
          event: "hf_rewards_claim_action",
          origin: "backend",
          userId: "user-1",
          payload: {
            source: "earnings_dialog",
            status: "claim_success",
            event_slug: "137",
            attempt_id: "claim-1",
          },
        });
        assertAccepted(success);
        const error = await collectAnalyticsEvent(pool, {
          event: "hf_rewards_claim_action",
          origin: "backend",
          userId: "user-1",
          payload: {
            source: "earnings_dialog",
            status: "claim_error",
            event_slug: "137",
            attempt_id: "claim-1",
          },
        });
        assertAccepted(error);
        const duplicateSuccess = await collectAnalyticsEvent(pool, {
          event: "hf_rewards_claim_action",
          origin: "backend",
          userId: "user-1",
          payload: {
            source: "earnings_dialog",
            status: "claim_success",
            event_slug: "137",
            attempt_id: "claim-1",
          },
        });
        assertAccepted(duplicateSuccess);

        assert.deepEqual(
          pool.inserts.map((entry) => entry.dedupeKey),
          [
            "hf_rewards_claim_action:claim-1:claim_submit",
            "hf_rewards_claim_action:claim-1:claim_success",
            "hf_rewards_claim_action:claim-1:claim_error",
            "hf_rewards_claim_action:claim-1:claim_success",
          ],
        );
        assert.deepEqual(
          [
            submit.deduped,
            success.deduped,
            error.deduped,
            duplicateSuccess.deduped,
          ],
          [false, false, false, true],
        );
      } finally {
        setAnalyticsDeliveryModeForTests(null);
      }
    },
  },
  {
    name: "portfolio cancel collector keeps submit, success, and error statuses separately",
    run: async () => {
      setAnalyticsDeliveryModeForTests("database");
      const pool = createMockDbQuery();

      try {
        const statuses = [
          "cancel_submit",
          "cancel_success",
          "cancel_error",
        ] as const;
        for (const status of statuses) {
          const result = await collectAnalyticsEvent(pool, {
            event: "hf_portfolio_order_cancel",
            origin: "browser",
            userId: "user-2",
            payload: {
              analytics_schema_version: "frontend-v1",
              source: "portfolio",
              status,
              attempt_id: "cancel-1",
            },
          });
          assertAccepted(result);
          assert.equal(result.deduped, false);
        }

        const duplicateSubmit = await collectAnalyticsEvent(pool, {
          event: "hf_portfolio_order_cancel",
          origin: "browser",
          userId: "user-2",
          payload: {
            analytics_schema_version: "frontend-v1",
            source: "portfolio",
            status: "cancel_submit",
            attempt_id: "cancel-1",
          },
        });
        assertAccepted(duplicateSubmit);

        assert.deepEqual(
          pool.inserts.map((entry) => entry.dedupeKey),
          [
            "hf_portfolio_order_cancel:cancel-1:cancel_submit",
            "hf_portfolio_order_cancel:cancel-1:cancel_success",
            "hf_portfolio_order_cancel:cancel-1:cancel_error",
            "hf_portfolio_order_cancel:cancel-1:cancel_submit",
          ],
        );
        assert.equal(duplicateSubmit.deduped, true);
      } finally {
        setAnalyticsDeliveryModeForTests(null);
      }
    },
  },
  {
    name: "monitor collector accepts expanded backend analytics event coverage",
    run: async () => {
      setAnalyticsDeliveryModeForTests("database");
      const pool = createMockDbQuery();

      try {
        const browserEvents = [
          {
            event: "hf_wallet_connect_click",
            payload: {
              analytics_schema_version: "frontend-v1",
              source: "header",
            },
          },
          {
            event: "hf_wallet_connect_completed_funnel",
            payload: {
              analytics_schema_version: "frontend-v1",
              source: "header",
              status: "completed",
            },
          },
          {
            event: "hf_wallet_link_error",
            payload: {
              analytics_schema_version: "frontend-v1",
              source: "deposit",
              status: "wallet_link_error",
            },
          },
          {
            event: "hf_market_open",
            payload: {
              analytics_schema_version: "frontend-v1",
              event_id: "event-1",
            },
          },
          {
            event: "hf_event_entry_open",
            payload: {
              analytics_schema_version: "frontend-v1",
              event_id: "event-1",
              source: "home",
            },
          },
        ];

        for (const entry of browserEvents) {
          const result = await collectAnalyticsEvent(pool, {
            event: entry.event,
            origin: "browser",
            payload: entry.payload,
          });
          assertAccepted(result);
          assert.equal(result.deduped, false);
        }

        const missingUser = await collectAnalyticsEvent(pool, {
          event: "hf_trade_submit_no_terminal_2m",
          origin: "browser",
          payload: {
            analytics_schema_version: "frontend-v1",
            attempt_id: "order-1",
            status: "timeout_120s",
            venue: "polymarket",
          },
        });
        assert.equal(missingUser.accepted, false);
        assert.equal(missingUser.reason, "invalid");

        const timeout = await collectAnalyticsEvent(pool, {
          event: "hf_trade_submit_no_terminal_2m",
          origin: "browser",
          userId: "user-4",
          payload: {
            analytics_schema_version: "frontend-v1",
            attempt_id: "order-1",
            status: "timeout_120s",
            venue: "polymarket",
          },
        });
        assertAccepted(timeout);
        assert.equal(timeout.deduped, false);
        assert.equal(
          pool.inserts.at(-1)?.dedupeKey,
          "hf_trade_submit_no_terminal_2m:order-1",
        );
      } finally {
        setAnalyticsDeliveryModeForTests(null);
      }
    },
  },
  {
    name: "redemption collector keeps submit, success, and error statuses separately",
    run: async () => {
      setAnalyticsDeliveryModeForTests("database");
      const pool = createMockDbQuery();

      try {
        const statuses = [
          "redemption_submit",
          "redemption_success",
          "redemption_fail",
        ] as const;
        for (const status of statuses) {
          const result = await collectAnalyticsEvent(pool, {
            event: "hf_redemption_action",
            origin: "browser",
            userId: "user-3",
            payload: {
              analytics_schema_version: "frontend-v1",
              source: "portfolio_positions",
              status,
              attempt_id: "redeem-1",
            },
          });
          assertAccepted(result);
          assert.equal(result.deduped, false);
        }

        const duplicateSuccess = await collectAnalyticsEvent(pool, {
          event: "hf_redemption_action",
          origin: "browser",
          userId: "user-3",
          payload: {
            analytics_schema_version: "frontend-v1",
            source: "portfolio_positions",
            status: "redemption_success",
            attempt_id: "redeem-1",
          },
        });
        assertAccepted(duplicateSuccess);

        assert.deepEqual(
          pool.inserts.map((entry) => entry.dedupeKey),
          [
            "hf_redemption_action:redeem-1:redemption_submit",
            "hf_redemption_action:redeem-1:redemption_success",
            "hf_redemption_action:redeem-1:redemption_fail",
            "hf_redemption_action:redeem-1:redemption_success",
          ],
        );
        assert.equal(duplicateSuccess.deduped, true);
      } finally {
        setAnalyticsDeliveryModeForTests(null);
      }
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[analytics-forwarding-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[analytics-forwarding-tests] passed ${passed}/${tests.length}`);
