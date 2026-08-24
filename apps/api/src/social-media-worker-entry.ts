#!/usr/bin/env tsx

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPgPool, type Pool } from "@hunch/infra";

import {
  beginSignalBotMessageDelivery,
  finishSignalBotMessageDelivery,
} from "./services/signal-bot-message-delivery-ledger.js";
import {
  claimXEditorialMediaJob,
  finishXEditorialMediaJob,
  requeueXEditorialMediaDelivery,
  retryXEditorialMediaJob,
  type XEditorialMediaJob,
} from "./services/signal-bot-editorial-media-jobs.js";
import { TelegramBotApiClient } from "./services/signal-bot-telegram-client.js";
import type { SignalBotTelegramClient } from "./services/signal-bot-contracts.js";
import {
  renderXEditorialMedia,
  type RenderedXEditorialMedia,
} from "./services/x-editorial-media-renderer.js";

type SocialMediaWorkerConfig = {
  allowedOrigins: string[];
  browserExecutablePath: string | null;
  enabled: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  fps: number;
  leaseMs: number;
  navigationTimeoutMs: number;
  pollIntervalMs: number;
  retryDelayMs: number;
  token: string;
};

function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = (value?.trim() || "https://app.hunch.trade")
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .flatMap((candidate) => {
      try {
        const url = new URL(candidate);
        return url.protocol === "https:" || url.protocol === "http:"
          ? [url.origin]
          : [];
      } catch {
        return [];
      }
    });
  return [...new Set(origins)];
}

