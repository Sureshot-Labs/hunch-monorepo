import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "@hunch/infra";
import { hip4Identity } from "@hunch/shared";
import { z } from "zod";
import {
  socialTradeAttributionFields,
  refineSocialTradeAttribution,
} from "../schemas/social-trade.js";
import { buildHip4SocialInstrument } from "../services/hip4-social-instrument.js";
import type { WalletExecutionProfile } from "../funding/domain/types.js";
import { lockFundingControllerWallet } from "../funding/execution/funding-controller-wallet-lock.js";
import { HyperliquidNonceConflictError } from "../funding/execution/hyperliquid-nonce-claims.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { calculateHip4OrderAmounts } from "../services/hip4-order-amounts.js";
import { readHip4TradingPolicy } from "./hip4-trading-policy.js";
import {
  quoteHip4OrderFees,
  type Hip4OrderFeeObservation,
} from "../services/hip4-order-fees.js";
import {
  prepareHip4TradeSigning,
  type Hip4TradeSigningInput,
} from "../services/hip4-trade-signing.js";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const hip4OrderPreparationRequestSchema = z
  .object({
    requestKey: uuid,
    marketId: z.string().regex(/^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u),
    outcomeSide: z.enum(["YES", "NO"]),
    side: z.enum(["BUY", "SELL"]),
    timeInForce: z.enum(["Gtc", "Ioc", "Alo"]),
    limitPrice: z.string().max(128),
    quantity: z.string().max(128),
    consentedDebitCapRaw: z.string().max(128),
    controllerWalletRef: uuid,
    ...socialTradeAttributionFields,
  })
  .strict()
  .superRefine(refineSocialTradeAttribution);
export type Hip4OrderPreparationRequest = z.infer<
  typeof hip4OrderPreparationRequestSchema
>;
export const hip4CancelPreparationRequestSchema = z
  .object({ requestKey: uuid, orderId: uuid })
  .strict();
export type Hip4CancelPreparationRequest = z.infer<
  typeof hip4CancelPreparationRequestSchema
>;

/** Shared deterministic amount validation. Runtime uses a provisional zero
 * only before provider IO; actual fee terms are applied before persistence. */
export function normalizeHip4OrderPreparationAmounts(
  request: Hip4OrderPreparationRequest,
  policy: Awaited<ReturnType<typeof readHip4TradingPolicy>> | undefined,
  feeCapRaw: string | null,
) {
  const amounts = calculateHip4OrderAmounts({
    ...request,
    environment: "mainnet",
    policy,
    feeCapRaw,
  });
  if (amounts.kind !== "calculated" || !amounts.validation.valid)
    throw new Error(
      `hip4_preparation_${amounts.kind === "invalid" ? amounts.reason : amounts.validation.reason}`,
    );
  return amounts;
}

/** Exact terms shared by a read-only quote and durable preparation. The cloid
 * on a quote is not an authorization; only persistAction reserves an identity. */
export function buildHip4OrderPreparationTerms(input: {
  request: Hip4OrderPreparationRequest;
  policy: Awaited<ReturnType<typeof readHip4TradingPolicy>> | undefined;
  feeCapRaw: string | null;
  feeObservation?: Hip4OrderFeeObservation;
  address: string;
  cloid: string;
}) {
  const { request, policy } = input;
  const identity = hip4Identity(
    "mainnet",
    Number(request.marketId.split(":").at(-1)),
  );
  const token = identity.sides[request.outcomeSide === "YES" ? 0 : 1];
  let amounts = normalizeHip4OrderPreparationAmounts(
    request,
    policy,
    input.feeObservation ? "0" : input.feeCapRaw,
  );
  const action = {
    type: "order" as const,
    grouping: "na" as const,
    orders: [
      {
        a: token.assetId,
        b: request.side === "BUY",
        p: amounts.limitPrice,
        s: amounts.quantity,
        r: false as const,
        t: { limit: { tif: request.timeInForce } },
        c: input.cloid,
      },
    ],
  };
  const feeQuote = input.feeObservation
    ? quoteHip4OrderFees({
        observation: input.feeObservation,
        address: input.address,
        action,
      })
    : null;
  if (feeQuote) {
    const feeAmounts = calculateHip4OrderAmounts({
      ...request,
      environment: "mainnet",
      policy,
      feeCapRaw: feeQuote.buyFeeCapRaw,
      ...(request.side === "SELL"
        ? { sellFeeEstimateAtLimitRaw: feeQuote.estimatedFeeAtLimitRaw }
        : {}),
    });
    if (feeAmounts.kind !== "calculated" || !feeAmounts.validation.valid)
      throw new Error("hip4_preparation_fee_amounts_invalid");
    amounts = feeAmounts;
  }
  return { identity, token, amounts, action, feeQuote };
}

