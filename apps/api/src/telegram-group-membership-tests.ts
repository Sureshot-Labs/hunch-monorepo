#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  checkTelegramGroupMembership,
  normalizeTelegramChatMember,
  type TelegramGroupMembershipRedis,
} from "./services/telegram-group-membership.js";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const BOT_TOKEN = "8822816999:TEST_TOKEN";
const CHAT_ID = "-1003910565409";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

class FakeRedis implements TelegramGroupMembershipRedis {
  readonly entries = new Map<string, string>();
  readonly writes: Array<{ key: string; ttl: number | undefined }> = [];

  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { EX?: number },
  ): Promise<void> {
    this.entries.set(key, value);
    this.writes.push({ key, ttl: options?.EX });
  }
}

function dbReturning(telegramUserId: string | null) {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      assert.deepEqual(params, ["hunch-user-1"]);
      return {
        rows: telegramUserId ? [{ telegram_user_id: telegramUserId }] : [],
      };
    },
  } as never;
}

function telegramResponse(input: {
  isMember?: boolean;
  status: string;
  userId?: number | string;
}): Response {
  return Response.json({
    ok: true,
    result: {
      is_member: input.isMember,
      status: input.status,
      user: { id: input.userId ?? 123456789 },
    },
  });
}

const tests: TestCase[] = [
  {
    name: "normalizes every Telegram member status without using username",
    run: () => {
      assert.equal(
        normalizeTelegramChatMember({ status: "creator" }),
        "member",
      );
      assert.equal(
        normalizeTelegramChatMember({ status: "administrator" }),
        "member",
      );
      assert.equal(normalizeTelegramChatMember({ status: "member" }), "member");
      assert.equal(
        normalizeTelegramChatMember({ status: "restricted", is_member: true }),
        "member",
      );
      assert.equal(
        normalizeTelegramChatMember({
          status: "restricted",
          is_member: false,
        }),
        "not_member",
      );
      assert.equal(normalizeTelegramChatMember({ status: "restricted" }), null);
      assert.equal(
        normalizeTelegramChatMember({ status: "left" }),
        "not_member",
      );
      assert.equal(
        normalizeTelegramChatMember({ status: "kicked" }),
        "not_member",
      );
      assert.equal(normalizeTelegramChatMember({ status: "unknown" }), null);
    },
  },
  {
    name: "returns telegram_not_linked without calling Telegram",
    run: async () => {
      let fetchCalled = false;
      const result = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning(null),
        expectedBotId: "8822816999",
        fetchImpl: (async () => {
          fetchCalled = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
        now: () => NOW,
        userId: "hunch-user-1",
      });

      assert.deepEqual(result, {
        cached: false,
        checkedAt: NOW.toISOString(),
        state: "telegram_not_linked",
      });
      assert.equal(fetchCalled, false);
    },
  },
  {
    name: "checks member by linked Telegram id and caches the result",
    run: async () => {
      const redis = new FakeRedis();
      let requestUrl = "";
      let requestBody: unknown = null;
      let fetchCalls = 0;
      const fetchImpl = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        fetchCalls += 1;
        requestUrl = String(url);
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return telegramResponse({ status: "member" });
      }) as typeof fetch;

      const first = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl,
        now: () => NOW,
        redis,
        userId: "hunch-user-1",
      });

      assert.deepEqual(first, {
        cached: false,
        checkedAt: NOW.toISOString(),
        state: "member",
      });
      assert.equal(
        requestUrl,
        `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`,
      );
      assert.deepEqual(requestBody, {
        chat_id: CHAT_ID,
        user_id: 123456789,
      });
      assert.equal(redis.writes.length, 1);
      assert.equal(redis.writes[0]?.ttl, 60);

      const second = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl,
        now: () => new Date("2026-07-17T12:00:30.000Z"),
        redis,
        userId: "hunch-user-1",
      });
      assert.deepEqual(second, {
        cached: true,
        checkedAt: NOW.toISOString(),
        state: "member",
      });
      assert.equal(fetchCalls, 1);
    },
  },
  {
    name: "returns not_member for a restricted user who left the group",
    run: async () => {
      const result = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl: (async () =>
          telegramResponse({
            status: "restricted",
            isMember: false,
          })) as typeof fetch,
        now: () => NOW,
        userId: "hunch-user-1",
      });
      assert.equal(result.state, "not_member");
    },
  },
  {
    name: "rejects a token belonging to a different bot",
    run: async () => {
      let fetchCalled = false;
      const result = await checkTelegramGroupMembership({
        botToken: "1111111111:WRONG_BOT",
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl: (async () => {
          fetchCalled = true;
          return telegramResponse({ status: "member" });
        }) as typeof fetch,
        now: () => NOW,
        userId: "hunch-user-1",
      });
      assert.equal(result.state, "unavailable");
      assert.equal(result.unavailableReason, "invalid_configuration");
      assert.equal(fetchCalled, false);
    },
  },
  {
    name: "does not trust a Telegram response for another user",
    run: async () => {
      const result = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl: (async () =>
          telegramResponse({
            status: "member",
            userId: 987654321,
          })) as typeof fetch,
        now: () => NOW,
        userId: "hunch-user-1",
      });
      assert.equal(result.state, "unavailable");
      assert.equal(result.unavailableReason, "telegram_response_mismatch");
    },
  },
  {
    name: "keeps Telegram API failures separate from not_member",
    run: async () => {
      const result = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl: (async () =>
          Response.json(
            { ok: false, description: "Bad Request: chat not found" },
            { status: 400 },
          )) as typeof fetch,
        now: () => NOW,
        userId: "hunch-user-1",
      });
      assert.equal(result.state, "unavailable");
      assert.equal(result.unavailableReason, "telegram_api_error");
    },
  },
  {
    name: "classifies an aborted Telegram request as a timeout",
    run: async () => {
      const result = await checkTelegramGroupMembership({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        db: dbReturning("123456789"),
        expectedBotId: "8822816999",
        fetchImpl: ((_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          })) as typeof fetch,
        now: () => NOW,
        requestTimeoutMs: 1,
        userId: "hunch-user-1",
      });
      assert.equal(result.state, "unavailable");
      assert.equal(result.unavailableReason, "telegram_timeout");
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-group-membership-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(
  `[telegram-group-membership-tests] passed ${passed}/${tests.length}`,
);
