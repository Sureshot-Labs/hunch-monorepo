import { canonicalJsonHash } from "../funding/persistence/canonical.js";

const TRADE_INPUT_CONTEXT_KEY_PREFIX = "tg:signal_bot:v2:trade_input_context";

const EXACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TradeInputContextRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type TelegramBotTradeInputContext = Readonly<{
  action: "buy" | "sell";
  authority: TelegramBotTradeAuthorityBinding;
  chatId: string;
  controlledPositionId: string | null;
  createdAt: string;
  eventId: string | null;
  expiresAt: string;
  funderAddress: string | null;
  id: string;
  marketId: string;
  messageScope: TelegramBotTradeInputMessageScope;
  side: "NO" | "YES";
  telegramUserId: string;
  venue: "polymarket";
  version: 2;
}>;

export type TelegramBotTradeAuthorityBinding = Readonly<{
  authorizationId: string;
  privyWalletId: string;
  telegramAccountLinkId: string;
  userId: string;
  walletAddress: string;
  walletChain: "ethereum" | "solana";
}>;

export type TelegramBotTradeInputMessageScope =
  | Readonly<{ kind: "exact_message"; messageId: number }>
  | Readonly<{ kind: "new_message_unbound" }>;

export function telegramBotTradeInputMessageScopeMatches(
  scope: TelegramBotTradeInputMessageScope,
  messageId: number,
): boolean {
  return scope.kind === "new_message_unbound" || scope.messageId === messageId;
}

function contextKey(id: string): string {
  return `${TRADE_INPUT_CONTEXT_KEY_PREFIX}:${id}`;
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

export function parseTelegramBotTradeAuthorityBinding(
  value: unknown,
): TelegramBotTradeAuthorityBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Partial<TelegramBotTradeAuthorityBinding>;
  const authorizationId = binding.authorizationId;
  const telegramAccountLinkId = binding.telegramAccountLinkId;
  const userId = binding.userId;
  if (
    typeof authorizationId !== "string" ||
    authorizationId.length === 0 ||
    typeof telegramAccountLinkId !== "string" ||
    telegramAccountLinkId.length === 0 ||
    typeof userId !== "string" ||
    userId.length === 0 ||
    typeof binding.privyWalletId !== "string" ||
    binding.privyWalletId.length === 0 ||
    typeof binding.walletAddress !== "string" ||
    binding.walletAddress.length === 0 ||
    (binding.walletChain !== "ethereum" && binding.walletChain !== "solana")
  ) {
    return null;
  }
  return {
    authorizationId,
    privyWalletId: binding.privyWalletId,
    telegramAccountLinkId,
    userId,
    walletAddress:
      binding.walletChain === "ethereum"
        ? binding.walletAddress.trim().toLowerCase()
        : binding.walletAddress.trim(),
    walletChain: binding.walletChain,
  };
}

export function telegramBotTradeAuthorityFingerprint(
  binding: TelegramBotTradeAuthorityBinding,
): string {
  return canonicalJsonHash({
    ...binding,
    walletAddress:
      binding.walletChain === "ethereum"
        ? binding.walletAddress.trim().toLowerCase()
        : binding.walletAddress.trim(),
    version: 1,
  });
}

function isAuthorityBinding(
  value: unknown,
): value is TelegramBotTradeAuthorityBinding {
  return parseTelegramBotTradeAuthorityBinding(value) != null;
}

function isMessageScope(
  value: unknown,
): value is TelegramBotTradeInputMessageScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<TelegramBotTradeInputMessageScope> & {
    messageId?: unknown;
  };
  if (scope.kind === "new_message_unbound") return true;
  return (
    scope.kind === "exact_message" &&
    Number.isInteger(scope.messageId) &&
    Number(scope.messageId) > 0
  );
}

export function isTelegramBotTradeInputContext(
  value: unknown,
): value is TelegramBotTradeInputContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<TelegramBotTradeInputContext>;
  return Boolean(
    context.version === 2 &&
    EXACT_UUID_RE.test(context.id ?? "") &&
    (context.action === "buy" || context.action === "sell") &&
    context.venue === "polymarket" &&
    (context.side === "YES" || context.side === "NO") &&
    typeof context.marketId === "string" &&
    context.marketId.length > 0 &&
    isNullableString(context.eventId) &&
    typeof context.telegramUserId === "string" &&
    context.telegramUserId.length > 0 &&
    typeof context.chatId === "string" &&
    context.chatId.length > 0 &&
    isAuthorityBinding(context.authority) &&
    isMessageScope(context.messageScope) &&
    isNullableString(context.controlledPositionId) &&
    isNullableString(context.funderAddress) &&
    typeof context.createdAt === "string" &&
    Number.isFinite(Date.parse(context.createdAt)) &&
    typeof context.expiresAt === "string" &&
    Number.isFinite(Date.parse(context.expiresAt)),
  );
}

export async function writeTelegramBotTradeInputContext(input: {
  context: TelegramBotTradeInputContext;
  redis: Pick<TradeInputContextRedis, "set">;
}): Promise<boolean> {
  const ttlSec = Math.ceil(
    (Date.parse(input.context.expiresAt) - Date.now()) / 1_000,
  );
  if (ttlSec <= 0) return false;
  await input.redis.set(
    contextKey(input.context.id),
    JSON.stringify(input.context),
    { EX: ttlSec },
  );
  return true;
}

export async function readTelegramBotTradeInputContext(input: {
  id: string;
  redis: Pick<TradeInputContextRedis, "get">;
}): Promise<TelegramBotTradeInputContext | null> {
  if (!EXACT_UUID_RE.test(input.id)) return null;
  const raw = await input.redis.get(contextKey(input.id));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isTelegramBotTradeInputContext(parsed)) return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}
