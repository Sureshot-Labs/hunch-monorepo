type RedisMulti = {
  set: (key: string, value: string, options?: { EX?: number }) => RedisMulti;
  publish: (channel: string, message: string) => RedisMulti;
  exec: () => Promise<unknown>;
};

export type MarketStateRedis = {
  multi: () => RedisMulti;
};

export type MarketStatePayload = {
  schema_version: 1;
  venue: string;
  token_id: string;
  market: string | null;
  condition_id: string | null;
  event_type: string;
  status: string | null;
  accepting_orders: boolean | null;
  resolved_outcome: string | null;
  ts: number;
};

export type PublishMarketStateInputs = {
  redis: MarketStateRedis;
  venue: string;
  tokenId: string;
  market?: string | null;
  conditionId?: string | null;
  eventType?: string;
  status?: string | null;
  acceptingOrders?: boolean | null;
  resolvedOutcome?: string | null;
  tsMs?: number;
  ttlSec?: number;
};

export function buildMarketStatePayload(
  inputs: Omit<PublishMarketStateInputs, "redis" | "ttlSec">,
): MarketStatePayload {
  return {
    schema_version: 1,
    venue: inputs.venue,
    token_id: inputs.tokenId,
    market: inputs.market ?? null,
    condition_id: inputs.conditionId ?? null,
    event_type: inputs.eventType ?? "price_refresh",
    status: inputs.status ?? null,
    accepting_orders: inputs.acceptingOrders ?? null,
    resolved_outcome: inputs.resolvedOutcome ?? null,
    ts: inputs.tsMs ?? Date.now(),
  };
}

export async function publishMarketState(
  inputs: PublishMarketStateInputs,
): Promise<void> {
  const payload = buildMarketStatePayload(inputs);
  const payloadJson = JSON.stringify(payload);
  const ttlSec = inputs.ttlSec ?? 60;

  const multi = inputs.redis.multi();
  multi.set(`market_state:${payload.token_id}`, payloadJson, { EX: ttlSec });
  multi.publish(`market_state:${payload.token_id}`, payloadJson);
  await multi.exec();
}
