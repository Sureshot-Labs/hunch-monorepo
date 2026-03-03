import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { z } from "zod";
import { pool } from "./db.js";
import { env } from "./env.js";
import { runMapSignals } from "./ai-map-signals-run.js";
import { marketMapActiveKey } from "./services/market-map.js";
import { resolveMapSignalsPolicy } from "./services/runtime-policies.js";

const KEY_PREFIX = "ai:map_signals:v1";
const LOCK_KEY = `${KEY_PREFIX}:lock`;
const RUNS_KEY = `${KEY_PREFIX}:runs`;
const STATUS_KEY = `${KEY_PREFIX}:status:last`;
const LATEST_KEY = `${KEY_PREFIX}:latest`;
const LAST_INPUT_DIGEST_KEY = `${KEY_PREFIX}:last_input_digest`;
const RUN_HISTORY_TTL_MS = 60 * 60 * 24 * 14 * 1_000;

const SEARCH_KEY_PREFIX = "ai:map_search:v1";
function searchArtifactKey(mapRunId: string): string {
  return `${SEARCH_KEY_PREFIX}:run:${mapRunId}:artifact`;
}
function latestSearchForMapRunKey(mapRunId: string): string {
  return `${SEARCH_KEY_PREFIX}:map_run:${mapRunId}:latest_search`;
}

function signalsArtifactKey(mapRunId: string): string {
  return `${KEY_PREFIX}:run:${mapRunId}:artifact`;
}
function signalsRunStatusKey(mapRunId: string): string {
  return `${KEY_PREFIX}:run:${mapRunId}:status`;
}
function signalsLatestForMapRunKey(mapRunId: string): string {
  return `${KEY_PREFIX}:map_run:${mapRunId}:latest_signals`;
}
function runInputDigestKey(mapRunId: string): string {
  return `${KEY_PREFIX}:run:${mapRunId}:input_digest`;
}

type RunnerOptions = {
  force: boolean;
  ignorePolicyRate: boolean;
  ignorePolicyBudget: boolean;
  ignoreInputDigest: boolean;
  dryRun: boolean;
  verbose: boolean;
  passthroughArgs: string[];
};

type SignalsRunnerResult = "ok" | "error" | "dry_run";

type RunEntry = {
  runnerRunId: string;
  mapRunId: string;
  searchRunId: string | null;
  inputDigest: string;
  ts: number;
  costUsd: number;
  estimatedCostUsd?: number;
  chargedCostUsd?: number;
  providerReportedCostUsd?: number;
  providerReportedCostCalls?: number;
  costSource?: "estimated" | "provider_reported" | "mixed";
  generatedSignals?: number;
  publishCandidates?: number;
  notesPersisted?: number;
  notesSkippedExisting?: number;
  notesSuperseded?: number;
  result: SignalsRunnerResult;
};

const signalsReportSignalSchema = z
  .object({
    signalId: z.string().min(1),
    nodeId: z.string().min(1),
    nodeLabel: z.string().min(1),
    level: z.coerce.number().int().nonnegative(),
    decision: z.enum(["publish_candidate", "context_only", "skip"]),
    signalType: z.enum(["catalyst", "risk", "update"]),
    direction: z.enum(["up", "down", "mixed"]),
    confidence: z.coerce.number().finite(),
    headline: z.string().min(1),
    summary: z.string().min(1),
    rationale: z.string().min(1),
    targetMarketId: z.string().min(1).nullable(),
    targetEventId: z.string().min(1).nullable(),
    targetMarketTitle: z.string().min(1).nullable(),
    targetEventTitle: z.string().min(1).nullable(),
    targetVenue: z.string().min(1).nullable(),
    reasonCodes: z.array(z.string().min(1)).default([]),
    metrics: z.object({
      evidenceCount: z.coerce.number().finite(),
      confirmedCount: z.coerce.number().finite(),
      distinctDomains: z.coerce.number().finite(),
      candidateMarkets: z.coerce.number().finite(),
      selectedMarketAffinity: z.coerce.number().finite().nullable(),
      bestMarketAffinity: z.coerce.number().finite().nullable(),
    }),
    evidenceRefs: z
      .array(
        z.object({
          evidenceId: z.string().min(1),
          headline: z.string().min(1),
          sourceUrl: z.string().min(1),
          sourceDomain: z.string().min(1),
          publishedAt: z.string().min(1).nullable(),
          confirmation: z.enum(["confirmed", "developing", "unconfirmed"]),
          sourceTier: z.enum([
            "official",
            "wire",
            "major_media",
            "specialist",
            "social",
          ]),
        }),
      )
      .default([]),
    modelStatus: z.enum(["PUBLISH", "CONTEXT", "SKIP", "NONE"]),
    downgradedFromPublish: z.coerce.boolean(),
    chargedCostUsd: z.coerce.number().finite(),
    estimatedCostUsd: z.coerce.number().finite(),
    providerCostUsd: z.coerce.number().finite().nullable(),
    costSource: z.enum(["estimated", "provider_reported", "mixed"]),
  })
  .passthrough();

