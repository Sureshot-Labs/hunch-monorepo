/* no-transaction */

DROP INDEX CONCURRENTLY IF EXISTS idx_order_fills_order_id_venue_fill_id_unique;

CREATE UNIQUE INDEX CONCURRENTLY idx_order_fills_order_id_venue_fill_id_unique
  ON order_fills(order_id, venue_fill_id)
  WHERE venue_fill_id IS NOT NULL;
