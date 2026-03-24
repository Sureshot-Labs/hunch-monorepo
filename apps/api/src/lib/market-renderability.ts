type BuildRenderableMarketSqlOptions = {
  alias?: string;
  volumeTotalExpr?: string;
  volume24hExpr?: string;
  liquidityExpr?: string;
  openInterestExpr?: string;
  bestBidExpr?: string;
  bestAskExpr?: string;
  lastPriceExpr?: string;
};

export function buildRenderableMarketSql(
  options: BuildRenderableMarketSqlOptions = {},
): string {
  const alias = options.alias ?? "m";
  const volumeTotalExpr = options.volumeTotalExpr ?? `${alias}.volume_total`;
  const volume24hExpr = options.volume24hExpr ?? `${alias}.volume_24h`;
  const liquidityExpr = options.liquidityExpr ?? `${alias}.liquidity`;
  const openInterestExpr = options.openInterestExpr ?? `${alias}.open_interest`;
  const bestBidExpr = options.bestBidExpr ?? `${alias}.best_bid`;
  const bestAskExpr = options.bestAskExpr ?? `${alias}.best_ask`;
  const lastPriceExpr = options.lastPriceExpr ?? `${alias}.last_price`;

  return `(
    coalesce(${volumeTotalExpr}, 0) > 0
    or coalesce(${volume24hExpr}, 0) > 0
    or coalesce(${liquidityExpr}, 0) > 0
    or coalesce(${openInterestExpr}, 0) > 0
    or ${bestBidExpr} is not null
    or ${bestAskExpr} is not null
    or ${lastPriceExpr} is not null
  )`;
}
