import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON,
  parseSignalPriceSnapshotV1,
} from "./signal-publication-contract.js";
import {
  houseConfirmationIsFresh,
  usdRaw,
  type HouseTraderPolicy,
} from "./house-trader-policy.js";

export type Account = {
  user_id: string;
  controller: string | null;
  deposit_wallet: string | null;
  active: boolean;
  revision: number;
  settings: HouseTraderPolicy | null;
  cursor_at: string;
  cursor_id: string;
  snapshot: Record<string, unknown> | null;
  worker_status: Record<string, unknown>;
  position_cursor: string | null;
};
export type ActionKind = "setup" | "buy" | "sell" | "redeem" | "withdraw";
export type Action = {
  id: string;
  account_user_id: string;
  action_key: string;
  kind: ActionKind;
  state: string;
  claim_token: string | null;
  market_id: string | null;
  event_id: string | null;
  token_id: string | null;
  outcome: "YES" | "NO" | null;
  revision: number;
  budget_raw: string;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  reference: string | null;
  protected_submission: string | null;
  reason: string | null;
  created_at: Date;
};

export async function account(
  db: DbQuery,
  lock = false,
): Promise<Account | null> {
  return (
    (
      await db.query<Account>(
        `select *, cursor_at::text from house_trader_account where singleton ${lock ? "for update" : ""}`,
      )
    ).rows[0] ?? null
  );
}

export async function houseSellPosition(db: DbQuery, job: Action) {
  const id = job.request.positionId;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    return null;
  const {
    rows: [entry],
  } = await db.query<Action>(
    `select * from house_trader_actions
      where id=$1 and account_user_id=$2 and kind='buy' and state='filled'
        and market_id=$3 and event_id=$4 and token_id=$5 and outcome=$6`,
    [
      id,
      job.account_user_id,
      job.market_id,
      job.event_id,
      job.token_id,
      job.outcome,
    ],
  );
  return entry ?? null;
}

export async function enqueue(
  db: DbQuery,
  a: Account,
  input: {
    key: string;
    kind: ActionKind;
    market?: string;
    event?: string;
    token?: string;
    outcome?: "YES" | "NO";
    request?: Record<string, unknown>;
  },
) {
  return (
    (
      await db.query<Action>(
        `insert into house_trader_actions(account_user_id,action_key,kind,state,
       revision,market_id,event_id,token_id,outcome,request)
     values($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9)
     on conflict(account_user_id,action_key) do nothing returning *`,
        [
          a.user_id,
          input.key,
          input.kind,
          a.revision,
          input.market ?? null,
          input.event ?? null,
          input.token ?? null,
          input.outcome ?? null,
          input.request ?? {},
        ],
      )
    ).rows[0] ?? null
  );
}

export async function finish(
  db: DbQuery,
  job: Action,
  state: string,
  reason: string | null,
  result: Record<string, unknown> = {},
) {
  await db.query(
    `update house_trader_actions set state=$2,reason=$3,result=result || $4::jsonb,
       updated_at=now() where id=$1 and claim_token is not distinct from $5::uuid
        and (state not in ('done','skipped','filled') or state=$2 or (state='filled' and $2='done'))`,
    [job.id, state, reason, result, job.claim_token],
  );
}

export async function boundary(
  pool: Pool,
  job: Action,
  reference: string,
  extra: Record<string, unknown> = {},
) {
  await tx(pool, async (db) => {
    const a = await account(db, true);
    if (
      !a ||
      (job.request.automatic === true &&
        (!a.active || a.revision !== job.revision))
    )
      throw new Error("strategy_changed_or_paused");
    if (job.kind === "buy" && job.request.automatic === true) {
      const reason = await houseBuyEligibility(db, a, job);
      if (reason) throw new Error(reason);
    }
    if (
      (job.kind === "withdraw" ||
        (job.kind === "sell" && job.request.automatic !== true)) &&
      !houseConfirmationIsFresh(job.request.confirmedAt)
    )
      throw new Error("manual_confirmation_expired");
    const { rowCount } = await db.query(
      `update house_trader_actions set state='submitting',reference=$2,committed_at=now(),
        result=result || $3::jsonb,updated_at=now() where id=$1 and state='working'
          and reference is null and claim_token=$4::uuid
          and (kind<>'buy' or budget_raw>0)`,
      [job.id, reference, extra, job.claim_token],
    );
    if (rowCount !== 1) throw new Error("submission_already_claimed");
  });
}

