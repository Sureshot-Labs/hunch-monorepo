import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const [scenario, environmentFile, entry] = process.argv.slice(2);
const expectedDatabase = "isolated_restore_target";
const databaseUrl = `postgres://fixture:fixture@127.0.0.1:1/${expectedDatabase}`;
const userId = "10000000-0000-4000-8000-000000000001";
const stagingKey = "content-staging/restored-avatar.jpg";
const publicKey = "content/restored-avatar.jpg";
const events: string[] = [];
const enqueued: { key: string; availableAt: Date }[] = [];
const started = Date.now();

Object.assign(process.env, {
  DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/ambient_wrong_db",
  ACCOUNT_ERASURE_RESTORE_ISOLATED:
    scenario === "missing-isolation" ? "false" : "true",
});
process.argv = [
  process.execPath,
  fileURLToPath(entry),
  "--env-file",
  environmentFile,
  ...(scenario === "missing-target"
    ? []
    : [
        "--database-url",
        databaseUrl,
        "--expect-database",
        scenario === "url-database-mismatch"
          ? "other_restore"
          : expectedDatabase,
      ]),
  ...(scenario === "dry-run" ? [] : ["--apply"]),
];
globalThis.fetch = async () => {
  throw new Error("Network forbidden in replay fixture");
};

function checkTarget(pool: Pool): void {
  assert.equal(
    (pool as unknown as { options: { connectionString: string } }).options
      .connectionString,
    databaseUrl,
    "dotenv must not redirect the actual pool to the ambient/repository DB",
  );
}
async function query(sql: string, values: unknown[] = []) {
  const normalized = sql.trim().replace(/\s+/gu, " ").toLowerCase();
  if (normalized === "select current_database() as current_database") {
    events.push("verify");
    return {
      rows: [
        {
          current_database:
            scenario === "actual-database-mismatch"
              ? "wrong_live_db"
              : expectedDatabase,
        },
      ],
    };
  }
  assert.ok(
    events.includes("verify"),
    "verify identity before transaction queries",
  );
  assert.notEqual(scenario, "actual-database-mismatch");
  if (
    normalized === "begin" ||
    normalized === "commit" ||
    normalized === "rollback"
  ) {
    events.push(normalized);
    return { rows: [] };
  }
  if (normalized.startsWith("select id, privy_user_id from users"))
    return { rows: [{ id: userId, privy_user_id: null }] };
  if (normalized.includes("as active_funding_movement"))
    return { rows: [{ preparation_run_count: "0" }] };
  if (
    normalized.startsWith("select id,storage_key,metadata from content_assets")
  )
    return {
      rows: [
        {
          id: "restored-asset",
          storage_key: stagingKey,
          metadata: { verificationTargetKey: publicKey },
        },
      ],
    };
  if (normalized.startsWith("insert into content_storage_deletion_jobs")) {
    enqueued.push({ key: String(values[0]), availableAt: values[1] as Date });
    return { rows: [] };
  }
  if (normalized === "delete from users where id = $1")
    events.push("erase-user");
  // Existing financial/social SQL is exercised through the real AuthService;
  // these fixture boundaries supply an account with no financial evidence.
  if (/^(select|delete|update)/u.test(normalized)) return { rows: [] };
  throw new Error("Unexpected replay SQL");
}
const originalQuery = Pool.prototype.query;
const originalConnect = Pool.prototype.connect;
const originalEnd = Pool.prototype.end;
const originalSend = S3Client.prototype.send;
Pool.prototype.query = async function (
  this: Pool,
  sql: string,
  values?: unknown[],
) {
  checkTarget(this);
  return query(sql, values);
} as typeof Pool.prototype.query;
Pool.prototype.connect = async function (this: Pool) {
  checkTarget(this);
  return { query, release() {} };
} as typeof Pool.prototype.connect;
Pool.prototype.end = async function (this: Pool) {
  events.push("close");
  await Reflect.apply(originalEnd, this, []);
} as typeof Pool.prototype.end;
S3Client.prototype.send = (async (command: unknown) => {
  assert.equal(
    events[0],
    "verify",
    "verify the connected DB before reading the journal",
  );
  if (command instanceof ListObjectsV2Command) {
    events.push("list");
    assert.equal(command.input.Bucket, "replay-private-journal");
    return {
      Contents: [{ Key: `account-erasure/v1/${userId}.json`, Size: 150 }],
    };
  }
  assert.ok(command instanceof GetObjectCommand);
  events.push("get");
  return {
    Body: {
      transformToString: async () =>
        JSON.stringify({
          schemaVersion: 1,
          userId:
            scenario === "invalid-journal"
              ? "20000000-0000-4000-8000-000000000002"
              : userId,
          requestedAt: "2026-10-23T10:00:00.000Z",
        }),
    },
  };
}) as typeof S3Client.prototype.send;

const expectedErrors: Record<string, RegExp> = {
  "actual-database-mismatch": /Connected replay database does not match/,
  "url-database-mismatch": /Replay database URL does not match/,
  "missing-target": /Replay requires --database-url and --expect-database/,
  "missing-isolation": /Keep restored database isolated/,
  "invalid-journal": /Journal identity mismatch/,
};
try {
  if (expectedErrors[scenario]) {
    await assert.rejects(import(entry), expectedErrors[scenario]);
    assert.equal(events.includes("begin"), false);
    assert.equal(enqueued.length, 0);
    if (scenario !== "invalid-journal") {
      assert.equal(events.includes("list"), false);
      assert.equal(events.includes("get"), false);
    }
    if (scenario === "actual-database-mismatch")
      assert.deepEqual(events, ["verify", "close"]);
  } else {
    await import(entry);
    assert.equal(events.at(-1), "close");
    if (scenario === "dry-run") {
      assert.deepEqual(events, ["verify", "list", "get", "close"]);
      assert.equal(enqueued.length, 0);
    } else {
      assert.deepEqual(events, [
        "verify",
        "list",
        "get",
        "begin",
        "erase-user",
        "commit",
        "close",
      ]);
      assert.deepEqual(
        enqueued.map((item) => item.key),
        [stagingKey, publicKey],
      );
      assert.ok(enqueued[0].availableAt.getTime() >= started + 180_000);
      assert.ok(enqueued[0].availableAt.getTime() <= Date.now() + 180_000);
      assert.ok(enqueued[1].availableAt.getTime() <= Date.now());
    }
  }
} finally {
  Pool.prototype.query = originalQuery;
  Pool.prototype.connect = originalConnect;
  Pool.prototype.end = originalEnd;
  S3Client.prototype.send = originalSend;
}
console.log(`[replay-fixture] ${scenario} passed`);
