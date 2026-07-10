import assert from "node:assert/strict";

import { hasCliFlag, readCliValues, readPositiveInt } from "./lib/cli-args.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("CLI values support equals, separate, repeated, and comma forms", () => {
  assert.deepEqual(
    readCliValues(
      ["--venue=polymarket, limitless", "--venue", "kalshi", "--other"],
      "venue",
    ),
    ["polymarket", "limitless", "kalshi"],
  );
});

test("CLI values can preserve comma-delimited input", () => {
  assert.deepEqual(
    readCliValues(["--value=a,b"], "value", { splitCommas: false }),
    ["a,b"],
  );
  assert.deepEqual(
    readCliValues(["--value", "   "], "value", { splitCommas: false }),
    [],
  );
});

test("CLI flags require an exact flag token", () => {
  assert.equal(hasCliFlag(["--execute"], "execute"), true);
  assert.equal(hasCliFlag(["--execute=true"], "execute"), false);
});

test("CLI positive integers preserve strict and fallback policies", () => {
  assert.equal(readPositiveInt(["--limit", "12.9"], "limit", 5), 12);
  assert.throws(
    () => readPositiveInt(["--limit=bad"], "limit", 5),
    /--limit must be a positive integer/,
  );
  assert.equal(
    readPositiveInt(["--limit=bad"], "limit", 5, {
      invalid: "fallback",
    }),
    5,
  );
  assert.equal(readPositiveInt([], "limit", 5), 5);
});
