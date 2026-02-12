import { readFile, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const QA_CONTRACT_VERSION = "qa_contract_v1";
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
const envLoaded = config({ path: envPath });
if (envLoaded.error) {
  const err = envLoaded.error as NodeJS.ErrnoException;
  if (err.code !== "ENOENT") {
    console.warn(`[ai-e2e-smoke] Failed loading env from ${envPath}:`, envLoaded.error.message);
  }
} else {
  console.log(`[ai-e2e-smoke] Loading env from ${envPath}`);
}

type Args = {
  topicsOut: string;
  searchOut: string;
  synthesisOut: string;
  out: string | null;
  maxTopics: number;
  limit: number;
  sampling: "per-venue" | "global";
  launchProfile: "custom" | "top50_per_venue" | "top100_per_venue" | "stress500_global";
  mode: "combined" | "web_only" | "internal_only";
  tiers: string;
  searchConcurrency: number;
  synthesisConcurrency: number;
  maxContextMarkets: number;
  verbose: boolean;
  saveRaw: boolean;
  sampleSeed: number | null;
  searchDryRun: boolean;
  synthesisDryRun: boolean;
};

type ChildResult = {
  exitCode: number;
  durationMs: number;
};

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.findIndex(value => value === name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseSampling(raw: string | undefined): "per-venue" | "global" {
  return raw === "global" ? "global" : "per-venue";
}

function parseLaunchProfile(
  raw: string | undefined,
): Args["launchProfile"] {
  if (raw === "top50_per_venue") return "top50_per_venue";
  if (raw === "top100_per_venue") return "top100_per_venue";
  if (raw === "stress500_global") return "stress500_global";
  return "custom";
}

function parseMode(raw: string | undefined): Args["mode"] {
  if (raw === "web_only" || raw === "internal_only") return raw;
  return "combined";
}

function parseArgs(argv: string[]): Args {
  return {
    topicsOut:
      parseFlag(argv, "--topics-out") ?? "/tmp/ai-e2e-topics.json",
    searchOut:
      parseFlag(argv, "--search-out") ?? "/tmp/ai-e2e-search.json",
    synthesisOut:
      parseFlag(argv, "--synthesis-out") ?? "/tmp/ai-e2e-synthesis.json",
    out: parseFlag(argv, "--out") ?? null,
    maxTopics: parsePositiveInt(parseFlag(argv, "--max-topics"), 8),
    limit: parsePositiveInt(parseFlag(argv, "--limit"), 5000),
    sampling: parseSampling(parseFlag(argv, "--sampling")),
    launchProfile: parseLaunchProfile(parseFlag(argv, "--launch-profile")),
    mode: parseMode(parseFlag(argv, "--mode")),
    tiers: parseFlag(argv, "--tiers") ?? "A,B,C",
    searchConcurrency: parsePositiveInt(
      parseFlag(argv, "--search-concurrency"),
      2,
    ),
    synthesisConcurrency: parsePositiveInt(
      parseFlag(argv, "--synthesis-concurrency"),
      2,
    ),
    maxContextMarkets: parsePositiveInt(
      parseFlag(argv, "--max-context-markets"),
      5,
    ),
    verbose: hasFlag(argv, "--verbose"),
    saveRaw: hasFlag(argv, "--save-raw"),
    sampleSeed: parseInteger(parseFlag(argv, "--sample-seed")),
    searchDryRun: hasFlag(argv, "--search-dry-run"),
    synthesisDryRun: hasFlag(argv, "--synthesis-dry-run"),
  };
}

function usage(exitCode = 1): never {
  console.error(`Usage: pnpm -C hunch-monorepo -F api run ai:e2e:smoke -- [options]

Options:
  --topics-out <path>            Topics JSON output (default: /tmp/ai-e2e-topics.json)
  --search-out <path>            Search JSON output (default: /tmp/ai-e2e-search.json)
  --synthesis-out <path>         Synthesis JSON output (default: /tmp/ai-e2e-synthesis.json)
  --out <path>                   Consolidated report JSON output
  --max-topics <n>               Topics used in search/synthesis (default: 8)
  --limit <n>                    Topic extractor row limit (default: 5000)
  --sampling <per-venue|global>  Topic extractor sampling (default: per-venue)
  --launch-profile <name>        custom|top50_per_venue|top100_per_venue|stress500_global
  --mode <combined|web_only|internal_only>  Search mode (default: combined)
  --tiers <csv>                  Search tiers (default: A,B,C)
  --search-concurrency <n>       Search concurrency (default: 2)
  --synthesis-concurrency <n>    Synthesis concurrency (default: 2)
  --max-context-markets <n>      Synthesis context markets (default: 5)
  --sample-seed <n>              Deterministic topic sampling seed passed to search stage
  --search-dry-run               Run search stage with --dry-run (no xAI API calls)
  --synthesis-dry-run            Run synthesis stage with --dry-run (no model calls)
  --save-raw                     Pass through raw search responses
  --verbose                      Verbose child script output
`);
  process.exit(exitCode);
}

function runCommand(
  cmd: string,
  cmdArgs: string[],
  label: string,
): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, cmdArgs, {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });

    child.on("error", reject);
    child.on("close", code => {
      const exitCode = code ?? 1;
      const durationMs = Date.now() - startedAt;
      if (exitCode !== 0) {
        reject(new Error(`${label} failed with exit code ${exitCode}`));
        return;
      }
      resolvePromise({ exitCode, durationMs });
    });
  });
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(resolve(path), "utf8");
  return JSON.parse(raw) as unknown;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    usage(0);
  }

  const args = parseArgs(argv);

  if (!args.searchDryRun && !process.env.XAI_API_KEY?.trim()) {
    throw new Error("XAI_API_KEY is required when search stage is not dry-run");
  }
  if (!args.synthesisDryRun && !process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error(
      "OPENROUTER_API_KEY is required when synthesis stage is not dry-run",
    );
  }

  const topicsCmd = [
    "src/ai-topics-dry-run.ts",
    "--json",
    "--out",
    args.topicsOut,
    "--limit",
    String(args.limit),
    "--sampling",
    args.sampling,
    "--launch-profile",
    args.launchProfile,
  ];

  const searchCmd = [
    "src/ai-search-smoke.ts",
    "--topics-file",
    args.topicsOut,
    "--mode",
    args.mode,
    "--tiers",
    args.tiers,
    "--max-topics",
    String(args.maxTopics),
    "--concurrency",
    String(args.searchConcurrency),
    "--out",
    args.searchOut,
  ];
  if (args.sampleSeed != null) {
    searchCmd.push("--sample-seed", String(args.sampleSeed));
  }
  if (args.searchDryRun) searchCmd.push("--dry-run");
  if (args.verbose) searchCmd.push("--verbose");
  if (args.saveRaw) searchCmd.push("--save-raw");

  const synthesisCmd = [
    "src/ai-synthesis-smoke.ts",
    "--topics-file",
    args.topicsOut,
  ];
  if (!args.searchDryRun) {
    synthesisCmd.push("--search-results-file", args.searchOut);
  }
  synthesisCmd.push(
    "--max-topics",
    String(args.maxTopics),
    "--max-context-markets",
    String(args.maxContextMarkets),
    "--concurrency",
    String(args.synthesisConcurrency),
    "--out",
    args.synthesisOut,
  );
  if (args.synthesisDryRun) synthesisCmd.push("--dry-run");
  if (args.verbose) synthesisCmd.push("--verbose");

  console.log("[ai-e2e-smoke] running topics stage");
  const topicsStage = await runCommand("tsx", topicsCmd, "topics");

  console.log("[ai-e2e-smoke] running search stage");
  const searchStage = await runCommand("tsx", searchCmd, "search");

  console.log("[ai-e2e-smoke] running synthesis stage");
  const synthesisStage = await runCommand("tsx", synthesisCmd, "synthesis");

  const topicsJson = await readJson(args.topicsOut);
  const searchJson = await readJson(args.searchOut);
  const synthesisJson = await readJson(args.synthesisOut);

  const report = {
    qaContract: {
      version: QA_CONTRACT_VERSION,
      script: "ai-e2e-smoke",
      generatedAt: new Date().toISOString(),
    },
    args,
    timings: {
      topicsMs: topicsStage.durationMs,
      searchMs: searchStage.durationMs,
      synthesisMs: synthesisStage.durationMs,
      totalMs:
        topicsStage.durationMs + searchStage.durationMs + synthesisStage.durationMs,
    },
    artifacts: {
      topicsOut: resolve(args.topicsOut),
      searchOut: resolve(args.searchOut),
      synthesisOut: resolve(args.synthesisOut),
    },
    summary: {
      topics: {
        uniqueSearchTopics:
          (topicsJson as { totals?: { uniqueSearchTopics?: number } }).totals
            ?.uniqueSearchTopics ?? null,
        tierCounts:
          (topicsJson as { searchPlan?: { tierCounts?: Record<string, number> } })
            .searchPlan?.tierCounts ?? null,
      },
      search: {
        totals:
          (searchJson as { totals?: Record<string, unknown> }).totals ?? null,
        outcomeSummary:
          (searchJson as { outcomeSummary?: Record<string, number> })
            .outcomeSummary ?? null,
      },
      synthesis: {
        totals:
          (synthesisJson as { totals?: Record<string, unknown> }).totals ?? null,
        gateSummary:
          (synthesisJson as { gateSummary?: Record<string, unknown> })
            .gateSummary ?? null,
      },
    },
  };

  if (args.out) {
    await writeFile(resolve(args.out), JSON.stringify(report, null, 2), "utf8");
    console.log(`[ai-e2e-smoke] wrote ${resolve(args.out)}`);
  }

  console.log(
    `[ai-e2e-smoke] done totalMs=${report.timings.totalMs} searchOutcomes=${JSON.stringify(report.summary.search.outcomeSummary ?? {})}`,
  );
}

main().catch(error => {
  console.error("[ai-e2e-smoke] failed", error);
  process.exit(1);
});
