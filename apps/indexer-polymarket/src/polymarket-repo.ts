import { chunkArray } from "@hunch/shared";
import type { ChangeReasonTelemetry } from "@hunch/db";
import { pool } from "./db.js";
import type {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
} from "./mappers.js";

export type PolymarketEventRow = ReturnType<typeof mapPolymarketEventRow>;
export type PolymarketMarketRow = ReturnType<typeof mapPolymarketMarketRow>;

export type PolymarketUpsertStats = {
  inputRows: number;
  dedupedRows: number;
  changedRows: number;
  skippedRows: number;
  batches: number;
  upsertedRows: number;
  changeReasons: ChangeReasonTelemetry;
};

function emptyChangeReasonTelemetry(): ChangeReasonTelemetry {
  return { primary: {} };
}

function incrementReasonCounts(
  target: Record<string, number>,
  source: unknown,
): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [reason, rawCount] of Object.entries(source)) {
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count <= 0) continue;
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return Array.from(map.values());
}

function emptyPolymarketUpsertStats(inputRows = 0): PolymarketUpsertStats {
  return {
    inputRows,
    dedupedRows: 0,
    changedRows: 0,
    skippedRows: 0,
    batches: 0,
    upsertedRows: 0,
    changeReasons: emptyChangeReasonTelemetry(),
  };
}

function rawWithoutSourceTimestampSql(alias: string): string {
  return `(coalesce(${alias}.raw, '{}'::jsonb) - 'updatedAt' - 'updated_at')`;
}

// Only fields that are not already represented faithfully by source columns
// and are still consumed by normalization, maintenance, or trading reads.
// Gamma embeds volatile series metrics in every event. Comparing the complete
// series object rewrites thousands of otherwise unchanged event rows whenever
// series volume, liquidity, comments, or updatedAt changes.
function eventRawBusinessProjectionSql(alias: string): string {
  return `jsonb_build_object(
    'category', ${alias}.raw->'category',
    'tags', ${alias}.raw->'tags',
    'series', jsonb_build_object(
      'slug', ${alias}.raw->'series'->0->'slug',
      'ticker', ${alias}.raw->'series'->0->'ticker',
      'title', ${alias}.raw->'series'->0->'title'
    ),
    'seriesSlug', ${alias}.raw->'seriesSlug',
    'seriesTitle', ${alias}.raw->'seriesTitle',
    'series_slug', ${alias}.raw->'series_slug',
    'series_title', ${alias}.raw->'series_title',
    'sponsorName', ${alias}.raw->'sponsorName',
    'sponsorImage', ${alias}.raw->'sponsorImage',
    'twitterCardImage', ${alias}.raw->'twitterCardImage'
  )`;
}

function marketRawBusinessProjectionSql(alias: string): string {
  return `jsonb_build_object(
    'makerBaseFee', ${alias}.raw->'makerBaseFee',
    'takerBaseFee', ${alias}.raw->'takerBaseFee',
    'maker_fee_bps', ${alias}.raw->'maker_fee_bps',
    'taker_fee_bps', ${alias}.raw->'taker_fee_bps',
    'negRiskMarketID', ${alias}.raw->'negRiskMarketID',
    'fee', ${alias}.raw->'fee',
    'ammType', ${alias}.raw->'ammType',
    'denominationToken', ${alias}.raw->'denominationToken',
    'lowerBound', ${alias}.raw->'lowerBound',
    'upperBound', ${alias}.raw->'upperBound',
    'lowerBoundDate', ${alias}.raw->'lowerBoundDate',
    'upperBoundDate', ${alias}.raw->'upperBoundDate',
    'marketType', ${alias}.raw->'marketType',
    'formatType', ${alias}.raw->'formatType',
    'category', ${alias}.raw->'category',
    'tags', ${alias}.raw->'tags',
    'question', ${alias}.raw->'question',
    'title', ${alias}.raw->'title',
    'description', ${alias}.raw->'description'
  )`;
}

