type TrackableMarketSqlOptions = {
  marketAlias?: string;
  eventAlias?: string | null;
  asOfSql?: string;
};

type SnapshotDeltaActivitySqlOptions = {
  activityAlias?: string;
  marketAlias?: string;
  eventAlias?: string | null;
};

export function buildWalletIntelTrackableMarketSql({
  marketAlias = "m",
  eventAlias = "e",
  asOfSql = "now()",
}: TrackableMarketSqlOptions = {}): string {
  const eventClause = eventAlias
    ? `
        and (
          ${eventAlias}.id is null
          or (
            ${eventAlias}.status = 'ACTIVE'
            and (${eventAlias}.end_date is null or ${eventAlias}.end_date > ${asOfSql})
          )
        )
      `
    : "";

  return `
    ${marketAlias}.status = 'ACTIVE'
    and ${marketAlias}.resolved_outcome is null
    and (${marketAlias}.close_time is null or ${marketAlias}.close_time > ${asOfSql})
    and (${marketAlias}.expiration_time is null or ${marketAlias}.expiration_time > ${asOfSql})
    ${eventClause}
  `;
}

export function buildSnapshotDeltaTrackableActivitySql({
  activityAlias = "wa",
  marketAlias = "m",
  eventAlias = "e",
}: SnapshotDeltaActivitySqlOptions = {}): string {
  const eventClause = eventAlias
    ? `
        and (
          ${marketAlias}.close_time is not null
          or ${marketAlias}.expiration_time is not null
          or ${eventAlias}.end_date is null
          or ${activityAlias}.occurred_at < ${eventAlias}.end_date
        )
      `
    : "";

  return `
    (
      ${activityAlias}.source is distinct from 'snapshot_delta'
      or (
        ${marketAlias}.id is not null
        and (
          ${marketAlias}.close_time is null
          or ${activityAlias}.occurred_at < ${marketAlias}.close_time
        )
        and (
          ${marketAlias}.expiration_time is null
          or ${activityAlias}.occurred_at < ${marketAlias}.expiration_time
        )
        ${eventClause}
      )
    )
  `;
}
