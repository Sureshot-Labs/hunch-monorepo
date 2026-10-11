import { fetchActiveRuntimePolicy } from "@hunch/db";
import {
  hip4ReadMarketSchema,
  hip4Identity,
  hip4BinaryPayout,
  hip4ReadPolicySchema,
  hip4TradeSchema,
  type Hip4Environment,
  type Hip4ReadMarket,
} from "@hunch/shared";
import type { Pool } from "pg";
import type { z } from "zod";

export async function readHip4Policy(db: Pick<Pool, "query">) {
  const row = await fetchActiveRuntimePolicy(db, "hip4_read");
  // Unlike an absent override, broken policy/configuration is not permission
  // to poll a provider. No API env import, including through dependencies.
  const policy = hip4ReadPolicySchema.parse(row ? row.payload : {});
  return { policy, revision: row ? `db-${row.id}` : "defaults-v1" };
}

export async function admitHip4Request(
  db: Pick<Pool, "query">,
  _environment: Hip4Environment,
  weight: number,
  maximum: number,
): Promise<boolean> {
  if (!Number.isInteger(weight) || weight <= 0 || weight > maximum)
    return false;
  // A single atomic rolling-window admission, shared across environments and
  // processes using this DB. No minute-boundary double burst or two-minute
  // blackout. At minimum request weight 1 the row has at most 1200 entries.
  const result = await db.query(
    `
    insert into hip4_request_budget(scope, admissions)
    values ('public-info', jsonb_build_array(jsonb_build_object('at', extract(epoch from statement_timestamp()), 'weight', $1::int)))
    on conflict (scope) do update set
      admissions = coalesce((select jsonb_agg(admission_row)
        from jsonb_array_elements(hip4_request_budget.admissions) as admission_row
        where (admission_row->>'at')::numeric > extract(epoch from statement_timestamp()) - 60), '[]'::jsonb) || excluded.admissions
    where coalesce((select sum((admission_row->>'weight')::int)
      from jsonb_array_elements(hip4_request_budget.admissions) as admission_row
      where (admission_row->>'at')::numeric > extract(epoch from statement_timestamp()) - 60), 0) + $1 <= $2
    returning scope
  `,
    [weight, maximum],
  );
  return result.rowCount === 1;
}

export async function advanceHip4Cursor(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  outcome: number,
) {
  await db.query(
    `insert into hip4_read_runtime(environment,after_outcome) values($1,$2)
    on conflict(environment) do update set after_outcome=excluded.after_outcome`,
    [environment, outcome],
  );
}

export async function readHip4Cursor(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
): Promise<number> {
  const result = await db.query(
    "select after_outcome from hip4_read_runtime where environment = $1",
    [environment],
  );
  return Number(result.rows[0]?.after_outcome ?? -1);
}

export async function readHip4Markets(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  allowlist: number[],
  after: number,
  limit: number,
) {
  const result = await db.query(
    `
    select read_model from hip4_read_markets
    where environment = $1 and outcome = any($2::bigint[]) and outcome > $3
    order by outcome limit $4
  `,
    [environment, allowlist, after, limit],
  );
  return result.rows.map((row) => hip4ReadMarketSchema.parse(row.read_model));
}

export async function readHip4StoredMarket(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  outcome: number,
) {
  const result = await db.query(
    "select read_model, raw from hip4_read_markets where environment=$1 and outcome=$2",
    [environment, outcome],
  );
  const row = result.rows[0];
  return row
    ? { market: hip4ReadMarketSchema.parse(row.read_model), raw: row.raw }
    : null;
}

