import type { Pool } from "@hunch/infra";

const MICRO_SCALE = 1_000_000n;

const OPEN_ORDER_STATUSES = [
  "pending",
  "submitted",
  "live",
  "partially_filled",
  "delayed",
  "unconfirmed",
  "open",
] as const;

type Venue = "polymarket" | "limitless";

type OpenOrderCollateralRow = {
  venue: Venue;
  wallet_key: string | null;
  side: string | null;
  price: string | number | null;
  size: string | number | null;
  filled_size: string | number | null;
  order_payload: unknown | null;
};

type OpenOrderPositionRow = {
  wallet_key: string | null;
  token_id: string | null;
  size: string | number | null;
  filled_size: string | number | null;
  order_payload: unknown | null;
};

export type OpenOrderCollateralLocks = {
  polymarket: Map<string, bigint>;
  limitless: Map<string, bigint>;
};

export function normalizeCollateralWalletKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function parseRawInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function parseDecimalToMicro(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return BigInt(Math.trunc(value * Number(MICRO_SCALE)));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const [whole, fraction = ""] = trimmed.split(".");
    const wholeRaw = BigInt(whole || "0") * MICRO_SCALE;
    const fractionRaw = BigInt((fraction + "000000").slice(0, 6));
    return wholeRaw + fractionRaw;
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return BigInt(Math.trunc(numeric * Number(MICRO_SCALE)));
}

function readPayloadRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function readNestedRecord(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!record) return null;
  return readPayloadRecord(record[key]);
}

function readSignedAmounts(
  venue: Venue,
  payload: unknown,
): { makerAmountRaw: bigint; takerAmountRaw: bigint } | null {
  const record = readPayloadRecord(payload);
  const orderRecord =
    venue === "limitless"
      ? (readNestedRecord(record, "order") ?? record)
      : record;
  if (!orderRecord) return null;

  const makerAmountRaw = parseRawInteger(orderRecord.makerAmount);
  const takerAmountRaw = parseRawInteger(orderRecord.takerAmount);
  if (
    makerAmountRaw == null ||
    takerAmountRaw == null ||
    makerAmountRaw <= 0n ||
    takerAmountRaw <= 0n
  ) {
    return null;
  }
  return { makerAmountRaw, takerAmountRaw };
}

export function computeBuyCollateralLockedRaw(inputs: {
  venue: Venue;
  side: string | null;
  price: string | number | null;
  size: string | number | null;
  filledSize: string | number | null;
  orderPayload: unknown | null;
}): bigint {
  if (inputs.side?.toUpperCase() !== "BUY") return 0n;

  const signedAmounts = readSignedAmounts(inputs.venue, inputs.orderPayload);
  if (signedAmounts) {
    const filledSizeRaw = parseDecimalToMicro(inputs.filledSize) ?? 0n;
    const remainingSharesRaw =
      signedAmounts.takerAmountRaw > filledSizeRaw
        ? signedAmounts.takerAmountRaw - filledSizeRaw
        : 0n;
    if (remainingSharesRaw <= 0n) return 0n;
    return (
      (signedAmounts.makerAmountRaw * remainingSharesRaw) /
      signedAmounts.takerAmountRaw
    );
  }

  const sizeRaw = parseDecimalToMicro(inputs.size);
  const priceRaw = parseDecimalToMicro(inputs.price);
  if (sizeRaw == null || priceRaw == null || sizeRaw <= 0n || priceRaw <= 0n) {
    return 0n;
  }
  const filledSizeRaw = parseDecimalToMicro(inputs.filledSize) ?? 0n;
  const remainingSizeRaw =
    sizeRaw > filledSizeRaw ? sizeRaw - filledSizeRaw : 0n;
  if (remainingSizeRaw <= 0n) return 0n;
  return (remainingSizeRaw * priceRaw) / MICRO_SCALE;
}

function addLock(
  target: Map<string, bigint>,
  walletKey: string | null,
  amount: bigint,
) {
  const key = normalizeCollateralWalletKey(walletKey);
  if (!key || amount <= 0n) return;
  target.set(key, (target.get(key) ?? 0n) + amount);
}

