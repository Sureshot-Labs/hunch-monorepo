import type { PoolClient } from "pg";
import { pool } from "./db.js";

type Args = {
  confirmDelete: boolean;
  cutoffDays: number;
  execute: boolean;
  json: boolean;
  limit: number;
  sampleLimit: number;
  statementTimeoutSec: number;
  statuses: string[];
  venues: string[];
};

type GlobalSummaryRow = {
  venue: string;
  status: string;
  markets: string;
  events: string;
  oldest_terminal_at: Date | null;
  newest_terminal_at: Date | null;
};

type BatchSummaryRow = {
  section: string;
  venue: string | null;
  status: string | null;
  label: string;
  markets: string | null;
  rows: string | null;
  oldest_terminal_at: Date | null;
  newest_terminal_at: Date | null;
};

type SampleRow = {
  market_id: string;
  venue: string;
  status: string;
  event_id: string;
  title: string;
  terminal_at: Date;
  token_count: string;
};

type DeleteCountRow = {
  label: string;
  rows: string;
};

const DEFAULT_CUTOFF_DAYS = 30;
const DEFAULT_LIMIT = 50_000;
const DEFAULT_SAMPLE_LIMIT = 20;
const DEFAULT_STATUSES = ["CLOSED", "SETTLED", "ARCHIVED"];
const ALLOWED_STATUSES = new Set(["ACTIVE", "CLOSED", "SETTLED", "ARCHIVED"]);
const TELEGRAM_TRADE_INTENT_EPHEMERAL_STATUSES = [
  "draft",
  "previewed",
  "confirming",
  "expired",
  "cancelled",
  "failed",
];

function readValues(argv: string[], name: string): string[] {
  const key = `--${name}`;
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${key}=`)) {
      const value = arg.slice(key.length + 1).trim();
      if (value.length) values.push(value);
      continue;
    }
    if (arg === key) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value.trim());
        index += 1;
      }
    }
  }

  return values.flatMap((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function readPositiveInt(
  argv: string[],
  name: string,
  fallback: number,
): number {
  const raw = readValues(argv, name)[0];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Math.trunc(parsed);
}

function normalizeStatuses(values: string[]): string[] {
  if (values.length === 0) return DEFAULT_STATUSES;

  const statuses = values.map((entry) => entry.toUpperCase());
  const unknown = statuses.filter((entry) => !ALLOWED_STATUSES.has(entry));
  if (unknown.length > 0) {
    throw new Error(`Unknown status value(s): ${unknown.join(", ")}`);
  }
  return [...new Set(statuses)];
}

function normalizeVenues(values: string[]): string[] {
  return [...new Set(values.map((entry) => entry.toLowerCase()))];
}

function parseArgs(argvInput: string[]): Args {
  const argv = argvInput.filter((arg) => arg !== "--");
  const cutoffDays =
    readValues(argv, "cutoff-days")[0] !== undefined
      ? readPositiveInt(argv, "cutoff-days", DEFAULT_CUTOFF_DAYS)
      : readPositiveInt(argv, "retention-days", DEFAULT_CUTOFF_DAYS);

  return {
    confirmDelete: hasFlag(argv, "confirm-delete"),
    cutoffDays,
    execute: hasFlag(argv, "execute"),
    json: hasFlag(argv, "json"),
    limit: readPositiveInt(argv, "limit", DEFAULT_LIMIT),
    sampleLimit: readPositiveInt(argv, "sample", DEFAULT_SAMPLE_LIMIT),
    statementTimeoutSec: readPositiveInt(argv, "statement-timeout-sec", 180),
    statuses: normalizeStatuses([
      ...readValues(argv, "status"),
      ...readValues(argv, "statuses"),
    ]),
    venues: normalizeVenues([
      ...readValues(argv, "venue"),
      ...readValues(argv, "venues"),
    ]),
  };
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -C hunch-monorepo -F api run market:retention:select -- [options]

Options:
  --cutoff-days <days>          Terminal market age threshold. Default: ${DEFAULT_CUTOFF_DAYS}
  --limit <count>               Bounded candidate pool size. Default: ${DEFAULT_LIMIT}
  --sample <count>              Removable sample row count. Default: ${DEFAULT_SAMPLE_LIMIT}
  --venue <venue[,venue]>       Optional venue filter. Repeatable.
  --status <status[,status]>    Optional status filter. Default: ${DEFAULT_STATUSES.join(",")}
  --statement-timeout-sec <sec> Query timeout. Default: 180
  --json                        Emit one JSON report.
  --execute                     Delete selected rows. Requires --confirm-delete.
  --confirm-delete              Required together with --execute.
  --help                        Show this message.

Selection rule:
  status in CLOSED/SETTLED/ARCHIVED by default
  terminal_at = coalesce(market.close_time, market.expiration_time, event.end_date)
  terminal_at older than cutoff
  no protected user/history/ledger references

Dry-run is the default. Delete mode recomputes the same removable set inside a write
transaction and only runs when both --execute and --confirm-delete are present.`);
}

