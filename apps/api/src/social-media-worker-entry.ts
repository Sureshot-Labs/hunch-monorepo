#!/usr/bin/env tsx

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPgPool, type Pool } from "@hunch/infra";

import {
  beginSignalBotMessageDelivery,
  finishSignalBotMessageDelivery,
  getSignalBotMessageDeliverySnapshot,
} from "./services/signal-bot-message-delivery-ledger.js";
import {
  claimXEditorialMediaJob,
  finishXEditorialMediaJob,
  requeueXEditorialMediaDelivery,
  renewXEditorialMediaJobLease,
  retryXEditorialMediaJob,
  type XEditorialMediaJob,
} from "./services/signal-bot-editorial-media-jobs.js";
import { TelegramBotApiClient } from "./services/signal-bot-telegram-client.js";
import type { SignalBotTelegramClient } from "./services/signal-bot-contracts.js";
import {
  renderXEditorialMedia,
  type RenderedXEditorialMedia,
  X_EDITORIAL_MEDIA_DEFAULT_FPS,
  X_EDITORIAL_MEDIA_MAX_FPS,
} from "./services/x-editorial-media-renderer.js";

type SocialMediaWorkerConfig = {
  allowedOrigins: string[];
  browserExecutablePath: string | null;
  enabled: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  fps: number;
  jobTimeoutMs: number;
  leaseMs: number;
  maxVideoBytes: number;
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
      /^\/tracking\/wallet\/[^/]+\/?$/.test(url.pathname)
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

function boundedInt(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, positiveInt(value, fallback, maximum));
}

export function parseSocialMediaWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): SocialMediaWorkerConfig {
  return {
    allowedOrigins: parseAllowedOrigins(env.HUNCH_SOCIAL_MEDIA_ALLOWED_ORIGINS),
    browserExecutablePath: env.HUNCH_SOCIAL_MEDIA_CHROMIUM_PATH?.trim() || null,
    enabled: parseBoolean(env.HUNCH_SOCIAL_MEDIA_WORKER_ENABLED, true),
    ffmpegPath: env.HUNCH_SOCIAL_MEDIA_FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.HUNCH_SOCIAL_MEDIA_FFPROBE_PATH?.trim() || "ffprobe",
    fps: positiveInt(
      env.HUNCH_SOCIAL_MEDIA_FPS,
      X_EDITORIAL_MEDIA_DEFAULT_FPS,
      X_EDITORIAL_MEDIA_MAX_FPS,
    ),
    jobTimeoutMs:
      boundedInt(env.HUNCH_SOCIAL_MEDIA_JOB_TIMEOUT_SEC, 900, 60, 3_600) *
      1_000,
    leaseMs:
      boundedInt(env.HUNCH_SOCIAL_MEDIA_LEASE_SEC, 600, 180, 3_600) * 1_000,
    maxVideoBytes:
      boundedInt(env.HUNCH_SOCIAL_MEDIA_MAX_VIDEO_MB, 45, 1, 49) * 1024 * 1024,
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

type XEditorialMediaJobOutcome =
  | "blocked"
  | "delivery_unknown"
  | "failed"
  | "lease_lost"
  | "retry"
  | "sent";

class LeaseLostError extends Error {
  constructor() {
    super("The editorial media job lease is no longer owned by this worker");
    this.name = "LeaseLostError";
  }
}

class EditorialMediaJobTimeoutError extends Error {
  constructor() {
    super("Editorial media job timed out");
    this.name = "EditorialMediaJobTimeoutError";
  }
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
    job: input.job,
    status: "delivery_unknown",
  });
}

async function terminalizeStartedDeliveryAsUnknown(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  errorCode: string;
  errorMessage: string;
  job: XEditorialMediaJob;
  metrics: Record<string, unknown>;
}): Promise<void> {
  await markDeliveryResult({
    db: input.db,
    errorCode: input.errorCode,
    job: input.job,
    metrics: input.metrics,
    status: "delivery_unknown",
  }).catch(() => false);
  await finishJobAsUnknown(input).catch(() => undefined);
}

async function ensureJobLease(input: {
  db: Parameters<typeof renewXEditorialMediaJobLease>[0]["db"];
  job: XEditorialMediaJob;
  leaseMs: number;
}): Promise<void> {
  const renewed = await renewXEditorialMediaJobLease(input);
  if (!renewed) throw new LeaseLostError();
}