export function isAllowedXEditorialCaptureUrl(input: {
  allowedOrigins: string[];
  captureUrl: string;
}): boolean {
  try {
    const url = new URL(input.captureUrl);
    return (
      input.allowedOrigins.includes(url.origin) &&
      url.pathname.startsWith("/tracking/wallet/")
    );
  } catch {
    return false;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function positiveInt(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function parseSocialMediaWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): SocialMediaWorkerConfig {
  return {
    allowedOrigins: parseAllowedOrigins(env.HUNCH_SOCIAL_MEDIA_ALLOWED_ORIGINS),
    browserExecutablePath: env.HUNCH_SOCIAL_MEDIA_CHROMIUM_PATH?.trim() || null,
    enabled: parseBoolean(
      env.HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_ENABLED,
      false,
    ),
    ffmpegPath: env.HUNCH_SOCIAL_MEDIA_FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.HUNCH_SOCIAL_MEDIA_FFPROBE_PATH?.trim() || "ffprobe",
    fps: positiveInt(env.HUNCH_SOCIAL_MEDIA_FPS, 30, 30),
    leaseMs: positiveInt(env.HUNCH_SOCIAL_MEDIA_LEASE_SEC, 600, 3_600) * 1_000,
    navigationTimeoutMs:
      positiveInt(env.HUNCH_SOCIAL_MEDIA_NAVIGATION_TIMEOUT_SEC, 45, 180) *
      1_000,
    pollIntervalMs:
      positiveInt(env.HUNCH_SOCIAL_MEDIA_POLL_INTERVAL_SEC, 5, 60) * 1_000,
    retryDelayMs:
      positiveInt(env.HUNCH_SOCIAL_MEDIA_RETRY_DELAY_SEC, 60, 3_600) * 1_000,
    token: env.HUNCH_SIGNAL_BOT_TOKEN?.trim() || "",
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the social media worker`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event: string, fields?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event,
      ...(fields ?? {}),
      ts: new Date().toISOString(),
    }),
  );
}

async function markDeliveryResult(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  errorCode?: string | null;
  job: XEditorialMediaJob;
  messageId?: number | null;
  metrics: Record<string, unknown>;
  status: "blocked" | "delivery_unknown" | "sent" | "skipped";
}): Promise<boolean> {
  return finishSignalBotMessageDelivery({
    attemptId: input.job.deliveryAttemptId,
    db: input.db,
    deliveryRef: input.job.deliveryRef,
    errorCode: input.errorCode,
    expectedStatus: "sending",
    messageId: input.messageId,
    metrics: input.metrics,
    status: input.status,
  });
}

async function beginDelivery(input: {
  db: Parameters<typeof beginSignalBotMessageDelivery>[0]["db"];
  job: XEditorialMediaJob;
}): Promise<boolean> {
  return beginSignalBotMessageDelivery({
    attemptId: input.job.deliveryAttemptId,
    db: input.db,
    deliveryRef: input.job.deliveryRef,
    expectedStatus: "queued",
  });
}

async function finishJobAsUnknown(input: {
  db: Parameters<typeof finishXEditorialMediaJob>[0]["db"];
  errorCode: string;
  errorMessage: string;
  job: XEditorialMediaJob;
}): Promise<void> {
  await finishXEditorialMediaJob({
    db: input.db,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    jobId: input.job.id,
    status: "delivery_unknown",
  });
}

async function deliverTextFallback(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  job: XEditorialMediaJob;
  reason: string;
  telegram: SignalBotTelegramClient;
}): Promise<"blocked" | "delivery_unknown" | "failed" | "sent"> {
  let deliveryStarted = false;
  try {
    if (!(await beginDelivery(input))) {
      await finishJobAsUnknown({
        ...input,
        errorCode: "delivery_ledger_not_queued",
        errorMessage: "Could not acquire the queued delivery ledger row",
      });
      return "delivery_unknown";
    }
    deliveryStarted = true;
    const result = await input.telegram.sendMessage({
      chat_id: input.job.chatId,
      disable_web_page_preview: true,
      parse_mode: "MarkdownV2",
      text: input.job.payload.captionMarkdownV2,
    });
    const metrics = {
      editorialMediaV1: {
        fallback: "text",
        reason: input.reason,
        status: result.ok ? "sent" : result.error,
        version: 1,
      },
    };
    if (result.ok) {
      const persisted = await markDeliveryResult({
        db: input.db,
        job: input.job,
        messageId: result.messageId,
        metrics,
        status: "sent",
      });
      await finishXEditorialMediaJob({
        db: input.db,
        jobId: input.job.id,
        result: { fallback: "text", messageId: result.messageId },
        status: persisted ? "sent" : "delivery_unknown",
      });
      return persisted ? "sent" : "delivery_unknown";
    }
    const status =
      result.error === "ambiguous"
        ? "delivery_unknown"
        : result.error === "blocked_or_missing"
          ? "blocked"
          : "skipped";
    await markDeliveryResult({
      db: input.db,
      errorCode: result.error,
      job: input.job,
      metrics,
      status,
    });
    await finishXEditorialMediaJob({
      db: input.db,
      errorCode: result.error,
      errorMessage: result.message,
      jobId: input.job.id,
      status:
        status === "skipped"
          ? "failed"
          : status === "blocked"
            ? "blocked"
            : "delivery_unknown",
    });
    return status === "skipped" ? "failed" : status;
  } catch (error) {
    if (!deliveryStarted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await markDeliveryResult({
      db: input.db,
      errorCode: "text_fallback_failed_after_delivery_started",
      job: input.job,
      metrics: {
        editorialMediaV1: {
          error: message,
          fallback: "text",
          status: "delivery_unknown",
          version: 1,
        },
      },
      status: "delivery_unknown",
    }).catch(() => false);
    await finishJobAsUnknown({
      db: input.db,
      errorCode: "text_fallback_failed_after_delivery_started",
      errorMessage: message,
      job: input.job,
    }).catch(() => undefined);
    return "delivery_unknown";
  }
}

async function readRenderedVideos(rendered: RenderedXEditorialMedia[]): Promise<
  Array<
    RenderedXEditorialMedia & {
      bytes: Uint8Array;
      filename: string;
      sha256: string;
    }
  >
> {
  const videos = [];
  for (const media of rendered) {
    const bytes = await readFile(media.path);
    videos.push({
      ...media,
      bytes,
      filename: path.basename(media.path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return videos;
}

export async function processXEditorialMediaJob(input: {
  allowedOrigins: string[];
  browserExecutablePath: string | null;
  db: Parameters<typeof claimXEditorialMediaJob>[0]["db"];
  ffmpegPath: string;
  ffprobePath: string;
  fps: number;
  job: XEditorialMediaJob;
  navigationTimeoutMs: number;
  retryDelayMs: number;
  telegram: SignalBotTelegramClient;
}): Promise<"blocked" | "delivery_unknown" | "failed" | "retry" | "sent"> {
  let temporaryDirectory: string | null = null;
  let deliveryStarted = false;
  try {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "hunch-social-media-"),
    );
    if (
      !isAllowedXEditorialCaptureUrl({
        allowedOrigins: input.allowedOrigins,
        captureUrl: input.job.payload.captureUrl,
      })
    ) {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        reason: "capture_url_not_allowed",
        telegram: input.telegram,
      });
    }
    const render = await renderXEditorialMedia({
      browserExecutablePath: input.browserExecutablePath,
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
      fps: input.fps,
      navigationTimeoutMs: input.navigationTimeoutMs,
      outputDirectory: temporaryDirectory,
      profiles: input.job.payload.profiles,
      url: input.job.payload.captureUrl,
    });
    if (render.rendered.length === 0) {
      const errorMessage = Object.entries(render.errors)
        .map(([profile, message]) => `${profile}: ${message}`)
        .join("; ");
      if (input.job.attemptCount < input.job.maxAttempts) {
        await retryXEditorialMediaJob({
          db: input.db,
          errorCode: "render_failed",
          errorMessage: errorMessage || "No media profile rendered",
          job: input.job,
          retryAfterMs: input.retryDelayMs,
        });
        return "retry";
      }
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        reason: "render_attempts_exhausted",
        telegram: input.telegram,
      });
    }
    if (!input.telegram.sendVideo || !input.telegram.sendMediaGroup) {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        reason: "telegram_media_methods_unavailable",
        telegram: input.telegram,
      });
    }
    const videos = await readRenderedVideos(render.rendered);
    if (!(await beginDelivery(input))) {
      await finishJobAsUnknown({
        ...input,
        errorCode: "delivery_ledger_not_queued",
        errorMessage: "Could not acquire the queued delivery ledger row",
      });
      return "delivery_unknown";
    }
    deliveryStarted = true;
    const telegramResult =
      videos.length === 1
        ? await input.telegram.sendVideo({
            caption: input.job.payload.captionMarkdownV2,
            chat_id: input.job.chatId,
            filename: videos[0]?.filename ?? "hunch.mp4",
            parse_mode: "MarkdownV2",
            video: videos[0]?.bytes ?? new Uint8Array(),
          })
        : await input.telegram.sendMediaGroup({
            caption: input.job.payload.captionMarkdownV2,
            chat_id: input.job.chatId,
            parse_mode: "MarkdownV2",
            videos: videos.map((video) => ({
              bytes: video.bytes,
              filename: video.filename,
            })),
          });
    if (telegramResult.ok) {
      const messageIds =
        "messageIds" in telegramResult
          ? telegramResult.messageIds
          : [telegramResult.messageId];
      const fileIds =
        "fileIds" in telegramResult
          ? telegramResult.fileIds
          : [telegramResult.fileId];
      const fileUniqueIds =
        "fileUniqueIds" in telegramResult
          ? telegramResult.fileUniqueIds
          : [telegramResult.fileUniqueId];
      const mediaMetrics = {
        editorialMediaV1: {
          failedProfiles: render.errors,
          fileIds,
          fileUniqueIds,
          messageIds,
          profiles: videos.map((video) => video.profile),
          renders: videos.map((video) => ({
            byteSize: video.byteSize,
            durationSec: video.durationSec,
            frameCount: video.frameCount,
            height: video.height,
            profile: video.profile,
            sha256: video.sha256,
            width: video.width,
          })),
          status: "sent",
          version: 1,
        },
      };
      const persisted = await markDeliveryResult({
        db: input.db,
        job: input.job,
        messageId: messageIds[0] ?? null,
        metrics: mediaMetrics,
        status: "sent",
      });
      await finishXEditorialMediaJob({
        db: input.db,
        jobId: input.job.id,
        result: mediaMetrics.editorialMediaV1,
        status: persisted ? "sent" : "delivery_unknown",
      });
      return persisted ? "sent" : "delivery_unknown";
    }
    if (telegramResult.error === "other") {
      const requeued = await requeueXEditorialMediaDelivery({
        db: input.db,
        job: input.job,
      });
      if (!requeued) {
        await finishJobAsUnknown({
          ...input,
          errorCode: "delivery_requeue_failed",
          errorMessage: telegramResult.message,
        });
        return "delivery_unknown";
      }
      deliveryStarted = false;
      if (telegramResult.retryAfterSec) {
        const retryStatus = await retryXEditorialMediaJob({
          db: input.db,
          errorCode: "telegram_rate_limited",
          errorMessage: telegramResult.message,
          extendForDeliveryRetry: true,
          job: input.job,
          retryAfterMs: telegramResult.retryAfterSec * 1_000,
        });
        return retryStatus;
      }
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        reason: "telegram_media_rejected",
        telegram: input.telegram,
      });
    }
    const terminalStatus =
      telegramResult.error === "blocked_or_missing"
        ? "blocked"
        : "delivery_unknown";
    await markDeliveryResult({
      db: input.db,
      errorCode: telegramResult.error,
      job: input.job,
      metrics: {
        editorialMediaV1: {
          error: telegramResult.message,
          status: terminalStatus,
          version: 1,
        },
      },
      status: terminalStatus,
    });
    await finishXEditorialMediaJob({
      db: input.db,
      errorCode: telegramResult.error,
      errorMessage: telegramResult.message,
      jobId: input.job.id,
      status: terminalStatus,
    });
    return terminalStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (deliveryStarted) {
      await markDeliveryResult({
        db: input.db,
        errorCode: "worker_failed_after_delivery_started",
        job: input.job,
        metrics: {
          editorialMediaV1: {
            error: message,
            status: "delivery_unknown",
            version: 1,
          },
        },
        status: "delivery_unknown",
      }).catch(() => false);
      await finishJobAsUnknown({
        db: input.db,
        errorCode: "worker_failed_after_delivery_started",
        errorMessage: message,
        job: input.job,
      }).catch(() => undefined);
      return "delivery_unknown";
    }
    if (input.job.attemptCount >= input.job.maxAttempts) {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        reason: "worker_attempts_exhausted",
        telegram: input.telegram,
      });
    }
    const retryStatus = await retryXEditorialMediaJob({
      db: input.db,
      errorCode: "worker_failed",
      errorMessage: message,
      job: input.job,
      retryAfterMs: input.retryDelayMs,
    });
    return retryStatus;
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

function createWorkerPool(): Pool {
  const pool = createPgPool({
    connectionString: requiredEnv("DATABASE_URL"),
    options: "-c jit=off",
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 3,
  });
  pool.on("error", (error: unknown) =>
    console.error("[social-media-worker] pg error", error),
  );
  return pool;
}

export async function runSocialMediaWorker(): Promise<void> {
  const config = parseSocialMediaWorkerConfig();
  if (!config.enabled) {
    log("social_media_worker_disabled");
    while (true) await delay(60_000);
  }
  if (!config.token) {
    throw new Error(
      "HUNCH_SIGNAL_BOT_TOKEN is required when social media rendering is enabled",
    );
  }
  const owner = `${process.pid}:${randomUUID()}`;
  const db = createWorkerPool();
  const telegram = new TelegramBotApiClient(config.token);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log("social_media_worker_started", {
    fps: config.fps,
    leaseMs: config.leaseMs,
  });
  try {
    while (!stopping) {
      const job = await claimXEditorialMediaJob({
        db,
        leaseMs: config.leaseMs,
        owner,
      }).catch((error: unknown) => {
        log("social_media_job_claim_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!job) {
        await delay(config.pollIntervalMs);
        continue;
      }
      try {
        const outcome = await processXEditorialMediaJob({
          allowedOrigins: config.allowedOrigins,
          browserExecutablePath: config.browserExecutablePath,
          db,
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          fps: config.fps,
          job,
          navigationTimeoutMs: config.navigationTimeoutMs,
          retryDelayMs: config.retryDelayMs,
          telegram,
        });
        log("social_media_job_finished", {
          attempt: job.attemptCount,
          jobId: job.id,
          outcome,
          profiles: job.payload.profiles,
        });
      } catch (error) {
        log("social_media_job_unhandled_error", {
          error: error instanceof Error ? error.message : String(error),
          jobId: job.id,
        });
        await delay(config.pollIntervalMs);
      }
    }
  } finally {
    await db.end().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSocialMediaWorker();
}
