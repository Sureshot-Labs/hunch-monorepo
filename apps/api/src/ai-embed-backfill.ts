import { pathToFileURL } from "node:url";
import { fetchActiveRuntimePolicy, type RuntimePolicyQuery } from "@hunch/db";
import {
  countEmbeddingSources,
  embeddingPolicySchema,
  generationForPolicy,
  readActiveGeneration,
  EMBEDDING_STATUS_KEY,
} from "@hunch/embeddings";
import { createPgPool, createRedisClient } from "@hunch/infra";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  parseVenueLifecyclePolicy,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { parseAdminEmbeddingStatus } from "./services/admin-embeddings-status.js";

export type EmbeddingBackfillOptions = {
  mode: "preview" | "execute" | "status" | "help";
  venues: string[];
  limit?: number;
  includeMarkets: boolean;
  includeEvents: boolean;
};

export function parseEmbeddingBackfillOptions(
  args: string[],
): EmbeddingBackfillOptions {
  const options: EmbeddingBackfillOptions = {
    mode: "preview",
    venues: [],
    includeMarkets: true,
    includeEvents: true,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--" && index === 0) continue;
    const equalAt = arg.indexOf("=");
    const key = equalAt < 0 ? arg : arg.slice(0, equalAt);
    if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
    seen.add(key);
    if (
      [
        "--execute",
        "--dry-run",
        "--status",
        "--help",
        "--markets",
        "--events",
      ].includes(key)
    ) {
      if (equalAt >= 0) throw new Error(`${key} does not take a value`);
      if (key === "--execute") options.mode = "execute";
      if (key === "--status") options.mode = "status";
      if (key === "--help") options.mode = "help";
      continue;
    }
    if (key !== "--venue" && key !== "--limit") {
      throw new Error(
        key === "--batch-size"
          ? "--batch-size is now controlled by the ai_embeddings policy"
          : `Unknown option: ${key}`,
      );
    }
    const value = equalAt < 0 ? args[++index] : arg.slice(equalAt + 1);
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    if (key === "--limit") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--limit must be a positive safe integer");
      }
      options.limit = Number(value);
    } else {
      options.venues = [
        ...new Set(value.split(",").map((item) => item.trim().toLowerCase())),
      ];
      if (
        options.venues.some(
          (venue) =>
            !["polymarket", "limitless", "kalshi", "dflow"].includes(venue),
        )
      ) {
        throw new Error(
          "--venue supports polymarket, limitless, kalshi or dflow",
        );
      }
      options.venues = [
        ...new Set(
          options.venues.map((venue) => (venue === "dflow" ? "kalshi" : venue)),
        ),
      ];
    }
  }
  const modes = ["--execute", "--dry-run", "--status", "--help"].filter((key) =>
    seen.has(key),
  );
  if (modes.length > 1)
    throw new Error(
      "Choose only one of --execute, --dry-run, --status or --help",
    );
  if (seen.has("--markets") && seen.has("--events"))
    throw new Error("Choose --markets, --events, or neither for both");
  options.includeMarkets = !seen.has("--events");
  options.includeEvents = !seen.has("--markets");
  const filtered =
    options.venues.length > 0 ||
    options.limit != null ||
    !options.includeMarkets ||
    !options.includeEvents;
  if (filtered && options.mode !== "preview") {
    throw new Error(
      "Venue/entity/limit filters are preview-only; --execute requests the full canonical reconciliation",
    );
  }
  return options;
}

const help = `Usage: pnpm -C hunch-monorepo -F api run ai:embed:backfill -- [options]

Default: read-only preview of eligible source counts and the desired generation.
  --dry-run                 Explicit read-only preview (no embedding requests)
  --venue <venue[,venue]>    Preview only: polymarket,limitless,kalshi,dflow
  --limit <n>               Preview only: cap displayed candidates per entity type
  --markets | --events      Preview only: select one entity type
  --status                  Read the worker's saved verification/progress report
  --execute                 Request a full reconciliation by the existing worker
  --help                    Show this help

Execution does not write vectors, reset checkpoints or call the provider here.
The worker uses its policy batch size, budget, lease and resumable checkpoint.
A request being accepted is NOT evidence of completed coverage. Use --status.
`;

