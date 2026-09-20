import { stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const HEARTBEAT_PATH = "/tmp/hunch-market-matcher-heartbeat";
export const HEARTBEAT_MAX_AGE_MS = 120_000;

export async function markHealthy(path = HEARTBEAT_PATH): Promise<void> {
  await writeFile(path, String(Date.now()));
}

export async function isHealthy(
  path = HEARTBEAT_PATH,
  now = Date.now(),
): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(path);
    return mtimeMs <= now && now - mtimeMs < HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = (await isHealthy()) ? 0 : 1;
