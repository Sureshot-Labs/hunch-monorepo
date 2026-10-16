import { spawn } from "node:child_process";

// Use installed tools only. Turbo's strict mode would drop pnpm's no-fetch
// overrides in child tasks. No dependency install or lockfile update is run.
const child = spawn(
  process.execPath,
  ["node_modules/turbo/bin/turbo", "run", "build", "--env-mode=loose"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PNPM_CONFIG_PM_ON_FAIL: "ignore",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "warn",
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.once("error", () => {
  console.error(
    "Installed Turbo could not start; dependencies must already be installed.",
  );
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode = signal ? 130 : (code ?? 1);
});
