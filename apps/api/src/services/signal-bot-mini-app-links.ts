const TELEGRAM_STARTAPP_MAX_LENGTH = 512;
export const SIGNAL_BOT_TELEGRAM_WEB_APP_ENTRY_PATH = "/tg";
const TELEGRAM_WEB_APP_START_PARAM_QUERY = "tgWebAppStartParam";
const SIGNAL_BOT_ROUTE_ID_RE = /^[A-Za-z0-9:_-]{1,160}$/;
const SIGNAL_BOT_SAFE_ROUTE_ID_RE = /^[A-Za-z0-9_-]{1,58}$/;
const SIGNAL_BOT_WALLET_ADDRESS_RE = /^[A-Za-z0-9]{3,64}$/;
const SIGNAL_BOT_CHAIN_RE = /^[a-z0-9-]{1,16}$/;

const SIGNAL_BOT_MINI_APP_VENUE_CODES: Record<string, string> = {
  dflow: "d",
  kalshi: "k",
  limitless: "l",
  polymarket: "p",
};

function isSignalBotRouteId(value: string): boolean {
  return SIGNAL_BOT_ROUTE_ID_RE.test(value) && !value.includes("|");
}

function splitSignalBotRouteId(
  value: string,
): { body: string; venue: string } | null {
  const index = value.indexOf(":");
  if (index <= 0 || index >= value.length - 1) return null;
  const venue = value.slice(0, index).toLowerCase();
  const body = value.slice(index + 1);
  return venue && body ? { body, venue } : null;
}

