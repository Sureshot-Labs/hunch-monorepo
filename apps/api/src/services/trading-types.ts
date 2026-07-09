export type TradingVenue = "kalshi" | "limitless" | "polymarket";
export type ExternalTradingVenue = string & {
  readonly __externalTradingVenue: unique symbol;
};

export type TradeActorKind = "admin_test" | "telegram_bot" | "web_app" | "worker";

export type TradeActor = {
  kind: TradeActorKind;
  userId: string;
  telegramUserId?: string | null;
  authorizationId?: string | null;
  source?: string | null;
};

export type TradeSide = "BUY" | "SELL";
export type TradeOutcomeSide = "NO" | "YES";
export type TradeOrderType = "FAK" | "FOK" | "GTC" | "GTD" | "market";

export type TradeAmount =
  | { type: "raw"; value: string }
  | { type: "shares"; value: string }
  | { type: "usd"; value: string };

export type VenueTradingCapabilities = {
  venue: TradingVenue;
  supportsBuy: boolean;
  supportsSell: boolean;
  supportsCancel: boolean;
  supportsOrderSync: boolean;
  supportsPositionSync: boolean;
  supportsExecutionSync: boolean;
  supportsSetup: boolean;
  authorizationModes: PreparedTradeAuthorizationMode[];
  notes?: string[];
};

export type TradeTarget = {
  venue: TradingVenue;
  marketId: string | null;
  venueMarketId: string | null;
  eventId: string | null;
  tokenId: string | null;
  outcome: TradeOutcomeSide | string | null;
  title: string | null;
  raw?: unknown;
};

export type TradingReadinessInput = {
  actor: TradeActor;
  venue: TradingVenue;
  executionAuthorization?: TradeExecutionAuthorization | null;
  privyWalletId?: string | null;
  walletAddress: string | null;
  walletChain?: "ethereum" | "solana" | string | null;
  target?: TradeTarget | null;
  action?: TradeSide | null;
  raw?: unknown;
};

export type KalshiTradeEligibility = {
  checkedAt: string | null;
  expiresAt: string | null;
  geoAllowed: boolean | null;
  proofVerified: boolean | null;
};

export type TradeExecutionAuthorization = {
  kalshiEligibility?: KalshiTradeEligibility | null;
  privyWalletId?: string | null;
};

export type TradingReadiness = {
  ready: boolean;
  executable: boolean;
  reasonCode: string | null;
  message: string | null;
  setupRequired: boolean;
  capabilities: VenueTradingCapabilities;
  raw?: unknown;
};

export type TradeIntent = {
  id?: string | null;
  actor: TradeActor;
  venue: TradingVenue;
  target: TradeTarget;
  executionAuthorization?: TradeExecutionAuthorization | null;
  walletAddress: string;
  walletChain?: "ethereum" | "solana" | string | null;
  action: TradeSide;
  outcome?: TradeOutcomeSide | string | null;
  amount: TradeAmount;
  orderType?: TradeOrderType | null;
  limitPrice?: number | null;
  slippageBps?: number | null;
  idempotencyKey: string;
  raw?: unknown;
};

export type TradeQuoteInput = {
  intent: TradeIntent;
  now?: Date;
};

export type TradeQuote = {
  venue: TradingVenue;
  target: TradeTarget;
  action: TradeSide;
  amount: TradeAmount;
  price: number | null;
  estimatedShares: number | null;
  estimatedNotionalUsd: number | null;
  maxSpendUsd: number | null;
  minReceiveShares: number | null;
  fees: Record<string, unknown>;
  expiresAt: Date | null;
  raw?: unknown;
};

export type PreparedTradeAuthorizationMode =
  | "client_signed_order"
  | "client_signed_transaction"
  | "embedded_privy"
  | "embedded_privy_evm"
  | "embedded_privy_solana"
  | "server_delegated"
  | "unsupported";

export type PreparedAuthorizationRequest = {
  id: string;
  label: string;
  input?: unknown;
};

export type PrepareTradeInput = {
  intent: TradeIntent;
  quote?: TradeQuote | null;
  now?: Date;
};

export type PreparedTrade = {
  preparedId: string;
  venue: TradingVenue;
  intent: TradeIntent;
  quote: TradeQuote | null;
  authorizationMode: PreparedTradeAuthorizationMode;
  authorizationRequests: PreparedAuthorizationRequest[];
  reconcileKeys: Record<string, unknown>;
  venuePayload: unknown;
  expiresAt: Date | null;
};

export type SubmitPreparedTradeInput = {
  onBeforeBroadcast?: () => Promise<void> | void;
  prepared: PreparedTrade;
  signatures?: Array<{ id: string; signature: string }>;
  now?: Date;
};

export type SubmitResultStatus =
  | "cancelled"
  | "failed"
  | "filled"
  | "no_fill"
  | "open"
  | "submitted";

export type SubmitResult = {
  venue: TradingVenue;
  status: SubmitResultStatus;
  venueOrderId: string | null;
  orderHash: string | null;
  txSignature: string | null;
  price: number | null;
  size: number | null;
  raw?: unknown;
};

export type PersistTradeInput = {
  intent: TradeIntent;
  prepared?: PreparedTrade | null;
  submitResult: SubmitResult;
};

export type PersistedTrade = {
  venue: TradingVenue;
  orderId: string | null;
  executionId: string | null;
  venueOrderId: string | null;
  status: string;
  raw?: unknown;
};

export type ApplyTradeEffectsInput = {
  intent: TradeIntent;
  persisted: PersistedTrade;
  submitResult: SubmitResult;
};

export type TradeEffectsResult = {
  ok: boolean;
  notificationsCreated?: number;
  referralFirstTrade?: unknown;
  positionDeltaApplied?: boolean;
  raw?: unknown;
};

export type ExecutedPreparedTradeError = {
  code: string;
  message: string;
  statusCode: number;
};

export type ExecutePreparedTradeInput = {
  onBeforeBroadcast?: () => Promise<void> | void;
  onSubmitted?: (submitResult: SubmitResult) => Promise<void> | void;
  prepared: PreparedTrade;
  signatures?: Array<{ id: string; signature: string }>;
  now?: Date;
};

export type ExecutedPreparedTrade = {
  submitResult: SubmitResult;
  persisted: PersistedTrade | null;
  effects: TradeEffectsResult | null;
  postSubmitError: ExecutedPreparedTradeError | null;
};

export type TradingErrorCode =
  | "insufficient_readiness"
  | "invalid_trade_request"
  | "quote_unavailable"
  | "trade_submission_failed"
  | "unsupported_capability"
  | string;

export type TradingError = {
  code: TradingErrorCode;
  message: string;
  statusCode: number;
  venue?: TradingVenue | null;
  raw?: unknown;
};
