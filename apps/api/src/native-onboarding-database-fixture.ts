import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";

/** Only an explicitly selected disposable database; all objects live in a fresh schema. */
export async function nativeOnboardingDatabase(
  createPool: typeof createIntegrationTestPool = createIntegrationTestPool,
) {
  const schema = `native_onboarding_${randomUUID().replaceAll("-", "")}`;
  const pool = await createPool({
    max: 8,
    options: `-c search_path=${schema},public -c statement_timeout=120000 -c jit=off`,
  });
  await pool.query(`create schema ${schema}`);
  await pool.query(`
    create type unified_status as enum('ACTIVE','CLOSED','SETTLED','ARCHIVED');
    create table users(id uuid primary key default gen_random_uuid(),display_name text,handle text,bio text,avatar_url text,avatar_asset_id uuid,is_active boolean default true,social_suspended_at timestamptz,created_at timestamptz default now());
    create table user_sessions(id uuid primary key,user_id uuid references users(id) on delete cascade,is_active boolean default true,expires_at timestamptz default now()+interval '1 day');
    create table content_assets(id uuid primary key,public_url text,status text);
    create table user_follows(follower_user_id uuid references users(id) on delete cascade,followed_user_id uuid references users(id) on delete cascade,created_at timestamptz default now(),primary key(follower_user_id,followed_user_id));
    create table user_blocks(blocker_user_id uuid references users(id) on delete cascade,blocked_user_id uuid references users(id) on delete cascade,primary key(blocker_user_id,blocked_user_id));
    create table unified_markets(id text primary key,event_id text,venue text,title text,category text,status unified_status default 'ACTIVE',metadata jsonb,expiration_time timestamptz,close_time timestamptz,resolved_outcome text,resolved_outcome_pct numeric,created_at timestamptz,created_at_db timestamptz default now());
    create table unified_tokens(token_id text primary key,market_id text references unified_markets(id),side text,venue text);
    create table unified_market_tokens(token_id text primary key,market_id text,outcome_side text,updated_at timestamptz default now());
    create index fixture_market_tokens on unified_market_tokens(market_id,outcome_side,updated_at desc,token_id);
    create table unified_token_top_latest(token_id text primary key,best_bid numeric,best_ask numeric,ts timestamptz default now());
    create table unified_token_change_24h(token_id text primary key,avg_mid_24h numeric,bucket_24h timestamptz default date_trunc('hour',now()-interval '24 hours'),updated_at timestamptz default now());
    create table polymarket_asset_bindings(chain_id integer,asset_id text,position_contract text,market_id text,outcome_index integer,primary key(chain_id,asset_id,position_contract));
    create table positions(id uuid primary key default gen_random_uuid(),user_id uuid references users(id) on delete cascade,token_id text,venue text,position_contract text,position_scope text default 'own',size numeric default 1,is_hidden boolean default false);
    create table notifications(id uuid primary key default gen_random_uuid(),user_id uuid references users(id) on delete cascade,type text,title text,body text,data jsonb,created_at timestamptz default now());
    create table user_theses(id uuid primary key default gen_random_uuid(),author_id uuid references users(id) on delete set null,market_id text references unified_markets(id),event_id text,outcome text default 'YES',instrument_generation text,token_id text,expiry timestamptz,body text default 'A verified Hunch',published_at timestamptz default now(),author_hidden_at timestamptz,moderation_hidden_at timestamptz,proof_invalidated_at timestamptz);
    create index user_theses_author_page on user_theses(author_id,published_at desc,id desc);
    create index user_theses_author_public_page on user_theses(author_id,published_at desc,id desc) where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
    create table runtime_policies(id uuid primary key default gen_random_uuid(),policy_key text,payload jsonb,effective_at timestamptz,created_at timestamptz default now());
  `);
  for (const file of [
    "0282_native_push.sql",
    "0283_native_push_source_indexes.sql",
    "0284_social_trader_rankings.sql",
    "0285_native_onboarding_race_safety.sql",
    "0286_trader_statistics_pending.sql",
  ]) {
    const sql = await readFile(
      new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
      "utf8",
    );
    if (file.includes("source_indexes")) {
      for (const statement of sql.split(";").filter((value) => value.trim()))
        await pool.query(statement);
    } else await pool.query(sql);
  }
  const statements = new Map<string, unknown[]>();
  const firstStatements = new Map<string, unknown[]>();
  function record(sql: string, values: unknown[]) {
    statements.set(sql, values);
    if (!firstStatements.has(sql)) firstStatements.set(sql, values);
  }
  const db = {
    async query(sql: string, values: unknown[] = []) {
      record(sql, values);
      return pool.query(sql, values);
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values: unknown[] = []) {
          record(sql, values);
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  return {
    db,
    pool,
    schema,
    statements,
    firstStatements,
    async close() {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    },
  };
}
