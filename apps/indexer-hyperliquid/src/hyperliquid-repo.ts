import type { Pool, PoolClient } from "pg";
import {
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
  upsertUnifiedTokens,
} from "@hunch/db";
import type {
  HyperliquidMappedSnapshot,
  HyperliquidOutcomeAssetRow,
  HyperliquidOutcomeRow,
  HyperliquidQuestionRow,
} from "./types.js";

type Queryable = Pick<Pool | PoolClient, "query">;

function serializeDate(value: Date | undefined): string | undefined {
  return value?.toISOString();
}

function questionPayload(rows: HyperliquidQuestionRow[]) {
  return rows.map((row) => ({
    question_id: row.question_id,
    title: row.title,
    description: row.description,
    status: row.status,
    fallback_outcome_id: row.fallback_outcome_id,
    named_outcome_ids: row.named_outcome_ids,
    settled_named_outcome_ids: row.settled_named_outcome_ids,
    outcome_ids: row.outcome_ids,
    parsed_description: row.parsed_description,
    category: row.category,
    expiration_time: serializeDate(row.expiration_time),
    raw: row.raw,
  }));
}

function outcomePayload(rows: HyperliquidOutcomeRow[]) {
  return rows.map((row) => ({
    outcome_id: row.outcome_id,
    question_id: row.question_id,
    name: row.name,
    description: row.description,
    status: row.status,
    side_specs: row.side_specs,
    parsed_description: row.parsed_description,
    category: row.category,
    expiration_time: serializeDate(row.expiration_time),
    raw: row.raw,
  }));
}

function assetPayload(rows: HyperliquidOutcomeAssetRow[]) {
  return rows.map((row) => ({
    outcome_id: row.outcome_id,
    side_index: row.side_index,
    side_name: row.side_name,
    outcome_side: row.outcome_side,
    encoding: row.encoding,
    coin: row.coin,
    token_name: row.token_name,
    official_asset_id: row.official_asset_id,
    hunch_token_id: row.hunch_token_id,
    mark_px: row.mark_px,
    mid_px: row.mid_px,
    prev_day_px: row.prev_day_px,
    day_ntl_vlm: row.day_ntl_vlm,
    day_base_vlm: row.day_base_vlm,
    circulating_supply: row.circulating_supply,
    total_supply: row.total_supply,
    raw: row.raw,
  }));
}

