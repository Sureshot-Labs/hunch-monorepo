import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  applyFundingStepReceiptEvidenceInTransaction,
  type FundingStepReceiptEvidence,
} from "../persistence/funding-step-receipt-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import {
  deriveFundingLifecycle,
  FUNDING_PHYSICAL_EVENT_OWNERSHIP_CONFLICT,
} from "../lifecycle/funding-lifecycle-projector.js";
import { allocateFundingObservationInTransaction } from "../persistence/funding-operation-repository.js";
import {
  createOrReuseFundingReceiveSession,
  lockFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
  insertFundingReceiveReceipt,
  finalizeFundingReceiveCanonicalEventAllocation,
} from "../persistence/funding-receive-session-repository.js";
import {
  prelockFundingHandoffEvent,
  revalidateFundingHandoffEvent,
  HANDOFF_EVENT_SNAPSHOT_SQL,
  HANDOFF_EXISTING_EVENT_LOCK_SQL,
  HANDOFF_EVENT_OTHER_CREDIT_SQL,
  HANDOFF_EVENT_ANCHOR_REPAIR_SQL,
} from "../persistence/funding-handoff-event-ownership.js";

type Target = {
  operationId: string;
  stepId: string;
  attemptId: string;
  networkId: string;
};
const hash = () => `0x${randomBytes(32).toString("hex")}`;

/** Real writer/reducer/constraints, inside the enclosing rollback fixture.
 * Sequential race orders here do not replace the separate multi-session test. */
