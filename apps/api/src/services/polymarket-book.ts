import { polymarketClient } from "./polymarket-client.js";
import { createTradingBookCache } from "./trading-book-cache.js";

const cache = createTradingBookCache();
// Outcome asset IDs identify immutable instruments. Callers still validate the
// market's CURRENT asset generation on every request, outside this public cache.
export const loadPolymarketBook = (tokenId: string) =>
  cache.load(tokenId, () => polymarketClient.getOrderBook(tokenId));