async function reconcileDeliveryLedger(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  job: XEditorialMediaJob;
}): Promise<XEditorialMediaJobOutcome | null> {
  const snapshot = await getSignalBotMessageDeliverySnapshot({
    db: input.db,
    deliveryRef: input.job.deliveryRef,
  });
  if (
    snapshot?.status === "queued" &&
    snapshot.attemptId === input.job.deliveryAttemptId
  ) {
    return null;
  }
  if (snapshot?.status === "sending") {
    const persisted = await markDeliveryResult({
      db: input.db,
      errorCode: "delivery_recovered_from_sending",
      job: input.job,
      metrics: {
        editorialMediaV1: {
          status: "delivery_unknown",
          version: 1,
        },
      },
      status: "delivery_unknown",
    });
    await finishJobAsUnknown({
      db: input.db,
      errorCode: "delivery_recovered_from_sending",
      errorMessage: persisted
        ? "Recovered a job whose prior delivery outcome was ambiguous"
        : "Could not reconcile a job whose delivery ledger was sending",
      job: input.job,
    });
    return "delivery_unknown";
  }
  if (
    snapshot?.status === "sent" ||
    snapshot?.status === "blocked" ||
    snapshot?.status === "delivery_unknown" ||
    snapshot?.status === "skipped"
  ) {
    const outcome = snapshot.status === "skipped" ? "failed" : snapshot.status;
    await finishXEditorialMediaJob({
      db: input.db,
      errorCode:
        snapshot.status === "sent" ? null : `ledger_${snapshot.status}`,
      errorMessage: "Reconciled terminal delivery ledger state after recovery",
      job: input.job,
      result: { reconciledFromLedger: true },
      status: outcome,
    });
    return outcome;
  }
  await finishJobAsUnknown({
    db: input.db,
    errorCode: "delivery_ledger_inconsistent",
    errorMessage: `Expected queued delivery ledger, found ${snapshot?.status ?? "missing"}`,
    job: input.job,
  });
  return "delivery_unknown";
}

async function beginDeliveryOrReconcile(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  job: XEditorialMediaJob;
  leaseMs: number;
}): Promise<true | XEditorialMediaJobOutcome> {
  await ensureJobLease(input);
  if (await beginDelivery(input)) return true;
  const reconciled = await reconcileDeliveryLedger(input);
  if (reconciled) return reconciled;
  await ensureJobLease(input);
  await finishJobAsUnknown({
    db: input.db,
    errorCode: "delivery_ledger_not_acquired",
    errorMessage: "The queued delivery ledger could not be acquired",
    job: input.job,
  });
  return "delivery_unknown";
}

async function finishQueuedDeliveryAsSkipped(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  errorCode: string;
  job: XEditorialMediaJob;
  metrics: Record<string, unknown>;
}): Promise<boolean> {
  return finishSignalBotMessageDelivery({
    attemptId: input.job.deliveryAttemptId,
    db: input.db,
    deliveryRef: input.job.deliveryRef,
    errorCode: input.errorCode,
    expectedStatus: "queued",
    metrics: input.metrics,
    status: "skipped",
  });
}

async function deliverTextFallback(input: {
  db: Parameters<typeof finishSignalBotMessageDelivery>[0]["db"];
  job: XEditorialMediaJob;
  leaseMs: number;
  reason: string;
  retryDelayMs: number;
  telegram: SignalBotTelegramClient;
}): Promise<XEditorialMediaJobOutcome> {
  let deliveryStarted = false;
  try {
    const acquired = await beginDeliveryOrReconcile(input);
    if (acquired !== true) return acquired;
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
        job: input.job,
        result: { fallback: "text", messageId: result.messageId },
        status: persisted ? "sent" : "delivery_unknown",
      });
      return persisted ? "sent" : "delivery_unknown";
    }
    if (result.error === "other" && result.retryAfterSec) {
      const requeued = await requeueXEditorialMediaDelivery({
        db: input.db,
        job: input.job,
      });
      if (!requeued) {
        await finishJobAsUnknown({
          db: input.db,
          errorCode: "text_delivery_requeue_failed",
          errorMessage: result.message,
          job: input.job,
        });
        return "delivery_unknown";
      }
      deliveryStarted = false;
      const retryStatus = await retryXEditorialMediaJob({
        db: input.db,
        deliveryMode: "text",
        errorCode: "telegram_text_rate_limited",
        errorMessage: result.message,
        extendForDeliveryRetry: true,
        job: input.job,
        retryAfterMs: Math.max(
          input.retryDelayMs,
          result.retryAfterSec * 1_000,
        ),
      });
      if (retryStatus === "retry" || retryStatus === "lease_lost") {
        return retryStatus;
      }
      const persisted = await finishQueuedDeliveryAsSkipped({
        db: input.db,
        errorCode: "telegram_text_retry_exhausted",
        job: input.job,
        metrics: {
          editorialMediaV1: {
            fallback: "text",
            reason: input.reason,
            status: "retry_exhausted",
            version: 1,
          },
        },
      });
      await finishXEditorialMediaJob({
        db: input.db,
        errorCode: persisted
          ? "telegram_text_retry_exhausted"
          : "telegram_text_terminal_persist_failed",
        errorMessage: result.message,
        job: input.job,
        status: persisted ? "failed" : "delivery_unknown",
      });
      return persisted ? "failed" : "delivery_unknown";
    }
    const status =
      result.error === "ambiguous"
        ? "delivery_unknown"
        : result.error === "blocked_or_missing"
          ? "blocked"
          : "skipped";
    const persisted = await markDeliveryResult({
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
      job: input.job,
      status: !persisted
        ? "delivery_unknown"
        : status === "skipped"
          ? "failed"
          : status === "blocked"
            ? "blocked"
            : "delivery_unknown",
    });
    return !persisted
      ? "delivery_unknown"
      : status === "skipped"
        ? "failed"
        : status;
  } catch (error) {
    if (!deliveryStarted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await terminalizeStartedDeliveryAsUnknown({
      db: input.db,
      errorCode: "text_fallback_failed_after_delivery_started",
      errorMessage: message,
      job: input.job,
      metrics: {
        editorialMediaV1: {
          error: message,
          fallback: "text",
          status: "delivery_unknown",
          version: 1,
        },
      },
    });
    return "delivery_unknown";
  }
}