// Upsert Polymarket event to polymarket_events table
export async function upsertPolymarketEvent(row: PolymarketEventRow) {
  const q = `
  INSERT INTO polymarket_events(
    id, ticker, slug, title, description, resolution_source, 
    start_date, creation_date, end_date, category, image, icon, 
    active, closed, archived, new, featured, restricted, 
    liquidity, volume, open_interest, created_by, created_at, updated_at, 
    competitive, volume24hr, volume1wk, volume1mo, volume1yr, 
    enable_order_book, liquidity_clob, neg_risk, comment_count, raw
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
  ON CONFLICT (id) DO UPDATE SET
    ticker=EXCLUDED.ticker,
    slug=EXCLUDED.slug,
    title=EXCLUDED.title,
    description=EXCLUDED.description,
    resolution_source=EXCLUDED.resolution_source,
    start_date=EXCLUDED.start_date,
    creation_date=EXCLUDED.creation_date,
    end_date=EXCLUDED.end_date,
    category=EXCLUDED.category,
    image=EXCLUDED.image,
    icon=EXCLUDED.icon,
    active=EXCLUDED.active,
    closed=EXCLUDED.closed,
    archived=EXCLUDED.archived,
    new=EXCLUDED.new,
    featured=EXCLUDED.featured,
    restricted=EXCLUDED.restricted,
    liquidity=EXCLUDED.liquidity,
    volume=EXCLUDED.volume,
    open_interest=EXCLUDED.open_interest,
    created_by=EXCLUDED.created_by,
    created_at=EXCLUDED.created_at,
    updated_at=EXCLUDED.updated_at,
    competitive=EXCLUDED.competitive,
    volume24hr=EXCLUDED.volume24hr,
    volume1wk=EXCLUDED.volume1wk,
    volume1mo=EXCLUDED.volume1mo,
    volume1yr=EXCLUDED.volume1yr,
    enable_order_book=EXCLUDED.enable_order_book,
    liquidity_clob=EXCLUDED.liquidity_clob,
    neg_risk=EXCLUDED.neg_risk,
    comment_count=EXCLUDED.comment_count,
    raw=EXCLUDED.raw,
    updated_at_db=now()
  RETURNING id`;

  const { rows } = await pool.query(q, [
    row.id,
    row.ticker,
    row.slug,
    row.title,
    row.description,
    row.resolution_source,
    row.start_date,
    row.creation_date,
    row.end_date,
    row.category,
    row.image,
    row.icon,
    row.active,
    row.closed,
    row.archived,
    row.new,
    row.featured,
    row.restricted,
    row.liquidity,
    row.volume,
    row.open_interest,
    row.created_by,
    row.created_at,
    row.updated_at,
    row.competitive,
    row.volume24hr,
    row.volume1wk,
    row.volume1mo,
    row.volume1yr,
    row.enable_order_book,
    row.liquidity_clob,
    row.neg_risk,
    row.comment_count,
    row.raw,
  ]);
  return rows[0].id as string;
}

export async function upsertPolymarketEvents(
  eventRows: PolymarketEventRow[],
): Promise<PolymarketUpsertStats> {
  if (eventRows.length === 0) return emptyPolymarketUpsertStats();
  const rows = dedupeById(eventRows);

  const query = `
    with input as (
      select *
      from jsonb_to_recordset($1::jsonb) as x(
        id text,
        ticker text,
        slug text,
        title text,
        description text,
        resolution_source text,
        start_date timestamptz,
        creation_date timestamptz,
        end_date timestamptz,
        category text,
        image text,
        icon text,
        active boolean,
        closed boolean,
        archived boolean,
        new boolean,
        featured boolean,
        restricted boolean,
        liquidity numeric,
        volume numeric,
        open_interest numeric,
        created_by text,
        created_at timestamptz,
        updated_at timestamptz,
        competitive numeric,
        volume24hr numeric,
        volume1wk numeric,
        volume1mo numeric,
        volume1yr numeric,
        enable_order_book boolean,
        liquidity_clob numeric,
        neg_risk boolean,
        comment_count integer,
        raw jsonb
      )
    ),
    classified as (
      select
        input.*,
        existing.raw as existing_raw,
        existing.id is null as inserted,
        (existing.ticker, existing.slug, existing.title,
         existing.description, existing.resolution_source,
         existing.start_date, existing.creation_date, existing.end_date,
         existing.category, existing.image, existing.icon,
         existing.active, existing.closed, existing.archived, existing.new,
         existing.featured, existing.restricted, existing.created_by,
         existing.created_at, existing.enable_order_book, existing.neg_risk)
          is distinct from
        (input.ticker, input.slug, input.title,
         input.description, input.resolution_source,
         input.start_date, input.creation_date, input.end_date,
         input.category, input.image, input.icon,
         input.active, input.closed, input.archived, input.new,
         input.featured, input.restricted, input.created_by,
         input.created_at, input.enable_order_book, input.neg_risk)
          as structural_changed,
        (existing.liquidity, existing.volume, existing.open_interest,
         existing.competitive, existing.volume24hr, existing.volume1wk,
         existing.volume1mo, existing.volume1yr, existing.liquidity_clob,
         existing.comment_count)
          is distinct from
        (input.liquidity, input.volume, input.open_interest,
         input.competitive, input.volume24hr, input.volume1wk,
         input.volume1mo, input.volume1yr, input.liquidity_clob,
         input.comment_count)
          as metrics_changed,
        existing.updated_at is distinct from input.updated_at
          as source_timestamp_changed,
        existing.raw is distinct from input.raw as raw_changed,
        ${rawWithoutSourceTimestampSql("existing")} is distinct from
          ${rawWithoutSourceTimestampSql("input")} as raw_content_changed,
        ${eventRawBusinessProjectionSql("existing")} is distinct from
          ${eventRawBusinessProjectionSql("input")} as relevant_raw_changed
      from input
      left join polymarket_events existing on existing.id = input.id
    ),
    reasoned as (
      select
        classified.*,
        inserted
          or structural_changed
          or metrics_changed
          or relevant_raw_changed
          as is_changed,
        case
          when inserted then 'inserted'
          when structural_changed then 'structural'
          when metrics_changed then 'metrics'
          when (source_timestamp_changed or raw_changed)
            and not raw_content_changed
          then 'source_timestamp_only'
          when relevant_raw_changed then 'relevant_raw'
          when raw_content_changed then 'raw_only'
          else 'unchanged'
        end as primary_reason
      from classified
    ),
    changed as (
      select
        reasoned.*,
        case
          when inserted or structural_changed or relevant_raw_changed
          then raw
          else existing_raw
        end as raw_to_store
      from reasoned
      where is_changed
    ),
    upserted as (
      insert into polymarket_events(
        id, ticker, slug, title, description, resolution_source,
        start_date, creation_date, end_date, category, image, icon,
        active, closed, archived, new, featured, restricted,
        liquidity, volume, open_interest, created_by, created_at, updated_at,
        competitive, volume24hr, volume1wk, volume1mo, volume1yr,
        enable_order_book, liquidity_clob, neg_risk, comment_count, raw
      )
      select
        id, ticker, slug, title, description, resolution_source,
        start_date, creation_date, end_date, category, image, icon,
        active, closed, archived, new, featured, restricted,
        liquidity, volume, open_interest, created_by, created_at, updated_at,
        competitive, volume24hr, volume1wk, volume1mo, volume1yr,
        enable_order_book, liquidity_clob, neg_risk, comment_count, raw_to_store
      from changed
      on conflict (id) do update set
        ticker=excluded.ticker,
        slug=excluded.slug,
        title=excluded.title,
        description=excluded.description,
        resolution_source=excluded.resolution_source,
        start_date=excluded.start_date,
        creation_date=excluded.creation_date,
        end_date=excluded.end_date,
        category=excluded.category,
        image=excluded.image,
        icon=excluded.icon,
        active=excluded.active,
        closed=excluded.closed,
        archived=excluded.archived,
        new=excluded.new,
        featured=excluded.featured,
        restricted=excluded.restricted,
        liquidity=excluded.liquidity,
        volume=excluded.volume,
        open_interest=excluded.open_interest,
        created_by=excluded.created_by,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at,
        competitive=excluded.competitive,
        volume24hr=excluded.volume24hr,
        volume1wk=excluded.volume1wk,
        volume1mo=excluded.volume1mo,
        volume1yr=excluded.volume1yr,
        enable_order_book=excluded.enable_order_book,
        liquidity_clob=excluded.liquidity_clob,
        neg_risk=excluded.neg_risk,
        comment_count=excluded.comment_count,
        raw=excluded.raw,
        updated_at_db=now()
      returning 1
    )
    select
      (select count(*) from input)::int as input_count,
      (select count(*) from changed)::int as changed_count,
      (select count(*) from upserted)::int as upserted_count,
      (
        select jsonb_object_agg(primary_reason, reason_count)
        from (
          select primary_reason, count(*)::int as reason_count
          from reasoned
          group by primary_reason
        ) primary_counts
      ) as primary_reasons
  `;

  const batches = chunkArray(rows, 1000);
  let changedRows = 0;
  let upsertedRows = 0;
  const changeReasons = emptyChangeReasonTelemetry();
  for (const batch of batches) {
    const result = await pool.query<{
      input_count: number;
      changed_count: number;
      upserted_count: number;
      primary_reasons: unknown;
    }>(query, [JSON.stringify(batch)]);
    const row = result.rows[0];
    changedRows += row?.changed_count ?? batch.length;
    upsertedRows += row?.upserted_count ?? 0;
    incrementReasonCounts(changeReasons.primary, row?.primary_reasons ?? null);
  }
  return {
    inputRows: eventRows.length,
    dedupedRows: rows.length,
    changedRows,
    skippedRows: rows.length - changedRows,
    batches: batches.length,
    upsertedRows,
    changeReasons,
  };
}