const signalsReportSchema = z
  .object({
    source: z
      .object({
        runId: z.string().min(1).optional(),
        mapGeneratedAt: z.string().min(1).optional(),
        providerReportedSearchCostUsd: z.coerce.number().finite().optional(),
        providerReportedSearchCostCalls: z.coerce.number().finite().optional(),
        chargedSearchCostUsd: z.coerce.number().finite().optional(),
      })
      .partial()
      .optional(),
    totals: z
      .object({
        durationMs: z.coerce.number().finite().optional(),
        generatedSignals: z.coerce.number().finite().optional(),
        publishCandidates: z.coerce.number().finite().optional(),
        contextOnly: z.coerce.number().finite().optional(),
        skipped: z.coerce.number().finite().optional(),
        estimatedCostUsd: z.coerce.number().finite().optional(),
        chargedCostUsd: z.coerce.number().finite().optional(),
        providerReportedCostUsd: z.coerce.number().finite().optional(),
        providerReportedCostCalls: z.coerce.number().finite().optional(),
      })
      .partial()
      .optional(),
    signals: z.array(signalsReportSignalSchema).optional(),
  })
  .passthrough();

type SignalsReportSignal = z.infer<typeof signalsReportSignalSchema>;
type SignalsReportLike = z.infer<typeof signalsReportSchema>;

type PersistStats = {
  considered: number;
  persisted: number;
  skippedExisting: number;
  superseded: number;
  errors: number;
};

type LatestSearchMeta = {
  runnerRunId?: string;
  mapRunId?: string;
  completedAt?: string;
};

