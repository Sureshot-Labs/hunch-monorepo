import type { DbQuery } from "../db.js";

export type AdminSolanaSponsorshipLedgerFilters = {
  q?: string;
  venue?: "kalshi" | "bridge" | "wallet";
  flow?: "dflow" | "across" | "directTransfer" | "debridge";
  status?: string;
  rentStatus?: string;
  wallet?: string;
  sponsor?: string;
  intentId?: string;
  txSignature?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

type QueryParts = {
  clauses: string[];
  params: unknown[];
};

type LedgerUserRow = {
  user_id: string | null;
  user_email: string | null;
  user_username: string | null;
  user_display_name: string | null;
};

type SponsorshipLedgerRow = LedgerUserRow & {
  id: string;
  created_at: Date;
  updated_at: Date;
  venue: string;
  flow: string;
  status: string;
  intent_id: string | null;
  wallet_address: string | null;
  sponsor_address: string | null;
  market_id: string | null;
  input_mint: string | null;
  output_mint: string | null;
  amount_raw: string | null;
  message_digest: string | null;
  transaction_digest: string | null;
  tx_signature: string | null;
  estimated_sponsor_lamports: string;
  actual_sponsor_lamports: string | null;
  rent_lamports: string | null;
  rent_status: string;
  error: string | null;
  metadata: unknown;
};

type CountRow = {
  count: string;
};

type GroupCountRow = {
  key: string | null;
  count: string;
};

type TotalsRow = {
  count: string;
  estimated_sponsor_lamports: string;
  actual_sponsor_lamports: string;
  rent_lamports: string;
  reclaimed_lamports: string;
  close_fee_lamports: string;
  net_actual_sponsor_lamports: string;
};

const SOLSCAN_TX_BASE_URL = "https://solscan.io/tx";
const SOLSCAN_ACCOUNT_BASE_URL = "https://solscan.io/account";
const DIGITS_RE = /^\d+$/;

function push(parts: QueryParts, value: unknown): string {
  parts.params.push(value);
  return `$${parts.params.length}`;
}

function whereSql(parts: QueryParts): string {
  return parts.clauses.length ? `where ${parts.clauses.join("\n  and ")}` : "";
}

function limitOffset(query: AdminSolanaSponsorshipLedgerFilters): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Math.max(query.limit ?? 50, 1), 100),
    offset: Math.max(query.offset ?? 0, 0),
  };
}

