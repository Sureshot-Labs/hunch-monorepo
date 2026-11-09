import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseFundingEvidenceRepairArguments,
  runFundingEvidenceRepairCommand,
  fundingEvidenceRepairCliFailure,
} from "./funding-evidence-repair.js";
import type { FundingEvidenceRepairInspection } from "./funding/persistence/funding-evidence-repair-repository.js";

const operationId = "11111111-2222-4333-8444-555555555555";
const idempotencyKey = "synthetic-idempotency-key";
const base = [
  "--operation-id",
  operationId,
  "--idempotency-key",
  idempotencyKey,
];
const inspection: FundingEvidenceRepairInspection = {
  operationStatus: "recovery_required",
  recoveryMode: "manual_review",
  expired: true,
  stopped: true,
  evidenceOnly: true,
  compatible: true,
  state: "waiting_evidence",
  generation: 2,
  processedGeneration: 2,
  reason: "unchanged_evidence",
  jobStatus: "dead_letter",
  nextProbeAt: null,
  lastProbe: {
    outcome: "intrinsic_mismatch",
    status: "mismatch",
    matchingMask: {
      chain: true,
      from: false,
      to: false,
      calldata: false,
      value: true,
    },
  },
};
assert.deepEqual(parseFundingEvidenceRepairArguments(base), {
  operationId,
  idempotencyKey,
  execute: false,
});
assert.equal(
  parseFundingEvidenceRepairArguments([...base, "--dry-run"]).execute,
  false,
);
assert.equal(
  parseFundingEvidenceRepairArguments([
    `--operation-id=${operationId}`,
    `--idempotency-key=${idempotencyKey}`,
    "--execute",
  ]).execute,
  true,
);
for (const args of [
  [],
  ["--execute"],
  base.slice(0, 2),
  ["--operation-id", "not-a-uuid", "--idempotency-key", idempotencyKey],
  [...base, "--unknown"],
  [...base, "--operation-id", operationId],
  [...base, "--execute", "--dry-run"],
  [...base, "--execute", "--execute"],
  ["--operation-id", operationId, "--idempotency-key", " "],
  ["--operation-id", operationId, "--idempotency-key", "x".repeat(201)],
])
  assert.throws(
    () => parseFundingEvidenceRepairArguments(args),
    /invalid_request/,
  );

let reads = 0,
  requests = 0;
const dependencies = {
  inspect: async (selectedId: string) => {
    reads++;
    assert.equal(selectedId, operationId);
    return { ...inspection, privateReference: "synthetic-private-reference" };
  },
  request: async (input: { operationId: string; idempotencyKey: string }) => {
    requests++;
    assert.equal(
      reads,
      2,
      "execute must first perform its own exact-target preflight",
    );
    assert.deepEqual(input, { operationId, idempotencyKey });
    return {
      replayed: false,
      generation: 3,
      inspection: { ...inspection, generation: 3 },
    };
  },
};
const dry = await runFundingEvidenceRepairCommand(
  parseFundingEvidenceRepairArguments(base),
  dependencies,
);
assert.equal(reads, 1);
assert.equal(requests, 0);
assert.equal(dry.dryRun, true);
assert.equal(dry.queued, false);
assert.equal(dry.observationOnly, true);
assert.equal(dry.transactionsSubmitted, 0);
assert.ok(!JSON.stringify(dry).includes(idempotencyKey));
assert.ok(!JSON.stringify(dry).includes(operationId));
assert.ok(!JSON.stringify(dry).includes("synthetic-private-reference"));
const queued = await runFundingEvidenceRepairCommand(
  parseFundingEvidenceRepairArguments([...base, "--execute"]),
  dependencies,
);
assert.equal(requests, 1);
assert.equal(queued.queued, true);
assert.equal(queued.generation, 3);
const replayed = await runFundingEvidenceRepairCommand(
  parseFundingEvidenceRepairArguments([...base, "--execute"]),
  {
    inspect: async () => inspection,
    request: async () => ({ replayed: true, generation: 3, inspection }),
  },
);
assert.equal(replayed.replayed, true);
assert.equal(replayed.queued, false);
for (const value of [
  null,
  { ...inspection, stopped: false, expired: false, evidenceOnly: false },
]) {
  await assert.rejects(
    runFundingEvidenceRepairCommand(
      parseFundingEvidenceRepairArguments([...base, "--execute"]),
      {
        inspect: async () => value,
        request: async () => {
          throw Error("request must never run after failed preflight");
        },
      },
    ),
    value ? /operation_not_stopped/ : /operation_not_found/,
  );
}
await assert.rejects(
  runFundingEvidenceRepairCommand(
    parseFundingEvidenceRepairArguments([...base, "--execute"]),
    {
      inspect: async () => ({ ...inspection, compatible: false }),
      request: async () => {
        throw Error("unsupported repair generation must remain untouched");
      },
    },
  ),
  /incompatible_repair_state/,
);
assert.equal(
  fundingEvidenceRepairCliFailure({ code: "incompatible_repair_state" }).code,
  "incompatible_repair_state",
);
assert.deepEqual(
  fundingEvidenceRepairCliFailure(
    new Error("secret value must not be printed"),
  ),
  {
    event: "funding_evidence_repair_request_failed",
    code: "evidence_repair_request_failed",
  },
);
assert.equal(
  fundingEvidenceRepairCliFailure({ code: "operation_not_stopped" }).code,
  "operation_not_stopped",
);
assert.equal(
  fundingEvidenceRepairCliFailure({ code: "postgresql://secret" }).code,
  "evidence_repair_request_failed",
);

const require = createRequire(import.meta.url);
const entrypoint = fileURLToPath(
  new URL("./funding-evidence-repair.ts", import.meta.url),
);
const childPrefix = process.versions.bun
  ? []
  : ["--import", require.resolve("tsx")];
const childEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  DATABASE_URL: "",
  NODE_ENV: "intentionally-invalid-no-api-env",
};
const help = spawnSync(
  process.execPath,
  [...childPrefix, entrypoint, "--help"],
  {
    env: childEnv,
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
  },
);
assert.ifError(help.error);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--operation-id/);
const missingDb = spawnSync(
  process.execPath,
  [...childPrefix, entrypoint, ...base],
  {
    env: childEnv,
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
  },
);
assert.ifError(missingDb.error);
assert.equal(missingDb.status, 1);
assert.equal(
  JSON.parse(missingDb.stderr.trim()).code,
  "database_configuration_missing",
);
console.log(
  "funding evidence repair CLI: dry-run, exact target, idempotency, no execution imports and safe errors passed",
);