function queryParams(args: Args): Array<number | string[] | null> {
  return [
    args.statuses,
    args.venues.length > 0 ? args.venues : null,
    args.cutoffDays,
    args.limit,
  ];
}

function assertExecutionFlags(args: Args): void {
  if (args.execute === args.confirmDelete) return;

  throw new Error(
    "Market retention deletion requires both --execute and --confirm-delete. Omit both flags for dry-run.",
  );
}

function protectedRefsSql(
  candidatePoolTable: string,
  candidateRefTokensTable: string,
  options: { includeTelegramTradeIntents?: boolean } = {},
): string {
  const telegramTradeIntentsRef = options.includeTelegramTradeIntents
    ? `
    union
    select distinct c.market_id, 'telegram_trade_intents_durable' as reason
    from ${candidatePoolTable} c
    join telegram_trade_intents ti on ti.market_id = c.market_id
    where ti.status in ('executing', 'submitted', 'filled', 'reconcile_required')
       or ti.order_id is not null
       or ti.execution_id is not null
       or ti.venue_order_id is not null
       or ti.tx_signature is not null
  `
    : "";
  return `
    select distinct ct.market_id, 'orders' as reason
    from ${candidateRefTokensTable} ct
    join orders o on o.token_id = ct.token_id
    union
    select distinct ct.market_id, 'positions' as reason
    from ${candidateRefTokensTable} ct
    join positions p on p.token_id = ct.token_id
    union
    select distinct c.market_id, 'user_watchlist' as reason
    from ${candidatePoolTable} c
    join user_watchlist w on w.market_id = c.market_id
    union
    select distinct c.market_id, 'executions' as reason
    from ${candidatePoolTable} c
    join executions ex on ex.unified_market_id = c.market_id
    ${telegramTradeIntentsRef}
    union
    select distinct c.market_id, 'wallet_position_snapshots' as reason
    from ${candidatePoolTable} c
    join wallet_position_snapshots ws on ws.venue = c.venue and ws.market_id = c.market_id
    union
    select distinct c.market_id, 'wallet_activity_events' as reason
    from ${candidatePoolTable} c
    join wallet_activity_events wa on wa.venue = c.venue and wa.market_id = c.market_id
    union
    select distinct c.market_id, 'wallet_activity_hourly' as reason
    from ${candidatePoolTable} c
    join wallet_activity_hourly wh on wh.venue = c.venue and wh.market_id = c.market_id
    union
    select distinct c.market_id, 'wallet_activity_cache' as reason
    from ${candidatePoolTable} c
    join wallet_activity_cache wc on wc.venue = c.venue and wc.market_id = c.market_id
    union
    select distinct c.market_id, 'unified_market_activity_snapshots_1h' as reason
    from ${candidatePoolTable} c
    join unified_market_activity_snapshots_1h mas on mas.venue = c.venue and mas.market_id = c.market_id
    union
    select distinct c.market_id, 'limitless_fee_receivables_market' as reason
    from ${candidatePoolTable} c
    join limitless_contract_fee_receivables lr on lr.market_id = c.market_id
    union
    select distinct c.market_id, 'limitless_fee_receivables_event' as reason
    from ${candidatePoolTable} c
    join limitless_contract_fee_receivables lr on lr.event_id = c.event_id
    union
    select distinct ct.market_id, 'limitless_fee_receivables_token' as reason
    from ${candidateRefTokensTable} ct
    join limitless_contract_fee_receivables lr on lr.token_id = ct.token_id
    union
    select distinct ct.market_id, 'venue_fee_accruals' as reason
    from ${candidateRefTokensTable} ct
    join venue_fee_accruals vf on vf.token_id = ct.token_id
  `;
}

function telegramTradeIntentEphemeralPredicate(alias: string): string {
  return `
    ${alias}.status in (${TELEGRAM_TRADE_INTENT_EPHEMERAL_STATUSES.map(
      (status) => `'${status}'`,
    ).join(", ")})
    and ${alias}.order_id is null
    and ${alias}.execution_id is null
    and ${alias}.venue_order_id is null
    and ${alias}.tx_signature is null
  `;
}

function telegramTradeIntentEphemeralDerivedSql(
  candidatePoolTable: string,
): string {
  return `
        union all
        select 'telegram_trade_intents_ephemeral_cleanup' as label,
          count(distinct x.market_id)::text as markets,
          count(*)::text as rows
        from telegram_trade_intents x
        join ${candidatePoolTable} c on c.market_id = x.market_id
        where ${telegramTradeIntentEphemeralPredicate("x")}
  `;
}

