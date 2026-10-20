// Sidecar-safe read-only provider observer. No API env, signer, executor or bot.
import type { Pool } from "pg";
import { readHip4Policy } from "./services/hip4-repository.js";
import {
  readHip4AccountPolicy,
  failHip4AccountRefresh,
} from "./services/hip4-account-repository.js";
import { refreshHip4OwnedAccount } from "./services/hip4-account-service.js";
import { runHip4OrderObservationPass } from "./services/hip4-order-observer.js";

/** Cheap current-policy reads, without provider IO or API-wide secrets. The
 * worker must reconsider a shortened interval or newly enabled scope now,
 * rather than waiting behind a previously cached account due timestamp. */
export async function readHip4FinancialReadCadence(pool: Pool) {
  const [account, read] = await Promise.all([
    readHip4AccountPolicy(pool),
    // A broken account-read policy must not prevent observing an admitted
    // order. Let the due account phase report its normal diagnostic failure.
    readHip4Policy(pool, "accountRead").catch(() => null),
  ]);
  return {
    nextIntervalSeconds: Math.ceil(
      Math.min(
        account.policy.workerIntervalMs,
        account.policy.orderObservationIntervalMs,
      ) / 1000,
    ),
    nextAccountIntervalSeconds: Math.ceil(
      account.policy.workerIntervalMs / 1000,
    ),
    accountPolicyRevision: account.revision,
    accountReadEnabled: read?.policy.enabled ?? true,
    accountReadEnvironment: read?.policy.environment ?? null,
  };
}

/** Existing finance-worker job/pool, not a second trading executor. Already
 * admitted orders remain observable after new-exposure/account-read disabling. */
export async function runHip4FinancialReadPass(
  pool: Pool,
  fetcher?: typeof fetch,
  accountFirst = true,
  options: { skipAccounts?: boolean } = {},
) {
  const orders = () =>
    runHip4OrderObservationPass(pool, fetcher).catch(() => ({
      claimed: 0,
      saved: 0,
      errors: 1,
      leaseLost: 0,
      budgetExhausted: 0,
    }));
  // Try both phases even if one policy/read fails. Priority is rotated by the
  // existing single-flight job so neither can monopolize the shared IP budget.
  const accounts = () =>
    options.skipAccounts
      ? Promise.resolve({
          claimed: 0,
          updated: 0,
          errors: 0,
          leaseLost: 0,
          budgetExhausted: 0,
        })
      : runHip4AccountReadPass(pool, fetcher).catch(() => null);
  const first = accountFirst ? await accounts() : null;
  const orderObservation = await orders();
  const account = accountFirst ? first : await accounts();
  if (!account) throw new Error("hip4_account_observation_failed");
  return {
    ...account,
    orderObservation,
    ...(await readHip4FinancialReadCadence(pool)),
  };
}

// Materialize eligibility before the LIMIT row goal. Otherwise PostgreSQL can
// walk every unowned snapshot in time order and repeatedly probe all wallets
// while hoping to find one eligible row near the front of a sparse queue.
// OFFSET 0 fences lateral PK lookup and candidate ordering against flattening;
// the LIMIT remains AFTER SKIP LOCKED so contention can try the next candidate.
export const HIP4_CLAIM_DUE_ACCOUNT_SQL = `with owned_due_accounts as materialized (
  select snapshot_row.environment,snapshot_row.account_address,snapshot_row.attempt_at
  from user_wallets wallet_row
  join users owner_row on owner_row.id=wallet_row.user_id and owner_row.is_active
  cross join lateral (
    select account_row.environment,account_row.account_address,account_row.attempt_at
    from hip4_account_snapshots account_row
    where account_row.environment=$1 and account_row.account_address=wallet_row.wallet_address_norm
      and (account_row.attempt_at is null or account_row.attempt_at<=statement_timestamp()-$2*interval '1 millisecond')
      and (account_row.lease_until is null or account_row.lease_until<statement_timestamp())
    offset 0
  ) snapshot_row
  where wallet_row.is_verified and wallet_row.wallet_type='ethereum'
), due_accounts as (
  select snapshot_row.environment, snapshot_row.account_address
  from (select * from owned_due_accounts
    order by attempt_at asc nulls first,account_address offset 0) candidate_row
  cross join lateral (
    select locked_row.environment,locked_row.account_address
    from hip4_account_snapshots locked_row
    where locked_row.environment=candidate_row.environment
      and locked_row.account_address=candidate_row.account_address
      and (locked_row.attempt_at is null or locked_row.attempt_at<=statement_timestamp()-$2*interval '1 millisecond')
      and (locked_row.lease_until is null or locked_row.lease_until<statement_timestamp())
    for update of locked_row skip locked
  ) snapshot_row limit 1
) update hip4_account_snapshots target_row
  set attempt_at=statement_timestamp(),
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
        background: true,
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
