import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Opt-in isolation for fixtures that replace SDK prototypes or module singletons. */
export function runIsolatedTestFile(
  file: URL,
  options: { timeoutMs?: number; quiet?: boolean } = {},
): void {
  const extension = new URL(import.meta.url).pathname.endsWith(".ts")
    ? "ts"
    : "js";
  const result = spawnSync(
    process.execPath,
    [
      ...(!process.versions.bun && extension === "ts"
        ? ["--import", "tsx"]
        : []),
      fileURLToPath(
        new URL(`./test-process-entry.${extension}`, import.meta.url),
      ),
      file.href,
    ],
    {
      stdio: options.quiet ? "ignore" : "inherit",
      timeout: options.timeoutMs ?? 60_000,
    },
  );
  // Check signals explicitly: Bun can report status=0 for a killed child.
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0)
    throw new Error(
      `Isolated test ${fileURLToPath(file)} failed: signal=${result.signal ?? "none"}, status=${result.status}`,
    );
}
