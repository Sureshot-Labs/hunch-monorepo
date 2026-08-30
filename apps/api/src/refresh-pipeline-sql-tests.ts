import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const unusedIndexMigration = readFileSync(
  new URL(
    "../../../packages/db/migrations/0237_drop_confirmed_unused_indexes.sql",
    import.meta.url,
  ),
  "utf8",
);
const tokenMigration = readFileSync(
  new URL(
    "../../../packages/db/migrations/0239_incremental_token_change_24h.sql",
    import.meta.url,
  ),
  "utf8",
);
const activityMigration = readFileSync(
  new URL(
    "../../../packages/db/migrations/0240_incremental_activity_refresh.sql",
    import.meta.url,
  ),
  "utf8",
);

// No-transaction migrations are split on semicolons by the repository
// migrator, including semicolons inside line comments.
assert.doesNotMatch(unusedIndexMigration, /--[^\n]*;/);

assert.match(
  tokenMigration,
  /create table if not exists unified_refresh_pipeline_state/i,
);
assert.match(
  tokenMigration,
  /create or replace function refresh_unified_token_change_24h_full\(\)/i,
);
assert.match(
  tokenMigration,
  /hourly_top\.bucket > v_previous_current_watermark[\s\S]*hourly_top\.bucket <= v_current_watermark/i,
);
assert.match(
  tokenMigration,
  /hourly_top\.bucket > v_previous_baseline_watermark[\s\S]*hourly_top\.bucket <= v_baseline_watermark/i,
);
assert.match(
  tokenMigration,
  /pg_try_advisory_xact_lock\([\s\S]*unified_token_change_24h/i,
);
assert.match(
  tokenMigration,
  /refresh_unified_token_change_24h_full_job[\s\S]*interval '1 hour'/i,
);
assert.doesNotMatch(tokenMigration, /refresh_unified_market_change_24h/i);

assert.match(activityMigration, /v_previous_cutoff - interval '5 minutes'/i);
assert.match(
  activityMigration,
  /market_row\.updated_at_db > v_scan_from[\s\S]*market_row\.updated_at_db <= v_scan_until/i,
);
assert.match(activityMigration, /affected_event_keys as materialized/i);
assert.match(
  activityMigration,
  /prospective_market_snapshots as materialized/i,
);
assert.match(activityMigration, /aggregated_event_snapshots as materialized/i);

const changedMarketSection = activityMigration.match(
  /changed_market_snapshots as materialized \([\s\S]*?\),\s*affected_event_keys/i,
)?.[0];
assert.ok(changedMarketSection);
assert.doesNotMatch(
  changedMarketSection,
  /existing_snapshot\.source_updated_at is distinct from/i,
);

const incrementalJobSection = activityMigration.match(
  /create or replace function refresh_unified_market_activity_metrics_1h_job[\s\S]*$/i,
)?.[0];
assert.ok(incrementalJobSection);
assert.doesNotMatch(
  incrementalJobSection,
  /refresh_unified_event_activity_snapshots_1h/i,
);

console.log("refresh pipeline SQL tests passed");