function refTokensSql(
  candidatePoolTable: string,
  candidateTokensTable: string,
): string {
  return `
    select distinct ct.market_id, v.token_id
    from ${candidateTokensTable} ct
    join ${candidatePoolTable} c on c.market_id = ct.market_id
    cross join lateral (
      select ct.token_id
      union all
      select regexp_replace(ct.token_id, '^limitless:', '')
      where c.venue = 'limitless'
        and regexp_replace(ct.token_id, '^limitless:', '') ~ '^[0-9]+$'
      union all
      select 'limitless:' || regexp_replace(ct.token_id, '^limitless:', '')
      where c.venue = 'limitless'
        and regexp_replace(ct.token_id, '^limitless:', '') ~ '^[0-9]+$'
    ) v(token_id)
    where v.token_id is not null and v.token_id <> ''
  `;
}

function candidateCte(options: { includeTelegramTradeIntents?: boolean } = {}): string {
  return `
  with raw_candidate_pool as materialized (
    select
      m.id as market_id,
      m.venue,
      m.status::text as status,
      m.event_id,
      m.title,
      m.close_time as terminal_at
    from unified_markets m
    where m.status::text = any($1::text[])
      and ($2::text[] is null or m.venue = any($2::text[]))
      and m.close_time is not null
      and m.close_time < now() - make_interval(days => $3::int)
    union all
    select
      m.id as market_id,
      m.venue,
      m.status::text as status,
      m.event_id,
      m.title,
      m.expiration_time as terminal_at
    from unified_markets m
    where m.status::text = any($1::text[])
      and ($2::text[] is null or m.venue = any($2::text[]))
      and m.close_time is null
      and m.expiration_time is not null
      and m.expiration_time < now() - make_interval(days => $3::int)
    union all
    select
      m.id as market_id,
      m.venue,
      m.status::text as status,
      m.event_id,
      m.title,
      e.end_date as terminal_at
    from unified_markets m
    join unified_events e on e.id = m.event_id
    where m.status::text = any($1::text[])
      and ($2::text[] is null or m.venue = any($2::text[]))
      and m.close_time is null
      and m.expiration_time is null
      and e.end_date is not null
      and e.end_date < now() - make_interval(days => $3::int)
  ),
  candidate_pool as materialized (
    select *
    from raw_candidate_pool
    order by terminal_at asc, market_id asc
    limit $4::int
  ),
  candidate_events as materialized (
    select distinct event_id from candidate_pool
  ),
  candidate_tokens as materialized (
    select distinct c.market_id, umt.token_id
    from candidate_pool c
    join unified_market_tokens umt on umt.market_id = c.market_id
    where umt.token_id is not null and umt.token_id <> ''
    union
    select distinct c.market_id, ut.token_id
    from candidate_pool c
    join unified_tokens ut on ut.market_id = c.market_id
    where ut.token_id is not null and ut.token_id <> ''
    union
    select distinct c.market_id, m.token_yes as token_id
    from candidate_pool c
    join unified_markets m on m.id = c.market_id
    where m.token_yes is not null and m.token_yes <> ''
    union
    select distinct c.market_id, m.token_no as token_id
    from candidate_pool c
    join unified_markets m on m.id = c.market_id
    where m.token_no is not null and m.token_no <> ''
  ),
  candidate_ref_tokens as materialized (
    ${refTokensSql("candidate_pool", "candidate_tokens")}
  ),
  -- Retention safety boundary: update this list, dry-run reports, and delete cleanup when adding persisted market/token/event user-visible references.
  protected_refs as materialized (
    ${protectedRefsSql("candidate_pool", "candidate_ref_tokens", options)}
  ),
  protected_market_ids as materialized (
    select distinct market_id from protected_refs
  )
`;
}

async function queryGlobalTerminalSummary(
  client: PoolClient,
  args: Args,
): Promise<GlobalSummaryRow[]> {
  const { rows } = await client.query<GlobalSummaryRow>(
    `
      with terminal_candidates as materialized (
        select
          m.venue,
          m.status::text as status,
          m.event_id,
          m.close_time as terminal_at
        from unified_markets m
        where m.status::text = any($1::text[])
          and ($2::text[] is null or m.venue = any($2::text[]))
          and m.close_time is not null
          and m.close_time < now() - make_interval(days => $3::int)
        union all
        select
          m.venue,
          m.status::text as status,
          m.event_id,
          m.expiration_time as terminal_at
        from unified_markets m
        where m.status::text = any($1::text[])
          and ($2::text[] is null or m.venue = any($2::text[]))
          and m.close_time is null
          and m.expiration_time is not null
          and m.expiration_time < now() - make_interval(days => $3::int)
        union all
        select
          m.venue,
          m.status::text as status,
          m.event_id,
          e.end_date as terminal_at
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status::text = any($1::text[])
          and ($2::text[] is null or m.venue = any($2::text[]))
          and m.close_time is null
          and m.expiration_time is null
          and e.end_date is not null
          and e.end_date < now() - make_interval(days => $3::int)
      )
      select
        venue,
        status,
        count(*)::text as markets,
        count(distinct event_id)::text as events,
        min(terminal_at) as oldest_terminal_at,
        max(terminal_at) as newest_terminal_at
      from terminal_candidates
      group by venue, status
      order by venue, status
    `,
    queryParams(args).slice(0, 3),
  );

  return rows;
}

