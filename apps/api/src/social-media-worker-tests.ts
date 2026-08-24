import assert from "node:assert/strict";

import {
  isAllowedXEditorialCaptureUrl,
  parseSocialMediaWorkerConfig,
  processXEditorialMediaJob,
} from "./social-media-worker-entry.js";
import { parseXEditorialMediaPreviewOptions } from "./social-media-preview.js";
import {
  claimXEditorialMediaJob,
  enqueueXEditorialMediaJob,
  finishXEditorialMediaJob,
  retryXEditorialMediaJob,
  type XEditorialMediaJob,
} from "./services/signal-bot-editorial-media-jobs.js";
import { sendTelegramMediaGroupRequest } from "./services/telegram-api-media.js";
import {
  editorialMediaScrollPosition,
  X_EDITORIAL_MEDIA_PROFILE_SPECS,
  X_EDITORIAL_MEDIA_TIMELINE,
} from "./services/x-editorial-media-renderer.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "local preview CLI accepts a tracking-wallet URL and bounded profiles",
    run: () => {
      const options = parseXEditorialMediaPreviewOptions([
        "--url",
        "http://localhost:3000/tracking/wallet/0x123?chain=polygon",
        "--profiles=desktop,mobile,desktop",
        "--fps",
        "12",
        "--output",
        "/tmp/hunch-preview",
      ]);
      assert.deepEqual(options, {
        fps: 12,
        outputRoot: "/tmp/hunch-preview",
        profiles: ["desktop", "mobile"],
        url: "http://localhost:3000/tracking/wallet/0x123?chain=polygon",
      });
    },
  },
  {
    name: "local preview CLI rejects unrelated pages and out-of-range FPS",
    run: () => {
      assert.throws(
        () =>
          parseXEditorialMediaPreviewOptions([
            "--url",
            "https://app.hunch.trade/admin",
          ]),
        /tracking\/wallet/,
      );
      assert.throws(
        () =>
          parseXEditorialMediaPreviewOptions([
            "--url",
            "https://app.hunch.trade/tracking/wallet/0x123",
            "--fps=60",
          ]),
        /12 through 30/,
      );
      assert.throws(
        () =>
          parseXEditorialMediaPreviewOptions([
            "--url",
            "https://app.hunch.trade/tracking/wallet/0x123",
            "--profiles",
          ]),
        /requires at least one profile/,
      );
    },
  },
  {
    name: "consumer stays enabled independently of the producer and keeps safe bounds",
    run: () => {
      const config = parseSocialMediaWorkerConfig({});
      assert.equal(config.enabled, true);
      assert.equal(config.fps, 30);
      assert.equal(config.leaseMs, 600_000);
      assert.equal(config.jobTimeoutMs, 300_000);
      assert.equal(config.maxVideoBytes, 45 * 1024 * 1024);
      assert.equal(
        parseSocialMediaWorkerConfig({
          HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_ENABLED: "false",
        }).enabled,
        true,
      );
      assert.equal(
        parseSocialMediaWorkerConfig({
          HUNCH_SOCIAL_MEDIA_WORKER_ENABLED: "false",
        }).enabled,
        false,
      );
      assert.equal(
        parseSocialMediaWorkerConfig({
          HUNCH_SOCIAL_MEDIA_LEASE_SEC: "2",
        }).leaseMs,
        180_000,
      );
      assert.deepEqual(config.allowedOrigins, ["https://app.hunch.trade"]);
      assert.deepEqual(
        {
          height: X_EDITORIAL_MEDIA_PROFILE_SPECS.mobile.outputHeight,
          width: X_EDITORIAL_MEDIA_PROFILE_SPECS.mobile.outputWidth,
        },
        { height: 1_900, width: 1_080 },
      );
      assert.deepEqual(
        {
          height: X_EDITORIAL_MEDIA_PROFILE_SPECS.desktop.outputHeight,
          width: X_EDITORIAL_MEDIA_PROFILE_SPECS.desktop.outputWidth,
        },
        { height: 900, width: 1_440 },
      );
      assert.equal(X_EDITORIAL_MEDIA_PROFILE_SPECS.mobile.durationSec, 22);
      assert.equal(X_EDITORIAL_MEDIA_PROFILE_SPECS.desktop.durationSec, 16);
      assert.ok(
        X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetScrollEndSec <
          X_EDITORIAL_MEDIA_PROFILE_SPECS.mobile.durationSec,
      );
    },
  },
  {
    name: "capture URL fence only accepts tracking-wallet pages on configured origins",
    run: () => {
      const allowedOrigins = ["https://app.hunch.trade"];
      assert.equal(
        isAllowedXEditorialCaptureUrl({
          allowedOrigins,
          captureUrl:
            "https://app.hunch.trade/tracking/wallet/0x123?chain=polygon",
        }),
        true,
      );
      assert.equal(
        isAllowedXEditorialCaptureUrl({
          allowedOrigins,
          captureUrl: "https://example.com/tracking/wallet/0x123",
        }),
        false,
      );
      assert.equal(
        isAllowedXEditorialCaptureUrl({
          allowedOrigins,
          captureUrl: "https://app.hunch.trade/admin",
        }),
        false,
      );
      assert.equal(
        isAllowedXEditorialCaptureUrl({
          allowedOrigins,
          captureUrl:
            "https://app.hunch.trade/tracking/wallet/0x123/private-notes",
        }),
        false,
      );
    },
  },
  {
    name: "scroll timeline pauses on each editorial section between eased moves",
    run: () => {
      const positions = {
        "entry-distribution": 300,
        ledger: 400,
        mix: 200,
        performance: 100,
        profile: 0,
      };
      assert.equal(
        editorialMediaScrollPosition({ elapsedSec: 1, positions }),
        0,
      );
      const firstMove = editorialMediaScrollPosition({
        elapsedSec: 2.4,
        positions,
      });
      assert.ok(firstMove > 0 && firstMove < 100);
      assert.equal(
        editorialMediaScrollPosition({ elapsedSec: 4, positions }),
        100,
      );
      assert.equal(
        editorialMediaScrollPosition({ elapsedSec: 7.5, positions }),
        200,
      );
      assert.equal(
        editorialMediaScrollPosition({ elapsedSec: 11, positions }),
        300,
      );
      assert.equal(
        editorialMediaScrollPosition({ elapsedSec: 14, positions }),
        400,
      );
      const transitions = X_EDITORIAL_MEDIA_TIMELINE.scrollTransitions;
      for (let index = 0; index < transitions.length - 1; index += 1) {
        const current = transitions[index];
        const next = transitions[index + 1];
        assert.ok(next.startSec - current.endSec >= 2);
      }
      const finalTransition = transitions.at(-1);
      assert.ok(finalTransition);
      assert.ok(
        X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetOpenSec -
          finalTransition.endSec >=
          2,
      );
    },
  },
  {
    name: "enqueue atomically moves the delivery ledger to queued and stores the attempt",
    run: async () => {
      let capturedSql = "";
      let capturedParams: unknown[] = [];
      const queued = await enqueueXEditorialMediaJob({
        attemptId: "00000000-0000-4000-8000-000000000002",
        captionMarkdownV2: "Draft",
        captureUrl:
          "https://app.hunch.trade/tracking/wallet/0x123?chain=polygon",
        chatId: "-1001",
        db: {
          query: async (sql: string, params?: unknown[]) => {
            capturedSql = sql;
            capturedParams = params ?? [];
            return { rowCount: 1, rows: [{ id: "job-1" }] };
          },
        } as never,
        deliveryRef: "00000000-0000-4000-8000-000000000003",
        now: new Date("2026-08-24T12:00:00.000Z"),
        profiles: ["mobile", "desktop", "mobile"],
      });
      assert.equal(queued, true);
      assert.match(capturedSql, /with queued_delivery as/);
      assert.match(capturedSql, /delivery_attempt_id/);
      assert.match(
        String(capturedParams[2]),
        /"profiles":\["mobile","desktop"\]/,
      );
      assert.match(String(capturedParams[3]), /"status":"queued"/);
    },
  },
  {
    name: "claim returns the delivery attempt needed for the media handoff fence",
    run: async () => {
      const job = await claimXEditorialMediaJob({
        db: {
          query: async () => ({
            rowCount: 1,
            rows: [
              {
                attempt_count: 1,
                chat_id: "-1001",
                delivery_attempt_id: "00000000-0000-4000-8000-000000000002",
                id: "00000000-0000-4000-8000-000000000004",
                lease_owner: "test-worker",
                max_attempts: 3,
                payload: {
                  captionMarkdownV2: "Draft",
                  captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
                  profiles: ["mobile", "desktop"],
                  version: 1,
                },
                result: {},
                signal_bot_message_id: "00000000-0000-4000-8000-000000000003",
              },
            ],
          }),
        } as never,
        leaseMs: 600_000,
        owner: "test-worker",
      });
      assert.equal(
        job?.deliveryAttemptId,
        "00000000-0000-4000-8000-000000000002",
      );
      assert.deepEqual(job?.payload.profiles, ["mobile", "desktop"]);
      assert.equal(job?.leaseOwner, "test-worker");
    },
  },
  {
    name: "claim quarantines an invalid payload instead of leaving a poison lease",
    run: async () => {
      const sqlCalls: string[] = [];
      const job = await claimXEditorialMediaJob({
        db: {
          query: async (sql: string) => {
            sqlCalls.push(sql);
            if (sqlCalls.length > 1) return { rowCount: 1, rows: [] };
            return {
              rowCount: 1,
              rows: [
                {
                  attempt_count: 1,
                  chat_id: "-1001",
                  delivery_attempt_id: "00000000-0000-4000-8000-000000000002",
                  id: "00000000-0000-4000-8000-000000000004",
                  lease_owner: "test-worker",
                  max_attempts: 3,
                  payload: { version: 999 },
                  result: {},
                  signal_bot_message_id: "00000000-0000-4000-8000-000000000003",
                },
              ],
            };
          },
        } as never,
        leaseMs: 600_000,
        owner: "test-worker",
      });
      assert.equal(job, null);
      assert.equal(sqlCalls.length, 2);
      assert.match(sqlCalls[1] ?? "", /set status = 'failed'/);
      assert.match(sqlCalls[1] ?? "", /lease_owner = \$2/);
      assert.match(sqlCalls[1] ?? "", /attempt_count = \$3::integer/);
    },
  },
  {
    name: "job transitions are fenced by lease owner and attempt count",
    run: async () => {
      const sqlCalls: string[] = [];
      const paramsCalls: unknown[][] = [];
      const job: XEditorialMediaJob = {
        attemptCount: 2,
        chatId: "-1001",
        deliveryAttemptId: "00000000-0000-4000-8000-000000000002",
        deliveryMode: "media",
        deliveryRef: "00000000-0000-4000-8000-000000000003",
        id: "00000000-0000-4000-8000-000000000004",
        leaseOwner: "worker-a",
        maxAttempts: 3,
        payload: {
          captionMarkdownV2: "Draft",
          captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
          profiles: ["mobile"],
          version: 1,
        },
      };
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          sqlCalls.push(sql);
          paramsCalls.push(params ?? []);
          return { rowCount: 1, rows: [] };
        },
      } as never;
      assert.equal(
        await retryXEditorialMediaJob({
          db,
          errorCode: "render_failed",
          errorMessage: "failed",
          job,
          retryAfterMs: 1_000,
        }),
        "retry",
      );
      assert.equal(
        await finishXEditorialMediaJob({ db, job, status: "sent" }),
        true,
      );
      assert.match(sqlCalls[0] ?? "", /lease_owner = \$3/);
      assert.match(sqlCalls[0] ?? "", /attempt_count = \$8::integer/);
      assert.match(sqlCalls[1] ?? "", /lease_owner = \$7/);
      assert.match(sqlCalls[1] ?? "", /attempt_count = \$8::integer/);
      assert.equal(paramsCalls[0]?.[2], "worker-a");
      assert.equal(paramsCalls[0]?.[7], 2);
    },
  },
  {
    name: "an exhausted retry distinguishes an owned job from a lost lease",
    run: async () => {
      const job: XEditorialMediaJob = {
        attemptCount: 3,
        chatId: "-1001",
        deliveryAttemptId: "00000000-0000-4000-8000-000000000002",
        deliveryMode: "media",
        deliveryRef: "00000000-0000-4000-8000-000000000003",
        id: "00000000-0000-4000-8000-000000000004",
        leaseOwner: "worker-a",
        maxAttempts: 3,
        payload: {
          captionMarkdownV2: "Draft",
          captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
          profiles: ["mobile"],
          version: 1,
        },
      };
      const retry = (owned: boolean) =>
        retryXEditorialMediaJob({
          db: {
            query: async () => ({
              rowCount: owned ? 1 : 0,
              rows: owned ? [{ id: job.id }] : [],
            }),
          } as never,
          errorCode: "render_failed",
          errorMessage: "failed",
          job,
          retryAfterMs: 1_000,
        });
      assert.equal(await retry(true), "exhausted");
      assert.equal(await retry(false), "lease_lost");
    },
  },
  {
    name: "text fallback preserves a rate-limited draft as a text retry",
    run: async () => {
      const job: XEditorialMediaJob = {
        attemptCount: 3,
        chatId: "-1001",
        deliveryAttemptId: "00000000-0000-4000-8000-000000000002",
        deliveryMode: "text",
        deliveryRef: "00000000-0000-4000-8000-000000000003",
        id: "00000000-0000-4000-8000-000000000004",
        leaseOwner: "worker-a",
        maxAttempts: 3,
        payload: {
          captionMarkdownV2: "Draft",
          captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
          profiles: ["mobile"],
          version: 1,
        },
      };
      const paramsCalls: unknown[][] = [];
      let sendCalls = 0;
      const outcome = await processXEditorialMediaJob({
        allowedOrigins: ["https://app.hunch.trade"],
        browserExecutablePath: null,
        db: {
          query: async (sql: string, params?: unknown[]) => {
            paramsCalls.push(params ?? []);
            if (/select id::text, telegram_message_id, metrics/.test(sql)) {
              return {
                rowCount: 1,
                rows: [
                  {
                    id: job.deliveryRef,
                    metrics: {
                      deliveryStateV2: {
                        attemptId: job.deliveryAttemptId,
                        status: "queued",
                      },
                    },
                    telegram_message_id: null,
                  },
                ],
              };
            }
            return { rowCount: 1, rows: [] };
          },
        } as never,
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        fps: 30,
        job,
        leaseMs: 600_000,
        maxVideoBytes: 45 * 1024 * 1024,
        navigationTimeoutMs: 45_000,
        retryDelayMs: 60_000,
        telegram: {
          sendMessage: async () => {
            sendCalls += 1;
            return {
              error: "other" as const,
              message: "Too Many Requests",
              ok: false as const,
              retryAfterSec: 30,
            };
          },
        } as never,
      });
      assert.equal(outcome, "retry");
      assert.equal(sendCalls, 1);
      assert.ok(
        paramsCalls.some((params) =>
          params.some((value) =>
            String(value).includes('"deliveryMode":"text"'),
          ),
        ),
      );
    },
  },
  {
    name: "the final text rate limit terminalizes both ledgers without an orphan",
    run: async () => {
      const sqlCalls: string[] = [];
      const job: XEditorialMediaJob = {
        attemptCount: 6,
        chatId: "-1001",
        deliveryAttemptId: "00000000-0000-4000-8000-000000000002",
        deliveryMode: "text",
        deliveryRef: "00000000-0000-4000-8000-000000000003",
        id: "00000000-0000-4000-8000-000000000004",
        leaseOwner: "worker-a",
        maxAttempts: 3,
        payload: {
          captionMarkdownV2: "Draft",
          captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
          profiles: ["mobile"],
          version: 1,
        },
      };
      const outcome = await processXEditorialMediaJob({
        allowedOrigins: ["https://app.hunch.trade"],
        browserExecutablePath: null,
        db: {
          query: async (sql: string) => {
            sqlCalls.push(sql);
            if (/select id::text, telegram_message_id, metrics/.test(sql)) {
              return {
                rowCount: 1,
                rows: [
                  {
                    id: job.deliveryRef,
                    metrics: {
                      deliveryStateV2: {
                        attemptId: job.deliveryAttemptId,
                        status: "queued",
                      },
                    },
                    telegram_message_id: null,
                  },
                ],
              };
            }
            if (
              /select id::text\s+from signal_bot_editorial_media_jobs/.test(sql)
            ) {
              return { rowCount: 1, rows: [{ id: job.id }] };
            }
            return { rowCount: 1, rows: [] };
          },
        } as never,
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        fps: 30,
        job,
        leaseMs: 600_000,
        maxVideoBytes: 45 * 1024 * 1024,
        navigationTimeoutMs: 45_000,
        retryDelayMs: 60_000,
        telegram: {
          sendMessage: async () => ({
            error: "other" as const,
            message: "Too Many Requests",
            ok: false as const,
            retryAfterSec: 30,
          }),
        } as never,
      });
      assert.equal(outcome, "failed");
      assert.ok(
        sqlCalls.some(
          (sql) =>
            /update signal_bot_messages/.test(sql) &&
            /metrics #>> '\{deliveryStateV2,status\}' = \$2/.test(sql),
        ),
      );
      assert.ok(
        sqlCalls.some(
          (sql) =>
            /update signal_bot_editorial_media_jobs/.test(sql) &&
            /lease_owner = \$7/.test(sql),
        ),
      );
    },
  },
  {
    name: "a terminal delivery ledger is reconciled without resending",
    run: async () => {
      let sendCalls = 0;
      const outcome = await processXEditorialMediaJob({
        allowedOrigins: ["https://app.hunch.trade"],
        browserExecutablePath: null,
        db: {
          query: async (sql: string) =>
            /select id::text, telegram_message_id, metrics/.test(sql)
              ? {
                  rowCount: 1,
                  rows: [
                    {
                      id: "00000000-0000-4000-8000-000000000003",
                      metrics: {},
                      telegram_message_id: 123,
                    },
                  ],
                }
              : { rowCount: 1, rows: [] },
        } as never,
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        fps: 30,
        job: {
          attemptCount: 2,
          chatId: "-1001",
          deliveryAttemptId: "00000000-0000-4000-8000-000000000002",
          deliveryMode: "media",
          deliveryRef: "00000000-0000-4000-8000-000000000003",
          id: "00000000-0000-4000-8000-000000000004",
          leaseOwner: "worker-a",
          maxAttempts: 3,
          payload: {
            captionMarkdownV2: "Draft",
            captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
            profiles: ["mobile"],
            version: 1,
          },
        },
        leaseMs: 600_000,
        maxVideoBytes: 45 * 1024 * 1024,
        navigationTimeoutMs: 45_000,
        retryDelayMs: 60_000,
        telegram: {
          sendMessage: async () => {
            sendCalls += 1;
            return { messageId: 124, ok: true as const };
          },
        } as never,
      });
      assert.equal(outcome, "sent");
      assert.equal(sendCalls, 0);
    },
  },
  {
    name: "a lost lease prevents any Telegram mutation",
    run: async () => {
      let sendCalls = 0;
      const outcome = await processXEditorialMediaJob({
        allowedOrigins: ["https://app.hunch.trade"],
        browserExecutablePath: null,
        db: {
          query: async () => ({ rowCount: 0, rows: [] }),
        } as never,
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        fps: 30,
        job: {
          attemptCount: 1,
          chatId: "-1001",
          deliveryAttemptId: "00000000-0000-4000-8000-000000000002",
          deliveryMode: "text",
          deliveryRef: "00000000-0000-4000-8000-000000000003",
          id: "00000000-0000-4000-8000-000000000004",
          leaseOwner: "worker-a",
          maxAttempts: 3,
          payload: {
            captionMarkdownV2: "Draft",
            captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
            profiles: ["mobile"],
            version: 1,
          },
        },
        leaseMs: 600_000,
        maxVideoBytes: 45 * 1024 * 1024,
        navigationTimeoutMs: 45_000,
        retryDelayMs: 60_000,
        telegram: {
          sendMessage: async () => {
            sendCalls += 1;
            return { messageId: 1, ok: true as const };
          },
        } as never,
      });
      assert.equal(outcome, "lease_lost");
      assert.equal(sendCalls, 0);
    },
  },
  {
    name: "Telegram media group attaches two MP4 files and returns durable IDs",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const requestBodies: FormData[] = [];
      globalThis.fetch = async (_url, init) => {
        requestBodies.push(init?.body as FormData);
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                message_id: 101,
                video: {
                  file_id: "file-mobile",
                  file_unique_id: "unique-mobile",
                },
              },
              {
                message_id: 102,
                video: {
                  file_id: "file-desktop",
                  file_unique_id: "unique-desktop",
                },
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      };
      try {
        const result = await sendTelegramMediaGroupRequest({
          baseUrl: "https://api.telegram.org/bottest",
          caption: "Draft",
          chatId: "-1001",
          parseMode: "MarkdownV2",
          signal: AbortSignal.timeout(1_000),
          videos: [
            { bytes: new Uint8Array([1, 2]), filename: "mobile.mp4" },
            { bytes: new Uint8Array([3, 4]), filename: "desktop.mp4" },
          ],
        });
        assert.deepEqual(result, {
          fileIds: ["file-mobile", "file-desktop"],
          fileUniqueIds: ["unique-mobile", "unique-desktop"],
          messageIds: [101, 102],
          ok: true,
        });
        const requestBody = requestBodies[0];
        assert.ok(requestBody instanceof FormData);
        assert.equal(requestBody.get("chat_id"), "-1001");
        assert.match(String(requestBody.get("media")), /attach:\/\/video_0/);
        assert.ok(requestBody.get("video_0") instanceof Blob);
        assert.ok(requestBody.get("video_1") instanceof Blob);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[social-media-worker-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[social-media-worker-tests] ${passed}/${tests.length} passed`);
