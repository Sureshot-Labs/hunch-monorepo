/** Exclude protocol infrastructure before LIMIT; smart-wallet traders remain eligible. */
export const WALLET_INTEL_AUTO_TRACKED_SQL = `
      select
        w.id::text as wallet_id,
        w.address,
        w.chain,
        wts.venue,
        array_agg(distinct wts.source order by wts.source) as sources,
        max(wts.priority) as priority
      from wallet_tracking_subjects wts
      join wallets w on w.id = wts.wallet_id
      where wts.status = 'active'
        and wts.source in ('whale', 'recent_top_holder', 'signal_candidate')
        and wts.venue = any($6::text[])
        and (wts.venue <> 'polymarket' or lower(w.address) <> all($7::text[]))
        and (
          $5::int <= 0 or
          (
            wts.last_selected_at is not null and
            wts.last_selected_at >= $2::timestamptz - ($5::int * interval '1 day')
          )
        )
        and (
          (wts.venue = 'polymarket' and w.chain = 'polygon') or
          (wts.venue = 'limitless' and w.chain = 'base') or
          (wts.venue = 'kalshi' and w.chain = 'solana')
        )
        and (
          wts.last_refreshed_at is null or
          wts.last_refreshed_at <= $2::timestamptz - ($3::int * interval '1 hour')
        )
        and (
          wts.last_refresh_attempted_at is null or
          wts.last_refreshed_at >= wts.last_refresh_attempted_at or
          wts.last_refresh_attempted_at <= $2::timestamptz - ($4::int * interval '1 minute')
        )
      group by w.id, w.address, w.chain, wts.venue
      order by
        max(wts.priority) desc,
        min(coalesce(wts.last_refreshed_at, 'epoch'::timestamptz)) asc,
        min(wts.created_at) asc
      limit $1
    `;
