#!/usr/bin/env tsx

import type { Pool, PoolClient } from "@hunch/infra";
import { pool } from "./db.js";
import { recomputePositionMetricsForWalletInTx } from "./services/positions-metrics.js";

type Args = {
  confirmFix: boolean;
  execute: boolean;
  json: boolean;
  sampleLimit: number;
  statementTimeoutSec: number;
};

export type CleanupCountRow = {
  label: string;
  rows: string;
};

type DuplicateSummaryRow = {
  section: string;
  table_name: string;
  column_name: string;
  groups: string;
  rows: string;
  duplicate_rows: string;
};

type DuplicateSampleRow = {
  table_name: string;
  column_name: string;
  user_id: string | null;
  venue: string | null;
  position_scope: string | null;
  wallet_key: string;
  token_id: string | null;
  variants: string[];
  rows: string;
};

type AffectedWalletRow = {
  user_id: string;
  wallet_address: string;
};

export type WalletCasingCleanupReport = {
  duplicateSummary: DuplicateSummaryRow[];
  duplicateSamples: DuplicateSampleRow[];
};

export type WalletCasingCleanupResult = WalletCasingCleanupReport & {
  mutationCounts: CleanupCountRow[];
  postValidation: DuplicateSummaryRow[];
};

type Queryable = Pick<PoolClient, "query">;

const DEFAULT_SAMPLE_LIMIT = 20;
const EVM_SQL = "^0x[0-9a-fA-F]{40}$";

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

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

  return values;
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

export function parseArgs(argvInput: string[]): Args {
  const argv = argvInput.filter((arg) => arg !== "--");
  return {
    confirmFix: hasFlag(argv, "confirm-fix"),
    execute: hasFlag(argv, "execute"),
    json: hasFlag(argv, "json"),
    sampleLimit: readPositiveInt(argv, "sample", DEFAULT_SAMPLE_LIMIT),
    statementTimeoutSec: readPositiveInt(argv, "statement-timeout-sec", 180),
  };
}

