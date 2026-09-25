import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The exporter imports real renderers only in this disposable, offline process.
// In particular, neither the root .env nor the preview bot token is inherited.
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--import",
    fileURLToPath(new URL("./offline.mjs", import.meta.url)),
    "apps/api/src/telegram-preview/export.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TZ: "UTC",
      TELEGRAM_PREVIEW_EXPORT: "1",
      HUNCH_RUNTIME_SECRETS_LOADED: "1",
      HUNCH_SIGNAL_BOT_APP_BASE_URL: "https://preview.invalid",
      DATABASE_URL: "postgresql://preview:preview@127.0.0.1:1/preview",
      JWT_SECRET: "offline-preview-only",
      PRIVY_APP_ID: "offline-preview-only",
      PRIVY_APP_SECRET: "offline-preview-only",
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
