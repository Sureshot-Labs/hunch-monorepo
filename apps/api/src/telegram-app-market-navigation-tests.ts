import assert from "node:assert/strict";
import { test } from "node:test";
import type { DbQuery } from "./db.js";
import { buildTelegramAppMarketNavigation } from "./services/telegram-app-market-navigation.js";
import { isTelegramAppHandoffV2TradeVenue } from "./services/telegram-app-handoff-v2-contract.js";

const db: DbQuery = {
  query: async () => {
    throw new Error("Unexpected database access");
  },
};
const market = {
  id: "hyperliquid:mainnet:outcome:1473",
  event_id: "hyperliquid:mainnet:question:198",
  event_title: "Premier League · Winner",
  title: "Arsenal",
  venue: "hyperliquid",
  status: "ACTIVE",
};
const input = {
  db,
  marketRef: market.id,
  appBaseUrl: "https://app.hunch.test",
  telegramMiniAppEnabled: true,
};
const dependencies = {
  readPolicy: async () => ({
    policy: { enabled: true, environment: "mainnet" as const },
  }),
  readMarket: async () => market,
};

test("HIP navigation preserves environment, market and side without trade authority", async () => {
  for (const side of ["YES", "NO"] as const) {
    const message = await buildTelegramAppMarketNavigation(
      { ...input, side },
      dependencies,
    );
    assert.equal(message?.marketFound, true);
    const buttons = message?.reply_markup?.inline_keyboard.flat() ?? [];
    const button = buttons.find((button) => "web_app" in button);
    assert.ok(button && "web_app" in button);
    const url = new URL(button.web_app.url);
    assert.equal(url.pathname, "/tg");
    const start = url.searchParams.get("tgWebAppStartParam");
    assert.ok(start);
    assert.ok(start.startsWith("m_"));
    assert.equal(
      Buffer.from(start.slice(2), "base64url").toString(),
      `${market.event_id}|${market.id}|${side === "YES" ? "Y" : "N"}`,
    );
    assert.equal(button.text, "Open market in Hunch");
    assert.equal(isTelegramAppHandoffV2TradeVenue("hyperliquid"), false);
    assert.deepEqual(
      buttons
        .filter((button) => "callback_data" in button)
        .map((button) =>
          "callback_data" in button ? button.callback_data : "",
        ),
      ["hm:v1:home"],
    );
  }
});

test("HIP app review uses the common buy link without choosing an unfocused side or issuing bot callbacks", async () => {
  for (const focusedSide of [undefined, "YES", "NO"] as const) {
    const message = await buildTelegramAppMarketNavigation(
      { ...input, side: focusedSide },
      dependencies,
    );
    const reviews =
      message?.reply_markup?.inline_keyboard
        .flat()
        .filter((button) => button.text.startsWith("Review ")) ?? [];
    const sides = focusedSide ? [focusedSide] : ["YES", "NO"];
    assert.equal(reviews.length, sides.length);
    for (const [index, review] of reviews.entries()) {
      assert.ok("web_app" in review);
      const start = new URL(review.web_app.url).searchParams.get(
        "tgWebAppStartParam",
      );
      assert.ok(start);
      assert.ok(start.startsWith("b_"));
      assert.equal(
        Buffer.from(start.slice(2), "base64url").toString(),
        `${market.event_id}|${market.id}|${sides[index] === "YES" ? "Y" : "N"}|`,
      );
      assert.equal("callback_data" in review, false);
    }
  }
  for (const status of ["CLOSED", "RESOLVED", "PROPOSED"]) {
    const message = await buildTelegramAppMarketNavigation(input, {
      ...dependencies,
      readMarket: async () => ({ ...market, status }),
    });
    assert.equal(message?.marketFound, true);
    const buttons = message?.reply_markup?.inline_keyboard.flat() ?? [];
    assert.equal(
      buttons.some((button) => button.text.startsWith("Review ")),
      false,
    );
    assert.equal(
      buttons.some((button) => button.text === "Open market in Hunch"),
      true,
    );
  }
});

