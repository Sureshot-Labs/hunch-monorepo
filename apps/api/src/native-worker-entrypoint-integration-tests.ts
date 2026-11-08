// @requires-db
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import {
  createIntegrationTestPool,
  integrationDatabaseTargetFromEnv,
} from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const root = mkdtempSync(join(tmpdir(), "hunch-native-entrypoint-"));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const node = process.versions.bun ? "node" : process.execPath;
const environmentFile = join(root, "empty.env");
writeFileSync(environmentFile, "# no production secrets\n");
try {
  const authors = Array.from({ length: 4 }, () => randomUUID()),
    viewer = randomUUID();
  for (const [index, id] of [...authors, viewer].entries())
    await fixture.db.query("insert into users(id,handle) values($1,$2)", [
      id,
      `native-entrypoint-${index}`,
    ]);
  for (let index = 0; index < 4; index++) {
    const market = `kalshi:entrypoint-${index}`,
      token = `sol:entrypoint-${index}`;
    await fixture.db.query(
      "insert into unified_markets(id,venue,title,status,resolved_outcome) values($1,'kalshi','Synthetic entrypoint fixture',$2,$3)",
      [
        market,
        index === 3 ? "ACTIVE" : "SETTLED",
        index === 3 ? null : index === 1 ? "NO" : "YES",
      ],
    );
    await fixture.db.query(
      "insert into unified_tokens(token_id,market_id,side,venue) values($1,$2,'YES','kalshi')",
      [token, market],
    );
    await fixture.db.query(
      "insert into user_theses(author_id,market_id,token_id,instrument_generation) values($1,$2,$3,$4)",
      [authors[index], market, token, `solana:mainnet:${token}`],
    );
  }
  for (const mode of ["disabled", "invalid"] as const) {
    await fixture.db.query(
      "update social_trader_statistics set next_refresh_at=now(),computed_at=null",
    );
    const url = new URL(integrationDatabaseTargetFromEnv().databaseUrl);
    url.searchParams.set(
      "options",
      `-c search_path=${fixture.schema},public -c statement_timeout=10000`,
    );
    const healthPath = join(root, `${mode}.json`);
    const child = spawn(
      node,
      [
        "packages/config/dist/run-with-secrets.js",
        "apps/api/dist/native-push-worker.js",
      ],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: url.href,
          HUNCH_ENV_FILE: environmentFile,
          HUNCH_SECRETS_MODE: "off",
          HUNCH_SECRET_BUNDLES: "",
          HUNCH_APNS_DELIVERY_ENABLED: mode === "disabled" ? "false" : "true",
          APNS_KEY_ID: "TESTKEY123",
          APNS_TEAM_ID: "TESTTEAM12",
          APNS_PRIVATE_KEY: "DO_NOT_LOG_invalid_synthetic_key",
          HUNCH_NATIVE_ONBOARDING_HEALTH_FILE: healthPath,
          HUNCH_RPC_DIAGNOSTICS_ENABLED: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (value) => {
      logs = (logs + String(value)).slice(-65536);
    });
    child.stderr.on("data", (value) => {
      logs = (logs + String(value)).slice(-65536);
    });
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline && child.exitCode === null) {
        const computed = Number(
          (
            await fixture.db.query(
              "select count(*)::int as count from social_trader_statistics where computed_at is not null",
            )
          ).rows[0].count,
        );
        const ranks = Number(
          (
            await fixture.db.query(
              "select count(*)::int as count from social_trader_ranking_entries where snapshot_id=(select id from social_trader_ranking_snapshots order by created_at desc,id desc limit 1)",
            )
          ).rows[0].count,
        );
        const check = spawnSync(
          node,
          ["apps/api/dist/native-onboarding-health.js"],
          {
            cwd: repo,
            env: {
              PATH: process.env.PATH,
              HUNCH_NATIVE_ONBOARDING_HEALTH_FILE: healthPath,
            },
            encoding: "utf8",
            timeout: 3000,
          },
        );
        if (computed === 4 && ranks === 3 && check.status === 0) {
          ready = true;
          break;
        }
        await delay(100);
      }
      assert.ok(ready, `Real worker failed ${mode} startup/progress`);
      const suggestions = await new SocialService(fixture.db).listProfiles(
        viewer,
        { kind: "suggestions", limit: 10 },
      );
      assert.equal(suggestions.items.length, 4);
      assert.ok(suggestions.items.every((item) => item.statistics !== null));
      assert.ok(!/native_(?:statistics|push)_cycle_failed/.test(logs));
      assert.ok(!logs.includes("DO_NOT_LOG"));
      assert.ok(!authors.some((id) => logs.includes(id)));
      assert.equal(
        logs.includes("native_push_configuration_failed"),
        mode === "invalid",
      );
      const required = spawnSync(
        node,
        ["apps/api/dist/native-onboarding-health.js", "--require-delivery"],
        {
          cwd: repo,
          env: {
            PATH: process.env.PATH,
            HUNCH_NATIVE_ONBOARDING_HEALTH_FILE: healthPath,
          },
          encoding: "utf8",
          timeout: 3000,
        },
      );
      assert.equal(
        required.status,
        1,
        "Readiness must not silently claim Apple delivery is available",
      );
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        closed,
        delay(10000).then(() => ({ code: null, signal: "timeout" })),
      ]);
      assert.equal(stopped.code, 0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([closed, delay(3000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await closed;
        }
      }
    }
  }
  console.log(
    "native worker entrypoint PG16: DB-only secret bootstrap, statistics/suggestions/ranking under disabled and invalid APNs, read-only readiness and SIGTERM recovery passed; no Apple requests",
  );
} finally {
  await fixture.close();
  rmSync(root, { recursive: true, force: true });
}
