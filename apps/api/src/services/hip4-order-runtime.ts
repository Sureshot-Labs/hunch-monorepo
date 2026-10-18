import { tx, type Pool } from "@hunch/infra";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import { hip4Identity } from "@hunch/shared";
import { z } from "zod";
import { assertFundingControllerWallet } from "../funding/execution/funding-controller-wallet-lock.js";
import { fetchFundingConsumerReservationForUser } from "../funding/persistence/funding-evidence-repository.js";
import {
  inspectHip4PreparedAction,
  readHip4OrderSubmissionAttempt,
  readHip4TradeLifecycle,
  type Hip4OrderSubmitReference,
  type Hip4OrderSubmitRequest,
} from "../repos/hip4-order-admission.js";
import {
  readHip4OrderCapacity,
  readHip4OrderQuoteCapacity,
} from "./hip4-financial-observation.js";
import { readHip4OrderFeeObservation } from "./hip4-order-fees.js";
import { submitHip4OrderAction } from "./hip4-order-submission.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";
import { createHip4ReadClient } from "./hip4-client.js";
import {
  hip4MarketOrderQuoteRequestSchema,
  sizeHip4MarketOrder,
  type Hip4MarketOrderQuoteRequest,
} from "./hip4-market-order.js";
import { readHip4OrderController } from "../repos/hip4-order-controller.js";
import {
  hip4OrderPreparationRequestSchema,
  readHip4OrderPreparationReplay,
  persistHip4OrderPreparationInTransaction,
  normalizeHip4OrderPreparationAmounts,
  buildHip4OrderPreparationTerms,
  hip4CancelPreparationRequestSchema,
  readHip4CancelPreparationReplay,
  readHip4OwnedOrderAction,
  persistHip4CancelPreparationInTransaction,
  type Hip4CancelPreparationRequest,
  type Hip4OrderPreparationRequest,
} from "../repos/hip4-order-preparation.js";
import {
  readHip4TradingPolicy,
  readHip4CancelPolicy,
  readHip4MarketQuotePolicy,
} from "../repos/hip4-trading-policy.js";
import { prepareHip4TradeSigning } from "./hip4-trade-signing.js";
import {
  readTelegramAppHandoffV2Binding,
  telegramAppHandoffV2BindingSchema,
} from "./telegram-app-handoff-v2-contract.js";
import type { TelegramAppHandoffV2ScopeAssertion } from "../repos/telegram-app-handoff-v2-direct-trade-repository.js";
import { socialTradeAttributionFields } from "../schemas/social-trade.js";
import { currentHip4NativeInstrument } from "./hip4-native-instrument.js";
import {
  readHip4AccountPolicy,
  readHip4AccountSnapshot,
} from "./hip4-account-repository.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { createHip4QuotePreviewCache } from "./hip4-quote-preview-cache.js";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const requestSchema = z
  .object({
    userId: uuid,
    actionId: uuid,
    signature: z.string().max(132),
    actor: z.literal("web_app"),
    ...socialTradeAttributionFields,
    telegramAppHandoffId:
      telegramAppHandoffV2BindingSchema.shape.handoffId.optional(),
    telegramAppHandoffPlanFingerprint:
      telegramAppHandoffV2BindingSchema.shape.planFingerprint.optional(),
    funding: z
      .object({ operationId: uuid, reservationId: uuid })
      .strict()
      .optional(),
  })
  .strict();

type PreparationInput = {
  userId: string;
  actor: "web_app";
  request: Hip4OrderPreparationRequest;
};
export type Hip4OrderRuntimeDependencies = {
  fetcher?: typeof fetch;
  capabilityCheck?: Parameters<typeof readHip4TradeLifecycle>[2];
  telegramAppHandoffScope?: TelegramAppHandoffV2ScopeAssertion;
};
type Hip4QuotePreviewFacts = {
  feeObservation: Awaited<ReturnType<typeof readHip4OrderFeeObservation>>;
  capacity: Awaited<ReturnType<typeof readHip4OrderQuoteCapacity>>;
};
const quotePreviewCaches = new WeakMap<
  Pool,
  WeakMap<
    typeof fetch,
    ReturnType<typeof createHip4QuotePreviewCache<Hip4QuotePreviewFacts>>
  >
>();

