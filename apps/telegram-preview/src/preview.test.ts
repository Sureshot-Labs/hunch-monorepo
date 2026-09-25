import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authorizedUser, PreviewBot } from "./bot.js";
import { ALLOWED_USER_IDS, previewWebAppUrl } from "./config.js";
import { TelegramClient, TelegramError } from "./telegram.js";
import type { Catalog, Message, Telegram, Update } from "./types.js";

const catalog = JSON.parse(
  readFileSync(new URL("../snapshots/screens.json", import.meta.url), "utf8"),
) as Catalog;
const user = 8418940574;
function message(text: string, id = user): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id },
      chat: { id, type: "private" },
      text,
    },
  };
}

class FakeTelegram implements Telegram {
  calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  current = new Map<string, Message & { message_id: number }>();
  error?: Error;
  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, payload: structuredClone(payload) });
    if (this.error && method !== "answerCallbackQuery") {
      const error = this.error;
      this.error = undefined;
      throw error;
    }
    const message_id = Number(payload.message_id ?? this.calls.length);
    if (method !== "answerCallbackQuery")
      this.current.set(String(payload.chat_id), {
        ...(payload as Message),
        message_id,
      });
    return { message_id } as T;
  }
}

function setup(webAppUrl?: string) {
  const api = new FakeTelegram();
  return { api, bot: new PreviewBot(catalog, api, webAppUrl) };
}

function callback(api: FakeTelegram, label: string, id = user): Update {
  const current = api.current.get(String(id));
  assert.ok(current);
  const button = current.reply_markup?.inline_keyboard
    .flat()
    .find((b) => b.text === label);
  assert.ok(button?.callback_data, `Missing ${label}`);
  return {
    update_id: 2,
    callback_query: {
      id: "click",
      from: { id },
      data: button.callback_data,
      message: {
        message_id: current.message_id,
        chat: { id, type: "private" },
      },
    },
  };
}

async function openScreen(
  bot: PreviewBot,
  api: FakeTelegram,
  id: string,
  userId = user,
) {
  const screen = catalog.screens.find((s) => s.id === id);
  assert.ok(screen);
  await bot.handle(message("/scenarios", userId));
  await bot.handle(callback(api, screen.group, userId));
  await bot.handle(callback(api, screen.title, userId));
}

test("exact allowlist, including IDs larger than 32 bits", () => {
  assert.deepEqual(
    [...ALLOWED_USER_IDS],
    [
      "1413356895",
      "328573687",
      "949308286",
      "8418940574",
      "5766496728",
      "780532781",
      "1489504208",
      "7005668881",
    ],
  );
  for (const id of ALLOWED_USER_IDS)
    assert.equal(authorizedUser(message("/start", Number(id))), id);
});

test("outsiders, forged chat IDs, groups and unsupported updates produce no API calls", async () => {
  const { bot, api } = setup();
  const outsider = message("/start", 123);
  const forged = message("/start", 123);
  if (forged.message) forged.message.chat.id = user;
  const group = message("/start");
  if (group.message) group.message.chat = { id: -123, type: "supergroup" };
  const updates: Update[] = [
    outsider,
    forged,
    group,
    { update_id: 5 },
    {
      update_id: 6,
      callback_query: {
        id: "x",
        from: { id: 123 },
        data: "pv:1:0",
        message: { message_id: 2, chat: { id: user, type: "private" } },
      },
    },
    {
      update_id: 7,
      callback_query: {
        id: "x",
        from: { id: user },
        data: "pv:1:0",
        message: { message_id: 2, chat: { id: -123, type: "group" } },
      },
    },
    {
      update_id: 8,
      callback_query: { id: "x", from: { id: user }, data: "pv:1:0" },
    },
  ];
  for (const update of updates) await bot.handle(update);
  assert.equal(api.calls.length, 0);
});

test("old, forged and cross-user callbacks cannot navigate", async () => {
  const { bot, api } = setup();
  await bot.handle(message("/start"));
  const first = callback(api, "🔎 Markets");
  await bot.handle(first);
  const before = api.calls.length;
  await bot.handle(first);
  assert.equal(api.calls.length, before + 1);
  assert.equal(api.calls.at(-1)?.method, "answerCallbackQuery");
  assert.equal(api.calls.at(-1)?.payload.show_alert, true);
  const forged = callback(api, "🏠 Home");
  assert.ok(forged.callback_query);
  forged.callback_query.data = "hbt:confirm:production-intent";
  await bot.handle(forged);
  assert.equal(api.calls.at(-1)?.method, "answerCallbackQuery");
  forged.callback_query.data = "pv:2:99999";
  await bot.handle(forged);
  assert.equal(api.calls.at(-1)?.method, "answerCallbackQuery");
  const n = api.calls.length;
  forged.callback_query.from.id = 1413356895;
  await bot.handle(forged);
  assert.equal(api.calls.length, n);
});

