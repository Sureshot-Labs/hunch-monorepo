import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = new URL(import.meta.url).pathname.endsWith(".ts")
  ? "ts"
  : "js";
const directory = await mkdtemp(join(tmpdir(), "hunch-erasure-replay-"));
try {
  const environmentFile = join(directory, "fixture.env");
  await writeFile(
    environmentFile,
    [
      // Deliberately conflicting with the explicit CLI URL, just like the
      // repository .env that caused the review reproduction.
      "DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/wrong_repository_db",
      "NODE_ENV=test",
      "JWT_SECRET=replay-fixture",
      "PRIVY_APP_ID=replay-fixture",
      "PRIVY_APP_SECRET=replay-fixture",
      "ACCOUNT_ERASURE_JOURNAL_BUCKET=replay-private-journal",
      "CONTENT_ASSET_S3_BUCKET=replay-public-assets",
      "CONTENT_ASSET_PUBLIC_BASE_URL=https://images.example.test",
      "CONTENT_ASSET_UPLOAD_TTL_SEC=120",
      "ACCOUNT_ERASURE_RESTORE_ISOLATED=true",
    ].join("\n"),
  );
  for (const scenario of [
    "apply-staging",
    "secret-bundle",
    "dry-run",
    "actual-database-mismatch",
    "url-database-mismatch",
    "missing-target",
    "missing-isolation",
    "invalid-journal",
  ]) {
    const output = execFileSync(
      process.execPath,
      [
        ...(!process.versions.bun && extension === "ts"
          ? ["--import", "tsx"]
          : []),
        fileURLToPath(
          new URL(
            `./account-erasure-replay-fixture.${extension}`,
            import.meta.url,
          ),
        ),
        scenario,
        environmentFile,
        new URL(`./account-erasure-replay.${extension}`, import.meta.url).href,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.ok(output.includes(`[replay-fixture] ${scenario} passed`));
  }
  console.log(
    `[account-erasure-replay] ${extension} CLI: 8 scenarios passed; explicit target, actual DB verification, dry run and real staging deletion`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
