import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
execFileSync(
  process.execPath,
  [
    ...(process.versions.bun
      ? []
      : ["--experimental-test-module-mocks", "--import", "tsx"]),
    fileURLToPath(
      new URL("./feed-singleflight-route-fixture.ts", import.meta.url),
    ),
  ],
  { stdio: "inherit", timeout: 60_000 },
);
