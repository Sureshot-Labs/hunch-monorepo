type RedisMulti = {
  set: (key: string, value: string, options?: { EX?: number }) => RedisMulti;
  publish: (channel: string, message: string) => RedisMulti;
  exec: () => Promise<unknown>;
};

export type MarketUpdateRedis = {
  multi: () => RedisMulti;
};

export type MarketUpdatePayload = {
  schema_version: 1;
  venue: string;
  token_id: string;
  market_id: string | null;
  event_id: string | null;
  condition_id: string | null;
  volume_total: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  open_interest: number | null;
  last_price: number | null;
  status: string | null;
  accepting_orders: boolean | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: number | null;
  event_volume_total: number | null;
  event_volume_24h: number | null;
  event_liquidity: number | null;
  event_open_interest: number | null;
  ts: number;
};

export type PublishMarketUpdateInputs = {
  redis: MarketUpdateRedis;
  venue: string;
  tokenIds: Array<string | null | undefined>;
  marketId?: string | null;
  eventId?: string | null;
  conditionId?: string | null;
  volumeTotal?: number | null;
  volume24h?: number | null;
  liquidity?: number | null;
  openInterest?: number | null;
  lastPrice?: number | null;
  status?: string | null;
  acceptingOrders?: boolean | null;
  resolvedOutcome?: string | null;
  resolvedOutcomePct?: number | null;
  eventVolumeTotal?: number | null;
  eventVolume24h?: number | null;
  eventLiquidity?: number | null;
  eventOpenInterest?: number | null;
  tsMs?: number;
  ttlSec?: number;
};

function normalizedNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedTokenIds(
  tokenIds: Array<string | null | undefined>,
): string[] {
  return Array.from(
    new Set(
      tokenIds
        .map((tokenId) => tokenId?.trim())
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
}

export function buildMarketUpdatePayload(
  inputs: Omit<PublishMarketUpdateInputs, "redis" | "ttlSec" | "tokenIds"> & {
    tokenId: string;
  },
): MarketUpdatePayload {
  return {
    schema_version: 1,
    venue: inputs.venue,
    token_id: inputs.tokenId,
    market_id: inputs.marketId ?? null,
    event_id: inputs.eventId ?? null,
    condition_id: inputs.conditionId ?? null,
    volume_total: normalizedNumber(inputs.volumeTotal),
    volume_24h: normalizedNumber(inputs.volume24h),
    liquidity: normalizedNumber(inputs.liquidity),
    open_interest: normalizedNumber(inputs.openInterest),
    last_price: normalizedNumber(inputs.lastPrice),
    status: inputs.status ?? null,
    accepting_orders: inputs.acceptingOrders ?? null,
    resolved_outcome: inputs.resolvedOutcome ?? null,
    resolved_outcome_pct: normalizedNumber(inputs.resolvedOutcomePct),
    event_volume_total: normalizedNumber(inputs.eventVolumeTotal),
    event_volume_24h: normalizedNumber(inputs.eventVolume24h),
    event_liquidity: normalizedNumber(inputs.eventLiquidity),
    event_open_interest: normalizedNumber(inputs.eventOpenInterest),
    ts: inputs.tsMs ?? Date.now(),
  };
}

export async function publishMarketUpdate(
  inputs: PublishMarketUpdateInputs,
): Promise<void> {
  const tokenIds = normalizedTokenIds(inputs.tokenIds);
  if (!tokenIds.length) return;

  const ttlSec = inputs.ttlSec ?? 60;
  const multi = inputs.redis.multi();
  for (const tokenId of tokenIds) {
    const payload = buildMarketUpdatePayload({ ...inputs, tokenId });
    const payloadJson = JSON.stringify(payload);
    multi.set(`market_update:${tokenId}`, payloadJson, { EX: ttlSec });
    multi.publish(`market_update:${tokenId}`, payloadJson);
  }
  await multi.exec();
}
