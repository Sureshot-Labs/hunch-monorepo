import { fetchActiveRuntimePolicy } from "@hunch/db";
import {
  hip4ReadMarketSchema,
  hip4Identity,
  hip4BinaryPayout,
  hip4ReadPolicySchema,
  hip4TradeSchema,
  hip4RawSnapshotSchema,
  type Hip4Environment,
  type Hip4ReadMarket,
  type Hip4Attempt,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import type { Pool } from "pg";
import type { z } from "zod";
import { mergeHip4Volume } from "./hip4-volume.js";
import {
  insertHip4Trades,
  insertHip4Intervals,
  type Hip4Interval,
} from "./hip4-history.js";

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

export async function recordHip4MetadataFailure(
  pool: Pool,
  environment: Hip4Environment,
  outcomes: number[],
  attempt: Hip4Attempt,
) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("begin");
    for (const outcome of [...new Set(outcomes)].sort((a, b) => a - b)) {
      const marketId = hip4Identity(environment, outcome).marketId;
      // Same serialization boundary as REST/WS snapshot writes. A direct
      // jsonb update can otherwise be lost after a concurrent reader's SELECT.
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [marketId],
      );
      await client.query(
        `update hip4_read_markets set read_model=jsonb_set(read_model,'{metadataAttempt}',$2::jsonb)
         where market_id=$1 and coalesce(read_model->'metadataAttempt'->>'at','') < $3`,
        [marketId, JSON.stringify(attempt), attempt.at],
      );
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
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

export const HIP4_CATALOG_READ_SQL = `select read_model from hip4_read_markets
     where environment=$1 and outcome>$2 order by outcome limit $3`;

export async function readHip4Markets(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  allowlist: number[] | null,
  after: number,
  limit: number,
) {
  const result =
    allowlist === null
      ? await db.query(HIP4_CATALOG_READ_SQL, [environment, after, limit])
      : await db.query(
          `
    select read_model from hip4_read_markets
    where environment = $1 and outcome = any($2::bigint[]) and outcome > $3
    order by outcome limit $4
  `,
          [environment, allowlist, after, limit],
        );
  return result.rows.map((row) => hip4ReadMarketSchema.parse(row.read_model));
}

// Only choose a bounded live subset. Catalog breadth never multiplies WS
// subscriptions or REST book/trade requests.
export async function readHip4LiveOutcomes(
  db: Pick<Pool, "query">,
  policy: Hip4ReadPolicy,
  hotTokens: string[],
): Promise<number[]> {
  const result = await db.query(
    `select outcome from hip4_read_markets
     where environment=$1 and read_model->>'status'<>'settled'
     and ($2::bigint[] is null or outcome=any($2))
     order by (('hyperliquid:' || environment || ':' || (outcome*10)::text)=any($3::text[])
       or ('hyperliquid:' || environment || ':' || (outcome*10+1)::text)=any($3::text[])) desc, outcome
     limit $4`,
    [
      policy.environment,
      policy.catalogMode === "all" ? null : policy.outcomeAllowlist,
      hotTokens,
      policy.maxLiveOutcomes,
    ],
  );
  return result.rows.map((row) => Number(row.outcome));
}

export async function readHip4PendingOutcomes(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  after: number,
  limit: number,
): Promise<number[]> {
  const result = await db.query(
    `select outcome from hip4_read_markets where environment=$1
     and read_model->>'status'<>'settled'
     order by (outcome>$2) desc, outcome limit $3`,
    [environment, after, limit],
  );
  return result.rows.map((row) => Number(row.outcome));
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
    ? {
        market: hip4ReadMarketSchema.parse(row.read_model),
        raw: hip4RawSnapshotSchema.parse(row.raw),
      }
    : null;
}

export async function readHip4SettledOutcomes(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  allowlist: number[],
): Promise<number[]> {
  const result = await db.query(
    "select outcome from hip4_read_markets where environment=$1 and outcome=any($2::bigint[]) and read_model->>'status'='settled'",
    [environment, allowlist],
  );
  return result.rows.map((row) => Number(row.outcome));
}

export async function persistHip4Market(
  pool: Pool,
  input: {
    market: Hip4ReadMarket;
    raw: unknown;
    trades: z.infer<typeof hip4TradeSchema>[];
    advanceCursor?: boolean;
    intervals?: Hip4Interval[];
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
    const olderMetadata =
      stored &&
      Date.parse(stored.market.fetchedAt) > Date.parse(input.market.fetchedAt);
    let market = hip4ReadMarketSchema.parse(
      olderMetadata ? stored.market : input.market,
    );
    let raw = olderMetadata ? stored.raw : input.raw;
    if (stored) {
      market = { ...market, ...mergeHip4Volume(stored.market, input.market) };
      const latestAttempt = <T extends { at: string }>(
        previous: T | null | undefined,
        incoming: T | null | undefined,
      ) => ((previous?.at ?? "") >= (incoming?.at ?? "") ? previous : incoming);
      market.metadataAttempt = latestAttempt(
        stored.market.metadataAttempt,
        input.market.metadataAttempt,
      );
      market.settlementAttempt = latestAttempt(
        stored.market.settlementAttempt,
        input.market.settlementAttempt,
      );
      const previous = stored.market.coverage;
      const incoming = input.market.coverage;
      const observed =
        (previous.tradeObservedAt ?? "") >= (incoming.tradeObservedAt ?? "")
          ? previous
          : incoming;
      market.coverage = {
        ...market.coverage,
        trades: observed.trades,
        tradeObservedAt: observed.tradeObservedAt,
        tradeWindowStart: observed.tradeWindowStart,
        tradeWindowEnd: observed.tradeWindowEnd,
        tradeAttempt: latestAttempt(
          previous.tradeAttempt,
          incoming.tradeAttempt,
        ),
      };
    }
    // Metadata age cannot order quotes. Serialize per-side provider times under
    // the same lock as publication (REST and WS may race). Ties are idempotent.
    if (stored)
      market.sides = market.sides.map((side, index) => {
        const incoming = input.market.sides[index];
        const previous = stored.market.sides[index];
        const winner =
          stored.market.settlement ||
          (previous.bookAt &&
            (!incoming.bookAt || previous.bookAt >= incoming.bookAt))
            ? previous
            : incoming;
        const attempt =
          (previous.bookAttempt?.at ?? "") > (incoming.bookAttempt?.at ?? "")
            ? previous.bookAttempt
            : incoming.bookAttempt;
        return {
          ...side,
          bid: winner.bid,
          ask: winner.ask,
          bookAt: winner.bookAt,
          bookState: winner.bookState,
          bookAttempt: attempt,
        };
      });
    if (
      input.market.settlement &&
      (!stored?.market.settlement ||
        (input.market.settlement.checkedAt ??
          input.market.settlement.observedAt) >=
          (stored.market.settlement.checkedAt ??
            stored.market.settlement.observedAt))
    ) {
      market = {
        ...market,
        settlement: input.market.settlement,
        status: "settled",
        sides: market.sides.map((side, index) => ({
          ...side,
          payout: input.market.sides[index].payout,
        })),
      };
      raw = {
        ...hip4RawSnapshotSchema.parse(raw),
        settlement: hip4RawSnapshotSchema.parse(input.raw).settlement,
      };
    }
    if (
      stored?.market.settlement &&
      (!market.settlement ||
        (stored.market.settlement.checkedAt ??
          stored.market.settlement.observedAt) >
          (market.settlement.checkedAt ?? market.settlement.observedAt))
    ) {
      market = {
        ...market,
        status: "settled",
        settlement: stored.market.settlement,
        sides: market.sides.map((side, index) => ({
          ...side,
          payout: stored.market.sides[index].payout,
        })),
      };
      raw = {
        ...hip4RawSnapshotSchema.parse(raw),
        settlement: stored.raw.settlement,
      };
    }
    if (stored?.market.settlement && market.settlement) {
      market.settlement.observedAt = stored.market.settlement.observedAt;
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
        JSON.stringify(raw),
      ],
    );
    await insertHip4Trades(client, market, input.trades);
    await insertHip4Intervals(client, market.marketId, input.intervals ?? []);
    if (input.advanceCursor !== false)
      await advanceHip4Cursor(client, market.environment, market.outcome);
    await client.query("commit");
    return !olderMetadata;
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
