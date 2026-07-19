#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  TelegramInitDataValidationError,
  normalizeTelegramStartParam,
  validateTelegramInitData,
} from "./lib/telegram-mini-app.js";
import {
  buildHunchMiniAppDeepLinkButton,
  buildHunchMiniAppWebButton,
} from "./services/telegram-mini-app-buttons.js";
import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";

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
    name: "Telegram user id is read from parsed top-level user object",
    run: () => {
      const result = validate(
        makeValidInitData({
          user: JSON.stringify({
            first_name: '"id":123',
            id: 456,
            username: "real_user",
          }),
        }),
      );
      assert.equal(result.user.id, "456");
      assert.equal(result.user.firstName, '"id":123');
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
      await assertValidationError(
        () => validate(params.toString()),
        "missing_hash",
      );
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
      assert.equal(
        normalizeTelegramStartParam("event_event-123"),
        "event_event-123",
      );
      assert.equal(
        normalizeTelegramStartParam("e_cG9seW1hcmtldDpldmVudC0x"),
        "e_cG9seW1hcmtldDpldmVudC0x",
      );
      assert.equal(
        normalizeTelegramStartParam(
          "b_cG9seW1hcmtldDpldmVudC0xfHBvbHltYXJrZXQ6bWFya2V0LTF8WXwxMA",
        ),
        "b_cG9seW1hcmtldDpldmVudC0xfHBvbHltYXJrZXQ6bWFya2V0LTF8WXwxMA",
      );
      assert.equal(
        normalizeTelegramStartParam("m_cDpldmVudC0xfG1hcmtldC0xfFk"),
        "m_cDpldmVudC0xfG1hcmtldC0xfFk",
      );
      assert.equal(
        normalizeTelegramStartParam(
          "wt_cG9seWdvbnwweGEwMjJiYTBhNjhlMTFhNzgzNDgzODJmZjE2ODYwMTAxMmQ0ZDc3Zjg",
        ),
        "wt_cG9seWdvbnwweGEwMjJiYTBhNjhlMTFhNzgzNDgzODJmZjE2ODYwMTAxMmQ0ZDc3Zjg",
      );
      assert.equal(normalizeTelegramStartParam("https://example.com"), null);
      assert.equal(normalizeTelegramStartParam("event_../admin"), null);
      assert.equal(normalizeTelegramStartParam(`e_${"x".repeat(511)}`), null);
      assert.equal(normalizeTelegramStartParam("unknown_value"), null);
    },
  },
  {
    name: "Hunch Telegram CTA builders never emit a raw website fallback",
    run: () => {
      assert.equal(
        buildHunchMiniAppWebButton({
          appBaseUrl: "https://app.hunch.trade",
          enabled: false,
          path: "/portfolio",
          text: "Open portfolio",
        }),
        null,
      );
      assert.equal(
        buildHunchMiniAppDeepLinkButton({
          miniAppLinkBase: null,
          startParam: "m_test",
          text: "Open market",
        }),
        null,
      );
      assert.equal(
        buildHunchMiniAppDeepLinkButton({
          miniAppLinkBase: "https://app.hunch.trade/tg",
          startParam: "m_test",
          text: "Open market",
        }),
        null,
      );
      const privateButton = buildHunchMiniAppWebButton({
        appBaseUrl: "https://app.hunch.trade",
        enabled: true,
        path: "/portfolio",
        text: "Open portfolio",
      });
      assert.ok(privateButton && "web_app" in privateButton);
      assert.equal(privateButton && "url" in privateButton, false);
      assert.equal(
        privateButton?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.hunch.id,
      );

      const publicButton = buildHunchMiniAppDeepLinkButton({
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        startParam: "m_test",
        text: "Open market",
      });
      assert.ok(publicButton && "url" in publicButton);
      assert.equal(
        publicButton?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.hunch.id,
      );
      assert.match(
        publicButton && "url" in publicButton ? publicButton.url : "",
        /^https:\/\/t\.me\//,
      );
    },
  },
  {
    name: "telegram context route handles disabled and unconfigured states",
    run: async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnabled = process.env.HUNCH_TELEGRAM_MINI_APP_ENABLED;
      const originalToken = process.env.HUNCH_TELEGRAM_BOT_TOKEN;
      process.env.NODE_ENV = "test";
      process.env.HUNCH_TELEGRAM_MINI_APP_ENABLED = "true";
      delete process.env.HUNCH_TELEGRAM_BOT_TOKEN;

      const { telegramRoutes } = await import("./routes/telegram.js");
      const { env } = await import("./env.js");
      const mutableEnv = env as typeof env & {
        telegramMiniAppEnabled: boolean;
      };
      const originalEnvTelegramMiniAppEnabled =
        mutableEnv.telegramMiniAppEnabled;
      mutableEnv.telegramMiniAppEnabled = true;
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(telegramRoutes);

      try {
        const response = await app.inject({
          method: "POST",
          url: "/telegram/context",
          payload: { initDataRaw: "auth_date=1&hash=00" },
        });

        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), {
          error: "telegram_mini_app_unconfigured",
        });

        mutableEnv.telegramMiniAppEnabled = false;
        const disabledApp = Fastify({ logger: false });
        disabledApp.setValidatorCompiler(validatorCompiler);
        disabledApp.setSerializerCompiler(serializerCompiler);
        await disabledApp.register(telegramRoutes);
        try {
          const disabledResponse = await disabledApp.inject({
            method: "POST",
            url: "/telegram/context",
            headers: { "content-type": "application/json" },
            payload: "{",
          });

          assert.equal(disabledResponse.statusCode, 404);
          assert.deepEqual(disabledResponse.json(), {
            error: "telegram_mini_app_disabled",
          });
        } finally {
          await disabledApp.close();
        }
      } finally {
        await app.close();
        mutableEnv.telegramMiniAppEnabled = originalEnvTelegramMiniAppEnabled;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalEnabled === undefined)
          delete process.env.HUNCH_TELEGRAM_MINI_APP_ENABLED;
        else process.env.HUNCH_TELEGRAM_MINI_APP_ENABLED = originalEnabled;
        if (originalToken === undefined)
          delete process.env.HUNCH_TELEGRAM_BOT_TOKEN;
        else process.env.HUNCH_TELEGRAM_BOT_TOKEN = originalToken;
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
    console.error(`[telegram-mini-app-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-mini-app-tests] passed ${passed}/${tests.length}`);
