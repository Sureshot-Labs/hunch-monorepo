import { pool } from "./db.js";

type Venue = "polymarket" | "kalshi" | "limitless";

type ExperimentResult = {
  venue: Venue;
  heuristic: string;
  markets: number;
  marketsWithPositions: number;
  walletsWithPositions: number;
  whalesWithPositions: number;
  activityEvents30d: number;
  activityUsd30d: number;
  tradeVol24h: number | null;
  tradeTrades24h: number | null;
};

type Heuristic = {
  venue: Venue;
  id: string;
  label: string;
  selectMarkets: (limit: number) => Promise<string[]>;
  tradeAware: boolean;
};

type Args = {
  limit: number;
  hours: number;
  venues: Venue[];
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 200,
    hours: 24,
    venues: ["polymarket", "kalshi", "limitless"],
    json: false,
  };

  for (const raw of argv) {
    const [key, value] = raw.split("=");
    if (key === "--limit" && value) {
      args.limit = Number(value);
    }
    if (key === "--hours" && value) {
      args.hours = Number(value);
    }
    if (key === "--venues" && value) {
      args.venues = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .filter(
          (entry): entry is Venue =>
            entry === "polymarket" || entry === "kalshi" || entry === "limitless",
        );
    }
    if (key === "--json") {
      args.json = true;
    }
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    args.limit = 200;
  }
  if (!Number.isFinite(args.hours) || args.hours <= 0) {
    args.hours = 24;
  }

  return args;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function fetchLatestSnapshotAt() {
  const client = await pool.connect();
  try {
    const result = await client.query<{ ts: string }>(
      `select max(snapshot_at) as ts from wallet_position_snapshots`,
    );
    return result.rows[0]?.ts ?? null;
  } finally {
    client.release();
  }
}