type PreparedRow = {
  id: string;
  order_id: string;
  user_id: string;
  request_fingerprint: string;
  action_fingerprint: string;
  unsigned_envelope: Hip4TradeSigningInput;
  preparation_snapshot: Record<string, unknown>;
  state: "prepared" | "abandoned";
  cloid: string;
  canonical_market_id: string;
  token_id: string;
  signer_address: string;
};
export const HIP4_PREPARATION_LOOKUP_SQL = `select action_row.*, order_row.user_id
  from hip4_order_actions action_row join orders order_row on order_row.id=action_row.order_id
  where action_row.request_key=$1`;
export const HIP4_OWNED_ORDER_ACTION_SQL = `select action_row.*, order_row.user_id
  from orders order_row join hip4_order_actions action_row on action_row.order_id=order_row.id
  where order_row.id=$1 and order_row.user_id=$2 and order_row.venue='hyperliquid'
    and action_row.action_kind='order'`;

function replay(
  row: PreparedRow | undefined,
  userId: string,
  fingerprint: string,
) {
  if (!row) return null;
  if (row.user_id !== userId || row.request_fingerprint !== fingerprint)
    throw new Error("hip4_preparation_conflict");
  return result(row);
}
function result(row: PreparedRow) {
  return {
    actionId: row.id,
    orderId: row.order_id,
    cloid: row.cloid,
    state: row.state,
    envelope: row.unsigned_envelope,
    snapshot: row.preparation_snapshot,
  };
}

/** One ownership-scoped snapshot before provider IO. Locked persistence repeats
 * the idempotency check; this read never reserves a nonce or creates an order. */
export async function readHip4OrderPreparationReplay(
  db: Pick<Pool, "query">,
  input: { userId: string; request: Hip4OrderPreparationRequest },
) {
  const userId = uuid.parse(input.userId);
  const request = hip4OrderPreparationRequestSchema.parse(input.request);
  const prior = await db.query<PreparedRow>(HIP4_PREPARATION_LOOKUP_SQL, [
    request.requestKey,
  ]);
  return replay(prior.rows[0], userId, canonicalJsonHash(request));
}

function cancelFingerprint(request: Hip4CancelPreparationRequest) {
  return canonicalJsonHash({ kind: "cancelByCloid", ...request });
}
export async function readHip4CancelPreparationReplay(
  db: Pick<Pool, "query">,
  input: { userId: string; request: Hip4CancelPreparationRequest },
) {
  const userId = uuid.parse(input.userId);
  const request = hip4CancelPreparationRequestSchema.parse(input.request);
  const prior = await db.query<PreparedRow>(HIP4_PREPARATION_LOOKUP_SQL, [
    request.requestKey,
  ]);
  return replay(prior.rows[0], userId, cancelFingerprint(request));
}
export async function readHip4OwnedOrderAction(
  db: Pick<Pool, "query">,
  input: { userId: string; orderId: string },
) {
  const found = await db.query<PreparedRow>(HIP4_OWNED_ORDER_ACTION_SQL, [
    uuid.parse(input.orderId),
    uuid.parse(input.userId),
  ]);
  const original = found.rows[0];
  if (!original) throw new Error("hip4_cancel_order_not_found");
  return original;
}

