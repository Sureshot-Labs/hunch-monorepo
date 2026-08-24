import assert from "node:assert/strict";

import {
  isAllowedXEditorialCaptureUrl,
  parseSocialMediaWorkerConfig,
} from "./social-media-worker-entry.js";
import {
  claimXEditorialMediaJob,
  enqueueXEditorialMediaJob,
} from "./services/signal-bot-editorial-media-jobs.js";
import { sendTelegramMediaGroupRequest } from "./services/telegram-api-media.js";
import {
  editorialMediaScrollProgress,
  X_EDITORIAL_MEDIA_PROFILE_SPECS,
} from "./services/x-editorial-media-renderer.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "worker configuration is disabled by default and keeps canonical output settings",
    run: () => {
      const config = parseSocialMediaWorkerConfig({});
      assert.equal(config.enabled, false);
      assert.equal(config.fps, 30);
      assert.equal(config.leaseMs, 600_000);
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
    },
  },
  {
    name: "scroll timeline holds, eases forward, and reaches its target",
    run: () => {
      assert.equal(
        editorialMediaScrollProgress({ elapsedSec: 0, profile: "mobile" }),
        0,
      );
      const middle = editorialMediaScrollProgress({
        elapsedSec: 4.3,
        profile: "mobile",
      });
      assert.ok(middle > 0 && middle < 1);
      assert.equal(
        editorialMediaScrollProgress({ elapsedSec: 8, profile: "mobile" }),
        1,
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
                max_attempts: 3,
                payload: {
                  captionMarkdownV2: "Draft",
                  captureUrl: "https://app.hunch.trade/tracking/wallet/0x123",
                  profiles: ["mobile", "desktop"],
                  version: 1,
                },
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
