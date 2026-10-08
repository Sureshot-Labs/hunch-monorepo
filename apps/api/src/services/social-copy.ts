import { tx, type Pool } from "@hunch/infra";
import { parsePolymarketAssetContext } from "@hunch/shared";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  verifiedBuyFactsSchema,
  type SocialSourceRef,
  type VerifiedBuyFacts,
} from "../schemas/social-trade.js";
import { readVisibleSocialSource } from "./social-visibility.js";
import { resolveSocialPolicy } from "./social-policy.js";
import { SocialError } from "./social-primitives.js";
import type { PersistedTrade, PreparedTrade } from "./trading-types.js";
import { isRecord } from "../lib/type-guards.js";
import type { PolymarketAssetContext } from "@hunch/shared";

type Db = Pick<Pool, "query">;
type Instrument = VerifiedBuyFacts["instrument"];
type CurrentInstrumentConfig = { limitlessPositionContract?: string };
export type RetainedCopyAttempt = {
  id: string;
  created: boolean;
  attemptToken: string;
  priorSubmissionUncertain: boolean;
};

/** Adapts an already-validated venue request to the same Copy contract. */
export async function retainClientCopyBeforeSubmission(
  pool: Pool,
  input: {
    sourceRef: SocialSourceRef;
    userId: string;
    walletAddress: string;
    venue: Instrument["venue"];
    marketId: string;
    tokenId: string;
    outcome: "YES" | "NO";
    action: "BUY" | "SELL";
    amount: string;
    idempotencyKey?: string;
    providerReference: string;
    preparedFingerprint: string;
    assetContext?: PolymarketAssetContext;
    orderType?: "FOK" | "FAK" | "GTC" | "GTD" | "market";
    marketAddress?: string;
    positionOwner?: string;
    limitlessPositionContract?: string;
    onRetained?: (attempt: RetainedCopyAttempt) => void;
  },
): Promise<string> {
  const key = input.idempotencyKey ?? input.providerReference;
  const prepared: PreparedTrade = {
    preparedId: input.preparedFingerprint,
    venue: input.venue,
    quote: null,
    authorizationMode: "client_signed_order",
    authorizationRequests: [],
    reconcileKeys: {},
    expiresAt: null,
    venuePayload: {
      assetContext: input.assetContext,
      marketAddress: input.marketAddress,
      positionWalletAddress: input.positionOwner,
    },
    intent: {
      actor: { kind: "web_app", userId: input.userId },
      venue: input.venue,
      sourceRef: input.sourceRef,
      walletAddress: input.walletAddress,
      action: input.action,
      outcome: input.outcome,
      amount: { type: "usd", value: input.amount },
      idempotencyKey: key,
      orderType: input.orderType,
      target: {
        venue: input.venue,
        marketId: input.marketId,
        tokenId: input.tokenId,
        outcome: input.outcome,
        eventId: null,
        venueMarketId: null,
        title: null,
        assetContext: input.assetContext,
      },
    },
  };
  const attempt = await retainCopyBeforeSubmission(pool, {
    prepared,
    providerReference: input.providerReference,
    preparedFingerprint: input.preparedFingerprint,
    limitlessPositionContract: input.limitlessPositionContract,
  });
  await markCopySubmissionStarted(pool, input.userId, attempt);
  input.onRetained?.(attempt);
  // An explicit client retry can submit exactly the same economic identity.
  // The unique provider reference/fingerprint above forbids creating another buy.
  return key;
}

export type CopyAttributionStatus = {
  id: string;
  state: "pending" | "confirmed" | "revoked" | "failed";
  sourceRef: SocialSourceRef;
  purchaseRef: { kind: "order" | "execution"; id: string } | null;
  createdAt: string;
  confirmedAt: string | null;
  updatedAt: string;
};

