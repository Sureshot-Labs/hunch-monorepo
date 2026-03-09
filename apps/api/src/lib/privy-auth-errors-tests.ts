import assert from "node:assert/strict";

import { getPrivyTerminalAuthMessage } from "./privy-auth-errors.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [
  {
    name: "wallet_conflict maps to a non-empty terminal auth message",
    run: () => {
      assert.equal(
        getPrivyTerminalAuthMessage("wallet_conflict"),
        "One of this Privy account's wallets is already linked to another Hunch account. Please contact support to recover or merge the account.",
      );
    },
  },
  {
    name: "unknown terminal auth codes fall back to the default message",
    run: () => {
      assert.equal(
        getPrivyTerminalAuthMessage("unexpected_terminal_error"),
        "Privy authentication could not be completed. Please contact support.",
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[privy-auth-errors-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[privy-auth-errors-tests] passed ${passed}/${tests.length}`);