function countToNumber(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordValue(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function arrayValue(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const nested = value[key];
  return Array.isArray(nested) ? nested : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function lamportString(value: unknown): string | null {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DIGITS_RE.test(trimmed) ? trimmed : null;
}

function lamportBigInt(value: unknown): bigint | null {
  const text = lamportString(value);
  if (!text) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function sumCloseFeeLamports(metadata: unknown): string {
  const reclaim = recordValue(metadata, "sponsorshipRentReclaim");
  let total = 0n;
  for (const entry of arrayValue(reclaim, "closeTransactions")) {
    if (!isRecord(entry)) continue;
    const fee = lamportBigInt(entry.feeLamports);
    if (fee != null) total += fee;
  }
  return total.toString();
}

function mapUser(row: LedgerUserRow) {
  if (!row.user_id) return null;
  return {
    id: row.user_id,
    email: row.user_email,
    username: row.user_username,
    displayName: row.user_display_name,
  };
}

function solscanTxUrl(signature: string | null): string | null {
  return signature ? `${SOLSCAN_TX_BASE_URL}/${signature}` : null;
}

function solscanAccountUrl(address: string | null): string | null {
  return address ? `${SOLSCAN_ACCOUNT_BASE_URL}/${address}` : null;
}

export function buildAdminSolanaSponsorshipLedgerFilters(
  query: AdminSolanaSponsorshipLedgerFilters,
): QueryParts {
  const parts: QueryParts = { clauses: [], params: [] };

  if (query.venue) {
    parts.clauses.push(`l.venue = ${push(parts, query.venue)}`);
  }
  if (query.flow) {
    parts.clauses.push(`l.flow = ${push(parts, query.flow)}`);
  }
  if (query.status) {
    parts.clauses.push(`l.status = ${push(parts, query.status)}`);
  }
  if (query.rentStatus) {
    parts.clauses.push(`l.rent_status = ${push(parts, query.rentStatus)}`);
  }
  if (query.wallet) {
    parts.clauses.push(`lower(l.wallet_address) = lower(${push(parts, query.wallet)})`);
  }
  if (query.sponsor) {
    parts.clauses.push(
      `lower(l.sponsor_address) = lower(${push(parts, query.sponsor)})`,
    );
  }
  if (query.intentId) {
    parts.clauses.push(`l.intent_id = ${push(parts, query.intentId)}`);
  }
  if (query.txSignature) {
    parts.clauses.push(`l.tx_signature = ${push(parts, query.txSignature)}`);
  }
  if (query.userId) {
    parts.clauses.push(`l.user_id = ${push(parts, query.userId)}::uuid`);
  }
  if (query.from) {
    parts.clauses.push(`l.created_at >= ${push(parts, query.from)}::timestamptz`);
  }
  if (query.to) {
    parts.clauses.push(`l.created_at <= ${push(parts, query.to)}::timestamptz`);
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    const placeholder = push(parts, pattern);
    parts.clauses.push(`(
      l.id::text ilike ${placeholder}
      or l.intent_id ilike ${placeholder}
      or l.wallet_address ilike ${placeholder}
      or l.sponsor_address ilike ${placeholder}
      or l.tx_signature ilike ${placeholder}
      or l.message_digest ilike ${placeholder}
      or l.transaction_digest ilike ${placeholder}
      or l.market_id ilike ${placeholder}
      or u.email ilike ${placeholder}
      or u.username ilike ${placeholder}
      or u.display_name ilike ${placeholder}
    )`);
  }

  return parts;
}

export function mapAdminSolanaSponsorshipLedgerRow(row: SponsorshipLedgerRow) {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const rentReclaim = recordValue(metadata, "sponsorshipRentReclaim");
  const dflowReconciliation = recordValue(metadata, "sponsorshipReconciliation");
  const genericReconciliation = recordValue(
    metadata,
    "genericSponsorshipReconciliation",
  );
  const reclaimedLamports =
    lamportString(rentReclaim?.reclaimedLamports) ?? "0";
  const closeFeeLamports = sumCloseFeeLamports(metadata);
  const remainingOpenLamports = lamportString(rentReclaim?.remainingOpenLamports);
  const reclaimedAt = stringValue(rentReclaim?.reclaimedAt);
  const reconciledAt =
    stringValue(dflowReconciliation?.reconciledAt) ??
    stringValue(genericReconciliation?.reconciledAt);
  const netActualSponsorLamports =
    row.actual_sponsor_lamports == null
      ? null
      : (
          BigInt(row.actual_sponsor_lamports) -
          BigInt(reclaimedLamports) +
          BigInt(closeFeeLamports)
        ).toString();

  return {
    id: row.id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    user: mapUser(row),
    venue: row.venue,
    flow: row.flow,
    status: row.status,
    intentId: row.intent_id,
    walletAddress: row.wallet_address,
    sponsorAddress: row.sponsor_address,
    marketId: row.market_id,
    inputMint: row.input_mint,
    outputMint: row.output_mint,
    amountRaw: row.amount_raw,
    messageDigest: row.message_digest,
    transactionDigest: row.transaction_digest,
    txSignature: row.tx_signature,
    estimatedSponsorLamports: row.estimated_sponsor_lamports,
    actualSponsorLamports: row.actual_sponsor_lamports,
    rentLamports: row.rent_lamports,
    rentStatus: row.rent_status,
    error: row.error,
    metadata,
    adminPredictionMarketInit: metadata.adminPredictionMarketInit === true,
    reconciledAt,
    reclaimedAt,
    reclaimedLamports,
    remainingOpenLamports,
    closeFeeLamports,
    netActualSponsorLamports,
    txSolscanUrl: solscanTxUrl(row.tx_signature),
    walletSolscanUrl: solscanAccountUrl(row.wallet_address),
    sponsorSolscanUrl: solscanAccountUrl(row.sponsor_address),
  };
}

export async function listAdminSolanaSponsorshipLedgerRows(
  pool: DbQuery,
  query: AdminSolanaSponsorshipLedgerFilters,
) {
  const filters = buildAdminSolanaSponsorshipLedgerFilters(query);
  const { limit, offset } = limitOffset(query);
  const where = whereSql(filters);
  const rowParams = [...filters.params, limit, offset];

  const [countResult, rowsResult] = await Promise.all([
    pool.query<CountRow>(
      `
        select count(*)::text as count
        from solana_sponsorship_ledger l
        left join users u on u.id = l.user_id
        ${where}
      `,
      filters.params,
    ),
    pool.query<SponsorshipLedgerRow>(
      `
        select
          l.id,
          l.created_at,
          l.updated_at,
          l.user_id,
          u.email as user_email,
          u.username as user_username,
          u.display_name as user_display_name,
          l.venue,
          l.flow,
          l.status,
          l.intent_id,
          l.wallet_address,
          l.sponsor_address,
          l.market_id,
          l.input_mint,
          l.output_mint,
          l.amount_raw,
          l.message_digest,
          l.transaction_digest,
          l.tx_signature,
          l.estimated_sponsor_lamports::text as estimated_sponsor_lamports,
          l.actual_sponsor_lamports::text as actual_sponsor_lamports,
          l.rent_lamports::text as rent_lamports,
          l.rent_status,
          l.error,
          l.metadata
        from solana_sponsorship_ledger l
        left join users u on u.id = l.user_id
        ${where}
        order by l.created_at desc, l.id desc
        limit $${filters.params.length + 1}
        offset $${filters.params.length + 2}
      `,
      rowParams,
    ),
  ]);

  return {
    items: rowsResult.rows.map(mapAdminSolanaSponsorshipLedgerRow),
    total: countToNumber(countResult.rows[0]?.count),
    limit,
    offset,
  };
}

function summaryTotalsSql(where: string): string {
  return `
    with filtered as (
      select
        l.estimated_sponsor_lamports,
        l.actual_sponsor_lamports,
        l.rent_lamports,
        case
          when l.metadata #>> '{sponsorshipRentReclaim,reclaimedLamports}' ~ '^[0-9]+$'
            then (l.metadata #>> '{sponsorshipRentReclaim,reclaimedLamports}')::numeric
          else 0
        end as reclaimed_lamports,
        (
          select coalesce(sum(
            case
              when close_tx.item ->> 'feeLamports' ~ '^[0-9]+$'
                then (close_tx.item ->> 'feeLamports')::numeric
              else 0
            end
          ), 0)
          from jsonb_array_elements(
            case
              when jsonb_typeof(l.metadata #> '{sponsorshipRentReclaim,closeTransactions}') = 'array'
                then l.metadata #> '{sponsorshipRentReclaim,closeTransactions}'
              else '[]'::jsonb
            end
          ) as close_tx(item)
        ) as close_fee_lamports
      from solana_sponsorship_ledger l
      left join users u on u.id = l.user_id
      ${where}
    )
    select
      count(*)::text as count,
      coalesce(sum(estimated_sponsor_lamports), 0)::text as estimated_sponsor_lamports,
      coalesce(sum(actual_sponsor_lamports), 0)::text as actual_sponsor_lamports,
      coalesce(sum(rent_lamports), 0)::text as rent_lamports,
      coalesce(sum(reclaimed_lamports), 0)::text as reclaimed_lamports,
      coalesce(sum(close_fee_lamports), 0)::text as close_fee_lamports,
      coalesce(sum(
        case
          when actual_sponsor_lamports is null then 0
          else actual_sponsor_lamports - reclaimed_lamports + close_fee_lamports
        end
      ), 0)::text as net_actual_sponsor_lamports
    from filtered
  `;
}

async function groupedCounts(
  pool: DbQuery,
  query: AdminSolanaSponsorshipLedgerFilters,
  column: "status" | "flow" | "rent_status",
): Promise<Array<{ key: string | null; count: number }>> {
  const filters = buildAdminSolanaSponsorshipLedgerFilters(query);
  const result = await pool.query<GroupCountRow>(
    `
      select l.${column} as key, count(*)::text as count
      from solana_sponsorship_ledger l
      left join users u on u.id = l.user_id
      ${whereSql(filters)}
      group by l.${column}
      order by l.${column}
    `,
    filters.params,
  );
  return result.rows.map((row) => ({
    key: row.key,
    count: countToNumber(row.count),
  }));
}

export async function getAdminSolanaSponsorshipLedgerSummary(
  pool: DbQuery,
  query: AdminSolanaSponsorshipLedgerFilters,
) {
  const totalFilters = buildAdminSolanaSponsorshipLedgerFilters(query);
  const [totalsResult, byStatus, byFlow, byRentStatus] = await Promise.all([
    pool.query<TotalsRow>(
      summaryTotalsSql(whereSql(totalFilters)),
      totalFilters.params,
    ),
    groupedCounts(pool, query, "status"),
    groupedCounts(pool, query, "flow"),
    groupedCounts(pool, query, "rent_status"),
  ]);
  const totals = totalsResult.rows[0] ?? {
    count: "0",
    estimated_sponsor_lamports: "0",
    actual_sponsor_lamports: "0",
    rent_lamports: "0",
    reclaimed_lamports: "0",
    close_fee_lamports: "0",
    net_actual_sponsor_lamports: "0",
  };

  return {
    totals: {
      count: countToNumber(totals.count),
      estimatedSponsorLamports: totals.estimated_sponsor_lamports,
      actualSponsorLamports: totals.actual_sponsor_lamports,
      rentLamports: totals.rent_lamports,
      reclaimedLamports: totals.reclaimed_lamports,
      closeFeeLamports: totals.close_fee_lamports,
      netActualSponsorLamports: totals.net_actual_sponsor_lamports,
    },
    byStatus: byStatus.map((row) => ({
      status: row.key ?? "unknown",
      count: row.count,
    })),
    byFlow: byFlow.map((row) => ({
      flow: row.key ?? "unknown",
      count: row.count,
    })),
    byRentStatus: byRentStatus.map((row) => ({
      rentStatus: row.key ?? "unknown",
      count: row.count,
    })),
  };
}
