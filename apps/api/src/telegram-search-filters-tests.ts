import assert from "node:assert/strict";
import {
  handleSignalBotInteractiveMenuCallback,
  parseSignalBotInteractiveMenuRoute,
} from "./services/telegram-bot-menu-actions.js";
import {
  writeSignalBotMarketSearchSession,
  readSignalBotMarketSearchSession,
  buildSignalBotMarketSearchScreen,
} from "./services/telegram-bot-menu-markets.js";

const values = new Map<string, string>();
const redis = {
  get: async (key: string) => values.get(key) ?? null,
  set: async (key: string, value: string) => {
    values.set(key, value);
  },
};
const sessionId = await writeSignalBotMarketSearchSession({
  redis,
  chatId: "1",
  telegramUserId: 1,
  query: "Fed",
  results: [],
});
let rendered:
  | Parameters<
      Parameters<typeof handleSignalBotInteractiveMenuCallback>[0]["render"]
    >[0]
  | undefined;
let searched = false;
await handleSignalBotInteractiveMenuCallback({
  redis,
  chatId: "1",
  telegramUserId: 1,
  messageId: 1,
  callbackPrefix: "menu:",
  route: { kind: "market_search_filters", sessionId, venue: "limitless" },
  render: async (message) => {
    rendered = message;
  },
  renderExpiredSearch: async () => {
    throw new Error("unexpected expiry");
  },
  searchMarkets: async (input) => {
    assert.equal(input.query, "Fed");
    assert.deepEqual(input.venues, ["limitless"]);
    searched = true;
    return [];
  },
});
assert.equal(searched, true);
assert.ok(
  rendered?.reply_markup?.inline_keyboard
    .flat()
    .some((button) => button.text === "⚙️ Filters (🟡)"),
);
assert.equal(
  await readSignalBotMarketSearchSession({
    redis,
    chatId: "2",
    telegramUserId: 1,
    sessionId,
  }),
  null,
);
assert.deepEqual(
  parseSignalBotInteractiveMenuRoute(`search_filters:${sessionId}:all`),
  { kind: "market_search_filters", sessionId, venue: "all" },
);
assert.equal(
  parseSignalBotInteractiveMenuRoute(`search_filters:${sessionId}:unknown`),
  null,
);
const screen = buildSignalBotMarketSearchScreen({
  callbackPrefix: "menu:",
  query: "Fed",
  results: [],
  sessionId,
});
assert.ok(
  screen.reply_markup.inline_keyboard
    .flat()
    .some((button) => button.text === "⚙️ Filters (All)"),
);
await handleSignalBotInteractiveMenuCallback({
  redis,
  chatId: "1",
  telegramUserId: 1,
  messageId: 1,
  callbackPrefix: "menu:",
  route: { kind: "market_search_filters", sessionId },
  searchOptions: async () => ({ venues: ["polymarket", "limitless"] }),
  render: async (message) => {
    // The real menu transport defaults to MarkdownV2; raw punctuation makes
    // Telegram reject this screen even when the callback and API succeed.
    assert.equal(/(?<!\\)[.!]/u.test(message.text), false);
    rendered = message;
  },
  renderExpiredSearch: async () => {
    throw new Error("expired");
  },
});
assert.ok(
  !rendered?.reply_markup?.inline_keyboard
    .flat()
    .some((button) => button.text.includes("Kalshi")),
);
for (const [choice, category, sort] of [
  ["c_crypto", "crypto", "trending"],
  ["s_time", undefined, "time"],
  ["all", undefined, "trending"],
] as const) {
  await handleSignalBotInteractiveMenuCallback({
    redis,
    chatId: "1",
    telegramUserId: 1,
    messageId: 1,
    callbackPrefix: "menu:",
    route: { kind: "market_search_filters", sessionId, venue: choice },
    render: async () => {},
    renderExpiredSearch: async () => {
      throw new Error("expired");
    },
    searchMarkets: async (input) => {
      assert.equal(input.category, category);
      assert.equal(input.sort, sort);
      return [];
    },
  });
}
assert.ok(
  screen.reply_markup.inline_keyboard
    .flat()
    .some((button) => button.text === "↕️ Sort (Trending)"),
);
console.log("[telegram-search-filters-tests] passed");
