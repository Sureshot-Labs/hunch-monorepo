#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  TelegramInitDataValidationError,
  normalizeTelegramStartParam,
  validateTelegramInitData,
} from "./lib/telegram-mini-app.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const BOT_TOKEN = "123456789:TEST_TOKEN";
const NOW = new Date("2026-07-03T12:00:00.000Z");

function signInitData(params: Record<string, string>): string {
  const searchParams = new URLSearchParams(params);
  const pairs = Array.from(searchParams.entries())
    .map(([key, value]) => `${key}=${value}`)
    .sort((left, right) => left.localeCompare(right));
  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const hash = crypto
    .createHmac("sha256", secret)
    .update(pairs.join("\n"))
    .digest("hex");
  searchParams.set("hash", hash);
  return searchParams.toString();
}

function makeValidInitData(overrides: Record<string, string> = {}): string {
  return signInitData({
    auth_date: Math.floor(NOW.getTime() / 1_000).toString(),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({
      id: 279058397,
      first_name: "Vladislav",
      last_name: "Kibenko",
      username: "vdkfrost",
      photo_url: "https://t.me/i/userpic/example.svg",
    }),
    ...overrides,
  });
}

function validate(initDataRaw: string) {
  return validateTelegramInitData(initDataRaw, {
    botToken: BOT_TOKEN,
    initDataMaxAgeSeconds: 300,
    now: NOW,
  });
}

async function assertValidationError(
  fn: () => unknown,
  code: string,
): Promise<void> {
  await assert.rejects(
    async () => {
      fn();
    },
    (error: unknown) =>
      error instanceof TelegramInitDataValidationError && error.code === code,
  );
}

const tests: TestCase[] = [
  {
    name: "valid Telegram init data returns safe context",
    run: () => {
      const result = validate(makeValidInitData({ start_param: "ref_ABC123" }));
      assert.equal(result.user.id, "279058397");
      assert.equal(result.user.username, "vdkfrost");
      assert.equal(result.startParam, "ref_ABC123");
      assert.equal(result.authDate.toISOString(), NOW.toISOString());
    },
  },
  {
    name: "invalid Telegram init data hash is rejected",
    run: async () => {
      const initData = makeValidInitData().replace(/hash=[a-f0-9]+/, "hash=0");
      await assertValidationError(() => validate(initData), "invalid_hash");
    },
  },
  {
    name: "missing Telegram init data hash is rejected",
    run: async () => {
      const params = new URLSearchParams(makeValidInitData());
      params.delete("hash");
      await assertValidationError(() => validate(params.toString()), "missing_hash");
    },
  },
  {
    name: "stale Telegram init data auth_date is rejected",
    run: async () => {
      const initData = makeValidInitData({
        auth_date: Math.floor((NOW.getTime() - 301_000) / 1_000).toString(),
      });
      await assertValidationError(() => validate(initData), "stale_auth_date");
    },
  },
  {
    name: "missing Telegram user is rejected",
    run: async () => {
      const params = new URLSearchParams(makeValidInitData());
      params.delete("hash");
      params.delete("user");
      const initData = signInitData(Object.fromEntries(params.entries()));
      await assertValidationError(() => validate(initData), "missing_user");
    },
  },
  {
    name: "malformed Telegram user JSON is rejected",
    run: async () => {
      const initData = makeValidInitData({ user: '{"id":279058397' });
      await assertValidationError(() => validate(initData), "malformed_user");
    },
  },
  {
    name: "oversized Telegram init data is rejected",
    run: async () => {
      await assertValidationError(
        () =>
          validateTelegramInitData(`user=${"x".repeat(9 * 1024)}`, {
            botToken: BOT_TOKEN,
            initDataMaxAgeSeconds: 300,
            now: NOW,
          }),
        "oversized_init_data",
      );
    },
  },
  {
    name: "unsafe Telegram start_param formats are ignored",
    run: () => {
      assert.equal(normalizeTelegramStartParam("ref_ABC123"), "ref_ABC123");
      assert.equal(normalizeTelegramStartParam("event_event-123"), "event_event-123");
      assert.equal(normalizeTelegramStartParam("https://example.com"), null);
      assert.equal(normalizeTelegramStartParam("event_../admin"), null);
      assert.equal(normalizeTelegramStartParam("unknown_value"), null);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-mini-app-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-mini-app-tests] passed ${passed}/${tests.length}`);
