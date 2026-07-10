// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import {
  findTradeMarketById,
  findTradeMarketByRef,
  isOrderable,
  loadMarketForVenue,
} from "./services/api-trading-market-repo.js";

const client = await pool.connect();

try {
  await client.query("begin");

  const suffix = crypto.randomUUID();
  const ref = `trade-market-ref-${suffix}`;
  const polymarketEventId = `trade-market-source-event-${suffix}`;
  const unifiedEventId = `polymarket:trade-market-event-${suffix}`;
  const exactSourceMarketId = `trade-market-source-exact-${suffix}`;
  const slugSourceMarketId = `trade-market-source-slug-${suffix}`;
  const venueMatchUnifiedId = `polymarket:trade-market-venue-${suffix}`;
  const slugMatchUnifiedId = `polymarket:trade-market-slug-${suffix}`;
  const future = new Date(Date.now() + 24 * 60 * 60 * 1_000);

  await client.query(
    `insert into polymarket_events (id, title, raw)
     values ($1, $2, '{}'::jsonb)`,
    [polymarketEventId, "Telegram trading integration source event"],
  );
  await client.query(
    `insert into polymarket_markets (
       id,
       event_id,
       question,
       accepting_orders,
       active,
       closed,
       archived,
       raw
     )
     values
       ($1, $4, 'Exact ID market', false, true, false, false, '{}'::jsonb),
       ($2, $4, 'Venue ID market', true, true, false, false, '{}'::jsonb),
       ($3, $4, 'Slug market', true, true, false, false, '{}'::jsonb)`,
    [exactSourceMarketId, ref, slugSourceMarketId, polymarketEventId],
  );
  await client.query(
    `insert into unified_events (
       id,
       venue,
       venue_event_id,
       title,
       status,
       end_date
     )
     values ($1, 'polymarket', $2, $3, 'ACTIVE', $4)`,
    [
      unifiedEventId,
      polymarketEventId,
      "Telegram trading integration event",
      future,
    ],
  );
  await client.query(
    `insert into unified_markets (
       id,
       venue,
       venue_market_id,
       event_id,
       title,
       status,
       market_type,
       close_time,
       expiration_time,
       best_bid,
       best_ask,
       last_price,
       outcomes,
       slug,
       clob_token_ids,
       metadata
     )
     values
       ($1, 'polymarket', $2, $6, 'Exact ID market', 'ACTIVE', 'binary', $7, $7, 0.04, 0.06, 0.05, '["Yes","No"]', $8, '["yes-exact","no-exact"]', '{}'::jsonb),
       ($3, 'polymarket', $1, $6, 'Venue ID market', 'ACTIVE', 'binary', $7, $7, 0.14, 0.16, 0.15, '["Yes","No"]', $9, '["yes-venue","no-venue"]', '{}'::jsonb),
       ($4, 'polymarket', $5, $6, 'Slug market', 'ACTIVE', 'binary', $7, $7, 0.24, 0.26, 0.25, '["Yes","No"]', $1, '["yes-slug","no-slug"]', '{}'::jsonb)`,
    [
      ref,
      exactSourceMarketId,
      venueMatchUnifiedId,
      slugMatchUnifiedId,
      slugSourceMarketId,
      unifiedEventId,
      future,
      `exact-slug-${suffix}`,
      `venue-slug-${suffix}`,
    ],
  );

  const exactMatch = await findTradeMarketByRef(client, ref);
  assert.equal(exactMatch?.id, ref);
  assert.equal(exactMatch?.accepting_orders, false);
  assert.equal(exactMatch ? isOrderable(exactMatch) : true, false);

  await client.query(
    `update polymarket_markets
        set accepting_orders = true
      where id = $1`,
    [exactSourceMarketId],
  );
  const exactById = await findTradeMarketById(client, ref);
  assert.equal(exactById?.accepting_orders, true);
  assert.equal(exactById ? isOrderable(exactById) : false, true);

  await client.query("delete from unified_markets where id = $1", [ref]);
  assert.equal(
    (await findTradeMarketByRef(client, ref))?.id,
    venueMatchUnifiedId,
  );

  await client.query("delete from unified_markets where id = $1", [
    venueMatchUnifiedId,
  ]);
  assert.equal(
    (await findTradeMarketByRef(client, ref))?.id,
    slugMatchUnifiedId,
  );
  assert.equal(
    (await loadMarketForVenue(client, slugMatchUnifiedId, "polymarket"))
      .accepting_orders,
    true,
  );

  for (const venue of ["kalshi", "limitless"] as const) {
    const eventId = `${venue}:trade-market-event-${suffix}`;
    const marketId = `${venue}:trade-market-${suffix}`;
    await client.query(
      `insert into unified_events (
         id,
         venue,
         venue_event_id,
         title,
         status,
         end_date
       )
       values ($1, $2, $3, $4, 'ACTIVE', $5)`,
      [
        eventId,
        venue,
        `trade-market-event-${suffix}`,
        `${venue} event`,
        future,
      ],
    );
    await client.query(
      `insert into unified_markets (
         id,
         venue,
         venue_market_id,
         event_id,
         title,
         status,
         market_type,
         close_time,
         expiration_time,
         outcomes,
         slug,
         metadata
       )
       values ($1, $2, $3, $4, $5, 'ACTIVE', 'binary', $6, $6, '["Yes","No"]', $7, $8::jsonb)`,
      [
        marketId,
        venue,
        `trade-market-${suffix}`,
        eventId,
        `${venue} market`,
        future,
        `trade-market-${venue}-${suffix}`,
        venue === "kalshi"
          ? JSON.stringify({ dflowNativeAcceptingOrders: true })
          : "{}",
      ],
    );

    const market = await loadMarketForVenue(client, marketId, venue);
    assert.equal(market.accepting_orders, null);
    assert.equal(isOrderable(market), true);
  }

  console.log("[telegram-bot-trading-market-integration-tests] passed 12/12");
} finally {
  await client.query("rollback");
  client.release();
}
