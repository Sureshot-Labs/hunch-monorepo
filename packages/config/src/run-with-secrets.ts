import { pathToFileURL } from "node:url";
import path from "node:path";

import { loadRuntimeSecrets } from "./secrets.js";

async function main(): Promise<void> {
  const [, , targetArg, ...targetArgs] = process.argv;
  if (!targetArg) {
    console.error(
      "Usage: node packages/config/dist/run-with-secrets.js <target-js> [args...]",
    );
    process.exit(1);
  }

  const envPath = process.env.HUNCH_ENV_FILE?.trim() || path.resolve(".env");
  await loadRuntimeSecrets({ envPath });

  const targetPath = path.isAbsolute(targetArg)
    ? targetArg
    : path.resolve(process.cwd(), targetArg);
  process.argv = [process.argv[0] ?? "node", targetPath, ...targetArgs];
  await import(pathToFileURL(targetPath).href);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