function quotePreviewCache(pool: Pool, fetcher: typeof fetch) {
  let byFetcher = quotePreviewCaches.get(pool);
  if (!byFetcher) {
    byFetcher = new WeakMap();
    quotePreviewCaches.set(pool, byFetcher);
  }
  let cache = byFetcher.get(fetcher);
  if (!cache) {
    cache = createHip4QuotePreviewCache<Hip4QuotePreviewFacts>();
    byFetcher.set(fetcher, cache);
  }
  return cache;
}
const preparationInputSchema = z
  .object({
    userId: uuid,
    actor: z.literal("web_app"),
    request: hip4OrderPreparationRequestSchema,
  })
  .strict();

/** Read-only, current terms for the common quote/prepare adapter. No nonce,
 * order, cash reservation, provider submission or signature is created. */
export async function quoteHip4OrderWithCurrentContext(
  pool: Pool,
  input: PreparationInput,
  dependencies: Hip4OrderRuntimeDependencies = {},
) {
  return readHip4OrderContext(pool, input, dependencies, "quote");
}

async function readHip4OrderContext(
  pool: Pool,
  input: PreparationInput,
  dependencies: Hip4OrderRuntimeDependencies,
  phase: "quote" | "prepare",
) {
  input = preparationInputSchema.parse(input);
  await readHip4TradeLifecycle(
    pool,
    input.request.side,
    dependencies.capabilityCheck,
  );
  const profile = await readHip4OrderController(pool, {
    userId: input.userId,
    controllerWalletRef: input.request.controllerWalletRef,
  });
  const policy =
    input.request.side === "BUY"
      ? await readHip4TradingPolicy(pool)
      : undefined;
  normalizeHip4OrderPreparationAmounts(input.request, policy, "0");
  const identity = hip4Identity(
    "mainnet",
    Number(input.request.marketId.split(":").at(-1)),
  );
  const market = (
    await pool.query<{
      metadata: unknown;
      status: string;
      expiration_time: Date | null;
    }>(
      "select metadata,status,expiration_time from unified_markets where id=$1 and venue='hyperliquid'",
      [input.request.marketId],
    )
  ).rows[0];
  const nativeInstrument = market
    ? currentHip4NativeInstrument({
        marketId: input.request.marketId,
        tokenId:
          identity.sides[input.request.outcomeSide === "YES" ? 0 : 1].tokenId,
        outcome: input.request.outcomeSide,
        expiry: market.expiration_time?.toISOString() ?? null,
        metadata: market.metadata,
        status: market.status,
        now: Date.now(),
      })
    : null;
  if (!nativeInstrument) throw new Error("hip4_market_unavailable");
  const scope = {
    address: profile.address,
    marketId: input.request.marketId,
    side: input.request.side,
  };
  const loadFacts = async (): Promise<Hip4QuotePreviewFacts> => {
    const [feeObservation, capacity] = await Promise.all([
      readHip4OrderFeeObservation(pool, scope, dependencies.fetcher),
      (phase === "quote" ? readHip4OrderQuoteCapacity : readHip4OrderCapacity)(
        pool,
        { ...scope, outcomeSide: input.request.outcomeSide },
        dependencies.fetcher,
      ),
    ]);
    return { feeObservation, capacity };
  };
  let facts: Hip4QuotePreviewFacts;
  let previewValidUntil = Infinity;
  if (phase === "quote") {
    const [read, account] = await Promise.all([
      readHip4Policy(pool, "accountRead"),
      readHip4AccountPolicy(pool),
    ]);
    if (
      !read.policy.enabled ||
      !account.policy.enabled ||
      read.policy.environment !== "mainnet"
    )
      throw new Error("native_account_read_unavailable");
    const previewDeadline = ({
      feeObservation,
      capacity,
    }: Hip4QuotePreviewFacts) =>
      Math.min(
        Date.parse(feeObservation.expiresAt),
        Date.parse(capacity.expiresAt),
        Date.parse(feeObservation.observedAt) + account.policy.snapshotMaxAgeMs,
        Date.parse(capacity.observedAt) + account.policy.snapshotMaxAgeMs,
        nativeInstrument.expiry
          ? Date.parse(nativeInstrument.expiry)
          : Infinity,
      );
    const cache = quotePreviewCache(pool, dependencies.fetcher ?? fetch);
    if (read.policy.quotePreviewCacheEntries === 0) {
      facts = await cache.read("disabled", 0, loadFacts, previewDeadline);
    } else {
      const [snapshot, sellTradingPolicy] = await Promise.all([
        readHip4AccountSnapshot(pool, "mainnet", profile.address).catch(
          (error: unknown) => {
            // This optional display snapshot only invalidates preview reuse. A
            // malformed legacy row must not block a healthy fresh provider read.
            if (error instanceof z.ZodError) return undefined;
            throw error;
          },
        ),
        // SELL must not start depending on unrelated BUY-floor validation.
        policy
          ? Promise.resolve(null)
          : fetchActiveRuntimePolicy(pool, "hip4_trading", new Date(), {
              missingTable: "error",
            }),
      ]);
      const key = canonicalJsonHash({
        userId: input.userId,
        controllerWalletRef: input.request.controllerWalletRef,
        address: profile.address,
        environment: read.policy.environment,
        marketId: input.request.marketId,
        side: input.request.side,
        outcomeSide: input.request.outcomeSide,
        readRevision: read.revision,
        accountRevision: account.revision,
        accountPolicy: account.policy,
        tradingRevision: policy?.revision ?? null,
        sellTradingPolicy: sellTradingPolicy
          ? { id: sellTradingPolicy.id, payload: sellTradingPolicy.payload }
          : null,
        instrument: nativeInstrument.generation,
        // An explicit post-funding account refresh changes this bounded stored
        // observation. Reuse must not retain the old preview cash until its TTL.
        storedAccountObservation: snapshot?.observation ?? null,
      });
      facts =
        snapshot === undefined
          ? await loadFacts()
          : await cache.read(
              key,
              read.policy.quotePreviewCacheEntries,
              loadFacts,
              previewDeadline,
            );
    }
    previewValidUntil = previewDeadline(facts);
  } else {
    // Strict preparation/submission readers never consume preview facts.
    facts = await loadFacts();
  }
  const { feeObservation, capacity } = facts;
  const { amounts, feeQuote } = buildHip4OrderPreparationTerms({
    request: input.request,
    policy,
    feeObservation,
    feeCapRaw: null,
    address: profile.address,
    cloid: `0x${"0".repeat(32)}`,
  });
  const expiresAfter = Math.min(
    Date.parse(capacity.expiresAt),
    Date.parse(feeObservation.expiresAt),
    previewValidUntil,
    nativeInstrument.expiry ? Date.parse(nativeInstrument.expiry) : Infinity,
  );
  if (expiresAfter <= Date.now()) throw new Error("hip4_preparation_expired");
  return {
    profile,
    capacity,
    feeObservation,
    amounts,
    feeQuote,
    expiresAfter,
  };
}

