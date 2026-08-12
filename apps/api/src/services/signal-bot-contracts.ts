import type { SignalBotFollowthroughDataQuality } from "./signal-bot-followthrough-policy.js";
import type {
  HolderResearchUpdateV1,
  SignalPriceSnapshotV1,
  TelegramMarketIdentityV1,
} from "./signal-publication-contract.js";
import type { TelegramInputRichMessage } from "./telegram-rich-message.js";

export type TelegramInlineKeyboardButton = (
  | {
      copy_text: { text: string };
      text: string;
      url?: never;
      web_app?: never;
    }
  | {
      text: string;
      url: string;
      web_app?: never;
    }
  | {
      text: string;
      url?: never;
      web_app: { url: string };
    }
  | {
      callback_data: string;
      text: string;
      url?: never;
      web_app?: never;
    }
) & { icon_custom_emoji_id?: string };

export type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<TelegramInlineKeyboardButton>>;
};

export type TelegramSendMessageInput = {
  chat_id: string;
  disable_web_page_preview: boolean;
  parse_mode?: "MarkdownV2";
  reply_parameters?: {
    allow_sending_without_reply?: boolean;
    message_id: number;
  };
  reply_markup?: TelegramInlineKeyboard;
  text: string;
};

export type TelegramSendRichMessageInput = {
  chat_id: string;
  reply_parameters?: {
    allow_sending_without_reply?: boolean;
    message_id: number;
  };
  reply_markup?: TelegramInlineKeyboard;
  rich_message: TelegramInputRichMessage;
};

export type TelegramSendResult =
  | { messageId: number | null; ok: true }
  | {
      error:
        | "ambiguous"
        | "blocked_or_missing"
        | "message_not_editable"
        | "other"
        | "reply_target_missing";
      message: string;
      ok: false;
      retryAfterSec?: number;
    };

export type TelegramMutationResult =
  | { ok: true }
  | Extract<TelegramSendResult, { ok: false }>;

export type SignalBotTelegramClient = {
  answerCallbackQuery(input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }): Promise<unknown>;
  getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]>;
  editMessageText?(input: {
    chat_id: string;
    disable_web_page_preview: boolean;
    message_id: number;
    parse_mode: "MarkdownV2";
    reply_markup?: TelegramInlineKeyboard;
    text: string;
  }): Promise<TelegramSendResult>;
  sendPhoto?(input: {
    caption?: string;
    chat_id: string;
    filename: string;
    parse_mode?: "MarkdownV2";
    photo: Uint8Array;
    reply_markup?: TelegramInlineKeyboard;
  }): Promise<TelegramSendResult>;
  sendRichMessage?(
    input: TelegramSendRichMessageInput,
  ): Promise<TelegramSendResult>;
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendResult>;
};

export type TelegramBotUpdate = {
  update_id: number;
  callback_query?: TelegramBotCallbackQuery;
  message?: TelegramBotMessage;
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

export type TelegramBotCallbackQuery = {
  id: string;
  from?: {
    id?: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  message?: TelegramBotMessage;
  data?: string;
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
  metrics?: Record<string, unknown>;
  holderResearchUpdateV1?: HolderResearchUpdateV1 | null;
  signalPriceSnapshotV1?: SignalPriceSnapshotV1 | null;
  telegramMarketIdentityV1?: TelegramMarketIdentityV1 | null;
  createdAt: string;
  revisionKind: "initial" | "research_update";
  meaningfulDeltaReasons?: string[];
  decisionSnapshot?: unknown;
  previousDecisionSnapshot?: unknown;
  thesisKey: string;
  thesisRootNoteId: string;
  primaryTargetMeta: Record<string, unknown>;
  marketId: string | null;
  eventId: string | null;
  marketVenue: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
  marketDescription: string | null;
  marketMetadata?: unknown;
  eventTitle: string | null;
  eventDescription: string | null;
  outcomes: string[] | null;
  resolutionSource: string | null;
  marketSegment: string | null;
  closeTime: string | null;
  expirationTime: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  holderAddress: string | null;
  holderChain: string | null;
  holderWalletId?: string | null;
  holderDisplayName?: string | null;
  holderIdentityDisplayName?: string | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderCredentialBullets: string[];
  holderClusterOpenPnlUsd: number | null;
  holderClusterPnl30dUsd: number | null;
  holderClusterSharpHolders: number | null;
  holderClusterSharpUsd: number | null;
};

export type SignalBotMessageKind =
  | "followthrough_stats"
  | "initial"
  | "research_update"
  | "resolved_loss"
  | "resolved_win";

export type SignalBotFollowthroughStats = {
  version: 1;
  evaluatedAt: string;
  threadRootNoteId: string;
  finalProbabilitySource:
    | "missing"
    | "resolved_outcome"
    | "resolved_outcome_pct"
    | "terminal_price";
  marketId: string;
  signalSide: "NO" | "YES" | null;
  state: "open" | "resolved" | "unknown";
  outcome: "loss" | "open" | "unknown" | "win";
  baselineAt: string;
  asOf: string;
  entryPrice: number | null;
  markPrice: number | null;
  priceMoveCents: number | null;
  joinedWallets: number;
  addedWallets: number;
  joinedOrAddedWallets: number;
  earlyWalletsCut: number;
  trimmedWallets: number;
  exitedWallets: number;
  stillHoldingWallets: number;
  missingBaselineSnapshots: number;
  netSignalSideFlowUsd: number;
  netOppositeSideFlowUsd: number;
  estimatedOpenPnlUsd: number | null;
  estimatedRealizedPnlUsd: number | null;
  dataQuality: SignalBotFollowthroughDataQuality;
  dataQualityTags: string[];
};

export type SignalBotFollowthroughCandidateRow = {
  chat_id: string;
  thread_root_note_id: string;
  reply_to_message_id: string | number | null;
  baseline_at: Date | string;
  title: string;
  direction: "down" | "mixed" | "up" | null;
  metrics: unknown;
  root_metrics: unknown;
  target_meta: unknown;
  market_id: string;
  event_id: string | null;
  market_title: string | null;
  market_slug: string | null;
  market_description: string | null;
  event_title: string | null;
  event_description: string | null;
  outcomes: string | null;
  resolution_source: string | null;
  venue: string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
  accepting_orders: boolean | null;
};

export type SignalBotDeliveryPreparationReason =
  | "editorial_compose_failed"
  | "identity_mismatch"
  | "missing_market_identity"
  | "missing_price_snapshot"
  | "missing_update_contract"
  | "non_directional"
  | "quote_refresh"
  | "stale_price_snapshot"
  | "unpublishable_copy";

export type SignalBotTestSignalOutcome = {
  reason: SignalBotDeliveryPreparationReason | "no_eligible_note" | null;
  sent: boolean;
};