async function persistAction(
  client: PoolClient,
  input: {
    orderId: string;
    requestKey: string;
    requestFingerprint: string;
    marketId: string;
    tokenId: string;
    signer: string;
    cloid: string;
    envelope: Hip4TradeSigningInput;
    snapshot: Record<string, unknown>;
  },
) {
  // Strict reconstruction rejects extra fields (including signatures). Only
  // unsigned authorization material is stored; network submission is elsewhere.
  const prepared = prepareHip4TradeSigning(input.envelope);
  const envelope: Hip4TradeSigningInput = {
    environment: prepared.environment,
    action: prepared.action,
    nonce: prepared.nonce,
    expiresAfter: prepared.expiresAfter,
    vaultAddress: prepared.vaultAddress,
  };
  const actionId = randomUUID();
  const fingerprint = canonicalJsonHash(envelope);
  const rows = await client.query<PreparedRow>(
    `insert into hip4_order_actions
    (id,order_id,request_key,request_fingerprint,action_kind,environment,signer_address,
     canonical_market_id,token_id,cloid,nonce,action_fingerprint,unsigned_envelope,preparation_snapshot)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13::jsonb,$14::jsonb) returning *`,
    [
      actionId,
      input.orderId,
      input.requestKey,
      input.requestFingerprint,
      prepared.action.type,
      prepared.environment,
      input.signer,
      input.marketId,
      input.tokenId,
      input.cloid,
      String(prepared.nonce),
      fingerprint,
      envelope,
      input.snapshot,
    ],
  );
  const claim = await client.query(
    `insert into hyperliquid_nonce_claims
    (environment,signer_address,nonce,action_fingerprint,order_action_id)
    values($1,$2,$3::bigint,$4,$5) on conflict do nothing returning nonce`,
    [
      prepared.environment,
      input.signer,
      String(prepared.nonce),
      fingerprint,
      actionId,
    ],
  );
  if (!claim.rowCount) throw new HyperliquidNonceConflictError();
  // Check AFTER all potentially waiting writes, including the shared nonce
  // claim. A failed fence rolls this transaction back and leaves the same
  // request key available for a fresh preparation.
  const checkedAt = (
    await client.query<{ checked_at: Date }>(
      "select clock_timestamp() as checked_at",
    )
  ).rows[0].checked_at.getTime();
  if (envelope.expiresAfter === null || envelope.expiresAfter <= checkedAt)
    throw new Error("hip4_preparation_expired");
  return result(rows.rows[0]);
}

/** Internal persistence boundary, NOT a public trade prepare/admission API.
 * Caller owns the transaction and supplies current server-resolved snapshots.
 * Errors must roll it back. No cash reservation is consumed, no funding
 * operation is manufactured, and no signer/exchange is called here.
 * Admission must revalidate policy, ownership, fees, market and capacity later.
 */
export async function persistHip4OrderPreparationInTransaction(
  client: PoolClient,
  input: {
    userId: string;
    request: Hip4OrderPreparationRequest;
    profile: WalletExecutionProfile;
    feeCapRaw: string | null;
    feeObservation?: Hip4OrderFeeObservation;
    marketRevision: string;
    accountRevision: string;
    nonce: number;
    expiresAfter: number;
  },
) {
  input = { ...input, userId: uuid.parse(input.userId) };
  const request = hip4OrderPreparationRequestSchema.parse(input.request);
  const fingerprint = canonicalJsonHash(request);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `hip4-preparation:${request.requestKey}`,
  ]);
  const prior = await client.query<PreparedRow>(HIP4_PREPARATION_LOOKUP_SQL, [
    request.requestKey,
  ]);
  const existing = replay(prior.rows[0], input.userId, fingerprint);
  if (existing) return existing;
  if (
    input.profile.controllerWalletRef?.toLowerCase() !==
      request.controllerWalletRef ||
    input.profile.networkId !== "hyperliquid:mainnet" ||
    !/^0x[0-9a-fA-F]{40}$/u.test(input.profile.address) ||
    !input.marketRevision.trim() ||
    !input.accountRevision.trim() ||
    !Number.isSafeInteger(input.expiresAfter) ||
    input.expiresAfter <= input.nonce
  )
    throw new Error("hip4_preparation_context_invalid");
  await lockFundingControllerWallet(client, input.userId, input.profile);
  const identity = hip4Identity(
    "mainnet",
    Number(request.marketId.split(":").at(-1)),
  );
  const token = identity.sides[request.outcomeSide === "YES" ? 0 : 1];
  const market = await client.query(
    `select id,metadata,expiration_time from unified_markets
    where id=$1 and venue='hyperliquid' and status='ACTIVE' for share`,
    [identity.marketId],
  );
  if (market.rows.length !== 1)
    throw new Error("hip4_preparation_market_unavailable");
  const marketRow = market.rows[0];
  const socialInstrumentSnapshot = marketRow.metadata?.hip4 ?? null;
  const socialInstrument =
    request.side === "BUY"
      ? buildHip4SocialInstrument({
          marketId: identity.marketId,
          tokenId: token.tokenId,
          outcome: request.outcomeSide,
          expiry: marketRow.expiration_time?.toISOString() ?? null,
          snapshot: socialInstrumentSnapshot,
        })
      : null;
  if (request.sourceRef && !socialInstrument)
    throw new Error("hip4_copy_instrument_unavailable");
  const policy =
    request.side === "BUY" ? await readHip4TradingPolicy(client) : undefined;
  const orderId = randomUUID();
  const cloid = `0x${randomBytes(16).toString("hex")}`;
  const signer = input.profile.address.toLowerCase();
  const { amounts, action, feeQuote } = buildHip4OrderPreparationTerms({
    request,
    policy,
    address: signer,
    cloid,
    feeCapRaw: input.feeCapRaw,
    feeObservation: input.feeObservation,
  });
  await client.query(
    `insert into orders
    (id,user_id,venue,token_id,side,order_type,price,size,status,wallet_address,signer_address)
    values($1,$2,'hyperliquid',$3,$4,$5,$6::numeric,$7::numeric,'prepared',$8,$8)`,
    [
      orderId,
      input.userId,
      token.tokenId,
      request.side,
      request.timeInForce.toUpperCase(),
      amounts.limitPrice,
      amounts.quantity,
      signer,
    ],
  );
  return persistAction(client, {
    orderId,
    requestKey: request.requestKey,
    requestFingerprint: fingerprint,
    marketId: identity.marketId,
    tokenId: token.tokenId,
    signer,
    cloid,
    envelope: {
      environment: "mainnet",
      nonce: input.nonce,
      expiresAfter: input.expiresAfter,
      vaultAddress: null,
      action,
    },
    snapshot: {
      // Computed debit can be below the user's maximum after lot rounding.
      // Keep the exact original cap for sealed consumers; a request hash alone
      // cannot reconstruct it. Old unsealed preparations remain compatible.
      consentedDebitCapRaw: request.consentedDebitCapRaw,
      amounts,
      feeQuote,
      feeObservation: input.feeObservation ?? null,
      profile: input.profile,
      marketRevision: input.marketRevision,
      accountRevision: input.accountRevision,
      policy: policy ?? null,
      ...(socialInstrument
        ? { socialInstrument, socialInstrumentSnapshot }
        : {}),
      ...(request.sourceRef
        ? {
            sourceRef: request.sourceRef,
            copyIdempotencyKey: request.copyIdempotencyKey,
          }
        : {}),
    },
  });
}

