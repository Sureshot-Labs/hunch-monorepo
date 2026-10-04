import type { PoolClient } from "pg";

// Pure SELECT fixtures: these CTEs shadow every relation read by the activity
// queries. They can be parsed/tested without DDL or copying production data.
export const activityFixtureNow = "2026-10-04T12:00:00Z";
export const activityFixtureWalletIds = Array.from(
  { length: 9 },
  (_, index) =>
    `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
);

function relation(
  name: string,
  columns: string,
  rows: Record<string, unknown>[],
): string {
  const json = JSON.stringify(rows).replaceAll("'", "''");
  return `${name} as (
    select * from jsonb_to_recordset('${json}'::jsonb) as fixture_row(${columns})
  )`;
}

export function walletActivityFixturePrefix(boundaryTies = false): string {
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] =
    activityFixtureWalletIds;
  const activity = (
    walletId: string,
    marketId: string,
    amount: string | null,
    occurredAt = "2026-10-04T11:00:00.000123Z",
    overrides: Record<string, unknown> = {},
  ) => ({
    wallet_id: walletId,
    venue: "polymarket",
    market_id: marketId,
    outcome_side: "YES",
    activity_type: "trade",
    hour_bucket: "2026-10-04T11:00:00Z",
    last_occurred_at: occurredAt,
    signed_delta_shares: amount,
    signed_delta_usd: amount,
    abs_delta_usd: amount == null ? null : String(Math.abs(Number(amount))),
    max_abs_delta_usd: amount == null ? null : String(Math.abs(Number(amount))),
    last_price: "0.05",
    last_change_action: "INCREASED",
    entered_late: false,
    counts_opened: 1,
    counts_closed: 0,
    counts_increased: 1,
    counts_reduced: 0,
    ...overrides,
  });
  const activityRows = [
    activity(first, "large", "100000"),
    activity(first, "missing-market", "5000", "2026-10-04T10:59:00Z"),
    activity(first, "closed", "3000", "2026-10-04T10:58:00Z"),
    activity(first, "null-values", null, "2026-10-04T10:57:00Z"),
    // Prior markets/idle time must see ALL retained history, not the top-K.
    activity(first, "prior", "10", "2026-09-20T11:00:00Z", {
      hour_bucket: "2026-09-20T11:00:00Z",
    }),
    activity(first, "outside-retention", "10", "2026-08-01T11:00:00Z", {
      hour_bucket: "2026-08-01T11:00:00Z",
    }),
    activity(second, "negative", "-108000", "2026-10-04T11:00:00.000789Z", {
      outcome_side: "NO",
    }),
    activity(third, "cancel-positive", "500"),
    activity(third, "cancel-negative", "-500", "2026-10-04T10:59:00Z"),
    // Numeric differences that disappear after the existing JS Number parse.
    activity(fourth, "precision-a", "9007199254740992"),
    activity(fifth, "precision-b", "9007199254740993"),
    activity(sixth, "no-activity-time", "200", "2026-10-04T11:00:00Z", {
      last_occurred_at: null,
    }),
    activity(second, "ignored-holder", "1000000", undefined, {
      activity_type: "holder",
    }),
    activity(seventh, "non-finite", "Infinity"),
    activity(eighth, "not-a-number", "NaN"),
    ...(boundaryTies
      ? [
          activity(first, "tie-a", "5000", "2026-10-04T10:59:00Z"),
          activity(first, "tie-b", "5000", "2026-10-04T10:59:00Z"),
        ]
      : []),
  ];
  const markets = [
    ...new Map(
      activityRows
        .filter((row) => row.market_id !== "missing-market")
        .map((row) => ({
          id: row.market_id,
          venue: "polymarket",
          title: row.market_id,
          image: null,
          icon: null,
          event_id: "fixture-event",
          category: "politics",
          status: row.market_id === "closed" ? "CLOSED" : "ACTIVE",
          close_time: "2026-10-04T14:00:00Z",
          expiration_time: null,
          resolved_outcome: null,
          outcomes: '["Yes","No"]',
          best_bid: "0.04",
          best_ask: "0.06",
          last_price: "0.05",
          metadata: {},
        }))
        .map((row) => [row.id, row]),
    ).values(),
  ];
  return `with ${[
    relation(
      "wallet_activity_hourly",
      "wallet_id uuid, venue text, market_id text, outcome_side text, activity_type text, hour_bucket timestamptz, last_occurred_at timestamptz, signed_delta_shares numeric, signed_delta_usd numeric, abs_delta_usd numeric, max_abs_delta_usd numeric, last_price numeric, last_change_action text, entered_late boolean, counts_opened integer, counts_closed integer, counts_increased integer, counts_reduced integer",
      activityRows,
    ),
    relation(
      "wallet_activity_baseline",
      "wallet_id uuid, window_days integer, p90_usd numeric, sample_count integer",
      [
        { wallet_id: first, window_days: 30, p90_usd: 100, sample_count: 25 },
        { wallet_id: second, window_days: 30, p90_usd: 100, sample_count: 1 },
        { wallet_id: third, window_days: 7, p90_usd: 1, sample_count: 100 },
      ],
    ),
    relation("wallet_profiles", "wallet_id uuid, profile jsonb", [
      { wallet_id: first, profile: { categories: ["POLITICS"] } },
    ]),
    relation(
      "wallet_intel_selector_snapshot",
      "wallet_id uuid, metrics_pnl_30d numeric, metrics_roi_30d numeric, metrics_trades_30d integer, metrics_volume_30d numeric, metrics_win_rate_30d numeric, metrics_resolved_edge_sample_count_30d integer, metrics_resolved_win_rate_edge_30d numeric, metrics_resolved_edge_z_score_30d numeric, metrics_resolved_stake_usd_30d numeric",
      [{ wallet_id: first, metrics_pnl_30d: 321, metrics_trades_30d: 9 }],
    ),
    relation(
      "unified_markets",
      "id text, venue text, title text, image text, icon text, event_id text, category text, status text, close_time timestamptz, expiration_time timestamptz, resolved_outcome text, outcomes text, best_bid numeric, best_ask numeric, last_price numeric, metadata jsonb",
      markets,
    ),
    relation(
      "unified_events",
      "id text, title text, image text, icon text, category text, status text, end_date timestamptz",
      [{ id: "fixture-event", title: "Fixture", status: "ACTIVE" }],
    ),
  ].join(",\n")}`;
}

export function withWalletActivityFixture(
  sql: string,
  boundaryTies = false,
): string {
  return `${walletActivityFixturePrefix(boundaryTies)}
    select * from (${sql.replaceAll("now()", `timestamptz '${activityFixtureNow}'`)}) fixture_result`;
}

export async function captureActivitySql(
  task: (client: PoolClient) => Promise<unknown>,
): Promise<{ sql: string; params: unknown[] }> {
  let captured: { sql: string; params: unknown[] } | undefined;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (captured) throw new Error("Expected exactly one SELECT");
      captured = { sql, params };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  await task(client);
  if (!captured) throw new Error("Expected activity query");
  return captured;
}
