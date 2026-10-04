export type LegacyEvidencePollingKind =
  | "polymarket_orphan_attempt"
  | "legacy_debridge";

/** Internal SQL expressions only; never pass request-supplied SQL here.
 * A pause is scoped to one record, not its wallet or subsequent purchases.
 * It stops new evidence leases, not an in-flight positive receipt or money movement.
 */
export function legacyEvidencePollingPausedSql(
  metadataSql: string,
  recordIdSql: string,
  kind: LegacyEvidencePollingKind,
): string {
  return `coalesce(${metadataSql} -> 'legacyEvidencePolling' @> jsonb_build_object(
    'version', 1, 'state', 'paused', 'kind', '${kind}', 'recordId', ${recordIdSql}::text
  ), false)`;
}
