import type { Pool } from "@hunch/infra";
import {
  observeVerifiedBuySource,
  type VerifiedBuyObserverDependencies,
  type VerifiedBuySourceRow,
} from "./verified-buy-observer.js";
import { isRecord } from "../lib/type-guards.js";
import { verifiedBuyFactsSchema } from "../schemas/social-trade.js";
import { observationFailureReason } from "./verified-buy.js";

/** A successful external submission can exist without any local order row.
 * Observe that retained exact identity directly; never manufacture/replay a buy.
 */
export async function repairUnrecordedCopies(
  pool: Pool,
  deps: VerifiedBuyObserverDependencies,
  policy: {
    batchSize: number;
    concurrency: number;
    leaseSeconds: number;
    retrySeconds: number;
    recheckSeconds: number;
  },
): Promise<{
  checked: number;
  confirmed: number;
  revoked: number;
  pending: number;
  leaseLost: number;
  budgetExhausted: number;
}> {
  const counts = {
    checked: 0,
    confirmed: 0,
    revoked: 0,
    pending: 0,
    leaseLost: 0,
    budgetExhausted: 0,
  };
  const rows = await pool.query<{
    id: string;
    copier_user_id: string;
    provider_reference: string;
    instrument: unknown;
    source_snapshot: unknown;
    repair_lease_token: string;
  }>(
    `
    with due_copy as (
      select id from copy_attributions where copier_user_id is not null and order_id is null and execution_id is null
        and repair_due_at<=now() and (repair_lease_until is null or repair_lease_until<now())
      order by repair_due_at,id limit $1 for update skip locked
    ) update copy_attributions copy_row set repair_lease_token=gen_random_uuid(),repair_lease_until=now()+$2*interval '1 second'
      from due_copy where copy_row.id=due_copy.id
      returning copy_row.id,copy_row.copier_user_id,copy_row.provider_reference,copy_row.instrument,copy_row.source_snapshot,copy_row.repair_lease_token
  `,
    [Math.min(policy.batchSize, policy.concurrency), policy.leaseSeconds],
  );
  await Promise.all(
    rows.rows.map(async (row) => {
      counts.checked++;
      let result: Awaited<ReturnType<typeof observeVerifiedBuySource>> = {
        state: "pending",
        reason: "source_identity_missing",
      };
      try {
        const parsed = verifiedBuyFactsSchema.shape.instrument.safeParse(
          row.instrument,
        );
        const snapshot = isRecord(row.source_snapshot)
          ? row.source_snapshot
          : {};
        const submission = isRecord(snapshot.submission)
          ? snapshot.submission
          : {};
        const signer =
          typeof submission.walletAddress === "string"
            ? submission.walletAddress
            : null;
        const owner =
          typeof submission.positionOwner === "string"
            ? submission.positionOwner
            : signer;
        if (parsed.success && signer && owner) {
          const instrument = parsed.data;
          const poly = row.provider_reference.match(
            /^polymarket:137:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/i,
          );
          const dflow = row.provider_reference.match(
            /^dflow:mainnet:([^:]+):([^:]+)$/,
          );
          const clob = row.provider_reference.match(
            /^limitless:clob:8453:(.+)$/,
          );
          const amm = row.provider_reference.match(
            /^limitless:amm:8453:(0x[0-9a-f]{64}):(\d+)$/i,
          );
          const source: VerifiedBuySourceRow = {
            id: row.id,
            user_id: row.copier_user_id,
            venue: instrument.venue,
            wallet_address: owner,
            signer_address: signer,
            order_hash: poly?.[2] ?? null,
            venue_order_id: amm ? `amm:${amm[1]}:${instrument.tokenId}` : null,
            token_id: instrument.tokenId,
            side: "BUY",
            order_payload: {
              assetContext: submission.assetContext,
              marketAddress: submission.marketAddress,
            },
            client_order_id: clob?.[1] ?? null,
            tx_signature: dflow?.[1] ?? null,
            market_id: instrument.marketId,
            outcome: instrument.outcome,
            expiration_time: instrument.expiry
              ? new Date(instrument.expiry)
              : null,
            market_metadata: { marketAddress: submission.marketAddress },
            input_mint:
              instrument.venue === "kalshi" ? deps.solanaCollateralMint : null,
            output_mint:
              instrument.venue === "kalshi"
                ? instrument.tokenId.replace(/^sol:/, "")
                : null,
          };
          if (
            (poly && instrument.venue === "polymarket") ||
            ((clob || amm) && instrument.venue === "limitless") ||
            (dflow && instrument.venue === "kalshi" && dflow[2] === owner)
          ) {
            result = await observeVerifiedBuySource(pool, deps, source);
            if (
              result.state === "verified" &&
              JSON.stringify(result.facts.instrument) !==
                JSON.stringify(instrument)
            )
              result = {
                state: "pending",
                reason: "source_instrument_mismatch",
              };
          }
        }
      } catch (error) {
        result = { state: "pending", reason: observationFailureReason(error) };
      }
      const budgetExhausted =
        result.state === "pending" &&
        result.reason.startsWith("evidence_budget_exhausted:");
      if (budgetExhausted) counts.budgetExhausted++;
      const state = result.state === "verified" ? "confirmed" : result.state;
      const saved = await pool.query(
        `update copy_attributions
      set state=case when $3='pending' then state else $3 end,
          canonical_purchase_key=case when $3='confirmed' then $4 else canonical_purchase_key end,
          facts_revision=case when $3='confirmed' then $5 else facts_revision end,
          execution_facts=case when $3='confirmed' then $6::jsonb else execution_facts end,
          confirmed_at=case when $3='confirmed' then coalesce(confirmed_at,now()) else confirmed_at end,
          repair_due_at=now()+$7*interval '1 second',repair_lease_token=null,repair_lease_until=null,updated_at=now()
      where id=$1 and repair_lease_token=$2 and repair_lease_until>now()
        and copier_user_id=$8 and order_id is null and execution_id is null returning id`,
        [
          row.id,
          row.repair_lease_token,
          state,
          result.state === "verified"
            ? result.facts.canonicalPurchaseKey
            : null,
          result.state === "verified" ? result.facts.evidenceRevision : null,
          result.state === "verified" ? JSON.stringify(result.facts) : null,
          result.state === "verified" || budgetExhausted
            ? policy.recheckSeconds
            : policy.retrySeconds,
          row.copier_user_id,
        ],
      );
      if (saved.rows.length) counts[state]++;
      else counts.leaseLost++;
    }),
  );
  return counts;
}
