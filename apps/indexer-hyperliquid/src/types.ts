import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";

export type HyperliquidNetwork = "mainnet" | "testnet";

export type HyperliquidUnifiedSide = "YES" | "NO";

export interface HyperliquidSideSpec {
  name?: string;
  [key: string]: unknown;
}

export interface HyperliquidOutcome {
  outcome: number;
  name: string;
  description?: string;
  sideSpecs: HyperliquidSideSpec[];
  [key: string]: unknown;
}

export interface HyperliquidQuestion {
  question: number;
  name: string;
  description?: string;
  fallbackOutcome?: number;
  namedOutcomes?: number[];
  settledNamedOutcomes?: number[];
  [key: string]: unknown;
}

export interface HyperliquidOutcomeMetaResponse {
  outcomes: HyperliquidOutcome[];
  questions?: HyperliquidQuestion[];
}

export interface HyperliquidAssetContext {
  coin: string;
  prevDayPx?: string | null;
  dayNtlVlm?: string | null;
  markPx?: string | null;
  midPx?: string | null;
  circulatingSupply?: string | null;
  totalSupply?: string | null;
  dayBaseVlm?: string | null;
  [key: string]: unknown;
}

export type HyperliquidSpotMetaAndAssetCtxsResponse = [
  unknown,
  HyperliquidAssetContext[],
];

export interface HyperliquidBookLevel {
  px: string;
  sz: string;
  n?: number;
}

export interface HyperliquidL2Book {
  coin: string;
  time: number;
  levels: [HyperliquidBookLevel[], HyperliquidBookLevel[]];
}

export interface HyperliquidBboPayload {
  coin: string;
  time: number;
  bbo: [
    HyperliquidBookLevel | null | undefined,
    HyperliquidBookLevel | null | undefined,
  ];
}

export interface HyperliquidWsMessage {
  channel?: string;
  data?: unknown;
}

export interface HyperliquidTrade {
  coin: string;
  side: "A" | "B" | string;
  px: string;
  sz: string;
  time: number;
  hash?: string;
  tid?: number;
  users?: string[];
}

export interface HyperliquidCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n?: number;
}

export interface HyperliquidParsedDescription {
  structured: boolean;
  values: Record<string, string>;
  metadata?: Record<string, string>;
  class?: string;
  underlying?: string;
  expiry?: string;
  expiryTime?: Date;
  deadlineTime?: Date;
  deadlineSource?: string;
  deadlineText?: string;
  deadlineAssumption?: string;
  scheduledTime?: Date;
  scheduledSource?: string;
  scheduledText?: string;
  targetPrice?: number;
  priceThresholds?: number[];
  period?: string;
}

export interface HyperliquidSideAsset {
  outcomeId: string;
  sideIndex: number;
  sideName: string;
  outcomeSide: HyperliquidUnifiedSide;
  encoding: number;
  coin: string;
  tokenName: string;
  officialAssetId: number;
  hunchTokenId: string;
  context?: HyperliquidAssetContext;
}

export interface HyperliquidQuestionRow {
  question_id: string;
  title: string;
  description?: string;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  fallback_outcome_id?: string;
  named_outcome_ids: string[];
  settled_named_outcome_ids: string[];
  outcome_ids: string[];
  parsed_description: HyperliquidParsedDescription;
  category?: string;
  expiration_time?: Date;
  raw: HyperliquidQuestion;
}

export interface HyperliquidOutcomeRow {
  outcome_id: string;
  question_id?: string;
  name: string;
  description?: string;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  side_specs: HyperliquidSideSpec[];
  parsed_description: HyperliquidParsedDescription;
  category?: string;
  expiration_time?: Date;
  raw: HyperliquidOutcome;
}

export interface HyperliquidOutcomeAssetRow {
  outcome_id: string;
  side_index: number;
  side_name: string;
  outcome_side: HyperliquidUnifiedSide;
  encoding: number;
  coin: string;
  token_name: string;
  official_asset_id: number;
  hunch_token_id: string;
  mark_px?: number;
  mid_px?: number;
  prev_day_px?: number;
  day_ntl_vlm?: number;
  day_base_vlm?: number;
  circulating_supply?: number;
  total_supply?: number;
  raw?: HyperliquidAssetContext;
}

export interface HyperliquidMappedSnapshot {
  network: HyperliquidNetwork;
  questions: HyperliquidQuestionRow[];
  outcomes: HyperliquidOutcomeRow[];
  assets: HyperliquidOutcomeAssetRow[];
  events: UnifiedEventRow[];
  markets: UnifiedMarketRow[];
  tokens: Array<{
    token_id: string;
    market_id: string;
    side: HyperliquidUnifiedSide;
  }>;
  diagnostics: {
    outcomeCount: number;
    questionCount: number;
    eventCount: number;
    marketCount: number;
    tokenCount: number;
    standaloneOutcomeCount: number;
  };
}