export async function verifyHandoffEventOwnershipPg(
  db: PoolClient,
  input: {
    userId: string;
    create: () => Promise<Target>;
    asset: { networkId: string; assetId: string; decimals: number };
    from: string;
    to: string;
    amount: string;
  },
) {
  const now = new Date();
  const make = () => {
    const event = {
      networkId: input.asset.networkId,
      asset: input.asset,
      sourceAddress: input.from,
      destinationAddress: input.to,
      rawAmount: input.amount,
      transactionHash: hash(),
      eventIndex: "19",
      ledgerHeight: "911",
      blockHash: hash(),
      observedAt: now,
      now,
    };
    const receipt: FundingStepReceiptEvidence = {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: event.ledgerHeight,
      blockHash: event.blockHash,
      canonical: true,
      failureCode: null,
      evidence: {
        transactionHash: event.transactionHash,
        transactionHashSource: "provider",
        handoffEventIndex: event.eventIndex,
      },
    };
    return { event, receipt };
  };
  const apply = (target: Target, receipt: FundingStepReceiptEvidence) =>
    applyFundingStepReceiptEvidenceInTransaction(db, {
      ...target,
      receipt,
      now,
    });
  const lifecycle = async (target: Target) => {
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
      operationId: target.operationId,
      now,
    });
    assert.ok(facts);
    return deriveFundingLifecycle(facts);
  };
  const row = async (event: ReturnType<typeof make>["event"]) =>
    (
      await db.query(
        `select * from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3`,
        [event.networkId, event.transactionHash, event.eventIndex],
      )
    ).rows[0];
  const accepted = await input.create();
  const first = make();
  assert.equal(
    (await apply(accepted, { ...first.receipt, status: "confirmed" })).status,
    "confirmed",
  );
  assert.equal(
    (await row(first.event)).allocation_error_code,
    "internal_handoff_suppressed",
  );
  const final = await apply(accepted, first.receipt);
  assert.equal(final.status, "finalized");
  assert.equal(
    (await row(first.event)).allocation_error_code,
    "internal_handoff_suppressed",
  );
  assert.equal(
    (await apply(accepted, first.receipt)).finalizedAt?.getTime(),
    final.finalizedAt?.getTime(),
  );
  assert.equal(
    await finalizeFundingReceiveCanonicalEventAllocation(db, {
      eventId: (await row(first.event)).id,
      receiveSessionId: randomUUID(),
      receiptId: randomUUID(),
      now,
    }),
    false,
    "handoff-first cannot become an external allocation",
  );

  const confirmedRemine = await input.create();
  const beforeFinality = make();
  await apply(confirmedRemine, {
    ...beforeFinality.receipt,
    status: "confirmed",
  });
  await db.query("savepoint reject_handoff_value_change");
  await assert.rejects(
    db.query(
      `update funding_receive_canonical_events
    set ledger_height=912,block_hash=$4,raw_amount=raw_amount+1
    where network_id=$1 and tx_hash=$2 and event_index=$3`,
      [
        beforeFinality.event.networkId,
        beforeFinality.event.transactionHash,
        beforeFinality.event.eventIndex,
        hash(),
      ],
    ),
    /identity is immutable/u,
  );
  await db.query("rollback to savepoint reject_handoff_value_change");
  await db.query("release savepoint reject_handoff_value_change");
  const finalAnchor = {
    ...beforeFinality.receipt,
    ledgerHeight: "912",
    blockHash: hash(),
  };
  await apply(confirmedRemine, { ...finalAnchor, status: "confirmed" });
  assert.equal(
    (await row(beforeFinality.event)).block_hash,
    finalAnchor.blockHash,
  );
  const afterRemine = await apply(confirmedRemine, finalAnchor);
  assert.equal(afterRemine.status, "finalized");
  assert.equal(afterRemine.failureCode, null);
  assert.equal(
    (await row(beforeFinality.event)).block_hash,
    finalAnchor.blockHash,
  );
  assert.notEqual(
    (await lifecycle(confirmedRemine)).recoveryMode,
    "manual_review",
  );
  assert.equal((await apply(confirmedRemine, finalAnchor)).failureCode, null);
  await db.query("savepoint reject_final_handoff_anchor_change");
  await assert.rejects(
    db.query(
      `update funding_receive_canonical_events
    set ledger_height=913,block_hash=$4 where network_id=$1 and tx_hash=$2 and event_index=$3`,
      [
        beforeFinality.event.networkId,
        beforeFinality.event.transactionHash,
        beforeFinality.event.eventIndex,
        hash(),
      ],
    ),
    /identity is immutable/u,
  );
  await db.query("rollback to savepoint reject_final_handoff_anchor_change");
  await db.query("release savepoint reject_final_handoff_anchor_change");

  // A receive poll can suppress this same log while the receipt poll still
  // has only confirmed evidence. It has no new handoff-owned marker yet.
  for (const priorReceiveClaim of [
    "absent",
    "old_anchor",
    "new_anchor",
  ] as const) {
    const receiveInstalled = await input.create();
    const received = make();
    await db.query(
      `insert into funding_step_receipt_observations
    (operation_id,step_id,attempt_id,network_id,status,action_match,ledger_height,block_hash,canonical,evidence,first_seen_at,observed_at)
    values($1,$2,$3,$4,'confirmed',true,$5,$6,true,$7,now(),now())`,
      [
        receiveInstalled.operationId,
        receiveInstalled.stepId,
        receiveInstalled.attemptId,
        receiveInstalled.networkId,
        received.receipt.ledgerHeight,
        received.receipt.blockHash,
        received.receipt.evidence,
      ],
    );
    const receivedFinal = {
      ...received.receipt,
      ledgerHeight: "912",
      blockHash: hash(),
    };
    if (priorReceiveClaim !== "absent")
      await quarantineFundingReceiveCanonicalInternalEvent(db, {
        ...received.event,
        ...(priorReceiveClaim === "new_anchor"
          ? {
              ledgerHeight: receivedFinal.ledgerHeight,
              blockHash: receivedFinal.blockHash,
            }
          : {}),
        reason: "internal_handoff_suppressed",
      });
    assert.equal(
      (await apply(receiveInstalled, receivedFinal)).failureCode,
      null,
    );
    assert.notEqual(
      (await lifecycle(receiveInstalled)).recoveryMode,
      "manual_review",
    );
    assert.equal(
      (await row(received.event)).block_hash,
      receivedFinal.blockHash,
    );
    assert.equal(
      (await apply(receiveInstalled, receivedFinal)).failureCode,
      null,
    );
  }

  const reorg = {
    ...first.receipt,
    status: "reorged" as const,
    canonical: false,
    blockHash: hash(),
    failureCode: "finalized_receipt_block_changed",
  };
  // A reverted inclusion below failure finality must not discard the exact
  // earlier owner or prevent a later canonical success of the SAME tx/log.
  const transientRevert = await input.create();
  const transientEvent = make();
  await apply(transientRevert, {
    ...transientEvent.receipt,
    status: "confirmed",
  });
  await apply(transientRevert, {
    ...transientEvent.receipt,
    status: "confirmed",
    actionMatch: null,
    ledgerHeight: "912",
    blockHash: hash(),
    failureCode: "transaction_reverted",
    evidence: {
      transactionHash: transientEvent.event.transactionHash,
      failureFinalized: false,
    },
  });
  const recovered = {
    ...transientEvent.receipt,
    ledgerHeight: "913",
    blockHash: hash(),
  };
  const recoveredReceipt = await apply(transientRevert, recovered);
  assert.equal(recoveredReceipt.status, "finalized");
  assert.equal(recoveredReceipt.failureCode, null);
  assert.equal(
    (await row(transientEvent.event)).block_hash,
    recovered.blockHash,
  );
  assert.notEqual(
    (await lifecycle(transientRevert)).recoveryMode,
    "manual_review",
  );
  assert.equal((await apply(transientRevert, recovered)).failureCode, null);
  assert.equal((await apply(accepted, reorg)).status, "reorged");
  assert.equal((await apply(accepted, reorg)).status, "reorged");
  assert.equal((await row(first.event)).block_hash, first.event.blockHash);
  assert.equal(
    (await row(first.event)).allocation_error_code,
    "internal_handoff_suppressed",
  );

  const rebound = await input.create();
  const original = make();
  await apply(rebound, original.receipt);
  const newHash = hash();
  const changedHash = {
    ...original.receipt,
    status: "reorged" as const,
    canonical: false,
    failureCode: "polymarket_relayer_transaction_hash_changed",
    evidence: {
      transactionHash: newHash,
      previousTransactionHash: original.event.transactionHash,
    },
  };
  await apply(rebound, changedHash);
  await apply(rebound, changedHash);
  assert.equal(
    (
      await db.query(
        "select 1 from funding_receive_canonical_events where network_id=$1 and tx_hash=$2",
        [input.asset.networkId, newHash],
      )
    ).rowCount,
    0,
    "reorg replay must not insert a phantom new-hash log",
  );

  for (const kind of ["destination_credit", "refund_credit"] as const) {
    const target = await input.create();
    const other = await input.create();
    const data = make();
    await allocateFundingObservationInTransaction(db, {
      operationId: other.operationId,
      segmentId: null,
      kind,
      networkId: data.event.networkId,
      assetId: input.asset.assetId,
      assetDecimals: input.asset.decimals,
      txHash: data.event.transactionHash,
      eventIndex: data.event.eventIndex,
      fromAddress: input.from,
      toAddress: input.to,
      rawAmount: input.amount,
      observedAt: now,
      ledgerHeight: data.event.ledgerHeight,
      blockHash: data.event.blockHash,
      finalityStatus: "finalized",
      finalizedAt: now,
      metadata: {},
    });
    const conflict = await apply(target, data.receipt);
    assert.equal(conflict.status, "pending");
    assert.equal(
      conflict.failureCode,
      FUNDING_PHYSICAL_EVENT_OWNERSHIP_CONFLICT,
    );
    assert.equal((await lifecycle(target)).recoveryMode, "manual_review");
  }

  // Use the real receive API within the parent's rollback transaction.
  const nested = {
    connect: async () => ({
      query: (sql: string, values?: unknown[]) =>
        db.query(
          sql.toLowerCase() === "begin"
            ? "savepoint handoff_receive_session"
            : sql.toLowerCase() === "commit"
              ? "release savepoint handoff_receive_session"
              : sql.toLowerCase() === "rollback"
                ? "rollback to savepoint handoff_receive_session"
                : sql,
          values,
        ),
      release: () => {},
    }),
  } as unknown as Pool;
  const id = randomUUID();
  const receiveTarget = {
    receiveTargetId: id,
    networkId: input.asset.networkId,
    destinationAddress: input.to,
    acceptedAssets: [{ asset: input.asset, handling: "direct" as const }],
    safeInstructions: [],
  };
  const session = await createOrReuseFundingReceiveSession(nested, {
    userId: input.userId,
    venueId: "polymarket",
    destinationOptionId: id,
    venueBindingOptionId: id,
    destinationAsset: input.asset,
    destinationTargetSnapshot: {},
    venueBindingSnapshot: {},
    methods: [
      {
        methodId: id,
        kind: "manual",
        safeLabel: "Test",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: id,
          destinationOptionId: id,
          destinationAddress: input.to,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(now.getTime() + 60000).toISOString(),
          safeInstructions: [],
        },
      },
    ],
    receiveTargets: [receiveTarget],
    selectedReceiveTargetId: id,
    observationVariants: [
      {
        variantId: id,
        networkId: input.asset.networkId,
        asset: input.asset,
        destinationAddress: input.to,
        destinationLocationId: id,
        baselineRaw: "0",
        baselineRevision: "offline",
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: {
            eventCursorBlock: "100",
            eventIdentity: "evm_erc20_transfer_v1",
            eventConfirmations: 2,
          },
        },
        completion: { kind: "direct_destination_credit" },
      },
    ],
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "offline-test",
    ownershipRevision: "offline-test",
    now,
    expiresAt: new Date(now.getTime() + 60000),
    observeUntil: new Date(now.getTime() + 120000),
  });
  const sessionId = session.snapshot.session.receiveSessionId;
  for (const legacyStatus of [null, "confirmed", "finalized"] as const) {
    const legacyFinal = legacyStatus === "finalized";
    const target = await input.create();
    const data = make();
    await lockFundingReceiveCanonicalEvents(db, [data.event]);
    const external = await insertFundingReceiveReceipt(db, {
      receiveSessionId: sessionId,
      userId: input.userId,
      variantId: id,
      asset: input.asset,
      destinationAddress: input.to,
      rawAmount: input.amount,
      observationRevision: randomUUID(),
      observedAt: now,
      handling: "direct",
      status: "ready",
      evidence: {},
      now,
      canonicalEvent: data.event,
    });
    assert.equal(
      await finalizeFundingReceiveCanonicalEventAllocation(db, {
        eventId: (await row(data.event)).id,
        receiveSessionId: sessionId,
        receiptId: external.receipt.receiptId,
        now,
      }),
      true,
    );
    if (legacyStatus)
      await db.query(
        `insert into funding_step_receipt_observations
      (operation_id,step_id,attempt_id,network_id,status,action_match,ledger_height,block_hash,canonical,evidence,first_seen_at,observed_at,finalized_at)
      values($1,$2,$3,$4,$8,true,$5,$6,true,$7,now(),now(),
        case when $8='finalized' then date_trunc('milliseconds',now()) + interval '123 microseconds' else null end)`,
        [
          target.operationId,
          target.stepId,
          target.attemptId,
          target.networkId,
          data.receipt.ledgerHeight,
          data.receipt.blockHash,
          data.receipt.evidence,
          legacyStatus,
        ],
      );
    const incoming =
      legacyStatus === "confirmed"
        ? { ...data.receipt, ledgerHeight: "912", blockHash: hash() }
        : data.receipt;
    const result = await apply(target, incoming);
    assert.equal(result.status, legacyStatus ?? "pending");
    assert.equal(result.failureCode, FUNDING_PHYSICAL_EVENT_OWNERSHIP_CONFLICT);
    assert.equal(result.actionMatch, legacyStatus ? true : null);
    if (legacyFinal) {
      const precise = await db.query<{ remainder: string }>(
        `select mod(extract(microseconds from finalized_at)::numeric,1000)::text as remainder
         from funding_step_receipt_observations where attempt_id=$1`,
        [target.attemptId],
      );
      assert.equal(precise.rows[0]?.remainder, "123");
    }
    assert.equal((await lifecycle(target)).status, "recovery_required");
    assert.equal((await row(data.event)).allocation_status, "allocated");
    assert.equal(
      (await apply(target, data.receipt)).failureCode,
      FUNDING_PHYSICAL_EVENT_OWNERSHIP_CONFLICT,
    );
  }
  const stale = await input.create();
  const data = make();
  await assert.rejects(
    revalidateFundingHandoffEvent(db, stale, {
      snapshot: null,
      incoming: null,
      changedAnchor: false,
    }),
    /classification facts changed/,
    "a previously absent attempt becoming visible must restart before taking E under O",
  );
  const prelock = await prelockFundingHandoffEvent(db, {
    ...stale,
    receipt: data.receipt,
    now,
  });
  await apply(stale, data.receipt);
  await assert.rejects(
    revalidateFundingHandoffEvent(db, stale, prelock),
    /classification facts changed/,
  );
  const moved = await apply(stale, {
    ...data.receipt,
    blockHash: hash(),
    ledgerHeight: "912",
  });
  assert.equal(moved.failureCode, FUNDING_PHYSICAL_EVENT_OWNERSHIP_CONFLICT);
  assert.equal((await row(data.event)).block_hash, data.event.blockHash);

  const primaryHandoff = await input.create();
  const duplicatedEvent = make();
  await apply(primaryHandoff, duplicatedEvent.receipt);
  const legacyDuplicate = await input.create();
  await db.query(
    `insert into funding_step_receipt_observations
      (operation_id,step_id,attempt_id,network_id,status,action_match,ledger_height,block_hash,canonical,evidence,first_seen_at,observed_at,finalized_at)
     values($1,$2,$3,$4,'finalized',true,$5,$6,true,$7,now(),now(),now())`,
    [
      legacyDuplicate.operationId,
      legacyDuplicate.stepId,
      legacyDuplicate.attemptId,
      legacyDuplicate.networkId,
      duplicatedEvent.receipt.ledgerHeight,
      duplicatedEvent.receipt.blockHash,
      duplicatedEvent.receipt.evidence,
    ],
  );
  const duplicate = await apply(legacyDuplicate, duplicatedEvent.receipt);
  assert.equal(duplicate.status, "finalized");
  assert.equal(
    duplicate.failureCode,
    FUNDING_PHYSICAL_EVENT_OWNERSHIP_CONFLICT,
  );
  assert.equal((await lifecycle(legacyDuplicate)).status, "recovery_required");

  const mismatch = await input.create();
  const claimed = make();
  await apply(mismatch, {
    ...claimed.receipt,
    status: "mismatch",
    actionMatch: false,
    failureCode: "original_mismatch",
  });
  await quarantineFundingReceiveCanonicalInternalEvent(db, {
    ...claimed.event,
    reason: "internal_exact_refund_suppressed",
  });
  assert.equal(
    (await apply(mismatch, claimed.receipt)).failureCode,
    "original_mismatch",
  );
  console.log(
    "PASS handoff E ownership: receive-first/handoff-first, legacy success conflict, refund/destination ownership, replay, reorg/hash-change, immutable mismatch, restart",
  );
}

