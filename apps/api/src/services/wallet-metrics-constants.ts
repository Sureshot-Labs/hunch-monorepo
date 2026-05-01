export const AGGREGATE_WALLET_METRICS_VENUE = "aggregate";

export function aggregateWalletMetricsFilterSql(alias: string): string {
  return `(${alias}.venue is null or ${alias}.venue = '${AGGREGATE_WALLET_METRICS_VENUE}')`;
}

export function aggregateWalletMetricsPreferenceExpressionSql(
  alias: string,
): string {
  return `(${alias}.venue = '${AGGREGATE_WALLET_METRICS_VENUE}')`;
}

export function aggregateWalletMetricsPreferenceSql(alias: string): string {
  return `${aggregateWalletMetricsPreferenceExpressionSql(alias)} desc`;
}
