import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep module mocks and fake credentials out of the shared test-runner process.
execFileSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--import",
    "tsx",
    fileURLToPath(new URL("./onboarding-route-fixture.ts", import.meta.url)),
  ],
  { stdio: "inherit", timeout: 60_000 },
);
