import type { DbQuery } from "../db.js";

export type AdminFeeLedgerFilters = {
  id?: string;
  q?: string;
  venue?: string;
  chainId?: string;
  status?: string;
  userId?: string;
  wallet?: string;
  orderId?: string;
  orderHash?: string;
  venueOrderId?: string;
  txHash?: string;
  feeEventId?: string;
  sourceId?: string;
  sourceType?: "order" | "execution";
  feeProgram?: string;
  referralCode?: string;
  referralCodeId?: string;
  referralPolicyId?: string;
  referrerUserId?: string;
  referredUserId?: string;
  rewardKind?: "any" | "cashback" | "referral";
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

type AccrualRow = LedgerUserRow & {
  id: string;
  wallet_address: string | null;
  signer_address: string | null;
  venue: string;
  fee_program: string;
  chain_id: string | null;
  order_id: string;
  order_hash: string;
  venue_order_id: string | null;
  venue_fill_id: string;
  venue_trade_id: string | null;
  tx_hash: string | null;
  log_index: number | null;
  token_id: string | null;
  side: string;
  role: string;
  attribution_code: string | null;
  fee_rate_bps: number;
  fee_basis: string | null;
  venue_fee_rate_bps: number | null;
  venue_effective_fee_bps: number | null;
  notional_amount: string;
  notional_amount_raw: string;
  fee_amount: string;
  fee_amount_raw: string;
  fee_asset: string;
  venue_fee_amount: string | null;
  venue_fee_amount_raw: string | null;
  filled_at: Date;
  chain_verified_at: Date | null;
  verification_error: string | null;
  fee_event_id: string | null;
  collected_at: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  order_venue_order_id: string | null;
  order_status: string | null;
  order_side: string | null;
  order_type: string | null;
  order_token_id: string | null;
  order_price: string | null;
  order_size: string | null;
  order_filled_size: string | null;
  order_average_fill_price: string | null;
  order_posted_at: Date | null;
  order_filled_at: Date | null;
  order_fee_policy_snapshot: unknown | null;
  linked_fee_event_status: string | null;
  linked_fee_event_fee_usd: string | null;
  linked_fee_event_tx_hash: string | null;
  linked_fee_event_collected_at: Date | null;
  linked_fee_event_created_at: Date | null;
};

type FeeEventRow = LedgerUserRow & {
  id: string;
  wallet_address: string | null;
  venue: string;
  chain_id: string | null;
  source_type: string;
  source_id: string;
  fee_amount: string;
  fee_asset: string;
  fee_usd: string;
  tx_hash: string | null;
  collected_at: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  cashback_bps_applied: number;
  referral_bps_applied: number;
  cashback_earned_usdc: string;
  referral_earned_usdc: string;
  liability_snapshot_source: string;
  referral_id: string | null;
  referral_code: string | null;
  referral_code_id: string | null;
  referral_policy_id: string | null;
  referral_policy_type: string | null;
  referral_label: string | null;
  referral_referrer_user_id: string | null;
  referral_referrer_email: string | null;
  referral_referrer_username: string | null;
  referral_referrer_display_name: string | null;
  referral_attached_at: Date | null;
  linked_accruals: unknown | null;
  linked_order: unknown | null;
  linked_execution: unknown | null;
};

type ClaimRow = LedgerUserRow & {
  id: string;
  wallet_address: string;
  chain_id: string;
  amount_usdc: string;
  tx_hash: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

type BackfillAttemptRow = LedgerUserRow & {
  id: string;
  venue: string;
  fee_program: string;
  order_id: string;
  venue_order_id: string | null;
  status: string;
  reason: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  first_attempted_at: Date;
  last_attempted_at: Date;
  created_at: Date;
  updated_at: Date;
  order_status: string | null;
  order_hash: string | null;
  order_wallet_address: string | null;
  order_payload: unknown | null;
};

function push(parts: QueryParts, value: unknown): string {
  parts.params.push(value);
  return `$${parts.params.length}`;
}

function whereSql(parts: QueryParts): string {
  return parts.clauses.length ? `where ${parts.clauses.join("\n  and ")}` : "";
}

function countToNumber(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function limitOffset(query: AdminFeeLedgerFilters): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Math.max(query.limit ?? 50, 1), 100),
    offset: Math.max(query.offset ?? 0, 0),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
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

function textValue(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return typeof nested === "string" && nested.trim() ? nested : null;
}

function rawDigitString(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function isPositiveRaw(value: string | null): value is string {
  return value != null && BigInt(value) > 0n;
}

function microRawToDecimal(raw: string): string {
  const value = BigInt(raw);
  const scale = 1_000_000n;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

function extractLimitlessStoredExecution(
  payload: unknown,
): Record<string, unknown> | null {
  const submitted = recordValue(payload, "submitted");
  const submittedUpstream = recordValue(submitted, "_hunchUpstream");
  const directUpstream = recordValue(payload, "_hunchUpstream");
  return (
    recordValue(submittedUpstream, "execution") ??
    recordValue(recordValue(submittedUpstream, "order"), "execution") ??
    recordValue(directUpstream, "execution") ??
    recordValue(recordValue(directUpstream, "order"), "execution")
  );
}

function mapLimitlessStoredExecution(payload: unknown) {
  const execution = extractLimitlessStoredExecution(payload);
  if (!execution) return null;
  const totalsRaw = recordValue(execution, "totalsRaw");
  return {
    txHash: textValue(execution, "txHash"),
    tradeEventId: textValue(execution, "tradeEventId"),
    settlementStatus: textValue(execution, "settlementStatus"),
    feeRateBps: execution.feeRateBps ?? null,
    effectiveFeeBps: execution.effectiveFeeBps ?? null,
    totalsRaw: totalsRaw
      ? {
          usdFee: totalsRaw.usdFee ?? null,
          usdNet: totalsRaw.usdNet ?? null,
          usdGross: totalsRaw.usdGross ?? null,
          contractsFee: totalsRaw.contractsFee ?? null,
          contractsNet: totalsRaw.contractsNet ?? null,
          contractsGross: totalsRaw.contractsGross ?? null,
        }
      : null,
  };
}

function mapLimitlessFeeObservation(payload: unknown) {
  const execution = mapLimitlessStoredExecution(payload);
  const totalsRaw = execution?.totalsRaw;
  const usdFeeRaw = rawDigitString(totalsRaw?.usdFee);
  const contractsFeeRaw = rawDigitString(totalsRaw?.contractsFee);
  const amountRaw = isPositiveRaw(usdFeeRaw)
    ? usdFeeRaw
    : isPositiveRaw(contractsFeeRaw)
      ? contractsFeeRaw
      : null;
  if (!amountRaw) return null;
  const kind = isPositiveRaw(usdFeeRaw) ? "usdc" : "contracts";
  return {
    kind,
    asset: kind === "usdc" ? "USDC" : "contracts",
    amountRaw,
    amount: microRawToDecimal(amountRaw),
    txHash: execution?.txHash ?? null,
    tradeEventId: execution?.tradeEventId ?? null,
  };
}

function addDateRange(
  parts: QueryParts,
  columnSql: string,
  query: AdminFeeLedgerFilters,
) {
  if (query.from) {
    const idx = push(parts, query.from);
    parts.clauses.push(`${columnSql} >= ${idx}::timestamptz`);
  }
  if (query.to) {
    const idx = push(parts, query.to);
    parts.clauses.push(`${columnSql} <= ${idx}::timestamptz`);
  }
}

function buildAccrualFilters(query: AdminFeeLedgerFilters): QueryParts {
  const parts: QueryParts = { clauses: [], params: [] };
  if (query.id) parts.clauses.push(`a.id::text = ${push(parts, query.id)}`);
  if (query.venue) parts.clauses.push(`a.venue = ${push(parts, query.venue)}`);
  if (query.chainId)
    parts.clauses.push(`a.chain_id = ${push(parts, query.chainId)}`);
  if (query.status)
    parts.clauses.push(`a.status = ${push(parts, query.status)}`);
  if (query.userId)
    parts.clauses.push(`a.user_id = ${push(parts, query.userId)}::uuid`);
  if (query.wallet) {
    const idx = push(parts, query.wallet);
    parts.clauses.push(
      `(lower(a.wallet_address) = lower(${idx}) or lower(a.signer_address) = lower(${idx}))`,
    );
  }
  if (query.orderId)
    parts.clauses.push(`a.order_id = ${push(parts, query.orderId)}::uuid`);
  if (query.orderHash)
    parts.clauses.push(`a.order_hash = ${push(parts, query.orderHash)}`);
  if (query.venueOrderId)
    parts.clauses.push(
      `a.venue_order_id = ${push(parts, query.venueOrderId)}`,
    );
  if (query.txHash) parts.clauses.push(`a.tx_hash = ${push(parts, query.txHash)}`);
  if (query.feeEventId)
    parts.clauses.push(
      `a.fee_event_id = ${push(parts, query.feeEventId)}::uuid`,
    );
  if (query.feeProgram)
    parts.clauses.push(`a.fee_program = ${push(parts, query.feeProgram)}`);
  if (query.sourceType)
    parts.clauses.push(`fe.source_type = ${push(parts, query.sourceType)}`);
  if (query.sourceId) {
    const idx = push(parts, query.sourceId);
    parts.clauses.push(
      `(fe.source_id = ${idx} or a.order_hash = ${idx} or a.venue_fill_id = ${idx} or a.venue_trade_id = ${idx})`,
    );
  }
  if (query.q) {
    const idx = push(parts, query.q);
    parts.clauses.push(`(
      a.id::text = ${idx}
      or a.order_id::text = ${idx}
      or a.order_hash = ${idx}
      or a.venue_order_id = ${idx}
      or a.venue_fill_id = ${idx}
      or a.venue_trade_id = ${idx}
      or a.tx_hash = ${idx}
      or a.token_id = ${idx}
      or a.fee_event_id::text = ${idx}
      or lower(a.wallet_address) = lower(${idx})
      or lower(a.signer_address) = lower(${idx})
      or lower(u.email) = lower(${idx})
    )`);
  }
  addDateRange(parts, "a.filled_at", query);
  return parts;
}

function buildEventFilters(query: AdminFeeLedgerFilters): QueryParts {
  const parts: QueryParts = { clauses: [], params: [] };
  if (query.id) parts.clauses.push(`fe.id::text = ${push(parts, query.id)}`);
  if (query.feeEventId)
    parts.clauses.push(`fe.id = ${push(parts, query.feeEventId)}::uuid`);
  if (query.venue) parts.clauses.push(`fe.venue = ${push(parts, query.venue)}`);
  if (query.chainId)
    parts.clauses.push(`fe.chain_id = ${push(parts, query.chainId)}`);
  if (query.status)
    parts.clauses.push(`fe.status = ${push(parts, query.status)}`);
  if (query.userId)
    parts.clauses.push(`fe.user_id = ${push(parts, query.userId)}::uuid`);
  if (query.wallet) {
    const idx = push(parts, query.wallet);
    parts.clauses.push(`lower(fe.wallet_address) = lower(${idx})`);
  }
  if (query.txHash) {
    const idx = push(parts, query.txHash);
    parts.clauses.push(
      `(fe.tx_hash = ${idx} or exists (select 1 from venue_fee_accruals ax where ax.fee_event_id = fe.id and ax.tx_hash = ${idx}))`,
    );
  }
  if (query.sourceType)
    parts.clauses.push(`fe.source_type = ${push(parts, query.sourceType)}`);
  if (query.sourceId)
    parts.clauses.push(`fe.source_id = ${push(parts, query.sourceId)}`);
  if (query.feeProgram) {
    const idx = push(parts, query.feeProgram);
    parts.clauses.push(
      `exists (select 1 from venue_fee_accruals ax where ax.fee_event_id = fe.id and ax.fee_program = ${idx})`,
    );
  }
  if (query.orderId) {
    const idx = push(parts, query.orderId);
    parts.clauses.push(`(
      exists (select 1 from venue_fee_accruals ax where ax.fee_event_id = fe.id and ax.order_id = ${idx}::uuid)
      or exists (select 1 from orders ox where ox.id = ${idx}::uuid and ox.user_id = fe.user_id)
    )`);
  }
  if (query.orderHash) {
    const idx = push(parts, query.orderHash);
    parts.clauses.push(`(
      exists (select 1 from venue_fee_accruals ax where ax.fee_event_id = fe.id and ax.order_hash = ${idx})
      or exists (select 1 from orders ox where ox.user_id = fe.user_id and ox.order_hash = ${idx})
    )`);
  }
  if (query.venueOrderId) {
    const idx = push(parts, query.venueOrderId);
    parts.clauses.push(`(
      exists (select 1 from venue_fee_accruals ax where ax.fee_event_id = fe.id and ax.venue_order_id = ${idx})
      or exists (select 1 from orders ox where ox.user_id = fe.user_id and ox.venue_order_id = ${idx})
      or exists (select 1 from executions ex where ex.user_id = fe.user_id and ex.venue_order_id = ${idx})
    )`);
  }
  if (query.referralCode) {
    const idx = push(parts, query.referralCode);
    parts.clauses.push(`upper(rc.code) = upper(${idx})`);
  }
  if (query.referralCodeId)
    parts.clauses.push(
      `rc.id = ${push(parts, query.referralCodeId)}::uuid`,
    );
  if (query.referralPolicyId)
    parts.clauses.push(
      `p.id = ${push(parts, query.referralPolicyId)}::uuid`,
    );
  if (query.referrerUserId)
    parts.clauses.push(
      `r.referrer_user_id = ${push(parts, query.referrerUserId)}::uuid`,
    );
  if (query.referredUserId)
    parts.clauses.push(
      `r.referred_user_id = ${push(parts, query.referredUserId)}::uuid`,
    );
  if (query.rewardKind === "cashback") {
    parts.clauses.push(`fe.cashback_earned_usdc > 0`);
  } else if (query.rewardKind === "referral") {
    parts.clauses.push(`fe.referral_earned_usdc > 0`);
  }
  if (query.q) {
    const idx = push(parts, query.q);
    parts.clauses.push(`(
      fe.id::text = ${idx}
      or fe.source_id = ${idx}
      or fe.tx_hash = ${idx}
      or lower(fe.wallet_address) = lower(${idx})
      or lower(u.email) = lower(${idx})
      or upper(rc.code) = upper(${idx})
      or r.id::text = ${idx}
      or r.referrer_user_id::text = ${idx}
      or r.referred_user_id::text = ${idx}
      or exists (
        select 1
        from venue_fee_accruals ax
        where ax.fee_event_id = fe.id
          and (
            ax.order_id::text = ${idx}
            or ax.order_hash = ${idx}
            or ax.venue_order_id = ${idx}
            or ax.tx_hash = ${idx}
            or ax.venue_fill_id = ${idx}
          )
      )
    )`);
  }
  addDateRange(parts, "fe.created_at", query);
  return parts;
}

function buildClaimFilters(query: AdminFeeLedgerFilters): QueryParts {
  const parts: QueryParts = { clauses: [], params: [] };
  if (query.id) parts.clauses.push(`c.id::text = ${push(parts, query.id)}`);
  if (query.chainId)
    parts.clauses.push(`c.chain_id = ${push(parts, query.chainId)}`);
  if (query.status)
    parts.clauses.push(`c.status = ${push(parts, query.status)}`);
  if (query.userId)
    parts.clauses.push(`c.user_id = ${push(parts, query.userId)}::uuid`);
  if (query.wallet) {
    const idx = push(parts, query.wallet);
    parts.clauses.push(`lower(c.wallet_address) = lower(${idx})`);
  }
  if (query.txHash) parts.clauses.push(`c.tx_hash = ${push(parts, query.txHash)}`);
  if (query.q) {
    const idx = push(parts, query.q);
    parts.clauses.push(`(
      c.id::text = ${idx}
      or c.tx_hash = ${idx}
      or lower(c.wallet_address) = lower(${idx})
      or lower(u.email) = lower(${idx})
      or u.id::text = ${idx}
    )`);
  }
  addDateRange(parts, "c.created_at", query);
  return parts;
}

function buildBackfillFilters(query: AdminFeeLedgerFilters): QueryParts {
  const parts: QueryParts = { clauses: [], params: [] };
  if (query.id) parts.clauses.push(`b.id::text = ${push(parts, query.id)}`);
  if (query.venue) parts.clauses.push(`b.venue = ${push(parts, query.venue)}`);
  if (query.status)
    parts.clauses.push(`b.status = ${push(parts, query.status)}`);
  if (query.feeProgram)
    parts.clauses.push(`b.fee_program = ${push(parts, query.feeProgram)}`);
  if (query.orderId)
    parts.clauses.push(`b.order_id = ${push(parts, query.orderId)}::uuid`);
  if (query.venueOrderId)
    parts.clauses.push(
      `b.venue_order_id = ${push(parts, query.venueOrderId)}`,
    );
  if (query.userId)
    parts.clauses.push(`o.user_id = ${push(parts, query.userId)}::uuid`);
  if (query.wallet) {
    const idx = push(parts, query.wallet);
    parts.clauses.push(`lower(o.wallet_address) = lower(${idx})`);
  }
  if (query.orderHash)
    parts.clauses.push(`o.order_hash = ${push(parts, query.orderHash)}`);
  if (query.q) {
    const idx = push(parts, query.q);
    parts.clauses.push(`(
      b.id::text = ${idx}
      or b.order_id::text = ${idx}
      or b.venue_order_id = ${idx}
      or o.order_hash = ${idx}
      or lower(o.wallet_address) = lower(${idx})
      or lower(u.email) = lower(${idx})
    )`);
  }
  addDateRange(parts, "b.created_at", query);
  return parts;
}

const ACCRUAL_FROM_SQL = `
  from venue_fee_accruals a
  left join users u on u.id = a.user_id
  left join orders o on o.id = a.order_id
  left join fee_events fe on fe.id = a.fee_event_id
`;

const ACCRUAL_SELECT_SQL = `
  select
    a.id,
    a.user_id,
    u.email as user_email,
    u.username as user_username,
    u.display_name as user_display_name,
    a.wallet_address,
    a.signer_address,
    a.venue,
    a.fee_program,
    a.chain_id,
    a.order_id,
    a.order_hash,
    a.venue_order_id,
    a.venue_fill_id,
    a.venue_trade_id,
    a.tx_hash,
    a.log_index,
    a.token_id,
    a.side,
    a.role,
    a.attribution_code,
    a.fee_rate_bps,
    a.fee_basis,
    a.venue_fee_rate_bps,
    a.venue_effective_fee_bps,
    a.notional_amount::text as notional_amount,
    a.notional_amount_raw,
    a.fee_amount::text as fee_amount,
    a.fee_amount_raw,
    a.fee_asset,
    a.venue_fee_amount::text as venue_fee_amount,
    a.venue_fee_amount_raw,
    a.filled_at,
    a.chain_verified_at,
    a.verification_error,
    a.fee_event_id,
    a.collected_at,
    a.status,
    a.created_at,
    a.updated_at,
    o.venue_order_id as order_venue_order_id,
    o.status as order_status,
    o.side as order_side,
    o.order_type as order_type,
    o.token_id as order_token_id,
    o.price::text as order_price,
    o.size::text as order_size,
    o.filled_size::text as order_filled_size,
    o.average_fill_price::text as order_average_fill_price,
    o.posted_at as order_posted_at,
    o.filled_at as order_filled_at,
    o.fee_policy_snapshot as order_fee_policy_snapshot,
    fe.status as linked_fee_event_status,
    fe.fee_usd::text as linked_fee_event_fee_usd,
    fe.tx_hash as linked_fee_event_tx_hash,
    fe.collected_at as linked_fee_event_collected_at,
    fe.created_at as linked_fee_event_created_at
`;

function mapAccrual(row: AccrualRow) {
  return {
    id: row.id,
    user: mapUser(row),
    walletAddress: row.wallet_address,
    signerAddress: row.signer_address,
    venue: row.venue,
    feeProgram: row.fee_program,
    chainId: row.chain_id,
    orderId: row.order_id,
    orderHash: row.order_hash,
    venueOrderId: row.venue_order_id,
    venueFillId: row.venue_fill_id,
    venueTradeId: row.venue_trade_id,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    tokenId: row.token_id,
    side: row.side,
    role: row.role,
    attributionCode: row.attribution_code,
    feeRateBps: row.fee_rate_bps,
    feeBasis: row.fee_basis,
    venueFeeRateBps: row.venue_fee_rate_bps,
    venueEffectiveFeeBps: row.venue_effective_fee_bps,
    notionalAmount: row.notional_amount,
    notionalAmountRaw: row.notional_amount_raw,
    feeAmount: row.fee_amount,
    feeAmountRaw: row.fee_amount_raw,
    feeAsset: row.fee_asset,
    venueFeeAmount: row.venue_fee_amount,
    venueFeeAmountRaw: row.venue_fee_amount_raw,
    filledAt: toIso(row.filled_at),
    chainVerifiedAt: toIso(row.chain_verified_at),
    verificationError: row.verification_error,
    feeEventId: row.fee_event_id,
    collectedAt: toIso(row.collected_at),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    order: {
      id: row.order_id,
      venueOrderId: row.order_venue_order_id,
      status: row.order_status,
      side: row.order_side,
      orderType: row.order_type,
      tokenId: row.order_token_id,
      price: row.order_price,
      size: row.order_size,
      filledSize: row.order_filled_size,
      averageFillPrice: row.order_average_fill_price,
      postedAt: toIso(row.order_posted_at),
      filledAt: toIso(row.order_filled_at),
      feePolicySnapshot: row.order_fee_policy_snapshot,
    },
    feeEvent: row.fee_event_id
      ? {
          id: row.fee_event_id,
          status: row.linked_fee_event_status,
          feeUsd: row.linked_fee_event_fee_usd,
          txHash: row.linked_fee_event_tx_hash,
          collectedAt: toIso(row.linked_fee_event_collected_at),
          createdAt: toIso(row.linked_fee_event_created_at),
        }
      : null,
  };
}

export async function listAdminFeeLedgerAccruals(
  pool: DbQuery,
  query: AdminFeeLedgerFilters,
) {
  const filters = buildAccrualFilters(query);
  const { limit, offset } = limitOffset(query);
  const where = whereSql(filters);
  const countResult = await pool.query<{ total: string }>(
    `select count(*)::text as total ${ACCRUAL_FROM_SQL} ${where}`,
    filters.params,
  );
  const params = [...filters.params, limit, offset];
  const rowsResult = await pool.query<AccrualRow>(
    `
      ${ACCRUAL_SELECT_SQL}
      ${ACCRUAL_FROM_SQL}
      ${where}
      order by a.filled_at desc, a.created_at desc, a.id desc
      limit $${params.length - 1}
      offset $${params.length}
    `,
    params,
  );
  return {
    items: rowsResult.rows.map(mapAccrual),
    total: countToNumber(countResult.rows[0]?.total),
    limit,
    offset,
  };
}

const EVENT_FROM_SQL = `
  from fee_events fe
  left join users u on u.id = fe.user_id
  left join referrals r on r.referred_user_id = fe.user_id
  left join referral_codes rc on rc.id = r.referral_code_id
  left join referral_code_policies p on p.id = rc.policy_id
  left join users ru on ru.id = r.referrer_user_id
`;

const EVENT_SELECT_SQL = `
  select
    fe.id,
    fe.user_id,
    u.email as user_email,
    u.username as user_username,
    u.display_name as user_display_name,
    fe.wallet_address,
    fe.venue,
    fe.chain_id,
    fe.source_type,
    fe.source_id,
    fe.fee_amount::text as fee_amount,
    fe.fee_asset,
    fe.fee_usd::text as fee_usd,
    fe.tx_hash,
    fe.collected_at,
    fe.status,
    fe.created_at,
    fe.updated_at,
    fe.cashback_bps_applied,
    fe.referral_bps_applied,
    fe.cashback_earned_usdc::text as cashback_earned_usdc,
    fe.referral_earned_usdc::text as referral_earned_usdc,
    fe.liability_snapshot_source,
    r.id as referral_id,
    rc.code as referral_code,
    rc.id as referral_code_id,
    p.id as referral_policy_id,
    p.policy_type as referral_policy_type,
    p.label as referral_label,
    r.referrer_user_id as referral_referrer_user_id,
    ru.email as referral_referrer_email,
    ru.username as referral_referrer_username,
    ru.display_name as referral_referrer_display_name,
    r.created_at as referral_attached_at,
    accruals.linked_accruals,
    order_link.linked_order,
    execution_link.linked_execution
`;

const EVENT_LATERAL_SQL = `
  left join lateral (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', ax.id,
          'venue', ax.venue,
          'feeProgram', ax.fee_program,
          'status', ax.status,
          'orderId', ax.order_id,
          'orderHash', ax.order_hash,
          'venueOrderId', ax.venue_order_id,
          'venueFillId', ax.venue_fill_id,
          'txHash', ax.tx_hash,
          'feeAmount', ax.fee_amount::text,
          'feeAmountRaw', ax.fee_amount_raw,
          'feeAsset', ax.fee_asset,
          'filledAt', ax.filled_at
        )
        order by ax.filled_at desc, ax.created_at desc
      ),
      '[]'::jsonb
    ) as linked_accruals
    from venue_fee_accruals ax
    where ax.fee_event_id = fe.id
  ) accruals on true
  left join lateral (
    select jsonb_build_object(
      'id', ox.id,
      'venue', ox.venue,
      'venueOrderId', ox.venue_order_id,
      'orderHash', ox.order_hash,
      'status', ox.status,
      'side', ox.side,
      'orderType', ox.order_type,
      'tokenId', ox.token_id,
      'price', ox.price::text,
      'size', ox.size::text,
      'filledSize', ox.filled_size::text,
      'averageFillPrice', ox.average_fill_price::text,
      'postedAt', ox.posted_at,
      'filledAt', ox.filled_at,
      'feePolicySnapshot', ox.fee_policy_snapshot
    ) as linked_order
    from orders ox
    where ox.user_id = fe.user_id
      and (
        ox.id::text = fe.source_id
        or ox.order_hash = fe.source_id
        or ox.venue_order_id = fe.source_id
        or exists (
          select 1
          from venue_fee_accruals ax
          where ax.fee_event_id = fe.id
            and ax.order_id = ox.id
        )
      )
    order by coalesce(ox.filled_at, ox.last_update, ox.posted_at) desc
    limit 1
  ) order_link on true
  left join lateral (
    select jsonb_build_object(
      'id', ex.id,
      'venue', ex.venue,
      'venueOrderId', ex.venue_order_id,
      'txSignature', ex.tx_signature,
      'status', ex.status,
      'side', ex.side,
      'outcome', ex.outcome,
      'amountIn', ex.amount_in::text,
      'amountOut', ex.amount_out::text,
      'createdAt', ex.created_at
    ) as linked_execution
    from executions ex
    where ex.user_id = fe.user_id
      and (
        ex.id::text = fe.source_id
        or ex.venue_order_id = fe.source_id
        or ex.tx_signature = fe.tx_hash
        or ex.tx_signature = fe.source_id
      )
    order by ex.created_at desc
    limit 1
  ) execution_link on true
`;

function mapFeeEvent(row: FeeEventRow) {
  return {
    id: row.id,
    user: mapUser(row),
    walletAddress: row.wallet_address,
    venue: row.venue,
    chainId: row.chain_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    feeAmount: row.fee_amount,
    feeAsset: row.fee_asset,
    feeUsd: row.fee_usd,
    txHash: row.tx_hash,
    collectedAt: toIso(row.collected_at),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    cashbackBpsApplied: row.cashback_bps_applied,
    referralBpsApplied: row.referral_bps_applied,
    cashbackEarnedUsdc: row.cashback_earned_usdc,
    referralEarnedUsdc: row.referral_earned_usdc,
    liabilitySnapshotSource: row.liability_snapshot_source,
    referral: row.referral_id
      ? {
          id: row.referral_id,
          code: row.referral_code,
          codeId: row.referral_code_id,
          policyId: row.referral_policy_id,
          policyType: row.referral_policy_type,
          label: row.referral_label,
          referrerUserId: row.referral_referrer_user_id,
          referrerEmail: row.referral_referrer_email,
          referrerUsername: row.referral_referrer_username,
          referrerDisplayName: row.referral_referrer_display_name,
          attachedAt: toIso(row.referral_attached_at),
        }
      : null,
    linkedAccruals: row.linked_accruals ?? [],
    linkedOrder: row.linked_order,
    linkedExecution: row.linked_execution,
  };
}

export async function listAdminFeeLedgerEvents(
  pool: DbQuery,
  query: AdminFeeLedgerFilters,
) {
  const filters = buildEventFilters(query);
  const { limit, offset } = limitOffset(query);
  const where = whereSql(filters);
  const countResult = await pool.query<{ total: string }>(
    `select count(*)::text as total ${EVENT_FROM_SQL} ${where}`,
    filters.params,
  );
  const params = [...filters.params, limit, offset];
  const rowsResult = await pool.query<FeeEventRow>(
    `
      ${EVENT_SELECT_SQL}
      ${EVENT_FROM_SQL}
      ${EVENT_LATERAL_SQL}
      ${where}
      order by fe.created_at desc, fe.id desc
      limit $${params.length - 1}
      offset $${params.length}
    `,
    params,
  );
  return {
    items: rowsResult.rows.map(mapFeeEvent),
    total: countToNumber(countResult.rows[0]?.total),
    limit,
    offset,
  };
}

function mapClaim(row: ClaimRow) {
  return {
    id: row.id,
    user: mapUser(row),
    walletAddress: row.wallet_address,
    chainId: row.chain_id,
    amountUsdc: row.amount_usdc,
    txHash: row.tx_hash,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listAdminFeeLedgerClaims(
  pool: DbQuery,
  query: AdminFeeLedgerFilters,
) {
  const filters = buildClaimFilters(query);
  const { limit, offset } = limitOffset(query);
  const where = whereSql(filters);
  const countResult = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from reward_claims c
      left join users u on u.id = c.user_id
      ${where}
    `,
    filters.params,
  );
  const params = [...filters.params, limit, offset];
  const rowsResult = await pool.query<ClaimRow>(
    `
      select
        c.id,
        c.user_id,
        u.email as user_email,
        u.username as user_username,
        u.display_name as user_display_name,
        c.wallet_address,
        c.chain_id,
        c.amount_usdc::text as amount_usdc,
        c.tx_hash,
        c.status,
        c.created_at,
        c.updated_at
      from reward_claims c
      left join users u on u.id = c.user_id
      ${where}
      order by c.created_at desc, c.id desc
      limit $${params.length - 1}
      offset $${params.length}
    `,
    params,
  );
  return {
    items: rowsResult.rows.map(mapClaim),
    total: countToNumber(countResult.rows[0]?.total),
    limit,
    offset,
  };
}

function mapBackfillAttempt(row: BackfillAttemptRow) {
  const execution = mapLimitlessStoredExecution(row.order_payload);
  const feeObservation = mapLimitlessFeeObservation(row.order_payload);
  return {
    id: row.id,
    venue: row.venue,
    feeProgram: row.fee_program,
    orderId: row.order_id,
    venueOrderId: row.venue_order_id,
    status: row.status,
    reason: row.reason,
    attempts: row.attempts,
    nextAttemptAt: toIso(row.next_attempt_at),
    firstAttemptedAt: toIso(row.first_attempted_at),
    lastAttemptedAt: toIso(row.last_attempted_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    user: mapUser(row),
    order: {
      id: row.order_id,
      status: row.order_status,
      orderHash: row.order_hash,
      txHash: execution?.txHash ?? row.order_hash,
      walletAddress: row.order_wallet_address,
      venueOrderId: row.venue_order_id,
      execution,
    },
    feeObservation,
  };
}

export async function listAdminFeeLedgerBackfillAttempts(
  pool: DbQuery,
  query: AdminFeeLedgerFilters,
) {
  const filters = buildBackfillFilters(query);
  const { limit, offset } = limitOffset(query);
  const where = whereSql(filters);
  const countResult = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from venue_fee_backfill_attempts b
      left join orders o on o.id = b.order_id
      left join users u on u.id = o.user_id
      ${where}
    `,
    filters.params,
  );
  const params = [...filters.params, limit, offset];
  const rowsResult = await pool.query<BackfillAttemptRow>(
    `
      select
        b.id,
        b.venue,
        b.fee_program,
        b.order_id,
        b.venue_order_id,
        b.status,
        b.reason,
        b.attempts,
        b.next_attempt_at,
        b.first_attempted_at,
        b.last_attempted_at,
        b.created_at,
        b.updated_at,
        o.status as order_status,
        o.order_hash,
        o.wallet_address as order_wallet_address,
        o.order_payload,
        o.user_id,
        u.email as user_email,
        u.username as user_username,
        u.display_name as user_display_name
      from venue_fee_backfill_attempts b
      left join orders o on o.id = b.order_id
      left join users u on u.id = o.user_id
      ${where}
      order by coalesce(b.next_attempt_at, b.last_attempted_at, b.created_at) desc, b.id desc
      limit $${params.length - 1}
      offset $${params.length}
    `,
    params,
  );
  return {
    items: rowsResult.rows.map(mapBackfillAttempt),
    total: countToNumber(countResult.rows[0]?.total),
    limit,
    offset,
  };
}

export async function getAdminFeeLedgerAccrual(
  pool: DbQuery,
  id: string,
) {
  const result = await listAdminFeeLedgerAccruals(pool, { id, limit: 1 });
  return result.items[0] ?? null;
}

export async function getAdminFeeLedgerEvent(pool: DbQuery, id: string) {
  const result = await listAdminFeeLedgerEvents(pool, { id, limit: 1 });
  return result.items[0] ?? null;
}

export async function getAdminFeeLedgerClaim(pool: DbQuery, id: string) {
  const result = await listAdminFeeLedgerClaims(pool, { id, limit: 1 });
  return result.items[0] ?? null;
}

export async function getAdminFeeLedgerSummary(
  pool: DbQuery,
  query: AdminFeeLedgerFilters,
) {
  const accrualFilters = buildAccrualFilters(query);
  const eventFilters = buildEventFilters(query);
  const claimFilters = buildClaimFilters(query);
  const backfillFilters = buildBackfillFilters(query);

  const [accruals, events, claims, backfills] = await Promise.all([
    pool.query<{
      venue: string;
      fee_program: string;
      status: string;
      chain_id: string | null;
      linked_state: string;
      count: string;
      fee_amount: string;
    }>(
      `
        select
          a.venue,
          a.fee_program,
          a.status,
          a.chain_id,
          case when a.fee_event_id is null then 'unlinked' else 'linked' end as linked_state,
          count(*)::text as count,
          coalesce(sum(a.fee_amount), 0)::text as fee_amount
        ${ACCRUAL_FROM_SQL}
        ${whereSql(accrualFilters)}
        group by a.venue, a.fee_program, a.status, a.chain_id, linked_state
        order by a.venue, a.fee_program, a.status, a.chain_id, linked_state
      `,
      accrualFilters.params,
    ),
    pool.query<{
      venue: string;
      source_type: string;
      status: string;
      chain_id: string | null;
      reward_kind: string;
      count: string;
      fee_usd: string;
      cashback_earned_usdc: string;
      referral_earned_usdc: string;
    }>(
      `
        select
          fe.venue,
          fe.source_type,
          fe.status,
          fe.chain_id,
          case
            when fe.cashback_earned_usdc > 0 and fe.referral_earned_usdc > 0 then 'cashback_referral'
            when fe.referral_earned_usdc > 0 then 'referral'
            when fe.cashback_earned_usdc > 0 then 'cashback'
            else 'fee'
          end as reward_kind,
          count(*)::text as count,
          coalesce(sum(fe.fee_usd), 0)::text as fee_usd,
          coalesce(sum(fe.cashback_earned_usdc), 0)::text as cashback_earned_usdc,
          coalesce(sum(fe.referral_earned_usdc), 0)::text as referral_earned_usdc
        ${EVENT_FROM_SQL}
        ${whereSql(eventFilters)}
        group by fe.venue, fe.source_type, fe.status, fe.chain_id, reward_kind
        order by fe.venue, fe.source_type, fe.status, fe.chain_id, reward_kind
      `,
      eventFilters.params,
    ),
    pool.query<{
      chain_id: string;
      status: string;
      count: string;
      amount_usdc: string;
    }>(
      `
        select
          c.chain_id,
          c.status,
          count(*)::text as count,
          coalesce(sum(c.amount_usdc), 0)::text as amount_usdc
        from reward_claims c
        left join users u on u.id = c.user_id
        ${whereSql(claimFilters)}
        group by c.chain_id, c.status
        order by c.chain_id, c.status
      `,
      claimFilters.params,
    ),
    pool.query<{
      venue: string;
      fee_program: string;
      status: string;
      count: string;
      max_last_attempted_at: Date | null;
    }>(
      `
        select
          b.venue,
          b.fee_program,
          b.status,
          count(*)::text as count,
          max(b.last_attempted_at) as max_last_attempted_at
        from venue_fee_backfill_attempts b
        left join orders o on o.id = b.order_id
        left join users u on u.id = o.user_id
        ${whereSql(backfillFilters)}
        group by b.venue, b.fee_program, b.status
        order by b.venue, b.fee_program, b.status
      `,
      backfillFilters.params,
    ),
  ]);

  return {
    accruals: accruals.rows.map((row) => ({
      venue: row.venue,
      feeProgram: row.fee_program,
      status: row.status,
      chainId: row.chain_id,
      linkedState: row.linked_state,
      count: countToNumber(row.count),
      feeAmount: row.fee_amount,
    })),
    events: events.rows.map((row) => ({
      venue: row.venue,
      sourceType: row.source_type,
      status: row.status,
      chainId: row.chain_id,
      rewardKind: row.reward_kind,
      count: countToNumber(row.count),
      feeUsd: row.fee_usd,
      cashbackEarnedUsdc: row.cashback_earned_usdc,
      referralEarnedUsdc: row.referral_earned_usdc,
    })),
    claims: claims.rows.map((row) => ({
      chainId: row.chain_id,
      status: row.status,
      count: countToNumber(row.count),
      amountUsdc: row.amount_usdc,
    })),
    backfillAttempts: backfills.rows.map((row) => ({
      venue: row.venue,
      feeProgram: row.fee_program,
      status: row.status,
      count: countToNumber(row.count),
      lastAttemptedAt: toIso(row.max_last_attempted_at),
    })),
  };
}

export async function getReferralCodeLedgerInfo(pool: DbQuery, code: string) {
  const { rows } = await pool.query<{
    id: string;
    code: string;
    policy_id: string;
    policy_type: string;
    label: string | null;
    owner_user_id: string | null;
    is_active: boolean;
    retired_at: Date | null;
  }>(
    `
      select
        rc.id,
        rc.code,
        p.id as policy_id,
        p.policy_type,
        p.label,
        p.owner_user_id,
        rc.is_active,
        rc.retired_at
      from referral_codes rc
      join referral_code_policies p on p.id = rc.policy_id
      where upper(rc.code) = upper($1)
      limit 1
    `,
    [code],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    policyId: row.policy_id,
    policyType: row.policy_type,
    label: row.label,
    ownerUserId: row.owner_user_id,
    isActive: row.is_active,
    retiredAt: toIso(row.retired_at),
  };
}
