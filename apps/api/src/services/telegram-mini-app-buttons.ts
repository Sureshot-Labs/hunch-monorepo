import type { TelegramButtonAppearance } from "./telegram-button-style.js";
import {
  buildSignalBotMiniAppUrl,
  buildSignalBotTelegramWebAppUrl,
} from "./signal-bot-mini-app-links.js";
import { telegramCustomEmojiId } from "./telegram-custom-emoji.js";

export type TelegramHunchMiniAppButton = (
  | { text: string; url: string }
  | { text: string; web_app: { url: string } }
) &
  TelegramButtonAppearance;

/** Mini App navigation is blue. web_app is private-chat only; groups use deep links. */
export function buildHunchMiniAppChatButton(input: {
  appBaseUrl: string;
  chatType?: string | null;
  iconCustomEmojiId?: string;
  miniAppLinkBase?: string | null;
  startParam: string | null | undefined;
  text: string;
}): TelegramHunchMiniAppButton | null {
  const button = {
    customEmojiEnabled: input.chatType !== "channel",
    iconCustomEmojiId: input.iconCustomEmojiId,
    startParam: input.startParam,
    text: input.text,
  };
  return input.miniAppLinkBase &&
    input.chatType === "private" &&
    input.startParam
    ? buildHunchMiniAppWebButton({
        ...button,
        appBaseUrl: input.appBaseUrl,
        enabled: true,
      })
    : buildHunchMiniAppDeepLinkButton({
        ...button,
        miniAppLinkBase: input.miniAppLinkBase,
      });
}

export function buildHunchMiniAppWebButton(input: {
  appBaseUrl: string;
  customEmojiEnabled?: boolean;
  enabled: boolean;
  iconCustomEmojiId?: string;
  path?: string;
  startParam?: string | null;
  text: string;
}): TelegramHunchMiniAppButton | null {
  if (!input.enabled) return null;
  const url = input.startParam
    ? buildSignalBotTelegramWebAppUrl({
        appBaseUrl: input.appBaseUrl,
        startParam: input.startParam,
      })
    : (() => {
        try {
          return new URL(input.path ?? "/tg", input.appBaseUrl).toString();
        } catch {
          return null;
        }
      })();
  return url
    ? {
        ...(input.customEmojiEnabled === false
          ? {}
          : {
              icon_custom_emoji_id:
                input.iconCustomEmojiId ?? telegramCustomEmojiId("hunch"),
            }),
        style: "primary",
        text: input.text,
        web_app: { url },
      }
    : null;
}

export function buildHunchMiniAppDeepLinkButton(input: {
  customEmojiEnabled?: boolean;
  iconCustomEmojiId?: string;
  miniAppLinkBase: string | null | undefined;
  startParam: string | null | undefined;
  text: string;
}): TelegramHunchMiniAppButton | null {
  const url = buildSignalBotMiniAppUrl({
    base: input.miniAppLinkBase,
    startParam: input.startParam ?? null,
  });
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "t.me"
      ? {
          ...(input.customEmojiEnabled === false
            ? {}
            : {
                icon_custom_emoji_id:
                  input.iconCustomEmojiId ?? telegramCustomEmojiId("hunch"),
              }),
          style: "primary",
          text: input.text,
          url: parsed.toString(),
        }
      : null;
  } catch {
    return null;
  }
}
