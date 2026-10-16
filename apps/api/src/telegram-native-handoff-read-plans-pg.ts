import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { telegramBotTradingTestHooks } from "./services/telegram-bot-trading.js";
import { readTelegramNativeHandoffOrder } from "./repos/telegram-native-handoff-read.js";
import { projectTelegramNativeHandoffStatusInTransaction } from "./repos/telegram-native-handoff-read.js";
import { telegramTradeLifecycleProgressTestHooks } from "./services/telegram-trade-lifecycle-progress.js";

/** Only disposable PG16. Temp clones preserve installed indexes and realistic
 * JSON widths; 5k owned terminal intents plus 45k foreign rows exercise the
 * correlated order lookups. No new special-purpose test index is installed.
 */
export async function checkTelegramNativeHandoffReadPlans(
  pool: Pool,
  input: {
    tradeIntentId: string;
    actionId: string;
    userId: string;
    telegramUserId: string;
    marketId: string;
  },
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    // Match apps/api/src/db.ts. API connections explicitly disable JIT; a
    // default-on disposable session would measure compilation of a generic
    // test plan that the production API never compiles.
    await db.query("set local jit=off");
    assert.match(
      (await db.query("show server_version")).rows[0].server_version,
      /^16\./u,
    );
    for (const table of [
      "telegram_trade_intents",
      "orders",
      "hip4_order_actions",
      "hip4_order_submissions",
    ])
      await db.query(
        `create temporary table ${table}(like public.${table} including defaults including indexes) on commit drop`,
      );
    const foreignUser = randomUUID();
    const fixtureUuid = (kind: string, entry = "entry") =>
      `overlay(overlay(md5('native-read-${kind}-'||${entry}) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid`;
    // Existing committed fixtures supply complete valid row shapes; these
    // clones have no foreign keys/triggers and disappear with this transaction.
    for (const [table, predicate, args, changes] of [
      [
        "telegram_trade_intents",
        "source_row.id=$1::uuid",
        [input.tradeIntentId, input.userId, foreignUser],
        `jsonb_build_object('id',${fixtureUuid("intent")},'order_id',${fixtureUuid("order")},
          'idempotency_key',md5('native-read-intent-key-'||entry),
          'status',case when entry in (42,43) then 'submitted' else source_row.status end,
          'user_id',case when entry<=5000 then $2::text else $3::text end,
          'telegram_user_id',case when entry<=5000 then source_row.telegram_user_id else '900000001' end,
          'updated_at',clock_timestamp()-entry*interval '1 second')`,
      ],
      [
        "orders",
        "source_row.id=(select order_id from public.hip4_order_actions where id=$1::uuid)",
        [input.actionId, input.userId, foreignUser],
        `jsonb_build_object('id',${fixtureUuid("order")},
          'user_id',case when entry<=5000 then $2::text else $3::text end,
          'venue_order_id',entry::text)`,
      ],
      [
        "hip4_order_actions",
        "source_row.id=$1::uuid",
        [input.actionId],
        `jsonb_build_object('id',${fixtureUuid("action")},'order_id',${fixtureUuid("order")},
          'request_key',${fixtureUuid("request")},'cloid','0x'||md5('native-read-cloid-'||entry),'nonce',entry)`,
      ],
      [
        "hip4_order_submissions",
        "source_row.action_id=$1::uuid",
        [input.actionId],
        `jsonb_build_object('action_id',${fixtureUuid("action")},'funding_trade_attempt_id',null,
          'order_observation',case when entry=42 then null else source_row.order_observation end)`,
      ],
    ] as const) {
      // FROM evaluates the record conversion once per row. Expanding a
      // volatile record expression with .* would repeat the large JSON
      // conversion for every column and test fixture construction, not the
      // read query, would hit the bounded statement timeout.
      for (let first = 1; first <= 50000; first += 5000) {
        await db.query(
          `insert into ${table}
          select normalized_row.* from public.${table} source_row
          cross join generate_series(${first},${first + 4999}) entry
          cross join lateral jsonb_populate_record(null::${table},to_jsonb(source_row)||${changes}) normalized_row
          where ${predicate}`,
          [...args],
        );
      }
      // Retain one exact admitted original binding as well: the status writer
      // can reach its real handoff PK without fabricating 50k public handoffs.
      await db.query(
        `insert into ${table} select source_row.* from public.${table} source_row where ${predicate}`,
        [args[0]],
      );
      await db.query(`analyze ${table}`);
      assert.equal(
        (await db.query(`select count(*)::int as row_count from ${table}`))
          .rows[0].row_count,
        50001,
      );
    }
    const ownerIntentId = (
      await db.query(
        `select id from telegram_trade_intents where order_id=${fixtureUuid("order", "42")}`,
      )
    ).rows[0].id;
    let ordinal = 0;
    const literal = (value: unknown): string =>
      value == null
        ? "null"
        : Array.isArray(value)
          ? literal(
              `{${value.map((item) => `"${String(item).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`,
            )
          : typeof value === "number"
            ? String(value)
            : `'${String(value).replaceAll("'", "''")}'`;
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      await db.query(`set local plan_cache_mode=${mode}`);
      const statements: { sql: string; args: unknown[] }[] = [];
      const recorder = {
        query: async (
          query: string | { text: string; values: unknown[] },
          args: unknown[] = [],
        ) => {
          const sql = typeof query === "string" ? query : query.text;
          const values = typeof query === "string" ? args : query.values;
          statements.push({ sql, args: values });
          return db.query(sql, values);
        },
      };
      for (const [label, action] of [
        [
          "projector-exact",
          () =>
            projectTelegramNativeHandoffStatusInTransaction(recorder as never, {
              actionId: input.actionId,
              userId: input.userId,
            }),
        ],
        [
          "projector-empty",
          () =>
            projectTelegramNativeHandoffStatusInTransaction(recorder as never, {
              actionId: randomUUID(),
              userId: input.userId,
            }),
        ],
        [
          "detail",
          () =>
            readTelegramNativeHandoffOrder(recorder, {
              ...input,
              tradeIntentId: ownerIntentId,
            }),
        ],
        [
          "empty-detail",
          () =>
            readTelegramNativeHandoffOrder(recorder, {
              ...input,
              tradeIntentId: randomUUID(),
            }),
        ],
        [
          "sparse-unresolved",
          () =>
            telegramBotTradingTestHooks.loadUnresolvedTelegramTradeIntent(
              recorder as never,
              input,
            ),
        ],
        [
          "count",
          () =>
            telegramBotTradingTestHooks.countUnresolvedTelegramTradeIntents(
              recorder as never,
              input.telegramUserId,
            ),
        ],
        [
          "list",
          () =>
            telegramBotTradingTestHooks.listResolvingTelegramTradeIntents(
              recorder as never,
              input.telegramUserId,
            ),
        ],
        [
          "empty-owner",
          () =>
            telegramBotTradingTestHooks.countUnresolvedTelegramTradeIntents(
              recorder as never,
              "900000002",
            ),
        ],
        [
          "empty-tail-unresolved",
          async () => {
            await db.query(
              `update hip4_order_submissions set order_observation=(select order_observation from public.hip4_order_submissions where action_id=$1) where action_id=${fixtureUuid("action", "42")}`,
              [input.actionId],
            );
            return telegramBotTradingTestHooks.loadUnresolvedTelegramTradeIntent(
              recorder as never,
              input,
            );
          },
        ],
        [
          "empty-tail-count",
          () =>
            telegramBotTradingTestHooks.countUnresolvedTelegramTradeIntents(
              recorder as never,
              input.telegramUserId,
            ),
        ],
        [
          "empty-tail-list",
          () =>
            telegramBotTradingTestHooks.listResolvingTelegramTradeIntents(
              recorder as never,
              input.telegramUserId,
            ),
        ],
      ] as const) {
        const result = await action();
        if (label === "count") assert.equal(result, 1);
        if (label === "empty-owner") assert.equal(result, 0);
        if (label === "empty-tail-unresolved") assert.equal(result, null);
        if (label === "empty-tail-count") assert.equal(result, 0);
        if (label === "empty-tail-list") assert.deepEqual(result, []);
        for (const statement of statements.splice(0)) {
          const name = `telegram_native_read_${++ordinal}`;
          await db.query(`prepare ${name} as ${statement.sql}`);
          const plan = (
            await db.query(
              `explain(analyze,buffers,format json) execute ${name}(${statement.args.map(literal).join(",")})`,
            )
          ).rows[0]["QUERY PLAN"][0];
          await db.query(`deallocate ${name}`);
          const nodes: Record<string, unknown>[] = [];
          const visit = (node: Record<string, unknown>) => {
            nodes.push(node);
            for (const child of (node.Plans ?? []) as Record<string, unknown>[])
              visit(child);
          };
          visit(plan.Plan);
          assert.ok(
            !nodes.some(
              (node) =>
                node["Node Type"] === "Seq Scan" &&
                [
                  "orders",
                  "hip4_order_actions",
                  "hip4_order_submissions",
                ].includes(String(node["Relation Name"])),
            ),
            "native terminal lookups must not scan unrelated order history",
          );
          console.log(
            "[telegram-native-read-plan]",
            JSON.stringify({
              label,
              mode,
              ms: plan["Execution Time"],
              sharedBuffers: plan.Plan["Shared Hit Blocks"],
              localBuffers: plan.Plan["Local Hit Blocks"],
              rows: plan.Plan["Actual Rows"],
            }),
          );
        }
      }
      for (const label of [
        "lifecycle-first",
        "lifecycle-resumed",
        "lifecycle-empty",
      ] as const) {
        if (label === "lifecycle-resumed")
          await db.query(
            `update telegram_trade_intents set result=result||jsonb_build_object(
            'shortfallProgress','{}'::jsonb,'shortfallProgressSourceWatermark',jsonb_build_object(
              'intentUpdatedAtUs',floor(extract(epoch from updated_at)*1000000)::bigint,
              'fundingUpdatedAtUs',0,'projectionVersion',8))
            where id=(select id from telegram_trade_intents order by updated_at desc,id limit 1)`,
          );
        if (label === "lifecycle-empty") {
          for (let first = 1; first <= 50001; first += 5000)
            await db.query(
              `update telegram_trade_intents set result=result||jsonb_build_object(
              'shortfallProgress','{}'::jsonb,'shortfallProgressSourceWatermark',jsonb_build_object(
                'intentUpdatedAtUs',floor(extract(epoch from updated_at)*1000000)::bigint,
                'fundingUpdatedAtUs',0,'projectionVersion',8))
              where id in (select id from telegram_trade_intents order by id limit 5000 offset $1)`,
              [first - 1],
            );
          await db.query(
            `update telegram_trade_intents set result=result||jsonb_build_object(
            'shortfallProgress','{}'::jsonb,'shortfallProgressSourceWatermark',jsonb_build_object(
              'intentUpdatedAtUs',floor(extract(epoch from updated_at)*1000000)::bigint,
              'fundingUpdatedAtUs',0,'projectionVersion',8)) where id=$1`,
            [input.tradeIntentId],
          );
          await db.query("analyze telegram_trade_intents");
        }
        const lifecycleIds =
          await telegramTradeLifecycleProgressTestHooks.listCandidateIds(
            recorder as never,
            1,
          );
        if (label === "lifecycle-empty") assert.deepEqual(lifecycleIds, []);
        for (const statement of statements.splice(0)) {
          const name = `telegram_native_lifecycle_${++ordinal}`;
          await db.query(`prepare ${name} as ${statement.sql}`);
          const plan = (
            await db.query(
              `explain(analyze,buffers,format json) execute ${name}(${statement.args.map(literal).join(",")})`,
            )
          ).rows[0]["QUERY PLAN"][0];
          await db.query(`deallocate ${name}`);
          console.log(
            "[telegram-native-lifecycle-plan]",
            JSON.stringify({
              label,
              mode,
              ms: plan["Execution Time"],
              sharedBuffers: plan.Plan["Shared Hit Blocks"],
              localBuffers: plan.Plan["Local Hit Blocks"],
              rows: plan.Plan["Actual Rows"],
            }),
          );
        }
      }
      // The next cache mode must start from the same unprojected source pool.
      await db.query(
        "update telegram_trade_intents set result=result-'shortfallProgress'-'shortfallProgressSourceWatermark'",
      );
      await db.query(
        `update hip4_order_submissions set order_observation=null where action_id=${fixtureUuid("action", "42")}`,
      );
    }
    await db.query(
      `update hip4_order_submissions set order_observation=(select order_observation from public.hip4_order_submissions where action_id=$1) where action_id=${fixtureUuid("action", "42")}`,
      [input.actionId],
    );
    assert.equal(
      await telegramBotTradingTestHooks.loadUnresolvedTelegramTradeIntent(
        db,
        input,
      ),
      null,
    );
    assert.equal(
      await telegramBotTradingTestHooks.countUnresolvedTelegramTradeIntents(
        db,
        input.telegramUserId,
      ),
      0,
    );
    assert.deepEqual(
      await telegramBotTradingTestHooks.listResolvingTelegramTradeIntents(
        db,
        input.telegramUserId,
      ),
      [],
    );
  } finally {
    await db.query("rollback");
    db.release();
  }
}
