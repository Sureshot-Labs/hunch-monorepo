import { Pool } from "pg";
import { env } from "./env.js";
import { log } from "./log.js";
import type { TLimitlessMarket, TLimitlessMarketItem } from "./types.js";

const pool = new Pool({ connectionString: env.dbUrl });

export interface LimitlessEventRow {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  tags: string[];
  status: string;
  expired: boolean;
  creator_name: string | null;
  creator_image_uri: string | null;
  creator_link: string | null;
  logo: string | null;
  categories: string[];
  market_type: string;
  proxy_title: string | null;
  condition_id: string | null;
  is_rewardable: boolean;
  priority_index: number;
  expiration_date: string | null;
  expiration_timestamp: number | null;
  volume: string | null;
  volume_formatted: string | null;
  volume_total: number | null;
  trends_rank: number | null;
  trends_value: number | null;
  metadata_fee: boolean;
  metadata_is_bannered: boolean;
  metadata_is_poly_arbitrage: boolean;
  metadata_should_market_make: boolean;
  settings_c: string | null;
  settings_min_size: string | null;
  settings_max_spread: number | null;
  settings_daily_reward: string | null;
  settings_rewards_epoch: string | null;
  collateral_token_symbol: string | null;
  collateral_token_address: string | null;
  collateral_token_decimals: number;
  neg_risk_request_id: string | null;
  neg_risk_market_id: string | null;
  winning_outcome_index: number | null;
  og_image_uri: string | null;
  daily_reward: string | null;
  outcome_tokens: string[];
  trade_type: string;
  created_at: Date | null;
  updated_at: Date | null;
  raw: any;
}

export interface LimitlessMarketRow {
  id: string;
  event_id: string;
  slug: string | null;
  title: string;
  description: string | null;
  tags: string[];
  status: string;
  expired: boolean;
  creator_name: string | null;
  creator_image_uri: string | null;
  creator_link: string | null;
  logo: string | null;
  categories: string[];
  market_type: string;
  proxy_title: string | null;
  condition_id: string | null;
  is_rewardable: boolean;
  priority_index: number;
  expiration_date: string | null;
  expiration_timestamp: number | null;
  volume: string | null;
  volume_formatted: string | null;
  volume_total: number | null;
  prices: number[];
  tokens_no: string | null;
  tokens_yes: string | null;
  metadata_fee: boolean;
  metadata_is_bannered: boolean;
  metadata_is_poly_arbitrage: boolean;
  metadata_should_market_make: boolean;
  settings_c: string | null;
  settings_min_size: string | null;
  settings_max_spread: number | null;
  settings_daily_reward: string | null;
  settings_rewards_epoch: string | null;
  collateral_token_symbol: string | null;
  collateral_token_address: string | null;
  collateral_token_decimals: number;
  neg_risk_request_id: string | null;
  winning_outcome_index: number | null;
  trade_type: string;
  created_at: Date | null;
  updated_at: Date | null;
  raw: any;
}

