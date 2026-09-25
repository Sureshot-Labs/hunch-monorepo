import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export const ALLOWED_USER_IDS = new Set([
  "1413356895",
  "328573687",
  "949308286",
  "8418940574",
  "5766496728",
  "780532781",
  "1489504208",
  "7005668881",
]);

export function previewWebAppUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const url = new URL(raw.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /(^|\.)hunch\.trade$/i.test(url.hostname) ||
    /(^|\.)t\.me$/i.test(url.hostname)
  ) {
    throw new Error(
      "Use a separate HTTPS demo page for TELEGRAM_PREVIEW_WEB_APP_URL.",
    );
  }
  return url.href;
}

export function readConfig() {
  // Parse only this app's file. Do not populate process.env or load the root .env.
  let local: Record<string, string | undefined> = {};
  try {
    local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = (
    process.env.TELEGRAM_PREVIEW_BOT_TOKEN ?? local.TELEGRAM_PREVIEW_BOT_TOKEN
  )?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(
      "Set TELEGRAM_PREVIEW_BOT_TOKEN in apps/telegram-preview/.env.",
    );
  }
  return {
    token,
    webAppUrl: previewWebAppUrl(
      process.env.TELEGRAM_PREVIEW_WEB_APP_URL ??
        local.TELEGRAM_PREVIEW_WEB_APP_URL,
    ),
  };
}