async function queryActivePastTerminalSummary(
  client: PoolClient,
  args: Args,
): Promise<GlobalSummaryRow[]> {
  const { rows } = await client.query<GlobalSummaryRow>(
    `
      with active_candidates as materialized (
        select
          m.venue,
          m.status::text as status,
          m.event_id,
          m.close_time as terminal_at
        from unified_markets m
        where m.status = 'ACTIVE'
          and ($1::text[] is null or m.venue = any($1::text[]))
          and m.close_time is not null
          and m.close_time < now() - make_interval(days => $2::int)
        union all
        select
          m.venue,
          m.status::text as status,
          m.event_id,
          m.expiration_time as terminal_at
        from unified_markets m
        where m.status = 'ACTIVE'
          and ($1::text[] is null or m.venue = any($1::text[]))
          and m.close_time is null
          and m.expiration_time is not null
          and m.expiration_time < now() - make_interval(days => $2::int)
        union all
        select
          m.venue,
          m.status::text as status,
          m.event_id,
          e.end_date as terminal_at
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status = 'ACTIVE'
          and ($1::text[] is null or m.venue = any($1::text[]))
          and m.close_time is null
          and m.expiration_time is null
          and e.end_date is not null
          and e.end_date < now() - make_interval(days => $2::int)
      )
      select
        venue,
        status,
        count(*)::text as markets,
        count(distinct event_id)::text as events,
        min(terminal_at) as oldest_terminal_at,
        max(terminal_at) as newest_terminal_at
      from active_candidates
      group by venue, status
      order by venue, status
    `,
    [args.venues.length > 0 ? args.venues : null, args.cutoffDays],
  );

  return rows;
}

async function relationExists(
  client: PoolClient,
  relationName: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `select to_regclass($1) is not null as exists`,
    [relationName],
  );
  return rows[0]?.exists === true;
}