test("HIP navigation checks current public policy before reading stored data", async () => {
  for (const policy of [
    { enabled: false, environment: "mainnet" as const },
    { enabled: true, environment: "testnet" as const },
  ]) {
    const message = await buildTelegramAppMarketNavigation(input, {
      readPolicy: async () => ({ policy }),
      readMarket: async () => {
        throw new Error("Disabled market must not be read");
      },
    });
    assert.equal(message?.marketFound, false);
    assert.equal(message?.reply_markup, undefined);
  }
  await assert.rejects(
    buildTelegramAppMarketNavigation(input, {
      readPolicy: async () => {
        throw new Error("Policy unavailable");
      },
    }),
    /Policy unavailable/,
  );
  assert.equal(
    (await buildTelegramAppMarketNavigation(input, dependencies))?.marketFound,
    true,
  );
});

test("app review displays native outcome labels but keeps canonical side in the link", async () => {
  const message = await buildTelegramAppMarketNavigation(input, {
    ...dependencies,
    readMarket: async () => ({
      ...market,
      outcomes: JSON.stringify(["Up", "Down"]),
    }),
  });
  const reviews =
    message?.reply_markup?.inline_keyboard
      .flat()
      .filter((button) => button.text.startsWith("Review ")) ?? [];
  assert.deepEqual(
    reviews.map((button) => button.text),
    ["Review Up in Hunch", "Review Down in Hunch"],
  );
  const down = reviews[1];
  assert.ok(down && "web_app" in down);
  const start = new URL(down.web_app.url).searchParams.get(
    "tgWebAppStartParam",
  );
  assert.ok(start);
  assert.equal(
    Buffer.from(start.slice(2), "base64url").toString(),
    `${market.event_id}|${market.id}|N|`,
  );
});

test("HIP navigation rejects wrong stored identity and leaves other venues untouched", async () => {
  for (const row of [
    null,
    { ...market, venue: "polymarket" },
    { ...market, id: "hyperliquid:mainnet:outcome:1" },
    { ...market, event_id: "hyperliquid:testnet:question:198" },
  ]) {
    assert.equal(
      (
        await buildTelegramAppMarketNavigation(input, {
          ...dependencies,
          readMarket: async () => row,
        })
      )?.marketFound,
      false,
    );
  }
  for (const marketRef of ["polymarket:123", "limitless:123", "kalshi:123"]) {
    assert.equal(
      await buildTelegramAppMarketNavigation({ ...input, marketRef }),
      null,
    );
  }
  assert.equal(
    (
      await buildTelegramAppMarketNavigation({
        ...input,
        marketRef: "hyperliquid:mainnet:outcome:-1",
      })
    )?.marketFound,
    false,
  );
});

test("disabled Mini App does not produce a broken launch or a trade callback", async () => {
  const message = await buildTelegramAppMarketNavigation(
    {
      ...input,
      telegramMiniAppEnabled: false,
      returnCallbackData: "hm:v1:search_back:123456789abc:0",
    },
    dependencies,
  );
  assert.deepEqual(message?.reply_markup?.inline_keyboard, [
    [{ text: "⬅️ Back", callback_data: "hm:v1:search_back:123456789abc:0" }],
  ]);
});

test("pasted market URL retains its side and explicit context takes precedence", async () => {
  for (const [urlSide, contextSide, expected] of [
    ["NO", undefined, "N"],
    ["NO", "YES", "Y"],
    ["invalid", undefined, ""],
  ] as const) {
    const message = await buildTelegramAppMarketNavigation(
      {
        ...input,
        marketRef: `https://app.hunch.test/events/${market.event_id}?market=${market.id}&side=${urlSide}`,
        side: contextSide,
      },
      dependencies,
    );
    const button = message?.reply_markup?.inline_keyboard
      .flat()
      .find((button) => "web_app" in button);
    assert.ok(button && "web_app" in button);
    const start = new URL(button.web_app.url).searchParams.get(
      "tgWebAppStartParam",
    );
    assert.ok(start);
    assert.equal(
      Buffer.from(start.slice(2), "base64url").toString(),
      `${market.event_id}|${market.id}|${expected}`,
    );
  }
});
