import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import type { TelegramFundingRoutePresentation } from "./telegram-funding-route.js";
import type { FundingReceiveReviewContinuation } from "../funding/domain/types.js";

export const TELEGRAM_FUNDING_CALLBACK_PREFIX = "hm:v1:fund";

export type TelegramFundingProgressState =
  | "waiting_for_transfer"
  | "funds_received"
  | "waiting_for_routing"
  | "converting"
  | "ready"
  | "expired"
  | "cancelled"
  | "unavailable"
  | "needs_attention";

export type TelegramFundingSourceReceiptState =
  | "queued"
  | "converting"
  | "ready"
  | "needs_attention";

export type TelegramFundingReceiptBreakdown = Readonly<{
  sourceAssetSymbol: string;
  sourceDecimals: number;
  totalSourceRaw: string;
  queuedSourceRaw: string;
  convertingSourceRaw: string;
  readySourceRaw: string;
  attentionSourceRaw: string;
  sourceReceiptCount: number;
  destinationAssetSymbol: string;
  destinationDecimals: number;
  readyDestinationRaw: string;
  destinationReceiptCount: number;
  transfers: readonly Readonly<{
    rawAmount: string;
    state: TelegramFundingSourceReceiptState;
  }>[];
  hiddenTransferCount: number;
}>;

export type TelegramFundingProgressProjection = Readonly<{
  version: 2;
  fundingContextId: string;
  state: TelegramFundingProgressState;
  terminal: boolean;
  presentation: TelegramFundingRoutePresentation;
  assetSymbol: string;
  rawAmount: string | null;
  receiveAddress: string | null;
  expiresAt: string;
  observedAt: string | null;
  automaticConversionEnabled?: boolean;
  automaticConversionPaused?: boolean;
  sourceAssetSymbol?: string;
  sourceRawAmount?: string | null;
  receiptBreakdown?: TelegramFundingReceiptBreakdown;
  minimumFundingUsd?: string;
  reviewContinuation?: FundingReceiveReviewContinuation;
  reviewReceiptId?: string;
  returnToMarketAvailable?: boolean;
}>;

export type TelegramFundingMessage = TelegramBotTradingClientMessage & {
  fundingContextId?: string;
  qrPresentation?: Readonly<{
    assetLabel: string;
    instructions: readonly string[];
    networkLabel: string;
  }>;
  qrText?: string;
  venue?: string;
  /** Address-bearing funding output may only be rendered by the durable outbox. */
  durableFundingDeliveryRequired?: boolean;
};

export type TelegramFundingCallbackRoute =
  | Readonly<{ contextId: string; kind: "cancel" }>
  | Readonly<{ contextId: string; kind: "back_to_market" }>
  | Readonly<{ contextId: string; kind: "hide_qr" }>
  | Readonly<{ contextId: string; kind: "qr" }>
  | Readonly<{ contextId: string; kind: "refresh" }>
  | Readonly<{ contextId: string; kind: "targets" }>
  | Readonly<{ receiptId: string; kind: "review_conversion" }>
  | Readonly<{ consentToken: string; kind: "confirm_conversion" }>
  | Readonly<{ continuationToken: string; kind: "review_buy" }>
  | Readonly<{ continuationToken: string; kind: "change_buy_amount" }>
  | Readonly<{ choiceToken: string; contextId: string; kind: "select" }>;

const UUID =
  "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const CONTINUATION_TOKEN = "([A-Za-z0-9_-]{22})";

export function parseTelegramFundingCallbackRoute(
  route: string,
): TelegramFundingCallbackRoute | null {
  const changeBuyAmount = route.match(
    new RegExp(`^fund:amount:${CONTINUATION_TOKEN}$`),
  );
  if (changeBuyAmount) {
    return {
      kind: "change_buy_amount",
      continuationToken: changeBuyAmount[1] ?? "",
    };
  }
  const reviewBuy = route.match(
    new RegExp(`^fund:review:${CONTINUATION_TOKEN}$`),
  );
  if (reviewBuy) {
    return {
      kind: "review_buy",
      continuationToken: reviewBuy[1] ?? "",
    };
  }
  const confirmConversion = route.match(
    /^fund:c:(consent_[A-Za-z0-9_-]{43})$/u,
  );
  if (confirmConversion) {
    return {
      kind: "confirm_conversion",
      consentToken: confirmConversion[1] ?? "",
    };
  }
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
    new RegExp(
      `^fund:(refresh|cancel|market|qr|hide|targets|convert):${UUID}$`,
      "i",
    ),
  );
  if (!action) return null;
  return action[1] === "convert"
    ? { kind: "review_conversion", receiptId: action[2] ?? "" }
    : action[1] === "market"
      ? { kind: "back_to_market", contextId: action[2] ?? "" }
      : action[1] === "hide"
        ? { kind: "hide_qr", contextId: action[2] ?? "" }
        : {
            kind: action[1] as "refresh" | "cancel" | "qr" | "targets",
            contextId: action[2] ?? "",
          };
}

export function telegramFundingCallbackData(
  input: TelegramFundingCallbackRoute,
): string {
  const data =
    input.kind === "confirm_conversion"
      ? `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:c:${input.consentToken}`
      : input.kind === "change_buy_amount"
        ? `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:amount:${input.continuationToken}`
        : input.kind === "review_buy"
          ? `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:review:${input.continuationToken}`
          : input.kind === "select"
            ? `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:select:${input.contextId}:${input.choiceToken}`
            : input.kind === "review_conversion"
              ? `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:convert:${input.receiptId}`
              : `${TELEGRAM_FUNDING_CALLBACK_PREFIX}:${
                  input.kind === "hide_qr"
                    ? "hide"
                    : input.kind === "back_to_market"
                      ? "market"
                      : input.kind
                }:${input.contextId}`;
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error("Telegram funding callback exceeds 64 bytes");
  }
  return data;
}

export function shouldDeleteTelegramFundingQr(
  projection: TelegramFundingProgressProjection,
): boolean {
  return (
    projection.receiveAddress === null &&
    (projection.terminal || projection.observedAt !== null)
  );
}
