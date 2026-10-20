import { hip4Identity } from "@hunch/shared";
import { z } from "zod";
import { hip4OrderPreparationRequestSchema } from "../repos/hip4-order-preparation.js";
import { readHip4OrderController } from "../repos/hip4-order-controller.js";
import { readHip4TradeLifecycle } from "../repos/hip4-order-admission.js";
import {
  projectHip4StoredDefaultBuyQuoteCapacity,
  readHip4OrderCapacity,
} from "./hip4-financial-observation.js";
import {
  readHip4AccountPolicy,
  readHip4AccountSnapshot,
} from "./hip4-account-repository.js";
import { readHip4Policy } from "./hip4-repository.js";
import {
  prepareHip4OrderWithCurrentContext,
  quoteHip4OrderWithCurrentContext,
  submitHip4OrderWithCurrentContext,
  prepareHip4CancelWithCurrentContext,
  submitHip4CancelWithCurrentContext,
  type Hip4OrderRuntimeDependencies,
} from "./hip4-order-runtime.js";
import { prepareHip4TradeSigning } from "./hip4-trade-signing.js";
import { TradingServiceError } from "./trading-errors.js";
import type {
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
} from "./api-trading-types.js";
import type {
  PreparedTrade,
  TradeIntent,
  TradeQuote,
  SubmitPreparedTradeInput,
  SubmitResult,
} from "./trading-types.js";

function unavailable(code: string, message: string): never {
  throw new TradingServiceError({
    code,
    message,
    statusCode: 409,
    venue: "hyperliquid",
  });
}
function assertWebIntent(intent: TradeIntent) {
  if (intent.venue !== "hyperliquid" || intent.target.venue !== "hyperliquid")
    unavailable(
      "invalid_trade_request",
      "The trade venue does not match its target.",
    );
  if (intent.actor.kind !== "web_app")
    unavailable("app_required", "Review and sign this trade in the Hunch app.");
  if (intent.sourceRef && intent.action !== "BUY")
    unavailable(
      "unsupported_capability",
      "Only a BUY can be attributed as Copy.",
    );
}
function requestFor(intent: TradeIntent) {
  assertWebIntent(intent);
  const native = intent.nativeOrder;
  if (
    !native ||
    native.kind !== "hyperliquid_order" ||
    intent.amount.type !== "shares" ||
    intent.limitPrice != null
  )
    unavailable(
      "invalid_trade_request",
      "Native orders require exact share quantity and decimal limit price.",
    );
  const tif = { GTC: "Gtc", IOC: "Ioc", ALO: "Alo" } as const;
  if (!intent.orderType || !(intent.orderType in tif))
    unavailable(
      "unsupported_capability",
      "Use a native GTC, IOC or ALO order.",
    );
  const request = hip4OrderPreparationRequestSchema.parse({
    requestKey: intent.idempotencyKey,
    marketId: intent.target.marketId,
    side: intent.action,
    outcomeSide: intent.target.outcome,
    timeInForce: tif[intent.orderType as keyof typeof tif],
    limitPrice: native.limitPrice,
    quantity: intent.amount.value,
    consentedDebitCapRaw: native.consentedDebitCapRaw,
    controllerWalletRef: native.controllerWalletRef,
    ...(intent.sourceRef || intent.copyIdempotencyKey
      ? {
          sourceRef: intent.sourceRef,
          copyIdempotencyKey: intent.copyIdempotencyKey,
        }
      : {}),
  });
  const identity = hip4Identity(
    "mainnet",
    Number(request.marketId.split(":").at(-1)),
  );
  const token = identity.sides[request.outcomeSide === "YES" ? 0 : 1];
  if (
    (intent.target.tokenId && intent.target.tokenId !== token.tokenId) ||
    (intent.outcome && intent.outcome !== request.outcomeSide)
  )
    unavailable(
      "invalid_trade_request",
      "The selected outcome does not match this instrument.",
    );
  return request;
}