test("Buy/Sell navigation, custom NO input and colors preserve the real keyboard", async () => {
  const { bot, api } = setup();
  await openScreen(bot, api, "market");
  let current = api.current.get(String(user));
  assert.equal(
    current?.reply_markup?.inline_keyboard
      .flat()
      .find((b) => b.text === "50% · NO")?.style,
    "danger",
  );
  await bot.handle(callback(api, "50% · NO"));
  assert.match(api.current.get(String(user))?.text ?? "", /Confirm sell/);
  assert.match(api.current.get(String(user))?.text ?? "", /Side:\* NO/);
  assert.equal(
    api.current.get(String(user))?.reply_markup?.inline_keyboard[0]?.[0]?.style,
    "danger",
  );
  await bot.handle(message("/colors"));
  current = api.current.get(String(user));
  assert.ok(
    current?.reply_markup?.inline_keyboard
      .flat()
      .every((b) => b.style === undefined),
  );
  await bot.handle(message("/colors"));
  assert.equal(
    api.current.get(String(user))?.reply_markup?.inline_keyboard[0]?.[0]?.style,
    "danger",
  );
  await bot.handle(callback(api, "Change amount"));
  await bot.handle(callback(api, "Custom Sell · NO"));
  assert.match(api.current.get(String(user))?.text ?? "", /Custom sell/);
  await bot.handle(message("50%"));
  assert.match(api.current.get(String(user))?.text ?? "", /Side:\* NO/);
  await bot.handle(callback(api, "⬅️ Back"));
  await bot.handle(callback(api, "Custom Buy · NO"));
  assert.match(api.current.get(String(user))?.text ?? "", /Custom buy/);
  await bot.handle(message("25"));
  assert.match(api.current.get(String(user))?.text ?? "", /Side:\* NO/);
});

test("users have independent screens and color preferences", async () => {
  const { bot, api } = setup();
  await bot.handle(message("/start"));
  await bot.handle(message("/colors"));
  await bot.handle(message("/start", 1413356895));
  assert.equal(
    api.current
      .get("1413356895")
      ?.reply_markup?.inline_keyboard.flat()
      .find((b) => b.text === "Open Hunch Mini App")?.style,
    "primary",
  );
  assert.equal(
    api.current
      .get(String(user))
      ?.reply_markup?.inline_keyboard.flat()
      .find((b) => b.text === "Open Hunch Mini App")?.style,
    undefined,
  );
});

test("Mini App keeps its native type with a demo URL, with no source bot destinations", async () => {
  const { bot, api } = setup("https://demo.example/preview");
  await bot.handle(message("/start"));
  const button = api.current
    .get(String(user))
    ?.reply_markup?.inline_keyboard.flat()
    .find((b) => b.web_app);
  assert.ok(button?.web_app);
  const url = new URL(button.web_app.url);
  assert.equal(url.origin, "https://demo.example");
  assert.equal(url.searchParams.get("screen"), "home");
  assert.ok(!button.callback_data);
  await openScreen(bot, api, "rewards");
  assert.doesNotMatch(
    api.current.get(String(user))?.text ?? "",
    /\]\(https:\/\/t\.me\//,
  );
  const link = api.current
    .get(String(user))
    ?.reply_markup?.inline_keyboard.flat()
    .find((b) => b.url);
  assert.equal(new URL(link?.url ?? "").origin, "https://demo.example");
  for (const invalid of [
    "http://localhost:8787",
    "https://app.hunch.trade",
    "https://hunch.trade",
    "https://t.me/prod",
    "https://user:secret@demo.example",
  ])
    assert.throws(() => previewWebAppUrl(invalid));
});

test("no Mini App URL gives an explanation without opening production", async () => {
  const { bot, api } = setup();
  await bot.handle(message("/start"));
  await bot.handle(callback(api, "Open Hunch Mini App"));
  assert.match(
    String(api.calls.at(-1)?.payload.text),
    /TELEGRAM_PREVIEW_WEB_APP_URL/,
  );
});

test("custom emoji rejection retries once with the production fallback and preserves colors", async () => {
  const { bot, api } = setup();
  await openScreen(bot, api, "market");
  api.error = new TelegramError(400, "Bad Request: BUTTON_TYPE_INVALID");
  await bot.handle(callback(api, "50% · NO"));
  const current = api.current.get(String(user));
  assert.ok(
    current?.reply_markup?.inline_keyboard
      .flat()
      .every((b) => b.icon_custom_emoji_id === undefined),
  );
  assert.equal(current?.reply_markup?.inline_keyboard[0]?.[0]?.style, "danger");
});

