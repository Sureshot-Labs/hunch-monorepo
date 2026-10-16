import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  TELEGRAM_NATIVE_FUNDED_LIFECYCLE_PAGE_SQL,
  TELEGRAM_NATIVE_FUNDED_LIFECYCLE_HOT_SQL,
  TELEGRAM_NATIVE_FUNDED_LIFECYCLE_OPERATIONS_SQL,
  listTelegramNativeFundedLifecyclePage,
} from "./repos/telegram-native-lifecycle-page.js";
import { telegramTradeLifecycleProgressTestHooks } from "./services/telegram-trade-lifecycle-progress.js";

/** Disposable PG16 only. Dense unchanged funded history is deliberately not
 * equivalent to the existing direct-intent test. No Telegram delivery runs. */
export async function checkTelegramNativeFundedLifecyclePlans(
  pool: Pool,
  input: { intentId: string; operationId: string },
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local jit=off");
    await db.query(`create temporary table telegram_trade_intents
      (like public.telegram_trade_intents including defaults including indexes) on commit drop`);
    await db.query(`create temporary table telegram_native_lifecycle_scan
      (like public.telegram_native_lifecycle_scan including all) on commit drop`);
    await db.query(
      `insert into telegram_native_lifecycle_scan(scan_name) values('funded_v1')`,
    );
    for (let start = 1; start <= 50000; start += 5000)
      await db.query(
        `insert into telegram_trade_intents
        select cloned_row.* from public.telegram_trade_intents source_row
        cross join generate_series($2::integer,$2::integer+4999) entry
        cross join lateral jsonb_populate_record(null::telegram_trade_intents,
          to_jsonb(source_row)||jsonb_build_object('id',md5('funded-lifecycle-'||entry)::uuid,
            'idempotency_key','funded-lifecycle-'||entry,'status','filled',
            'updated_at',transaction_timestamp()-interval '1 day',
            'result',jsonb_build_object('shortfallProgress','{}'::jsonb,
              'shortfallProgressSourceWatermark',jsonb_build_object('projectionVersion',8,
                'intentUpdatedAtUs',floor(extract(epoch from transaction_timestamp()-interval '1 day')*1000000)::bigint,
                'fundingUpdatedAtUs',floor(extract(epoch from transaction_timestamp()-interval '1 microsecond')*1000000)::bigint)))) cloned_row
        where source_row.id=$1::uuid`,
        [input.intentId, start],
      );
    await db.query("analyze telegram_trade_intents");
    assert.equal(
      (
        await db.query(
          "select funding_operation_id from telegram_trade_intents limit 1",
        )
      ).rows[0].funding_operation_id,
      input.operationId,
      "dense fixture must retain its exact linked funding source",
    );
    const lastId = (
      await db.query(
        "select id from telegram_trade_intents order by id desc limit 1",
      )
    ).rows[0].id;
    const firstId = (
      await db.query(
        "select id from telegram_trade_intents order by id limit 1",
      )
    ).rows[0].id;
    let ordinal = 0;
    const literal = (value: unknown): string =>
      value === null
        ? "null"
        : Array.isArray(value)
          ? literal(`{${value.join(",")}}`)
          : typeof value === "number"
            ? String(value)
            : `'${String(value).replaceAll("'", "''")}'`;
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const operationIds of [
        [input.operationId],
        ["00000000-0000-4000-8000-000000000099"],
        [],
      ]) {
        const name = `funded_operation_hint_${++ordinal}`;
        await db.query(
          `prepare ${name}(uuid[]) as ${TELEGRAM_NATIVE_FUNDED_LIFECYCLE_OPERATIONS_SQL}`,
        );
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${name}(${literal(operationIds)})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        await db.query(`deallocate ${name}`);
        assert.equal(
          plan.Plan["Actual Rows"],
          operationIds[0] === input.operationId ? 1 : 0,
        );
        assert.ok(
          plan.Plan["Local Hit Blocks"] < 100,
          `one processed operation must not scan its 50k historical aliases: ${JSON.stringify(plan.Plan)}`,
        );
        console.log(
          "[native-funded-operation-hint]",
          JSON.stringify({
            mode,
            kind:
              operationIds[0] === input.operationId
                ? "hit"
                : operationIds.length
                  ? "missing"
                  : "empty",
            ms: plan["Execution Time"],
            blocks: plan.Plan["Local Hit Blocks"],
          }),
        );
      }
      for (const cursor of [
        null,
        "7fffffff-ffff-ffff-ffff-ffffffffffff",
        lastId,
      ]) {
        const name = `funded_source_${++ordinal}`;
        await db.query(
          `prepare ${name}(uuid,integer) as ${TELEGRAM_NATIVE_FUNDED_LIFECYCLE_PAGE_SQL}`,
        );
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${name}(${literal(cursor)},25)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        await db.query(`deallocate ${name}`);
        assert.ok(plan.Plan["Actual Rows"] <= 25);
        assert.ok(
          plan.Plan["Local Hit Blocks"] < 150,
          "source page must not scan funded history",
        );
        console.log(
          "[native-funded-source-page]",
          JSON.stringify({
            mode,
            cursor,
            ms: plan["Execution Time"],
            blocks: plan.Plan["Local Hit Blocks"],
            rows: plan.Plan["Actual Rows"],
          }),
        );
      }
      await db.query(
        "update telegram_native_lifecycle_scan set last_intent_id=null",
      );
      const statements: { text: string; values: unknown[] }[] = [];
      const recorder = {
        query: async (
          query: string | { text: string; values: unknown[] },
          values: unknown[] = [],
        ) => {
          const statement =
            typeof query === "string" ? { text: query, values } : query;
          if (statement.text.includes("lifecycle_hint"))
            statements.push(statement);
          return db.query(statement.text, statement.values);
        },
      };
      assert.deepEqual(
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(
          recorder as never,
          25,
        ),
        [],
      );
      assert.ok(
        (
          await db.query(
            "select last_intent_id from telegram_native_lifecycle_scan",
          )
        ).rows[0].last_intent_id,
      );
      for (const statement of statements) {
        const name = `funded_hint_${++ordinal}`;
        await db.query(`prepare ${name} as ${statement.text}`);
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${name}(${statement.values.map(literal).join(",")})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        await db.query(`deallocate ${name}`);
        assert.equal(plan.Plan["Actual Rows"], 0);
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
              node["Relation Name"] === "telegram_trade_intents",
          ),
        );
        assert.ok(
          plan.Plan["Local Hit Blocks"] < 1500,
          "unchanged funded facts must be evaluated only for the source page",
        );
        console.log(
          "[native-funded-unchanged-hints]",
          JSON.stringify({
            mode,
            ms: plan["Execution Time"],
            localBlocks: plan.Plan["Local Hit Blocks"],
            sharedBlocks: plan.Plan["Shared Hit Blocks"],
          }),
        );
      }
      await db.query("savepoint fresh_funded_intent");
      const freshId = "00000000-0000-4000-8000-000000000001";
      await db.query(
        `insert into telegram_trade_intents
        select copied_row.* from public.telegram_trade_intents source_row
        cross join lateral jsonb_populate_record(null::telegram_trade_intents,to_jsonb(source_row)||
          jsonb_build_object('id',$2::uuid,'idempotency_key','new-funded-behind-cursor',
            'status','funding','result','{}'::jsonb,'updated_at',clock_timestamp())) copied_row
        where source_row.id=$1`,
        [input.intentId, freshId],
      );
      await db.query(
        "update telegram_native_lifecycle_scan set last_intent_id='7fffffff-ffff-ffff-ffff-ffffffffffff'",
      );
      assert.deepEqual(
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 25),
        [freshId],
        "new funded intent behind the cursor must be visible on the next ordinary tick",
      );
      const hotName = `funded_hot_${++ordinal}`;
      await db.query(
        `prepare ${hotName}(integer) as ${TELEGRAM_NATIVE_FUNDED_LIFECYCLE_HOT_SQL}`,
      );
      const hotPlan = (
        await db.query(
          `explain(analyze,buffers,format json) execute ${hotName}(25)`,
        )
      ).rows[0]["QUERY PLAN"][0];
      await db.query(`deallocate ${hotName}`);
      assert.equal(hotPlan.Plan["Actual Rows"], 1);
      assert.ok(
        hotPlan.Plan["Local Hit Blocks"] < 150,
        "hot source must not walk the historical UUID rotation",
      );
      console.log(
        "[native-funded-hot-page]",
        JSON.stringify({
          mode,
          ms: hotPlan["Execution Time"],
          blocks: hotPlan.Plan["Local Hit Blocks"],
          rows: hotPlan.Plan["Actual Rows"],
        }),
      );
      await db.query("rollback to savepoint fresh_funded_intent");
      // A source change on a deep historical page is still observed. Nothing
      // depends on terminal cached intent/operation status, and wrap is durable.
      await db.query("savepoint changed_funding_source");
      await db.query(
        "update funding_operations set version=version+1,updated_at=transaction_timestamp()+interval '1 hour' where id=$1",
        [input.operationId],
      );
      assert.equal(
        (
          await db.query(
            `select updated_at>transaction_timestamp()-interval '1 microsecond' as changed from funding_operations where id=$1`,
            [input.operationId],
          )
        ).rows[0].changed,
        true,
        "late source must actually advance beyond the frozen watermark",
      );
      const beforeTail = (
        await db.query(
          "select id from telegram_trade_intents order by id desc offset 25 limit 1",
        )
      ).rows[0].id;
      await db.query(
        "update telegram_native_lifecycle_scan set last_intent_id=$1",
        [beforeTail],
      );
      const changed =
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 25);
      assert.equal(changed.length, 25);
      assert.ok(
        changed.includes(lastId),
        "deep terminal history must be repaired after late funding evidence",
      );
      assert.equal(
        (await listTelegramNativeFundedLifecyclePage(db, 25))?.ids.length,
        25,
        "same normal tick wraps after the empty tail without housekeeping delay",
      );
      // Newer direct work must not consume every historical repair slot or
      // advance the cursor over due-but-unprocessed historical candidates.
      await db.query(
        `insert into telegram_trade_intents
        select copied_row.* from public.telegram_trade_intents source_row
        cross join generate_series(1,25) entry
        cross join lateral jsonb_populate_record(null::telegram_trade_intents,to_jsonb(source_row)||
          jsonb_build_object('id',md5('competing-direct-'||entry)::uuid,
            'idempotency_key','competing-direct-'||entry,'funding_operation_id',null,
            'status','submitted','result',jsonb_build_object('appHandoffExecution',jsonb_build_object('version',2)),
            'updated_at',clock_timestamp())) copied_row
        where source_row.id=$1`,
        [input.intentId],
      );
      const tailIds = (
        await db.query(
          "select id from telegram_trade_intents where funding_operation_id is not null and id>$1 order by id",
          [beforeTail],
        )
      ).rows.map((row) => row.id);
      await db.query(
        "update telegram_native_lifecycle_scan set last_intent_id=$1,prefer_history=true",
        [beforeTail],
      );
      const mixed =
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 25);
      assert.equal(mixed.length, 25);
      assert.ok(
        mixed.includes(tailIds[0]),
        "newer unprojected direct work must not displace the reserved historical candidate",
      );
      assert.equal(
        (
          await db.query(
            "select last_intent_id from telegram_native_lifecycle_scan",
          )
        ).rows[0].last_intent_id,
        tailIds[0],
        "cursor must stop before unprocessed due history",
      );
      const nextMixed =
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 25);
      assert.ok(
        nextMixed.includes(tailIds[1]),
        "next tick must recover the next skipped historical candidate, not skip the page each rotation",
      );
      // A known funding hint must not invert the existing unprojected-first
      // phase. With only two slots, old repair + the new direct card win.
      await db.query(
        "update telegram_native_lifecycle_scan set last_intent_id=$1,prefer_history=true",
        [beforeTail],
      );
      const newCardPriority =
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 2, [
          input.operationId,
        ]);
      assert.ok(
        newCardPriority.some((id) => !tailIds.includes(id) && id !== firstId),
        "processed funding must not displace every new/unprojected direct card",
      );
      await db.query(
        "update telegram_trade_intents set result=result||jsonb_build_object('shortfallProgress','{}'::jsonb) where funding_operation_id is null",
      );
      const processedFunding =
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 25, [
          input.operationId,
        ]);
      assert.ok(
        processedFunding.includes(firstId),
        "a funding operation processed by the common worker must wake its exact indexed source outside both current source pages",
      );
      await db.query(
        "update telegram_native_lifecycle_scan set last_intent_id=$1,prefer_history=false",
        [beforeTail],
      );
      const oneHot =
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 1);
      assert.equal(oneHot.length, 1);
      assert.ok(
        !tailIds.includes(oneHot[0]),
        "batch of one must preserve a hot turn",
      );
      assert.equal(
        (
          await db.query(
            "select last_intent_id from telegram_native_lifecycle_scan",
          )
        ).rows[0].last_intent_id,
        beforeTail,
      );
      assert.deepEqual(
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 1),
        [tailIds[0]],
        "next batch of one reserves the historical turn",
      );
      await db.query("rollback to savepoint changed_funding_source");
    }
  } finally {
    await db.query("rollback");
    db.release();
  }
}
