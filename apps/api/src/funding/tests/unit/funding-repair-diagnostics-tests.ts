import assert from "node:assert/strict";
import { FundingPersistenceError } from "../../persistence/funding-operation-repository.js";
import { fundingEvidenceRepairErrorCode } from "../../reconciliation/funding-reducer.js";

const conflict = new FundingPersistenceError(
  "actual_amount_conflict",
  "private provider detail",
);
const physicalBusy = {
  code: "55P03",
  constraint: "funding_physical_event_busy",
};
for (const error of [physicalBusy, new AggregateError([physicalBusy])]) {
  assert.equal(
    fundingEvidenceRepairErrorCode(error),
    "evidence_repair_physical_event_busy",
  );
}
assert.equal(
  fundingEvidenceRepairErrorCode(new AggregateError([physicalBusy, conflict])),
  "evidence_repair_actual_amount_conflict",
  "contention cannot hide a substantive repair failure",
);
assert.equal(
  fundingEvidenceRepairErrorCode(
    new AggregateError([physicalBusy, new Error("private RPC URL")]),
  ),
  "evidence_repair_failed",
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
