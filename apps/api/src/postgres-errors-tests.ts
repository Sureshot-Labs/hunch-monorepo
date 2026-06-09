#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  isPgStatementTimeoutError,
  isSearchStatementTimeout,
} from "./lib/postgres-errors.js";

assert.equal(isPgStatementTimeoutError({ code: "57014" }), true);
assert.equal(isPgStatementTimeoutError({ code: "23505" }), false);
assert.equal(isPgStatementTimeoutError(new Error("timeout")), false);

assert.equal(isSearchStatementTimeout({ code: "57014" }, "bitcoin"), true);
assert.equal(isSearchStatementTimeout({ code: "57014" }, "  "), false);
assert.equal(isSearchStatementTimeout({ code: "23505" }, "bitcoin"), false);

console.log("[postgres-errors-tests] ok");
