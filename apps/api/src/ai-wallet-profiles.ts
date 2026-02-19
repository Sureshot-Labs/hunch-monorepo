import { runWhaleProfiles } from "./services/whale-profiles.js";
import { pool } from "./db.js";
import { resolveAiWhaleProfilesPolicy } from "./services/runtime-policies.js";

function readArg(
  name: string,
  fallback?: number | boolean,
): number | boolean | undefined {
  const key = `--${name}`;
  const argv = process.argv.filter((arg) => arg !== "--");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith(key)) continue;
    const hasInline = arg.startsWith(`${key}=`);
    const raw = hasInline ? arg.slice(key.length + 1) : argv[i + 1];
    if (raw == null || raw.startsWith("--")) return true;
    if (raw === "true" || raw === "false") return raw === "true";
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }
  return fallback;
}

async function main() {
  const policy = await resolveAiWhaleProfilesPolicy(pool);
  const config = policy.effective;
  const limit =
    (readArg("limit") as number | undefined) ?? config.limit;
  const marketLimit =
    (readArg("market-limit") as number | undefined) ?? config.marketLimit;
  const windowDays =
    (readArg("window-days") as number | undefined) ?? config.windowDays;
  const force = Boolean(readArg("force", false));
  const dryRun = Boolean(readArg("dry-run", false));
  const verbose = Boolean(readArg("verbose", false));
  const logEvery = Math.max(
    1,
    Math.trunc((readArg("log-every", 10) as number) || 10),
  );

  console.log("[whale-profile] start", {
    limit,
    marketLimit,
    windowDays,
    force,
    dryRun,
    verbose,
    logEvery,
    selectionMode: config.selectionMode,
    selectionRecentLimit: config.selectionRecentLimit,
    selectionPnlLimit: config.selectionPnlLimit,
    selectionSignalsLimit: config.selectionSignalsLimit,
    selectionSignalsWindowHours: config.selectionSignalsWindowHours,
    model: config.model,
  });

  const result = await runWhaleProfiles({
    limit,
    marketLimit,
    windowDays,
    force,
    dryRun,
    verbose,
    logEvery,
    policy: config,
  });

  console.log("[whale-profile] done", result);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[whale-profile] failed", error);
    process.exit(1);
  });