export const houseBuyEligibilitySql = `select
    note_row.created_at >= now()-$7::int*interval '1 minute'
      and note_row.created_at <= now() as fresh,
    market_row.category,
    coalesce(market_row.close_time,market_row.expiration_time) as closes,
    now() as checked_at,
    exists(select 1 from house_trader_actions prior
      where prior.account_user_id=$8 and prior.id<>$9 and prior.kind='buy'
        and prior.market_id=$2 and prior.budget_raw>0
        and prior.state in ('working','submitting','submitted','filled')) as duplicate
  from ai_notes note_row
  join unified_markets market_row on market_row.id=note_row.source_id
  where note_row.id=$1 and note_row.source_id=$2 and note_row.status='active'
    and note_row.note_type='signal' and note_row.producer_type='holder_research'
    and note_row.source_kind='market' and note_row.lineage->>'revision_kind'='initial'
    and note_row.metrics @> $6::jsonb
    and note_row.direction=case $3 when 'YES' then 'up' else 'down' end
    and note_row.metrics->'socialInstrumentV1'->>'generation'=$5
    and note_row.metrics->'socialInstrumentV1'->>'marketId'=$2
    and note_row.metrics->'socialInstrumentV1'->>'venue'='polymarket'
    and note_row.metrics->'socialInstrumentV1'->>'outcome'=$3
    and note_row.metrics->'socialInstrumentV1'->>'tokenId'=$4
    and market_row.status='ACTIVE' and market_row.venue='polymarket' and market_row.event_id=$10
    and exists(select 1 from ai_note_targets target_row
      where target_row.note_id=note_row.id and target_row.target_kind='market'
        and target_row.target_id=market_row.id and target_row.is_primary)
    and (select min(token_row.token_id)
      from unified_market_tokens token_row
      where token_row.market_id=market_row.id and token_row.outcome_side=$3
      having count(distinct token_row.token_id)=1)=$4`;

export async function houseBuyEligibility(
  db: DbQuery,
  a: Account,
  job: Action,
) {
  if (!a.active || !a.settings || a.revision !== job.revision)
    return "strategy_changed_or_paused";
  if (
    !job.market_id ||
    !job.event_id ||
    !job.outcome ||
    !job.token_id ||
    typeof job.request.noteId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      job.request.noteId,
    ) ||
    typeof job.request.generation !== "string"
  )
    return "signal_or_instrument_inactive";
  const {
    rows: [source],
  } = await db.query<{
    fresh: boolean;
    category: string | null;
    closes: Date | null;
    checked_at: Date;
    duplicate: boolean;
  }>(houseBuyEligibilitySql, [
    job.request.noteId,
    job.market_id,
    job.outcome,
    job.token_id,
    job.request.generation,
    HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON,
    a.settings.signalAgeMinutes,
    a.user_id,
    job.id,
    job.event_id,
  ]);
  if (!source) return "signal_or_instrument_inactive";
  if (!source.fresh) return "signal_expired";
  if (source.duplicate) return "position_open";
  const minutes = source.closes
    ? (source.closes.getTime() - source.checked_at.getTime()) / 60_000
    : 0;
  if (
    !source.closes ||
    minutes <= 0 ||
    minutes < a.settings.minCloseMinutes ||
    minutes > a.settings.maxCloseMinutes
  )
    return "market_outside_close_window";
  if (
    a.settings.categories.length &&
    !a.settings.categories.includes(source.category ?? "")
  )
    return "category_filtered";
  return null;
}

