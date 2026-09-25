import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { PreviewBot } from "./bot.js";
import { readConfig } from "./config.js";
import { TelegramClient, TelegramError } from "./telegram.js";
import type { Catalog, Update } from "./types.js";

async function main() {
  const config = readConfig();
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  const telegram = new TelegramClient(config.token, stop.signal);
  const me = await telegram.call<{ username: string }>("getMe", {});
  const webhook = await telegram.call<{ url: string }>("getWebhookInfo", {});
  if (webhook.url)
    throw new Error(
      "This bot has a webhook. Use a separate preview bot; its webhook was not changed.",
    );
  const catalog = JSON.parse(
    readFileSync(new URL("../snapshots/screens.json", import.meta.url), "utf8"),
  ) as Catalog;
  const bot = new PreviewBot(catalog, telegram, config.webAppUrl);
  console.log(
    `Hunch Preview: @${me.username}; 8 allowed users; private chats only; ${catalog.screens.length} static screens.`,
  );
  console.log(
    config.webAppUrl
      ? "Demo Mini App configured."
      : "Demo Mini App URL not set. Chat screens are ready.",
  );
  let offset: number | undefined;
  while (!stop.signal.aborted) {
    try {
      const updates = await telegram.call<Update[]>("getUpdates", {
        ...(offset !== undefined ? { offset } : {}),
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        if (stop.signal.aborted) break;
        // Advance even after a failed render; replaying a send may duplicate it.
        offset = update.update_id + 1;
        try {
          await bot.handle(update);
        } catch (error) {
          console.error(
            error instanceof Error ? error.message : "Preview render failed.",
          );
        }
      }
    } catch (error) {
      if (stop.signal.aborted) break;
      if (error instanceof TelegramError && [401, 409].includes(error.code))
        throw error;
      console.error(
        error instanceof Error ? error.message : "Telegram polling failed.",
      );
      await setTimeout(
        error instanceof TelegramError
          ? Math.max(1000, (error.retryAfter ?? 3) * 1000)
          : 3000,
        undefined,
        { signal: stop.signal },
      ).catch(() => {});
    }
  }
  console.log("Hunch Preview stopped.");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Preview startup failed.",
  );
  process.exitCode = 1;
});
