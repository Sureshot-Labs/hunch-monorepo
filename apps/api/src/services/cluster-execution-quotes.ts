import type { DbQuery } from "../db.js";
import { buildBroadOrderableMarketSql } from "../lib/market-availability.js";
import type {
  ClusterMarketNativeQuotes,
  ClusterNativeTop,
} from "./cluster-execution.js";

type ClusterExecutionQuoteRow = {
  active: boolean;
  market_id: string;
  no_ask: unknown;
  no_bid: unknown;
  no_ts: Date | string | null;
  orderable: boolean;
  venue: string;
  yes_ask: unknown;
  yes_bid: unknown;
  yes_ts: Date | string | null;
};

const inFlightQuoteLoads = new Map<
  string,
  Promise<Map<string, ClusterMarketNativeQuotes>>
>();

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function top(input: {
  ask: unknown;
  bid: unknown;
  ts: Date | string | null;
}): ClusterNativeTop {
  return {
    ask: numberOrNull(input.ask),
    bid: numberOrNull(input.bid),
    asOf: isoOrNull(input.ts),
  };
}

export async function loadClusterMarketNativeQuotes(
  db: DbQuery,
  marketIds: Array<string | null | undefined>,
): Promise<Map<string, ClusterMarketNativeQuotes>> {
  const ids = Array.from(
    new Set(
      marketIds
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (ids.length === 0) return new Map();

  const inFlightKey = ids.slice().sort().join("\u0000");
  const existing = inFlightQuoteLoads.get(inFlightKey);
  if (existing) return existing;

  const load = (async () => {
    const { rows } = await db.query<ClusterExecutionQuoteRow>(
      `
      select
        m.id as market_id,
        m.venue,
        (m.status = 'ACTIVE' and e.status = 'ACTIVE') as active,
        (
          m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and ${buildBroadOrderableMarketSql({ marketAlias: "m", eventAlias: "e", nowParam: "now()", pmAlias: "pm" })}
          and (m.close_time is null or m.close_time > now())
          and (m.expiration_time is null or m.expiration_time > now())
        ) as orderable,
        yes_top.best_bid as yes_bid,
        yes_top.best_ask as yes_ask,
        yes_top.ts as yes_ts,
        no_top.best_bid as no_bid,
        no_top.best_ask as no_ask,
        no_top.ts as no_ts
      from unified_markets m
      join unified_events e on e.id = m.event_id
      left join polymarket_markets pm
        on pm.id = m.venue_market_id
       and m.venue = 'polymarket'
      left join lateral (
        select mt.token_id
        from unified_market_tokens mt
        where mt.market_id = m.id
          and mt.outcome_side = 'YES'
        order by mt.updated_at desc nulls last, mt.token_id
        limit 1
      ) yes_token on true
      left join lateral (
        select top.best_bid, top.best_ask, top.ts
        from unified_token_top_latest top
        where top.token_id = yes_token.token_id
        limit 1
      ) yes_top on true
      left join lateral (
        select mt.token_id
        from unified_market_tokens mt
        where mt.market_id = m.id
          and mt.outcome_side = 'NO'
        order by mt.updated_at desc nulls last, mt.token_id
        limit 1
      ) no_token on true
      left join lateral (
        select top.best_bid, top.best_ask, top.ts
        from unified_token_top_latest top
        where top.token_id = no_token.token_id
        limit 1
      ) no_top on true
      where m.id = any($1::text[])
    `,
      [ids],
    );

    return new Map(
      rows.map((row) => [
        row.market_id,
        {
          active: row.active,
          marketId: row.market_id,
          no: top({ ask: row.no_ask, bid: row.no_bid, ts: row.no_ts }),
          orderable: row.orderable,
          venue: row.venue,
          yes: top({ ask: row.yes_ask, bid: row.yes_bid, ts: row.yes_ts }),
        },
      ]),
    );
  })();
  inFlightQuoteLoads.set(inFlightKey, load);
  try {
    return await load;
  } finally {
    if (inFlightQuoteLoads.get(inFlightKey) === load) {
      inFlightQuoteLoads.delete(inFlightKey);
    }
  }
}