export async function hasHouseExitInFlight(
  db: DbQuery,
  accountId: string,
  positionId: string,
  recentAutomaticSkip: boolean,
  excludedActionId?: string,
) {
  const {
    rows: [row],
  } = await db.query<{ blocked: boolean }>(
    `select exists(select 1 from house_trader_actions exit_row
       where exit_row.account_user_id=$1 and exit_row.kind in ('sell','redeem')
         and ($4::uuid is null or exit_row.id<>$4)
         and exit_row.request->>'positionId'=$2 and (
           exit_row.state in ('queued','working','submitting','submitted')
           or ($4::uuid is null and exit_row.state='review' and exit_row.reason='confirm_preview'
             and exit_row.updated_at>now()-interval '3 minutes')
           or ($3 and exit_row.state='skipped' and
             (exit_row.kind='redeem' or exit_row.request->>'automatic'='true')
             and exit_row.updated_at>now()-interval '5 minutes')
         )) as blocked`,
    [accountId, positionId, recentAutomaticSkip, excludedActionId ?? null],
  );
  return row.blocked;
}

export async function recordHouseWorker(
  db: DbQuery,
  userId: string,
  status: Record<string, unknown>,
) {
  await db.query(
    "update house_trader_account set worker_status=worker_status || $2::jsonb where user_id=$1",
    [userId, status],
  );
}

export async function confirmHousePreview(
  db: DbQuery,
  userId: string,
  actionId: string,
  adminId: string,
) {
  const {
    rows: [preview],
  } = await db.query<Pick<Action, "kind" | "request">>(
    `select kind,request from house_trader_actions where id=$1 and account_user_id=$2
      and kind in ('sell','withdraw') and state='review' and reference is null
      and reason='confirm_preview' and updated_at>now()-interval '3 minutes'`,
    [actionId, userId],
  );
  if (!preview) return { error: "preview_expired_or_used" };
  if (
    preview.kind === "sell" &&
    typeof preview.request.positionId === "string" &&
    (await hasHouseExitInFlight(
      db,
      userId,
      preview.request.positionId,
      false,
      actionId,
    ))
  )
    return { error: "position_exit_already_pending" };
  const updated = await db.query(
    `update house_trader_actions set state='queued',
       request=request || jsonb_build_object('confirmedBy',$3::text,'confirmedAt',now()),updated_at=now()
      where id=$1 and account_user_id=$2 and state='review' and reference is null
        and reason='confirm_preview' and updated_at>now()-interval '3 minutes'`,
    [actionId, userId, adminId],
  );
  return updated.rowCount === 1
    ? { ok: true }
    : { error: "preview_expired_or_used" };
}

export const houseAdminActivitySql = `with recent as materialized (
    select id from house_trader_actions where account_user_id=$1
      order by created_at desc,id desc limit 60
  ), outstanding as materialized (
    select id from house_trader_actions where account_user_id=$1
      and state in ('queued','working','submitting','submitted','review')
      and (state<>'review' or kind='setup' or updated_at>now()-interval '3 minutes')
      order by created_at,id limit 20
  )
  select action_row.id, action_row.kind, action_row.state, action_row.market_id,
     action_row.token_id, action_row.outcome, action_row.revision, action_row.request,
     action_row.result, action_row.reference, action_row.reason, action_row.created_at, action_row.updated_at
  from (select id from recent union select id from outstanding) visible
  join house_trader_actions action_row on action_row.id=visible.id
  order by action_row.created_at desc,action_row.id desc`;

