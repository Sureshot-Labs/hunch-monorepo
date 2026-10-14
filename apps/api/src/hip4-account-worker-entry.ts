// Sidecar-safe read-only provider observer. No API env, signer, executor or bot.
import type { Pool } from "pg";
import { readHip4Policy } from "./services/hip4-repository.js";
import {
  readHip4AccountPolicy,
  failHip4AccountRefresh,
} from "./services/hip4-account-repository.js";
import { refreshHip4OwnedAccount } from "./services/hip4-account-service.js";

export const HIP4_CLAIM_DUE_ACCOUNT_SQL = `with due_accounts as (
  select snapshot_row.environment, snapshot_row.account_address
  from hip4_account_snapshots snapshot_row
  where snapshot_row.environment=$1
    and (snapshot_row.attempt_at is null or snapshot_row.attempt_at<=statement_timestamp()-$2*interval '1 millisecond')
    and (snapshot_row.lease_until is null or snapshot_row.lease_until<statement_timestamp())
    and exists (select 1 from user_wallets wallet_row join users owner_row
      on owner_row.id=wallet_row.user_id and owner_row.is_active
      where wallet_row.is_verified and wallet_row.wallet_type='ethereum'
        and lower(wallet_row.wallet_address)=snapshot_row.account_address)
  order by snapshot_row.attempt_at asc nulls first, snapshot_row.account_address
  limit 1 for update of snapshot_row skip locked
) update hip4_account_snapshots target_row
  set attempt_at=statement_timestamp(), attempt_error=null,
    lease_token=gen_random_uuid(), lease_until=statement_timestamp()+$3*interval '1 millisecond'
  from due_accounts where target_row.environment=due_accounts.environment
    and target_row.account_address=due_accounts.account_address
  returning target_row.account_address, target_row.lease_token, target_row.attempt_at`;

export async function runHip4AccountReadPass(
  pool: Pool,
  fetcher?: typeof fetch,
) {
  const [read, account] = await Promise.all([
    readHip4Policy(pool, "accountRead"),
    readHip4AccountPolicy(pool),
  ]);
  const result = {
    claimed: 0,
    updated: 0,
    errors: 0,
    leaseLost: 0,
    budgetExhausted: 0,
    nextIntervalSeconds: Math.ceil(account.policy.workerIntervalMs / 1000),
  };
  if (!read.policy.enabled) return result;
  // Only accounts already explicitly observed by an owned-account request are
  // enrolled. No wallet-history scan or implicit mainnet/testnet copying.
  for (let index = 0; index < account.policy.workerBatchSize; index++) {
    const current = await readHip4Policy(pool, "accountRead");
    if (
      !current.policy.enabled ||
      current.policy.environment !== read.policy.environment
    )
      break;
    const currentAccount = await readHip4AccountPolicy(pool);
    if (index >= currentAccount.policy.workerBatchSize) break;
    const claim = (
      await pool.query(HIP4_CLAIM_DUE_ACCOUNT_SQL, [
        read.policy.environment,
        currentAccount.policy.workerIntervalMs,
        currentAccount.policy.leaseMs,
      ])
    ).rows[0];
    if (!claim) break;
    result.claimed++;
    try {
      const refreshed = await refreshHip4OwnedAccount({
        pool,
        policy: current.policy,
        accountPolicy: currentAccount.policy,
        address: claim.account_address,
        lease: claim.lease_token,
        now: new Date(claim.attempt_at).getTime(),
        fetcher,
        requireCurrentOwner: true,
      });
      if (!refreshed.saved) result.leaseLost++;
      else if (refreshed.errors.length) result.errors++;
      else result.updated++;
      if (
        refreshed.errors.some((error) => error.includes("budget_exhausted"))
      ) {
        result.budgetExhausted++;
        break;
      }
    } catch {
      result.errors++;
      await failHip4AccountRefresh(
        pool,
        read.policy.environment,
        claim.account_address,
        claim.lease_token,
        "background_refresh_failed",
      );
    }
  }
  return result;
}
