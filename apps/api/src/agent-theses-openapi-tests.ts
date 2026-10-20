import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Module-mock fixture runs in Node even when the surrounding pure suites use Bun.
execFileSync(
  "node",
  [
    "--experimental-test-module-mocks",
    "--import",
    "tsx",
    fileURLToPath(
      new URL("./agent-theses-openapi-fixture.ts", import.meta.url),
    ),
  ],
  { stdio: "inherit", timeout: 60000 },
);
