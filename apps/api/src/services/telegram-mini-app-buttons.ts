import {
  buildSignalBotMiniAppUrl,
  buildSignalBotTelegramWebAppUrl,
} from "./signal-bot-mini-app-links.js";

export type TelegramHunchMiniAppButton =
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

export function buildHunchMiniAppWebButton(input: {
  appBaseUrl: string;
  enabled: boolean;
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
  return url ? { text: input.text, web_app: { url } } : null;
}

export function buildHunchMiniAppDeepLinkButton(input: {
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
      ? { text: input.text, url: parsed.toString() }
      : null;
  } catch {
    return null;
  }
}
