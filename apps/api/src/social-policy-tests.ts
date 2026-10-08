import assert from "node:assert/strict";
import type { DbQuery } from "./db.js";
import {
  DEFAULT_SOCIAL_POLICY,
  mergeSocialPolicy,
  resolveSocialPolicy,
  buildSocialPolicyRevision,
  SocialPolicyUnavailableError,
} from "./services/social-policy.js";

assert.equal(mergeSocialPolicy({}).minimumNotionalUsd, "10.00");
assert.equal(
  mergeSocialPolicy({ minimumNotionalUsd: "9.99" }).minimumNotionalUsd,
  "9.99",
);
assert.throws(() => mergeSocialPolicy({ minimumNotionalUsd: "0" }));
assert.throws(() => mergeSocialPolicy({ minimumNotionalUsd: 10 }));
assert.throws(() => mergeSocialPolicy({ pageSize: 51 }));
assert.throws(() => mergeSocialPolicy({ handleMinLength: 21 }));
assert.throws(() => mergeSocialPolicy({ repairRetrySeconds: 3601 }));
assert.equal(mergeSocialPolicy({ pageSize: 51, maxPageSize: 60 }).pageSize, 51);
assert.equal(
  buildSocialPolicyRevision(mergeSocialPolicy({})),
  buildSocialPolicyRevision({ ...DEFAULT_SOCIAL_POLICY }),
);
assert.notEqual(
  buildSocialPolicyRevision(mergeSocialPolicy({})),
  buildSocialPolicyRevision(mergeSocialPolicy({ minimumNotionalUsd: "11" })),
);
const emptyDb = { query: async () => ({ rows: [] }) } as unknown as DbQuery;
assert.equal((await resolveSocialPolicy(emptyDb)).source, "default");
const failingDb = {
  query: async () => {
    throw new Error("unavailable");
  },
} as unknown as DbQuery;
await assert.rejects(
  resolveSocialPolicy(failingDb),
  SocialPolicyUnavailableError,
);
const invalidDb = {
  query: async () => ({
    rows: [
      { payload: { minimumNotionalUsd: "oops" }, effective_at: new Date() },
    ],
  }),
} as unknown as DbQuery;
await assert.rejects(
  resolveSocialPolicy(invalidDb),
  SocialPolicyUnavailableError,
);
console.log("Social policy: 13 assertions passed");
