import crypto from "node:crypto";
import type { Pool } from "@hunch/infra";
import {
  verifiedBuyFactsSchema,
  type PurchaseRef,
  type VerifiedBuyFacts,
} from "../schemas/social-trade.js";
import { copyPurchaseIsTimelySql } from "./copy-purchase-timing.js";

export type { PurchaseRef, VerifiedBuyFacts } from "../schemas/social-trade.js";
type Db = Pick<Pool, "query">;
export type VerifiedBuyResult = {
  state: "pending" | "verified" | "revoked" | "missing";
  facts: VerifiedBuyFacts | null;
  reason: string | null;
};

function tableFor(ref: PurchaseRef): "orders" | "executions" {
  if (ref.kind === "order") return "orders";
  if (ref.kind === "execution") return "executions";
  throw new Error("Unknown purchase kind");
}

/** Private financial evidence is deliberately not read from raw/order_payload. */
export async function readVerifiedBuy(
  db: Db,
  input: {
    userId: string;
    purchaseRef: PurchaseRef;
    lock?: boolean;
  },
): Promise<VerifiedBuyResult> {
  const result = await db.query<{
    verified_buy_state: "pending" | "verified" | "revoked";
    verified_buy_facts: unknown;
    verified_buy_reason: string | null;
  }>(
    `select verified_buy_state, verified_buy_facts, verified_buy_reason
      from ${tableFor(input.purchaseRef)} where id = $1 and user_id = $2
      ${input.lock ? "for update" : ""}`,
    [input.purchaseRef.id, input.userId],
  );
  const row = result.rows[0];
  if (!row)
    return { state: "missing", facts: null, reason: "purchase_not_found" };
  const parsed = verifiedBuyFactsSchema.safeParse(row.verified_buy_facts);
  if (row.verified_buy_state === "verified" && !parsed.success)
    return { state: "pending", facts: null, reason: "facts_version_missing" };
  return {
    state: row.verified_buy_state,
    facts: parsed.success ? parsed.data : null,
    reason: row.verified_buy_reason,
  };
}

/** Explicit repair schedules observation only; it cannot revive a trade. */
export async function requestVerifiedBuyRefresh(
  db: Db,
  input: {
    userId: string;
    purchaseRef: PurchaseRef;
  },
): Promise<boolean> {
  const result = await db.query(
    `update ${tableFor(input.purchaseRef)}
    set verified_buy_due_at = now()
    where id = $1 and user_id = $2 returning id`,
    [input.purchaseRef.id, input.userId],
  );
  return result.rows.length === 1;
}

export function rawDecimal(raw: bigint, decimals: number): string {
  if (
    raw < 0n ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new Error("Invalid evidence amount");
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

export function decimalRatio(numerator: bigint, denominator: bigint): string {
  if (numerator < 0n || denominator <= 0n)
    throw new Error("Invalid evidence ratio");
  // Display precision only: actual financial quantities remain exact decimals.
  return rawDecimal((numerator * 10n ** 18n) / denominator, 18);
}

export type VerifiedPurchaseEvidence = {
  canonicalPurchaseKey: string;
  instrument: VerifiedBuyFacts["instrument"];
  owner: string;
  notionalRaw: bigint;
  grossSharesRaw: bigint;
  netSharesRaw: bigint;
  collateralDecimals: number;
  shareDecimals: number;
  feesUsdRaw: bigint | null;
  purchasedAt: string;
  evidenceIds: string[];
};

/** Called with provider/chain observations, never HTTP request bodies. */
export function factsFromEvidence(
  evidence: VerifiedPurchaseEvidence,
  now = new Date(),
): VerifiedBuyFacts {
  if (
    evidence.notionalRaw <= 0n ||
    evidence.grossSharesRaw <= 0n ||
    evidence.netSharesRaw <= 0n ||
    evidence.netSharesRaw > evidence.grossSharesRaw ||
    !evidence.evidenceIds.length
  )
    throw new Error(
      "Purchase evidence must contain positive executed quantities",
    );
  const economics = {
    canonicalPurchaseKey: evidence.canonicalPurchaseKey,
    instrument: evidence.instrument,
    owner: evidence.owner,
    grossNotionalUsd: rawDecimal(
      evidence.notionalRaw,
      evidence.collateralDecimals,
    ),
    grossShares: rawDecimal(evidence.grossSharesRaw, evidence.shareDecimals),
    netShares: rawDecimal(evidence.netSharesRaw, evidence.shareDecimals),
    entryPrice: decimalRatio(
      evidence.notionalRaw * 10n ** BigInt(evidence.shareDecimals),
      evidence.grossSharesRaw * 10n ** BigInt(evidence.collateralDecimals),
    ),
    feesUsd:
      evidence.feesUsdRaw === null
        ? null
        : rawDecimal(evidence.feesUsdRaw, evidence.collateralDecimals),
    purchasedAt: evidence.purchasedAt,
    evidenceIds: [...new Set(evidence.evidenceIds)].sort(),
  };
  return verifiedBuyFactsSchema.parse({
    version: 1,
    ...economics,
    evidenceRevision: crypto
      .createHash("sha256")
      .update(JSON.stringify(economics))
      .digest("hex"),
    verifiedAt: now.toISOString(),
  });
}

export type PurchaseObservation =
  | { state: "verified"; facts: VerifiedBuyFacts }
  | { state: "pending" | "revoked"; reason: string };
export type ClaimedPurchase = {
  purchaseRef: PurchaseRef;
  userId: string;
  leaseToken: string;
  attempts: number;
};
export class EvidenceBudgetExhausted extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super("Evidence request budget exhausted");
  }
}
export function observationFailureReason(error: unknown): string {
  return error instanceof EvidenceBudgetExhausted
    ? `evidence_budget_exhausted:required=${error.required}:available=${Math.max(0, error.available)}`
    : "observation_unavailable";
}

