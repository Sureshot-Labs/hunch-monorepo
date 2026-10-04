import assert from "node:assert/strict";
import {
  fetchWalletActivitySummaries,
  fetchWalletActivitySummaryStats,
  fetchWalletActivityTopChanges,
} from "./services/wallet-activity-summary.js";
import {
  activityFixtureWalletIds,
  captureActivitySql,
} from "./wallet-activity-sql-fixtures.js";

const options = { windowHours: 24, topChanges: 3 };
const ids = activityFixtureWalletIds;
const full = await captureActivitySql((client) =>
  fetchWalletActivitySummaries(client, ids, options),
);
const top = await captureActivitySql((client) =>
  fetchWalletActivityTopChanges(client, ids, options),
);
const stats = await captureActivitySql((client) =>
  fetchWalletActivitySummaryStats(client, ids, options),
);
const page = await captureActivitySql((client) =>
  fetchWalletActivitySummaryStats(client, ids, options, {
    limit: 2,
    offset: 1,
  }),
);

assert.doesNotMatch(full.sql, /ranked_window|enrichment_rank/);
assert.match(top.sql, /rank\(\) over/);
assert.doesNotMatch(top.sql, /row_number\(\)[\s\S]*from events_window_all/);
assert.match(
  top.sql,
  /events_window as materialized[\s\S]*enrichment_rank <= \$4/,
);
assert.ok(
  top.sql.indexOf("enrichment_rank <= $4") < top.sql.indexOf("enriched as"),
);
assert.match(top.sql, /history_events[\s\S]*from wallet_activity_hourly/);
assert.deepEqual(top.params, full.params);
assert.doesNotMatch(stats.sql, /paged_summary|limit \$4/);
assert.match(stats.sql, /left join baseline b/);
assert.match(page.sql, /paged_summary as materialized/);
assert.match(page.sql, /date_trunc\('milliseconds', last_activity_at\) desc/);
assert.match(
  page.sql,
  /abs\(net_change_usd::double precision\) end desc, wallet_id/,
);
assert.match(page.sql, /in \('NaN', 'Infinity', '-Infinity'\) then 0/);
assert.ok(
  page.sql.indexOf("limit $4") <
    page.sql.indexOf("left join wallet_activity_baseline"),
);
assert.deepEqual(page.params.slice(0, 3), stats.params);
assert.deepEqual(page.params.slice(3), [2, 1]);
console.log("wallet activity SQL scope/parameter checks passed");