export async function upsertLimitlessEvent(row: LimitlessEventRow): Promise<string> {
  const query = `
    INSERT INTO limitless_events (
      id, slug, title, description, tags, status, expired,
      creator_name, creator_image_uri, creator_link, logo, categories,
      market_type, proxy_title, condition_id, is_rewardable, priority_index,
      expiration_date, expiration_timestamp, volume, volume_formatted, volume_total,
      trends_rank, trends_value, metadata_fee, metadata_is_bannered,
      metadata_is_poly_arbitrage, metadata_should_market_make,
      settings_c, settings_min_size, settings_max_spread, settings_daily_reward,
      settings_rewards_epoch, collateral_token_symbol, collateral_token_address,
      collateral_token_decimals, neg_risk_request_id, neg_risk_market_id,
      winning_outcome_index, og_image_uri, daily_reward, outcome_tokens,
      trade_type, created_at, updated_at, raw
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
      $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46
    )
    ON CONFLICT (id) DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      tags = EXCLUDED.tags,
      status = EXCLUDED.status,
      expired = EXCLUDED.expired,
      creator_name = EXCLUDED.creator_name,
      creator_image_uri = EXCLUDED.creator_image_uri,
      creator_link = EXCLUDED.creator_link,
      logo = EXCLUDED.logo,
      categories = EXCLUDED.categories,
      market_type = EXCLUDED.market_type,
      proxy_title = EXCLUDED.proxy_title,
      condition_id = EXCLUDED.condition_id,
      is_rewardable = EXCLUDED.is_rewardable,
      priority_index = EXCLUDED.priority_index,
      expiration_date = EXCLUDED.expiration_date,
      expiration_timestamp = EXCLUDED.expiration_timestamp,
      volume = EXCLUDED.volume,
      volume_formatted = EXCLUDED.volume_formatted,
      volume_total = EXCLUDED.volume_total,
      trends_rank = EXCLUDED.trends_rank,
      trends_value = EXCLUDED.trends_value,
      metadata_fee = EXCLUDED.metadata_fee,
      metadata_is_bannered = EXCLUDED.metadata_is_bannered,
      metadata_is_poly_arbitrage = EXCLUDED.metadata_is_poly_arbitrage,
      metadata_should_market_make = EXCLUDED.metadata_should_market_make,
      settings_c = EXCLUDED.settings_c,
      settings_min_size = EXCLUDED.settings_min_size,
      settings_max_spread = EXCLUDED.settings_max_spread,
      settings_daily_reward = EXCLUDED.settings_daily_reward,
      settings_rewards_epoch = EXCLUDED.settings_rewards_epoch,
      collateral_token_symbol = EXCLUDED.collateral_token_symbol,
      collateral_token_address = EXCLUDED.collateral_token_address,
      collateral_token_decimals = EXCLUDED.collateral_token_decimals,
      neg_risk_request_id = EXCLUDED.neg_risk_request_id,
      neg_risk_market_id = EXCLUDED.neg_risk_market_id,
      winning_outcome_index = EXCLUDED.winning_outcome_index,
      og_image_uri = EXCLUDED.og_image_uri,
      daily_reward = EXCLUDED.daily_reward,
      outcome_tokens = EXCLUDED.outcome_tokens,
      trade_type = EXCLUDED.trade_type,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      raw = EXCLUDED.raw,
      updated_at_db = now()
    RETURNING id
  `;

  const values = [
    row.id, row.slug, row.title, row.description, row.tags, row.status, row.expired,
    row.creator_name, row.creator_image_uri, row.creator_link, row.logo, row.categories,
    row.market_type, row.proxy_title, row.condition_id, row.is_rewardable, row.priority_index,
    row.expiration_date, row.expiration_timestamp, row.volume, row.volume_formatted, row.volume_total,
    row.trends_rank, row.trends_value, row.metadata_fee, row.metadata_is_bannered,
    row.metadata_is_poly_arbitrage, row.metadata_should_market_make,
    row.settings_c, row.settings_min_size, row.settings_max_spread, row.settings_daily_reward,
    row.settings_rewards_epoch, row.collateral_token_symbol, row.collateral_token_address,
    row.collateral_token_decimals, row.neg_risk_request_id, row.neg_risk_market_id,
    row.winning_outcome_index, row.og_image_uri, row.daily_reward, row.outcome_tokens,
    row.trade_type, row.created_at, row.updated_at, row.raw
  ];

  try {
    const result = await pool.query(query, values);
    return result.rows[0].id;
  } catch (error) {
    log.err("Failed to upsert limitless event", { error, row });
    throw error;
  }
}

