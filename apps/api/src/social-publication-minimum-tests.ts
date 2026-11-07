import assert from "node:assert/strict";
import { test } from "node:test";
import { meetsPublicationMinimum } from "./services/social-publication-minimum.js";

for (const [actual, minimum, expected] of [
  ["10", "10", true],
  ["10.000000", "10.00", true],
  ["9.999999", "10", true],
  ["9.9999990001", "10.00", true],
  ["9.9999989999", "10", false],
  ["9.999998", "10", false],
  ["9.99", "10", false],
  ["1", "10", false],
  ["16.999999", "17", true],
  ["16.999998", "17", false],
  ["0", "10", false],
  ["-1", "10", false],
  ["10", "0", false],
] as const) {
  await test(`${actual} / minimum ${minimum} => ${expected}`, () => {
    assert.equal(meetsPublicationMinimum(actual, minimum), expected);
  });
}
await test("Invalid monetary input is not treated as eligible", () => {
  assert.throws(() => meetsPublicationMinimum("oops", "10"));
  assert.throws(() => meetsPublicationMinimum("10", "oops"));
});
