#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "../../planner/source-adapter.js";
import { listAdaptedFundingSources } from "../../planner/source-adapter.js";
import type { PlannedSourceOption } from "../../planner/planning-types.js";

const first = {
  option: { sourceOptionId: "source_adapter_first_12345678" },
} as PlannedSourceOption;
const second = {
  option: { sourceOptionId: "source_adapter_second_12345678" },
} as PlannedSourceOption;
const input = {} as FundingSourcePlanningInput;
const adapters: FundingSourceAdapter[] = [
  {
    adapterId: "fake_venue_a_v1",
    list: async () => [first],
  },
  {
    adapterId: "fake_venue_b_v1",
    list: async () => [second],
  },
];

const result = await listAdaptedFundingSources(adapters, input);
assert.deepEqual(
  result.map((source) => source.option.sourceOptionId),
  ["source_adapter_first_12345678", "source_adapter_second_12345678"],
);

console.log(
  "[funding-source-adapter-tests] independent venue adapters compose without core branching",
);
