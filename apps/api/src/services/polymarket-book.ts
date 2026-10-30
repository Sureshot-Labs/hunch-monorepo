import { polymarketClient } from "./polymarket-client.js";
import { createTradingBookCache } from "./trading-book-cache.js";

// /book returns the timestamp of the book version, not the HTTP observation.
// A quiet, freshly fetched book must not expire just because no order changed.
const cache = createTradingBookCache(undefined, undefined, {
  sourceTimestampBoundsLifetime: false,
});
// Outcome asset IDs identify immutable instruments. Callers still validate the
// market's CURRENT asset generation on every request, outside this public cache.
export const loadPolymarketBook = (tokenId: string) =>
  cache.load(tokenId, () => polymarketClient.getOrderBook(tokenId));