/** Cancellation has its own protocol action/nonce but the SAME economic order.
 * It deliberately does not check BUY cash, the BUY minimum or market ACTIVE.
 * Preparing a cancellation does not mark the order cancelled or release cash.
 */
export async function persistHip4CancelPreparationInTransaction(
  client: PoolClient,
  input: {
    userId: string;
    orderId: string;
    requestKey: string;
    profile: WalletExecutionProfile;
    nonce: number;
    expiresAfter: number;
    policyRevision?: string;
  },
) {
  input = {
    ...input,
    userId: uuid.parse(input.userId),
    requestKey: uuid.parse(input.requestKey),
    orderId: uuid.parse(input.orderId),
  };
  const fingerprint = cancelFingerprint({
    orderId: input.orderId,
    requestKey: input.requestKey,
  });
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `hip4-preparation:${input.requestKey}`,
  ]);
  const prior = await client.query<PreparedRow>(HIP4_PREPARATION_LOOKUP_SQL, [
    input.requestKey,
  ]);
  const existing = replay(prior.rows[0], input.userId, fingerprint);
  if (existing) return existing;
  await lockFundingControllerWallet(client, input.userId, input.profile);
  const original = (
    await client.query<PreparedRow>(
      `${HIP4_OWNED_ORDER_ACTION_SQL} for update of order_row`,
      [input.orderId, input.userId],
    )
  ).rows[0];
  if (
    !original ||
    input.profile.networkId !== "hyperliquid:mainnet" ||
    input.profile.address.toLowerCase() !== original.signer_address ||
    !Number.isSafeInteger(input.expiresAfter) ||
    input.expiresAfter <= input.nonce
  )
    throw new Error("hip4_cancel_preparation_context_invalid");
  const order = prepareHip4TradeSigning(original.unsigned_envelope).action;
  if (order.type !== "order" || order.orders.length !== 1)
    throw new Error("hip4_cancel_preparation_identity_invalid");
  return persistAction(client, {
    orderId: original.order_id,
    requestKey: input.requestKey,
    requestFingerprint: fingerprint,
    marketId: original.canonical_market_id,
    tokenId: original.token_id,
    signer: original.signer_address,
    cloid: original.cloid,
    envelope: {
      environment: "mainnet",
      nonce: input.nonce,
      expiresAfter: input.expiresAfter,
      vaultAddress: null,
      action: {
        type: "cancelByCloid",
        cancels: [{ asset: order.orders[0].a, cloid: original.cloid }],
      },
    },
    snapshot: {
      profile: input.profile,
      originalActionId: original.id,
      ...(input.policyRevision ? { policyRevision: input.policyRevision } : {}),
    },
  });
}