/** Owner-only recovery, deliberately independent of current social policy/visibility. */
export async function getCopyAttributionStatus(
  db: Db,
  userId: string,
  idempotencyKey: string,
): Promise<CopyAttributionStatus | null> {
  const result = await db.query<{
    id: string;
    state: CopyAttributionStatus["state"];
    source_thesis_id: string | null;
    source_ai_note_id: string | null;
    order_id: string | null;
    execution_id: string | null;
    created_at: Date;
    confirmed_at: Date | null;
    updated_at: Date;
  }>(
    `
    select id,state,source_thesis_id,source_ai_note_id,order_id,execution_id,created_at,confirmed_at,updated_at
    from copy_attributions where copier_user_id=$1 and idempotency_key=$2`,
    [userId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const sourceRef: SocialSourceRef | null = row.source_thesis_id
    ? { kind: "thesis", id: row.source_thesis_id }
    : row.source_ai_note_id
      ? { kind: "hunch", id: row.source_ai_note_id }
      : null;
  if (!sourceRef) return null;
  return {
    id: row.id,
    state: row.state,
    sourceRef,
    purchaseRef: row.order_id
      ? { kind: "order", id: row.order_id }
      : row.execution_id
        ? { kind: "execution", id: row.execution_id }
        : null,
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function copyPayloadHash(prepared: PreparedTrade): string {
  const intent = prepared.intent;
  return canonicalJsonHash({
    sourceRef: intent.sourceRef,
    venue: intent.venue,
    action: intent.action,
    marketId: intent.target.marketId,
    tokenId: intent.target.tokenId,
    outcome: intent.outcome ?? intent.target.outcome,
    amount: intent.amount,
    orderType: intent.orderType ?? null,
    limitPrice: intent.limitPrice ?? null,
    walletAddress: intent.walletAddress,
    slippageBps: intent.slippageBps ?? null,
  });
}

export function requireSameInstrument(
  prepared: PreparedTrade,
  instrument: Instrument,
  config: CurrentInstrumentConfig = {},
): void {
  const intent = prepared.intent;
  if (
    intent.action !== "BUY" ||
    intent.venue !== instrument.venue ||
    intent.target.marketId !== instrument.marketId ||
    intent.target.tokenId !== instrument.tokenId ||
    (intent.outcome ?? intent.target.outcome) !== instrument.outcome
  )
    throw new SocialError("copy_instrument_mismatch", 409);
  if (instrument.venue === "polymarket") {
    const payload = isRecord(prepared.venuePayload)
      ? prepared.venuePayload
      : {};
    const context = parsePolymarketAssetContext(
      payload.assetContext ?? intent.target.assetContext,
    );
    if (
      !context ||
      `${context.chainId}:${context.positionContract.toLowerCase()}:${context.protocolVersion}` !==
        instrument.generation
    )
      throw new SocialError("copy_generation_mismatch", 409);
  } else if (instrument.venue === "limitless") {
    if (
      !config.limitlessPositionContract ||
      instrument.generation !==
        `8453:${config.limitlessPositionContract.toLowerCase()}:${instrument.tokenId}`
    )
      throw new SocialError("copy_generation_mismatch", 409);
  } else if (instrument.generation !== `solana:mainnet:${instrument.tokenId}`) {
    throw new SocialError("copy_generation_mismatch", 409);
  }
}

export async function authorizeCopySource(
  db: Db,
  prepared: PreparedTrade,
  config: CurrentInstrumentConfig = {},
): Promise<{
  sourceRef: SocialSourceRef;
  instrument: Instrument;
  snapshot: unknown;
}> {
  const sourceRef = prepared.intent.sourceRef;
  if (!sourceRef) throw new SocialError("copy_source_required");
  const resolved = await resolveSocialPolicy(db);
  if (!resolved.policy.enabled || !resolved.policy.copyEnabled)
    throw new SocialError("copy_disabled", 409);
  const account = await db.query<{ allowed: boolean }>(
    `select is_active and social_suspended_at is null as allowed
    from users where id=$1`,
    [prepared.intent.actor.userId],
  );
  if (!account.rows[0]?.allowed)
    throw new SocialError("social_account_unavailable", 403);
  // The retained-authorization transaction holds this lock through its insert;
  // source hide/retraction cannot interleave between visibility and persistence.
  await db.query(
    `select id from ${sourceRef.kind === "thesis" ? "user_theses" : "ai_notes"} where id=$1 for share`,
    [sourceRef.id],
  );
  const source = await readVisibleSocialSource(
    db,
    prepared.intent.actor.userId,
    sourceRef,
  );
  let instrument: Instrument;
  if (source.kind === "thesis") instrument = source.facts.instrument;
  else {
    const parsed = verifiedBuyFactsSchema.shape.instrument.safeParse(
      source.metrics.socialInstrumentV1,
    );
    if (
      !parsed.success ||
      parsed.data.marketId !== source.marketId ||
      parsed.data.outcome !== source.side
    )
      throw new SocialError("source_instrument_unavailable", 409);
    instrument = parsed.data;
  }
  requireSameInstrument(prepared, instrument, config);
  const market = await db.query<{ expiration_time: Date | null }>(
    `select expiration_time from unified_markets where id=$1`,
    [instrument.marketId],
  );
  if (
    !market.rows[0] ||
    (market.rows[0].expiration_time?.toISOString() ?? null) !==
      instrument.expiry
  )
    throw new SocialError("copy_expiry_mismatch", 409);
  const payload = isRecord(prepared.venuePayload) ? prepared.venuePayload : {};
  return {
    sourceRef,
    instrument,
    snapshot: {
      sourceRef,
      instrument,
      policyRevision: resolved.revision,
      submission: {
        walletAddress: prepared.intent.walletAddress,
        positionOwner:
          typeof payload.positionWalletAddress === "string"
            ? payload.positionWalletAddress
            : prepared.intent.walletAddress,
        assetContext: payload.assetContext ?? null,
        marketAddress: payload.marketAddress ?? null,
      },
    },
  };
}

/** Commit exact identity before submit. A retry is reconciliation, never a fresh buy. */
export async function retainCopyBeforeSubmission(
  pool: Pool,
  input: {
    prepared: PreparedTrade;
    providerReference: string;
    preparedFingerprint: string;
    limitlessPositionContract?: string;
  },
): Promise<RetainedCopyAttempt> {
  if (!input.prepared.intent.sourceRef)
    throw new SocialError("copy_source_required");
  const userId = input.prepared.intent.actor.userId;
  const key = input.prepared.intent.idempotencyKey;
  const payloadHash = copyPayloadHash(input.prepared);
  return tx(pool, async (client) => {
    // Account deletion/merge acquires these same user rows. A new authorization
    // cannot pass an activity check before deletion and insert after its commit.
    const accounts = await client.query<{ id: string; is_active: boolean }>(
      `select id,is_active from users where id=$1 or id=(select author_id from user_theses where id=$2)
      order by id for update`,
      [
        userId,
        input.prepared.intent.sourceRef?.kind === "thesis"
          ? input.prepared.intent.sourceRef.id
          : null,
      ],
    );
    if (!accounts.rows.find((account) => account.id === userId)?.is_active)
      throw new SocialError("social_account_unavailable", 403);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `social-copy:${userId}:${key}`,
    ]);
    const existing = await client.query<{
      id: string;
      payload_hash: string;
      provider_reference: string;
      prepared_fingerprint: string;
      state: string;
      submission_started_at: Date | null;
    }>(
      `
      select id,payload_hash,provider_reference,prepared_fingerprint,state,submission_started_at from copy_attributions
      where copier_user_id=$1 and idempotency_key=$2 for update`,
      [userId, key],
    );
    if (existing.rows[0]) {
      const saved = existing.rows[0];
      if (
        saved.payload_hash !== payloadHash ||
        saved.provider_reference !== input.providerReference ||
        saved.prepared_fingerprint !== input.preparedFingerprint
      )
        throw new SocialError("copy_idempotency_conflict", 409);
      const retried = await client.query<{ submission_attempt_token: string }>(
        `update copy_attributions
        set submission_attempt_token=gen_random_uuid(),state=case when state='failed' then 'pending' else state end,
          submission_started_at=case when state='failed' then null else submission_started_at end,
          repair_due_at=now(),updated_at=now() where id=$1 returning submission_attempt_token`,
        [saved.id],
      );
      const attempt = retried.rows[0];
      if (!attempt)
        throw new Error("Copy retry did not return attempt identity");
      return {
        id: saved.id,
        created: false,
        attemptToken: attempt.submission_attempt_token,
        priorSubmissionUncertain:
          saved.state !== "failed" && saved.submission_started_at !== null,
      };
    }
    const source = await authorizeCopySource(client, input.prepared, input);
    const inserted = await client.query<{
      id: string;
      submission_attempt_token: string;
    }>(
      `insert into copy_attributions
      (copier_user_id,source_thesis_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference)
      values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9) returning id,submission_attempt_token`,
      [
        userId,
        source.sourceRef.kind === "thesis" ? source.sourceRef.id : null,
        source.sourceRef.kind === "hunch" ? source.sourceRef.id : null,
        JSON.stringify(source.snapshot),
        JSON.stringify(source.instrument),
        key,
        payloadHash,
        input.preparedFingerprint,
        input.providerReference,
      ],
    );
    const saved = inserted.rows[0];
    if (!saved) throw new Error("Copy insert did not return identity");
    return {
      id: saved.id,
      created: true,
      attemptToken: saved.submission_attempt_token,
      priorSubmissionUncertain: false,
    };
  });
}

/** No executor may cross its request boundary without retaining broadcast uncertainty. */
export async function markCopySubmissionStarted(
  db: Db,
  userId: string,
  attempt: RetainedCopyAttempt,
): Promise<void> {
  const result = await db.query(
    `update copy_attributions set submission_started_at=coalesce(submission_started_at,now()),updated_at=now()
    where id=$1 and copier_user_id=$2 and submission_attempt_token=$3 returning id`,
    [attempt.id, userId, attempt.attemptToken],
  );
  if (!result.rows.length)
    throw new SocialError("copy_attempt_superseded", 409);
}

/** A failed preflight cannot erase a previous or concurrent request's uncertainty. */
export async function markCopyDefinitelyNotBroadcast(
  db: Db,
  userId: string,
  attempt: RetainedCopyAttempt,
): Promise<void> {
  await db.query(
    `update copy_attributions set state='failed',updated_at=now()
    where id=$1 and copier_user_id=$2 and submission_attempt_token=$3
      and submission_started_at is null and state='pending'`,
    [attempt.id, userId, attempt.attemptToken],
  );
}

/** Only a first-attempt authoritative rejection proves no earlier submit succeeded. */
export async function markCopyDefinitiveProviderRejection(
  db: Db,
  userId: string,
  attempt: RetainedCopyAttempt,
): Promise<void> {
  if (attempt.priorSubmissionUncertain) return;
  await db.query(
    `update copy_attributions set state='failed',updated_at=now()
    where id=$1 and copier_user_id=$2 and submission_attempt_token=$3 and state='pending'`,
    [attempt.id, userId, attempt.attemptToken],
  );
}

export async function linkPersistedCopy(
  db: Db,
  input: { userId: string; idempotencyKey: string; persisted: PersistedTrade },
): Promise<void> {
  await db.query(
    `update copy_attributions set order_id=coalesce(order_id,$3),execution_id=coalesce(execution_id,$4),updated_at=now()
    where copier_user_id=$1 and idempotency_key=$2 and (order_id is null or order_id=$3)
      and (execution_id is null or execution_id=$4)`,
    [
      input.userId,
      input.idempotencyKey,
      input.persisted.orderId,
      input.persisted.executionId,
    ],
  );
  if (input.persisted.orderId)
    await db.query(
      "update orders set verified_buy_due_at=now() where id=$1 and user_id=$2",
      [input.persisted.orderId, input.userId],
    );
  if (input.persisted.executionId)
    await db.query(
      "update executions set verified_buy_due_at=now() where id=$1 and user_id=$2",
      [input.persisted.executionId, input.userId],
    );
}

/** Called after observation, never inferred from execution.status. */
export async function reconcileCopyFacts(
  db: Db,
  input: {
    purchaseRef: { kind: "order" | "execution"; id: string };
    userId: string;
    state: "pending" | "verified" | "revoked";
    facts: VerifiedBuyFacts | null;
  },
): Promise<void> {
  const column =
    input.purchaseRef.kind === "order" ? "order_id" : "execution_id";
  const table = input.purchaseRef.kind === "order" ? "orders" : "executions";
  if (input.state === "pending") return;
  if (input.state === "revoked") {
    await db.query(
      `update copy_attributions set state='revoked',updated_at=now()
      where ${column}=$1 and copier_user_id=$2 and exists(select 1 from ${table} purchase_row
        where purchase_row.id=$1 and purchase_row.user_id=$2 and purchase_row.verified_buy_state='revoked')`,
      [input.purchaseRef.id, input.userId],
    );
    return;
  }
  if (!input.facts) return;
  await db.query(
    `update copy_attributions set state='confirmed',canonical_purchase_key=$3,facts_revision=$4,
      confirmed_at=coalesce(confirmed_at,now()),updated_at=now()
    where ${column}=$1 and copier_user_id=$2 and instrument=$5::jsonb
      and exists(select 1 from ${table} purchase_row where purchase_row.id=$1 and purchase_row.user_id=$2
        and purchase_row.verified_buy_state='verified' and purchase_row.verified_buy_facts->>'evidenceRevision'=$4)`,
    [
      input.purchaseRef.id,
      input.userId,
      input.facts.canonicalPurchaseKey,
      input.facts.evidenceRevision,
      JSON.stringify(input.facts.instrument),
    ],
  );
}

/** Bounded identity-only recovery; never amount/time proximity or resubmission. */
export async function recoverCopyPurchaseLinks(
  db: Db,
  limit: number,
): Promise<number> {
  const pending = await db.query<{
    id: string;
    copier_user_id: string;
    provider_reference: string;
    instrument: Instrument;
  }>(
    `
    select id,copier_user_id,provider_reference,instrument from copy_attributions
    where copier_user_id is not null and state='pending' and order_id is null and execution_id is null
    order by updated_at,id limit $1`,
    [limit],
  );
  let linked = 0;
  for (const row of pending.rows) {
    let orderId: string | null = null,
      executionId: string | null = null;
    const poly = row.provider_reference.match(
      /^polymarket:137:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/i,
    );
    const dflow = row.provider_reference.match(
      /^dflow:mainnet:([^:]+):([^:]+)$/,
    );
    const clob = row.provider_reference.match(/^limitless:clob:8453:(.+)$/);
    const amm = row.provider_reference.match(
      /^limitless:amm:8453:(0x[0-9a-f]{64}):(\d+)$/i,
    );
    if (poly?.[1] && poly[2]) {
      const found = await db.query<{ id: string }>(
        `select id from orders where user_id=$1 and venue='polymarket'
        and lower(order_hash)=$2 and lower(order_payload->'assetContext'->>'exchangeAddress')=$3 order by id limit 1`,
        [row.copier_user_id, poly[2].toLowerCase(), poly[1].toLowerCase()],
      );
      orderId = found.rows[0]?.id ?? null;
    } else if (dflow?.[1] && dflow[2]) {
      const found = await db.query<{ id: string }>(
        `select id from executions where user_id=$1 and venue='kalshi'
        and tx_signature=$2 and wallet_address=$3 order by created_at,id limit 1`,
        [row.copier_user_id, dflow[1], dflow[2]],
      );
      executionId = found.rows[0]?.id ?? null;
    } else if (clob?.[1]) {
      const found = await db.query<{ id: string }>(
        `select id from orders where user_id=$1 and venue='limitless'
        and coalesce(order_payload->>'clientOrderId',order_payload->'submitted'->>'clientOrderId',order_payload->'_hunchSubmitted'->>'clientOrderId')=$2
        order by id limit 1`,
        [row.copier_user_id, clob[1]],
      );
      orderId = found.rows[0]?.id ?? null;
    } else if (amm?.[1] && amm[2]) {
      const found = await db.query<{ id: string }>(
        `select id from orders where user_id=$1 and venue='limitless'
        and venue_order_id=$2 order by id limit 1`,
        [row.copier_user_id, `amm:${amm[1].toLowerCase()}:${amm[2]}`],
      );
      orderId = found.rows[0]?.id ?? null;
    }
    await db.query(
      `update copy_attributions set order_id=$2,execution_id=$3,updated_at=now()
      where id=$1 and order_id is null and execution_id is null`,
      [row.id, orderId, executionId],
    );
    if (orderId) {
      linked++;
      await db.query(
        "update orders set verified_buy_due_at=now() where id=$1",
        [orderId],
      );
    }
    if (executionId) {
      linked++;
      await db.query(
        "update executions set verified_buy_due_at=now() where id=$1",
        [executionId],
      );
    }
  }
  return linked;
}
