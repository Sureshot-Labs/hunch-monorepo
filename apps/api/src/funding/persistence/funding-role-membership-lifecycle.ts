import type { PoolClient } from "@hunch/infra";
import { FundingClassificationChangedError } from "./funding-classification-revisions.js";

export const FUNDING_ROLE_MEMBERSHIP_OWNER_SQL = `select id from users where id=$1::uuid
  and current_setting('transaction_isolation')='read committed'
  for key share nowait`;

/** Merge already owns these users FOR UPDATE before moving operations. The
 * sessionless reader may reuse that lifecycle fence only NONWAITING: an
 * existing action writer can hold O before requesting the same users row.
 *
 * Derived work: full E -> U NOWAIT -> checkpoint writes -> COMMIT, no later O.
 * Publication: full E -> pure read -> sorted O union -> U NOWAIT -> current
 * membership reread -> effects -> F -> COMMIT, no later E/O acquisition.
 * Catch changed facts only OUTSIDE the rolled-back transaction.
 */
export async function lockFundingRoleMembershipOwner(
  db: Pick<PoolClient, "query">,
  userId: string,
): Promise<void> {
  try {
    const result = await db.query(
      FUNDING_ROLE_MEMBERSHIP_OWNER_SQL,
      [userId],
    );
    if (result.rowCount !== 1) throw new FundingClassificationChangedError();
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "55P03"
    )
      throw new FundingClassificationChangedError();
    throw error;
  }
}

export const RESTART_MERGED_FUNDING_ROLE_MEMBERSHIP_SQL = `
update funding_receive_refund_scans scan_row
set user_id=$2::uuid,scan_before=clock_timestamp(),
    source_cursor_created_at=null,source_cursor_id=null,source_exhausted=false,
    last_lease_token=null,updated_at=clock_timestamp()
where scan_row.user_id=any($1::uuid[])
  and scan_row.receive_session_id is null and not scan_row.cleanup_ready`;

/** Only the central authorized merge transaction, after its factual audit and
 * while it owns BOTH sorted users rows. Preserve every captured candidate,
 * revision and physical-event binding. keepSource does not change which
 * operations move. No financial row, queue or historical Buy is restarted.
 */
export async function restartMergedFundingRoleMembership(
  db: Pick<PoolClient, "query">,
  input: { sourceUserId: string; targetUserId: string },
): Promise<void> {
  await db.query(RESTART_MERGED_FUNDING_ROLE_MEMBERSHIP_SQL, [
    [input.sourceUserId, input.targetUserId],
    input.targetUserId,
  ]);
}
