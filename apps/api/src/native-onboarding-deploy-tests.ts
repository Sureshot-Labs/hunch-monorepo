import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

execFileSync(
  process.execPath,
  [
    fileURLToPath(
      new URL(
        "../../../ops/native-onboarding-deploy-tests.mjs",
        import.meta.url,
      ),
    ),
  ],
  { stdio: "inherit", timeout: 120_000 },
);