export async function reserveBuy(
  pool: Pool,
  job: Action,
  spend: bigint,
  balance: bigint,
) {
  return tx(pool, async (db) => {
    const a = await account(db, true);
    if (!a?.active || !a.settings || a.revision !== job.revision)
      return "strategy_changed_or_paused";
    if (spend <= 0n) return "invalid_order_amount";
    const aPolicy = a.settings;
    const usage = (
      await db.query<{
        daily: string;
        exposure: string;
        event: string;
        duplicate: boolean;
        pending_cash: string;
      }>(
        `select
        coalesce(sum(budget_raw) filter(where kind='buy' and
          (state='working' or committed_at >=
          date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')),0)::text as daily,
        coalesce(sum(budget_raw) filter(where kind='buy' and state in ('working','submitting','submitted','filled')),0)::text as exposure,
        coalesce(sum(budget_raw) filter(where kind='buy' and event_id=$3 and state in ('working','submitting','submitted','filled')),0)::text as event,
        coalesce(bool_or(kind='buy' and budget_raw>0 and market_id=$4 and state in ('working','submitting','submitted','filled')),false) as duplicate,
        coalesce(sum(budget_raw) filter(where kind='buy' and state in ('submitting','submitted')),0)::text as pending_cash
       from house_trader_actions where account_user_id=$1 and id<>$2 and kind='buy' and state<>'skipped'
         and (state in ('working','submitting','submitted','filled') or committed_at >=
              date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')`,
        [a.user_id, job.id, job.event_id, job.market_id],
      )
    ).rows[0];
    if (usage.duplicate) return "position_open";
    if (spend + BigInt(usage.pending_cash) > balance)
      return "insufficient_unreserved_pusd";
    if (spend > usdRaw(aPolicy.maxOrderUsd)) return "order_limit";
    if (BigInt(usage.daily) + spend > usdRaw(aPolicy.dailyBuyUsd))
      return "daily_limit";
    if (BigInt(usage.exposure) + spend > usdRaw(aPolicy.capitalUsd))
      return "capital_limit";
    if (BigInt(usage.event) + spend > usdRaw(aPolicy.eventExposureUsd))
      return "event_limit";
    const changed = await db.query(
      "update house_trader_actions set budget_raw=$2 where id=$1 and state='working' and claim_token=$3::uuid and reference is null",
      [job.id, spend.toString(), job.claim_token],
    );
    return changed.rowCount === 1 ? null : "claim_lost";
  });
}

export async function reserveHouseModelCost(
  pool: Pool,
  job: Action,
  allowance: bigint,
) {
  return tx(pool, async (db) => {
    const current = await account(db, true);
    if (
      !current?.active ||
      !current.settings ||
      current.revision !== job.revision
    )
      return "ai_strategy_changed";
    const { rowCount } = await db.query(
      `update house_trader_actions set result=result || jsonb_build_object(
         'aiReservedRaw',$2::text,'aiReservedAt',now())
        where id=$1 and account_user_id=$3 and state='working' and claim_token=$5::uuid
          and reference is null and not result ? 'aiReservedRaw' and
        coalesce((select sum(coalesce(result->>'aiChargedRaw',result->>'aiReservedRaw')::bigint)
          from house_trader_actions
          where account_user_id=$3 and created_at >= now()-interval '2 days'
            and (result->>'aiReservedAt')::timestamptz >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)
          + $2::bigint <= $4::bigint`,
      [
        job.id,
        allowance.toString(),
        current.user_id,
        usdRaw(current.settings.aiDailyUsd).toString(),
        job.claim_token,
      ],
    );
    return rowCount === 1 ? null : "ai_budget_or_claim_unavailable";
  });
}

