import { createPgPool, createRedisClient, ensureRedis } from "@hunch/infra";
import { env } from "./env.js";
import { runAgentTheses } from "./services/agent-theses-runner.js";

const redis = createRedisClient({ url: env.redisUrl });
const pool = createPgPool({
  connectionString: env.dbUrl,
  max: 2,
  options: "-c statement_timeout=15000 -c lock_timeout=2000 -c jit=off",
});
try {
  if (process.argv.slice(2).some((arg) => arg !== "--"))
    throw new Error("No CLI overrides; configure agent_theses policy");
  await ensureRedis(redis);
  console.log(
    JSON.stringify(
      await runAgentTheses({
        db: pool,
        redis,
        apiKey: env.openRouterKey,
        limitlessPositionContract: env.limitlessConditionalTokensAddress,
      }),
    ),
  );
} finally {
  if (redis.isOpen) await redis.quit();
  await pool.end();
}
