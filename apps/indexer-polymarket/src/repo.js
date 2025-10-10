import { pool } from "./db";
export async function getVenueId(name) {
    const { rows } = await pool.query("select id from venues where name=$1", [
        name,
    ]);
    if (!rows[0])
        throw new Error("venue not seeded");
    return rows[0].id;
}
export async function upsertEvent(row) {
    const q = `
  insert into events(id, venue_id, event_id, title, category, slug, active, closed, start_time, end_time,
                     liquidity, volume_total, volume24hr, raw)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  on conflict (venue_id, event_id) do update set
    title=excluded.title,
    category=excluded.category,
    slug=excluded.slug,
    active=excluded.active,
    closed=excluded.closed,
    start_time=excluded.start_time,
    end_time=excluded.end_time,
    liquidity=excluded.liquidity,
    volume_total=excluded.volume_total,
    volume24hr=excluded.volume24hr,
    raw=excluded.raw,
    updated_at=now()
  returning id`;
    const v = [
        row.id,
        row.venue_id,
        row.event_id,
        row.title,
        row.category,
        row.slug,
        row.active,
        row.closed,
        row.start_time,
        row.end_time,
        row.liquidity,
        row.volume_total,
        row.volume24hr,
        row.raw,
    ];
    const { rows } = await pool.query(q, v);
    return rows[0].id;
}
export async function upsertMarket(row) {
    const q = `
  insert into markets(id, event_id, venue_id, market_id, title, enable_orderbook, accepting_orders,
                      condition_id, order_price_min_tick_size, order_min_size,
                      neg_risk, neg_risk_market_id, liquidity, volume_total, volume24hr,
                      clob_token_yes, clob_token_no, raw)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  on conflict (venue_id, market_id) do update set
    title=excluded.title,
    enable_orderbook=excluded.enable_orderbook,
    accepting_orders=excluded.accepting_orders,
    condition_id=excluded.condition_id,
    order_price_min_tick_size=excluded.order_price_min_tick_size,
    order_min_size=excluded.order_min_size,
    neg_risk=excluded.neg_risk,
    neg_risk_market_id=excluded.neg_risk_market_id,
    liquidity=excluded.liquidity,
    volume_total=excluded.volume_total,
    volume24hr=excluded.volume24hr,
    clob_token_yes=excluded.clob_token_yes,
    clob_token_no=excluded.clob_token_no,
    raw=excluded.raw,
    updated_at=now()
  returning id, clob_token_yes, clob_token_no`;
    const { rows } = await pool.query(q, [
        row.id,
        row.event_id,
        row.venue_id,
        row.market_id,
        row.title,
        row.enable_orderbook,
        row.accepting_orders,
        row.condition_id,
        row.order_price_min_tick_size,
        row.order_min_size,
        row.neg_risk,
        row.neg_risk_market_id,
        row.liquidity,
        row.volume_total,
        row.volume24hr,
        row.clob_token_yes,
        row.clob_token_no,
        row.raw,
    ]);
    return rows[0];
}
export async function upsertToken(token) {
    await pool.query(`
    insert into tokens(token_id, market_id, side)
    values ($1,$2,$3)
    on conflict (token_id) do nothing
  `, [token.token_id, token.market_id, token.side]);
}
export async function writeBookTop(tokenId, bestBid, bestAsk, ts) {
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null;
    await pool.query(`
    insert into book_top(token_id, ts, best_bid, best_ask, mid, spread)
    values ($1,$2,$3,$4,$5,$6)
    on conflict do nothing
  `, [tokenId, ts.toISOString(), bestBid, bestAsk, mid, spread]);
}
//# sourceMappingURL=repo.js.map