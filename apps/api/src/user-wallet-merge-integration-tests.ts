// @requires-db — disposable PG16; synthetic identities, no provider or signing IO.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { mergeUsersById } from "./admin-merge-user-core.js";
import { readHip4OrderController } from "./repos/hip4-order-controller.js";
import { assertFundingControllerWallet } from "./funding/execution/funding-controller-wallet-lock.js";
import {
  REPARENT_USER_WALLETS_SQL,
  USER_WALLET_MERGE_CONFLICT_SQL,
  WalletMergeConflictError,
} from "./repos/user-wallet-merge.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
const db = await pool.connect();
const newUser = async () =>
  (await db.query("insert into users(is_active) values(true) returning id"))
    .rows[0].id as string;
const address = () => `0x${randomUUID().replaceAll("-", "")}12345678`;
async function wallet(
  owner: string,
  suppliedAddress = address(),
  type = "ethereum",
  embedded = false,
) {
  return (
    await db.query(
      `insert into user_wallets(user_id,wallet_address,wallet_type,is_verified,is_primary,
    name,verification_signature,wallet_source,is_internal_wallet,privy_wallet_id,privy_profile_updated_at)
    values($1,$2,$3,true,true,'synthetic profile','synthetic verification',$4,$5,$6,clock_timestamp()) returning id`,
      [
        owner,
        suppliedAddress,
        type,
        embedded ? "embedded" : "external",
        embedded,
        embedded ? `synthetic-${randomUUID()}` : null,
      ],
    )
  ).rows[0].id as string;
}
async function credential(owner: string, walletId: string) {
  await db.query(
    `insert into user_venue_credentials(user_id,wallet_address,venue,api_key,api_secret)
    select user_id,wallet_address,'polymarket','synthetic-not-a-key','synthetic-not-a-secret' from user_wallets where id=$1 and user_id=$2`,
    [walletId, owner],
  );
}
const stableWallet = async (id: string) =>
  (
    await db.query(
      "select to_jsonb(wallet_row)-array['user_id','is_primary','updated_at'] as snapshot from user_wallets wallet_row where id=$1",
      [id],
    )
  ).rows[0]?.snapshot;

