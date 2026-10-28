import { limitlessRequest } from "./limitless-client.js";
import { createTradingBookCache } from "./trading-book-cache.js";

const cache = createTradingBookCache();
export const clearLimitlessBookCache = () => cache.clear();
export const loadLimitlessBook = (slug: string) =>
  cache.load(slug, async () => {
    const response = await limitlessRequest({
      allowRetry: false,
      method: "GET",
      requestPath: `/markets/${encodeURIComponent(slug)}/orderbook`,
      timeoutMs: 3_000,
    });
    if (!response.ok) throw new Error("limitless_book_unavailable");
    return response.payload;
  });