/** The supplied observer must be read-only. Financial execution is never imported here. */
export async function repairVerifiedBuys(
  db: Db,
  input: {
    concurrency?: number;
    batchSize: number;
    leaseSeconds: number;
    retrySeconds: number;
    verifiedRecheckSeconds: number;
    observe: (claim: ClaimedPurchase) => Promise<PurchaseObservation>;
    onStored?: (
      claim: ClaimedPurchase,
      result: PurchaseObservation,
    ) => Promise<void>;
  },
): Promise<{
  claimed: number;
  verified: number;
  pending: number;
  revoked: number;
  leaseLost: number;
  budgetExhausted: number;
}> {
  for (const value of [
    input.batchSize,
    input.concurrency ?? 1,
    input.leaseSeconds,
    input.retrySeconds,
    input.verifiedRecheckSeconds,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid verification policy");
  const summary = {
    claimed: 0,
    verified: 0,
    pending: 0,
    revoked: 0,
    leaseLost: 0,
    budgetExhausted: 0,
  };
  const kinds = ["order", "execution"] as const;
  const drainedKinds = new Set<(typeof kinds)[number]>();
  const seenIds: Record<(typeof kinds)[number], string[]> = {
    order: [],
    execution: [],
  };
  // Alternate bounded chunks so a large order queue cannot consume the whole
  // batch before executions get a turn. Never re-claim a retry during this run.
  for (
    let turn = 0;
    summary.claimed < input.batchSize &&
    drainedKinds.size < kinds.length &&
    summary.budgetExhausted === 0;
    turn++
  ) {
    const kind = turn % kinds.length === 0 ? "order" : "execution";
    if (drainedKinds.has(kind)) continue;
    const table = tableFor({ kind, id: "" });
    const remaining = Math.min(
      input.batchSize - summary.claimed,
      input.concurrency ?? 1,
    );
    if (remaining <= 0) break;
    const claims = await db.query<{
      id: string;
      user_id: string;
      verified_buy_lease_token: string;
      verified_buy_attempts: number;
    }>(
      `
      with due_purchase as (
        select id from ${table}
        where verified_buy_due_at <= now()
          and not (id = any($3::uuid[]))
          and (verified_buy_lease_until is null or verified_buy_lease_until < now())
        order by verified_buy_due_at, id limit $1 for update skip locked
      ) update ${table} purchase_row
        set verified_buy_lease_token = gen_random_uuid(),
            verified_buy_lease_until = now() + $2 * interval '1 second',
            verified_buy_attempts = verified_buy_attempts + 1
        from due_purchase where purchase_row.id = due_purchase.id
        returning purchase_row.id, purchase_row.user_id, purchase_row.verified_buy_lease_token, purchase_row.verified_buy_attempts
    `,
      [remaining, input.leaseSeconds, seenIds[kind]],
    );
    if (!claims.rows.length) {
      drainedKinds.add(kind);
      continue;
    }
    seenIds[kind].push(...claims.rows.map((claim) => claim.id));
    await Promise.all(
      claims.rows.map(async (claim) => {
        summary.claimed++;
        let observation: PurchaseObservation;
        try {
          observation = await input.observe({
            purchaseRef: { kind, id: claim.id },
            userId: claim.user_id,
            leaseToken: claim.verified_buy_lease_token,
            attempts: claim.verified_buy_attempts,
          });
        } catch (error) {
          // Do not include provider errors: they can contain authenticated URLs.
          observation = {
            state: "pending",
            reason: observationFailureReason(error),
          };
        }
        if (observation.state === "verified")
          observation.facts = verifiedBuyFactsSchema.parse(observation.facts);
        else if (observation.reason.startsWith("evidence_budget_exhausted:"))
          summary.budgetExhausted++;
        const referenceColumn = kind === "order" ? "order_id" : "execution_id";
        const timelyPurchase = copyPurchaseIsTimelySql(
          "(stored_purchase.verified_buy_facts->>'purchasedAt')::timestamptz",
          "copy_row.created_at",
        );
        const result = await db.query(
          `with stored_purchase as (update ${table}
        set verified_buy_state = case when $2 = 'pending' and ($4 = 'observation_unavailable' or $4 like 'evidence_budget_exhausted:%') then verified_buy_state
                                     when $2 = 'pending' and verified_buy_state = 'revoked' then 'revoked' else $2 end,
            verified_buy_facts = case when $2 = 'verified' then $3::jsonb else verified_buy_facts end,
            verified_buy_reason = $4, verified_buy_revision = verified_buy_revision + 1,
            verified_buy_due_at = now() + $5 * interval '1 second',
            verified_buy_lease_token = null, verified_buy_lease_until = null
        where id = $1 and user_id = $6 and verified_buy_lease_token = $7
          and verified_buy_lease_until > now() returning id,verified_buy_state,verified_buy_facts),
        projected_theses as (
          update user_theses thesis_row set proof_invalidated_at=case
            when stored_purchase.verified_buy_state='revoked'
              or not ((thesis_row.buy_snapshot->'evidenceIds') <@ (stored_purchase.verified_buy_facts->'evidenceIds'))
              then coalesce(thesis_row.proof_invalidated_at,now())
            else null end
          from stored_purchase
          where thesis_row.author_id=$6 and (thesis_row.${referenceColumn}=stored_purchase.id
            or thesis_row.canonical_purchase_key=stored_purchase.verified_buy_facts->>'canonicalPurchaseKey')
            and stored_purchase.verified_buy_state in ('revoked','verified')
          returning thesis_row.id
        ), projected_copies as (
          update copy_attributions copy_row set
            state=case when stored_purchase.verified_buy_state='verified' and ${timelyPurchase}
              then 'confirmed' else 'revoked' end,
            canonical_purchase_key=case when stored_purchase.verified_buy_state='verified'
              then stored_purchase.verified_buy_facts->>'canonicalPurchaseKey' else copy_row.canonical_purchase_key end,
            facts_revision=case when stored_purchase.verified_buy_state='verified'
              then stored_purchase.verified_buy_facts->>'evidenceRevision' else copy_row.facts_revision end,
            execution_facts=case when stored_purchase.verified_buy_state='verified'
              then stored_purchase.verified_buy_facts else copy_row.execution_facts end,
            confirmed_at=case when stored_purchase.verified_buy_state='verified' and ${timelyPurchase}
              then coalesce(copy_row.confirmed_at,now()) else copy_row.confirmed_at end,updated_at=now()
          from stored_purchase where copy_row.copier_user_id=$6 and copy_row.${referenceColumn}=stored_purchase.id
            and (stored_purchase.verified_buy_state='revoked' or (stored_purchase.verified_buy_state='verified'
              and copy_row.instrument=stored_purchase.verified_buy_facts->'instrument')) returning copy_row.id
        ) select id from stored_purchase`,
          [
            claim.id,
            observation.state,
            observation.state === "verified"
              ? JSON.stringify(observation.facts)
              : null,
            observation.state === "verified" ? null : observation.reason,
            observation.state === "verified"
              ? input.verifiedRecheckSeconds
              : input.retrySeconds,
            claim.user_id,
            claim.verified_buy_lease_token,
          ],
        );
        if (result.rows.length) {
          summary[observation.state]++;
          await input.onStored?.(
            {
              purchaseRef: { kind, id: claim.id },
              userId: claim.user_id,
              leaseToken: claim.verified_buy_lease_token,
              attempts: claim.verified_buy_attempts,
            },
            observation,
          );
        } else summary.leaseLost++;
      }),
    );
  }
  return summary;
}
