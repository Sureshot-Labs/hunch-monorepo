#!/usr/bin/env tsx

import { pool } from "./db.js";
import { auditHolderResearchSignalPerformance } from "./services/holder-research-performance.js";
import { resolveHolderResearchPolicy } from "./services/runtime-policies.js";

type AuditArgs = {
  execute: boolean;
  force: boolean;
  json: boolean;
  includeOpen: boolean;
  includeResolved: boolean;
  limit: number | null;
  lookbackHours: number | null;
  noteIds: string[];
};

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function parseNoteIds(argv: string[]): string[] {
  const values = argv.flatMap((arg, index) => {
    if (arg.startsWith("--note-id=")) return [arg.slice("--note-id=".length)];
    if (arg === "--note-id" && argv[index + 1]) return [argv[index + 1]];
    if (arg.startsWith("--note-ids=")) {
      return arg.slice("--note-ids=".length).split(",");
    }
    return [];
  });
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

export function parseHolderResearchAuditArgs(argv: string[]): AuditArgs {
  const lookbackHours =
    parsePositiveInt(parseFlag(argv, "--lookback-hours")) ??
    (parsePositiveInt(parseFlag(argv, "--lookback-days")) != null
      ? (parsePositiveInt(parseFlag(argv, "--lookback-days")) as number) * 24
      : null);
  return {
    execute: hasFlag(argv, "--execute"),
    force: hasFlag(argv, "--force"),
    json: hasFlag(argv, "--json"),
    includeOpen: !hasFlag(argv, "--no-include-open"),
    includeResolved: !hasFlag(argv, "--no-include-resolved"),
    limit: parsePositiveInt(parseFlag(argv, "--limit")),
    lookbackHours,
    noteIds: parseNoteIds(argv),
  };
}

function formatPercent(value: number | null): string {
  if (value == null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatResult(
  result: Awaited<ReturnType<typeof auditHolderResearchSignalPerformance>>,
) {
  const overall = result.aggregates.overall;
  return [
    `[holder-research:audit] considered=${result.considered} evaluated=${result.evaluated} written=${result.written} unchanged=${result.unchanged} errors=${result.errors}`,
    `[holder-research:audit] open=${result.open} resolved=${result.resolved} unknown=${result.unknown} correct=${result.correct} wrong=${result.wrong} missingEntry=${result.missingEntry}`,
    `[holder-research:audit] hitRate=${formatPercent(overall.hitRate)} avgRoi=${formatPercent(overall.averageRoi)} medianRoi=${formatPercent(overall.medianRoi)}`,
  ].join("\n");
}

async function main() {
  const args = parseHolderResearchAuditArgs(process.argv.slice(2));
  const policyResult = await resolveHolderResearchPolicy(pool);
  const policy = policyResult.effective;
  const result = await auditHolderResearchSignalPerformance(pool, {
    lookbackHours: args.lookbackHours ?? policy.performanceAuditLookbackHours,
    limit: args.limit ?? policy.performanceAuditMaxNotesPerRun,
    noteIds: args.noteIds,
    persist: args.execute,
    includeOpen: args.includeOpen,
    includeResolved: args.includeResolved,
    force: args.force,
    approxEntryBeforeHours: policy.performanceAuditApproxEntryBeforeHours,
    approxEntryAfterHours: policy.performanceAuditApproxEntryAfterHours,
  });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: !args.execute,
          result,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatResult(result));
    if (!args.execute) {
      console.log(
        "[holder-research:audit] dry-run; pass --execute to persist metrics.signalPerformance",
      );
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error("[holder-research:audit] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
