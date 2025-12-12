import { config } from "dotenv";
import { resolve } from "path";

const cwd = process.cwd(); // apps/indexer-kalshi
config({ path: resolve(cwd, "../../.env"), override: true });

["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (k) => delete process.env[k],
);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Put it in ../../.env`);
    process.exit(1);
  }
  return v;
}

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),

  // Kalshi auth + base
  kalshiBase: process.env.KALSHI_API_BASE ?? "https://demo-api.kalshi.co",
  kalshiWsUrl:
    process.env.KALSHI_WS_URL ?? "wss://demo-api.kalshi.co/trade-api/ws/v2",
  kalshiKeyId: req("KALSHI_API_KEY_ID"),
  kalshiPrivateKeyPath: req("KALSHI_PRIVATE_KEY_PATH"),

  // indexer knobs
  bootstrapLimit: Number(process.env.INDEXER_BOOTSTRAP_LIMIT ?? "200"),
  topBookSnapshot: Number(process.env.INDEXER_TOP_BOOK_SNAPSHOT ?? "150"),
  rpsRead: Number(process.env.KALSHI_RPS_READ ?? "18"), // under 20/s
  rpsWrite: Number(process.env.KALSHI_RPS_WRITE ?? "9"), // under 10/s
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
};
