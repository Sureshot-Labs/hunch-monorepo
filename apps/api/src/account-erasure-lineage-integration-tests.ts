// @requires-db
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createIntegrationTestPool } from "./test-database-target.js";
import { AuthService } from "./auth.js";
import { mergeUsersById } from "./admin-merge-user-core.js";
import { journalAccountErasureLineage } from "./services/account-erasure-lineage.js";
import {
  erasureRecordSchema,
  type ErasureRecord,
} from "./services/account-erasure-journal.js";

const db = await createIntegrationTestPool({ max: 4 });
const directory = await mkdtemp(join(tmpdir(), "hunch-lineage-regression-"));
const originalSend = S3Client.prototype.send;
const records: ErasureRecord[] = [];
S3Client.prototype.send = (async (command: unknown) => {
  assert.ok(command instanceof PutObjectCommand);
  records.push(
    erasureRecordSchema.parse(JSON.parse(String(command.input.Body))),
  );
  return {};
}) as typeof S3Client.prototype.send;
process.env.ACCOUNT_ERASURE_JOURNAL_BUCKET = "fixture-private-journal";
process.env.CONTENT_ASSET_S3_BUCKET = "fixture-public-assets";
process.env.CONTENT_ASSET_PUBLIC_BASE_URL = "https://images.example.test";
const pgBin =
  process.env.HUNCH_TEST_PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const originalURL =
  process.env.DATABASE_URL ??
  assert.fail("Explicit disposable DATABASE_URL required");
const users: string[] = [];
const assets: string[] = [];
try {
  for (const keepSource of [false, true]) {
    records.length = 0;
    const source = randomUUID(),
      target = randomUUID(),
      asset = randomUUID();
    users.push(source, target);
    assets.push(asset);
    await db.query(
      "insert into users(id,bio) values($1,'Before merge'),($2,null)",
      [source, target],
    );
    await db.query(
      `insert into content_assets(id,owner_user_id,status,kind,storage_key,original_filename,mime_type,metadata,public_url,byte_size,checksum_sha256,ready_at)
      values($1,$2,'ready','image',$3,'fixture.png','image/png','{}','https://images.example.test/'||$3,100,repeat('a',64),now())`,
      [asset, source, `content/lineage-${asset}.png`],
    );
    const snapshots = [
      join(directory, `before-${keepSource}.dump`),
      join(directory, `after-${keepSource}.dump`),
    ];
    execFileSync(
      join(pgBin, "pg_dump"),
      [
        "--dbname=" + originalURL,
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file=" + snapshots[0],
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    await mergeUsersById(source, target, { dryRun: false, keepSource }, db);
    if (keepSource)
      await db.query(
        "update users set bio='New source data after merge' where id=$1",
        [source],
      );
    execFileSync(
      join(pgBin, "pg_dump"),
      [
        "--dbname=" + originalURL,
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file=" + snapshots[1],
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    await AuthService.deleteUser(target, undefined, {
      beforeErasure: journalAccountErasureLineage,
    });
    assert.equal(records.length, 2);
    const journal = join(directory, "records.json");
    await writeFile(journal, JSON.stringify(records));
    for (const [index, snapshot] of snapshots.entries()) {
      const name = "hunch_lineage_restore_" + randomUUID().replaceAll("-", "");
      const restoredURL = new URL(originalURL);
      restoredURL.pathname = "/" + name;
      let restored: Pool | undefined;
      try {
        await db.query(`create database ${name}`);
        execFileSync(
          join(pgBin, "pg_restore"),
          [
            "--dbname=" + restoredURL.href,
            "--no-owner",
            "--no-acl",
            "--exit-on-error",
            snapshot,
          ],
          { timeout: 60_000, stdio: "pipe" },
        );
        const output = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            new URL(
              `./account-erasure-lineage-replay-child.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
              import.meta.url,
            ).pathname,
            journal,
            restoredURL.href,
            name,
          ],
          { timeout: 60_000, encoding: "utf8", env: { ...process.env } },
        );
        assert.match(output, /"checked":2/);
        restored = new Pool({ connectionString: restoredURL.href, max: 1 });
        const sourceRow = (
          await restored.query("select bio from users where id=$1", [source])
        ).rows[0];
        if (index === 1 && keepSource)
          assert.equal(sourceRow.bio, "New source data after merge");
        else assert.equal(sourceRow, undefined);
        assert.equal(
          (await restored.query("select id from users where id=$1", [target]))
            .rows.length,
          0,
        );
        assert.equal(
          (
            await restored.query(
              "select status from content_assets where id=$1",
              [asset],
            )
          ).rows[0].status,
          "deleted",
        );
      } finally {
        await restored?.end();
        await db.query(`drop database if exists ${name} with (force)`);
      }
    }
  }
  // A request authenticated before a hard merge resolves the actual current owner.
  const source = randomUUID(),
    target = randomUUID();
  users.push(source, target);
  await db.query("insert into users(id,bio) values($1,'Moved'),($2,null)", [
    source,
    target,
  ]);
  await mergeUsersById(
    source,
    target,
    { dryRun: false, keepSource: false },
    db,
  );
  await AuthService.deleteUser(source, undefined, {
    resolveMergedIdentity: true,
    beforeErasure: journalAccountErasureLineage,
  });
  assert.equal(
    (
      await db.query("select id from users where id=any($1::uuid[])", [
        [source, target],
      ])
    ).rows.length,
    0,
  );
  console.log(
    "[account-erasure-lineage] actual pre/post-merge pg_dump/pg_restore and CLI, keepSource new data, stale authenticated identity passed",
  );
} finally {
  S3Client.prototype.send = originalSend;
  await db.query("delete from content_assets where id=any($1::uuid[])", [
    assets,
  ]);
  await db.query("delete from users where id=any($1::uuid[])", [users]);
  await db.query(
    "delete from account_erasure_aliases where transfer_id in(select id from account_merge_transfers where source_user_id=any($1::uuid[]))",
    [users],
  );
  await db.query(
    "delete from account_merge_transfers where source_user_id=any($1::uuid[])",
    [users],
  );
  await db.end();
  await rm(directory, { recursive: true, force: true });
}
