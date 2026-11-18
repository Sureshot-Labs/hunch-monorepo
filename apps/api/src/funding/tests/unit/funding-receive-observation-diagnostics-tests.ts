import assert from "node:assert/strict";
import { addReceiveObservationFailure } from "../../receive/receive-observation-diagnostics.js";

const counters: Record<string, number> = {};
const wrapped = new Error("secret URL and address", {
  cause: Object.assign(new Error("provider response"), { status: 429 }),
});
addReceiveObservationFailure(counters, "solana_scan", wrapped, 2);
addReceiveObservationFailure(counters, "solana_scan", { statusCode: 429 });
addReceiveObservationFailure(counters, "evm_scan", { code: "ETIMEDOUT" });
addReceiveObservationFailure(counters, "session", { code: "57014" });
addReceiveObservationFailure(counters, "session", {
  code: "secret custom code",
});
addReceiveObservationFailure(counters, "batch_scan", { status: 503 }, 0);
addReceiveObservationFailure(counters, "session", {
  get status() {
    throw new Error("provider diagnostic getter");
  },
});
assert.deepEqual(counters, {
  "solana_scan.rate_limit": 3,
  "evm_scan.timeout": 1,
  "session.sql_cancelled": 1,
  "session.unknown": 2,
});
console.log(
  "ok - fixed receive stage and error labels, no payloads or identifiers",
);