async function queryBatchSummary(
  client: PoolClient,
  args: Args,
): Promise<BatchSummaryRow[]> {
  const includeTelegramTradeIntents = await relationExists(
    client,
    "public.telegram_trade_intents",
  );
  const telegramTradeIntentsEphemeralDerived = includeTelegramTradeIntents
    ? telegramTradeIntentEphemeralDerivedSql("candidate_pool")
    : "";
  const { rows } = await client.query<BatchSummaryRow>(
    `
      ${candidateCte({ includeTelegramTradeIntents })},
      derived_refs as materialized (
        select 'unified_market_tokens' as label, count(distinct x.market_id)::text as markets, count(*)::text as rows
        from unified_market_tokens x
        join candidate_pool c on c.market_id = x.market_id
        union all
        select 'unified_tokens' as label, count(distinct x.market_id)::text as markets, count(*)::text as rows
        from unified_tokens x
        join candidate_pool c on c.market_id = x.market_id
        union all
        select 'unified_market_change_24h' as label, count(distinct x.market_id)::text as markets, count(*)::text as rows
        from unified_market_change_24h x
        join candidate_pool c on c.market_id = x.market_id
        union all
        select 'unified_market_trade_24h' as label, count(distinct x.market_id)::text as markets, count(*)::text as rows
        from unified_market_trade_24h x
        join candidate_pool c on c.market_id = x.market_id
        union all
        select 'unified_market_activity_snapshots_1h' as label, count(distinct x.market_id)::text as markets, count(*)::text as rows
        from unified_market_activity_snapshots_1h x
        join candidate_pool c on c.market_id = x.market_id
        union all
        select 'unified_token_change_24h' as label, count(distinct ct.market_id)::text as markets, count(*)::text as rows
        from unified_token_change_24h x
        join candidate_tokens ct on ct.token_id = x.token_id
        union all
        select 'unified_token_top_latest' as label, count(distinct ct.market_id)::text as markets, count(*)::text as rows
        from unified_token_top_latest x
        join candidate_tokens ct on ct.token_id = x.token_id
        union all
        select 'unified_event_change_24h' as label, count(distinct c.event_id)::text as markets, count(*)::text as rows
        from unified_event_change_24h x
        join candidate_events c on c.event_id = x.event_id
        union all
        select 'unified_event_trade_24h' as label, count(distinct c.event_id)::text as markets, count(*)::text as rows
        from unified_event_trade_24h x
        join candidate_events c on c.event_id = x.event_id
        union all
        select 'unified_event_activity_snapshots_1h' as label, count(distinct c.event_id)::text as markets, count(*)::text as rows
        from unified_event_activity_snapshots_1h x
        join candidate_events c on c.event_id = x.event_id
        union all
        select 'unified_market_activity_metrics_24h' as label, count(distinct x.market_id)::text as markets, count(*)::text as rows
        from unified_market_activity_metrics_24h x
        join candidate_pool c on c.market_id = x.market_id
        union all
        select 'unified_event_activity_metrics_24h' as label, count(distinct c.event_id)::text as markets, count(*)::text as rows
        from unified_event_activity_metrics_24h x
        join candidate_events c on c.event_id = x.event_id
        ${telegramTradeIntentsEphemeralDerived}
      )
      select
        'pool_total' as section,
        null::text as venue,
        null::text as status,
        'all' as label,
        count(*)::text as markets,
        null::text as rows,
        min(terminal_at) as oldest_terminal_at,
        max(terminal_at) as newest_terminal_at
      from candidate_pool
      union all
      select
        'pool_by_venue_status' as section,
        venue,
        status,
        'all' as label,
        count(*)::text as markets,
        null::text as rows,
        min(terminal_at) as oldest_terminal_at,
        max(terminal_at) as newest_terminal_at
      from candidate_pool
      group by venue, status
      union all
      select
        'removable_total' as section,
        null::text as venue,
        null::text as status,
        'all' as label,
        count(*)::text as markets,
        null::text as rows,
        min(c.terminal_at) as oldest_terminal_at,
        max(c.terminal_at) as newest_terminal_at
      from candidate_pool c
      left join protected_market_ids p on p.market_id = c.market_id
      where p.market_id is null
      union all
      select
        'removable_by_venue_status' as section,
        c.venue,
        c.status,
        'all' as label,
        count(*)::text as markets,
        null::text as rows,
        min(c.terminal_at) as oldest_terminal_at,
        max(c.terminal_at) as newest_terminal_at
      from candidate_pool c
      left join protected_market_ids p on p.market_id = c.market_id
      where p.market_id is null
      group by c.venue, c.status
      union all
      select
        'protected_by_reason' as section,
        null::text as venue,
        null::text as status,
        reason as label,
        count(distinct market_id)::text as markets,
        null::text as rows,
        null::timestamptz as oldest_terminal_at,
        null::timestamptz as newest_terminal_at
      from protected_refs
      group by reason
      union all
      select
        'derived_by_table' as section,
        null::text as venue,
        null::text as status,
        label,
        markets,
        rows,
        null::timestamptz as oldest_terminal_at,
        null::timestamptz as newest_terminal_at
      from derived_refs
      order by section, venue nulls first, status nulls first, label
    `,
    queryParams(args),
  );

  return rows;
}

async function queryRemovableSamples(
  client: PoolClient,
  args: Args,
): Promise<SampleRow[]> {
  const includeTelegramTradeIntents = await relationExists(
    client,
    "public.telegram_trade_intents",
  );
  const { rows } = await client.query<SampleRow>(
    `
      ${candidateCte({ includeTelegramTradeIntents })}
      select
        c.market_id,
        c.venue,
        c.status,
        c.event_id,
        c.title,
        c.terminal_at,
        count(distinct ct.token_id)::text as token_count
      from candidate_pool c
      left join protected_market_ids p on p.market_id = c.market_id
      left join candidate_tokens ct on ct.market_id = c.market_id
      where p.market_id is null
      group by c.market_id, c.venue, c.status, c.event_id, c.title, c.terminal_at
      order by c.terminal_at asc, c.market_id asc
      limit $5::int
    `,
    [...queryParams(args), args.sampleLimit],
  );

  return rows;
}

function dateToString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function formatSummaryRow(
  row: GlobalSummaryRow,
): Record<string, string | null> {
  return {
    venue: row.venue,
    status: row.status,
    markets: row.markets,
    events: row.events,
    oldest: dateToString(row.oldest_terminal_at),
    newest: dateToString(row.newest_terminal_at),
  };
}

function formatBatchRow(row: BatchSummaryRow): Record<string, string | null> {
  return {
    section: row.section,
    venue: row.venue,
    status: row.status,
    label: row.label,
    markets: row.markets,
    rows: row.rows,
    oldest: dateToString(row.oldest_terminal_at),
    newest: dateToString(row.newest_terminal_at),
  };
}

