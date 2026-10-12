import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The shared runner imports suites in one process. Isolate module mocks,
// fixture environment and imported runtime modules from the other suites.
execFileSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--import",
    "tsx",
    fileURLToPath(new URL("./privy-native-auth-fixture.ts", import.meta.url)),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
    timeout: 60_000,
  },
);
