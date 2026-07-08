import assert from "node:assert/strict";

import { buildMarketSideCopy } from "./services/market-side-copy.js";

const tests: Array<{ name: string; run: () => void }> = [
  {
    name: "labels match-total over under markets in plain English",
    run: () => {
      const under = buildMarketSideCopy({
        eventTitle: "Portugal vs Spain",
        marketDescription:
          "Over if Portugal and Spain combine for 3 or more goals.",
        marketTitle: "O/U 2.5",
        outcomes: ["Over", "Under"],
        side: "NO",
      });
      const over = buildMarketSideCopy({
        eventTitle: "Portugal vs Spain",
        marketDescription:
          "Over if Portugal and Spain combine for 3 or more goals.",
        marketTitle: "O/U 2.5",
        outcomes: ["Over", "Under"],
        side: "YES",
      });

      assert.equal(under.sideLabel, "Under 2.5 total goals");
      assert.equal(under.winCondition, "0-2 total goals");
      assert.equal(
        under.marketLine,
        "Portugal vs Spain · Under 2.5 total goals",
      );
      assert.equal(over.sideLabel, "Over 2.5 total goals");
      assert.equal(over.winCondition, "3+ total goals");
    },
  },
  {
    name: "labels first-half totals with the period in the side",
    run: () => {
      const copy = buildMarketSideCopy({
        eventTitle: "Portugal vs Spain",
        marketTitle: "1st Half O/U 1.5",
        outcomes: ["Over", "Under"],
        side: "YES",
      });

      assert.equal(copy.sideLabel, "Over 1.5 first-half goals");
      assert.equal(copy.winCondition, "2+ first-half goals");
    },
  },
  {
    name: "keeps named outcomes as the visible side",
    run: () => {
      const copy = buildMarketSideCopy({
        eventTitle: "World Cup Winner",
        marketTitle: "World Cup Winner",
        outcomes: ["Argentina", "Field"],
        side: "YES",
      });

      assert.equal(copy.sideLabel, "Argentina");
      assert.equal(copy.copyKind, "named_outcome");
    },
  },
  {
    name: "keeps generic team no labels as NO while preserving prose position",
    run: () => {
      const copy = buildMarketSideCopy({
        eventTitle: "World Cup Winner",
        marketTitle: "France",
        outcomes: null,
        side: "NO",
      });

      assert.equal(copy.buttonLabel, "NO");
      assert.equal(copy.sideLabel, "NO");
      assert.equal(copy.plainPosition, "fading France");
      assert.equal(copy.priceLabel, "NO");
      assert.equal(copy.marketLine, "World Cup Winner · France");
      assert.equal(copy.copyKind, "team_yes_no");
    },
  },
  {
    name: "keeps generic team yes labels as YES while preserving prose position",
    run: () => {
      const copy = buildMarketSideCopy({
        eventTitle: "World Cup Winner",
        marketTitle: "Will Belgium win?",
        outcomes: null,
        side: "YES",
      });

      assert.equal(copy.buttonLabel, "YES");
      assert.equal(copy.sideLabel, "YES");
      assert.equal(copy.plainPosition, "backing Belgium");
      assert.equal(copy.priceLabel, "YES");
      assert.equal(copy.marketLine, "Will Belgium win?");
      assert.equal(copy.copyKind, "team_yes_no");
    },
  },
  {
    name: "keeps generic fallback safe when no readable title exists",
    run: () => {
      const copy = buildMarketSideCopy({
        marketTitle: "Will test resolve Yes?",
        outcomes: null,
        side: "NO",
      });

      assert.equal(copy.sideLabel, "NO");
      assert.equal(copy.copyKind, "generic");
    },
  },
  {
    name: "abbreviates long named outcomes for buttons",
    run: () => {
      const copy = buildMarketSideCopy({
        marketTitle: "NFL Division Winner",
        outcomes: ["New York Giants", "Field"],
        side: "YES",
      });

      assert.equal(copy.buttonLabel, "NYG");
      assert.equal(copy.priceLabel, "NYG");
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed += 1;
  } catch (error) {
    console.error(`[market-side-copy-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[market-side-copy-tests] passed ${passed}/${tests.length}`);
