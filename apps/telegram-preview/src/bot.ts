import { ALLOWED_USER_IDS } from "./config.js";
import { TelegramError } from "./telegram.js";
import type {
  Button,
  Catalog,
  Message,
  Screen,
  Telegram,
  Update,
} from "./types.js";

type Session = {
  screen: string;
  colors: boolean;
  nativeEmoji: boolean;
  revision: number;
  messageId?: number;
  media?: boolean;
};

const INTRO =
  "🧪 Hunch Preview — static demo\n\nAll balances, markets and transactions here are fictional. Buttons only switch demo screens. No money is moved.\n\n/scenarios — all screens\n/colors — toggle button colors\n/reset — return home";

export function authorizedUser(update: Update): string | null {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  const sender = callback?.from ?? message?.from;
  if (
    !sender ||
    sender.is_bot ||
    !message ||
    message.chat.type !== "private" ||
    message.chat.id !== sender.id ||
    !Number.isSafeInteger(sender.id) ||
    !ALLOWED_USER_IDS.has(String(sender.id))
  )
    return null;
  return String(sender.id);
}

function demoUrl(base: string, screen: string, original: string): string {
  const url = new URL(base);
  url.searchParams.set("screen", screen);
  url.searchParams.set("target", original);
  return url.href;
}

export class PreviewBot {
  private readonly sessions = new Map<string, Session>();
  readonly screens: Map<string, Screen>;

  constructor(
    catalog: Catalog,
    private readonly telegram: Telegram,
    private readonly webAppUrl?: string,
  ) {
    if (catalog.version !== 1) throw new Error("Unsupported snapshot version.");
    this.screens = new Map(
      catalog.screens.map((screen) => [screen.id, screen]),
    );
    if (!this.screens.has("home")) throw new Error("Home snapshot is missing.");
    const groups = [...new Set(catalog.screens.map((screen) => screen.group))];
    for (const [index, group] of groups.entries()) {
      const rows = catalog.screens
        .filter((screen) => screen.group === group)
        .map((screen) => [
          { text: screen.title, callback_data: `open:${screen.id}` },
        ]);
      const routes = Object.fromEntries(
        catalog.screens.map((s) => [`open:${s.id}`, s.id]),
      );
      rows.push([{ text: "⬅️ Scenarios", callback_data: "open:scenarios" }]);
      routes["open:scenarios"] = "scenarios";
      this.addScreen(`group_${index}`, group, rows, routes);
    }
    this.addScreen(
      "scenarios",
      "🧪 Demo scenarios",
      groups.map((group, index) => [
        { text: group, callback_data: `open:group_${index}` },
      ]),
      Object.fromEntries(
        groups.map((_, index) => [`open:group_${index}`, `group_${index}`]),
      ),
    );
  }

  private addScreen(
    id: string,
    title: string,
    rows: Button[][],
    routes: Record<string, string>,
  ) {
    const message = { text: title, reply_markup: { inline_keyboard: rows } };
    this.screens.set(id, {
      id,
      title,
      group: "Preview",
      message,
      fallback: message,
      routes,
    });
  }

  private session(user: string): Session {
    let session = this.sessions.get(user);
    if (!session) {
      session = {
        screen: "home",
        colors: true,
        nativeEmoji: true,
        revision: 0,
      };
      this.sessions.set(user, session);
    }
    return session;
  }