/** USD BUY / token-sized SELL entry into the SAME exact-terms preparation.
 * Only a bounded public L2 read is added, under the existing shared info
 * budget. Ownership/lifecycle precede provider IO. No funding/reservation or
 * signing is triggered by quoting, even when provider cash is insufficient. */
export async function quoteHip4MarketOrderWithCurrentContext(
  pool: Pool,
  input: {
    userId: string;
    actor: "web_app";
    request: Hip4MarketOrderQuoteRequest;
  },
  dependencies: Hip4OrderRuntimeDependencies = {},
) {
  input = preparationInputSchema
    .extend({ request: hip4MarketOrderQuoteRequestSchema })
    .parse(input);
  await readHip4TradeLifecycle(
    pool,
    input.request.side,
    dependencies.capabilityCheck,
  );
  await readHip4OrderController(pool, {
    userId: input.userId,
    controllerWalletRef: input.request.controllerWalletRef,
  });
  const slippageBps =
    input.request.slippageBps ??
    (await readHip4MarketQuotePolicy(pool)).marketSlippageBps;
  const read = await readHip4Policy(pool, "accountRead");
  if (!read.policy.enabled || read.policy.environment !== "mainnet")
    throw new Error("hip4_market_book_unavailable");
  const provider = createHip4ReadClient(
    read.policy,
    (weight) =>
      admitHip4Request(
        pool,
        "mainnet",
        weight,
        read.policy.requestWeightPerMinute,
      ),
    dependencies.fetcher,
  );
  const identity = hip4Identity(
    "mainnet",
    Number(input.request.marketId.split(":").at(-1)),
  );
  const coin = identity.sides[input.request.outcomeSide === "YES" ? 0 : 1].coin;
  const book = await provider({ type: "l2Book", coin });
  const sized = sizeHip4MarketOrder({
    request: { ...input.request, slippageBps },
    book,
    now: Date.now(),
    bookMaxAgeMs: read.policy.bookMaxAgeMs,
  });
  const quoted = await quoteHip4OrderWithCurrentContext(
    pool,
    { ...input, request: sized.preparationRequest },
    dependencies,
  );
  const expiresAfter = Math.min(
    quoted.expiresAfter,
    Date.parse(sized.executionEstimate.expiresAt),
  );
  if (expiresAfter <= Date.now()) throw new Error("hip4_market_book_stale");
  return { ...quoted, ...sized, expiresAfter };
}