export async function upsertHyperliquidRawSnapshot(
  pool: Queryable,
  snapshot: HyperliquidMappedSnapshot,
): Promise<void> {
  if (snapshot.questions.length > 0) {
    await pool.query(
      `
          with input as (
            select *
            from jsonb_to_recordset($1::jsonb) as x(
              question_id text,
              title text,
              description text,
              status text,
              fallback_outcome_id text,
              named_outcome_ids text[],
              settled_named_outcome_ids text[],
              outcome_ids text[],
              parsed_description jsonb,
              category text,
              expiration_time timestamptz,
              raw jsonb
            )
          )
          insert into hyperliquid_questions (
            question_id, title, description, status, fallback_outcome_id,
            named_outcome_ids, settled_named_outcome_ids, outcome_ids,
            parsed_description, category, expiration_time, raw, updated_at
          )
          select
            question_id, title, description, status, fallback_outcome_id,
            named_outcome_ids, settled_named_outcome_ids, outcome_ids,
            parsed_description, category, expiration_time, raw, now()
          from input
          on conflict (question_id) do update set
            title = excluded.title,
            description = excluded.description,
            status = excluded.status,
            fallback_outcome_id = excluded.fallback_outcome_id,
            named_outcome_ids = excluded.named_outcome_ids,
            settled_named_outcome_ids = excluded.settled_named_outcome_ids,
            outcome_ids = excluded.outcome_ids,
            parsed_description = excluded.parsed_description,
            category = excluded.category,
            expiration_time = excluded.expiration_time,
            raw = excluded.raw,
            updated_at = now()
          where
            (hyperliquid_questions.title, hyperliquid_questions.description,
             hyperliquid_questions.status, hyperliquid_questions.fallback_outcome_id,
             hyperliquid_questions.named_outcome_ids,
             hyperliquid_questions.settled_named_outcome_ids,
             hyperliquid_questions.outcome_ids,
             hyperliquid_questions.parsed_description,
             hyperliquid_questions.category, hyperliquid_questions.expiration_time,
             hyperliquid_questions.raw)
            is distinct from
            (excluded.title, excluded.description, excluded.status,
             excluded.fallback_outcome_id, excluded.named_outcome_ids,
             excluded.settled_named_outcome_ids, excluded.outcome_ids,
             excluded.parsed_description, excluded.category,
             excluded.expiration_time, excluded.raw)
        `,
      [JSON.stringify(questionPayload(snapshot.questions))],
    );
  }

  if (snapshot.outcomes.length > 0) {
    await pool.query(
      `
          with input as (
            select *
            from jsonb_to_recordset($1::jsonb) as x(
              outcome_id text,
              question_id text,
              name text,
              description text,
              status text,
              side_specs jsonb,
              parsed_description jsonb,
              category text,
              expiration_time timestamptz,
              raw jsonb
            )
          )
          insert into hyperliquid_outcomes (
            outcome_id, question_id, name, description, status, side_specs,
            parsed_description, category, expiration_time, raw, updated_at
          )
          select
            outcome_id, question_id, name, description, status, side_specs,
            parsed_description, category, expiration_time, raw, now()
          from input
          on conflict (outcome_id) do update set
            question_id = excluded.question_id,
            name = excluded.name,
            description = excluded.description,
            status = excluded.status,
            side_specs = excluded.side_specs,
            parsed_description = excluded.parsed_description,
            category = excluded.category,
            expiration_time = excluded.expiration_time,
            raw = excluded.raw,
            updated_at = now()
          where
            (hyperliquid_outcomes.question_id, hyperliquid_outcomes.name,
             hyperliquid_outcomes.description, hyperliquid_outcomes.status,
             hyperliquid_outcomes.side_specs,
             hyperliquid_outcomes.parsed_description,
             hyperliquid_outcomes.category, hyperliquid_outcomes.expiration_time,
             hyperliquid_outcomes.raw)
            is distinct from
            (excluded.question_id, excluded.name, excluded.description,
             excluded.status, excluded.side_specs, excluded.parsed_description,
             excluded.category, excluded.expiration_time, excluded.raw)
        `,
      [JSON.stringify(outcomePayload(snapshot.outcomes))],
    );
  }

  if (snapshot.assets.length > 0) {
    await pool.query(
      `
          with input as (
            select *
            from jsonb_to_recordset($1::jsonb) as x(
              outcome_id text,
              side_index int,
              side_name text,
              outcome_side text,
              encoding bigint,
              coin text,
              token_name text,
              official_asset_id bigint,
              hunch_token_id text,
              mark_px numeric,
              mid_px numeric,
              prev_day_px numeric,
              day_ntl_vlm numeric,
              day_base_vlm numeric,
              circulating_supply numeric,
              total_supply numeric,
              raw jsonb
            )
          )
          insert into hyperliquid_outcome_assets (
            outcome_id, side_index, side_name, outcome_side, encoding, coin,
            token_name, official_asset_id, hunch_token_id, mark_px, mid_px,
            prev_day_px, day_ntl_vlm, day_base_vlm, circulating_supply,
            total_supply, raw, updated_at
          )
          select
            outcome_id, side_index, side_name, outcome_side, encoding, coin,
            token_name, official_asset_id, hunch_token_id, mark_px, mid_px,
            prev_day_px, day_ntl_vlm, day_base_vlm, circulating_supply,
            total_supply, raw, now()
          from input
          on conflict (outcome_id, side_index) do update set
            side_name = excluded.side_name,
            outcome_side = excluded.outcome_side,
            encoding = excluded.encoding,
            coin = excluded.coin,
            token_name = excluded.token_name,
            official_asset_id = excluded.official_asset_id,
            hunch_token_id = excluded.hunch_token_id,
            mark_px = excluded.mark_px,
            mid_px = excluded.mid_px,
            prev_day_px = excluded.prev_day_px,
            day_ntl_vlm = excluded.day_ntl_vlm,
            day_base_vlm = excluded.day_base_vlm,
            circulating_supply = excluded.circulating_supply,
            total_supply = excluded.total_supply,
            raw = excluded.raw,
            updated_at = now()
          where
            (hyperliquid_outcome_assets.side_name,
             hyperliquid_outcome_assets.outcome_side,
             hyperliquid_outcome_assets.encoding,
             hyperliquid_outcome_assets.coin,
             hyperliquid_outcome_assets.token_name,
             hyperliquid_outcome_assets.official_asset_id,
             hyperliquid_outcome_assets.hunch_token_id,
             hyperliquid_outcome_assets.mark_px,
             hyperliquid_outcome_assets.mid_px,
             hyperliquid_outcome_assets.prev_day_px,
             hyperliquid_outcome_assets.day_ntl_vlm,
             hyperliquid_outcome_assets.day_base_vlm,
             hyperliquid_outcome_assets.circulating_supply,
             hyperliquid_outcome_assets.total_supply,
             hyperliquid_outcome_assets.raw)
            is distinct from
            (excluded.side_name, excluded.outcome_side, excluded.encoding,
             excluded.coin, excluded.token_name, excluded.official_asset_id,
             excluded.hunch_token_id, excluded.mark_px, excluded.mid_px,
             excluded.prev_day_px, excluded.day_ntl_vlm, excluded.day_base_vlm,
             excluded.circulating_supply, excluded.total_supply, excluded.raw)
        `,
      [JSON.stringify(assetPayload(snapshot.assets))],
    );
  }
}

export async function persistHyperliquidSnapshot(
  pool: Pool,
  snapshot: HyperliquidMappedSnapshot,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await upsertHyperliquidRawSnapshot(client, snapshot);
    await upsertUnifiedEvents(client, snapshot.events);
    await upsertUnifiedMarkets(client, snapshot.markets);
    await upsertUnifiedTokens(client, snapshot.tokens);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