function formatSampleRow(row: SampleRow): Record<string, string | null> {
  return {
    marketId: row.market_id,
    venue: row.venue,
    status: row.status,
    eventId: row.event_id,
    terminalAt: dateToString(row.terminal_at),
    tokenCount: row.token_count,
    title: row.title,
  };
}

function logSection(title: string): void {
  console.log(`\n[market:retention:select] ${title}`);
}

async function buildReport(args: Args) {
  const client = await pool.connect();

  try {
    await client.query("begin read only");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);

    const terminalSummary = await queryGlobalTerminalSummary(client, args);
    const activePastTerminalSummary = await queryActivePastTerminalSummary(
      client,
      args,
    );
    const batchSummary = await queryBatchSummary(client, args);
    const removableSamples = await queryRemovableSamples(client, args);

    await client.query("commit");

    return {
      args,
      terminalSummary,
      activePastTerminalSummary,
      batchSummary,
      removableSamples,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function countTempRows(
  client: PoolClient,
  label: string,
  tableName: string,
): Promise<DeleteCountRow> {
  const { rows } = await client.query<{ rows: string }>(
    `select count(*)::text as rows from ${tableName}`,
  );
  return { label, rows: rows[0]?.rows ?? "0" };
}

async function deleteAndCount(
  client: PoolClient,
  label: string,
  deleteSql: string,
): Promise<DeleteCountRow> {
  const { rows } = await client.query<{ rows: string }>(
    `
      with deleted as (
        ${deleteSql}
        returning 1
      )
      select count(*)::text as rows from deleted
    `,
  );
  return { label, rows: rows[0]?.rows ?? "0" };
}

async function queryProtectedRefCounts(
  client: PoolClient,
): Promise<DeleteCountRow[]> {
  const { rows } = await client.query<DeleteCountRow>(
    `
      select reason as label, count(distinct market_id)::text as rows
      from tmp_market_retention_protected_refs
      group by reason
      order by reason
    `,
  );
  return rows;
}

async function materializeDeletionSet(
  client: PoolClient,
  args: Args,
): Promise<DeleteCountRow[]> {
  const includeTelegramTradeIntents = await relationExists(
    client,
    "public.telegram_trade_intents",
  );
  await client.query(
    `
      create temp table tmp_market_retention_removable_markets on commit drop as
      ${candidateCte({ includeTelegramTradeIntents })}
      select
        c.market_id,
        c.venue,
        c.status,
        c.event_id,
        c.terminal_at
      from candidate_pool c
      left join protected_market_ids p on p.market_id = c.market_id
      where p.market_id is null
    `,
    queryParams(args),
  );

  await client.query(
    `
      create temp table tmp_market_retention_removable_events on commit drop as
      select distinct event_id, venue
      from tmp_market_retention_removable_markets
    `,
  );

  await client.query(
    `
      create temp table tmp_market_retention_removable_tokens on commit drop as
      select distinct r.market_id, umt.token_id
      from tmp_market_retention_removable_markets r
      join unified_market_tokens umt on umt.market_id = r.market_id
      where umt.token_id is not null and umt.token_id <> ''
      union
      select distinct r.market_id, ut.token_id
      from tmp_market_retention_removable_markets r
      join unified_tokens ut on ut.market_id = r.market_id
      where ut.token_id is not null and ut.token_id <> ''
      union
      select distinct r.market_id, m.token_yes as token_id
      from tmp_market_retention_removable_markets r
      join unified_markets m on m.id = r.market_id
      where m.token_yes is not null and m.token_yes <> ''
      union
      select distinct r.market_id, m.token_no as token_id
      from tmp_market_retention_removable_markets r
      join unified_markets m on m.id = r.market_id
      where m.token_no is not null and m.token_no <> ''
    `,
  );

  await client.query(
    `
      create temp table tmp_market_retention_protected_ref_tokens on commit drop as
      ${refTokensSql(
        "tmp_market_retention_removable_markets",
        "tmp_market_retention_removable_tokens",
      )}
    `,
  );

  await client.query(
    `
      create temp table tmp_market_retention_protected_refs on commit drop as
      ${protectedRefsSql(
        "tmp_market_retention_removable_markets",
        "tmp_market_retention_protected_ref_tokens",
        { includeTelegramTradeIntents },
      )}
    `,
  );

  const protectedCounts = await queryProtectedRefCounts(client);
  if (protectedCounts.length > 0) {
    throw new Error(
      `Retention delete aborted: removable set still has protected refs ${JSON.stringify(
        protectedCounts,
      )}`,
    );
  }

  return [
    await countTempRows(
      client,
      "removable_markets",
      "tmp_market_retention_removable_markets",
    ),
    await countTempRows(
      client,
      "removable_events_touched",
      "tmp_market_retention_removable_events",
    ),
    await countTempRows(
      client,
      "removable_tokens",
      "tmp_market_retention_removable_tokens",
    ),
  ];
}

async function runMarketDeletes(client: PoolClient): Promise<DeleteCountRow[]> {
  const counts: DeleteCountRow[] = [];
  const includeTelegramTradeIntents = await relationExists(
    client,
    "public.telegram_trade_intents",
  );

  counts.push(
    await deleteAndCount(
      client,
      "unified_market_activity_snapshots_1h",
      `
        delete from unified_market_activity_snapshots_1h x
        using tmp_market_retention_removable_markets r
        where x.market_id = r.market_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_market_activity_metrics_24h",
      `
        delete from unified_market_activity_metrics_24h x
        using tmp_market_retention_removable_markets r
        where x.market_id = r.market_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_market_change_24h",
      `
        delete from unified_market_change_24h x
        using tmp_market_retention_removable_markets r
        where x.market_id = r.market_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_market_trade_24h",
      `
        delete from unified_market_trade_24h x
        using tmp_market_retention_removable_markets r
        where x.market_id = r.market_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_token_change_24h",
      `
        delete from unified_token_change_24h x
        using tmp_market_retention_removable_tokens t
        where x.token_id = t.token_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_token_top_latest",
      `
        delete from unified_token_top_latest x
        using tmp_market_retention_removable_tokens t
        where x.token_id = t.token_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_tokens",
      `
        delete from unified_tokens x
        using tmp_market_retention_removable_markets r
        where x.market_id = r.market_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_market_tokens",
      `
        delete from unified_market_tokens x
        using tmp_market_retention_removable_markets r
        where x.market_id = r.market_id
      `,
    ),
  );
  if (includeTelegramTradeIntents) {
    counts.push(
      await deleteAndCount(
        client,
        "telegram_trade_intents_ephemeral_cleanup",
        `
          delete from telegram_trade_intents x
          using tmp_market_retention_removable_markets r
          where x.market_id = r.market_id
            and ${telegramTradeIntentEphemeralPredicate("x")}
        `,
      ),
    );
  }
  counts.push(
    await deleteAndCount(
      client,
      "unified_markets",
      `
        delete from unified_markets x
        using tmp_market_retention_removable_markets r
        where x.id = r.market_id
      `,
    ),
  );

  return counts;
}

async function materializeOrphanEvents(
  client: PoolClient,
): Promise<DeleteCountRow> {
  await client.query(
    `
      create temp table tmp_market_retention_orphan_events on commit drop as
      select distinct e.event_id, e.venue
      from tmp_market_retention_removable_events e
      where not exists (
        select 1
        from unified_markets m
        where m.event_id = e.event_id
      )
    `,
  );

  return countTempRows(
    client,
    "orphan_events",
    "tmp_market_retention_orphan_events",
  );
}

async function runEventDeletes(client: PoolClient): Promise<DeleteCountRow[]> {
  const counts: DeleteCountRow[] = [];

  counts.push(
    await deleteAndCount(
      client,
      "unified_event_activity_snapshots_1h",
      `
        delete from unified_event_activity_snapshots_1h x
        using tmp_market_retention_orphan_events e
        where x.event_id = e.event_id
          and x.venue = e.venue
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_event_activity_metrics_24h",
      `
        delete from unified_event_activity_metrics_24h x
        using tmp_market_retention_orphan_events e
        where x.event_id = e.event_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_event_change_24h",
      `
        delete from unified_event_change_24h x
        using tmp_market_retention_orphan_events e
        where x.event_id = e.event_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_event_trade_24h",
      `
        delete from unified_event_trade_24h x
        using tmp_market_retention_orphan_events e
        where x.event_id = e.event_id
      `,
    ),
  );
  counts.push(
    await deleteAndCount(
      client,
      "unified_events",
      `
        delete from unified_events x
        using tmp_market_retention_orphan_events e
        where x.id = e.event_id
      `,
    ),
  );

  return counts;
}

async function queryPostDeleteValidation(
  client: PoolClient,
): Promise<DeleteCountRow[]> {
  const includeTelegramTradeIntents = await relationExists(
    client,
    "public.telegram_trade_intents",
  );
  await client.query(
    `
      create temp table tmp_market_retention_post_delete_protected_refs on commit drop as
      ${protectedRefsSql(
        "tmp_market_retention_removable_markets",
        "tmp_market_retention_protected_ref_tokens",
        { includeTelegramTradeIntents },
      )}
    `,
  );

  const protectedRefFailures = await client.query<DeleteCountRow>(
    `
      select concat('post_delete_protected:', reason) as label,
        count(distinct market_id)::text as rows
      from tmp_market_retention_post_delete_protected_refs
      group by reason
      order by reason
    `,
  );
  if (protectedRefFailures.rows.length > 0) {
    throw new Error(
      `Retention delete post-validation found protected refs ${JSON.stringify(
        protectedRefFailures.rows,
      )}`,
    );
  }

  const { rows } = await client.query<DeleteCountRow>(
    `
      select 'remaining_unified_markets' as label, count(*)::text as rows
      from unified_markets x
      join tmp_market_retention_removable_markets r on r.market_id = x.id
      union all
      select 'remaining_unified_market_tokens' as label, count(*)::text as rows
      from unified_market_tokens x
      join tmp_market_retention_removable_markets r on r.market_id = x.market_id
      union all
      select 'remaining_unified_tokens' as label, count(*)::text as rows
      from unified_tokens x
      join tmp_market_retention_removable_markets r on r.market_id = x.market_id
      union all
      select 'remaining_market_activity_snapshots' as label, count(*)::text as rows
      from unified_market_activity_snapshots_1h x
      join tmp_market_retention_removable_markets r on r.market_id = x.market_id
      union all
      select 'remaining_orphan_unified_events' as label, count(*)::text as rows
      from unified_events x
      join tmp_market_retention_orphan_events e on e.event_id = x.id
    `,
  );

  const failures = rows.filter((row) => Number(row.rows) > 0);
  if (failures.length > 0) {
    throw new Error(
      `Retention delete post-validation failed ${JSON.stringify(failures)}`,
    );
  }

  return rows;
}

async function executeDeletion(args: Args) {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);

    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext('market_retention_delete')) as locked",
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error("Retention delete aborted: another cleanup is running");
    }

    const selectionCounts = await materializeDeletionSet(client, args);
    const marketDeleteCounts = await runMarketDeletes(client);
    const orphanEventCount = await materializeOrphanEvents(client);
    const eventDeleteCounts = await runEventDeletes(client);
    const postDeleteValidation = await queryPostDeleteValidation(client);

    await client.query("commit");

    return {
      args,
      selectionCounts,
      deleteCounts: [
        ...marketDeleteCounts,
        orphanEventCount,
        ...eventDeleteCounts,
      ],
      postDeleteValidation,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (hasFlag(rawArgs, "help")) {
    printUsage();
    return;
  }

  const args = parseArgs(rawArgs);
  assertExecutionFlags(args);
  const startedAt = Date.now();

  if (args.execute) {
    const result = await executeDeletion(args);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            args: result.args,
            durationMs: Date.now() - startedAt,
            selectionCounts: result.selectionCounts,
            deleteCounts: result.deleteCounts,
            postDeleteValidation: result.postDeleteValidation,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log("[market:retention:select] execute delete", {
      cutoffDays: args.cutoffDays,
      limit: args.limit,
      statuses: args.statuses,
      venues: args.venues.length > 0 ? args.venues : "all",
      statementTimeoutSec: args.statementTimeoutSec,
    });
    logSection("selection counts");
    console.table(result.selectionCounts);
    logSection("delete counts");
    console.table(result.deleteCounts);
    logSection("post-delete validation");
    console.table(result.postDeleteValidation);
    console.log("[market:retention:select] done", {
      durationMs: Date.now() - startedAt,
      readOnly: false,
    });
    return;
  }

  const report = await buildReport(args);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          args: report.args,
          durationMs: Date.now() - startedAt,
          terminalSummary: report.terminalSummary.map(formatSummaryRow),
          activePastTerminalSummary:
            report.activePastTerminalSummary.map(formatSummaryRow),
          batchSummary: report.batchSummary.map(formatBatchRow),
          removableSamples: report.removableSamples.map(formatSampleRow),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("[market:retention:select] selector-only dry run", {
    cutoffDays: args.cutoffDays,
    limit: args.limit,
    sampleLimit: args.sampleLimit,
    statuses: args.statuses,
    venues: args.venues.length > 0 ? args.venues : "all",
    statementTimeoutSec: args.statementTimeoutSec,
  });

  logSection("terminal candidates older than cutoff");
  console.table(report.terminalSummary.map(formatSummaryRow));

  logSection("active past-terminal markets not selected for hard delete");
  console.table(report.activePastTerminalSummary.map(formatSummaryRow));

  logSection("bounded candidate batch");
  console.table(report.batchSummary.map(formatBatchRow));

  logSection("removable samples");
  console.table(report.removableSamples.map(formatSampleRow));

  console.log("[market:retention:select] done", {
    durationMs: Date.now() - startedAt,
    readOnly: true,
  });
}

main()
  .catch((error) => {
    console.error("[market:retention:select] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