export async function persistHip4Market(
  pool: Pool,
  input: {
    market: Hip4ReadMarket;
    raw: unknown;
    trades: z.infer<typeof hip4TradeSchema>[];
  },
): Promise<boolean> {
  const identity = hip4Identity(input.market.environment, input.market.outcome);
  if (
    input.market.marketId !== identity.marketId ||
    identity.sides.some((expected, index) =>
      Object.entries(expected).some(
        ([key, value]) =>
          input.market.sides[index]?.[key as keyof typeof expected] !== value,
      ),
    )
  )
    throw new Error("market_identity_mismatch");
  const client = await pool.connect();
  let discardConnection = false;
  try {
    await client.query("begin");
    // Serializes the bounded snapshot publication, never the remote requests.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [input.market.marketId],
    );
    const stored = await readHip4StoredMarket(
      client,
      input.market.environment,
      input.market.outcome,
    );
    if (
      stored &&
      Date.parse(stored.market.fetchedAt) > Date.parse(input.market.fetchedAt)
    ) {
      await client.query("rollback");
      return false;
    }
    let market = hip4ReadMarketSchema.parse(input.market);
    if (stored?.market.settlement && !market.settlement) {
      market = {
        ...market,
        status: "settled",
        settlement: stored.market.settlement,
        sides: market.sides.map((side, index) => ({
          ...side,
          payout: stored.market.sides[index].payout,
        })),
      };
    }
    const status =
      market.status === "settled"
        ? "SETTLED"
        : market.status === "expired"
          ? "CLOSED"
          : "ACTIVE";
    // Publish event, both tokens, source snapshot and membership in one commit.
    // Shared discovery still excludes HIP; this projection is not activation.
    await client.query(
      `
      insert into unified_events(id,venue,venue_event_id,title,description,status,metadata)
      values ($1,'hyperliquid',$1,$2,$3,$5,$4::jsonb)
      on conflict (id) do update set title=excluded.title, description=excluded.description, metadata=excluded.metadata,
        status=excluded.status
    `,
      [
        market.eventId,
        market.eventTitle,
        market.description,
        JSON.stringify({
          hip4: {
            environment: market.environment,
            questionId: market.questionId,
            readOnly: true,
          },
        }),
        market.questionId == null ? status : "ACTIVE",
      ],
    );
    await client.query(
      `
      insert into unified_markets(id,venue,venue_market_id,event_id,title,description,status,market_type,
        expiration_time,token_yes,token_no,outcomes,metadata,resolved_outcome)
      values ($1,'hyperliquid',$1,$2,$3,$4,$5,'binary',$6,$7,$8,$9,$10::jsonb,$11)
      on conflict (id) do update set event_id=excluded.event_id,title=excluded.title,description=excluded.description,
        status=excluded.status,expiration_time=excluded.expiration_time,outcomes=excluded.outcomes,
        metadata=excluded.metadata,resolved_outcome=excluded.resolved_outcome
    `,
      [
        market.marketId,
        market.eventId,
        market.title,
        market.description,
        status,
        market.expiry,
        market.sides[0].tokenId,
        market.sides[1].tokenId,
        JSON.stringify(market.sides.map((side) => side.label)),
        JSON.stringify({ hip4: market, acceptingOrders: false }),
        market.settlement
          ? hip4BinaryPayout(market.sides[0].payout) === 1
            ? "YES"
            : hip4BinaryPayout(market.sides[0].payout) === 0
              ? "NO"
              : null
          : null,
      ],
    );
    for (const side of market.sides) {
      const args = [
        market.marketId,
        side.tokenId,
        side.sideIndex === 0 ? "YES" : "NO",
      ];
      await client.query(
        `insert into unified_market_tokens(market_id,token_id,venue,outcome_side)
        values($1,$2,'hyperliquid',$3) on conflict (market_id,token_id) do nothing`,
        args,
      );
      await client.query(
        `insert into unified_tokens(market_id,token_id,venue,side)
        values($1,$2,'hyperliquid',$3) on conflict (market_id,side) do nothing`,
        args,
      );
    }
    await client.query(
      `insert into hip4_read_markets(market_id,environment,outcome,fetched_at,generation,read_model,raw)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) on conflict (market_id) do update set
      fetched_at=excluded.fetched_at,generation=excluded.generation,read_model=excluded.read_model,
      raw=case when excluded.raw->'settlement' = 'null'::jsonb and hip4_read_markets.raw->'settlement' is not null
        then excluded.raw || jsonb_build_object('settlement',hip4_read_markets.raw->'settlement') else excluded.raw end`,
      [
        market.marketId,
        market.environment,
        market.outcome,
        market.fetchedAt,
        market.generation,
        JSON.stringify(market),
        JSON.stringify(input.raw),
      ],
    );
    const trades = input.trades.map((tradeInput) => {
      const trade = hip4TradeSchema.parse(tradeInput);
      if (!market.sides.some((side) => side.coin === trade.coin))
        throw new Error("trade_identity_mismatch");
      return { ...trade, time_ms: trade.time };
    });
    await client.query(
      `insert into hip4_public_trades(environment,coin,time_ms,tid,market_id,side,price,size,transaction_hash)
      select $1, trade_row.coin, trade_row.time_ms, trade_row.tid, $2, trade_row.side, trade_row.px::numeric, trade_row.sz::numeric, trade_row.hash
      from jsonb_to_recordset($3::jsonb) as trade_row(coin text, time_ms bigint, tid bigint, side text, px text, sz text, hash text)
      on conflict (environment,coin,time_ms,tid) do nothing`,
      [market.environment, market.marketId, JSON.stringify(trades)],
    );
    await advanceHip4Cursor(client, market.environment, market.outcome);
    await client.query("commit");
    return true;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}
