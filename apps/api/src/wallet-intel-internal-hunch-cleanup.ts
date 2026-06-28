#!/usr/bin/env tsx

import type { PoolClient } from "pg";

import { pool } from "./db.js";
import { buildSnapshotDeltaTrackableActivitySql } from "./services/wallet-intel-market-eligibility.js";
import { refreshWalletMetrics } from "./services/wallet-metrics-refresh.js";

type Queryable = Pick<PoolClient, "query">;

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function countRows(client: Queryable, sql: string): Promise<number> {
  const result = await client.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

async function createBadRowTables(client: Queryable) {
  await client.query(`
    create temp table tmp_internal_hunch_bad_snapshots on commit drop as
    with hidden as (
      select
        venue,
        token_id,
        wallet_address
      from positions
      where position_scope = 'own'
        and coalesce(is_hidden, false) = true
    )
    select distinct
      s.id,
      s.wallet_id,
      s.venue,
      s.market_id,
      coalesce(s.outcome_side, '') as outcome_side,
      s.snapshot_at
    from wallet_position_snapshots s
    join wallets w on w.id = s.wallet_id
    join hidden hp
      on hp.venue = s.venue
     and hp.token_id = s.metadata->>'tokenId'
    where s.metadata->>'source' in (
      'hunch_own_position_open',
      'hunch_own_position_closed'
    )
      and (
        hp.wallet_address is null
        or btrim(hp.wallet_address) = ''
        or (w.chain = 'solana' and hp.wallet_address = w.address)
        or (w.chain <> 'solana' and lower(hp.wallet_address) = lower(w.address))
      )
  `);

  await client.query(`
    create temp table tmp_internal_hunch_bad_events on commit drop as
    with hidden as (
      select
        venue,
        token_id,
        wallet_address
      from positions
      where position_scope = 'own'
        and coalesce(is_hidden, false) = true
    ),
    hidden_snapshot_events as (
      select distinct
        e.id,
        e.wallet_id,
        e.venue,
        e.market_id,
        coalesce(e.outcome_side, '') as outcome_side,
        e.activity_type,
        date_trunc('hour', e.occurred_at) as hour_bucket
      from wallet_activity_events e
      join wallets w on w.id = e.wallet_id
      join hidden hp
        on hp.venue = e.venue
       and hp.token_id = e.metadata->>'tokenId'
      where e.source = 'snapshot_delta'
        and e.metadata->>'snapshotSource' in (
          'hunch_own_position_open',
          'hunch_own_position_closed'
        )
        and (
          hp.wallet_address is null
          or btrim(hp.wallet_address) = ''
          or (w.chain = 'solana' and hp.wallet_address = w.address)
          or (w.chain <> 'solana' and lower(hp.wallet_address) = lower(w.address))
        )
    ),
    first_import_events as (
      select distinct
        e.id,
        e.wallet_id,
        e.venue,
        e.market_id,
        coalesce(e.outcome_side, '') as outcome_side,
        e.activity_type,
        date_trunc('hour', e.occurred_at) as hour_bucket
      from wallet_activity_events e
      where e.source = 'snapshot_delta'
        and e.activity_type = 'delta'
        and e.metadata->>'snapshotSource' = 'hunch_own_position_open'
        and coalesce(nullif(e.metadata->>'prevShares', '')::numeric, 0) <= 0
        and coalesce(nullif(e.metadata->>'currShares', '')::numeric, 0) > 0
        and not exists (
          select 1
          from wallet_position_snapshots prev
          where prev.wallet_id = e.wallet_id
            and prev.venue = e.venue
            and prev.market_id = e.market_id
            and coalesce(prev.outcome_side, '') = coalesce(e.outcome_side, '')
            and prev.snapshot_at < e.occurred_at
        )
    )
    select * from hidden_snapshot_events
    union
    select * from first_import_events
  `);

  await client.query(`
    create temp table tmp_internal_hunch_affected_wallets on commit drop as
    select distinct wallet_id from tmp_internal_hunch_bad_snapshots
    union
    select distinct wallet_id from tmp_internal_hunch_bad_events
  `);
}

async function rebuildAffectedHourlyRows(client: Queryable) {
  await client.query(
    `
      insert into wallet_activity_hourly (
        wallet_id,
        venue,
        market_id,
        outcome_side,
        activity_type,
        hour_bucket,
        event_count,
        volume_usd,
        delta_shares_sum,
        price_weighted_sum,
        signed_delta_shares,
        signed_delta_usd,
        abs_delta_usd,
        max_abs_delta_usd,
        last_occurred_at,
        last_price,
        last_change_action,
        entered_late,
        counts_opened,
        counts_closed,
        counts_increased,
        counts_reduced
      )
      select
        e.wallet_id,
        e.venue,
        e.market_id,
        coalesce(e.outcome_side, '') as outcome_side,
        e.activity_type,
        e.hour_bucket,
        count(*)::int as event_count,
        sum(e.size_usd) as volume_usd,
        sum(e.delta_shares) as delta_shares_sum,
        sum(e.price_weighted) as price_weighted_sum,
        sum(e.signed_delta_shares) as signed_delta_shares,
        sum(e.signed_delta_usd) as signed_delta_usd,
        sum(e.abs_delta_usd) as abs_delta_usd,
        max(e.abs_delta_usd) as max_abs_delta_usd,
        max(e.occurred_at) as last_occurred_at,
        (array_agg(e.price order by e.occurred_at desc))[1] as last_price,
        (array_agg(e.change_action order by e.occurred_at desc))[1] as last_change_action,
        bool_or(e.entered_late) as entered_late,
        sum(case when e.change_action = 'OPENED' then 1 else 0 end) as counts_opened,
        sum(case when e.change_action = 'CLOSED' then 1 else 0 end) as counts_closed,
        sum(case when e.change_action = 'INCREASED' then 1 else 0 end) as counts_increased,
        sum(case when e.change_action = 'REDUCED' then 1 else 0 end) as counts_reduced
      from (
        select
          wa.wallet_id,
          wa.venue,
          wa.market_id,
          wa.outcome_side,
          wa.activity_type,
          wa.delta_shares,
          wa.size_usd,
          wa.price,
          wa.occurred_at,
          date_trunc('hour', wa.occurred_at) as hour_bucket,
          coalesce(
            wa.size_usd,
            abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
          ) as delta_usd,
          coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) as prev_shares,
          coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) as curr_shares,
          case
            when wa.delta_shares is not null and wa.price is not null
              then wa.price * wa.delta_shares
            else null
          end as price_weighted,
          (case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end)
            * coalesce(wa.delta_shares, 0) as signed_delta_shares,
          (case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end)
            * coalesce(
                wa.size_usd,
                abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
              ) as signed_delta_usd,
          abs(
            coalesce(
              wa.size_usd,
              abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
            )
          ) as abs_delta_usd,
          case
            when coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) <= 0
             and coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) > 0
              then 'OPENED'
            when coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) > 0
             and coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) <= 0
              then 'CLOSED'
            when coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0)
              > coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0)
             and coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) > 0
              then 'INCREASED'
            when coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0)
              < coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0)
             and coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) > 0
              then 'REDUCED'
            else null
          end as change_action,
          case
            when coalesce(um.close_time, um.expiration_time) is not null
             and coalesce(um.close_time, um.expiration_time) >= wa.occurred_at
             and coalesce(um.close_time, um.expiration_time) - wa.occurred_at
               <= interval '24 hours'
              then true
            else false
          end as entered_late
        from wallet_activity_events wa
        join (
          select distinct
            wallet_id,
            venue,
            market_id,
            outcome_side,
            activity_type,
            hour_bucket
          from tmp_internal_hunch_bad_events
        ) bad
          on bad.wallet_id = wa.wallet_id
         and bad.venue = wa.venue
         and bad.market_id = wa.market_id
         and bad.outcome_side = coalesce(wa.outcome_side, '')
         and bad.activity_type = wa.activity_type
         and bad.hour_bucket = date_trunc('hour', wa.occurred_at)
        left join unified_markets um on um.id = wa.market_id
        left join unified_events ue on ue.id = um.event_id
        where wa.activity_type in ('delta', 'trade', 'holder')
          and ${buildSnapshotDeltaTrackableActivitySql({
            activityAlias: "wa",
            marketAlias: "um",
            eventAlias: "ue",
          })}
      ) e
      group by
        e.wallet_id,
        e.venue,
        e.market_id,
        e.outcome_side,
        e.activity_type,
        e.hour_bucket
      on conflict (wallet_id, venue, market_id, outcome_side, activity_type, hour_bucket)
      do update set
        event_count = excluded.event_count,
        volume_usd = excluded.volume_usd,
        delta_shares_sum = excluded.delta_shares_sum,
        price_weighted_sum = excluded.price_weighted_sum,
        signed_delta_shares = excluded.signed_delta_shares,
        signed_delta_usd = excluded.signed_delta_usd,
        abs_delta_usd = excluded.abs_delta_usd,
        max_abs_delta_usd = excluded.max_abs_delta_usd,
        last_occurred_at = excluded.last_occurred_at,
        last_price = excluded.last_price,
        last_change_action = excluded.last_change_action,
        entered_late = excluded.entered_late,
        counts_opened = excluded.counts_opened,
        counts_closed = excluded.counts_closed,
        counts_increased = excluded.counts_increased,
        counts_reduced = excluded.counts_reduced,
        updated_at = now()
    `,
  );
}

async function deleteBadRows(
  client: Queryable,
): Promise<Record<string, number>> {
  const deletedSnapshots = await client.query(`
    delete from wallet_position_snapshots s
    using tmp_internal_hunch_bad_snapshots bad
    where s.id = bad.id
  `);

  const deletedEvents = await client.query(`
    delete from wallet_activity_events e
    using tmp_internal_hunch_bad_events bad
    where e.id = bad.id
  `);

  const deletedHourly = await client.query(`
    delete from wallet_activity_hourly wah
    using tmp_internal_hunch_bad_events bad
    where wah.wallet_id = bad.wallet_id
      and wah.venue = bad.venue
      and wah.market_id = bad.market_id
      and wah.outcome_side = bad.outcome_side
      and wah.activity_type = bad.activity_type
      and wah.hour_bucket = bad.hour_bucket
  `);

  await rebuildAffectedHourlyRows(client);

  const deletedBaseline = await client.query(`
    delete from wallet_activity_baseline b
    using tmp_internal_hunch_affected_wallets aw
    where b.wallet_id = aw.wallet_id
  `);

  const deletedExposure = await client.query(`
    delete from wallet_position_exposure e
    using tmp_internal_hunch_affected_wallets aw
    where e.wallet_id = aw.wallet_id
  `);

  const deletedInferred = await client.query(`
    delete from wallet_inferred_outcomes i
    using tmp_internal_hunch_affected_wallets aw
    where i.wallet_id = aw.wallet_id
  `);

  return {
    snapshots: deletedSnapshots.rowCount ?? 0,
    events: deletedEvents.rowCount ?? 0,
    hourly: deletedHourly.rowCount ?? 0,
    baseline: deletedBaseline.rowCount ?? 0,
    exposure: deletedExposure.rowCount ?? 0,
    inferred: deletedInferred.rowCount ?? 0,
  };
}

async function main() {
  const execute = hasFlag("--execute");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createBadRowTables(client);

    const snapshotRows = await countRows(
      client,
      "select count(*) from tmp_internal_hunch_bad_snapshots",
    );
    const eventRows = await countRows(
      client,
      "select count(*) from tmp_internal_hunch_bad_events",
    );
    const affectedWallets = await countRows(
      client,
      "select count(*) from tmp_internal_hunch_affected_wallets",
    );

    console.log("[wallets:intel:internal-hunch-cleanup] scan", {
      execute,
      snapshotRows,
      eventRows,
      affectedWallets,
    });

    if (!execute) {
      await client.query("rollback");
      console.log(
        "[wallets:intel:internal-hunch-cleanup] dry run complete; pass --execute to delete rows",
      );
      return;
    }

    const affectedRows = await client.query<{ wallet_id: string }>(
      "select wallet_id from tmp_internal_hunch_affected_wallets order by wallet_id",
    );
    const affectedWalletIds = affectedRows.rows.map((row) => row.wallet_id);
    const deleted = await deleteBadRows(client);
    if (affectedWalletIds.length > 0) {
      await refreshWalletMetrics(client, {
        walletIds: affectedWalletIds,
        asOf: new Date(),
        logPrefix: "[wallets:intel:internal-hunch-cleanup]",
      });
    }

    await client.query("commit");
    console.log("[wallets:intel:internal-hunch-cleanup] done", {
      deleted,
      affectedWallets: affectedWalletIds.length,
    });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[wallets:intel:internal-hunch-cleanup] failed", error);
  process.exit(1);
});
