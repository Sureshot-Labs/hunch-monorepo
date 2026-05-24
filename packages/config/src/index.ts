import fs from "fs";
import path from "path";
import { config as dotenv } from "dotenv";

import { z } from "zod";

/**
 * Walk up parent directories until we find a `.env` file,
 * then load it. Stops at filesystem root.
 */
function loadRootEnv() {
  if (process.env.HUNCH_RUNTIME_SECRETS_LOADED === "1") return;
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      dotenv({ path: candidate, override: true });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadRootEnv();

const Env = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.string().transform(Number).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  OPENSEARCH_URL: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type EnvType = z.infer<typeof Env>;

export const env: EnvType = (() => {
  try {
    return Env.parse(process.env);
  } catch (err) {
    console.error("❌ Invalid environment variables:", err);
    process.exit(1);
  }
})();
