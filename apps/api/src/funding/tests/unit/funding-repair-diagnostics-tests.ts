import assert from "node:assert/strict";
import { FundingPersistenceError } from "../../persistence/funding-operation-repository.js";
import { fundingEvidenceRepairErrorCode } from "../../reconciliation/funding-reducer.js";

const conflict = new FundingPersistenceError(
  "actual_amount_conflict",
  "private provider detail",
);
assert.equal(
  fundingEvidenceRepairErrorCode(conflict),
  "evidence_repair_actual_amount_conflict",
);
assert.equal(
  fundingEvidenceRepairErrorCode(
    new AggregateError([new Error("private URL"), conflict]),
  ),
  "evidence_repair_actual_amount_conflict",
);
assert.equal(
  fundingEvidenceRepairErrorCode(new Error("https://secret.example/token")),
  "evidence_repair_failed",
);
assert.equal(
  fundingEvidenceRepairErrorCode({ code: "private", message: "private" }),
  "evidence_repair_failed",
);
