import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { mergeUsersById } from "../../admin-merge-user-core.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  FundingClassificationChangedError,
  lockFundingClassificationOperations,
  readFundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import { lockFundingReceiveCanonicalEvents } from "../persistence/funding-receive-session-repository.js";
import {
  FUNDING_ROLE_MEMBERSHIP_OWNER_SQL,
  RESTART_MERGED_FUNDING_ROLE_MEMBERSHIP_SQL,
} from "../persistence/funding-role-membership-lifecycle.js";
import {
  advanceSessionlessFundingRoleScan,
  checkpointSessionlessFundingRoleArbitrationInTransaction,
  lockSessionlessFundingRoleMembershipForPublication,
  readSessionlessFundingRoleArbitrationInTransaction,
} from "../receive/receive-refund-scan.js";
import { cancelFundingOperationForUser } from "../reconciliation/funding-operation-cancellation.js";
import {
  sessionlessCancellableSourceSteps,
  type verifySessionlessMergeAdoptionPg,
} from "./sessionless-role-checkpoint-pg.js";

type Factory = Parameters<typeof verifySessionlessMergeAdoptionPg>[1];
type Fixture = Awaited<ReturnType<Factory>>;

function scanInput(data: Fixture) {
  const raw = data.evm[0];
  assert.ok(raw.ledgerHeight && raw.blockHash);
  return {
    operationId: data.base.operationId,
    userId: data.base.source.accountId,
    event: {
      ...raw,
      ledgerHeight: raw.ledgerHeight,
      blockHash: raw.blockHash,
      now: data.base.now,
    },
    progressToken: randomUUID(),
    limit: 50,
    referenceCodec: data.base.referenceCodec,
    transactionReferenceCodec: createFundingTransactionReferenceCodec({
      encryptionKey: Buffer.alloc(32, 19),
      lookupHmacKey: "offline-membership-lifecycle-key-32chars",
      keyVersion: 1,
    }),
  };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("membership race did not reach its actual lock")),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function hookPool(
  pool: Pool,
  hook: (
    sql: string,
    client: PoolClient,
    phase: "before" | "after",
  ) => Promise<void>,
): Pool {
  const wrapped = Object.create(pool) as Pool;
  wrapped.query = pool.query.bind(pool);
  wrapped.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            await hook(sql, target, "before");
            const result = await target.query(sql, values);
            await hook(sql, target, "after");
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;
  }) as Pool["connect"];
  return wrapped;
}

async function cancelledMergeInputs(pool: Pool, fixture: Factory) {
  const anchor = await fixture(
    undefined,
    undefined,
    sessionlessCancellableSourceSteps,
  );
  const userId = anchor.base.source.accountId;
  const sourceId = (
    await pool.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`role-membership-${randomUUID()}@example.com`],
    )
  ).rows[0].id as string;
  const imported = await fixture(
    { userId: sourceId, owner: anchor.owner },
    undefined,
    sessionlessCancellableSourceSteps,
  );
  for (const data of [anchor, imported]) {
    const cancelled = await cancelFundingOperationForUser(pool, {
      userId: data.base.source.accountId,
      operationId: data.base.operationId,
    });
    assert.equal(cancelled.status, "cancelled");
  }
  return {
    anchor,
    imported,
    userId,
    sourceId,
    input: scanInput(anchor),
    sourceInput: scanInput(imported),
  };
}

async function readySummary(pool: Pool, input: ReturnType<typeof scanInput>) {
  let result = await tx(pool, (db) =>
    readSessionlessFundingRoleArbitrationInTransaction(db, input),
  );
  for (let tick = 0; result.kind === "incomplete" && tick < 40; tick++) {
    const next = { ...input, progressToken: randomUUID() };
    await advanceSessionlessFundingRoleScan(pool, next);
    await tx(pool, (db) =>
      checkpointSessionlessFundingRoleArbitrationInTransaction(db, next),
    );
    result = await tx(pool, (db) =>
      readSessionlessFundingRoleArbitrationInTransaction(db, next),
    );
  }
  assert.equal(result.kind, "ready_for_fence", JSON.stringify(result));
  if (result.kind !== "ready_for_fence")
    throw Error("missing current summaries");
  return result;
}

