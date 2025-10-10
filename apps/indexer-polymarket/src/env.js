import { config } from "dotenv";
import { resolve } from "path";
const cwd = process.cwd(); // apps/indexer-polymarket
config({ path: resolve(cwd, "../../.env"), override: true }); // load repo .env
// 🧹 Prevent pg from mixing PG* env with your connectionString
["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach((k) => delete process.env[k]);
function req(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[env] Missing ${name}. Make sure it's in ../../.env`);
        process.exit(1);
    }
    return v;
}
export const env = {
    dbUrl: req("DATABASE_URL"),
    redisUrl: req("REDIS_URL"),
    gammaBase: process.env.POLYMARKET_GAMMA_BASE ?? "https://gamma-api.polymarket.com",
    clobBase: process.env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com",
    wsUrl: process.env.POLYMARKET_WS ??
        "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    // bootstrapLimit removed - now fetching all events
    topBookSnapshot: Number(process.env.INDEXER_TOP_BOOK_SNAPSHOT ?? "150"),
    wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
    wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
};
//# sourceMappingURL=env.js.map