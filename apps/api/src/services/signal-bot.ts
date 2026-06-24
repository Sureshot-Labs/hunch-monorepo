import type { DbQuery } from "../db.js";
import { buildWalletIntelAcceptingOrdersSql } from "./wallet-intel-market-eligibility.js";

export type SignalBotConfig = {
  enabled: boolean;
  token: string;
  adminUserIds: Set<number>;
  appBaseUrl: string;
  publishIntervalSec: number;
  pollTimeoutSec: number;
  minConfidence: number;
  maxSignalsPerTick: number;
  amountsUsd: number[];
};

export type SignalBotCommand =
  | "disable_signals"
  | "enable_signals"
  | "help"
  | "start"
  | "status"
  | "test_signal";

export type SignalBotChatState = {
  chatId: string;
  chatTitle: string | null;
  chatType: string | null;
  enabledBy: string;
  enabledAt: string;
  cursorCreatedAt: string;
  cursorId: string;
};

export type SignalBotRedisLike = {
  del(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { arguments: string[]; keys: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, value: Record<string, string>): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, member: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; NX?: boolean },
  ): Promise<unknown>;
};

export type TelegramBotChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramBotMessage = {
  message_id?: number;
  chat: TelegramBotChat;
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  text?: string;
};

export type TelegramBotUpdate = {
  update_id: number;
  message?: TelegramBotMessage;
};

export type TelegramBotUser = {
  id: number;
  is_bot: boolean;
  username?: string;
};

export type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
};

export type TelegramSendMessageInput = {
  chat_id: string;
  disable_web_page_preview: boolean;
  parse_mode: "MarkdownV2";
  reply_markup?: TelegramInlineKeyboard;
  text: string;
};

export type TelegramSendResult =
  | { ok: true }
  | { error: "blocked_or_missing" | "other"; message: string; ok: false };

export type SignalBotTelegramClient = {
  getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]>;
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendResult>;
};

export type SignalBotNote = {
  id: string;
  noteKey: string;
  title: string;
  description: string;
  rationale: string | null;
  producerRunId: string;
  direction: "down" | "mixed" | "up" | null;
  confidence: number | null;
  modelMeta: Record<string, unknown>;
  createdAt: string;
  primaryTargetMeta: Record<string, unknown>;
  marketId: string | null;
  eventId: string | null;
  marketTitle: string | null;
  eventTitle: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  holderAddress: string | null;
  holderChain: string | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderCredentialBullets: string[];
  holderClusterPnl30dUsd: number | null;
  holderClusterSharpHolders: number | null;
  holderClusterSharpUsd: number | null;
};

type SignalBotNoteRow = {
  id: string;
  note_key: string;
  title: string;
  description: string;
  rationale: string | null;
  producer_run_id: string;
  direction: "down" | "mixed" | "up" | null;
  confidence: string | number | null;
  model_meta: unknown;
  created_at: Date | string;
  primary_target_meta: unknown;
  market_id: string | null;
  event_id: string | null;
  market_title: string | null;
  event_title: string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  holder_address: string | null;
  holder_chain: string | null;
  holder_target_meta: unknown;
};

type SignalBotEligibilityCountRow = {
  below_min_confidence: string | number | null;
  eligible: string | number | null;
  non_directional: string | number | null;
  total: string | number | null;
};

const CHAT_SET_KEY = "tg:signal_bot:v1:enabled_chats";
const UPDATE_OFFSET_KEY = "tg:signal_bot:v1:update_offset";
const LOCK_KEY = "tg:signal_bot:v1:lock";
const LOCK_TTL_MS = 120_000;
const SIGNAL_CONTEXT_MAX_CHARS = 260;
const DEFAULT_CURSOR_ID = "00000000-0000-0000-0000-000000000000";
const LATEST_CURSOR_CREATED_AT = "9999-12-31T23:59:59.999Z";
const LATEST_CURSOR_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export function signalBotChatKey(chatId: string): string {
  return `tg:signal_bot:v1:chat:${chatId}`;
}

export function signalBotLockKey(): string {
  return LOCK_KEY;
}

