import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "@hunch/infra";
import { CANONICAL_EVENT_OWNERSHIP_LOCK_SQL } from "../persistence/canonical-event-lock-sql.js";
import {
  OWNED_REFUND_OTHER_CREDIT_SQL,
  OWNED_REFUND_OTHER_EVM_CREDIT_SQL,
  PROTECTED_RECORDED_REFUND_PROOF_SQL,
  OWNED_REFUND_OTHER_RECEIVE_SQL,
  OWNED_REFUND_OBSERVER_ID,
} from "../reconciliation/relay-owned-refund-ownership.js";

type PlanNode = {
  "Node Type": string;
  "Actual Rows": number;
  "Rows Removed by Filter"?: number;
  "Local Hit Blocks": number;
  "Local Read Blocks": number;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};

/** Session-local copies with the real installed indexes, not production data.
 * This isolates unrelated-history scale; live writers/guards are exercised by
 * owned-refund-publication-pg. These are exact lookups, not paginated scans. */
export async function verifyOwnedRefundPlansPg(
  pool: Pool,
  input: {
    targetSql: string;
    operationId: string;
    transactionHash: string;
  },
) {
  const db = await pool.connect();
  await db.query("begin");
  try {
    const tables = [
      "funding_operations",
      "funding_operation_segments",
      "funding_observations",
      "telegram_funding_authorizations",
      "telegram_funding_authorization_reservations",
      "funding_classification_revisions",
      "funding_receive_canonical_events",
    ] as const;
    for (const table of tables)
      await db.query(
        `create temp table ${table} (like public.${table} including defaults including indexes) on commit drop`,
      );
    await db.query(`create temp table owned_refund_probe_keys on commit drop as
      select gen_random_uuid() as operation_id,gen_random_uuid() as segment_id,
        gen_random_uuid() as authority_id,gen_random_uuid() as reservation_id,
        gen_random_uuid() as user_id,'0x'||encode(gen_random_bytes(32),'hex') as transaction_hash
      from generate_series(1,50000)`);
    await db.query(
      `insert into funding_operations select * from public.funding_operations where id=$1`,
      [input.operationId],
    );
    await db.query(
      `insert into funding_operation_segments select * from public.funding_operation_segments where operation_id=$1`,
      [input.operationId],
    );
    await db.query(
      `insert into funding_observations select * from public.funding_observations where operation_id=$1`,
      [input.operationId],
    );
    await db.query(
      `insert into telegram_funding_authorization_reservations select *
      from public.telegram_funding_authorization_reservations where funding_operation_id=$1`,
      [input.operationId],
    );
    await db.query(`insert into telegram_funding_authorizations select * from public.telegram_funding_authorizations
      where id in (select authorization_id from telegram_funding_authorization_reservations)`);
    await db.query(
      `insert into funding_classification_revisions select * from public.funding_classification_revisions where operation_id=$1`,
      [input.operationId],
    );
    await db.query(
      `insert into funding_receive_canonical_events select * from public.funding_receive_canonical_events
      where network_id='evm:8453' and tx_hash=$1 and event_index='0'`,
      [input.transactionHash],
    );
    const seeds = new Map<string, object>();
    for (const table of tables) {
      const row = (
        await db.query(
          `select to_jsonb(seed_row) as data from ${table} seed_row limit 1`,
        )
      ).rows[0];
      assert.ok(row, table);
      seeds.set(table, row.data);
    }
    // Fixed table/column names only; every copied row is a synthetic fixture.
    const copies = [
      [
        "funding_operations",
        "'id',keys.operation_id,'user_id',keys.user_id,'quote_id',gen_random_uuid()",
      ],
      [
        "funding_operation_segments",
        "'id',keys.segment_id,'operation_id',keys.operation_id",
      ],
      [
        "funding_observations",
        "'id',gen_random_uuid(),'operation_id',keys.operation_id,'segment_id',keys.segment_id,'tx_hash',keys.transaction_hash",
      ],
      [
        "telegram_funding_authorizations",
        "'id',keys.authority_id,'user_id',keys.user_id",
      ],
      [
        "telegram_funding_authorization_reservations",
        "'id',keys.reservation_id,'funding_operation_id',keys.operation_id,'authorization_id',keys.authority_id,'cleanup_operation_id',null,'source_trade_intent_id',null",
      ],
      ["funding_classification_revisions", "'operation_id',keys.operation_id"],
      [
        "funding_receive_canonical_events",
        "'id',gen_random_uuid(),'tx_hash',keys.transaction_hash",
      ],
    ] as const;
    for (const [table, patch] of copies) {
      await db.query(
        `insert into ${table} select copied_row.* from owned_refund_probe_keys keys
        cross join lateral jsonb_populate_record(null::${table},
          $1::jsonb || jsonb_build_object(${patch})) copied_row`,
        [seeds.get(table)],
      );
      await db.query(`analyze ${table}`);
    }
    const observationId = (
      await db.query(
        `select id from funding_observations where operation_id=$1 and kind='refund_credit'`,
        [input.operationId],
      )
    ).rows[0].id;
    const receipt = (
      await db.query(
        `select id,segment_id,to_jsonb(receipt_row)::text as snapshot
      from funding_observations receipt_row where id=$1`,
        [observationId],
      )
    ).rows[0];
    await db.query(`create temp table funding_receive_receipts
      (like public.funding_receive_receipts including defaults including indexes) on commit drop`);
    const receiveSeed = (
      await db.query(
        `select to_jsonb(receipt_row) as data from public.funding_receive_receipts receipt_row limit 1`,
      )
    ).rows[0]?.data;
    assert.ok(
      receiveSeed,
      "representative retained synthetic receive fixture required",
    );
    await db.query(
      `insert into funding_receive_receipts select
      (jsonb_populate_record(null::funding_receive_receipts,$1::jsonb || jsonb_build_object(
      'id',keys.reservation_id,'receive_session_id',keys.reservation_id,'child_funding_operation_id',null,
      'network_id','evm:8453','tx_hash',keys.transaction_hash,'event_index','0','ledger_height',100,
      'block_hash','0x'||repeat('45',32)))).*
      from owned_refund_probe_keys keys`,
      [JSON.stringify(receiveSeed)],
    );
    await db.query(
      `insert into funding_receive_receipts select
      (jsonb_populate_record(null::funding_receive_receipts,$1::jsonb || jsonb_build_object(
      'id',gen_random_uuid(),'receive_session_id',gen_random_uuid(),'child_funding_operation_id',null,
      'network_id','evm:8453','tx_hash',upper($2::text),'event_index','0','ledger_height',100,
      'block_hash','0x'||repeat('45',32)))).*`,
      [JSON.stringify(receiveSeed), input.transactionHash],
    );
    await db.query("analyze funding_receive_receipts");
    const guardMigration = await readFile(
      new URL(
        "../../../../../packages/db/migrations/0330_funding_recorded_refund_case_alias_repair.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const guardBody = guardMigration
      .split("    and exists (\n")[1]
      ?.split("\n    );\n  confirmed_handoff_recanonicalization")[0];
    assert.ok(
      guardBody,
      "test explains the actual installed migration predicate",
    );
    const guardQuery = `select exists (${guardBody.replace(/\bold\./gu, "prior_event.")})
      from jsonb_populate_record(null::funding_receive_canonical_events,$1::jsonb) prior_event`;
    const guardTransactionHash = `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
    const priorEvent = {
      ...(
        await db.query(
          `select to_jsonb(event_row) as data from funding_receive_canonical_events event_row where tx_hash=$1`,
          [input.transactionHash],
        )
      ).rows[0].data,
      tx_hash: guardTransactionHash,
    };
    const guardReceipt = {
      ...JSON.parse(receipt.snapshot),
      id: randomUUID(),
      operation_id: (
        await db.query(
          "select operation_id from owned_refund_probe_keys limit 1",
        )
      ).rows[0].operation_id,
      tx_hash: guardTransactionHash.toUpperCase(),
      canonical: false,
      finality_status: "reorged",
      reorged_at: new Date().toISOString(),
    };
    await db.query(
      `insert into funding_observations select (jsonb_populate_record(null::funding_observations,$1::jsonb)).*`,
      [JSON.stringify(guardReceipt)],
    );
    for (const [event, expected] of [
      [priorEvent, true],
      [{ ...priorEvent, raw_amount: "123456" }, false],
      [{ ...priorEvent, tx_hash: `0x${"ff".repeat(32)}` }, false],
    ] as const)
      assert.equal(
        (await db.query(guardQuery, [JSON.stringify(event)])).rows[0].exists,
        expected,
      );
    for (const [networkId, transactionHash] of [
      ["hyperliquid:mainnet", "NativeCaseSensitive"],
      ["evm:8453", "MalformedCaseSensitive"],
      ["evm:1", guardTransactionHash.toUpperCase()],
    ] as const) {
      const retained = {
        ...guardReceipt,
        id: randomUUID(),
        network_id: networkId,
        tx_hash: transactionHash,
      };
      await db.query(
        `insert into funding_observations select (jsonb_populate_record(null::funding_observations,$1::jsonb)).*`,
        [JSON.stringify(retained)],
      );
      const exact = {
        ...priorEvent,
        network_id: networkId,
        tx_hash: transactionHash,
      };
      assert.equal(
        (await db.query(guardQuery, [JSON.stringify(exact)])).rows[0].exists,
        true,
        "legacy exact semantics remain available",
      );
      assert.equal(
        (
          await db.query(guardQuery, [
            JSON.stringify({
              ...exact,
              tx_hash: transactionHash.toLowerCase(),
            }),
          ])
        ).rows[0].exists,
        false,
        "native/malformed/unsupported references cannot acquire EVM alias semantics",
      );
    }
    await db.query("analyze funding_observations");
    const probes = [
      {
        name: "owned_anchor_alias_plan",
        types: "jsonb",
        sql: guardQuery,
        cases: [
          { name: "hit", args: [JSON.stringify(priorEvent)], rows: 1 },
          {
            name: "empty",
            args: [
              JSON.stringify({
                ...priorEvent,
                tx_hash: `0x${"ff".repeat(32)}`,
              }),
            ],
            rows: 1,
          },
          {
            name: "economic-conflict",
            args: [JSON.stringify({ ...priorEvent, raw_amount: "123456" })],
            rows: 1,
          },
        ],
      },
      {
        name: "owned_receive_alias_plan",
        types: "text,text,text",
        sql: OWNED_REFUND_OTHER_RECEIVE_SQL,
        cases: [
          {
            name: "hit",
            args: ["evm:8453", input.transactionHash, "0"],
            rows: 1,
          },
          {
            name: "empty",
            args: ["evm:8453", `0x${"ff".repeat(32)}`, "0"],
            rows: 0,
          },
        ],
      },
      {
        name: "owned_protected_proof_plan",
        types: "text,text,text,uuid,uuid,uuid,jsonb",
        sql: PROTECTED_RECORDED_REFUND_PROOF_SQL,
        cases: [
          {
            name: "hit",
            args: [
              "evm:8453",
              input.transactionHash,
              "0",
              observationId,
              input.operationId,
              receipt.segment_id,
              receipt.snapshot,
            ],
            rows: 1,
          },
          {
            name: "empty",
            args: [
              "evm:8453",
              input.transactionHash,
              "0",
              randomUUID(),
              input.operationId,
              receipt.segment_id,
              receipt.snapshot,
            ],
            rows: 0,
          },
          {
            name: "changed-snapshot",
            args: [
              "evm:8453",
              input.transactionHash,
              "0",
              observationId,
              input.operationId,
              receipt.segment_id,
              "{}",
            ],
            rows: 0,
          },
        ],
      },
      {
        name: "owned_target_plan",
        types: "uuid",
        sql: input.targetSql,
        cases: [
          { name: "hit", args: [input.operationId], rows: 1 },
          { name: "invalid-authority", args: [input.operationId], rows: 0 },
          { name: "empty", args: [randomUUID()], rows: 0 },
        ],
      },
      {
        name: "owned_credit_plan",
        types: "text,text,text,uuid,uuid,text",
        sql: OWNED_REFUND_OTHER_CREDIT_SQL,
        cases: [
          {
            name: "same-credit-excluded",
            args: [
              "evm:8453",
              input.transactionHash,
              "0",
              observationId,
              input.operationId,
              OWNED_REFUND_OBSERVER_ID,
            ],
            rows: 0,
          },
          {
            name: "other-credit",
            args: [
              "evm:8453",
              input.transactionHash,
              "0",
              null,
              input.operationId,
              OWNED_REFUND_OBSERVER_ID,
            ],
            rows: 1,
          },
          {
            name: "empty",
            args: [
              "evm:8453",
              `0x${"ff".repeat(32)}`,
              "0",
              null,
              input.operationId,
              OWNED_REFUND_OBSERVER_ID,
            ],
            rows: 0,
          },
        ],
      },
      {
        name: "owned_event_plan",
        types: "text,text,text",
        sql: CANONICAL_EVENT_OWNERSHIP_LOCK_SQL,
        cases: [
          {
            name: "hit",
            args: ["evm:8453", input.transactionHash, "0"],
            rows: 1,
          },
          {
            name: "empty",
            args: ["evm:8453", `0x${"ff".repeat(32)}`, "0"],
            rows: 0,
          },
        ],
      },
    ];
    const nodes = (node: PlanNode): PlanNode[] => [
      node,
      ...(node.Plans ?? []).flatMap(nodes),
    ];
    const exactCredit = probes.find(
      (probe) => probe.name === "owned_credit_plan",
    );
    assert.ok(exactCredit);
    probes.push({
      ...exactCredit,
      name: "owned_evm_credit_plan",
      sql: OWNED_REFUND_OTHER_EVM_CREDIT_SQL,
    });
    for (const probe of probes) {
      await db.query(`prepare ${probe.name}(${probe.types}) as ${probe.sql}`);
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        await db.query(`set local plan_cache_mode=${mode}`);
        for (const scenario of probe.cases) {
          if (scenario.name === "invalid-authority")
            await db.query(
              `update funding_operations set support_metadata=jsonb_set(
              support_metadata,'{fundingAuthorizationId}','"malformed-legacy-value"') where id=$1`,
              [input.operationId],
            );
          const args = scenario.args
            .map((value) => {
              if (value === null) return "null";
              return `'${value.replace(/'/gu, "''")}'`;
            })
            .join(",");
          const result = (
            await db.query<{
              "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
            }>(
              `explain (analyze,buffers,format json) execute ${probe.name}(${args})`,
            )
          ).rows[0]["QUERY PLAN"][0];
          const planNodes = nodes(result.Plan);
          const diagnostic = JSON.stringify({
            probe: probe.name,
            mode,
            scenario: scenario.name,
            nodes: planNodes.map((node) => ({
              type: node["Node Type"],
              relation: node["Relation Name"],
              rows: node["Actual Rows"],
              index: node["Index Name"],
            })),
          });
          assert.equal(result.Plan["Actual Rows"], scenario.rows);
          assert.ok(
            planNodes.every((node) => node["Node Type"] !== "Seq Scan"),
            diagnostic,
          );
          assert.ok(
            planNodes.every((node) => node["Actual Rows"] <= 2),
            diagnostic,
          );
          console.log(
            JSON.stringify({
              suite: "owned-refund-plans",
              probe: probe.name,
              scenario: scenario.name,
              mode,
              ms: result["Execution Time"],
              rows: result.Plan["Actual Rows"],
              buffers:
                result.Plan["Local Hit Blocks"] +
                result.Plan["Local Read Blocks"],
              filtered: planNodes.reduce(
                (n, node) => n + (node["Rows Removed by Filter"] ?? 0),
                0,
              ),
              indexes: planNodes.flatMap((node) =>
                node["Index Name"] ? [node["Index Name"]] : [],
              ),
            }),
          );
          if (scenario.name === "invalid-authority")
            await db.query(
              `update funding_operations set support_metadata=(select support_metadata
              from public.funding_operations where id=$1) where id=$1`,
              [input.operationId],
            );
        }
      }
      await db.query(`deallocate ${probe.name}`);
    }
  } finally {
    await db.query("rollback");
    db.release();
  }
}