// Upsert Polymarket market to polymarket_markets table
export async function upsertPolymarketMarket(row: PolymarketMarketRow) {
  const q = `
  INSERT INTO polymarket_markets(
    id, event_id, question, condition_id, slug, resolution_source, end_date, category, liquidity, start_date,
    image, icon, description, outcomes, outcome_prices, volume, active, closed, market_maker_address,
    created_at, updated_at, new, featured, submitted_by, archived, resolved_by, restricted,
    group_item_title, group_item_threshold, question_id, enable_order_book, order_price_min_tick_size,
    order_min_size, volume_num, liquidity_num, end_date_iso, start_date_iso, has_reviewed_dates,
    volume24hr, volume1wk, volume1mo, volume1yr, clob_token_ids, uma_bond, uma_reward,
    volume24hr_clob, volume1wk_clob, volume1mo_clob, volume1yr_clob, volume_clob, liquidity_clob,
    custom_liveness, accepting_orders, neg_risk, neg_risk_market_id, neg_risk_request_id, ready, funded,
    accepting_orders_timestamp, cyom, competitive, pager_duty_notification_enabled, approved,
    rewards_min_size, rewards_max_spread, spread, one_day_price_change, one_hour_price_change,
    one_week_price_change, one_month_price_change, last_trade_price, best_bid, best_ask,
    automatically_active, clear_book_on_start, series_color, show_gmp_series, show_gmp_outcome,
    manual_activation, neg_risk_other, uma_resolution_statuses, pending_deployment, deploying,
    deploying_timestamp, rfq_enabled, holding_rewards_enabled, fees_enabled, raw
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58,$59,$60,$61,$62,$63,$64,$65,$66,$67,$68,$69,$70,$71,$72,$73,$74,$75,$76,$77,$78,$79,$80,$81,$82,$83,$84,$85,$86,$87,$88)
  ON CONFLICT (id) DO UPDATE SET
    question=EXCLUDED.question,
    condition_id=EXCLUDED.condition_id,
    slug=EXCLUDED.slug,
    resolution_source=EXCLUDED.resolution_source,
    end_date=EXCLUDED.end_date,
    category=EXCLUDED.category,
    liquidity=EXCLUDED.liquidity,
    start_date=EXCLUDED.start_date,
    image=EXCLUDED.image,
    icon=EXCLUDED.icon,
    description=EXCLUDED.description,
    outcomes=EXCLUDED.outcomes,
    outcome_prices=EXCLUDED.outcome_prices,
    volume=EXCLUDED.volume,
    active=EXCLUDED.active,
    closed=EXCLUDED.closed,
    market_maker_address=EXCLUDED.market_maker_address,
    created_at=EXCLUDED.created_at,
    updated_at=EXCLUDED.updated_at,
    new=EXCLUDED.new,
    featured=EXCLUDED.featured,
    submitted_by=EXCLUDED.submitted_by,
    archived=EXCLUDED.archived,
    resolved_by=EXCLUDED.resolved_by,
    restricted=EXCLUDED.restricted,
    group_item_title=EXCLUDED.group_item_title,
    group_item_threshold=EXCLUDED.group_item_threshold,
    question_id=EXCLUDED.question_id,
    enable_order_book=EXCLUDED.enable_order_book,
    order_price_min_tick_size=EXCLUDED.order_price_min_tick_size,
    order_min_size=EXCLUDED.order_min_size,
    volume_num=EXCLUDED.volume_num,
    liquidity_num=EXCLUDED.liquidity_num,
    end_date_iso=EXCLUDED.end_date_iso,
    start_date_iso=EXCLUDED.start_date_iso,
    has_reviewed_dates=EXCLUDED.has_reviewed_dates,
    volume24hr=EXCLUDED.volume24hr,
    volume1wk=EXCLUDED.volume1wk,
    volume1mo=EXCLUDED.volume1mo,
    volume1yr=EXCLUDED.volume1yr,
    clob_token_ids=EXCLUDED.clob_token_ids,
    uma_bond=EXCLUDED.uma_bond,
    uma_reward=EXCLUDED.uma_reward,
    volume24hr_clob=EXCLUDED.volume24hr_clob,
    volume1wk_clob=EXCLUDED.volume1wk_clob,
    volume1mo_clob=EXCLUDED.volume1mo_clob,
    volume1yr_clob=EXCLUDED.volume1yr_clob,
    volume_clob=EXCLUDED.volume_clob,
    liquidity_clob=EXCLUDED.liquidity_clob,
    custom_liveness=EXCLUDED.custom_liveness,
    accepting_orders=EXCLUDED.accepting_orders,
    neg_risk=EXCLUDED.neg_risk,
    neg_risk_market_id=EXCLUDED.neg_risk_market_id,
    neg_risk_request_id=EXCLUDED.neg_risk_request_id,
    ready=EXCLUDED.ready,
    funded=EXCLUDED.funded,
    accepting_orders_timestamp=EXCLUDED.accepting_orders_timestamp,
    cyom=EXCLUDED.cyom,
    competitive=EXCLUDED.competitive,
    pager_duty_notification_enabled=EXCLUDED.pager_duty_notification_enabled,
    approved=EXCLUDED.approved,
    rewards_min_size=EXCLUDED.rewards_min_size,
    rewards_max_spread=EXCLUDED.rewards_max_spread,
    spread=EXCLUDED.spread,
    one_day_price_change=EXCLUDED.one_day_price_change,
    one_hour_price_change=EXCLUDED.one_hour_price_change,
    one_week_price_change=EXCLUDED.one_week_price_change,
    one_month_price_change=EXCLUDED.one_month_price_change,
    last_trade_price=EXCLUDED.last_trade_price,
    best_bid=EXCLUDED.best_bid,
    best_ask=EXCLUDED.best_ask,
    automatically_active=EXCLUDED.automatically_active,
    clear_book_on_start=EXCLUDED.clear_book_on_start,
    series_color=EXCLUDED.series_color,
    show_gmp_series=EXCLUDED.show_gmp_series,
    show_gmp_outcome=EXCLUDED.show_gmp_outcome,
    manual_activation=EXCLUDED.manual_activation,
    neg_risk_other=EXCLUDED.neg_risk_other,
    uma_resolution_statuses=EXCLUDED.uma_resolution_statuses,
    pending_deployment=EXCLUDED.pending_deployment,
    deploying=EXCLUDED.deploying,
    deploying_timestamp=EXCLUDED.deploying_timestamp,
    rfq_enabled=EXCLUDED.rfq_enabled,
    holding_rewards_enabled=EXCLUDED.holding_rewards_enabled,
    fees_enabled=EXCLUDED.fees_enabled,
    raw=EXCLUDED.raw,
    updated_at_db=now()
  RETURNING id, clob_token_ids`;

  const { rows } = await pool.query(q, [
    row.id,
    row.event_id,
    row.question,
    row.condition_id,
    row.slug,
    row.resolution_source,
    row.end_date,
    row.category,
    row.liquidity,
    row.start_date,
    row.image,
    row.icon,
    row.description,
    row.outcomes,
    row.outcome_prices,
    row.volume,
    row.active,
    row.closed,
    row.market_maker_address,
    row.created_at,
    row.updated_at,
    row.new,
    row.featured,
    row.submitted_by,
    row.archived,
    row.resolved_by,
    row.restricted,
    row.group_item_title,
    row.group_item_threshold,
    row.question_id,
    row.enable_order_book,
    row.order_price_min_tick_size,
    row.order_min_size,
    row.volume_num,
    row.liquidity_num,
    row.end_date_iso,
    row.start_date_iso,
    row.has_reviewed_dates,
    row.volume24hr,
    row.volume1wk,
    row.volume1mo,
    row.volume1yr,
    row.clob_token_ids,
    row.uma_bond,
    row.uma_reward,
    row.volume24hr_clob,
    row.volume1wk_clob,
    row.volume1mo_clob,
    row.volume1yr_clob,
    row.volume_clob,
    row.liquidity_clob,
    row.custom_liveness,
    row.accepting_orders,
    row.neg_risk,
    row.neg_risk_market_id,
    row.neg_risk_request_id,
    row.ready,
    row.funded,
    row.accepting_orders_timestamp,
    row.cyom,
    row.competitive,
    row.pager_duty_notification_enabled,
    row.approved,
    row.rewards_min_size,
    row.rewards_max_spread,
    row.spread,
    row.one_day_price_change,
    row.one_hour_price_change,
    row.one_week_price_change,
    row.one_month_price_change,
    row.last_trade_price,
    row.best_bid,
    row.best_ask,
    row.automatically_active,
    row.clear_book_on_start,
    row.series_color,
    row.show_gmp_series,
    row.show_gmp_outcome,
    row.manual_activation,
    row.neg_risk_other,
    row.uma_resolution_statuses,
    row.pending_deployment,
    row.deploying,
    row.deploying_timestamp,
    row.rfq_enabled,
    row.holding_rewards_enabled,
    row.fees_enabled,
    row.raw,
  ]);
  return rows[0] as { id: string; clob_token_ids: string | null };
}

