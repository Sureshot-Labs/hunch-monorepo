import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type StageName = "build" | "search" | "signals";

type RunnerOptions = {
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
  skipBuild: boolean;
  skipSearch: boolean;
  skipSignals: boolean;
  buildArgs: string[];
  searchArgs: string[];
  signalsArgs: string[];
};

type Stage = {
  name: StageName;
  script: string;
  extraArgs: string[];
};

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:map:runner -- [options]

Runs the full AI market-map pipeline in order:
  1. ai:map-build:runner
  2. ai:map-search:runner
  3. ai:map-signals:runner

Defaults:
  - force mode is ON by default
  - stops on the first failing stage

Options:
  --force                   Force all three stages (default)
  --no-force                Do not add --force to stage runners
  --dry-run                 Forward dry-run to all stages
  --verbose                 Forward verbose to all stages
  --skip-build              Skip map build
  --skip-search             Skip map search
  --skip-signals            Skip map signals
  --build-arg <arg>         Extra arg for ai:map-build:runner (repeatable)
  --search-arg <arg>        Extra arg for ai:map-search:runner (repeatable)
  --signals-arg <arg>       Extra arg for ai:map-signals:runner (repeatable)
  --help                    Show this help

Examples:
  pnpm -C hunch-monorepo -F api run ai:map:runner --
  pnpm -C hunch-monorepo -F api run ai:map:runner -- --dry-run
  pnpm -C hunch-monorepo -F api run ai:map:runner -- --signals-arg=--max-signals=30
`);
}

function takeNextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function parseRunnerArgs(argv: string[]): RunnerOptions {
  let force = true;
  let dryRun = false;
  let verbose = false;
  let skipBuild = false;
  let skipSearch = false;
  let skipSignals = false;
  const buildArgs: string[] = [];
  const searchArgs: string[] = [];
  const signalsArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--no-force") {
      force = false;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--skip-search") {
      skipSearch = true;
      continue;
    }
    if (arg === "--skip-signals") {
      skipSignals = true;
      continue;
    }
    if (arg.startsWith("--build-arg=")) {
      buildArgs.push(arg.slice("--build-arg=".length));
      continue;
    }
    if (arg === "--build-arg") {
      buildArgs.push(takeNextValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--search-arg=")) {
      searchArgs.push(arg.slice("--search-arg=".length));
      continue;
    }
    if (arg === "--search-arg") {
      searchArgs.push(takeNextValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--signals-arg=")) {
      signalsArgs.push(arg.slice("--signals-arg=".length));
      continue;
    }
    if (arg === "--signals-arg") {
      signalsArgs.push(takeNextValue(argv, index, arg));
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    force,
    dryRun,
    verbose,
    skipBuild,
    skipSearch,
    skipSignals,
    buildArgs,
    searchArgs,
    signalsArgs,
  };
}

function buildStageArgs(options: RunnerOptions, extraArgs: string[]): string[] {
  const args: string[] = [];
  if (options.force) args.push("--force");
  if (options.dryRun) args.push("--dry-run");
  if (options.verbose) args.push("--verbose");
  args.push(...extraArgs);
  return args;
}

function stageList(options: RunnerOptions): Stage[] {
  const stages: Stage[] = [];
  if (!options.skipBuild) {
    stages.push({
      name: "build",
      script: "ai:map-build:runner",
      extraArgs: options.buildArgs,
    });
  }
  if (!options.skipSearch) {
    stages.push({
      name: "search",
      script: "ai:map-search:runner",
      extraArgs: options.searchArgs,
    });
  }
  if (!options.skipSignals) {
    stages.push({
      name: "signals",
      script: "ai:map-signals:runner",
      extraArgs: options.signalsArgs,
    });
  }
  return stages;
}

async function runStage(stage: Stage, options: RunnerOptions): Promise<void> {
  const args = ["run", stage.script, "--", ...buildStageArgs(options, stage.extraArgs)];
  console.log(`[ai-map-runner] stage_start ${stage.name} pnpm ${args.join(" ")}`);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(command, args, {
      cwd: API_DIR,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", rejectPromise);
    child.on("exit", code => {
      if (code === 0) {
        console.log(`[ai-map-runner] stage_done ${stage.name}`);
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`[ai-map-runner] stage_failed ${stage.name} exit_code=${code ?? "null"}`),
      );
    });
  });
}

async function main(): Promise<void> {
  const options = parseRunnerArgs(process.argv.slice(2));
  const stages = stageList(options);

  if (stages.length === 0) {
    console.log("[ai-map-runner] nothing to do");
    return;
  }

  console.log(
    `[ai-map-runner] start stages=${stages.map(stage => stage.name).join(",")} force=${options.force} dry_run=${options.dryRun} verbose=${options.verbose}`,
  );

  for (const stage of stages) {
    await runStage(stage, options);
  }

  console.log("[ai-map-runner] done");
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
