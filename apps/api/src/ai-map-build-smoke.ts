import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { runMarketMapBuild } from "./lib/map-news/map-build-core.js";

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasOption(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function withoutFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === flag) {
      i += 1;
      continue;
    }
    if (token.startsWith(`${flag}=`)) {
      continue;
    }
    out.push(token);
  }
  return out;
}

function buildMarkdown(report: {
  generatedAt: string;
  args: string[];
  result: unknown;
}): string {
  const lines: string[] = [];
  lines.push("# AI Map Build Smoke Report");
  lines.push("");
  lines.push(`- generated_at: ${report.generatedAt}`);
  lines.push(`- args: \`${report.args.join(" ")}\``);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.result, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:map-build:smoke -- [options]

Options:
  --out <path>               Write JSON report to path
  --report-out <path>        Write Markdown report to path
  --help                     Show this help

All other args are passed through to ai:map-build:run.
Smoke mode defaults to --dry-run unless explicitly overridden.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    printHelp();
    return;
  }

  const outPath = parseFlag(argv, "--out") ?? null;
  const reportOutPath = parseFlag(argv, "--report-out") ?? null;
  const passthrough = withoutFlag(withoutFlag(argv, "--out"), "--report-out");
  if (!hasOption(passthrough, "--dry-run")) {
    passthrough.push("--dry-run");
  }

  const startedAt = Date.now();
  const result = await runMarketMapBuild(passthrough);
  const report = {
    qaContract: {
      version: "qa_contract_v1",
      script: "ai-map-build-smoke",
      generatedAt: new Date().toISOString(),
    },
    durationMs: Date.now() - startedAt,
    args: passthrough,
    result,
  };

  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[ai-map-build-smoke] wrote ${outPath}`);
  }
  if (reportOutPath) {
    await writeFile(
      reportOutPath,
      buildMarkdown({
        generatedAt: report.qaContract.generatedAt,
        args: passthrough,
        result,
      }),
    );
    console.log(`[ai-map-build-smoke] wrote ${reportOutPath}`);
  }

  console.log(
    `[ai-map-build-smoke] done status=${result.status} events=${result.eventCountTotal} nodes=${result.nodeCountTotal} duration_ms=${report.durationMs}`,
  );
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[ai-map-build-smoke] failed", error);
      await pool.end();
      process.exit(1);
    });
}