export async function fetchOpenOrderCollateralLocks(
  pool: Pick<Pool, "query">,
  inputs: {
    userId: string;
    polymarketWallets: string[];
    limitlessWallets: string[];
  },
): Promise<OpenOrderCollateralLocks> {
  const polymarketWallets = Array.from(
    new Set(
      inputs.polymarketWallets
        .map(normalizeCollateralWalletKey)
        .filter(Boolean),
    ),
  );
  const limitlessWallets = Array.from(
    new Set(
      inputs.limitlessWallets.map(normalizeCollateralWalletKey).filter(Boolean),
    ),
  );

  const locks: OpenOrderCollateralLocks = {
    polymarket: new Map(),
    limitless: new Map(),
  };

  if (polymarketWallets.length === 0 && limitlessWallets.length === 0) {
    return locks;
  }

  const { rows } = await pool.query<OpenOrderCollateralRow>(
    `
      select
        lower(o.venue) as venue,
        case
          when lower(o.venue) = 'polymarket' then
            lower(coalesce(nullif(o.order_payload->>'maker', ''), o.wallet_address, o.signer_address))
          when lower(o.venue) = 'limitless' then
            lower(coalesce(o.wallet_address, o.signer_address))
          else null
        end as wallet_key,
        o.side,
        o.price,
        o.size,
        o.filled_size,
        o.order_payload
      from orders o
      where o.user_id = $1
        and lower(o.venue) in ('polymarket', 'limitless')
        and lower(coalesce(o.status, '')) = any($2::text[])
        and o.cancelled_at is null
        and upper(coalesce(o.side, '')) = 'BUY'
        and (o.order_type is null or upper(o.order_type) in ('GTC', 'GTD'))
        and (
          (
            lower(o.venue) = 'polymarket'
            and lower(coalesce(nullif(o.order_payload->>'maker', ''), o.wallet_address, o.signer_address)) = any($3::text[])
          )
          or (
            lower(o.venue) = 'limitless'
            and lower(coalesce(o.wallet_address, o.signer_address)) = any($4::text[])
          )
        )
    `,
    [
      inputs.userId,
      [...OPEN_ORDER_STATUSES],
      polymarketWallets,
      limitlessWallets,
    ],
  );

  for (const row of rows) {
    const venue = row.venue;
    const lockedRaw = computeBuyCollateralLockedRaw({
      venue,
      side: row.side,
      price: row.price,
      size: row.size,
      filledSize: row.filled_size,
      orderPayload: row.order_payload,
    });
    if (venue === "polymarket") {
      addLock(locks.polymarket, row.wallet_key, lockedRaw);
    } else if (venue === "limitless") {
      addLock(locks.limitless, row.wallet_key, lockedRaw);
    }
  }

  return locks;
}

export async function fetchPolymarketOpenOrderPositionLocks(
  pool: Pick<Pool, "query">,
  inputs: { userId: string; wallet: string },
): Promise<Map<string, bigint>> {
  const wallet = normalizeCollateralWalletKey(inputs.wallet);
  const locks = new Map<string, bigint>();
  if (!wallet) return locks;
  const { rows } = await pool.query<OpenOrderPositionRow>(
    `SELECT
       lower(coalesce(nullif(o.order_payload->>'maker', ''), o.wallet_address, o.signer_address)) AS wallet_key,
       coalesce(nullif(o.order_payload->>'tokenId', ''), o.token_id) AS token_id,
       o.size,
       o.filled_size,
       o.order_payload
     FROM orders o
     WHERE o.user_id = $1
       AND lower(o.venue) = 'polymarket'
       AND lower(coalesce(o.status, '')) = ANY($2::text[])
       AND o.cancelled_at IS NULL
       AND upper(coalesce(o.side, '')) = 'SELL'
       AND (o.order_type IS NULL OR upper(o.order_type) IN ('GTC', 'GTD'))
       AND lower(coalesce(nullif(o.order_payload->>'maker', ''), o.wallet_address, o.signer_address)) = $3`,
    [inputs.userId, [...OPEN_ORDER_STATUSES], wallet],
  );
  for (const row of rows) {
    const tokenId = row.token_id?.trim();
    if (!tokenId) continue;
    const signed = readSignedAmounts("polymarket", row.order_payload);
    const original =
      signed?.makerAmountRaw ?? parseDecimalToMicro(row.size) ?? 0n;
    const filled = parseDecimalToMicro(row.filled_size) ?? 0n;
    const remaining = original > filled ? original - filled : 0n;
    if (remaining <= 0n) continue;
    const key = `${wallet}:${tokenId}`;
    locks.set(key, (locks.get(key) ?? 0n) + remaining);
  }
  return locks;
}