export function parseSignalBotConfig(
  env: NodeJS.ProcessEnv = process.env,
): SignalBotConfig {
  return {
    enabled: parseBool(env.HUNCH_SIGNAL_BOT_ENABLED, false),
    token: env.HUNCH_SIGNAL_BOT_TOKEN?.trim() ?? "",
    adminUserIds: new Set(parseIntegerList(env.HUNCH_SIGNAL_BOT_ADMIN_USER_IDS)),
    appBaseUrl: normalizeBaseUrl(
      env.HUNCH_SIGNAL_BOT_APP_BASE_URL?.trim() || "https://app.hunch.trade",
    ),
    publishIntervalSec: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_PUBLISH_INTERVAL_SEC,
      60,
    ),
    pollTimeoutSec: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_POLL_TIMEOUT_SEC,
      25,
    ),
    minConfidence: parseRatio(env.HUNCH_SIGNAL_BOT_MIN_CONFIDENCE, 0.7),
    maxSignalsPerTick: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_MAX_SIGNALS_PER_TICK,
      5,
    ),
    amountsUsd: parseAmountList(env.HUNCH_SIGNAL_BOT_AMOUNTS_USD, [5, 20, 50]),
  };
}

export function parseSignalBotCommand(
  text: string | null | undefined,
  botUsername?: string | null,
): SignalBotCommand | null {
  if (!text) return null;
  const firstToken = text.trim().split(/\s+/)[0];
  if (!firstToken?.startsWith("/")) return null;
  const raw = firstToken.slice(1);
  const [command, mention] = raw.split("@");
  if (!command) return null;
  if (
    mention &&
    botUsername &&
    mention.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }
  switch (command.toLowerCase()) {
    case "disable_signals":
      return "disable_signals";
    case "enable_signals":
      return "enable_signals";
    case "help":
      return "help";
    case "start":
      return "start";
    case "status":
      return "status";
    case "test_signal":
      return "test_signal";
    default:
      return null;
  }
}

export function isSignalBotAdmin(
  config: Pick<SignalBotConfig, "adminUserIds">,
  userId: number | null | undefined,
): boolean {
  return typeof userId === "number" && config.adminUserIds.has(userId);
}

export function escapeTelegramMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_SPECIAL_CHARS, (char) => `\\${char}`);
}

export function escapeTelegramMarkdownV2Url(value: string): string {
  return value.replace(/[)\\]/g, (char) => `\\${char}`);
}

export function resolveSignalBotBuySide(
  note: Pick<SignalBotNote, "direction">,
): "NO" | "YES" | null {
  if (note.direction === "up") return "YES";
  if (note.direction === "down") return "NO";
  return null;
}

export function buildSignalBotTradeUrl(input: {
  amountUsd?: number | null;
  appBaseUrl: string;
  eventId: string;
  marketId: string;
  side: "NO" | "YES";
}): string {
  const url = new URL(`/events/${encodeURIComponent(input.eventId)}`, input.appBaseUrl);
  url.searchParams.set("market", input.marketId);
  url.searchParams.set("side", input.side);
  url.searchParams.set("tradeSide", "BUY");
  url.searchParams.set("orderType", "market");
  url.searchParams.set("openTrade", "1");
  url.searchParams.set("utm_source", "telegram_signal_bot");
  if (input.amountUsd != null && input.amountUsd > 0) {
    url.searchParams.set("amountUsd", String(input.amountUsd));
  }
  return url.toString();
}

export function buildSignalBotOpenMarketUrl(input: {
  appBaseUrl: string;
  eventId: string;
  marketId: string | null;
  side?: "NO" | "YES" | null;
}): string {
  const url = new URL(`/events/${encodeURIComponent(input.eventId)}`, input.appBaseUrl);
  if (input.marketId) url.searchParams.set("market", input.marketId);
  if (input.side) url.searchParams.set("side", input.side);
  url.searchParams.set("utm_source", "telegram_signal_bot");
  return url.toString();
}

export function buildSignalBotHolderUrl(input: {
  address: string | null | undefined;
  chain: string | null | undefined;
}): string | null {
  const address = input.address?.trim();
  const chain = input.chain?.trim().toLowerCase();
  if (!address || !chain) return null;
  switch (chain) {
    case "polygon":
      return `https://polygonscan.com/address/${encodeURIComponent(address)}`;
    case "base":
      return `https://basescan.org/address/${encodeURIComponent(address)}`;
    case "ethereum":
    case "mainnet":
      return `https://etherscan.io/address/${encodeURIComponent(address)}`;
    case "arbitrum":
      return `https://arbiscan.io/address/${encodeURIComponent(address)}`;
    case "optimism":
      return `https://optimistic.etherscan.io/address/${encodeURIComponent(address)}`;
    case "avalanche":
      return `https://snowtrace.io/address/${encodeURIComponent(address)}`;
    case "bsc":
      return `https://bscscan.com/address/${encodeURIComponent(address)}`;
    case "solana":
      return `https://solscan.io/account/${encodeURIComponent(address)}`;
    default:
      return null;
  }
}