/** Server-owned, unsigned preparation for the common venue adapter. Does not
 * fund, sign, submit, reserve cash or inspect unrelated venues. Expiry follows
 * the existing observation policy, not a new hardcoded signing lifetime. */
export async function prepareHip4OrderWithCurrentContext(
  pool: Pool,
  input: PreparationInput,
  dependencies: Hip4OrderRuntimeDependencies = {},
) {
  input = preparationInputSchema.parse(input);
  const prior = await readHip4OrderPreparationReplay(pool, input);
  if (prior) return prior;
  try {
    const { profile, feeObservation, capacity, expiresAfter } =
      await readHip4OrderContext(pool, input, dependencies, "prepare");
    return await tx(pool, (db) =>
      persistHip4OrderPreparationInTransaction(db, {
        userId: input.userId,
        request: input.request,
        profile,
        feeCapRaw: null,
        feeObservation,
        marketRevision: feeObservation.marketRevision,
        accountRevision: capacity.accountRevision,
        nonce: Date.now(),
        expiresAfter,
      }),
    );
  } catch (error) {
    const raced = await readHip4OrderPreparationReplay(pool, input);
    if (raced) return raced;
    throw error;
  }
}

/** Cancel is an exit authorization for the existing economic order. It shares
 * the nonce ledger and submit boundary, but never needs cash/fees/BUY limits. */
export async function prepareHip4CancelWithCurrentContext(
  pool: Pool,
  input: {
    userId: string;
    actor: "web_app";
    request: Hip4CancelPreparationRequest;
  },
  dependencies: Hip4OrderRuntimeDependencies = {},
) {
  input = preparationInputSchema
    .extend({ request: hip4CancelPreparationRequestSchema })
    .parse(input);
  const prior = await readHip4CancelPreparationReplay(pool, input);
  if (prior) return prior;
  try {
    await readHip4TradeLifecycle(pool, "CANCEL", dependencies.capabilityCheck);
    const original = await readHip4OwnedOrderAction(pool, {
      userId: input.userId,
      orderId: input.request.orderId,
    });
    const controller = z
      .object({ controllerWalletRef: uuid })
      .parse(original.preparation_snapshot.profile);
    const profile = await readHip4OrderController(pool, {
      userId: input.userId,
      controllerWalletRef: controller.controllerWalletRef,
    });
    if (profile.address.toLowerCase() !== original.signer_address)
      throw new Error("hip4_controller_changed");
    const policy = await readHip4CancelPolicy(pool);
    const nonce = Date.now();
    return await tx(pool, (db) =>
      persistHip4CancelPreparationInTransaction(db, {
        userId: input.userId,
        ...input.request,
        profile,
        nonce,
        expiresAfter: nonce + policy.cancelSignatureTtlMs,
        policyRevision: policy.revision,
      }),
    );
  } catch (error) {
    const raced = await readHip4CancelPreparationReplay(pool, input);
    if (raced) return raced;
    throw error;
  }
}

export async function submitHip4CancelWithCurrentContext(
  pool: Pool,
  input: {
    userId: string;
    actor: "web_app";
    orderId: string;
    actionId: string;
    signature: string;
  },
  dependencies: Hip4OrderRuntimeDependencies = {},
) {
  input = requestSchema
    .omit({
      telegramAppHandoffId: true,
      telegramAppHandoffPlanFingerprint: true,
      sourceRef: true,
      copyIdempotencyKey: true,
    })
    .omit({ funding: true })
    .extend({ orderId: uuid })
    .parse(input);
  const { row } = await readHip4OrderSubmissionAttempt(pool, input);
  if (
    row.order_id !== input.orderId ||
    prepareHip4TradeSigning(row.unsigned_envelope).action.type !==
      "cancelByCloid"
  )
    throw new Error("hip4_cancel_preparation_identity_invalid");
  const { orderId: _orderId, ...submission } = input;
  return submitHip4OrderWithCurrentContext(pool, submission, dependencies);
}