async function readRenderedVideos(
  rendered: RenderedXEditorialMedia[],
  maxVideoBytes: number,
): Promise<
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
    if (media.byteSize > maxVideoBytes) {
      throw new Error(
        `${media.profile} video exceeds the configured byte limit`,
      );
    }
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
  leaseMs: number;
  maxVideoBytes: number;
  navigationTimeoutMs: number;
  retryDelayMs: number;
  signal?: AbortSignal;
  telegram: SignalBotTelegramClient;
}): Promise<XEditorialMediaJobOutcome> {
  let temporaryDirectory: string | null = null;
  let deliveryStarted = false;
  try {
    input.signal?.throwIfAborted();
    await ensureJobLease(input);
    const reconciled = await reconcileDeliveryLedger(input);
    if (reconciled) return reconciled;
    if (input.job.deliveryMode === "text") {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "text_delivery_retry",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    if (
      !isAllowedXEditorialCaptureUrl({
        allowedOrigins: input.allowedOrigins,
        captureUrl: input.job.payload.captureUrl,
      })
    ) {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "capture_url_not_allowed",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "hunch-social-media-"),
    );
    const renderStartedAt = Date.now();
    let render: Awaited<ReturnType<typeof renderXEditorialMedia>>;
    try {
      render = await renderXEditorialMedia({
        browserExecutablePath: input.browserExecutablePath,
        ffmpegPath: input.ffmpegPath,
        ffprobePath: input.ffprobePath,
        fps: input.fps,
        navigationTimeoutMs: input.navigationTimeoutMs,
        maxOutputBytes: input.maxVideoBytes,
        outputDirectory: temporaryDirectory,
        profiles: input.job.payload.profiles,
        signal: input.signal,
        url: input.job.payload.captureUrl,
      });
    } catch (error) {
      log("social_media_render_failed", {
        attempt: input.job.attemptCount,
        elapsedMs: Date.now() - renderStartedAt,
        error: error instanceof Error ? error.message : String(error),
        fps: input.fps,
        jobId: input.job.id,
        profiles: input.job.payload.profiles,
      });
      throw error;
    }
    log("social_media_render_finished", {
      attempt: input.job.attemptCount,
      elapsedMs: Date.now() - renderStartedAt,
      failedProfiles: Object.keys(render.errors),
      fps: input.fps,
      jobId: input.job.id,
      renderedProfiles: render.rendered.map((media) => media.profile),
    });
    if (render.rendered.length === 0) {
      const errorMessage = Object.entries(render.errors)
        .map(([profile, message]) => `${profile}: ${message}`)
        .join("; ");
      const retryStatus = await retryXEditorialMediaJob({
        db: input.db,
        errorCode: "render_failed",
        errorMessage: errorMessage || "No media profile rendered",
        job: input.job,
        retryAfterMs: input.retryDelayMs,
      });
      if (retryStatus === "retry" || retryStatus === "lease_lost") {
        return retryStatus;
      }
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "render_attempts_exhausted",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    if (!input.telegram.sendVideo || !input.telegram.sendMediaGroup) {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "telegram_media_methods_unavailable",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    const videos = await readRenderedVideos(
      render.rendered,
      input.maxVideoBytes,
    );
    input.signal?.throwIfAborted();
    const acquired = await beginDeliveryOrReconcile(input);
    if (acquired !== true) return acquired;
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
        job: input.job,
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
        if (retryStatus === "retry" || retryStatus === "lease_lost") {
          return retryStatus;
        }
      }
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "telegram_media_rejected",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    const terminalStatus =
      telegramResult.error === "blocked_or_missing"
        ? "blocked"
        : "delivery_unknown";
    const persisted = await markDeliveryResult({
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
      errorCode: persisted
        ? telegramResult.error
        : "telegram_terminal_persist_failed",
      errorMessage: telegramResult.message,
      job: input.job,
      status: persisted ? terminalStatus : "delivery_unknown",
    });
    return persisted ? terminalStatus : "delivery_unknown";
  } catch (error) {
    if (
      error instanceof LeaseLostError ||
      input.signal?.reason instanceof LeaseLostError
    ) {
      return "lease_lost";
    }
    const failure = input.signal?.reason ?? error;
    const message =
      failure instanceof Error ? failure.message : String(failure);
    const errorCode =
      failure instanceof EditorialMediaJobTimeoutError
        ? "job_timeout"
        : "worker_failed";
    if (deliveryStarted) {
      await terminalizeStartedDeliveryAsUnknown({
        db: input.db,
        errorCode: "worker_failed_after_delivery_started",
        errorMessage: message,
        job: input.job,
        metrics: {
          editorialMediaV1: {
            error: message,
            status: "delivery_unknown",
            version: 1,
          },
        },
      });
      return "delivery_unknown";
    }
    if (input.job.attemptCount >= input.job.maxAttempts) {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "worker_attempts_exhausted",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    const retryStatus = await retryXEditorialMediaJob({
      db: input.db,
      errorCode,
      errorMessage: message,
      job: input.job,
      retryAfterMs: input.retryDelayMs,
    });
    if (retryStatus === "exhausted") {
      return deliverTextFallback({
        db: input.db,
        job: input.job,
        leaseMs: input.leaseMs,
        reason: "worker_attempts_exhausted",
        retryDelayMs: input.retryDelayMs,
        telegram: input.telegram,
      });
    }
    return retryStatus;
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function processWithLeaseHeartbeat(
  input: Parameters<typeof processXEditorialMediaJob>[0] & {
    jobTimeoutMs: number;
  },
): Promise<XEditorialMediaJobOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new EditorialMediaJobTimeoutError()),
    input.jobTimeoutMs,
  );
  timeout.unref();
  let heartbeatPromise = Promise.resolve();
  const heartbeat = setInterval(
    () => {
      heartbeatPromise = heartbeatPromise
        .then(async () => {
          if (controller.signal.aborted) return;
          const renewed = await renewXEditorialMediaJobLease({
            db: input.db,
            job: input.job,
            leaseMs: input.leaseMs,
          });
          if (!renewed) controller.abort(new LeaseLostError());
        })
        .catch((error: unknown) => controller.abort(error));
    },
    Math.max(10_000, Math.floor(input.leaseMs / 3)),
  );
  heartbeat.unref();
  try {
    return await processXEditorialMediaJob({
      ...input,
      signal: controller.signal,
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    await heartbeatPromise;
  }
}

export async function cleanupStaleSocialMediaDirectories(input?: {
  maxAgeMs?: number;
  now?: Date;
}): Promise<number> {
  const maxAgeMs = input?.maxAgeMs ?? 60 * 60_000;
  const now = input?.now ?? new Date();
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("hunch-social-media-")) {
      continue;
    }
    const directory = path.join(tmpdir(), entry.name);
    const metadata = await stat(directory).catch(() => null);
    if (!metadata || now.getTime() - metadata.mtimeMs < maxAgeMs) continue;
    await rm(directory, { force: true, recursive: true });
    removed += 1;
  }
  return removed;
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
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return;
  }
  if (!config.token) {
    throw new Error(
      "HUNCH_SIGNAL_BOT_TOKEN is required when the social media worker is enabled",
    );
  }
  const owner = `${process.pid}:${randomUUID()}`;
  const cleanedDirectories = await cleanupStaleSocialMediaDirectories().catch(
    (error: unknown) => {
      log("social_media_tmp_cleanup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    },
  );
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
    cleanedDirectories,
    jobTimeoutMs: config.jobTimeoutMs,
    leaseMs: config.leaseMs,
    maxVideoBytes: config.maxVideoBytes,
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
        const outcome = await processWithLeaseHeartbeat({
          allowedOrigins: config.allowedOrigins,
          browserExecutablePath: config.browserExecutablePath,
          db,
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          fps: config.fps,
          job,
          jobTimeoutMs: config.jobTimeoutMs,
          leaseMs: config.leaseMs,
          maxVideoBytes: config.maxVideoBytes,
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