function hasFlag(args: string[], flag: string): boolean {
  return args.some(arg => arg === flag);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inlineValue = args.find(arg => arg.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasOption(args: string[], flag: string): boolean {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`));
}

function addArgIfMissing(args: string[], flag: string, value: string): void {
  if (hasOption(args, flag)) return;
  args.push(`${flag}=${value}`);
}

function hasTruthyOverride(args: string[], flag: string): boolean {
  if (hasFlag(args, flag)) return true;
  const raw = parseFlag(args, flag);
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseRunnerArgs(argv: string[]): RunnerOptions {
  const passthroughArgs: string[] = [];
  let force = false;
  let ignorePolicyRate = false;
  let ignorePolicyBudget = false;
  let ignoreInputDigest = false;
  let dryRun = false;
  let verbose = false;

  for (const arg of argv) {
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--ignore-policy-rate") {
      ignorePolicyRate = true;
      continue;
    }
    if (arg === "--ignore-policy-budget") {
      ignorePolicyBudget = true;
      continue;
    }
    if (arg === "--ignore-input-digest") {
      ignoreInputDigest = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      passthroughArgs.push(arg);
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    passthroughArgs.push(arg);
  }

  if (force) {
    ignorePolicyRate = true;
    ignorePolicyBudget = true;
    ignoreInputDigest = true;
  }

  return {
    force,
    ignorePolicyRate,
    ignorePolicyBudget,
    ignoreInputDigest,
    dryRun,
    verbose,
    passthroughArgs,
  };
}

function parseRunEntries(rawMembers: string[]): RunEntry[] {
  const entries: RunEntry[] = [];
  for (const raw of rawMembers) {
    try {
      const parsed = JSON.parse(raw) as Partial<RunEntry>;
      if (
        typeof parsed.runnerRunId !== "string" ||
        typeof parsed.mapRunId !== "string" ||
        typeof parsed.ts !== "number" ||
        typeof parsed.costUsd !== "number" ||
        (parsed.result !== "ok" &&
          parsed.result !== "error" &&
          parsed.result !== "dry_run")
      ) {
        continue;
      }
      entries.push({
        ...parsed,
        runnerRunId: parsed.runnerRunId,
        mapRunId: parsed.mapRunId,
        searchRunId:
          typeof parsed.searchRunId === "string" ? parsed.searchRunId : null,
        inputDigest: typeof parsed.inputDigest === "string" ? parsed.inputDigest : "",
        ts: parsed.ts,
        costUsd: parsed.costUsd,
        result: parsed.result,
      });
    } catch {
      // ignore malformed entries
    }
  }
  return entries;
}

function sumCost(entries: RunEntry[]): number {
  return entries.reduce(
    (acc, item) =>
      acc +
      (typeof item.chargedCostUsd === "number" ? item.chargedCostUsd : item.costUsd),
    0,
  );
}

function previewError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function extractSignalsReport(raw: string): SignalsReportLike {
  const parsed = JSON.parse(raw) as unknown;
  const result = signalsReportSchema.safeParse(parsed);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.join(".") || "root"}:${issue.message}`)
    .join("; ");
  throw new Error(`invalid_signals_report:${issues}`);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeText(value: string | null | undefined, maxLen: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen);
}

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function buildModelEvidenceRefs(
  refs: SignalsReportSignal["evidenceRefs"],
): Array<{
  evidence_id: string;
  headline: string | null;
  source_url: string | null;
  source_domain: string | null;
  published_at: string | null;
  confirmation: "confirmed" | "developing" | "unconfirmed" | null;
}> {
  return ensureArray<SignalsReportSignal["evidenceRefs"][number]>(refs)
    .slice(0, 6)
    .map((ref) => ({
      evidence_id: normalizeText(ref.evidenceId, 160),
      headline: normalizeText(ref.headline, 240) || null,
      source_url: normalizeText(ref.sourceUrl, 1024) || null,
      source_domain: normalizeText(ref.sourceDomain, 120) || null,
      published_at: normalizeText(ref.publishedAt ?? "", 64) || null,
      confirmation:
        ref.confirmation === "confirmed" ||
        ref.confirmation === "developing" ||
        ref.confirmation === "unconfirmed"
          ? ref.confirmation
          : null,
    }))
    .filter((ref) => ref.evidence_id.length > 0);
}

function buildInputDigest(
  mapRunId: string,
  searchRunId: string | null,
  searchArtifactRaw: string,
): string {
  return createHash("sha1")
    .update(`map=${mapRunId}|search=${searchRunId ?? ""}|artifact=${searchArtifactRaw}`)
    .digest("hex");
}

function buildNoteKey(
  inputDigest: string,
  signal: SignalsReportSignal,
  primaryTargetKind: string,
  primaryTargetId: string,
): string {
  const raw = [
    "map_signals:v1",
    inputDigest,
    signal.signalId,
    signal.signalType,
    signal.direction,
    primaryTargetKind,
    primaryTargetId,
  ].join(":");
  return createHash("sha1").update(raw).digest("hex");
}

async function persistSignalNotes(params: {
  report: SignalsReportLike;
  runnerRunId: string;
  mapRunId: string;
  searchRunId: string | null;
  inputDigest: string;
  maxPublishPerRun: number;
}): Promise<PersistStats> {
  const { report, runnerRunId, mapRunId, searchRunId, inputDigest, maxPublishPerRun } = params;
  const signals = ensureArray<SignalsReportSignal>(report.signals)
    .filter(signal => signal.decision === "publish_candidate")
    .slice(0, maxPublishPerRun);

  const stats: PersistStats = {
    considered: signals.length,
    persisted: 0,
    skippedExisting: 0,
    superseded: 0,
    errors: 0,
  };

  if (signals.length === 0) return stats;

  const client = await pool.connect();
  try {
    for (const signal of signals) {
      const primaryTargetKind = signal.targetMarketId
        ? "market"
        : signal.targetEventId
          ? "event"
          : "node";
      const primaryTargetId =
        signal.targetMarketId ?? signal.targetEventId ?? signal.nodeId;
      const noteKey = buildNoteKey(
        inputDigest,
        signal,
        primaryTargetKind,
        primaryTargetId,
      );

      try {
        await client.query("begin");

        const noteInsert = await client.query<{ id: string }>(
          `
            insert into ai_notes (
              note_key,
              note_type,
              status,
              title,
              description,
              rationale,
              source_kind,
              source_id,
              producer_type,
              producer_run_id,
              lineage,
              signal_type,
              direction,
              confidence,
              reason_codes,
              metrics,
              model_meta
            ) values (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb
            )
            on conflict (note_key) do nothing
            returning id
          `,
          [
            noteKey,
            "signal",
            "active",
            normalizeText(signal.headline, 320) || "Signal",
            normalizeText(signal.summary, 320) || "No summary.",
            normalizeText(signal.rationale, 1_000) || null,
            "node",
            signal.nodeId,
            "map_signals",
            runnerRunId,
            JSON.stringify({
              map_run_id: mapRunId,
              search_run_id: searchRunId,
              source_node_id: signal.nodeId,
              signal_id: signal.signalId,
              input_digest: inputDigest,
            }),
            signal.signalType,
            signal.direction,
            Math.max(0, Math.min(1, Number(signal.confidence) || 0)),
            JSON.stringify(signal.reasonCodes ?? []),
            JSON.stringify(signal.metrics ?? {}),
            JSON.stringify({
              model_status: signal.modelStatus,
              downgraded_from_publish: Boolean(signal.downgradedFromPublish),
              cost_source: signal.costSource,
              charged_cost_usd: signal.chargedCostUsd,
              estimated_cost_usd: signal.estimatedCostUsd,
              provider_cost_usd: signal.providerCostUsd,
              evidence_refs: buildModelEvidenceRefs(signal.evidenceRefs),
            }),
          ],
        );

        let noteId: string | null = noteInsert.rows[0]?.id ?? null;
        const insertedNew = (noteInsert.rowCount ?? 0) > 0;

        if (!noteId) {
          const existing = await client.query<{ id: string }>(
            `select id from ai_notes where note_key = $1 limit 1`,
            [noteKey],
          );
          noteId = existing.rows[0]?.id ?? null;
        }
        if (!noteId) {
          throw new Error("note_insert_failed");
        }

        await client.query(
          `
            insert into ai_note_targets (
              note_id,
              target_kind,
              target_id,
              is_primary,
              target_rank,
              affinity_score,
              target_meta
            ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
            on conflict (note_id, target_kind, target_id) do nothing
          `,
          [
            noteId,
            primaryTargetKind,
            primaryTargetId,
            true,
            0,
            signal.metrics?.selectedMarketAffinity ?? null,
            JSON.stringify({
              target_market_title: signal.targetMarketTitle,
              target_event_title: signal.targetEventTitle,
              target_venue: signal.targetVenue,
            }),
          ],
        );

        if (signal.targetEventId && primaryTargetKind !== "event") {
          await client.query(
            `
              insert into ai_note_targets (
                note_id,
                target_kind,
                target_id,
                is_primary,
                target_rank,
                affinity_score,
                target_meta
              ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
              on conflict (note_id, target_kind, target_id) do nothing
            `,
            [
              noteId,
              "event",
              signal.targetEventId,
              false,
              5,
              null,
              JSON.stringify({
                target_event_title: signal.targetEventTitle,
              }),
            ],
          );
        }

        if (primaryTargetKind !== "node") {
          await client.query(
            `
              insert into ai_note_targets (
                note_id,
                target_kind,
                target_id,
                is_primary,
                target_rank,
                affinity_score,
                target_meta
              ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
              on conflict (note_id, target_kind, target_id) do nothing
            `,
            [
              noteId,
              "node",
              signal.nodeId,
              false,
              10,
              null,
              JSON.stringify({ node_label: signal.nodeLabel }),
            ],
          );
        }

        for (const ref of ensureArray<SignalsReportSignal["evidenceRefs"][number]>(
          signal.evidenceRefs,
        )) {
          if (!ref.evidenceId) continue;
          await client.query(
            `
              insert into ai_note_evidence (note_id, evidence_id, relevance)
              values ($1, $2, $3)
              on conflict (note_id, evidence_id) do nothing
            `,
            [noteId, ref.evidenceId, null],
          );
        }

        if (insertedNew) {
          const previous = await client.query<{ id: string }>(
            `
              select n.id
              from ai_notes n
              join ai_note_targets t
                on t.note_id = n.id
               and t.is_primary = true
              where n.note_type = 'signal'
                and n.producer_type = 'map_signals'
                and n.status = 'active'
                and t.target_kind = $1
                and t.target_id = $2
                and n.id <> $3
              order by n.created_at desc
              limit 1
            `,
            [primaryTargetKind, primaryTargetId, noteId],
          );

          const previousId = previous.rows[0]?.id ?? null;
          if (previousId) {
            await client.query(
              `update ai_notes set status = 'superseded', updated_at = now() where id = $1`,
              [previousId],
            );
            await client.query(
              `update ai_notes set supersedes_note_id = $1, updated_at = now() where id = $2 and supersedes_note_id is null`,
              [previousId, noteId],
            );
            stats.superseded += 1;
          }
          stats.persisted += 1;
        } else {
          stats.skippedExisting += 1;
        }

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        stats.errors += 1;
        console.warn("[map-signals-runner] note persist failed", {
          signalId: signal.signalId,
          nodeId: signal.nodeId,
          targetMarketId: signal.targetMarketId,
          error: previewError(error),
        });
      }
    }
  } finally {
    client.release();
  }

  return stats;
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:map-signals:runner -- [options]

Options:
  --force                   Bypass policy enabled/rate/budget/input-digest gates
  --ignore-policy-rate      Ignore poll/run-window/day run-count gates
  --ignore-policy-budget    Ignore budget-window/day budget gates
  --ignore-input-digest     Ignore unchanged-input skip gate
  --dry-run                 Forward dry-run to ai:map-signals:run core
  --verbose                 Print additional debug details
  --help                    Show this help

All other args are passed through to ai:map-signals:run.
`);
}

async function setStatus(
  redis: ReturnType<typeof createRedisClient>,
  ttlSec: number,
  payload: Record<string, string | number | null>,
): Promise<void> {
  const cleaned = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, value ?? ""]),
  );
  await redis.hSet(STATUS_KEY, cleaned);
  await redis.expire(STATUS_KEY, ttlSec);
}

async function setRunStatus(
  redis: ReturnType<typeof createRedisClient>,
  mapRunId: string,
  ttlSec: number,
  payload: Record<string, string | number | null>,
): Promise<void> {
  const key = signalsRunStatusKey(mapRunId);
  const cleaned = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, value ?? ""]),
  );
  await redis.hSet(key, cleaned);
  await redis.expire(key, ttlSec);
}

function installSignalHandlers(
  onSignal: (signal: "SIGINT" | "SIGTERM") => Promise<void>,
): () => void {
  const signals: Array<"SIGINT" | "SIGTERM"> = ["SIGINT", "SIGTERM"];
  const wrappedHandlers = new Map<
    "SIGINT" | "SIGTERM",
    (signal: NodeJS.Signals) => void
  >();

  for (const signal of signals) {
    const handler = () => {
      void onSignal(signal);
    };
    wrappedHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    for (const signal of signals) {
      const handler = wrappedHandlers.get(signal);
      if (handler) {
        process.removeListener(signal, handler);
      }
    }
  };
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2));
  const policy = await resolveMapSignalsPolicy(pool);
  const config = policy.effective;

  if (!env.redisUrl) {
    throw new Error("[map-signals-runner] REDIS_URL is required");
  }

  if (!config.enabled && !args.force) {
    console.log("[map-signals-runner] skipped (policy disabled)");
    return;
  }

  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, { waitForReady: true, logLabel: "map-signals-runner" });
  const lockValue = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runnerRunId = lockValue;
  const nowMs = Date.now();
  let released = false;
  let shuttingDownBySignal = false;
  let activeMapRunIdForSignal: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatInFlight = false;

  const releaseLockAndRedis = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      const currentLockValue = await redis.get(LOCK_KEY);
      if (currentLockValue === lockValue) {
        await redis.del(LOCK_KEY);
      }
    } finally {
      await redis.quit();
    }
  };

  const detachSignalHandlers = installSignalHandlers(async signal => {
    if (shuttingDownBySignal) return;
    shuttingDownBySignal = true;
    console.warn(`[map-signals-runner] received ${signal}, releasing lock and exiting`);
    try {
      await setStatus(redis, config.statusTtlSec, {
        state: "aborted",
        reason: `aborted_${signal.toLowerCase()}`,
        runnerRunId,
        mapRunId: activeMapRunIdForSignal ?? "",
        at: new Date().toISOString(),
      });
      if (activeMapRunIdForSignal) {
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "aborted",
          reason: `aborted_${signal.toLowerCase()}`,
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date().toISOString(),
        });
      }
    } catch {
      // best effort
    }
    try {
      await releaseLockAndRedis();
    } finally {
      await pool.end();
      process.exit(130);
    }
  });

  const renewLock = async (): Promise<void> => {
    if (released || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const currentLockValue = await redis.get(LOCK_KEY);
      if (currentLockValue !== lockValue) {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        return;
      }
      await redis.expire(LOCK_KEY, config.lockTtlSec);
    } catch {
      // best effort
    } finally {
      heartbeatInFlight = false;
    }
  };

  const startHeartbeat = () => {
    const intervalSec = Math.max(
      5,
      Math.min(config.lockHeartbeatSec, Math.max(5, Math.floor(config.lockTtlSec / 2))),
    );
    heartbeatTimer = setInterval(() => {
      void renewLock();
    }, intervalSec * 1_000);
    heartbeatTimer.unref();
  };

  let tmpInputPath: string | null = null;
  let tmpOutPath: string | null = null;

  try {
    const acquired = await redis.set(LOCK_KEY, lockValue, {
      NX: true,
      EX: config.lockTtlSec,
    });
    if (acquired !== "OK") {
      console.log("[map-signals-runner] skipped (lock active)");
      await setStatus(redis, config.statusTtlSec, {
        state: "skipped",
        reason: "skipped_lock_active",
        runnerRunId,
        mapRunId: "",
        at: new Date(nowMs).toISOString(),
      });
      return;
    }

    startHeartbeat();

    const requestedMapRunId = parseFlag(args.passthroughArgs, "--run-id")?.trim() || null;
    const activeMapRunId = requestedMapRunId ?? (await redis.get(marketMapActiveKey()));
    if (!activeMapRunId || activeMapRunId.trim().length === 0) {
      console.log("[map-signals-runner] skipped (no active map run)");
      await setStatus(redis, config.statusTtlSec, {
        state: "skipped",
        reason: "skipped_no_active_map",
        runnerRunId,
        mapRunId: "",
        at: new Date(nowMs).toISOString(),
      });
      return;
    }
    activeMapRunIdForSignal = activeMapRunId.trim();

    await redis.zRemRangeByScore(RUNS_KEY, 0, nowMs - RUN_HISTORY_TTL_MS);
    const historyRaw = await redis.zRangeByScore(RUNS_KEY, nowMs - RUN_HISTORY_TTL_MS, nowMs);
    const history = parseRunEntries(historyRaw);
    const lastRunMs = history.reduce((max, item) => Math.max(max, item.ts), 0);
    const windowStartMs = nowMs - config.runWindowMinutes * 60_000;
    const dayStartMs = nowMs - 24 * 60 * 60 * 1_000;
    const budgetWindowStartMs = nowMs - config.budgetWindowMinutes * 60_000;

    const runsInWindow = history.filter(item => item.ts >= windowStartMs);
    const runsInDay = history.filter(item => item.ts >= dayStartMs);
    const runsInBudgetWindow = history.filter(item => item.ts >= budgetWindowStartMs);
    const budgetWindowSpentUsd = sumCost(runsInBudgetWindow);
    const daySpentUsd = sumCost(runsInDay);
    const estimatedCostUsd = args.dryRun ? 0 : config.estimatedRunCostUsd;

    if (!args.ignorePolicyRate) {
      if (lastRunMs > 0 && nowMs - lastRunMs < config.pollIntervalSec * 1_000) {
        console.log("[map-signals-runner] skipped (poll interval)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_poll_interval",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_poll_interval",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
        });
        return;
      }
      if (runsInWindow.length >= config.maxRunsPerWindow) {
        console.log("[map-signals-runner] skipped (run window cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInWindow: runsInWindow.length,
          maxRunsPerWindow: config.maxRunsPerWindow,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInWindow: runsInWindow.length,
          maxRunsPerWindow: config.maxRunsPerWindow,
        });
        return;
      }
      if (runsInDay.length >= config.maxRunsPerDay) {
        console.log("[map-signals-runner] skipped (day run cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInDay: runsInDay.length,
          maxRunsPerDay: config.maxRunsPerDay,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInDay: runsInDay.length,
          maxRunsPerDay: config.maxRunsPerDay,
        });
        return;
      }
    }

    if (!args.ignorePolicyBudget) {
      if (budgetWindowSpentUsd + estimatedCostUsd > config.budgetWindowUsd) {
        console.log("[map-signals-runner] skipped (budget window cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          budgetWindowSpentUsd,
          budgetWindowUsd: config.budgetWindowUsd,
          estimatedCostUsd,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          budgetWindowSpentUsd,
          budgetWindowUsd: config.budgetWindowUsd,
          estimatedCostUsd,
        });
        return;
      }
      if (daySpentUsd + estimatedCostUsd > config.dayBudgetUsd) {
        console.log("[map-signals-runner] skipped (day budget cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          daySpentUsd,
          dayBudgetUsd: config.dayBudgetUsd,
          estimatedCostUsd,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          daySpentUsd,
          dayBudgetUsd: config.dayBudgetUsd,
          estimatedCostUsd,
        });
        return;
      }
    }

    const searchArtifactRaw = await redis.get(searchArtifactKey(activeMapRunIdForSignal));
    if (!searchArtifactRaw || searchArtifactRaw.trim().length === 0) {
      console.log("[map-signals-runner] skipped (no search artifact)");
      await setStatus(redis, config.statusTtlSec, {
        state: "skipped",
        reason: "skipped_no_search_artifact",
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
        at: new Date(nowMs).toISOString(),
      });
      await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
        state: "skipped",
        reason: "skipped_no_search_artifact",
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
        at: new Date(nowMs).toISOString(),
      });
      return;
    }

    const latestSearchRaw = await redis.get(latestSearchForMapRunKey(activeMapRunIdForSignal));
    let searchRunId: string | null = null;
    if (latestSearchRaw) {
      try {
        const parsed = JSON.parse(latestSearchRaw) as LatestSearchMeta;
        if (parsed && typeof parsed.runnerRunId === "string") {
          searchRunId = parsed.runnerRunId;
        }
      } catch {
        searchRunId = null;
      }
    }

    const inputDigest = buildInputDigest(
      activeMapRunIdForSignal,
      searchRunId,
      searchArtifactRaw,
    );

    if (config.inputDigestEnabled && !args.ignoreInputDigest) {
      const priorDigest = await redis.get(runInputDigestKey(activeMapRunIdForSignal));
      if (priorDigest && priorDigest === inputDigest) {
        console.log("[map-signals-runner] skipped (input digest unchanged)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_no_input_change",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          searchRunId: searchRunId ?? "",
          inputDigest,
          at: new Date(nowMs).toISOString(),
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_no_input_change",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          searchRunId: searchRunId ?? "",
          inputDigest,
          at: new Date(nowMs).toISOString(),
        });
        return;
      }
    }

    if (args.verbose) {
      console.log("[map-signals-runner] executing", {
        source: policy.source,
        effectiveAt: policy.effectiveAt?.toISOString() ?? null,
        mapRunId: activeMapRunIdForSignal,
        searchRunId,
        inputDigest,
        triggerMode: config.triggerMode,
        pollIntervalSec: config.pollIntervalSec,
        runWindowMinutes: config.runWindowMinutes,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        dayBudgetUsd: config.dayBudgetUsd,
        estimatedRunCostUsd: estimatedCostUsd,
        inputDigestEnabled: config.inputDigestEnabled,
        persistNotes: config.persistNotes,
        maxPublishPerRun: config.maxPublishPerRun,
      });
    }

    await setStatus(redis, config.statusTtlSec, {
      state: "running",
      reason: "started",
      runnerRunId,
      mapRunId: activeMapRunIdForSignal,
      searchRunId: searchRunId ?? "",
      inputDigest,
      at: new Date(nowMs).toISOString(),
    });
    await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
      state: "running",
      reason: "started",
      runnerRunId,
      mapRunId: activeMapRunIdForSignal,
      searchRunId: searchRunId ?? "",
      inputDigest,
      at: new Date(nowMs).toISOString(),
    });

    const searchArgs = args.passthroughArgs.slice();
    const providedOutPath = parseFlag(searchArgs, "--out")?.trim() || null;
    tmpInputPath = join(tmpdir(), `ai-map-signals-input-${runnerRunId}.json`);
    tmpOutPath =
      providedOutPath && providedOutPath.length > 0
        ? providedOutPath
        : join(tmpdir(), `ai-map-signals-runner-${runnerRunId}.json`);

    await writeFile(tmpInputPath, searchArtifactRaw, "utf8");
    addArgIfMissing(searchArgs, "--in", tmpInputPath);
    addArgIfMissing(searchArgs, "--out", tmpOutPath);
    addArgIfMissing(searchArgs, "--model", config.model);
    addArgIfMissing(searchArgs, "--embed-model", config.embedModel);
    addArgIfMissing(searchArgs, "--max-nodes", String(config.maxNodes));
    addArgIfMissing(searchArgs, "--max-signals", String(config.maxSignals));
    addArgIfMissing(
      searchArgs,
      "--max-evidence-per-node",
      String(config.maxEvidencePerNode),
    );
    addArgIfMissing(
      searchArgs,
      "--top-markets-per-event",
      String(config.topMarketsPerEvent),
    );
    addArgIfMissing(
      searchArgs,
      "--max-markets-per-node",
      String(config.maxMarketsPerNode),
    );
    addArgIfMissing(searchArgs, "--min-evidence", String(config.minEvidence));
    addArgIfMissing(searchArgs, "--min-confirmed", String(config.minConfirmed));
    addArgIfMissing(
      searchArgs,
      "--min-distinct-domains",
      String(config.minDistinctDomains),
    );
    addArgIfMissing(
      searchArgs,
      "--min-evidence-ids-for-publish",
      String(config.minEvidenceIdsForPublish),
    );
    addArgIfMissing(
      searchArgs,
      "--min-affinity-for-publish",
      String(config.minAffinityForPublish),
    );
    addArgIfMissing(searchArgs, "--concurrency", String(config.concurrency));
    addArgIfMissing(searchArgs, "--max-output-tokens", String(config.maxOutputTokens));
    addArgIfMissing(searchArgs, "--timeout-sec", String(config.timeoutSec));
    addArgIfMissing(searchArgs, "--max-retries", String(config.maxRetries));
    addArgIfMissing(searchArgs, "--retry-base-ms", String(config.retryBaseMs));

    if ((args.dryRun || config.dryRun) && !hasOption(searchArgs, "--dry-run")) {
      searchArgs.push("--dry-run");
    }
    if ((args.verbose || config.verbose) && !hasOption(searchArgs, "--verbose")) {
      searchArgs.push("--verbose");
    }

    try {
      await runMapSignals(searchArgs, {
        commandName: "ai:map-signals:run",
        scriptTag: "ai-map-signals-runner",
        qaScriptName: "ai-map-signals-runner",
      });

      const outputRaw = await readFile(tmpOutPath, "utf8");
      const report = extractSignalsReport(outputRaw);
      const mapRunId = report.source?.runId?.trim() || activeMapRunIdForSignal;
      const generatedSignals = Math.trunc(toNumber(report.totals?.generatedSignals));
      const publishCandidates = Math.trunc(toNumber(report.totals?.publishCandidates));
      const actualEstimatedCostUsd = toNumber(report.totals?.estimatedCostUsd);
      const actualChargedCostUsd = toNumber(
        report.totals?.chargedCostUsd,
        actualEstimatedCostUsd,
      );
      const providerReportedCostUsd = toNumber(report.totals?.providerReportedCostUsd);
      const providerReportedCostCalls = Math.trunc(
        toNumber(report.totals?.providerReportedCostCalls),
      );
      const costSource: "estimated" | "provider_reported" | "mixed" =
        providerReportedCostCalls <= 0
          ? "estimated"
          : providerReportedCostCalls >= generatedSignals
            ? "provider_reported"
            : "mixed";

      const shouldPersistNotes =
        config.persistNotes &&
        !hasTruthyOverride(searchArgs, "--dry-run");
      const persistStats = shouldPersistNotes
        ? await persistSignalNotes({
            report,
            runnerRunId,
            mapRunId,
            searchRunId,
            inputDigest,
            maxPublishPerRun: config.maxPublishPerRun,
          })
        : {
            considered: 0,
            persisted: 0,
            skippedExisting: 0,
            superseded: 0,
            errors: 0,
          };

      const finishedAt = Date.now();
      const runEntry: RunEntry = {
        runnerRunId,
        mapRunId,
        searchRunId,
        inputDigest,
        ts: finishedAt,
        costUsd: actualChargedCostUsd,
        estimatedCostUsd: actualEstimatedCostUsd,
        chargedCostUsd: actualChargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
        generatedSignals,
        publishCandidates,
        notesPersisted: persistStats.persisted,
        notesSkippedExisting: persistStats.skippedExisting,
        notesSuperseded: persistStats.superseded,
        result: hasTruthyOverride(searchArgs, "--dry-run") ? "dry_run" : "ok",
      };

      await redis.zAdd(RUNS_KEY, {
        score: finishedAt,
        value: JSON.stringify(runEntry),
      });
      await redis.set(signalsArtifactKey(mapRunId), outputRaw, {
        EX: config.artifactTtlSec,
      });
      await redis.set(LATEST_KEY, mapRunId, { EX: config.artifactTtlSec });
      await redis.set(
        signalsLatestForMapRunKey(mapRunId),
        JSON.stringify({
          runnerRunId,
          mapRunId,
          searchRunId,
          inputDigest,
          completedAt: new Date(finishedAt).toISOString(),
        }),
        { EX: config.artifactTtlSec },
      );

      if (!hasTruthyOverride(searchArgs, "--dry-run")) {
        await redis.set(LAST_INPUT_DIGEST_KEY, inputDigest, {
          EX: config.artifactTtlSec,
        });
        await redis.set(runInputDigestKey(mapRunId), inputDigest, {
          EX: config.artifactTtlSec,
        });
      }

      const postWindowStartMs = finishedAt - config.runWindowMinutes * 60_000;
      const postDayStartMs = finishedAt - 24 * 60 * 60 * 1_000;
      const postBudgetWindowStartMs = finishedAt - config.budgetWindowMinutes * 60_000;
      const historyAfter = [...history, runEntry];
      const postRunsInWindow = historyAfter.filter(item => item.ts >= postWindowStartMs);
      const postRunsInDay = historyAfter.filter(item => item.ts >= postDayStartMs);
      const postRunsInBudgetWindow = historyAfter.filter(
        item => item.ts >= postBudgetWindowStartMs,
      );
      const postBudgetWindowSpentUsd = sumCost(postRunsInBudgetWindow);
      const postDaySpentUsd = sumCost(postRunsInDay);

      const state = hasTruthyOverride(searchArgs, "--dry-run")
        ? "dry_run"
        : "completed";
      await setStatus(redis, config.statusTtlSec, {
        state,
        reason: "ok",
        runnerRunId,
        mapRunId,
        searchRunId: searchRunId ?? "",
        inputDigest,
        at: new Date(finishedAt).toISOString(),
        generatedSignals,
        publishCandidates,
        notesPersisted: persistStats.persisted,
        notesSkippedExisting: persistStats.skippedExisting,
        notesSuperseded: persistStats.superseded,
        notesPersistErrors: persistStats.errors,
        estimatedCostUsd,
        actualEstimatedCostUsd,
        actualChargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
        runWindowMinutes: config.runWindowMinutes,
        runsInWindow: postRunsInWindow.length,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        runsInDay: postRunsInDay.length,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        budgetWindowSpentUsd: Number(postBudgetWindowSpentUsd.toFixed(6)),
        budgetWindowRemainingUsd: Number(
          Math.max(0, config.budgetWindowUsd - postBudgetWindowSpentUsd).toFixed(6),
        ),
        dayBudgetUsd: config.dayBudgetUsd,
        daySpentUsd: Number(postDaySpentUsd.toFixed(6)),
        dayBudgetRemainingUsd: Number(
          Math.max(0, config.dayBudgetUsd - postDaySpentUsd).toFixed(6),
        ),
      });
      await setRunStatus(redis, mapRunId, config.statusTtlSec, {
        state,
        reason: "ok",
        runnerRunId,
        mapRunId,
        searchRunId: searchRunId ?? "",
        inputDigest,
        at: new Date(finishedAt).toISOString(),
        generatedSignals,
        publishCandidates,
        notesPersisted: persistStats.persisted,
        actualChargedCostUsd,
        costSource,
      });

      console.log(
        `[map-signals-runner] done runnerRunId=${runnerRunId} mapRunId=${mapRunId} state=${state} charged_cost=${actualChargedCostUsd.toFixed(6)} source=${costSource} signals=${generatedSignals} publish=${publishCandidates} notes=${persistStats.persisted}`,
      );
    } catch (error) {
      const finishedAt = Date.now();
      const runEntry: RunEntry = {
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
        searchRunId,
        inputDigest,
        ts: finishedAt,
        costUsd: estimatedCostUsd,
        estimatedCostUsd,
        chargedCostUsd: estimatedCostUsd,
        providerReportedCostUsd: 0,
        providerReportedCostCalls: 0,
        costSource: "estimated",
        result: "error",
      };
      await redis.zAdd(RUNS_KEY, {
        score: finishedAt,
        value: JSON.stringify(runEntry),
      });

      const postWindowStartMs = finishedAt - config.runWindowMinutes * 60_000;
      const postDayStartMs = finishedAt - 24 * 60 * 60 * 1_000;
      const postBudgetWindowStartMs = finishedAt - config.budgetWindowMinutes * 60_000;
      const historyAfter = [...history, runEntry];
      const postRunsInWindow = historyAfter.filter(item => item.ts >= postWindowStartMs);
      const postRunsInDay = historyAfter.filter(item => item.ts >= postDayStartMs);
      const postRunsInBudgetWindow = historyAfter.filter(
        item => item.ts >= postBudgetWindowStartMs,
      );
      const postBudgetWindowSpentUsd = sumCost(postRunsInBudgetWindow);
      const postDaySpentUsd = sumCost(postRunsInDay);
      const errorMessage = previewError(error);

      await setStatus(redis, config.statusTtlSec, {
        state: "failed",
        reason: "error",
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
        searchRunId: searchRunId ?? "",
        inputDigest,
        at: new Date(finishedAt).toISOString(),
        error: errorMessage,
        estimatedCostUsd,
        runWindowMinutes: config.runWindowMinutes,
        runsInWindow: postRunsInWindow.length,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        runsInDay: postRunsInDay.length,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        budgetWindowSpentUsd: Number(postBudgetWindowSpentUsd.toFixed(6)),
        budgetWindowRemainingUsd: Number(
          Math.max(0, config.budgetWindowUsd - postBudgetWindowSpentUsd).toFixed(6),
        ),
        dayBudgetUsd: config.dayBudgetUsd,
        daySpentUsd: Number(postDaySpentUsd.toFixed(6)),
        dayBudgetRemainingUsd: Number(
          Math.max(0, config.dayBudgetUsd - postDaySpentUsd).toFixed(6),
        ),
      });
      await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
        state: "failed",
        reason: "error",
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
        searchRunId: searchRunId ?? "",
        inputDigest,
        at: new Date(finishedAt).toISOString(),
        error: errorMessage,
      });

      throw error;
    }
  } finally {
    detachSignalHandlers();
    if (tmpInputPath) {
      try {
        await rm(tmpInputPath, { force: true });
      } catch {
        // best effort cleanup
      }
    }
    if (tmpOutPath && tmpOutPath.includes(`ai-map-signals-runner-${runnerRunId}`)) {
      try {
        await rm(tmpOutPath, { force: true });
      } catch {
        // best effort cleanup
      }
    }
    await releaseLockAndRedis();
    await pool.end();
  }
}

main().catch(error => {
  console.error("[map-signals-runner] failed", error);
  process.exit(1);
});
