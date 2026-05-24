import { buildSecretBundles } from "./secrets.js";

type CliOptions = {
  envPath?: string;
  outDir?: string;
  profile?: string;
  dryRun: boolean;
  force: boolean;
  awsCliCommands: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    force: false,
    awsCliCommands: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--env":
        options.envPath = argv[++i];
        break;
      case "--out":
        options.outDir = argv[++i];
        break;
      case "--profile":
        options.profile = argv[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--aws-cli-commands":
        options.awsCliCommands = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.envPath) throw new Error("Missing --env <path>");
  if (!options.outDir) throw new Error("Missing --out <dir>");
  return options;
}

function usage(): string {
  return [
    "Usage:",
    "  node packages/config/dist/build-secret-bundles.js --env /opt/hunch/.env --out /tmp/hunch-secret-bundles [--profile prod] [--dry-run] [--force] [--aws-cli-commands]",
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const { envPath, outDir } = options;
  if (!envPath) throw new Error("Missing --env <path>");
  if (!outDir) throw new Error("Missing --out <dir>");
  const result = buildSecretBundles({
    envPath,
    outDir,
    profile: options.profile,
    dryRun: options.dryRun,
    force: options.force,
    awsCliCommands: options.awsCliCommands,
  });
  if (!options.dryRun) {
    console.info(
      `[secrets] wrote bundles: ${Object.keys(result.bundles).join(", ")}`,
    );
    console.info(`[secrets] wrote sanitized env: ${result.sanitizedEnvPath}`);
    if (options.awsCliCommands) {
      console.info("[secrets] wrote aws-cli-commands.txt");
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
}