test("failed rendering is not blindly resent and the previous menu remains usable", async () => {
  const { bot, api } = setup();
  await bot.handle(message("/start"));
  const click = callback(api, "🔎 Markets");
  api.error = new Error("timeout");
  const start = api.calls.length;
  await assert.rejects(bot.handle(click), /timeout/);
  assert.equal(api.calls.length, start + 2); // acknowledgement and one mutation
  await bot.handle(click);
  assert.match(api.current.get(String(user))?.text ?? "", /Send a market/);
});

test("every snapshot is reachable; all buttons route locally and stay within Telegram limits", async () => {
  const { bot, api } = setup("https://demo.example/preview");
  for (const screen of catalog.screens) {
    assert.ok(screen.message.text.length <= 4096, screen.id);
    await openScreen(bot, api, screen.id);
    const payload = api.calls.at(-1)?.payload;
    assert.ok(payload);
    for (const row of (payload.reply_markup as Message["reply_markup"])
      ?.inline_keyboard ?? []) {
      assert.ok(row.length <= 8);
      for (const button of row) {
        const types = [
          button.callback_data,
          button.url,
          button.web_app,
          button.copy_text,
        ].filter(Boolean);
        assert.equal(types.length, 1, screen.id);
        if (button.callback_data)
          assert.ok(Buffer.byteLength(button.callback_data) <= 64);
        if (button.url || button.web_app)
          assert.equal(
            new URL(button.url ?? button.web_app?.url ?? "").origin,
            "https://demo.example",
          );
      }
    }
    for (const button of screen.message.reply_markup?.inline_keyboard.flat() ??
      []) {
      if (button.callback_data)
        assert.ok(
          bot.screens.has(screen.routes[button.callback_data] ?? ""),
          `${screen.id}: ${button.callback_data}`,
        );
    }
  }
});

test("transport errors do not expose the token or fetch cause", async (t) => {
  const token = "123:secret";
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(`https://api.telegram.org/bot${token}/getMe`);
  });
  const client = new TelegramClient(token, new AbortController().signal);
  await assert.rejects(
    client.call("getMe", {}),
    (error: Error) => !error.message.includes(token) && !error.cause,
  );
});

test("confirmation keeps the selected side and amount in its static result", async () => {
  const { bot, api } = setup();
  await openScreen(bot, api, "buy_NO_50");
  const label = api.current.get(String(user))?.reply_markup
    ?.inline_keyboard[0]?.[0]?.text;
  assert.ok(label);
  await bot.handle(callback(api, label));
  const result = api.current.get(String(user))?.text ?? "";
  assert.match(result, /Trade filled/);
  assert.match(result, /Side:\* NO/);
  assert.match(result, /\$50/);
});

test("QR uses a photo, an invalid demo address and can return to its route", async () => {
  const { bot, api } = setup();
  await openScreen(bot, api, "fund_waiting_ld");
  await bot.handle(callback(api, "🔳 Show QR"));
  assert.equal(api.calls.at(-1)?.method, "sendPhoto");
  assert.match(
    String(api.calls.at(-1)?.payload.caption),
    /DEMO-ADDRESS-DO-NOT-SEND/,
  );
  await bot.handle(callback(api, "🙈 Hide"));
  assert.equal(api.calls.at(-1)?.method, "sendMessage");
  assert.match(api.current.get(String(user))?.text ?? "", /Base/);
});

test("photo transport sends multipart PNG, caption and keyboard", async (t) => {
  const screen = catalog.screens.find((s) => s.id === "fund_qr_pd");
  assert.ok(screen?.message.photo);
  let form: FormData | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      assert.ok(options.body instanceof FormData);
      form = options.body;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
      );
    },
  );
  const client = new TelegramClient("123:test", new AbortController().signal);
  await client.call("sendPhoto", {
    photo: screen.message.photo,
    caption: screen.message.text,
    parse_mode: "MarkdownV2",
    reply_markup: screen.message.reply_markup,
    chat_id: String(user),
  });
  assert.ok(form);
  const photo = form.get("photo");
  assert.ok(photo instanceof Blob);
  assert.equal(
    Buffer.from(await photo.arrayBuffer())
      .subarray(1, 4)
      .toString(),
    "PNG",
  );
  assert.match(String(form.get("caption")), /DEMO-ADDRESS-DO-NOT-SEND/);
  assert.equal(
    JSON.parse(String(form.get("reply_markup"))).inline_keyboard[0][0].text,
    "🙈 Hide",
  );
});
