import assert from "node:assert/strict";
import { isExpiredSolanaPreparation } from "../../execution/solana-preparation.js";
import { fundingOperationActionPrepareRequestSchema } from "../../../schemas/funding.js";

const now = new Date("2026-09-22T14:00:00Z");
assert.equal(
  isExpiredSolanaPreparation({ version: 1, expiresAt: now.toISOString() }, now),
  true,
);
assert.equal(
  isExpiredSolanaPreparation(
    { version: 1, expiresAt: "2026-09-22T14:00:01Z" },
    now,
  ),
  false,
);
for (const value of [
  null,
  {},
  { version: 2, expiresAt: now.toISOString() },
  { version: 1, expiresAt: "invalid" },
  { version: 1, expiresAt: 0 },
]) {
  assert.equal(isExpiredSolanaPreparation(value, now), false);
}
assert.deepEqual(
  fundingOperationActionPrepareRequestSchema.parse({
    submissionProtocols: { solana: 1 },
  }),
  { submissionProtocols: { solana: 1 } },
);
assert.equal(
  fundingOperationActionPrepareRequestSchema.safeParse({
    submissionProtocols: { solana: 2 },
  }).success,
  false,
);
console.log("solana preparation tests passed");
