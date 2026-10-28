import assert from "node:assert/strict";
import {
  DEFAULT_JEV_MODEL,
  jevRequestModel,
  jevResponseModelMatches,
} from "./lib/jev-model-identity.js";
import { parseHolderBackgroundJevProbabilities } from "./services/holder-research-background.js";
import { HOLDER_RESEARCH_JEV_MODEL } from "./services/holder-research-jev.js";
import { MAP_SEARCH_FOCUS_MODEL } from "./services/map-search-focus.js";
import { SEMANTIC_REVIEW_MODEL } from "./services/market-map-semantic-review.js";

assert.equal(DEFAULT_JEV_MODEL, "typesafe/jev-1.14-20261014");
assert.equal(jevRequestModel(DEFAULT_JEV_MODEL), "typesafe/jev-1.14");
for (const model of [
  HOLDER_RESEARCH_JEV_MODEL,
  MAP_SEARCH_FOCUS_MODEL,
  SEMANTIC_REVIEW_MODEL,
]) {
  assert.equal(model, DEFAULT_JEV_MODEL);
  assert.equal(
    jevResponseModelMatches(model, "typesafe/jev-1.13-20260917"),
    false,
  );
  assert.equal(jevResponseModelMatches(model, DEFAULT_JEV_MODEL), true);
}
// Legacy explicitly pinned agent policy is still understood, never silently upgraded.
assert.equal(
  jevRequestModel("typesafe/jev-1.13-20260917"),
  "typesafe/jev-1.13",
);
assert.equal(
  jevResponseModelMatches("typesafe/jev-1.13", DEFAULT_JEV_MODEL),
  false,
);
const answers = {
  d0: { type: "choice", choice: "yes", probabilities: { yes: 0.9, no: 0.1 } },
};
assert.deepEqual(
  parseHolderBackgroundJevProbabilities(
    { model: DEFAULT_JEV_MODEL, answers },
    1,
  ),
  { d0: 0.9 },
);
assert.equal(
  parseHolderBackgroundJevProbabilities(
    { model: "typesafe/jev-1.13-20260917", answers },
    1,
  ),
  null,
);
console.log("[jev-model-identity-tests] passed");