function encodeSignalBotStartAppPayload(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fitSignalBotStartParam(value: string): string | null {
  return value.length <= TELEGRAM_STARTAPP_MAX_LENGTH ? value : null;
}

export function buildSignalBotEventStartParam(eventId: string): string | null {
  const normalized = eventId.trim();
  if (!isSignalBotRouteId(normalized)) return null;
  if (SIGNAL_BOT_SAFE_ROUTE_ID_RE.test(normalized)) {
    return fitSignalBotStartParam(`event_${normalized}`);
  }
  return fitSignalBotStartParam(
    `e_${encodeSignalBotStartAppPayload(normalized)}`,
  );
}

export function buildSignalBotBuyStartParam(input: {
  amountUsd?: number | null;
  eventId: string;
  marketId: string;
  side: "NO" | "YES";
}): string | null {
  const eventId = input.eventId.trim();
  const marketId = input.marketId.trim();
  if (!isSignalBotRouteId(eventId) || !isSignalBotRouteId(marketId)) {
    return null;
  }
  const amount =
    input.amountUsd != null && input.amountUsd > 0 && input.amountUsd <= 999_999
      ? String(Math.trunc(input.amountUsd))
      : "";
  const side = input.side === "YES" ? "Y" : "N";
  const eventParts = splitSignalBotRouteId(eventId);
  const marketParts = splitSignalBotRouteId(marketId);
  const compactVenueCode =
    eventParts && marketParts && eventParts.venue === marketParts.venue
      ? SIGNAL_BOT_MINI_APP_VENUE_CODES[eventParts.venue]
      : null;
  const payload =
    compactVenueCode && eventParts && marketParts
      ? [
          `${compactVenueCode}:${eventParts.body}`,
          marketParts.body,
          side,
          amount,
        ]
      : [eventId, marketId, side, amount];
  return fitSignalBotStartParam(
    `b_${encodeSignalBotStartAppPayload(payload.join("|"))}`,
  );
}

export function buildSignalBotMarketStartParam(input: {
  eventId: string;
  marketId?: string | null;
  side?: "NO" | "YES" | null;
}): string | null {
  const eventId = input.eventId.trim();
  const marketId = input.marketId?.trim() ?? "";
  if (!isSignalBotRouteId(eventId)) return null;
  if (marketId && !isSignalBotRouteId(marketId)) return null;
  if (!marketId && !input.side) return buildSignalBotEventStartParam(eventId);
  const side = input.side === "YES" ? "Y" : input.side === "NO" ? "N" : "";
  const eventParts = splitSignalBotRouteId(eventId);
  const marketParts = marketId ? splitSignalBotRouteId(marketId) : null;
  const compactVenueCode =
    eventParts && marketParts && eventParts.venue === marketParts.venue
      ? SIGNAL_BOT_MINI_APP_VENUE_CODES[eventParts.venue]
      : null;
  const payload =
    compactVenueCode && eventParts && marketParts
      ? [`${compactVenueCode}:${eventParts.body}`, marketParts.body, side]
      : [eventId, marketId, side];
  return fitSignalBotStartParam(
    `m_${encodeSignalBotStartAppPayload(payload.join("|"))}`,
  );
}

export function buildSignalBotHolderStartParam(input: {
  address: string | null | undefined;
  chain: string | null | undefined;
  eventId?: string | null | undefined;
  marketId?: string | null | undefined;
  noteId?: string | null | undefined;
  side?: "NO" | "YES" | null | undefined;
}): string | null {
  const address = input.address?.trim() ?? "";
  const chain = input.chain?.trim().toLowerCase() ?? "";
  const eventId = input.eventId?.trim() ?? "";
  const marketId = input.marketId?.trim() ?? "";
  const noteId = input.noteId?.trim() ?? "";
  if (
    !SIGNAL_BOT_WALLET_ADDRESS_RE.test(address) ||
    !SIGNAL_BOT_CHAIN_RE.test(chain)
  ) {
    return null;
  }
  if (eventId && !isSignalBotRouteId(eventId)) return null;
  if (marketId && !isSignalBotRouteId(marketId)) return null;
  if (noteId && !SIGNAL_BOT_SAFE_ROUTE_ID_RE.test(noteId)) return null;
  const side = input.side === "YES" ? "Y" : input.side === "NO" ? "N" : "";
  return fitSignalBotStartParam(
    `wt_${encodeSignalBotStartAppPayload(
      [chain, address, eventId, marketId, side, noteId].join("|"),
    )}`,
  );
}

export function buildSignalBotMiniAppUrl(input: {
  base: string | null | undefined;
  startParam: string | null;
}): string | null {
  if (!input.base || !input.startParam) return null;
  try {
    const url = new URL(input.base);
    url.searchParams.set("startapp", input.startParam);
    return url.toString();
  } catch {
    return null;
  }
}

export function buildSignalBotTelegramWebAppUrl(input: {
  appBaseUrl: string;
  startParam: string | null | undefined;
}): string | null {
  if (!input.startParam) return null;
  try {
    const url = new URL(
      SIGNAL_BOT_TELEGRAM_WEB_APP_ENTRY_PATH,
      input.appBaseUrl,
    );
    url.searchParams.set(TELEGRAM_WEB_APP_START_PARAM_QUERY, input.startParam);
    return url.toString();
  } catch {
    return null;
  }
}

export function buildSignalBotMiniAppEventUrl(input: {
  eventId: string | null | undefined;
  marketId?: string | null | undefined;
  miniAppLinkBase: string | null | undefined;
  side?: "NO" | "YES" | null | undefined;
}): string | null {
  if (!input.eventId) return null;
  return buildSignalBotMiniAppUrl({
    base: input.miniAppLinkBase,
    startParam: buildSignalBotMarketStartParam({
      eventId: input.eventId,
      marketId: input.marketId,
      side: input.side,
    }),
  });
}

export function buildSignalBotMiniAppTradeUrl(input: {
  amountUsd?: number | null;
  eventId: string;
  marketId: string;
  miniAppLinkBase: string | null | undefined;
  side: "NO" | "YES";
}): string | null {
  return buildSignalBotMiniAppUrl({
    base: input.miniAppLinkBase,
    startParam: buildSignalBotBuyStartParam(input),
  });
}

export function buildSignalBotMiniAppHolderUrl(input: {
  address: string | null | undefined;
  chain: string | null | undefined;
  eventId?: string | null | undefined;
  marketId?: string | null | undefined;
  miniAppLinkBase: string | null | undefined;
  noteId?: string | null | undefined;
  side?: "NO" | "YES" | null | undefined;
}): string | null {
  return buildSignalBotMiniAppUrl({
    base: input.miniAppLinkBase,
    startParam: buildSignalBotHolderStartParam(input),
  });
}

export function normalizeTelegramMiniAppLinkBase(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "t.me" && url.hostname !== "telegram.me") {
      return null;
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length < 1 || pathParts.length > 2) return null;
    if (!pathParts.every((part) => /^[A-Za-z0-9_]{3,64}$/.test(part))) {
      return null;
    }
    url.pathname = `/${pathParts.join("/")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
