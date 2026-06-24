#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";

import { createRedisClient, ensureRedis } from "@hunch/infra";

import { pool } from "./db.js";
import { env } from "./env.js";
import {
  acquireSignalBotLock,
  parseSignalBotConfig,
  pollSignalBotCommands,
  publishSignalBotTick,
  refreshSignalBotLock,
  releaseSignalBotLock,
  sendLatestSignalBotTestSignal,
  TelegramBotApiClient,
} from "./services/signal-bot.js";

function log(event: string, fields?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(fields ?? {}),
    }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keepAliveDisabled(): Promise<never> {
  log("signal_bot_disabled");
  while (true) {
    await delay(60_000);
  }
}

async function waitForSignalBotLock(input: {
  owner: string;
  redis: Parameters<typeof acquireSignalBotLock>[0]["redis"];
  shouldStop: () => boolean;
}): Promise<boolean> {
  let attempts = 0;
  while (!input.shouldStop()) {
    const locked = await acquireSignalBotLock({
      owner: input.owner,
      redis: input.redis,
    });
    if (locked) {
      if (attempts > 0) {
        log("signal_bot_lock_acquired_after_wait", { attempts });
      }
      return true;
    }
    log(attempts === 0 ? "signal_bot_lock_held" : "signal_bot_lock_wait", {
      retrySec: 5,
    });
    attempts += 1;
    await delay(5_000);
  }
  return false;
}

export async function runSignalBotRunner(): Promise<void> {
  const config = parseSignalBotConfig();
  if (!config.enabled) {
    await keepAliveDisabled();
  }
  if (!config.token) {
    throw new Error("HUNCH_SIGNAL_BOT_TOKEN is required when signal bot is enabled");
  }
  if (!env.redisUrl) {
    throw new Error("REDIS_URL is required when signal bot is enabled");
  }
  if (config.adminUserIds.size === 0) {
    throw new Error(
      "HUNCH_SIGNAL_BOT_ADMIN_USER_IDS is required when signal bot is enabled",
    );
  }

  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, {
    logLabel: "signal-bot",
    waitForReady: true,
  });

  const owner = `${process.pid}:${randomUUID()}`;
  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const locked = await waitForSignalBotLock({
    owner,
    redis,
    shouldStop: () => shuttingDown,
  });
  if (!locked) {
    await redis.quit().catch(() => undefined);
    return;
  }

  const telegram = new TelegramBotApiClient(config.token);
  const botUsername = await telegram
    .getMe()
    .then((user) => user.username ?? null)
    .catch((error: unknown) => {
      log("signal_bot_get_me_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  log("signal_bot_started", {
    adminCount: config.adminUserIds.size,
    amountsUsd: config.amountsUsd,
    maxSignalsPerTick: config.maxSignalsPerTick,
    minConfidence: config.minConfidence,
    publishIntervalSec: config.publishIntervalSec,
  });

  let nextPublishAt = 0;
  let nextLockRefreshAt = Date.now() + 20_000;
  try {
    while (!shuttingDown) {
      try {
        if (Date.now() >= nextLockRefreshAt) {
          const stillLocked = await refreshSignalBotLock({ owner, redis });
          if (!stillLocked) {
            log("signal_bot_lock_lost");
            break;
          }
          nextLockRefreshAt = Date.now() + 20_000;
        }

        const handledCommands = await pollSignalBotCommands({
          botUsername,
          config,
          redis,
          sendTestSignal: (chatId) =>
            sendLatestSignalBotTestSignal({
              chatId,
              config,
              db: pool,
              telegram,
            }),
          telegram,
        });
        if (handledCommands > 0) {
          log("signal_bot_commands", { handled: handledCommands });
        }

        const now = Date.now();
        if (now >= nextPublishAt) {
          const result = await publishSignalBotTick({
            config,
            db: pool,
            redis,
            telegram,
          });
          log("signal_bot_publish_tick", result);
          nextPublishAt = now + config.publishIntervalSec * 1_000;
        }
      } catch (error) {
        log("signal_bot_loop_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        await delay(5_000);
      }
    }
  } finally {
    await releaseSignalBotLock({ owner, redis }).catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runSignalBotRunner();
  } finally {
    await pool.end();
  }
}