export function buildSignalBotMessage(input: {
  amountsUsd: number[];
  appBaseUrl: string;
  note: SignalBotNote;
}): {
  keyboard: TelegramInlineKeyboard | undefined;
  text: string;
} {
  const note = input.note;
  const buySide = resolveSignalBotBuySide(note);
  const price = buySide ? resolveSidePrice(note, buySide) : null;
  const title = escapeTelegramMarkdownV2(note.title);
  const summary = escapeTelegramMarkdownV2(note.description);
  const contextLine = formatSignalContextLine(note);
  const credentialLines = formatSignalCredentialLines(note);
  const marketTitleLine = formatMarketTitleLine(note);
  const priceLine = formatPriceLine(note);
  const marketUrl = note.eventId
    ? buildSignalBotOpenMarketUrl({
        appBaseUrl: input.appBaseUrl,
        eventId: note.eventId,
        marketId: note.marketId,
        side: buySide,
      })
    : null;
  const rawHolderUrl = buildSignalBotHolderUrl({
    address: note.holderAddress,
    chain: note.holderChain,
  });
  const holderUrl =
    rawHolderUrl && (!buySide || !note.holderSide || note.holderSide === buySide)
      ? rawHolderUrl
      : null;
  const titleMarkdown = marketUrl
    ? `*[${title}](${escapeTelegramMarkdownV2Url(marketUrl)})*`
    : `*${title}*`;
  const metaLine = [
    formatSignalBotSignalLabel(note),
    priceLine,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const lines = [
    titleMarkdown,
    escapeTelegramMarkdownV2(metaLine),
    ...(marketTitleLine ? [escapeTelegramMarkdownV2(`📍 ${marketTitleLine}`)] : []),
    "",
    summary,
    ...(credentialLines.length > 0
      ? ["", ...credentialLines.map(escapeTelegramMarkdownV2)]
      : []),
    ...(contextLine ? ["", escapeTelegramMarkdownV2(contextLine)] : []),
  ];

  const keyboardRows: TelegramInlineKeyboard["inline_keyboard"] = [];
  if (note.eventId && note.marketId && buySide) {
    const baseTradeUrl = buildSignalBotTradeUrl({
      appBaseUrl: input.appBaseUrl,
      eventId: note.eventId,
      marketId: note.marketId,
      side: buySide,
    });
    keyboardRows.push([
      {
        text: `${buySide === "YES" ? "🟢" : "🔴"} Buy ${buySide}${price == null ? "" : ` ${formatCents(price)}`}`,
        url: baseTradeUrl,
      },
    ]);
    if (input.amountsUsd.length > 0) {
      keyboardRows.push(
        input.amountsUsd.map((amountUsd) => ({
          text: `💵 ${amountUsd}`,
          url: buildSignalBotTradeUrl({
            amountUsd,
            appBaseUrl: input.appBaseUrl,
            eventId: note.eventId as string,
            marketId: note.marketId as string,
            side: buySide,
          }),
        })),
      );
    }
    keyboardRows.push(
      buildSignalBotLinkRow({
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderUrl,
        marketUrl: marketUrl ?? baseTradeUrl,
      }),
    );
  } else if (note.eventId) {
    keyboardRows.push(
      buildSignalBotLinkRow({
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderUrl,
        marketUrl: buildSignalBotOpenMarketUrl({
          appBaseUrl: input.appBaseUrl,
          eventId: note.eventId,
          marketId: note.marketId,
          side: buySide,
        }),
      }),
    );
  } else if (holderUrl) {
    keyboardRows.push(
      buildSignalBotLinkRow({
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderUrl,
        marketUrl: null,
      }),
    );
  }

  return {
    keyboard:
      keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined,
    text: lines.join("\n"),
  };
}

function buildSignalBotLinkRow(input: {
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderUrl: string | null;
  marketUrl: string | null;
}): TelegramInlineKeyboard["inline_keyboard"][number] {
  const row: TelegramInlineKeyboard["inline_keyboard"][number] = [];
  if (input.holderUrl) {
    row.push({
      text: formatHolderButtonText(input),
      url: input.holderUrl,
    });
  }
  if (input.marketUrl) {
    row.push({
      text: "↗️ Open market",
      url: input.marketUrl,
    });
  }
  return row;
}

function formatHolderButtonText(input: {
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
}): string {
  const sideLabel = input.holderSide ?? "Holder";
  const parts = [
    "👤",
    input.holderActorMode === "sharp_cluster" && input.holderSide
      ? `Top ${sideLabel}`
      : sideLabel,
  ];
  if (input.holderPositionUsd != null) {
    parts.push(formatCompactUsd(input.holderPositionUsd));
  }
  const label = parts.join(" ");
  if (input.holderOpenPnlUsd == null) return label;
  return `${label} (${formatSignedCompactUsd(input.holderOpenPnlUsd)})`;
}

export async function enableSignalBotChat(input: {
  chat: TelegramBotChat;
  enabledBy: number;
  now?: Date;
  redis: SignalBotRedisLike;
}): Promise<SignalBotChatState> {
  const now = input.now ?? new Date();
  const chatId = String(input.chat.id);
  const state: SignalBotChatState = {
    chatId,
    chatTitle: resolveChatTitle(input.chat),
    chatType: input.chat.type ?? null,
    enabledBy: String(input.enabledBy),
    enabledAt: now.toISOString(),
    cursorCreatedAt: now.toISOString(),
    cursorId: DEFAULT_CURSOR_ID,
  };
  await input.redis.sAdd(CHAT_SET_KEY, chatId);
  await writeChatState(input.redis, state);
  return state;
}

export async function disableSignalBotChat(
  redis: SignalBotRedisLike,
  chatId: string,
): Promise<void> {
  await redis.sRem(CHAT_SET_KEY, chatId);
  await redis.del(signalBotChatKey(chatId));
}

export async function getSignalBotChatState(
  redis: SignalBotRedisLike,
  chatId: string,
): Promise<SignalBotChatState | null> {
  const raw = await redis.hGetAll(signalBotChatKey(chatId));
  return parseChatState(raw);
}

export async function updateSignalBotChatCursor(input: {
  chatId: string;
  createdAt: string;
  id: string;
  redis: SignalBotRedisLike;
}): Promise<void> {
  const existing = await getSignalBotChatState(input.redis, input.chatId);
  if (!existing) return;
  await writeChatState(input.redis, {
    ...existing,
    cursorCreatedAt: input.createdAt,
    cursorId: input.id,
  });
}

export async function acquireSignalBotLock(input: {
  owner: string;
  redis: SignalBotRedisLike;
}): Promise<boolean> {
  const result = await input.redis.set(LOCK_KEY, input.owner, {
    NX: true,
    PX: LOCK_TTL_MS,
  });
  return result === "OK";
}

export async function releaseSignalBotLock(input: {
  owner: string;
  redis: SignalBotRedisLike;
}): Promise<void> {
  await input.redis.eval(RELEASE_LOCK_SCRIPT, {
    arguments: [input.owner],
    keys: [LOCK_KEY],
  });
}

export async function refreshSignalBotLock(input: {
  owner: string;
  redis: SignalBotRedisLike;
}): Promise<boolean> {
  const result = await input.redis.eval(REFRESH_LOCK_SCRIPT, {
    arguments: [input.owner, String(LOCK_TTL_MS)],
    keys: [LOCK_KEY],
  });
  return Number(result) === 1;
}

export async function readSignalBotUpdateOffset(
  redis: SignalBotRedisLike,
): Promise<number | null> {
  const raw = await redis.get(UPDATE_OFFSET_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export async function writeSignalBotUpdateOffset(
  redis: SignalBotRedisLike,
  offset: number,
): Promise<void> {
  await redis.set(UPDATE_OFFSET_KEY, String(offset));
}

export async function handleSignalBotCommand(input: {
  botUsername?: string | null;
  config: SignalBotConfig;
  message: TelegramBotMessage;
  redis: SignalBotRedisLike;
  sendMessage: (message: TelegramSendMessageInput) => Promise<TelegramSendResult>;
  sendTestSignal: (chatId: string) => Promise<boolean>;
}): Promise<boolean> {
  const command = parseSignalBotCommand(input.message.text, input.botUsername);
  if (!command) return false;
  const chatId = String(input.message.chat.id);
  const isAdmin = isSignalBotAdmin(input.config, input.message.from?.id);

  if (
    !isAdmin &&
    (command === "disable_signals" ||
      command === "enable_signals" ||
      command === "test_signal")
  ) {
    await input.sendMessage(buildPlainReply(chatId, "Not authorized."));
    return true;
  }

  if (command === "start" || command === "help") {
    await input.sendMessage(buildPlainReply(chatId, helpText()));
    return true;
  }
  if (command === "enable_signals") {
    await enableSignalBotChat({
      chat: input.message.chat,
      enabledBy: input.message.from?.id ?? 0,
      redis: input.redis,
    });
    await input.sendMessage(buildPlainReply(chatId, "Signals enabled here."));
    return true;
  }
  if (command === "disable_signals") {
    await disableSignalBotChat(input.redis, chatId);
    await input.sendMessage(buildPlainReply(chatId, "Signals disabled here."));
    return true;
  }
  if (command === "status") {
    const state = await getSignalBotChatState(input.redis, chatId);
    await input.sendMessage(
      buildPlainReply(
        chatId,
        [
          state ? "Signals are enabled here." : "Signals are disabled here.",
          `Min confidence: ${formatPercent(input.config.minConfidence)}.`,
        ].join("\n"),
      ),
    );
    return true;
  }
  if (command === "test_signal") {
    const sent = await input.sendTestSignal(chatId);
    await input.sendMessage(
      buildPlainReply(chatId, sent ? "Sent latest eligible signal." : "No eligible signal found."),
    );
    return true;
  }
  return true;
}

export async function pollSignalBotCommands(input: {
  botUsername?: string | null;
  config: SignalBotConfig;
  redis: SignalBotRedisLike;
  sendTestSignal: (chatId: string) => Promise<boolean>;
  telegram: SignalBotTelegramClient;
}): Promise<number> {
  const offset = await readSignalBotUpdateOffset(input.redis);
  const updates = await input.telegram.getUpdates({
    offset,
    timeoutSec: input.config.pollTimeoutSec,
  });
  let handled = 0;
  for (const update of updates) {
    if (update.message) {
      const didHandle = await handleSignalBotCommand({
        botUsername: input.botUsername,
        config: input.config,
        message: update.message,
        redis: input.redis,
        sendMessage: (message) => input.telegram.sendMessage(message),
        sendTestSignal: input.sendTestSignal,
      });
      if (didHandle) handled += 1;
    }
    await writeSignalBotUpdateOffset(input.redis, update.update_id + 1);
  }
  return handled;
}

export async function publishSignalBotTick(input: {
  config: SignalBotConfig;
  db: DbQuery;
  redis: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
}): Promise<{
  belowConfidenceNotes: number;
  blockedChats: number;
  chats: number;
  eligibleNotes: number;
  nonDirectionalNotes: number;
  sent: number;
}> {
  const chatIds = await input.redis.sMembers(CHAT_SET_KEY);
  let sent = 0;
  let blockedChats = 0;
  let belowConfidenceNotes = 0;
  let eligibleNotes = 0;
  let nonDirectionalNotes = 0;
  for (const chatId of chatIds) {
    const state = await getSignalBotChatState(input.redis, chatId);
    if (!state) {
      await input.redis.sRem(CHAT_SET_KEY, chatId);
      continue;
    }
    const counts = await loadSignalBotEligibilityCounts(input.db, {
      afterCreatedAt: state.cursorCreatedAt,
      afterId: state.cursorId,
      minConfidence: input.config.minConfidence,
    });
    belowConfidenceNotes += counts.belowConfidence;
    eligibleNotes += counts.eligible;
    nonDirectionalNotes += counts.nonDirectional;
    const notes = await loadSignalBotNotes(input.db, {
      afterCreatedAt: state.cursorCreatedAt,
      afterId: state.cursorId,
      limit: input.config.maxSignalsPerTick,
      minConfidence: input.config.minConfidence,
    });
    for (const note of notes) {
      const { keyboard, text } = buildSignalBotMessage({
        amountsUsd: input.config.amountsUsd,
        appBaseUrl: input.config.appBaseUrl,
        note,
      });
      const result = await input.telegram.sendMessage({
        chat_id: chatId,
        disable_web_page_preview: false,
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
        text,
      });
      if (result.ok) {
        sent += 1;
        await updateSignalBotChatCursor({
          chatId,
          createdAt: note.createdAt,
          id: note.id,
          redis: input.redis,
        });
        continue;
      }
      if (result.error === "blocked_or_missing") {
        blockedChats += 1;
        await disableSignalBotChat(input.redis, chatId);
        break;
      }
      break;
    }
  }
  return {
    belowConfidenceNotes,
    blockedChats,
    chats: chatIds.length,
    eligibleNotes,
    nonDirectionalNotes,
    sent,
  };
}

export async function sendLatestSignalBotTestSignal(input: {
  chatId: string;
  config: SignalBotConfig;
  db: DbQuery;
  telegram: SignalBotTelegramClient;
}): Promise<boolean> {
  const notes = await loadSignalBotNotes(input.db, {
    afterCreatedAt: LATEST_CURSOR_CREATED_AT,
    afterId: LATEST_CURSOR_ID,
    descending: true,
    limit: 1,
    minConfidence: input.config.minConfidence,
  });
  const note = notes[0];
  if (!note) return false;
  const { keyboard, text } = buildSignalBotMessage({
    amountsUsd: input.config.amountsUsd,
    appBaseUrl: input.config.appBaseUrl,
    note,
  });
  const result = await input.telegram.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: false,
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
    text,
  });
  return result.ok;
}

export async function loadSignalBotNotes(
  db: DbQuery,
  input: {
    afterCreatedAt: string;
    afterId: string;
    descending?: boolean;
    limit: number;
    minConfidence: number;
  },
): Promise<SignalBotNote[]> {
  const order = input.descending ? "desc" : "asc";
  const comparison = input.descending ? "<" : ">";
  const { rows } = await db.query<SignalBotNoteRow>(
    `
      select
        n.id,
        n.note_key,
        n.title,
        n.description,
        n.rationale,
        n.producer_run_id,
        n.direction,
        n.confidence,
        n.model_meta,
        n.created_at::text as created_at,
        pt.target_meta as primary_target_meta,
        m.id as market_id,
        m.event_id,
        m.title as market_title,
        e.title as event_title,
        m.best_bid,
        m.best_ask,
        m.last_price,
        holder.address as holder_address,
        holder.chain as holder_chain,
        holder.target_meta as holder_target_meta
      from ai_notes n
      join ai_note_targets pt
        on pt.note_id = n.id
       and pt.is_primary = true
       and pt.target_kind = 'market'
      join unified_markets m on m.id = pt.target_id
      left join unified_events e on e.id = m.event_id
      left join lateral (
        select
          w.address,
          w.chain,
          t.target_meta
        from ai_note_targets t
        join wallets w on w.id::text = t.target_id
        where t.note_id = n.id
          and t.target_kind = 'wallet'
        order by t.target_rank asc, t.target_id asc
        limit 1
      ) holder on true
      where n.note_type = 'signal'
        and n.status = 'active'
        and n.producer_type = 'holder_research'
        and n.direction in ('up', 'down')
        and coalesce(n.confidence, 0) >= $1
        and ${buildWalletIntelAcceptingOrdersSql({
          eventAlias: "e",
          marketAlias: "m",
        })}
        and (
          n.created_at ${comparison} $2::timestamptz
          or (n.created_at = $2::timestamptz and n.id ${comparison} $3::uuid)
        )
      order by n.created_at ${order}, n.id ${order}
      limit $4
    `,
    [input.minConfidence, input.afterCreatedAt, input.afterId, input.limit],
  );
  return rows.map(rowToSignalBotNote);
}

async function loadSignalBotEligibilityCounts(
  db: DbQuery,
  input: {
    afterCreatedAt: string;
    afterId: string;
    minConfidence: number;
  },
): Promise<{
  belowConfidence: number;
  eligible: number;
  nonDirectional: number;
  total: number;
}> {
  const { rows } = await db.query<SignalBotEligibilityCountRow>(
    `
      select
        count(*) filter (
          where n.direction in ('up', 'down')
            and coalesce(n.confidence, 0) >= $1
        )::int as eligible,
        count(*) filter (
          where n.direction in ('up', 'down')
            and coalesce(n.confidence, 0) < $1
        )::int as below_min_confidence,
        count(*) filter (
          where n.direction is null
             or n.direction not in ('up', 'down')
        )::int as non_directional,
        count(*)::int as total
      from ai_notes n
      join ai_note_targets pt
        on pt.note_id = n.id
       and pt.is_primary = true
       and pt.target_kind = 'market'
      join unified_markets m on m.id = pt.target_id
      left join unified_events e on e.id = m.event_id
      where n.note_type = 'signal'
        and n.status = 'active'
        and n.producer_type = 'holder_research'
        and ${buildWalletIntelAcceptingOrdersSql({
          eventAlias: "e",
          marketAlias: "m",
        })}
        and (
          n.created_at > $2::timestamptz
          or (n.created_at = $2::timestamptz and n.id > $3::uuid)
        )
    `,
    [input.minConfidence, input.afterCreatedAt, input.afterId],
  );
  const row = rows[0];
  return {
    belowConfidence: Math.max(0, Math.trunc(toNumber(row?.below_min_confidence) ?? 0)),
    eligible: Math.max(0, Math.trunc(toNumber(row?.eligible) ?? 0)),
    nonDirectional: Math.max(0, Math.trunc(toNumber(row?.non_directional) ?? 0)),
    total: Math.max(0, Math.trunc(toNumber(row?.total) ?? 0)),
  };
}

export class TelegramBotApiClient implements SignalBotTelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getMe(): Promise<TelegramBotUser> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramBotUser;
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || !payload.result) {
      throw new Error(
        `Telegram getMe failed: ${response.status} ${payload?.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  async getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("timeout", String(input.timeoutSec));
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
    if (input.offset != null) url.searchParams.set("offset", String(input.offset));
    const response = await fetch(url);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramBotUpdate[];
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.result)) {
      throw new Error(
        `Telegram getUpdates failed: ${response.status} ${payload?.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramSendResult> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (response.ok) return { ok: true };
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
    } | null;
    const message = payload?.description ?? `HTTP ${response.status}`;
    if (
      response.status === 403 ||
      /chat not found|bot was blocked|user is deactivated/i.test(message)
    ) {
      return { error: "blocked_or_missing", message, ok: false };
    }
    return { error: "other", message, ok: false };
  }
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.trunc(parsed);
  return asInt > 0 ? asInt : fallback;
}

function parseRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function parseIntegerList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry))
    .map((entry) => Math.trunc(entry));
}

function parseAmountList(
  value: string | undefined,
  fallback: number[],
): number[] {
  const parsed = parseIntegerList(value).filter((entry) => entry > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://app.hunch.trade";
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, maxItems);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToSignalBotNote(row: SignalBotNoteRow): SignalBotNote {
  const holderMeta = asObject(row.holder_target_meta);
  const holderSide = String(holderMeta.side ?? "").toUpperCase();
  const holderActorMode = String(holderMeta.actorMode ?? "");
  return {
    id: row.id,
    noteKey: row.note_key,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    producerRunId: row.producer_run_id,
    direction: row.direction,
    confidence: toNumber(row.confidence),
    modelMeta: asObject(row.model_meta),
    createdAt: toIso(row.created_at),
    primaryTargetMeta: asObject(row.primary_target_meta),
    marketId: row.market_id,
    eventId: row.event_id,
    marketTitle: row.market_title,
    eventTitle: row.event_title,
    bestBid: toNumber(row.best_bid),
    bestAsk: toNumber(row.best_ask),
    lastPrice: toNumber(row.last_price),
    holderAddress: row.holder_address,
    holderChain: row.holder_chain,
    holderOpenPnlUsd: toNumber(holderMeta.openPnlUsd),
    holderPositionUsd: toNumber(holderMeta.positionUsd),
    holderSide: holderSide === "YES" || holderSide === "NO" ? holderSide : null,
    holderActorMode:
      holderActorMode === "single_holder" || holderActorMode === "sharp_cluster"
        ? holderActorMode
        : holderActorMode === "none"
          ? "none"
          : null,
    holderCredentialBullets: asStringArray(holderMeta.credentialBullets, 3),
    holderClusterPnl30dUsd: toNumber(holderMeta.clusterPnl30dUsd),
    holderClusterSharpHolders: toNumber(holderMeta.clusterSharpHolders),
    holderClusterSharpUsd: toNumber(holderMeta.clusterSharpUsd),
  };
}

function resolveSidePrice(note: SignalBotNote, side: "NO" | "YES"): number | null {
  const yesPrice =
    note.bestBid != null && note.bestAsk != null
      ? (note.bestBid + note.bestAsk) / 2
      : note.lastPrice;
  if (yesPrice == null) return null;
  return side === "YES" ? yesPrice : 1 - yesPrice;
}

function formatCents(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}¢`;
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
}

function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${formatCompactAmount(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${formatCompactAmount(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${formatCompactAmount(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function formatSignedCompactUsd(value: number): string {
  return value > 0 ? `+${formatCompactUsd(value)}` : formatCompactUsd(value);
}

function formatCompactAmount(value: number): string {
  const decimals = value >= 100 ? 0 : 1;
  return value.toFixed(decimals).replace(/\.0$/, "");
}

function formatPriceLine(note: SignalBotNote): string | null {
  const yes = resolveSidePrice(note, "YES");
  if (yes == null) return null;
  return `YES ${formatCents(yes)} / NO ${formatCents(1 - yes)}`;
}

function formatSignalCredentialLines(note: SignalBotNote): string[] {
  const bullets = note.holderCredentialBullets.slice(0, 2);
  if (bullets.length === 0) return [];
  const header =
    note.holderActorMode === "sharp_cluster"
      ? "Why this cluster matters:"
      : "Why this wallet matters:";
  return [header, ...bullets.map((bullet) => `• ${bullet}`)];
}

function formatSignalBotSignalLabel(note: SignalBotNote): string {
  if (note.holderActorMode === "sharp_cluster") return "⚡ Sharp cluster";
  const bucket = String(note.primaryTargetMeta.bucket ?? "").toLowerCase();
  switch (bucket) {
    case "sharp_minority":
    case "sharp_side":
      return "⚡ Sharp holder";
    case "sharp_split":
      return "⚡ Sharp split";
    case "clean_disagreement":
      return "⚖️ Split holders";
    case "recent_flow":
      return "🌊 Recent flow";
    case "event_bridge":
      return "🔗 Cross-market";
    case "concentration_risk":
      return "⚠️ Concentrated holder";
    case "followup_existing":
      return "🔄 Signal update";
    default:
      return "🔎 Holder signal";
  }
}

function formatMarketTitleLine(note: SignalBotNote): string | null {
  const unique: string[] = [];
  for (const raw of [note.eventTitle, note.marketTitle]) {
    const title = raw?.trim().replace(/\s+/g, " ");
    if (!title) continue;
    if (unique.some((existing) => existing.toLowerCase() === title.toLowerCase())) {
      continue;
    }
    unique.push(title);
  }
  return unique.join(" · ") || null;
}

function formatSignalContextLine(note: SignalBotNote): string | null {
  const external = asObject(note.modelMeta.external_research);
  const summary =
    typeof external.summary === "string" ? stripMarkdown(external.summary) : "";
  const timingMatch = summary.match(
    /public (?:info|information|context|news) ([^.]{0,80})\./i,
  );
  if (timingMatch?.[0]) {
    return `📰 ${truncateAtBoundary(timingMatch[0], SIGNAL_CONTEXT_MAX_CHARS)}`;
  }
  if (summary) return `📰 ${truncateAtBoundary(summary, SIGNAL_CONTEXT_MAX_CHARS)}`;
  const caveats = Array.isArray(note.modelMeta.caveats)
    ? note.modelMeta.caveats.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const caveat = caveats[0]?.trim();
  if (caveat) return `⚠️ ${truncateAtBoundary(caveat, SIGNAL_CONTEXT_MAX_CHARS)}`;
  if (note.rationale)
    return `💡 ${truncateAtBoundary(note.rationale, SIGNAL_CONTEXT_MAX_CHARS)}`;
  return null;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[\[?\d+\]?\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const boundary = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("; "));
  if (boundary >= Math.floor(max * 0.5)) return clipped.slice(0, boundary + 1);
  const space = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, space > 0 ? space : max - 3).trimEnd()}...`;
}

