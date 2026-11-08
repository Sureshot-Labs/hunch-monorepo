// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import { refreshSocialTraderStatistics } from "./services/social-trader-statistics.js";
import type { NativeStatisticsDiagnostics } from "./services/native-worker-diagnostics.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db } = fixture;
const good = randomUUID(),
  bad = randomUUID();
const original = SocialService.prototype.profileStatistics;
let failure: "profile" | "persist" | "retry_store" | null = "profile";
let summary: NativeStatisticsDiagnostics | undefined;
const report = (value: NativeStatisticsDiagnostics) => {
  summary = value;
};
const wrapped = {
  ...db,
  async query(sql: string, values: unknown[] = []) {
    if (
      values[0] === bad &&
      ((failure === "persist" && sql.includes("set policy_revision=$3")) ||
        (failure === "retry_store" &&
          sql.includes("next_refresh_at=now()+interval '1 minute'")))
    )
      throw Object.assign(Error("DO_NOT_LOG_wallet_or_prompt"), {
        code: "53200",
      });
    return db.query(sql, values);
  },
} as unknown as Pool;
try {
  await db.query(
    "insert into users(id,handle) values($1,'native-good'),($2,'native-bad')",
    [good, bad],
  );
  await db.query(
    "insert into social_trader_statistics(user_id,statistics) values($1,'{\"preserved\":true}'),($2,'{\"preserved\":true}')",
    [good, bad],
  );
  SocialService.prototype.profileStatistics = async function (userId, policy) {
    if (userId === bad && (failure === "profile" || failure === "retry_store"))
      throw Object.assign(Error("DO_NOT_LOG_wallet_or_prompt"), {
        code: "57014",
      });
    return original.call(this, userId, policy);
  };
  await refreshSocialTraderStatistics(wrapped, 50, report);
  assert.equal(summary?.claimed, 2);
  assert.equal(summary?.updated, 1);
  assert.equal(summary?.failed, 1);
  assert.equal(summary?.retryScheduled, 1);
  assert.ok(
    summary?.errors.some(
      (error) => error.stage === "profile" && error.code === "57014",
    ),
  );
  assert.equal(
    (
      await db.query(
        "select statistics->>'preserved' as value from social_trader_statistics where user_id=$1",
        [bad],
      )
    ).rows[0].value,
    "true",
  );
  assert.ok(!JSON.stringify(summary).includes(bad));
  assert.ok(!JSON.stringify(summary).includes("DO_NOT_LOG"));
  for (const nextFailure of ["persist", "retry_store"] as const) {
    failure = nextFailure;
    await db.query(
      "update social_trader_statistics set next_refresh_at=now() where user_id=any($1::uuid[])",
      [[good, bad]],
    );
    await refreshSocialTraderStatistics(wrapped, 50, report);
    assert.equal(summary?.updated, 1);
    assert.equal(summary?.failed, 1);
    assert.equal(summary?.completed, true);
    if (failure === "persist")
      assert.ok(
        summary?.errors.some(
          (error) => error.stage === "persist" && error.code === "53200",
        ),
      );
    else {
      assert.equal(summary?.retryStoreFailed, 1);
      assert.ok(summary?.errors.some((error) => error.stage === "retry_store"));
      assert.equal(
        (
          await db.query(
            "select lease_until>now() as leased from social_trader_statistics where user_id=$1",
            [bad],
          )
        ).rows[0].leased,
        true,
      );
    }
  }
  failure = null;
  await db.query(
    "update social_trader_statistics set next_refresh_at=now(),lease_until=now()-interval '1 second' where user_id=any($1::uuid[])",
    [[good, bad]],
  );
  await refreshSocialTraderStatistics(wrapped, 50, report);
  assert.equal(summary?.updated, 2);
  assert.equal(summary?.failed, 0);
  await db.query(
    "update social_trader_statistics set next_refresh_at=now() where user_id=$1",
    [good],
  );
  await assert.doesNotReject(
    refreshSocialTraderStatistics(wrapped, 50, () => {
      throw Error("diagnostic sink unavailable");
    }),
  );
  const failing = {
    ...db,
    async connect() {
      const client = await db.connect();
      return {
        async query(sql: string, values: unknown[] = []) {
          if (
            sql.includes(
              "select id,user_id from social_trader_statistics_pending",
            )
          )
            throw Object.assign(Error("private SQL"), { code: "57014" });
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  await assert.rejects(refreshSocialTraderStatistics(failing, 50, report));
  assert.equal(summary?.completed, false);
  assert.ok(summary?.errors.some((error) => error.stage === "pending_drain"));
  console.log(
    "native statistics diagnostics PG16: partial failures, persisted retry, retry-store failure isolation, cache preservation, recovery and safe error codes passed",
  );
} finally {
  SocialService.prototype.profileStatistics = original;
  await fixture.close();
}