/** Native protocol adapter inside the existing trading application service.
 * It owns the SAME common funding claim transaction as its durable submission,
 * not a second funding engine or unattended wallet signer. */
export function createHyperliquidTradingExecutionService(
  input: ApiTradingApplicationServiceInput,
  dependencies: Hip4OrderRuntimeDependencies = {},
): ApiVenueTradingExecutor {
  const capabilities: ApiVenueTradingExecutor["capabilities"] = () => ({
    venue: "hyperliquid",
    supportsBuy: false,
    supportsSell: false,
    supportsCancel: false,
    supportsOrderSync: false,
    supportsPositionSync: true,
    supportsExecutionSync: true,
    supportsSetup: false,
    authorizationModes: ["client_signed_order"],
    notes: ["Public financial activation awaits exact order reconciliation."],
  });
  function assertWebCancel(request: {
    venue: string;
    actor: { kind: string };
  }) {
    if (request.venue !== "hyperliquid")
      unavailable("invalid_trade_request", "Invalid cancellation venue.");
    if (request.actor.kind !== "web_app")
      unavailable(
        "app_required",
        "Review and sign the cancellation in the Hunch app.",
      );
  }
  const quote: ApiVenueTradingExecutor["quote"] = async ({ intent }) => {
    const current = await quoteHip4OrderWithCurrentContext(
      input.pool,
      {
        userId: intent.actor.userId,
        actor: "web_app",
        request: requestFor(intent),
      },
      dependencies,
    );
    const terms: TradeQuote = {
      venue: "hyperliquid",
      target: intent.target,
      action: intent.action,
      amount: intent.amount,
      price: null,
      estimatedShares: null,
      estimatedNotionalUsd: null,
      maxSpendUsd: null,
      minReceiveShares: null,
      fees: { ...current.feeQuote },
      expiresAt: new Date(current.expiresAfter),
      // Exact decimal strings are authoritative, unlike display-only legacy numbers.
      raw: { amounts: current.amounts, capacity: current.capacity },
    };
    return terms;
  };
  const prepareTrade: ApiVenueTradingExecutor["prepareTrade"] = async ({
    intent,
  }) => {
    const prepared = await prepareHip4OrderWithCurrentContext(
      input.pool,
      {
        userId: intent.actor.userId,
        actor: "web_app",
        request: requestFor(intent),
      },
      dependencies,
    );
    const typed = prepareHip4TradeSigning(prepared.envelope);
    return {
      preparedId: prepared.actionId,
      venue: "hyperliquid",
      intent,
      quote: null,
      authorizationMode: "client_signed_order",
      authorizationRequests: [
        {
          id: prepared.actionId,
          label: "Sign Hyperliquid order",
          input: typed.typedData,
        },
      ],
      reconcileKeys: {
        actionId: prepared.actionId,
        orderId: prepared.orderId,
        cloid: prepared.cloid,
      },
      venuePayload: {
        kind: "hyperliquid",
        actionId: prepared.actionId,
        orderId: prepared.orderId,
        amounts: prepared.snapshot.amounts,
        fees: prepared.snapshot.feeQuote,
      },
      expiresAt:
        prepared.envelope.expiresAfter === null
          ? null
          : new Date(prepared.envelope.expiresAfter),
    } satisfies PreparedTrade;
  };
  const submit = async (submissionInput: SubmitPreparedTradeInput) => {
    const { prepared } = submissionInput;
    assertWebIntent(prepared.intent);
    if (
      submissionInput.onBeforeBroadcast ||
      submissionInput.onBeforeTradeSubmission ||
      submissionInput.onDefinitiveTradeRejection ||
      submissionInput.onBroadcastSubmitted ||
      submissionInput.onSetupTransactionSubmitted
    )
      unavailable(
        "unsupported_capability",
        "Native durable submission does not accept generic broadcast-management callbacks.",
      );
    if (
      prepared.venue !== "hyperliquid" ||
      prepared.authorizationMode !== "client_signed_order"
    )
      unavailable("invalid_trade_request", "Invalid native preparation.");
    const signatures = z
      .array(
        z
          .object({ id: z.string().uuid(), signature: z.string().max(132) })
          .strict(),
      )
      .length(1)
      .parse(submissionInput.signatures);
    if (signatures[0].id !== prepared.preparedId)
      unavailable(
        "invalid_trade_request",
        "Signature is bound to another preparation.",
      );
    // Only authenticated ownership, exact stored action and its signature enter
    // runtime. Mutable client payload/quotes never reconstruct the financial wire.
    const result = await submitHip4OrderWithCurrentContext(
      input.pool,
      {
        userId: prepared.intent.actor.userId,
        actor: "web_app",
        actionId: prepared.preparedId,
        signature: signatures[0].signature,
        funding: prepared.intent.fundingReservation ?? undefined,
        ...(prepared.intent.sourceRef || prepared.intent.copyIdempotencyKey
          ? {
              sourceRef: prepared.intent.sourceRef,
              copyIdempotencyKey: prepared.intent.copyIdempotencyKey,
            }
          : {}),
      },
      dependencies,
    );
    const submitResult: SubmitResult = {
      venue: "hyperliquid",
      status:
        result.submission.state === "rejected"
          ? result.submission.reply_summary?.kind === "no_fill"
            ? "no_fill"
            : "failed"
          : "submitted",
      venueOrderId: null,
      orderHash: null,
      txSignature: null,
      price: null,
      size: null,
      raw: {
        actionId: result.submission.action_id,
        orderId: result.orderId,
        replayed: result.replayed,
        reconciliationRequired: result.submission.state !== "rejected",
      },
    };
    return {
      submitResult,
      persisted: {
        venue: "hyperliquid" as const,
        orderId: result.orderId,
        executionId: null,
        venueOrderId: null,
        status: submitResult.status,
      },
      effects: null,
      postSubmitError: null,
    };
  };
  return {
    venue: "hyperliquid",
    submissionOwnership: "durable_client_signed",
    capabilities,
    prepareCancelOrder: async (request) => {
      assertWebCancel(request);
      const prepared = await prepareHip4CancelWithCurrentContext(
        input.pool,
        {
          userId: request.actor.userId,
          actor: "web_app",
          request: {
            orderId: request.orderId,
            requestKey: request.idempotencyKey,
          },
        },
        dependencies,
      );
      const signing = prepareHip4TradeSigning(prepared.envelope);
      if (prepared.envelope.expiresAfter === null)
        unavailable("invalid_trade_request", "Cancellation expiry is missing.");
      return {
        preparedId: prepared.actionId,
        venue: "hyperliquid",
        orderId: prepared.orderId,
        authorizationMode: "client_signed_order",
        authorizationRequests: [
          {
            id: prepared.actionId,
            label: "Sign Hyperliquid cancellation",
            input: signing.typedData,
          },
        ],
        expiresAt: new Date(prepared.envelope.expiresAfter),
      };
    },
    submitPreparedCancelOrder: async (request) => {
      assertWebCancel(request);
      const result = await submitHip4CancelWithCurrentContext(
        input.pool,
        {
          userId: request.actor.userId,
          actor: "web_app",
          orderId: request.orderId,
          actionId: request.preparedId,
          signature: request.signature,
        },
        dependencies,
      );
      return {
        venue: "hyperliquid",
        // Even a successful cancel ACK is not an execution/hold-release fact.
        status: result.submission.state === "rejected" ? "failed" : "submitted",
        venueOrderId: null,
        orderHash: null,
        txSignature: null,
        price: null,
        size: null,
        raw: {
          actionId: result.submission.action_id,
          orderId: result.orderId,
          replayed: result.replayed,
          reconciliationRequired: true,
        },
      };
    },
    quote,
    prepareTrade,
    getReadiness: async (request) => {
      const notReady = (reasonCode: string, message: string) => ({
        ready: false,
        executable: false,
        reasonCode,
        message,
        setupRequired: false,
        capabilities: capabilities(),
      });
      if (request.actor.kind !== "web_app")
        return {
          ...notReady("app_required", "Review and sign in the Hunch app."),
          repair: {
            kind: "app_required" as const,
            code: "app_required",
            message: "Open the Hunch app.",
          },
        };
      try {
        await readHip4TradeLifecycle(
          input.pool,
          request.action ?? "BUY",
          dependencies.capabilityCheck,
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "hip4_lifecycle_disabled"
        )
          throw error;
        return notReady(
          "venue_lifecycle_blocked",
          "Hyperliquid trading is not enabled.",
        );
      }
      if (
        !request.controllerWalletRef ||
        !request.target?.marketId ||
        !["YES", "NO"].includes(request.target.outcome ?? "")
      )
        return notReady(
          "invalid_trade_request",
          "Select a controller wallet and exact outcome.",
        );
      const profile = await readHip4OrderController(input.pool, {
        userId: request.actor.userId,
        controllerWalletRef: request.controllerWalletRef,
      });
      if (
        profile.address.toLowerCase() !== request.walletAddress?.toLowerCase()
      )
        return notReady(
          "wallet_mismatch",
          "Select the linked controller wallet.",
        );
      const capacityInput = {
        address: profile.address,
        marketId: request.target.marketId,
        side: request.action ?? "BUY",
        outcomeSide: request.target.outcome as "YES" | "NO",
      };
      let capacity: Awaited<ReturnType<typeof readHip4OrderCapacity>> | null =
        null;
      if (capacityInput.side === "BUY") {
        // Stored USDC is preview-only, but it must not bypass the native
        // market/outcome identity validation performed by the fresh reader.
        const match = /^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u.exec(
          capacityInput.marketId,
        );
        if (!match) throw new Error("hip4_capacity_identity_invalid");
        hip4Identity("mainnet", Number(match[1]));
        const [read, account] = await Promise.all([
          readHip4Policy(input.pool, "accountRead"),
          readHip4AccountPolicy(input.pool),
        ]);
        if (
          !read.policy.enabled ||
          !account.policy.enabled ||
          read.policy.environment !== "mainnet"
        )
          throw new Error("native_account_read_unavailable");
        const snapshot = await readHip4AccountSnapshot(
          input.pool,
          "mainnet",
          profile.address,
        ).catch((error: unknown) => {
          // Optional legacy display facts cannot block a healthy fresh read.
          if (error instanceof z.ZodError) return undefined;
          throw error;
        });
        capacity = projectHip4StoredDefaultBuyQuoteCapacity({
          ...capacityInput,
          observation: snapshot?.observation,
          environment: read.policy.environment,
          snapshotMaxAgeMs: account.policy.snapshotMaxAgeMs,
          now: Date.now(),
          readRevision: read.revision,
          accountRevision: account.revision,
        });
      }
      // SELL stock and strict prepare/submit always retain fresh native reads.
      capacity ??= await readHip4OrderCapacity(
        input.pool,
        capacityInput,
        dependencies.fetcher,
      );
      return {
        ready: true,
        executable: true,
        reasonCode: null,
        message: null,
        setupRequired: false,
        capabilities: capabilities(),
        raw: { observation: capacity, admissionRequired: true },
      };
    },
    submitPreparedTrade: async (request) =>
      (await submit(request)).submitResult,
    executePreparedTrade: async (request) => {
      const executed = await submit(request);
      try {
        await request.onSubmitted?.(executed.submitResult);
      } catch {
        return {
          ...executed,
          postSubmitError: {
            code: "post_submit_callback_failed",
            message: "Order submitted; the follow-up update needs recovery.",
            statusCode: 409,
          },
        };
      }
      return executed;
    },
    // Preparation already stored the economic order. Never accept a client ACK
    // as an execution, create a second order, or grant effects/consumer release.
    persistTrade: async () =>
      unavailable(
        "reconcile_required",
        "Native orders are persisted by durable submission and reconciliation.",
      ),
    applyTradeEffects: async () =>
      unavailable(
        "reconcile_required",
        "Native execution effects require verified fills.",
      ),
  };
}