export function assertExecutionFlags(args: Args): void {
  if (args.execute === args.confirmFix) return;
  throw new Error(
    "Wallet casing cleanup requires both --execute and --confirm-fix. Omit both flags for dry-run.",
  );
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -C hunch-monorepo -F api run wallet:casing:cleanup -- [options]

Options:
  --sample <count>              Duplicate sample row count. Default: ${DEFAULT_SAMPLE_LIMIT}
  --statement-timeout-sec <sec> Query timeout. Default: 180
  --json                        Emit one JSON report.
  --execute                     Normalize/merge rows. Requires --confirm-fix.
  --confirm-fix                 Required together with --execute.
  --help                        Show this message.

Dry-run is the default. Execute mode uses a transaction, advisory lock, lowercases
EVM storage identities in orders/positions/funders, merges duplicate position rows,
and recomputes affected Polymarket position metrics.`);
}

async function queryDuplicateSummary(
  db: Queryable,
): Promise<DuplicateSummaryRow[]> {
  const { rows } = await db.query<DuplicateSummaryRow>(
    `
      with duplicate_groups as (
        select
          'positions_wallet_variants' as section,
          'positions' as table_name,
          'wallet_address' as column_name,
          count(*)::text as groups,
          coalesce(sum(row_count), 0)::text as rows,
          coalesce(sum(row_count - 1), 0)::text as duplicate_rows
        from (
          select
            user_id,
            venue,
            position_scope,
            lower(wallet_address) as wallet_key,
            count(*) as row_count
          from positions
          where wallet_address ~ $1
          group by user_id, venue, position_scope, lower(wallet_address)
          having count(distinct wallet_address) > 1
        ) g
        union all
        select
          'positions_cross_scope_conflicts',
          'positions',
          'wallet_address',
          count(*)::text,
          coalesce(sum(row_count), 0)::text,
          coalesce(sum(row_count - 1), 0)::text
        from (
          select user_id, venue, lower(wallet_address) as wallet_key, token_id, count(*) as row_count
          from positions
          where wallet_address ~ $1
          group by user_id, venue, lower(wallet_address), token_id
          having count(*) > 1 and count(distinct position_scope) > 1
        ) g
        union all
        select
          'positions_token_duplicates',
          'positions',
          'wallet_address',
          count(*)::text,
          coalesce(sum(row_count), 0)::text,
          coalesce(sum(row_count - 1), 0)::text
        from (
          select
            user_id,
            venue,
            position_scope,
            lower(wallet_address) as wallet_key,
            token_id,
            count(*) as row_count
          from positions
          where wallet_address ~ $1
          group by user_id, venue, position_scope, lower(wallet_address), token_id
          having count(*) > 1
        ) g
        union all
        select
          'orders_wallet_variants',
          'orders',
          'wallet_address',
          count(*)::text,
          coalesce(sum(row_count), 0)::text,
          coalesce(sum(row_count - 1), 0)::text
        from (
          select user_id, venue, lower(wallet_address) as wallet_key, count(*) as row_count
          from orders
          where wallet_address ~ $1
          group by user_id, venue, lower(wallet_address)
          having count(distinct wallet_address) > 1
        ) g
        union all
        select
          'orders_signer_variants',
          'orders',
          'signer_address',
          count(*)::text,
          coalesce(sum(row_count), 0)::text,
          coalesce(sum(row_count - 1), 0)::text
        from (
          select user_id, venue, lower(signer_address) as wallet_key, count(*) as row_count
          from orders
          where signer_address ~ $1
          group by user_id, venue, lower(signer_address)
          having count(distinct signer_address) > 1
        ) g
        union all
        select
          'credentials_funder_variants',
          'user_venue_credentials',
          'funder_address',
          count(*)::text,
          coalesce(sum(row_count), 0)::text,
          coalesce(sum(row_count - 1), 0)::text
        from (
          select user_id, venue, lower(funder_address) as wallet_key, count(*) as row_count
          from user_venue_credentials
          where funder_address ~ $1
          group by user_id, venue, lower(funder_address)
          having count(distinct funder_address) > 1
        ) g
      )
      select *
      from duplicate_groups
      order by section
    `,
    [EVM_SQL],
  );
  return rows;
}

async function queryDuplicateSamples(
  db: Queryable,
  sampleLimit: number,
): Promise<DuplicateSampleRow[]> {
  const { rows } = await db.query<DuplicateSampleRow>(
    `
      with samples as (
        select
          'positions' as table_name,
          'wallet_address' as column_name,
          user_id::text,
          venue,
          nullif(position_scope, '') as position_scope,
          lower(wallet_address) as wallet_key,
          null::text as token_id,
          array_agg(distinct wallet_address order by wallet_address) as variants,
          count(*)::text as rows
        from positions
        where wallet_address ~ $1
        group by user_id, venue, position_scope, lower(wallet_address)
        having count(distinct wallet_address) > 1
        union all
        select
          'positions',
          'wallet_address',
          user_id::text,
          venue,
          nullif(position_scope, ''),
          lower(wallet_address),
          token_id,
          array_agg(distinct wallet_address order by wallet_address),
          count(*)::text
        from positions
        where wallet_address ~ $1
        group by user_id, venue, position_scope, lower(wallet_address), token_id
        having count(*) > 1
        union all
        select
          'orders',
          'wallet_address',
          user_id::text,
          venue,
          null::text,
          lower(wallet_address),
          null::text,
          array_agg(distinct wallet_address order by wallet_address),
          count(*)::text
        from orders
        where wallet_address ~ $1
        group by user_id, venue, lower(wallet_address)
        having count(distinct wallet_address) > 1
        union all
        select
          'orders',
          'signer_address',
          user_id::text,
          venue,
          null::text,
          lower(signer_address),
          null::text,
          array_agg(distinct signer_address order by signer_address),
          count(*)::text
        from orders
        where signer_address ~ $1
        group by user_id, venue, lower(signer_address)
        having count(distinct signer_address) > 1
        union all
        select
          'user_venue_credentials',
          'funder_address',
          user_id::text,
          venue,
          null::text,
          lower(funder_address),
          null::text,
          array_agg(distinct funder_address order by funder_address),
          count(*)::text
        from user_venue_credentials
        where funder_address ~ $1
        group by user_id, venue, lower(funder_address)
        having count(distinct funder_address) > 1
      )
      select *
      from samples
      order by table_name, column_name, rows::int desc, wallet_key
      limit $2
    `,
    [EVM_SQL, sampleLimit],
  );
  return rows;
}

export async function buildWalletCasingCleanupReport(
  db: Queryable,
  args: Pick<Args, "sampleLimit">,
): Promise<WalletCasingCleanupReport> {
  const duplicateSummary = await queryDuplicateSummary(db);
  const duplicateSamples = await queryDuplicateSamples(db, args.sampleLimit);
  return { duplicateSummary, duplicateSamples };
}

async function queryCount(
  client: Queryable,
  label: string,
  sql: string,
  params: unknown[] = [],
): Promise<CleanupCountRow> {
  const { rows } = await client.query<{ rows: string }>(sql, params);
  return {
    label,
    rows: rows[0]?.rows ?? "0",
  };
}

async function materializePositionMergeSet(client: Queryable): Promise<void> {
  await client.query(
    `
      create temp table wallet_casing_position_ranked on commit drop as
      select
        p.id,
        p.user_id,
        p.venue,
        p.position_scope,
        p.wallet_address as original_wallet_address,
        lower(p.wallet_address) as canonical_wallet_address,
        p.token_id,
        row_number() over (
          partition by
            p.user_id,
            p.venue,
            p.position_scope,
            lower(p.wallet_address),
            p.token_id
          order by
            case when p.side <> 'FLAT' and p.size > 0 then 1 else 0 end desc,
            case when p.position_scope = 'own' then 1 else 0 end desc,
            p.last_updated_at desc nulls last,
            p.updated_at desc nulls last,
            p.created_at desc nulls last,
            p.id desc
        ) as rn,
        count(*) over (
          partition by
            p.user_id,
            p.venue,
            p.position_scope,
            lower(p.wallet_address),
            p.token_id
        ) as group_rows
      from positions p
      where p.wallet_address ~ $1
    `,
    [EVM_SQL],
  );

  await client.query(
    `
      create temp table wallet_casing_position_cross_scope_conflicts on commit drop as
      select
        p.user_id,
        p.venue,
        lower(p.wallet_address) as wallet_address,
        p.token_id,
        array_agg(distinct p.position_scope order by p.position_scope) as scopes,
        array_agg(distinct p.wallet_address order by p.wallet_address) as variants,
        count(*) as rows
      from positions p
      where p.wallet_address ~ $1
      group by p.user_id, p.venue, lower(p.wallet_address), p.token_id
      having count(*) > 1 and count(distinct p.position_scope) > 1
    `,
    [EVM_SQL],
  );

  await client.query(
    `
      create temp table wallet_casing_affected_polymarket on commit drop as
      select distinct user_id, canonical_wallet_address as wallet_address
      from wallet_casing_position_ranked
      where venue = 'polymarket'
        and position_scope = 'own'
        and (
          group_rows > 1
          or original_wallet_address <> canonical_wallet_address
        )
    `,
  );
}

export async function runWalletCasingCleanupMutationsInTx(
  client: Queryable,
): Promise<CleanupCountRow[]> {
  await materializePositionMergeSet(client);

  const crossScopeConflicts = await queryCount(
    client,
    "positions_cross_scope_conflicts",
    "select count(*)::text as rows from wallet_casing_position_cross_scope_conflicts",
  );
  if (Number(crossScopeConflicts.rows) > 0) {
    throw new Error(
      `Wallet casing cleanup aborted: ${crossScopeConflicts.rows} cross-scope position wallet/token conflicts require manual review`,
    );
  }

  const counts: CleanupCountRow[] = [];
  counts.push(
    await queryCount(
      client,
      "positions_duplicate_rows_deleted",
      `
        with deleted as (
          delete from positions p
          using wallet_casing_position_ranked r
          where p.id = r.id
            and r.rn > 1
          returning 1
        )
        select count(*)::text as rows from deleted
      `,
    ),
  );

  counts.push(
    await queryCount(
      client,
      "positions_wallet_address_normalized",
      `
        with updated as (
          update positions
          set wallet_address = lower(wallet_address),
              updated_at = now()
          where wallet_address ~ $1
            and wallet_address <> lower(wallet_address)
          returning 1
        )
        select count(*)::text as rows from updated
      `,
      [EVM_SQL],
    ),
  );

  counts.push(
    await queryCount(
      client,
      "orders_wallet_address_normalized",
      `
        with updated as (
          update orders
          set wallet_address = lower(wallet_address)
          where wallet_address ~ $1
            and wallet_address <> lower(wallet_address)
          returning 1
        )
        select count(*)::text as rows from updated
      `,
      [EVM_SQL],
    ),
  );

  counts.push(
    await queryCount(
      client,
      "orders_signer_address_normalized",
      `
        with updated as (
          update orders
          set signer_address = lower(signer_address)
          where signer_address ~ $1
            and signer_address <> lower(signer_address)
          returning 1
        )
        select count(*)::text as rows from updated
      `,
      [EVM_SQL],
    ),
  );

  counts.push(
    await queryCount(
      client,
      "credentials_funder_address_normalized",
      `
        with updated as (
          update user_venue_credentials
          set funder_address = lower(funder_address),
              funder_updated_at = coalesce(funder_updated_at, now()),
              updated_at = now()
          where funder_address ~ $1
            and funder_address <> lower(funder_address)
          returning 1
        )
        select count(*)::text as rows from updated
      `,
      [EVM_SQL],
    ),
  );

  const { rows: affectedWallets } = await client.query<AffectedWalletRow>(
    `
        select user_id::text, wallet_address
        from wallet_casing_affected_polymarket
        order by user_id, wallet_address
      `,
  );

  for (const wallet of affectedWallets) {
    await recomputePositionMetricsForWalletInTx(client, {
      userId: wallet.user_id,
      walletAddress: wallet.wallet_address,
      venue: "polymarket",
    });
  }

  counts.push({
    label: "polymarket_wallets_recomputed",
    rows: String(affectedWallets.length),
  });

  return counts;
}

export async function executeWalletCasingCleanup(
  dbPool: Pick<Pool, "connect">,
  args: Args,
): Promise<WalletCasingCleanupResult> {
  assertExecutionFlags(args);
  if (!args.execute) {
    throw new Error("executeWalletCasingCleanup requires --execute");
  }

  const client = await dbPool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);

    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext('wallet_casing_cleanup')) as locked",
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error(
        "Wallet casing cleanup aborted: another cleanup is running",
      );
    }

    const before = await buildWalletCasingCleanupReport(client, args);
    const mutationCounts = await runWalletCasingCleanupMutationsInTx(client);
    const postValidation = await queryDuplicateSummary(client);

    await client.query("commit");

    return {
      ...before,
      mutationCounts,
      postValidation,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function buildWalletCasingCleanupReportFromPool(
  dbPool: Pick<Pool, "connect">,
  args: Args,
): Promise<WalletCasingCleanupReport> {
  const client = await dbPool.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);
    const report = await buildWalletCasingCleanupReport(client, args);
    await client.query("rollback");
    return report;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function logSection(name: string): void {
  console.log(`\n[wallet:casing:cleanup] ${name}`);
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
    const result = await executeWalletCasingCleanup(pool, args);
    if (args.json) {
      console.log(
        JSON.stringify(
          { ...result, durationMs: Date.now() - startedAt, readOnly: false },
          null,
          2,
        ),
      );
      return;
    }
    console.log("[wallet:casing:cleanup] execute fix", {
      statementTimeoutSec: args.statementTimeoutSec,
    });
    logSection("pre-cleanup duplicate summary");
    console.table(result.duplicateSummary);
    logSection("mutation counts");
    console.table(result.mutationCounts);
    logSection("post-cleanup validation");
    console.table(result.postValidation);
    console.log("[wallet:casing:cleanup] done", {
      durationMs: Date.now() - startedAt,
      readOnly: false,
    });
    return;
  }

  const report = await buildWalletCasingCleanupReportFromPool(pool, args);
  if (args.json) {
    console.log(
      JSON.stringify(
        { ...report, durationMs: Date.now() - startedAt, readOnly: true },
        null,
        2,
      ),
    );
    return;
  }

  console.log("[wallet:casing:cleanup] dry-run", {
    statementTimeoutSec: args.statementTimeoutSec,
  });
  logSection("duplicate summary");
  console.table(report.duplicateSummary);
  logSection("samples");
  console.table(report.duplicateSamples);
  console.log("[wallet:casing:cleanup] done", {
    durationMs: Date.now() - startedAt,
    readOnly: true,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((error) => {
      console.error("[wallet:casing:cleanup] failed", error);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end().catch(() => {});
    });
}
