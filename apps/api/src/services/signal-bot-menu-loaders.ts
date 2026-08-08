import type * as TelegramBotMenuActions from "./telegram-bot-menu-actions.js";
import type { SignalBotMarketSearchResult } from "./telegram-bot-menu-markets.js";
import type { TelegramBotRewardsMenuDependencies } from "./telegram-bot-rewards-menu.js";
import type {
  TelegramBotMenuDeliveryOutcome,
  TelegramBotMenuMessage,
} from "./telegram-bot-menu-delivery.js";

export type SignalBotMenuLoaders = TelegramBotRewardsMenuDependencies & {
  completeTradeInput?: (input: {
    chatId: string;
    contextId: string;
    telegramMessageId: number;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: number;
    value: string;
  }) => Promise<{ completed: boolean; message: TelegramBotMenuMessage }>;
  loadAccountValue?: (input: {
    chatId: string;
    telegramUserId: number;
  }) => Promise<TelegramBotMenuMessage>;
  onAccountValueError?: (error: unknown) => void;
  loadDeposit?: TelegramBotMenuActions.SignalBotInteractiveMenuLoaders["deposit"];
  loadFunding?: TelegramBotMenuActions.SignalBotInteractiveMenuLoaders["funding"];
  loadMarketCard?: (input: {
    chatId: string;
    context?: {
      observedNoAsk?: number | null;
      observedYesAsk?: number | null;
      origin: "search";
      returnCallbackData: string;
    };
    marketRef: string;
    publicBrowseOnly?: boolean;
    telegramMessageId: number | null;
    telegramUserId: number;
  }) => Promise<TelegramBotMenuMessage>;
  loadPositionCard?: (input: {
    messageId: number;
    positionId: string;
    telegramUserId: number;
  }) => Promise<TelegramBotMenuMessage>;
  loadPositions?: (telegramUserId: number) => Promise<TelegramBotMenuMessage>;
  loadTradeStatus?: (telegramUserId: number) => Promise<TelegramBotMenuMessage>;
  onFundingMenuDelivery?: (input: {
    action: TelegramBotMenuActions.SignalBotFundingMenuAction;
    outcome: TelegramBotMenuDeliveryOutcome;
    retryAfterSec?: number;
  }) => void;
  onFundingMenuOperationError?: (input: {
    action: TelegramBotMenuActions.SignalBotFundingMenuAction;
    errorCode: "unexpected_error";
  }) => void;
  searchMarkets?: (input: {
    query?: string | null;
  }) => Promise<SignalBotMarketSearchResult[]>;
};