type BackfillRedis = {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
};

export async function runEmbeddingBackfill(
  options: EmbeddingBackfillOptions,
  dependencies: {
    db: RuntimePolicyQuery;
    redis: BackfillRedis;
    log: (value: unknown) => void;
  },
): Promise<void> {
  const { db, redis, log } = dependencies;
  if (options.mode === "help") {
    log(help);
    return;
  }
  if (options.mode === "status") {
    const report = parseAdminEmbeddingStatus(
      await redis.get(EMBEDDING_STATUS_KEY),
    );
    if (report.error) throw new Error(report.error);
    log({ readOnly: true, ...report });
    return;
  }
  const policyRow = await fetchActiveRuntimePolicy(db, "ai_embeddings");
  const policy = embeddingPolicySchema.parse(policyRow?.payload ?? {});
  const lifecycleRow = await fetchActiveRuntimePolicy(db, "venue_lifecycle");
  const lifecycle = lifecycleRow
    ? parseVenueLifecyclePolicy(lifecycleRow.payload)
    : DEFAULT_VENUE_LIFECYCLE_POLICY;
  if (!lifecycle)
    throw new Error(
      "Venue lifecycle policy is invalid; no reconciliation requested",
    );
  const eligibleVenues = Object.keys(lifecycle.venues).filter((venue) =>
    venueHasLifecycleCapability(lifecycle, venue, "discovery"),
  );
  const venues = options.venues.length
    ? eligibleVenues.filter((venue) => options.venues.includes(venue))
    : eligibleVenues;
  const desiredGeneration = generationForPolicy(policy);
  const activeGeneration = await readActiveGeneration(redis);
  const counts = await countEmbeddingSources(db, venues);
  const count = (value: number) => Math.min(value, options.limit ?? value);
  log({
    readOnly: true,
    preview: true,
    policyEnabled: policy.enabled,
    activeGeneration,
    desiredGeneration,
    venues,
    eligible: counts,
    previewCandidates: {
      event: options.includeEvents ? count(counts.event) : 0,
      market: options.includeMarkets ? count(counts.market) : 0,
    },
    generationBudgetUsd: policy.generationBudgetUsd,
    note: "Eligible candidates are not a count of missing embeddings or a price quote. The worker skips unchanged content and verifies coverage separately.",
  });
  if (options.mode !== "execute") return;
  if (!policy.enabled)
    throw new Error(
      "Embeddings are disabled by policy; no reconciliation requested",
    );
  const requestRevision = await redis.incr("ai:embed:control:reconcile");
  log({
    readOnly: false,
    requested: true,
    completed: false,
    requestRevision,
    note: "Full reconciliation requested. The worker owns execution, checkpoints and budget. Use --status to inspect progress; this does not prove completion.",
  });
}

async function run(): Promise<void> {
  const options = parseEmbeddingBackfillOptions(process.argv.slice(2));
  if (options.mode === "help") {
    console.log(help);
    return;
  }
  const { env } = await import("./env.js");
  if (!env.redisUrl) throw new Error("REDIS_URL is required");
  const redis = createRedisClient({ url: env.redisUrl });
  redis.on("error", () => {
    /* The bounded operation reports a sanitized failure. */
  });
  const db = createPgPool({
    connectionString: env.dbUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    options:
      "-c default_transaction_read_only=on -c statement_timeout=5000 -c jit=off",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.connect(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Redis connection timed out")),
          5000,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    await Promise.race([
      runEmbeddingBackfill(options, {
        db,
        redis,
        log: (value) => console.log(JSON.stringify(value, null, 2)),
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Backfill inspection/request timed out; inspect --status before retrying",
              ),
            ),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (redis.isOpen) redis.destroy();
    await db.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    // Do not dump provider or connection objects that may contain credentials.
    console.error(
      "[backfill] failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  });
}
