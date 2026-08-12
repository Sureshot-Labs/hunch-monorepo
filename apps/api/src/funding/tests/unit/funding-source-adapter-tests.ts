#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "../../planner/source-adapter.js";
import {
  listAdaptedFundingSources,
  verifyAdaptedFundingSourceCommit,
} from "../../planner/source-adapter.js";
import type { FundingCommitPlan } from "../../persistence/funding-operation-repository.js";
import type { PlannedSourceOption } from "../../planner/planning-types.js";

const first = {
  option: { sourceOptionId: "source_adapter_first_12345678" },
} as PlannedSourceOption;
const second = {
  option: { sourceOptionId: "source_adapter_second_12345678" },
} as PlannedSourceOption;
const input = {} as FundingSourcePlanningInput;
const verifiedCommits: string[] = [];
const adapters: FundingSourceAdapter[] = [
  {
    adapterId: "fake_venue_a_v1",
    list: async () => [first],
    verifyCommit: async (_client, commit) => {
      verifiedCommits.push("a");
      assert.equal(commit.userId, "user_adapter_commit_12345678");
    },
  },
  {
    adapterId: "fake_venue_b_v1",
    list: async () => [second],
    verifyCommit: async () => {
      verifiedCommits.push("b");
    },
  },
];

const result = await listAdaptedFundingSources(adapters, input);
assert.deepEqual(
  result.map((source) => source.option.sourceOptionId),
  ["source_adapter_first_12345678", "source_adapter_second_12345678"],
);
const operation = {
  supportMetadata: { adapterId: "fake_venue_a_v1" },
} as unknown as FundingCommitPlan["operation"];
await verifyAdaptedFundingSourceCommit(adapters, {} as never, {
  userId: "user_adapter_commit_12345678",
  operation,
});
assert.deepEqual(verifiedCommits, ["a", "b"]);
await verifyAdaptedFundingSourceCommit(adapters, {} as never, {
  userId: "user_adapter_commit_12345678",
  operation: {
    ...operation,
    supportMetadata: { adapterId: "unknown_adapter_v1" },
  },
});
assert.deepEqual(
  verifiedCommits,
  ["a", "b", "a", "b"],
  "effect guards run independently of the adapter that discovered the source",
);

console.log(
  "[funding-source-adapter-tests] independent venue adapters compose without core branching",
);
