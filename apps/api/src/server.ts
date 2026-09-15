import { buildApp } from "./app.js";
import { pool, waitForDatabaseReady } from "./db.js";
import { env } from "./env.js";
import { getRedis } from "./redis.js";

export async function start() {
  // HTTP traffic needs headroom; workers importing db.ts keep their existing cap.
  pool.options.max = 30;
  pool.options.application_name = "hunch-api";
  await getRedis().catch(() => {}); // optional
  await waitForDatabaseReady();

  const app = await buildApp();
  const addr = await app.listen({ port: env.port, host: env.host });
  app.log.info(`api listening on ${addr}`);
  return app;
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