export async function pollSignals(pool: Pool) {
  return tx(pool, async (db) => {
    const a = await account(db, true);
    if (!a?.active || !a.settings)
      return { read: 0, queued: 0, missingEvidence: 0 };
    const { rows } = await db.query<{
      id: string;
      created_at: string;
      market_id: string | null;
      token: string | null;
      outcome: string | null;
      price: unknown;
      generation: string | null;
      event_id: string | null;
      category: string | null;
      closes: Date | null;
    }>(
      `with source_page as materialized (
          select note_row.id,note_row.created_at,note_row.source_id,
            case note_row.direction when 'up' then 'YES' when 'down' then 'NO' end as outcome,
            note_row.metrics->'signalPriceSnapshotV1' as price,
            note_row.metrics->'socialInstrumentV1' as instrument
          from ai_notes note_row
          where note_row.note_type='signal' and note_row.status='active'
            and note_row.producer_type='holder_research' and note_row.source_kind='market'
            and note_row.lineage->>'revision_kind'='initial'
            and note_row.metrics @> $4::jsonb
            and note_row.created_at >= greatest($1::timestamptz,now()-$3::int * interval '1 minute')
            and (note_row.created_at,note_row.id)>($1::timestamptz,$2::uuid)
          order by note_row.created_at,note_row.id limit 32
        )
        select source_page.id,source_page.created_at::text,
          market_row.id as market_id,canonical_token.token_id as token,
          source_page.outcome,source_page.price,source_page.instrument->>'generation' as generation,
          market_row.event_id,market_row.category,
          coalesce(market_row.close_time,market_row.expiration_time) as closes
        from source_page
        left join unified_markets market_row on market_row.id=source_page.source_id
          and market_row.venue='polymarket' and market_row.status='ACTIVE'
          and exists(select 1 from ai_note_targets target_row where target_row.note_id=source_page.id
            and target_row.target_kind='market' and target_row.target_id=source_page.source_id and target_row.is_primary)
          and source_page.instrument->>'marketId'=source_page.source_id
          and source_page.instrument->>'venue'='polymarket'
          and source_page.instrument->>'outcome'=source_page.outcome
        left join lateral (
          select min(token_row.token_id) as token_id
          from unified_market_tokens token_row
          where token_row.market_id=market_row.id and token_row.outcome_side=source_page.outcome
          having count(distinct token_row.token_id)=1
        ) canonical_token on canonical_token.token_id=source_page.instrument->>'tokenId'
        order by source_page.created_at,source_page.id`,
      [
        a.cursor_at,
        a.cursor_id,
        a.settings.signalAgeMinutes,
        HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON,
      ],
    );
    let queued = 0;
    let missingEvidence = 0;
    for (const row of rows) {
      if (
        !row.market_id ||
        !row.event_id ||
        !row.token ||
        !/^\d{1,78}$/.test(row.token) ||
        (row.outcome !== "YES" && row.outcome !== "NO") ||
        !row.generation
      ) {
        missingEvidence++;
        continue;
      }
      const price = parseSignalPriceSnapshotV1(row.price);
      if (
        !price ||
        price.venue !== "polymarket" ||
        price.marketId !== row.market_id ||
        price.displaySide !== row.outcome ||
        Date.parse(price.asOf) > Date.parse(row.created_at)
      ) {
        missingEvidence++;
        continue;
      }
      const entry = price[row.outcome].ask;
      if (entry == null || entry <= 0 || entry >= 1) {
        missingEvidence++;
        continue;
      }
      const job = await enqueue(db, a, {
        key: `signal:${row.id}:${row.market_id}:${row.outcome}`,
        kind: "buy",
        market: row.market_id,
        event: row.event_id,
        token: row.token,
        outcome: row.outcome,
        request: {
          automatic: true,
          noteId: row.id,
          entry,
          generation: row.generation,
          publishedAt: row.created_at,
          category: row.category,
          closesAt: row.closes?.toISOString(),
        },
      });
      if (job) queued++;
    }
    const last = rows.at(-1);
    if (last)
      await db.query(
        "update house_trader_account set cursor_at=$1,cursor_id=$2 where singleton",
        [last.created_at, last.id],
      );
    return { read: rows.length, queued, missingEvidence };
  });
}
