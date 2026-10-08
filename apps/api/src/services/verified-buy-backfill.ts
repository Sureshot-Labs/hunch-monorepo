import type { Pool } from "@hunch/infra";
import type { PurchaseRef } from "../schemas/social-trade.js";

/** Pages the source primary key before filtering to bound sparse scans. */
export async function queueVerifiedBuyBackfillPage(
  db: Pick<Pool, "query">,
  input: {
    kind: PurchaseRef["kind"];
    afterId: string | null;
    batchSize: number;
    execute: boolean;
  },
): Promise<{
  scanned: number;
  eligible: number;
  queued: number;
  nextAfterId: string | null;
  done: boolean;
}> {
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1)
    throw new Error("Invalid repair batch size");
  const table =
    input.kind === "order"
      ? "orders"
      : input.kind === "execution"
        ? "executions"
        : null;
  if (!table) throw new Error("Unknown purchase kind");
  const page = await db.query<{ id: string; eligible: boolean }>(
    `select id,
    upper(coalesce(side,''))='BUY' and verified_buy_facts is null and verified_buy_state='pending' as eligible
    from ${table} ${input.afterId ? "where id>$1::uuid" : ""} order by id limit $${input.afterId ? 2 : 1}`,
    input.afterId ? [input.afterId, input.batchSize] : [input.batchSize],
  );
  const ids = page.rows.filter((row) => row.eligible).map((row) => row.id);
  let queued = 0;
  if (input.execute && ids.length) {
    const result = await db.query(
      `update ${table} set verified_buy_due_at=now()
      where id=any($1::uuid[]) and verified_buy_facts is null and verified_buy_state='pending' returning id`,
      [ids],
    );
    queued = result.rows.length;
  }
  return {
    scanned: page.rows.length,
    eligible: ids.length,
    queued,
    nextAfterId: page.rows.at(-1)?.id ?? input.afterId,
    done: page.rows.length < input.batchSize,
  };
}
