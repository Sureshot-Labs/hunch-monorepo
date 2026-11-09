import type { Pool } from "@hunch/infra";

/** Called inside the fill-sync transaction: an observer cannot store across a
 * meaningful source revision. Identical syncs do not reset its recheck time. */
export async function storePolymarketFillEvidence(
  db: Pick<Pool, "query">,
  input: {
    orderIds: string[];
    insertedOrderIds: string[];
    tradeEvidence: Array<{
      id: string;
      transactionHash: string;
      status: string | null;
    }>;
  },
): Promise<number> {
  const changedOrders = new Set(input.insertedOrderIds);
  if (input.tradeEvidence.length) {
    const changed = await db.query<{ order_id: string }>(
      `update order_fills fill_row
       set provider_tx_hash=evidence_row.tx_hash,provider_status=evidence_row.provider_status
       from unnest($1::text[],$2::text[],$3::text[]) as evidence_row(trade_id,tx_hash,provider_status)
       where fill_row.order_id=any($4::uuid[]) and fill_row.venue_trade_id=evidence_row.trade_id
         and (fill_row.provider_tx_hash,fill_row.provider_status)
           is distinct from (evidence_row.tx_hash,evidence_row.provider_status)
       returning fill_row.order_id`,
      [
        input.tradeEvidence.map((trade) => trade.id),
        input.tradeEvidence.map((trade) => trade.transactionHash),
        input.tradeEvidence.map((trade) => trade.status ?? "UNKNOWN"),
        input.orderIds,
      ],
    );
    for (const fill of changed.rows) changedOrders.add(fill.order_id);
  }
  if (changedOrders.size) {
    await db.query(
      `update orders set verified_buy_due_at=now(),
       verified_buy_lease_token=null,verified_buy_lease_until=null
       where id=any($1::uuid[]) and side='BUY'`,
      [[...changedOrders]],
    );
  }
  return changedOrders.size;
}