/** The common executor calls this with authenticated identity and client
 * sign-only output. The caller cannot set fee/capacity/profile/confirmed intent.
 * An owned durable replay is resolved before provider IO or current funding
 * readiness. No signer, automatic retry, alternate claim or release lives here.
 * Public registration remains disabled until exact reconciliation is connected. */
export async function submitHip4OrderWithCurrentContext(
  pool: Pool,
  input: Hip4OrderSubmitReference,
  dependencies: Hip4OrderRuntimeDependencies = {},
) {
  input = requestSchema.parse(input);
  readTelegramAppHandoffV2Binding(input);
  const attempt = await readHip4OrderSubmissionAttempt(pool, input);
  if (attempt.prior)
    return {
      replayed: true,
      submission: attempt.prior,
      orderId: attempt.row.order_id,
    };
  let context: Parameters<typeof submitHip4OrderAction>[1]["context"];
  let funding: Hip4OrderSubmitRequest["funding"];
  let transport: Parameters<typeof submitHip4OrderAction>[2];
  try {
    const { row } = attempt;
    const { wire, side, token } = inspectHip4PreparedAction(row);
    await readHip4TradeLifecycle(pool, side, dependencies.capabilityCheck);
    // The snapshot is only an identity hint, never proof of current ownership.
    // The exact same predicate is locked again inside admission after IO.
    const profile = row.preparation_snapshot.profile;
    if (
      !profile ||
      profile.networkId !== "hyperliquid:mainnet" ||
      profile.address.toLowerCase() !== row.signer_address ||
      profile.source === "smart" ||
      !profile.signingModes.includes("web_client")
    )
      throw new Error("hip4_controller_changed");
    await assertFundingControllerWallet(pool, input.userId, profile);
    if (input.funding) {
      if (side !== "BUY") throw new Error("hip4_funding_buy_required");
      const reservation = await fetchFundingConsumerReservationForUser(pool, {
        userId: input.userId,
        operationId: input.funding.operationId,
      });
      if (
        !reservation ||
        reservation.reservationId !== input.funding.reservationId
      )
        throw new Error("hip4_funding_reservation_unavailable");
      funding = {
        ...input.funding,
        confirmedIntent: reservation.consumerIntent,
      };
    }
    // Legacy internal raw-cap fixtures cannot silently become public orders.
    // A new server preparation is the recovery path, without moving any funds.
    if (wire && !row.preparation_snapshot.feeQuote)
      throw new Error("hip4_fee_preparation_required");
    const { policy } = await readHip4Policy(pool, "accountRead");
    transport = {
      timeoutMs: policy.requestTimeoutMs,
      responseMaxBytes: policy.responseMaxBytes,
      fetcher: dependencies.fetcher,
    };
    if (wire) {
      const scope = {
        address: row.signer_address,
        marketId: row.canonical_market_id,
        side: wire.b ? ("BUY" as const) : ("SELL" as const),
      };
      // Uses the pool, before borrowing a tx connection. Budget admissions are
      // committed even if later financial validation fails; max=1 pools work.
      const [feeObservation, capacity] = await Promise.all([
        readHip4OrderFeeObservation(pool, scope, dependencies.fetcher),
        readHip4OrderCapacity(
          pool,
          { ...scope, outcomeSide: token.sideIndex === 0 ? "YES" : "NO" },
          dependencies.fetcher,
        ),
      ]);
      context = { profile, feeCapRaw: null, feeObservation, capacity };
    } else {
      // Exit/cancel does not depend on cash, outcome inventory, BUY minimum or
      // fee observations. Final lifecycle and controller checks still apply.
      context = { profile, feeCapRaw: null, capacity: null };
    }
  } catch (error) {
    // Another request may have committed while our observation failed. Bounded
    // reread recovers its durable result, never authority to POST again.
    const latest = await readHip4OrderSubmissionAttempt(pool, input);
    if (latest.prior)
      return {
        replayed: true,
        submission: latest.prior,
        orderId: latest.row.order_id,
      };
    throw error;
  }
  const submitted = await submitHip4OrderAction(
    pool,
    {
      ...input,
      funding,
      context,
      telegramAppHandoffScope: dependencies.telegramAppHandoffScope,
    },
    transport,
    dependencies.capabilityCheck,
  );
  return { ...submitted, orderId: attempt.row.order_id };
}