export async function upsertLimitlessMarket(row: LimitlessMarketRow): Promise<string> {
  const query = `
    INSERT INTO limitless_markets (
      id, event_id, slug, title, description, tags, status, expired,
      creator_name, creator_image_uri, creator_link, logo, categories,
      market_type, proxy_title, condition_id, is_rewardable, priority_index,
      expiration_date, expiration_timestamp, volume, volume_formatted, volume_total,
      prices, tokens_no, tokens_yes, metadata_fee, metadata_is_bannered,
      metadata_is_poly_arbitrage, metadata_should_market_make,
      settings_c, settings_min_size, settings_max_spread, settings_daily_reward,
      settings_rewards_epoch, collateral_token_symbol, collateral_token_address,
      collateral_token_decimals, neg_risk_request_id, winning_outcome_index,
      trade_type, created_at, updated_at, raw
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
      $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44
    )
    ON CONFLICT (id) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      tags = EXCLUDED.tags,
      status = EXCLUDED.status,
      expired = EXCLUDED.expired,
      creator_name = EXCLUDED.creator_name,
      creator_image_uri = EXCLUDED.creator_image_uri,
      creator_link = EXCLUDED.creator_link,
      logo = EXCLUDED.logo,
      categories = EXCLUDED.categories,
      market_type = EXCLUDED.market_type,
      proxy_title = EXCLUDED.proxy_title,
      condition_id = EXCLUDED.condition_id,
      is_rewardable = EXCLUDED.is_rewardable,
      priority_index = EXCLUDED.priority_index,
      expiration_date = EXCLUDED.expiration_date,
      expiration_timestamp = EXCLUDED.expiration_timestamp,
      volume = EXCLUDED.volume,
      volume_formatted = EXCLUDED.volume_formatted,
      volume_total = EXCLUDED.volume_total,
      prices = EXCLUDED.prices,
      tokens_no = EXCLUDED.tokens_no,
      tokens_yes = EXCLUDED.tokens_yes,
      metadata_fee = EXCLUDED.metadata_fee,
      metadata_is_bannered = EXCLUDED.metadata_is_bannered,
      metadata_is_poly_arbitrage = EXCLUDED.metadata_is_poly_arbitrage,
      metadata_should_market_make = EXCLUDED.metadata_should_market_make,
      settings_c = EXCLUDED.settings_c,
      settings_min_size = EXCLUDED.settings_min_size,
      settings_max_spread = EXCLUDED.settings_max_spread,
      settings_daily_reward = EXCLUDED.settings_daily_reward,
      settings_rewards_epoch = EXCLUDED.settings_rewards_epoch,
      collateral_token_symbol = EXCLUDED.collateral_token_symbol,
      collateral_token_address = EXCLUDED.collateral_token_address,
      collateral_token_decimals = EXCLUDED.collateral_token_decimals,
      neg_risk_request_id = EXCLUDED.neg_risk_request_id,
      winning_outcome_index = EXCLUDED.winning_outcome_index,
      trade_type = EXCLUDED.trade_type,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      raw = EXCLUDED.raw,
      updated_at_db = now()
    RETURNING id
  `;

  const values = [
    row.id, row.event_id, row.slug, row.title, row.description, row.tags, row.status, row.expired,
    row.creator_name, row.creator_image_uri, row.creator_link, row.logo, row.categories,
    row.market_type, row.proxy_title, row.condition_id, row.is_rewardable, row.priority_index,
    row.expiration_date, row.expiration_timestamp, row.volume, row.volume_formatted, row.volume_total,
    row.prices, row.tokens_no, row.tokens_yes, row.metadata_fee, row.metadata_is_bannered,
    row.metadata_is_poly_arbitrage, row.metadata_should_market_make,
    row.settings_c, row.settings_min_size, row.settings_max_spread, row.settings_daily_reward,
    row.settings_rewards_epoch, row.collateral_token_symbol, row.collateral_token_address,
    row.collateral_token_decimals, row.neg_risk_request_id, row.winning_outcome_index,
    row.trade_type, row.created_at, row.updated_at, row.raw
  ];

  try {
    const result = await pool.query(query, values);
    return result.rows[0].id;
  } catch (error) {
    log.err("Failed to upsert limitless market", { error, row });
    throw error;
  }
}

export async function closePool() {
  await pool.end();
}