  private payload(screen: Screen, session: Session): Message {
    const original = session.nativeEmoji ? screen.message : screen.fallback;
    const message = structuredClone(original);
    message.text = message.text.replace(
      /https:\/\/t\.me\/preview_invalid_bot\/demo[^)\s]*/g,
      (url) =>
        this.webAppUrl
          ? demoUrl(this.webAppUrl, screen.id, url)
          : "https://preview.invalid/",
    );
    let index = 0;
    message.reply_markup?.inline_keyboard.forEach((row) =>
      row.forEach((button) => {
        const callback = `pv:${session.revision}:${index++}`;
        if (!session.colors) delete button.style;
        if (button.callback_data) button.callback_data = callback;
        if (button.web_app) {
          if (this.webAppUrl)
            button.web_app.url = demoUrl(
              this.webAppUrl,
              screen.id,
              button.web_app.url,
            );
          else {
            delete button.web_app;
            button.callback_data = callback;
          }
        }
        if (button.url) {
          // No source bot links, sharing links or production destinations escape.
          if (this.webAppUrl)
            button.url = demoUrl(this.webAppUrl, screen.id, button.url);
          else {
            delete button.url;
            button.callback_data = callback;
          }
        }
      }),
    );
    return message;
  }

  private async render(
    user: string,
    session: Session,
    destination: string,
    fresh = false,
  ) {
    const screen = this.screens.get(destination);
    if (!screen) throw new Error(`Unknown demo screen: ${destination}`);
    const previous = { ...session };
    session.screen = destination;
    session.revision += 1;
    const send = async () => {
      const { rich_message, photo, text, parse_mode, reply_markup } =
        this.payload(screen, session);
      const edit =
        !fresh &&
        session.messageId !== undefined &&
        !session.media &&
        !rich_message &&
        !photo;
      const method = photo
        ? "sendPhoto"
        : rich_message
          ? "sendRichMessage"
          : edit
            ? "editMessageText"
            : "sendMessage";
      const result = await this.telegram.call<{ message_id: number }>(method, {
        chat_id: user,
        ...(edit ? { message_id: session.messageId } : {}),
        ...(photo
          ? { photo, caption: text, parse_mode }
          : rich_message
            ? { rich_message }
            : { text, ...(parse_mode ? { parse_mode } : {}) }),
        ...(reply_markup ? { reply_markup } : {}),
        ...(!edit ? { protect_content: true } : {}),
        ...(!rich_message && !photo
          ? { link_preview_options: { is_disabled: true } }
          : {}),
      });
      session.messageId = result.message_id;
      session.media = Boolean(rich_message || photo);
    };
    try {
      try {
        await send();
      } catch (error) {
        if (
          error instanceof TelegramError &&
          error.code === 400 &&
          /emoji|premium|button_type_invalid/i.test(error.description) &&
          session.nativeEmoji
        ) {
          session.nativeEmoji = false;
          await send();
        } else throw error;
      }
    } catch (error) {
      Object.assign(session, previous);
      throw error;
    }
  }

  async handle(update: Update): Promise<void> {
    const user = authorizedUser(update);
    if (!user) return;
    const session = this.session(user);
    const callback = update.callback_query;
    if (callback) {
      const match = /^pv:(\d+):(\d+)$/.exec(callback.data ?? "");
      const screen = this.screens.get(session.screen);
      const button =
        screen?.message.reply_markup?.inline_keyboard.flat()[
          Number(match?.[2])
        ];
      if (
        !match ||
        Number(match[1]) !== session.revision ||
        callback.message?.message_id !== session.messageId ||
        !button
      ) {
        await this.telegram.call("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "This menu is outdated. Send /start.",
          show_alert: true,
        });
        return;
      }
      const destination = button.callback_data
        ? screen?.routes[button.callback_data]
        : undefined;
      const notice =
        button.web_app || button.url
          ? "Set TELEGRAM_PREVIEW_WEB_APP_URL to an HTTPS demo page to preview this button."
          : destination
            ? undefined
            : "Static demo. Use /scenarios to choose another state.";
      await this.telegram.call("answerCallbackQuery", {
        callback_query_id: callback.id,
        ...(notice ? { text: notice, show_alert: true } : {}),
      });
      if (destination) await this.render(user, session, destination);
      return;
    }
    const text = update.message?.text?.trim();
    if (!text) return;
    const command = text.split(/\s/, 1)[0]?.split("@", 1)[0]?.toLowerCase();
    if (command === "/start" || command === "/help") {
      await this.telegram.call("sendMessage", {
        chat_id: user,
        text: INTRO,
        protect_content: true,
      });
      await this.render(user, session, "home", true);
    } else if (command === "/reset") {
      session.colors = true;
      await this.render(user, session, "home", true);
    } else if (command === "/scenarios") {
      await this.render(user, session, "scenarios", true);
    } else if (command === "/colors") {
      session.colors = !session.colors;
      await this.render(user, session, session.screen);
    } else if (
      !text.startsWith("/") &&
      this.screens.get(session.screen)?.input
    ) {
      const destination = this.screens.get(session.screen)?.input;
      if (destination) await this.render(user, session, destination);
    } else {
      await this.telegram.call("sendMessage", {
        chat_id: user,
        text: "Static preview: /start · /scenarios · /colors · /reset",
        protect_content: true,
      });
    }
  }
}