export async function upsertPolymarketMarkets(
  marketRows: PolymarketMarketRow[],
): Promise<PolymarketUpsertStats> {
  if (marketRows.length === 0) return emptyPolymarketUpsertStats();
  const rows = dedupeById(marketRows);

  const query = `
    with input as (
      select *
      from jsonb_to_recordset($1::jsonb) as x(
        id text,
        event_id text,
        question text,
        condition_id text,
        slug text,
        resolution_source text,
        end_date timestamptz,
        category text,
        liquidity numeric,
        start_date timestamptz,
        image text,
        icon text,
        description text,
        outcomes text,
        outcome_prices text,
        volume numeric,
        active boolean,
        closed boolean,
        market_maker_address text,
        created_at timestamptz,
        updated_at timestamptz,
        new boolean,
        featured boolean,
        submitted_by text,
        archived boolean,
        resolved_by text,
        restricted boolean,
        group_item_title text,
        group_item_threshold text,
        question_id text,
        enable_order_book boolean,
        order_price_min_tick_size numeric,
        order_min_size numeric,
        volume_num numeric,
        liquidity_num numeric,
        end_date_iso text,
        start_date_iso text,
        has_reviewed_dates boolean,
        volume24hr numeric,
        volume1wk numeric,
        volume1mo numeric,
        volume1yr numeric,
        clob_token_ids text,
        uma_bond text,
        uma_reward text,
        volume24hr_clob numeric,
        volume1wk_clob numeric,
        volume1mo_clob numeric,
        volume1yr_clob numeric,
        volume_clob numeric,
        liquidity_clob numeric,
        custom_liveness integer,
        accepting_orders boolean,
        neg_risk boolean,
        neg_risk_market_id text,
        neg_risk_request_id text,
        ready boolean,
        funded boolean,
        accepting_orders_timestamp timestamptz,
        cyom boolean,
        competitive numeric,
        pager_duty_notification_enabled boolean,
        approved boolean,
        rewards_min_size numeric,
        rewards_max_spread numeric,
        spread numeric,
        one_day_price_change numeric,
        one_hour_price_change numeric,
        one_week_price_change numeric,
        one_month_price_change numeric,
        last_trade_price numeric,
        best_bid numeric,
        best_ask numeric,
        automatically_active boolean,
        clear_book_on_start boolean,
        series_color text,
        show_gmp_series boolean,
        show_gmp_outcome boolean,
        manual_activation boolean,
        neg_risk_other boolean,
        uma_resolution_statuses text,
        pending_deployment boolean,
        deploying boolean,
        deploying_timestamp timestamptz,
        rfq_enabled boolean,
        holding_rewards_enabled boolean,
        fees_enabled boolean,
        raw jsonb
      )
    ),
    classified as (
      select
        input.*,
        existing.raw as existing_raw,
        existing.id is null as inserted,
        (existing.question, existing.condition_id, existing.slug,
         existing.resolution_source, existing.end_date, existing.category,
         existing.start_date, existing.image, existing.icon,
         existing.description, existing.outcomes, existing.active,
         existing.closed, existing.market_maker_address, existing.created_at,
         existing.new, existing.featured, existing.submitted_by,
         existing.archived, existing.resolved_by, existing.restricted,
         existing.group_item_title, existing.group_item_threshold,
         existing.question_id, existing.enable_order_book,
         existing.order_price_min_tick_size, existing.order_min_size,
         existing.end_date_iso, existing.start_date_iso,
         existing.has_reviewed_dates, existing.clob_token_ids,
         existing.uma_bond, existing.uma_reward, existing.custom_liveness,
         existing.accepting_orders, existing.neg_risk,
         existing.neg_risk_market_id, existing.neg_risk_request_id,
         existing.ready, existing.funded,
         existing.accepting_orders_timestamp, existing.cyom,
         existing.pager_duty_notification_enabled, existing.approved,
         existing.rewards_min_size, existing.rewards_max_spread,
         existing.automatically_active, existing.clear_book_on_start,
         existing.series_color, existing.show_gmp_series,
         existing.show_gmp_outcome, existing.manual_activation,
         existing.neg_risk_other, existing.uma_resolution_statuses,
         existing.pending_deployment, existing.deploying,
         existing.deploying_timestamp, existing.rfq_enabled,
         existing.holding_rewards_enabled, existing.fees_enabled)
          is distinct from
        (input.question, input.condition_id, input.slug,
         input.resolution_source, input.end_date, input.category,
         input.start_date, input.image, input.icon,
         input.description, input.outcomes, input.active,
         input.closed, input.market_maker_address, input.created_at,
         input.new, input.featured, input.submitted_by,
         input.archived, input.resolved_by, input.restricted,
         input.group_item_title, input.group_item_threshold,
         input.question_id, input.enable_order_book,
         input.order_price_min_tick_size, input.order_min_size,
         input.end_date_iso, input.start_date_iso,
         input.has_reviewed_dates, input.clob_token_ids,
         input.uma_bond, input.uma_reward, input.custom_liveness,
         input.accepting_orders, input.neg_risk,
         input.neg_risk_market_id, input.neg_risk_request_id,
         input.ready, input.funded,
         input.accepting_orders_timestamp, input.cyom,
         input.pager_duty_notification_enabled, input.approved,
         input.rewards_min_size, input.rewards_max_spread,
         input.automatically_active, input.clear_book_on_start,
         input.series_color, input.show_gmp_series,
         input.show_gmp_outcome, input.manual_activation,
         input.neg_risk_other, input.uma_resolution_statuses,
         input.pending_deployment, input.deploying,
         input.deploying_timestamp, input.rfq_enabled,
         input.holding_rewards_enabled, input.fees_enabled)
          as structural_changed,
        (existing.liquidity, existing.outcome_prices, existing.volume,
         existing.volume_num, existing.liquidity_num, existing.volume24hr,
         existing.volume1wk, existing.volume1mo, existing.volume1yr,
         existing.volume24hr_clob, existing.volume1wk_clob,
         existing.volume1mo_clob, existing.volume1yr_clob,
         existing.volume_clob, existing.liquidity_clob,
         existing.competitive, existing.spread,
         existing.one_day_price_change, existing.one_hour_price_change,
         existing.one_week_price_change, existing.one_month_price_change,
         existing.last_trade_price, existing.best_bid, existing.best_ask)
          is distinct from
        (input.liquidity, input.outcome_prices, input.volume,
         input.volume_num, input.liquidity_num, input.volume24hr,
         input.volume1wk, input.volume1mo, input.volume1yr,
         input.volume24hr_clob, input.volume1wk_clob,
         input.volume1mo_clob, input.volume1yr_clob,
         input.volume_clob, input.liquidity_clob,
         input.competitive, input.spread,
         input.one_day_price_change, input.one_hour_price_change,
         input.one_week_price_change, input.one_month_price_change,
         input.last_trade_price, input.best_bid, input.best_ask)
          as metrics_changed,
        existing.updated_at is distinct from input.updated_at
          as source_timestamp_changed,
        existing.raw is distinct from input.raw as raw_changed,
        ${rawWithoutSourceTimestampSql("existing")} is distinct from
          ${rawWithoutSourceTimestampSql("input")} as raw_content_changed,
        ${marketRawBusinessProjectionSql("existing")} is distinct from
          ${marketRawBusinessProjectionSql("input")} as relevant_raw_changed
      from input
      left join polymarket_markets existing on existing.id = input.id
    ),
    reasoned as (
      select
        classified.*,
        inserted
          or structural_changed
          or metrics_changed
          or relevant_raw_changed
          as is_changed,
        not inserted
          and metrics_changed
          and not structural_changed
          and not relevant_raw_changed
          as is_metrics_only,
        case
          when inserted then 'inserted'
          when structural_changed then 'structural'
          when metrics_changed then 'metrics'
          when (source_timestamp_changed or raw_changed)
            and not raw_content_changed
          then 'source_timestamp_only'
          when relevant_raw_changed then 'relevant_raw'
          when raw_content_changed then 'raw_only'
          else 'unchanged'
        end as primary_reason
      from classified
    ),
    metrics_only_rows as (
      select reasoned.*, existing_raw as raw_to_store
      from reasoned
      where is_metrics_only
    ),
    wide_rows as (
      select
        reasoned.*,
        case
          when inserted or structural_changed or relevant_raw_changed
          then raw
          else existing_raw
        end as raw_to_store
      from reasoned
      where is_changed
        and not is_metrics_only
    ),
    metrics_updated_rows as (
      update polymarket_markets existing
      set liquidity = metrics_row.liquidity,
          outcome_prices = metrics_row.outcome_prices,
          volume = metrics_row.volume,
          updated_at = metrics_row.updated_at,
          volume_num = metrics_row.volume_num,
          liquidity_num = metrics_row.liquidity_num,
          volume24hr = metrics_row.volume24hr,
          volume1wk = metrics_row.volume1wk,
          volume1mo = metrics_row.volume1mo,
          volume1yr = metrics_row.volume1yr,
          volume24hr_clob = metrics_row.volume24hr_clob,
          volume1wk_clob = metrics_row.volume1wk_clob,
          volume1mo_clob = metrics_row.volume1mo_clob,
          volume1yr_clob = metrics_row.volume1yr_clob,
          volume_clob = metrics_row.volume_clob,
          liquidity_clob = metrics_row.liquidity_clob,
          competitive = metrics_row.competitive,
          spread = metrics_row.spread,
          one_day_price_change = metrics_row.one_day_price_change,
          one_hour_price_change = metrics_row.one_hour_price_change,
          one_week_price_change = metrics_row.one_week_price_change,
          one_month_price_change = metrics_row.one_month_price_change,
          last_trade_price = metrics_row.last_trade_price,
          best_bid = metrics_row.best_bid,
          best_ask = metrics_row.best_ask,
          updated_at_db = now()
      from metrics_only_rows metrics_row
      where existing.id = metrics_row.id
      returning existing.id
    ),
    rows_for_wide_upsert as (
      select wide_row.*
      from wide_rows wide_row
      union all
      select metrics_row.*
      from metrics_only_rows metrics_row
      where not exists (
        select 1
        from metrics_updated_rows updated_row
        where updated_row.id = metrics_row.id
      )
    ),
    wide_upserted_rows as (
      insert into polymarket_markets(
        id, event_id, question, condition_id, slug, resolution_source, end_date, category, liquidity, start_date,
        image, icon, description, outcomes, outcome_prices, volume, active, closed, market_maker_address,
        created_at, updated_at, new, featured, submitted_by, archived, resolved_by, restricted,
        group_item_title, group_item_threshold, question_id, enable_order_book, order_price_min_tick_size,
        order_min_size, volume_num, liquidity_num, end_date_iso, start_date_iso, has_reviewed_dates,
        volume24hr, volume1wk, volume1mo, volume1yr, clob_token_ids, uma_bond, uma_reward,
        volume24hr_clob, volume1wk_clob, volume1mo_clob, volume1yr_clob, volume_clob, liquidity_clob,
        custom_liveness, accepting_orders, neg_risk, neg_risk_market_id, neg_risk_request_id, ready, funded,
        accepting_orders_timestamp, cyom, competitive, pager_duty_notification_enabled, approved,
        rewards_min_size, rewards_max_spread, spread, one_day_price_change, one_hour_price_change,
        one_week_price_change, one_month_price_change, last_trade_price, best_bid, best_ask,
        automatically_active, clear_book_on_start, series_color, show_gmp_series, show_gmp_outcome,
        manual_activation, neg_risk_other, uma_resolution_statuses, pending_deployment, deploying,
        deploying_timestamp, rfq_enabled, holding_rewards_enabled, fees_enabled, raw
      )
      select
        id, event_id, question, condition_id, slug, resolution_source, end_date, category, liquidity, start_date,
        image, icon, description, outcomes, outcome_prices, volume, active, closed, market_maker_address,
        created_at, updated_at, new, featured, submitted_by, archived, resolved_by, restricted,
        group_item_title, group_item_threshold, question_id, enable_order_book, order_price_min_tick_size,
        order_min_size, volume_num, liquidity_num, end_date_iso, start_date_iso, has_reviewed_dates,
        volume24hr, volume1wk, volume1mo, volume1yr, clob_token_ids, uma_bond, uma_reward,
        volume24hr_clob, volume1wk_clob, volume1mo_clob, volume1yr_clob, volume_clob, liquidity_clob,
        custom_liveness, accepting_orders, neg_risk, neg_risk_market_id, neg_risk_request_id, ready, funded,
        accepting_orders_timestamp, cyom, competitive, pager_duty_notification_enabled, approved,
        rewards_min_size, rewards_max_spread, spread, one_day_price_change, one_hour_price_change,
        one_week_price_change, one_month_price_change, last_trade_price, best_bid, best_ask,
        automatically_active, clear_book_on_start, series_color, show_gmp_series, show_gmp_outcome,
        manual_activation, neg_risk_other, uma_resolution_statuses, pending_deployment, deploying,
        deploying_timestamp, rfq_enabled, holding_rewards_enabled, fees_enabled, raw_to_store
      from rows_for_wide_upsert
      on conflict (id) do update set
        question=excluded.question,
        condition_id=excluded.condition_id,
        slug=excluded.slug,
        resolution_source=excluded.resolution_source,
        end_date=excluded.end_date,
        category=excluded.category,
        liquidity=excluded.liquidity,
        start_date=excluded.start_date,
        image=excluded.image,
        icon=excluded.icon,
        description=excluded.description,
        outcomes=excluded.outcomes,
        outcome_prices=excluded.outcome_prices,
        volume=excluded.volume,
        active=excluded.active,
        closed=excluded.closed,
        market_maker_address=excluded.market_maker_address,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at,
        new=excluded.new,
        featured=excluded.featured,
        submitted_by=excluded.submitted_by,
        archived=excluded.archived,
        resolved_by=excluded.resolved_by,
        restricted=excluded.restricted,
        group_item_title=excluded.group_item_title,
        group_item_threshold=excluded.group_item_threshold,
        question_id=excluded.question_id,
        enable_order_book=excluded.enable_order_book,
        order_price_min_tick_size=excluded.order_price_min_tick_size,
        order_min_size=excluded.order_min_size,
        volume_num=excluded.volume_num,
        liquidity_num=excluded.liquidity_num,
        end_date_iso=excluded.end_date_iso,
        start_date_iso=excluded.start_date_iso,
        has_reviewed_dates=excluded.has_reviewed_dates,
        volume24hr=excluded.volume24hr,
        volume1wk=excluded.volume1wk,
        volume1mo=excluded.volume1mo,
        volume1yr=excluded.volume1yr,
        clob_token_ids=excluded.clob_token_ids,
        uma_bond=excluded.uma_bond,
        uma_reward=excluded.uma_reward,
        volume24hr_clob=excluded.volume24hr_clob,
        volume1wk_clob=excluded.volume1wk_clob,
        volume1mo_clob=excluded.volume1mo_clob,
        volume1yr_clob=excluded.volume1yr_clob,
        volume_clob=excluded.volume_clob,
        liquidity_clob=excluded.liquidity_clob,
        custom_liveness=excluded.custom_liveness,
        accepting_orders=excluded.accepting_orders,
        neg_risk=excluded.neg_risk,
        neg_risk_market_id=excluded.neg_risk_market_id,
        neg_risk_request_id=excluded.neg_risk_request_id,
        ready=excluded.ready,
        funded=excluded.funded,
        accepting_orders_timestamp=excluded.accepting_orders_timestamp,
        cyom=excluded.cyom,
        competitive=excluded.competitive,
        pager_duty_notification_enabled=excluded.pager_duty_notification_enabled,
        approved=excluded.approved,
        rewards_min_size=excluded.rewards_min_size,
        rewards_max_spread=excluded.rewards_max_spread,
        spread=excluded.spread,
        one_day_price_change=excluded.one_day_price_change,
        one_hour_price_change=excluded.one_hour_price_change,
        one_week_price_change=excluded.one_week_price_change,
        one_month_price_change=excluded.one_month_price_change,
        last_trade_price=excluded.last_trade_price,
        best_bid=excluded.best_bid,
        best_ask=excluded.best_ask,
        automatically_active=excluded.automatically_active,
        clear_book_on_start=excluded.clear_book_on_start,
        series_color=excluded.series_color,
        show_gmp_series=excluded.show_gmp_series,
        show_gmp_outcome=excluded.show_gmp_outcome,
        manual_activation=excluded.manual_activation,
        neg_risk_other=excluded.neg_risk_other,
        uma_resolution_statuses=excluded.uma_resolution_statuses,
        pending_deployment=excluded.pending_deployment,
        deploying=excluded.deploying,
        deploying_timestamp=excluded.deploying_timestamp,
        rfq_enabled=excluded.rfq_enabled,
        holding_rewards_enabled=excluded.holding_rewards_enabled,
        fees_enabled=excluded.fees_enabled,
        raw=excluded.raw,
        updated_at_db=now()
      returning 1
    )
    select
      (select count(*) from input)::int as input_count,
      (select count(*) from reasoned where is_changed)::int as changed_count,
      (
        (select count(*) from metrics_updated_rows)
        + (select count(*) from wide_upserted_rows)
      )::int as upserted_count,
      (
        select jsonb_object_agg(primary_reason, reason_count)
        from (
          select primary_reason, count(*)::int as reason_count
          from reasoned
          group by primary_reason
        ) primary_counts
      ) as primary_reasons
  `;

  const batches = chunkArray(rows, 250);
  let changedRows = 0;
  let upsertedRows = 0;
  const changeReasons = emptyChangeReasonTelemetry();
  for (const batch of batches) {
    const result = await pool.query<{
      input_count: number;
      changed_count: number;
      upserted_count: number;
      primary_reasons: unknown;
    }>(query, [JSON.stringify(batch)]);
    const row = result.rows[0];
    changedRows += row?.changed_count ?? batch.length;
    upsertedRows += row?.upserted_count ?? 0;
    incrementReasonCounts(changeReasons.primary, row?.primary_reasons ?? null);
  }
  return {
    inputRows: marketRows.length,
    dedupedRows: rows.length,
    changedRows,
    skippedRows: rows.length - changedRows,
    batches: batches.length,
    upsertedRows,
    changeReasons,
  };
}