function resolveChatTitle(chat: TelegramBotChat): string | null {
  const title =
    chat.title ??
    chat.username ??
    [chat.first_name, chat.last_name]
      .filter((value): value is string => Boolean(value))
      .join(" ");
  return title.trim().length > 0 ? title : null;
}

function parseChatState(
  value: Record<string, string>,
): SignalBotChatState | null {
  if (!value.chatId || !value.enabledBy || !value.enabledAt) return null;
  return {
    chatId: value.chatId,
    chatTitle: value.chatTitle || null,
    chatType: value.chatType || null,
    cursorCreatedAt: value.cursorCreatedAt || "1970-01-01T00:00:00.000Z",
    cursorId: value.cursorId || DEFAULT_CURSOR_ID,
    enabledAt: value.enabledAt,
    enabledBy: value.enabledBy,
  };
}

async function writeChatState(
  redis: SignalBotRedisLike,
  state: SignalBotChatState,
): Promise<void> {
  await redis.hSet(signalBotChatKey(state.chatId), {
    chatId: state.chatId,
    chatTitle: state.chatTitle ?? "",
    chatType: state.chatType ?? "",
    cursorCreatedAt: state.cursorCreatedAt,
    cursorId: state.cursorId,
    enabledAt: state.enabledAt,
    enabledBy: state.enabledBy,
  });
}

function buildPlainReply(
  chatId: string,
  text: string,
): TelegramSendMessageInput {
  return {
    chat_id: chatId,
    disable_web_page_preview: true,
    parse_mode: "MarkdownV2",
    text: escapeTelegramMarkdownV2(text),
  };
}

function helpText(): string {
  return [
    "Hunch Signal Bot",
    "",
    "/enable_signals - enable this chat",
    "/disable_signals - disable this chat",
    "/status - show chat status",
    "/test_signal - send latest eligible signal",
  ].join("\n");
}