/** Called after the enclosing 55k step/attempt/receipt fixture is populated. */
export async function verifyHandoffEventSnapshotPlansPg(
  db: PoolClient,
  input: Target,
) {
  await verifyConfirmedHandoffAnchorPlansPg(db);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    await db.query(
      `prepare handoff_ownership_snapshot(uuid,uuid,uuid) as ${HANDOFF_EVENT_SNAPSHOT_SQL}`,
    );
    for (const operation of [input.operationId, randomUUID()]) {
      const plan = (
        await db.query(
          `explain(analyze,buffers,format json) execute handoff_ownership_snapshot('${operation}','${input.stepId}','${input.attemptId}')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const visit = (node: Record<string, unknown>) => {
        if (node["Relation Name"])
          assert.ok(
            (Number(node["Actual Rows"] ?? 0) +
              Number(node["Rows Removed by Filter"] ?? 0)) *
              Number(node["Actual Loops"] ?? 0) <=
              1,
            `unbounded ownership snapshot: ${String(node["Relation Name"])}`,
          );
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(plan.Plan);
      console.log(
        "[handoff-ownership-plan]",
        JSON.stringify({
          mode,
          own: operation === input.operationId,
          ms: plan["Execution Time"],
          buffers:
            Number(plan.Plan["Shared Hit Blocks"] ?? 0) +
            Number(plan.Plan["Shared Read Blocks"] ?? 0) +
            Number(plan.Plan["Local Hit Blocks"] ?? 0) +
            Number(plan.Plan["Local Read Blocks"] ?? 0),
        }),
      );
    }
    await db.query("deallocate handoff_ownership_snapshot");
  }
  await db.query("savepoint handoff_physical_plans");
  try {
    for (const table of [
      "funding_receive_canonical_events",
      "funding_observations",
    ]) {
      await db.query(
        `create temporary table ${table} (like public.${table} including all) on commit drop`,
      );
    }
    await db.query(`insert into funding_receive_canonical_events
      (network_id,asset_id,asset_decimals,destination_address,source_address,raw_amount,
       tx_hash,event_index,ledger_height,block_hash,observed_at,allocation_status,allocation_error_code)
      select 'evm:137','token',6,'destination','source',1,
       '0x'||lpad(to_hex(fixture_ordinal),64,'0'),'19',1,'block',now(),
       'recovery_required','internal_handoff_suppressed'
      from generate_series(1,55000) fixture_ordinal`);
    await db.query(`insert into funding_observations
      (operation_id,kind,network_id,asset_id,asset_decimals,to_address,raw_amount,
       tx_hash,event_index,observed_at,finality_status)
      select gen_random_uuid(),case when fixture_ordinal%2=0 then 'source_credit' else 'refund_credit' end,
       'evm:137','token',6,'destination','1','0x'||lpad(to_hex(fixture_ordinal),64,'0'),
       '19',now(),'confirmed' from generate_series(1,55000) fixture_ordinal`);
    await db.query("analyze funding_receive_canonical_events");
    await db.query("analyze funding_observations");
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const [name, sql] of [
        ["handoff_physical_lock", HANDOFF_EXISTING_EVENT_LOCK_SQL],
        ["handoff_other_credit", HANDOFF_EVENT_OTHER_CREDIT_SQL],
        ["handoff_anchor_repair", HANDOFF_EVENT_ANCHOR_REPAIR_SQL],
      ]) {
        const repair = name === "handoff_anchor_repair";
        await db.query(
          `prepare ${name}(${repair ? "text,text,text,text,text,text,text" : "text,text,text"}) as ${sql}`,
        );
        for (const ordinal of [50001, 50002, 80000]) {
          await db.query("savepoint handoff_plan_update");
          const txHash = `0x${ordinal.toString(16).padStart(64, "0")}`;
          const plan = (
            await db.query(
              `explain(analyze,buffers,format json) execute ${name}('evm:137','${txHash}','19'${repair ? ",'2','new-block','1','block'" : ""})`,
            )
          ).rows[0]["QUERY PLAN"][0];
          const inspect = (node: Record<string, unknown>) => {
            if (node["Relation Name"] && node["Node Type"] !== "ModifyTable") {
              assert.match(String(node["Node Type"]), /Index/);
              assert.ok(
                (Number(node["Actual Rows"] ?? 0) +
                  Number(node["Rows Removed by Filter"] ?? 0)) *
                  Number(node["Actual Loops"] ?? 0) <=
                  1,
              );
            }
            for (const child of (node.Plans ?? []) as Record<string, unknown>[])
              inspect(child);
          };
          inspect(plan.Plan);
          console.log(
            "[handoff-ownership-plan]",
            JSON.stringify({
              mode,
              query: name,
              ordinal,
              ms: plan["Execution Time"],
              buffers:
                Number(plan.Plan["Shared Hit Blocks"] ?? 0) +
                Number(plan.Plan["Shared Read Blocks"] ?? 0) +
                Number(plan.Plan["Local Hit Blocks"] ?? 0) +
                Number(plan.Plan["Local Read Blocks"] ?? 0),
            }),
          );
          await db.query("rollback to savepoint handoff_plan_update");
          await db.query("release savepoint handoff_plan_update");
        }
        await db.query(`deallocate ${name}`);
      }
    }
  } finally {
    await db.query("rollback to savepoint handoff_physical_plans");
  }
}

/** Explain the installed trigger's actual predicate, not a hand-copied query.
 * The enclosing fixture supplies 55k indexed receipt/step rows. */
async function verifyConfirmedHandoffAnchorPlansPg(db: PoolClient) {
  const definition = (
    await db.query<{ body: string }>(
      `select pg_get_functiondef('guard_funding_receive_canonical_event_identity()'::regprocedure) as body`,
    )
  ).rows[0].body;
  const predicate = definition
    .split("confirmed_handoff_recanonicalization :=")[1]
    ?.match(/and exists \(([\s\S]*?)\n {4}\);/u)?.[1];
  assert.ok(predicate, "installed confirmed-handoff repair predicate missing");
  const query = `select exists(${predicate
    .replaceAll("old.network_id", "$1::text")
    .replaceAll("old.tx_hash", "$2::text")
    .replaceAll("old.event_index", "$3::text")
    .replaceAll("old.ledger_height", "$4::numeric")
    .replaceAll("old.block_hash", "$5::text")}) as permits`;
  await db.query("savepoint handoff_guard_plans");
  try {
    const witness = (
      await db.query<{ id: string; tx_hash: string }>(
        `select id,evidence->>'transactionHash' as tx_hash from funding_step_receipt_observations
       where evidence->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$' limit 1`,
      )
    ).rows[0];
    assert.ok(witness);
    await db.query(
      `update funding_step_receipt_observations set status='confirmed',canonical=true,
      action_match=true,failure_code=null,ledger_height='911',block_hash=$2,
      evidence=evidence||'{"handoffEventIndex":"19"}'::jsonb where id=$1`,
      [witness.id, hash()],
    );
    const block = (
      await db.query<{ block_hash: string }>(
        "select block_hash from funding_step_receipt_observations where id=$1",
        [witness.id],
      )
    ).rows[0].block_hash;
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare handoff_guard_lookup(text,text,text,numeric,text) as ${query}`,
      );
      for (const sample of ["hit", "wrong_anchor", "missing"] as const) {
        const txHash = sample === "missing" ? hash() : witness.tx_hash;
        const blockHash = sample === "wrong_anchor" ? hash() : block;
        const execution = `execute handoff_guard_lookup('evm:137','${txHash}','19',911,'${blockHash}')`;
        assert.equal(
          (await db.query(execution)).rows[0].permits,
          sample === "hit",
        );
        const plan = (
          await db.query(`explain(analyze,buffers,format json) ${execution}`)
        ).rows[0]["QUERY PLAN"][0];
        const inspect = (node: Record<string, unknown>) => {
          if (node["Relation Name"]) {
            assert.match(String(node["Node Type"]), /Index/);
            assert.ok(
              (Number(node["Actual Rows"] ?? 0) +
                Number(node["Rows Removed by Filter"] ?? 0)) *
                Number(node["Actual Loops"] ?? 0) <=
                1,
            );
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            inspect(child);
        };
        inspect(plan.Plan);
        console.log(
          "[handoff-ownership-plan]",
          JSON.stringify({
            mode,
            query: "installed_handoff_guard",
            sample,
            ms: plan["Execution Time"],
            buffers:
              Number(plan.Plan["Shared Hit Blocks"] ?? 0) +
              Number(plan.Plan["Shared Read Blocks"] ?? 0) +
              Number(plan.Plan["Local Hit Blocks"] ?? 0) +
              Number(plan.Plan["Local Read Blocks"] ?? 0),
          }),
        );
      }
      await db.query("deallocate handoff_guard_lookup");
    }
  } finally {
    await db.query("rollback to savepoint handoff_guard_plans");
    await db.query("release savepoint handoff_guard_plans");
  }
}