try {
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  for (const keepSource of [true, false]) {
    const source = await newUser(),
      target = await newUser();
    const owned = await wallet(source, address(), "ethereum", true);
    const additional = await wallet(source, `AbC${randomUUID()}`, "solana");
    await credential(source, owned);
    const targetPrimary = keepSource ? await wallet(target) : null;
    const before = await stableWallet(owned),
      additionalBefore = await stableWallet(additional);
    const profile = await readHip4OrderController(db, {
      userId: source,
      controllerWalletRef: owned,
    });
    const dry = await mergeUsersById(
      source,
      target,
      { dryRun: true, keepSource },
      pool,
    );
    assert.equal(dry.summary.walletsMoved, 2);
    assert.equal(dry.summary.venueCredsMoved, 1);
    await assertFundingControllerWallet(db, source, profile);
    assert.deepEqual(await stableWallet(owned), before);
    assert.equal(
      (
        await db.query(
          "select user_id from user_venue_credentials where user_id=$1",
          [source],
        )
      ).rowCount,
      1,
    );

    const merged = await mergeUsersById(
      source,
      target,
      { dryRun: false, keepSource },
      pool,
    );
    assert.equal(merged.summary.walletsMoved, 2);
    assert.equal(merged.summary.walletsInserted, 0);
    assert.equal(merged.summary.walletsDeleted, 0);
    assert.equal(merged.summary.venueCredsMoved, 1);
    assert.deepEqual(await stableWallet(owned), before);
    assert.deepEqual(await stableWallet(additional), additionalBefore);
    assert.deepEqual(
      await readHip4OrderController(db, {
        userId: target,
        controllerWalletRef: owned,
      }),
      profile,
    );
    await assertFundingControllerWallet(db, target, profile);
    await assert.rejects(
      () => assertFundingControllerWallet(db, source, profile),
      /controller wallet changed/u,
    );
    const primary = (
      await db.query(
        "select id from user_wallets where user_id=$1 and is_primary",
        [target],
      )
    ).rows;
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, targetPrimary ?? owned);
    const credentials = (
      await db.query(
        "select user_id,api_key,api_secret from user_venue_credentials where user_id=$1",
        [target],
      )
    ).rows;
    assert.deepEqual(credentials, [
      {
        user_id: target,
        api_key: "synthetic-not-a-key",
        api_secret: "synthetic-not-a-secret",
      },
    ]);
    assert.equal(
      (await db.query("select id from users where id=$1", [source])).rowCount,
      keepSource ? 1 : 0,
    );
  }

  const source = await newUser(),
    target = await newUser(),
    duplicate = address();
  const sourceWallet = await wallet(source, duplicate, "ethereum");
  const targetWallet = await wallet(target, duplicate, "polygon");
  await credential(source, sourceWallet);
  await credential(target, targetWallet);
  for (const dryRun of [true, false]) {
    await assert.rejects(
      () => mergeUsersById(source, target, { dryRun, keepSource: false }, pool),
      (error) => {
        assert.ok(error instanceof WalletMergeConflictError);
        assert.equal(error.conflict.source_wallet_id, sourceWallet);
        assert.equal(error.conflict.target_wallet_id, targetWallet);
        return true;
      },
    );
    assert.deepEqual(
      (
        await db.query(
          "select id,user_id from user_wallets where id=any($1::uuid[]) order by id",
          [[sourceWallet, targetWallet]],
        )
      ).rows,
      [
        { id: sourceWallet, user_id: source },
        { id: targetWallet, user_id: target },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    assert.equal(
      (
        await db.query(
          "select id from user_venue_credentials where user_id=any($1::uuid[])",
          [[source, target]],
        )
      ).rowCount,
      2,
    );
  }

  // Many unrelated rows, generic/custom sparse hit and empty tail. Mutating
  // EXPLAIN runs only on disposable temporary tables and rolls back each probe.
  await db.query("begin");
  await db.query(
    "create temp table user_wallets(like public.user_wallets including all) on commit drop",
  );
  await db.query(
    "create temp table user_venue_credentials(like public.user_venue_credentials including all) on commit drop",
  );
  await db.query(`insert into user_wallets(id,user_id,wallet_address,wallet_type)
    select md5('wallet-'||entry)::uuid,md5('owner-'||entry)::uuid,'0x'||md5('address-'||entry)||'12345678','ethereum' from generate_series(1,50000) entry`);
  await db.query(`insert into user_venue_credentials(user_id,wallet_address,venue,api_key,api_secret)
    select user_id,wallet_address,'polymarket','synthetic','synthetic' from user_wallets`);
  await db.query("analyze user_wallets; analyze user_venue_credentials");
  await db.query(
    `prepare wallet_merge_conflict(uuid,uuid) as ${USER_WALLET_MERGE_CONFLICT_SQL}`,
  );
  await db.query(
    `prepare wallet_merge_move(uuid,uuid) as ${REPARENT_USER_WALLETS_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const entry of [123, 50000, 50001]) {
      for (const query of ["wallet_merge_conflict", "wallet_merge_move"]) {
        await db.query("savepoint plan_probe");
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${query}(md5('owner-${entry}')::uuid,'${target}'::uuid)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const buffers =
          plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"];
        assert.ok(
          buffers < 200,
          "merge must use exact owner indexes, not unrelated wallets/credentials",
        );
        assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
        console.log("[wallet-merge-plan]", {
          mode,
          entry,
          query,
          ms: plan["Execution Time"],
          buffers,
        });
        await db.query("rollback to savepoint plan_probe");
      }
    }
  }
  await db.query("rollback");
  console.log(
    "[wallet-merge] actual merge/dry-run/collision rollback, stable profiles/controller identity and indexed PG16 plans passed",
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
