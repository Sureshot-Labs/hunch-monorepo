#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FundingEvidenceRepairInspection } from "./funding/persistence/funding-evidence-repair-repository.js";

export const FUNDING_EVIDENCE_REPAIR_USAGE =
  "funding:evidence:repair --operation-id <uuid> --idempotency-key <key> [--dry-run | --execute]";

export type FundingEvidenceRepairArguments = Readonly<{
  operationId: string;
  idempotencyKey: string;
  execute: boolean;
}>;

class FundingEvidenceRepairCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FundingEvidenceRepairCliError";
  }
}

export function parseFundingEvidenceRepairArguments(
  argv: readonly string[],
): FundingEvidenceRepairArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--execute" || arg === "--dry-run") {
      if (flags.has(arg))
        throw new FundingEvidenceRepairCliError("invalid_request");
      flags.add(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const key = separator < 0 ? arg : arg.slice(0, separator);
    if (
      !["--operation-id", "--idempotency-key"].includes(key) ||
      values.has(key)
    )
      throw new FundingEvidenceRepairCliError("invalid_request");
    const value = separator < 0 ? argv[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith("--"))
      throw new FundingEvidenceRepairCliError("invalid_request");
    values.set(key, value);
  }
  if (flags.has("--execute") && flags.has("--dry-run"))
    throw new FundingEvidenceRepairCliError("invalid_request");
  const operationId = values.get("--operation-id") ?? "";
  const idempotencyKey = values.get("--idempotency-key") ?? "";
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      operationId,
    ) ||
    !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)
  )
    throw new FundingEvidenceRepairCliError("invalid_request");
  return { operationId, idempotencyKey, execute: flags.has("--execute") };
}

function safeInspection(value: FundingEvidenceRepairInspection) {
  const probe = value.lastProbe;
  return {
    operationStatus: value.operationStatus,
    recoveryMode: value.recoveryMode,
    expired: value.expired,
    stopped: value.stopped,
    evidenceOnly: value.evidenceOnly,
    compatible: value.compatible,
    state: value.state,
    generation: value.generation,
    processedGeneration: value.processedGeneration,
    reason: value.reason,
    jobStatus: value.jobStatus,
    nextProbeAt: value.nextProbeAt,
    lastProbe: probe
      ? {
          outcome: probe.outcome,
          status: probe.status,
          ...(probe.matchingMask
            ? {
                matchingMask: {
                  chain: probe.matchingMask.chain,
                  from: probe.matchingMask.from,
                  to: probe.matchingMask.to,
                  calldata: probe.matchingMask.calldata,
                  value: probe.matchingMask.value,
                },
              }
            : {}),
        }
      : null,
  };
}

export async function runFundingEvidenceRepairCommand(
  args: FundingEvidenceRepairArguments,
  dependencies: Readonly<{
    inspect: (
      operationId: string,
    ) => Promise<FundingEvidenceRepairInspection | null>;
    request: (
      input: Readonly<{ operationId: string; idempotencyKey: string }>,
    ) => Promise<{
      replayed: boolean;
      generation: number;
      inspection: FundingEvidenceRepairInspection;
    }>;
  }>,
) {
  // Always inspect the exact target first. The repository repeats the stopped
  // check under lock when execution is explicitly requested.
  const before = await dependencies.inspect(args.operationId);
  if (!before) throw new FundingEvidenceRepairCliError("operation_not_found");
  if (!before.compatible)
    throw new FundingEvidenceRepairCliError("incompatible_repair_state");
  if (!before.stopped)
    throw new FundingEvidenceRepairCliError("operation_not_stopped");
  const requested = args.execute
    ? await dependencies.request({
        operationId: args.operationId,
        idempotencyKey: args.idempotencyKey,
      })
    : null;
  return {
    event: "funding_evidence_repair_request",
    operationKey: createHash("sha256")
      .update(args.operationId.toLowerCase())
      .digest("hex")
      .slice(0, 12),
    dryRun: !args.execute,
    observationOnly: true,
    queued: requested !== null && !requested.replayed,
    replayed: requested?.replayed ?? false,
    generation: requested?.generation ?? before.generation,
    inspection: safeInspection(requested?.inspection ?? before),
    transactionsSubmitted: 0,
  };
}

export function fundingEvidenceRepairCliFailure(error: unknown) {
  const candidate =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown })
      : null;
  const known = new Set([
    "invalid_request",
    "operation_not_found",
    "operation_not_stopped",
    "incompatible_repair_state",
    "database_configuration_missing",
  ]);
  const code =
    typeof candidate?.code === "string" && known.has(candidate.code)
      ? candidate.code
      : "evidence_repair_request_failed";
  return { event: "funding_evidence_repair_request_failed", code };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(FUNDING_EVIDENCE_REPAIR_USAGE);
    return;
  }
  const args = parseFundingEvidenceRepairArguments(argv);
  // Compatible with the production secret wrapper, and DB-only bundles. No
  // process-wide API env or execution runtime is imported by this command.
  if (process.env.HUNCH_RUNTIME_SECRETS_LOADED !== "1") {
    const { loadRuntimeSecrets } = await import("@hunch/config/secrets");
    await loadRuntimeSecrets({
      envPath: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../.env",
      ),
      logger: { info() {}, warn() {}, error() {} },
    });
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString)
    throw new FundingEvidenceRepairCliError("database_configuration_missing");
  const { createPgPool } = await import("@hunch/infra");
  const { inspectFundingEvidenceRepair, requestFundingEvidenceRepair } =
    await import("./funding/persistence/funding-evidence-repair-repository.js");
  const pool = createPgPool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    lock_timeout: 2_000,
    application_name: "hunch-funding-evidence-repair",
  });
  try {
    const result = await runFundingEvidenceRepairCommand(args, {
      inspect: async (operationId) => {
        const client = await pool.connect();
        try {
          await client.query("begin read only");
          return await inspectFundingEvidenceRepair(client, operationId);
        } finally {
          try {
            await client.query("rollback");
          } finally {
            client.release();
          }
        }
      },
      request: (input) => requestFundingEvidenceRepair(pool, input),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(JSON.stringify(fundingEvidenceRepairCliFailure(error)));
    process.exitCode = 1;
  });
}
