import assert from "node:assert/strict";

import { countReferralsForUser } from "./repos/rewards.js";
import {
  getReferralAttachmentStatus,
  getRewardsPolicy,
  getRewardsReferrals,
} from "./services/rewards.js";

type RewardsQuery = Parameters<typeof getRewardsPolicy>[0];

function normalizeSql(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "default rewards policy exposes the shared referral threshold",
    run: async () => {
      const query: RewardsQuery = {
        query: async () => ({ rows: [] }),
      } as unknown as RewardsQuery;

      const policy = await getRewardsPolicy(query);

      assert.deepEqual(policy.referralQualification, {
        pointsRequired: 500,
      });
    },
  },
  {
    name: "referral count parses the database aggregate",
    run: async () => {
      const query = {
        query: async (sql: unknown) => {
          assert.match(normalizeSql(sql), /select count\(\*\)::text as total/);
          return { rows: [{ total: "83" }] };
        },
      } as RewardsQuery;

      assert.equal(await countReferralsForUser(query, "user-1"), 83);
    },
  },
  {
    name: "inbound invite status is refreshed before it is displayed",
    run: async () => {
      let status: "pending" | "qualified" = "pending";
      const query = {
        query: async (sql: unknown) => {
          const normalized = normalizeSql(sql);
          if (normalized.includes("where r.referred_user_id = $1")) {
            return {
              rows: [
                {
                  referrer_user_id: "user-1",
                  code: "HUNCH42",
                  referral_code_id: "code-1",
                  policy_type: "user",
                  policy_id: "policy-1",
                  policy_label: null,
                  policy_multiplier_override: null,
                  policy_owner_user_id: "user-1",
                  status,
                  linked_at: new Date("2026-07-01T00:00:00.000Z"),
                  qualified_at:
                    status === "qualified"
                      ? new Date("2026-07-24T00:00:00.000Z")
                      : null,
                  referrer_username: "forecaster",
                  referrer_display_name: "Forecaster",
                },
              ],
            };
          }
          if (normalized.includes("update referrals r")) {
            status = "qualified";
            return { rows: [] };
          }
          throw new Error(`Unexpected attachment query: ${normalized}`);
        },
      } as RewardsQuery;

      const result = await getReferralAttachmentStatus(query, {
        userId: "user-2",
      });

      assert.equal(result.status, "qualified");
      assert.equal(result.referrer?.userId, "user-1");
      assert.ok(result.qualifiedAt instanceof Date);
    },
  },
  {
    name: "referrals response includes pagination metadata and effective status",
    run: async () => {
      const query = {
        query: async (sql: unknown) => {
          const normalized = normalizeSql(sql);
          if (normalized.includes("from rewards_policy")) {
            return { rows: [] };
          }
          if (
            normalized.includes("from volume_events ve") &&
            normalized.includes("where ve.user_id = $1")
          ) {
            return { rows: [{ total: "500" }] };
          }
          if (normalized.includes("update referrals r")) {
            return { rows: [] };
          }
          if (normalized.includes("with referral_rows as")) {
            return {
              rows: [
                {
                  id: "referral-1",
                  referred_user_id: "user-2",
                  status: "pending",
                  qualified_at: null,
                  created_at: new Date("2026-07-24T00:00:00.000Z"),
                  wallet_address: "0x1234567890abcdef",
                  points: "500",
                  tier_points: "500",
                  qualification_points: "500",
                  bonus: "1.25",
                },
              ],
            };
          }
          if (
            normalized.includes("select count(*)::text as total") &&
            normalized.includes("where referrer_user_id = $1")
          ) {
            return { rows: [{ total: "6" }] };
          }
          throw new Error(`Unexpected rewards query: ${normalized}`);
        },
      } as RewardsQuery;

      const result = await getRewardsReferrals(query, {
        userId: "user-1",
        sortBy: "points",
        sortDir: "desc",
        limit: 1,
        offset: 0,
      });

      assert.equal(result.total, 6);
      assert.equal(result.limit, 1);
      assert.equal(result.offset, 0);
      assert.equal(result.hasMore, true);
      assert.equal(result.referrals[0]?.status, "qualified");
      assert.equal(result.policy.referralQualification.pointsRequired, 500);
    },
  },
];

for (const test of tests) {
  await test.run();
  console.log(`ok - ${test.name}`);
}
