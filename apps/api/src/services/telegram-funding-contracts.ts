import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";

export const TELEGRAM_FUNDING_CALLBACK_PREFIX = "hm:v1:fund";

export type TelegramFundingProgressState =
  | "waiting_for_transfer"
  | "funds_received"
  | "ready"
  | "expired"
  | "cancelled"
  | "needs_attention";

export type TelegramFundingProgressProjection = Readonly<{
  version: 1;
  fundingContextId: string;
  state: TelegramFundingProgressState;
  terminal: boolean;
  assetSymbol: "pUSD" | "USDC.e";
  networkLabel: "Polygon";
  rawAmount: string | null;
  decimals: 6;
  receiveAddress: string | null;
  expiresAt: string;
  observedAt: string | null;
}>;

export type TelegramFundingMessage = TelegramBotTradingClientMessage & {
  fundingContextId?: string;
  qrText?: string;
  venue?: "polymarket";
};

export type TelegramFundingCallbackRoute =
  | Readonly<{ contextId: string; kind: "cancel" }>
  | Readonly<{ contextId: string; kind: "qr" }>
  | Readonly<{ contextId: string; kind: "refresh" }>
  | Readonly<{ choiceToken: string; contextId: string; kind: "select" }>;

const UUID =
  "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";

export function parseTelegramFundingCallbackRoute(
  route: string,
): TelegramFundingCallbackRoute | null {
  const select = route.match(
    new RegExp(`^fund:select:${UUID}:([a-z0-9]{1,8})$`, "i"),
  );
  if (select) {
    return {
      kind: "select",
      contextId: select[1] ?? "",
      choiceToken: (select[2] ?? "").toLowerCase(),
    };
  }
  const action = route.match(
    new RegExp(`^fund:(refresh|cancel|qr):${UUID}$`, "i"),
  );
  if (!action) return null;
  return {
    kind: action[1] as "refresh" | "cancel" | "qr",
    contextId: action[2] ?? "",
  };
}

export function telegramFundingCallbackData(input: {
  choiceToken?: string;
  contextId: string;
  kind: TelegramFundingCallbackRoute["kind"];
}): string {
  const data =
    input.kind === "select"
      ? `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:select:${input.contextId}:${input.choiceToken ?? ""}`
      : `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:${input.kind}:${input.contextId}`;
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error("Telegram funding callback exceeds 64 bytes");
  }
  return data;
}