async function selectPolymarketVolume(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'polymarket' and status = 'ACTIVE'
        order by volume_24h desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectPolymarketLiquidity(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'polymarket' and status = 'ACTIVE'
        order by liquidity desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectPolymarketTradeVolume(limit: number, hours: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        with recent as (
          select token_id, sum(volume) as vol
          from unified_last_trade_1m
          where venue = 'polymarket'
            and bucket >= now() - ($1::text || ' hours')::interval
          group by token_id
        ),
        mapped as (
          select m.id, sum(r.vol) as vol
          from unified_markets m
          join recent r on (m.clob_token_ids::jsonb ? r.token_id)
          where m.status = 'ACTIVE' and m.venue = 'polymarket'
          group by m.id
        )
        select id
        from mapped
        order by vol desc nulls last
        limit $2
      `,
      [hours, limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectPolymarketHybrid(limit: number, hours: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        with recent as (
          select token_id, sum(volume) as vol
          from unified_last_trade_1m
          where venue = 'polymarket'
            and bucket >= now() - ($1::text || ' hours')::interval
          group by token_id
        ),
        mapped as (
          select m.id,
                 sum(r.vol) as vol,
                 max(m.volume_24h) as volume_24h,
                 max(m.liquidity) as liquidity
          from unified_markets m
          left join recent r on (m.clob_token_ids::jsonb ? r.token_id)
          where m.status = 'ACTIVE' and m.venue = 'polymarket'
          group by m.id
        )
        select id
        from mapped
        order by (coalesce(vol, 0) + 0.5 * coalesce(volume_24h, 0) + 0.3 * coalesce(liquidity, 0)) desc nulls last
        limit $2
      `,
      [hours, limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectKalshiOpenInterest(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'kalshi'
          and status = 'ACTIVE'
          and is_initialized is true
        order by open_interest desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectKalshiTradeVolume(limit: number, hours: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        with recent as (
          select token_id, sum(volume) as vol
          from unified_last_trade_1m
          where venue = 'kalshi'
            and bucket >= now() - ($1::text || ' hours')::interval
          group by token_id
        ),
        mapped as (
          select m.id, sum(r.vol) as vol
          from unified_markets m
          join recent r on (m.token_yes = r.token_id or m.token_no = r.token_id)
          where m.status = 'ACTIVE'
            and m.venue = 'kalshi'
            and m.is_initialized is true
          group by m.id
        )
        select id
        from mapped
        order by vol desc nulls last
        limit $2
      `,
      [hours, limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectKalshiUpdated(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'kalshi'
          and status = 'ACTIVE'
          and is_initialized is true
        order by updated_at desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectKalshiHybrid(limit: number, hours: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        with recent as (
          select token_id, sum(volume) as vol
          from unified_last_trade_1m
          where venue = 'kalshi'
            and bucket >= now() - ($1::text || ' hours')::interval
          group by token_id
        ),
        mapped as (
          select m.id,
                 sum(r.vol) as vol,
                 max(m.open_interest) as open_interest
          from unified_markets m
          left join recent r on (m.token_yes = r.token_id or m.token_no = r.token_id)
          where m.status = 'ACTIVE'
            and m.venue = 'kalshi'
            and m.is_initialized is true
          group by m.id
        )
        select id
        from mapped
        order by (coalesce(vol, 0) + 0.3 * coalesce(open_interest, 0)) desc nulls last
        limit $2
      `,
      [hours, limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectLimitlessLiquidity(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'limitless' and status = 'ACTIVE'
        order by liquidity desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectLimitlessBook(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'limitless' and status = 'ACTIVE'
        order by
          (case when best_bid is not null or best_ask is not null then 1 else 0 end) desc,
          liquidity desc nulls last,
          updated_at desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectLimitlessUpdated(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'limitless' and status = 'ACTIVE'
        order by updated_at desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function selectLimitlessHybrid(limit: number) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `
        select id
        from unified_markets
        where venue = 'limitless' and status = 'ACTIVE'
        order by
          (coalesce(liquidity, 0) + (case when best_bid is not null or best_ask is not null then 1 else 0 end)) desc,
          updated_at desc nulls last
        limit $1
      `,
      [limit],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function evaluateSelection(
  venue: Venue,
  heuristic: string,
  marketIds: string[],
  snapshotAt: string | null,
  hours: number,
): Promise<ExperimentResult> {
  const client = await pool.connect();
  try {
    const ids = marketIds.length ? marketIds : ["__empty__"];

    let marketsWithPositions = 0;
    let walletsWithPositions = 0;
    let whalesWithPositions = 0;
    if (snapshotAt) {
      const positions = await client.query<{
        markets: string;
        wallets: string;
      }>(
        `
          select
            count(distinct market_id)::text as markets,
            count(distinct wallet_id)::text as wallets
          from wallet_position_snapshots
          where snapshot_at = $1
            and market_id = any($2::text[])
        `,
        [snapshotAt, ids],
      );
      marketsWithPositions = asNumber(positions.rows[0]?.markets);
      walletsWithPositions = asNumber(positions.rows[0]?.wallets);

      const whales = await client.query<{ whales: string }>(
        `
          select count(distinct ws.wallet_id)::text as whales
          from wallet_position_snapshots ws
          join wallet_tag_map tm on tm.wallet_id = ws.wallet_id
          join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
          where ws.snapshot_at = $1
            and ws.market_id = any($2::text[])
        `,
        [snapshotAt, ids],
      );
      whalesWithPositions = asNumber(whales.rows[0]?.whales);
    }

    const activity = await client.query<{
      events: string;
      usd: string | null;
    }>(
      `
        select
          count(*)::text as events,
          coalesce(sum(size_usd), 0)::text as usd
        from wallet_activity_events
        where market_id = any($1::text[])
          and occurred_at >= now() - interval '30 days'
      `,
      [ids],
    );
    const activityEvents30d = asNumber(activity.rows[0]?.events);
    const activityUsd30d = asNumber(activity.rows[0]?.usd);

    let tradeVol24h: number | null = null;
    let tradeTrades24h: number | null = null;
    if (venue === "polymarket") {
      const trade = await client.query<{ vol: string | null; trades: string | null }>(
        `
          with recent as (
            select token_id, sum(volume) as vol, sum(trades) as trades
            from unified_last_trade_1m
            where venue = 'polymarket'
              and bucket >= now() - ($1::text || ' hours')::interval
            group by token_id
          )
          select
            coalesce(sum(recent.vol), 0)::text as vol,
            coalesce(sum(recent.trades), 0)::text as trades
          from unified_markets m
          join recent on (m.clob_token_ids::jsonb ? recent.token_id)
          where m.id = any($2::text[])
        `,
        [hours, ids],
      );
      tradeVol24h = asNumber(trade.rows[0]?.vol);
      tradeTrades24h = asNumber(trade.rows[0]?.trades);
    }

    if (venue === "kalshi") {
      const trade = await client.query<{ vol: string | null; trades: string | null }>(
        `
          with recent as (
            select token_id, sum(volume) as vol, sum(trades) as trades
            from unified_last_trade_1m
            where venue = 'kalshi'
              and bucket >= now() - ($1::text || ' hours')::interval
            group by token_id
          )
          select
            coalesce(sum(recent.vol), 0)::text as vol,
            coalesce(sum(recent.trades), 0)::text as trades
          from unified_markets m
          join recent on (m.token_yes = recent.token_id or m.token_no = recent.token_id)
          where m.id = any($2::text[])
        `,
        [hours, ids],
      );
      tradeVol24h = asNumber(trade.rows[0]?.vol);
      tradeTrades24h = asNumber(trade.rows[0]?.trades);
    }

    return {
      venue,
      heuristic,
      markets: marketIds.length,
      marketsWithPositions,
      walletsWithPositions,
      whalesWithPositions,
      activityEvents30d,
      activityUsd30d,
      tradeVol24h,
      tradeTrades24h,
    };
  } finally {
    client.release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotAt = await fetchLatestSnapshotAt();

  const heuristics: Heuristic[] = [
    {
      venue: "polymarket",
      id: "vol24h",
      label: "Volume 24h",
      selectMarkets: (limit) => selectPolymarketVolume(limit),
      tradeAware: false,
    },
    {
      venue: "polymarket",
      id: "liquidity",
      label: "Liquidity",
      selectMarkets: (limit) => selectPolymarketLiquidity(limit),
      tradeAware: false,
    },
    {
      venue: "polymarket",
      id: "trade_1h",
      label: "Trade Vol 1h",
      selectMarkets: (limit) => selectPolymarketTradeVolume(limit, 1),
      tradeAware: true,
    },
    {
      venue: "polymarket",
      id: "trade_24h",
      label: "Trade Vol 24h",
      selectMarkets: (limit) => selectPolymarketTradeVolume(limit, args.hours),
      tradeAware: true,
    },
    {
      venue: "polymarket",
      id: "hybrid",
      label: "Hybrid",
      selectMarkets: (limit) => selectPolymarketHybrid(limit, 1),
      tradeAware: true,
    },
    {
      venue: "kalshi",
      id: "open_interest",
      label: "Open Interest",
      selectMarkets: (limit) => selectKalshiOpenInterest(limit),
      tradeAware: false,
    },
    {
      venue: "kalshi",
      id: "trade_1h",
      label: "Trade Vol 1h",
      selectMarkets: (limit) => selectKalshiTradeVolume(limit, 1),
      tradeAware: true,
    },
    {
      venue: "kalshi",
      id: "trade_24h",
      label: "Trade Vol 24h",
      selectMarkets: (limit) => selectKalshiTradeVolume(limit, args.hours),
      tradeAware: true,
    },
    {
      venue: "kalshi",
      id: "updated",
      label: "Updated",
      selectMarkets: (limit) => selectKalshiUpdated(limit),
      tradeAware: false,
    },
    {
      venue: "kalshi",
      id: "hybrid",
      label: "Hybrid",
      selectMarkets: (limit) => selectKalshiHybrid(limit, 1),
      tradeAware: true,
    },
    {
      venue: "limitless",
      id: "liquidity",
      label: "Liquidity",
      selectMarkets: (limit) => selectLimitlessLiquidity(limit),
      tradeAware: false,
    },
    {
      venue: "limitless",
      id: "book",
      label: "Book + Liquidity",
      selectMarkets: (limit) => selectLimitlessBook(limit),
      tradeAware: false,
    },
    {
      venue: "limitless",
      id: "updated",
      label: "Updated",
      selectMarkets: (limit) => selectLimitlessUpdated(limit),
      tradeAware: false,
    },
    {
      venue: "limitless",
      id: "hybrid",
      label: "Hybrid",
      selectMarkets: (limit) => selectLimitlessHybrid(limit),
      tradeAware: false,
    },
  ];

  const activeHeuristics = heuristics.filter((h) => args.venues.includes(h.venue));
  const results: ExperimentResult[] = [];

  for (const heuristic of activeHeuristics) {
    console.log(
      `[wallets:intel:experiments] ${heuristic.venue} -> ${heuristic.label}`,
    );
    const markets = await heuristic.selectMarkets(args.limit);
    const evaluation = await evaluateSelection(
      heuristic.venue,
      heuristic.id,
      markets,
      snapshotAt,
      args.hours,
    );
    results.push(evaluation);
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const printable = results.map((row) => ({
    venue: row.venue,
    heuristic: row.heuristic,
    markets: row.markets,
    markets_positions: row.marketsWithPositions,
    wallets_positions: row.walletsWithPositions,
    whales_positions: row.whalesWithPositions,
    activity_events_30d: row.activityEvents30d,
    activity_usd_30d: Number(row.activityUsd30d.toFixed(2)),
    trade_vol_24h: row.tradeVol24h ? Number(row.tradeVol24h.toFixed(2)) : null,
    trade_trades_24h: row.tradeTrades24h,
  }));

  console.table(printable);
}

main()
  .catch((error) => {
    console.error("[wallets:intel:experiments] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