async function clearMembershipEvents(
  pool: Pool,
  inputs: ReturnType<typeof scanInput>[],
) {
  await tx(pool, async (db) => {
    const eventIds = (
      await db.query(
        "select id from funding_receive_canonical_events where network_id=$1 and tx_hash=any($2::text[])",
        [
          inputs[0].event.networkId,
          inputs.map((input) => input.event.transactionHash),
        ],
      )
    ).rows.map((row) => row.id);
    await db.query(
      "delete from funding_receive_refund_candidates where event_id=any($1::uuid[])",
      [eventIds],
    );
    await db.query(
      "delete from funding_receive_refund_scans where event_id=any($1::uuid[])",
      [eventIds],
    );
    // Keep append-only physical events, like the rest of the concurrency
    // suite. Only their derived checkpoint work is disposable here.
  });
}

/** Actual terminal operation cancellation, central user merge and shared page
 * adapter. These test the lifecycle seam, NOT activated reciprocal financial
 * publication. No provider read, signature, transfer or financial effect. */
export async function verifySessionlessMembershipLifecyclePg(
  pool: Pool,
  fixture: Factory,
) {
  for (const existingHeader of [false, true]) {
    for (const mergeFirst of [false, true]) {
      const { anchor, imported, userId, sourceId, input, sourceInput } =
        await cancelledMergeInputs(pool, fixture);
      const header = async (hash = input.event.transactionHash) =>
        (
          await pool.query(
            `select scan_row.* from funding_receive_refund_scans scan_row
        join funding_receive_canonical_events event_row on event_row.id=scan_row.event_id
        where event_row.network_id=$1 and event_row.tx_hash=$2 and event_row.event_index=$3`,
            [input.event.networkId, hash, input.event.eventIndex],
          )
        ).rows[0];
      if (existingHeader) {
        await advanceSessionlessFundingRoleScan(pool, input);
        await advanceSessionlessFundingRoleScan(pool, sourceInput);
        assert.equal((await header()).source_exhausted, true);
        const beforeMerge = await readySummary(pool, input);
        assert.deepEqual(
          beforeMerge.dependencies.map((facts) => facts.operationId),
          [input.operationId],
        );
      }
      if (existingHeader && mergeFirst) {
        const beforeDryRun = [
          await header(),
          await header(sourceInput.event.transactionHash),
        ];
        await mergeUsersById(
          sourceId,
          userId,
          { dryRun: true, keepSource: false },
          pool,
        );
        assert.deepEqual(
          [await header(), await header(sourceInput.event.transactionHash)],
          beforeDryRun,
        );
        assert.equal(
          (
            await pool.query(
              "select user_id from funding_operations where id=$1",
              [imported.base.operationId],
            )
          ).rows[0].user_id,
          sourceId,
        );
      }
      const candidateIds = existingHeader
        ? (
            await pool.query(
              "select candidate_id from funding_receive_refund_candidates where event_id=$1 order by candidate_id",
              [(await header()).event_id],
            )
          ).rows.map((row) => row.candidate_id)
        : [];
      const held = latch(),
        resume = latch(),
        mergeEntered = latch();
      let holderPid = 0,
        mergePid = 0;
      const mergeDb = hookPool(pool, async (sql, db, phase) => {
        if (!/select id\s+from users\s+where id = any/u.test(sql)) return;
        if (phase === "before") {
          mergePid = (await db.query("select pg_backend_pid() as pid")).rows[0]
            .pid;
          mergeEntered.release();
        }
        if (phase === "after" && mergeFirst) {
          held.release();
          await resume.promise;
        }
      });
      const pageDb = hookPool(pool, async (sql, db, phase) => {
        if (
          !mergeFirst &&
          phase === "after" &&
          sql.includes("for key share nowait")
        ) {
          holderPid = (await db.query("select pg_backend_pid() as pid")).rows[0]
            .pid;
          held.release();
          await resume.promise;
        }
      });
      let mergeRun: ReturnType<typeof mergeUsersById> | undefined;
      let pageRun:
        | ReturnType<typeof advanceSessionlessFundingRoleScan>
        | undefined;
      // Both keepSource variants must invalidate membership: operations move
      // irrespective of source profile retention.
      const keepSource = existingHeader;
      try {
        if (mergeFirst)
          mergeRun = mergeUsersById(
            sourceId,
            userId,
            { dryRun: false, keepSource },
            mergeDb,
          );
        else
          pageRun = advanceSessionlessFundingRoleScan(pageDb, {
            ...input,
            progressToken: randomUUID(),
          });
        await bounded(held.promise);
        if (mergeFirst) {
          assert.deepEqual(
            await advanceSessionlessFundingRoleScan(pool, input),
            { kind: "unavailable" },
          );
          if (existingHeader) {
            // Actual all-E/sorted-O late fence must roll back on the real
            // merger's U lock, not wait while merge later requests O.
            await assert.rejects(
              tx(pool, async (db) => {
                await lockFundingReceiveCanonicalEvents(db, [input.event]);
                const facts = await readFundingClassificationRevision(
                  db,
                  input,
                );
                assert.ok(facts);
                await lockFundingClassificationOperations(db, [facts]);
                await lockSessionlessFundingRoleMembershipForPublication(
                  db,
                  input,
                );
              }),
              FundingClassificationChangedError,
            );
          }
        } else {
          mergeRun = mergeUsersById(
            sourceId,
            userId,
            { dryRun: false, keepSource },
            mergeDb,
          );
          await bounded(mergeEntered.promise);
          let blocked = false;
          for (let probe = 0; probe < 400; probe++) {
            blocked = (
              await pool.query(
                "select $2::int=any(pg_blocking_pids($1::int)) as blocked",
                [mergePid, holderPid],
              )
            ).rows[0].blocked;
            if (blocked) break;
            await delay(10);
          }
          assert.equal(
            blocked,
            true,
            "real central merge must wait on the page's lifecycle fence",
          );
          await tx(pool, async (db) => {
            assert.equal(
              (
                await db.query(
                  "select id from funding_operations where id=$1 for update nowait",
                  [input.operationId],
                )
              ).rowCount,
              1,
            );
          });
        }
      } finally {
        resume.release();
        await Promise.allSettled([mergeRun, pageRun]);
      }
      assert.ok(mergeRun);
      assert.equal((await mergeRun).summary.fundingOperationsMoved, 1);
      if (pageRun) assert.notEqual((await pageRun).kind, "unavailable");
      const reset = await header();
      if (existingHeader || !mergeFirst) {
        assert.equal(reset.user_id, userId);
        assert.equal(reset.source_exhausted, false);
        assert.equal(reset.last_lease_token, null);
      }
      if (existingHeader) {
        const reparented = await header(sourceInput.event.transactionHash);
        assert.equal(reparented.user_id, userId);
        assert.equal(reparented.source_exhausted, false);
        assert.equal(reparented.last_lease_token, null);
        const preserved = (
          await pool.query(
            "select candidate_id from funding_receive_refund_candidates where event_id=$1",
            [reset.event_id],
          )
        ).rows.map((row) => row.candidate_id);
        assert.ok(candidateIds.every((id) => preserved.includes(id)));
      }
      // No receive adoption or forced version downgrade: the same ordinary
      // work token after merge must enumerate the newly imported old source.
      assert.notEqual(
        (await advanceSessionlessFundingRoleScan(pool, input)).kind,
        "replayed",
      );
      const arbitration = await readySummary(pool, input);
      assert.deepEqual(
        arbitration.dependencies.map((facts) => facts.operationId).sort(),
        [anchor.base.operationId, imported.base.operationId].sort(),
      );
      await tx(pool, async (db) => {
        await lockFundingReceiveCanonicalEvents(db, [input.event]);
        await lockFundingClassificationOperations(db, arbitration.dependencies);
        await lockSessionlessFundingRoleMembershipForPublication(db, input);
      });
      await assert.rejects(
        tx(pool, async (db) => {
          await db.query("set transaction isolation level repeatable read");
          await lockSessionlessFundingRoleMembershipForPublication(db, input);
        }),
        FundingClassificationChangedError,
      );
      await clearMembershipEvents(pool, [input, sourceInput]);
      console.log(
        `PASS real sessionless membership ${existingHeader ? "existing" : "absent"} header / ${mergeFirst ? "merge" : "page"} first / keepSource=${keepSource}: NOWAIT retry, preserved dependencies, ordinary convergence`,
      );
    }
  }
  {
    // Distinct race: merge COMMIT happens AFTER a real ready read while E is
    // still held, BEFORE O/U. U is free when acquired, so only the fresh header
    // reread can reject this omitted-source negative set.
    const { imported, userId, sourceId, input, sourceInput } =
      await cancelledMergeInputs(pool, fixture);
    await readySummary(pool, input);
    const publisher = await pool.connect();
    try {
      await publisher.query("begin isolation level read committed");
      await lockFundingReceiveCanonicalEvents(publisher, [input.event]);
      const beforeMerge =
        await readSessionlessFundingRoleArbitrationInTransaction(
          publisher,
          input,
        );
      assert.equal(beforeMerge.kind, "ready_for_fence");
      if (beforeMerge.kind !== "ready_for_fence")
        throw Error("ready read missing");
      assert.deepEqual(
        beforeMerge.dependencies.map((facts) => facts.operationId),
        [input.operationId],
      );
      await mergeUsersById(
        sourceId,
        userId,
        { dryRun: false, keepSource: false },
        pool,
      );
      await lockFundingClassificationOperations(
        publisher,
        beforeMerge.dependencies,
      );
      await assert.rejects(
        lockSessionlessFundingRoleMembershipForPublication(publisher, input),
        FundingClassificationChangedError,
      );
    } finally {
      await publisher.query("rollback");
      publisher.release();
    }
    const repaired = await readySummary(pool, input);
    assert.deepEqual(
      repaired.dependencies.map((facts) => facts.operationId).sort(),
      [input.operationId, imported.base.operationId].sort(),
    );
    await clearMembershipEvents(pool, [input, sourceInput]);
    console.log(
      "PASS sessionless pure ready read -> actual merge COMMIT while E held -> late owner/header fence rejects -> ordinary bounded recovery",
    );
  }
  await tx(pool, async (db) => {
    // Representative isolated relations, never production-shaped workload
    // INSERTs into public tables. Exercise the exact SQL and generic plans.
    await db.query(
      `create temporary table users(id uuid primary key) on commit drop`,
    );
    await db.query(
      `insert into users select md5('membership-owner-'||ordinal)::uuid from generate_series(1,50000) ordinal`,
    );
    await db.query(`create temporary table funding_receive_refund_scans
      (like public.funding_receive_refund_scans including all) on commit drop`);
    await db.query(`insert into funding_receive_refund_scans
      (event_id,contract_version,user_id,source_exhausted,last_lease_token)
      select md5('membership-event-'||ordinal)::uuid,4,
        md5('membership-owner-'||ordinal)::uuid,true,gen_random_uuid()
      from generate_series(1,50000) ordinal`);
    await db.query("analyze users");
    await db.query("analyze funding_receive_refund_scans");
    const metrics: unknown[] = [];
    const source = (
      await db.query("select md5('membership-owner-1')::uuid as id")
    ).rows[0].id;
    const target = (
      await db.query("select md5('membership-owner-2')::uuid as id")
    ).rows[0].id;
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare membership_owner_gate(uuid) as ${FUNDING_ROLE_MEMBERSHIP_OWNER_SQL}`,
      );
      await db.query(
        `prepare membership_reset(uuid[],uuid) as ${RESTART_MERGED_FUNDING_ROLE_MEMBERSHIP_SQL}`,
      );
      for (const missing of [false, true]) {
        for (const kind of ["owner", "reset"] as const) {
          await db.query("savepoint membership_plan");
          const id = missing ? randomUUID() : source;
          const plan = (
            await db.query(
              `explain(analyze,buffers,format json) execute ${kind === "owner" ? `membership_owner_gate('${id}')` : `membership_reset(array['${id}','${missing ? randomUUID() : target}']::uuid[],'${target}')`}`,
            )
          ).rows[0]["QUERY PLAN"][0];
          const buffers =
            Number(plan.Plan["Local Hit Blocks"] ?? 0) +
            Number(plan.Plan["Local Read Blocks"] ?? 0);
          const nodes: Record<string, unknown>[] = [];
          const visit = (node: Record<string, unknown>) => {
            nodes.push(node);
            for (const child of (node.Plans ?? []) as Record<string, unknown>[])
              visit(child);
          };
          visit(plan.Plan);
          assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));
          assert.ok(
            buffers < 50,
            `${kind} must remain exact-owner indexed: ${buffers}`,
          );
          assert.equal(
            nodes
              .filter(
                (node) =>
                  String(node["Node Type"]).includes("Index") &&
                  node["Node Type"] !== "Bitmap Index Scan",
              )
              .reduce((sum, node) => sum + Number(node["Actual Rows"]), 0),
            missing ? 0 : kind === "owner" ? 1 : 2,
          );
          metrics.push({
            mode,
            kind,
            missing,
            buffers,
            ms: plan["Execution Time"],
          });
          await db.query("rollback to savepoint membership_plan");
          await db.query("release savepoint membership_plan");
        }
      }
      await db.query("deallocate membership_owner_gate");
      await db.query("deallocate membership_reset");
    }
    console.log("Sessionless membership PG16 plans", JSON.stringify(metrics));
  });
}
