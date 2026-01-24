import { env } from "./env.js";
import { runWhaleProfiles } from "./services/whale-profiles.js";

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
  const limit =
    (readArg("limit") as number | undefined) ?? env.aiWhaleProfileLimit;
  const marketLimit =
    (readArg("market-limit") as number | undefined) ??
    env.aiWhaleProfileMarketLimit;
  const windowDays =
    (readArg("window-days") as number | undefined) ??
    env.aiWhaleProfileWindowDays;
  const force = Boolean(readArg("force", false));
  const dryRun = Boolean(readArg("dry-run", false));

  console.log("[whale-profile] start", {
    limit,
    marketLimit,
    windowDays,
    force,
    dryRun,
    model: env.aiWhaleProfileModel,
  });

  const result = await runWhaleProfiles({
    limit,
    marketLimit,
    windowDays,
    force,
    dryRun,
  });

  console.log("[whale-profile] done", result);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[whale-profile] failed", error);
    process.exit(1);
  });
