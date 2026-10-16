import { hip4Identity } from "@hunch/shared";
import { z } from "zod";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  socialSourceRefSchema,
  verifiedBuyFactsSchema,
  type SocialSourceRef,
} from "../schemas/social-trade.js";
import { buildHip4SocialInstrument } from "./hip4-social-instrument.js";
import { hip4SocialProviderReference } from "./hip4-social-evidence.js";
import {
  prepareHip4TradeSigning,
  type Hip4TradeSigningInput,
} from "./hip4-trade-signing.js";
import type { PreparedTrade } from "./trading-types.js";

export const hip4CopyAttributionSchema = z
  .object({
    sourceRef: socialSourceRefSchema,
    copyIdempotencyKey: z.string().uuid(),
  })
  .strict();

export function readHip4CopyAttribution(input: {
  sourceRef?: unknown;
  copyIdempotencyKey?: unknown;
}) {
  if (input.sourceRef === undefined && input.copyIdempotencyKey === undefined)
    return null;
  return hip4CopyAttributionSchema.parse({
    sourceRef: input.sourceRef,
    copyIdempotencyKey: input.copyIdempotencyKey,
  });
}

/** Even a durable response-loss replay must refer to the same frozen source. */
export function assertHip4CopyAttribution(
  input: { sourceRef?: SocialSourceRef; copyIdempotencyKey?: string },
  snapshot: Record<string, unknown>,
) {
  const requested = readHip4CopyAttribution(input);
  const frozen = readHip4CopyAttribution(snapshot);
  if (canonicalJsonHash(requested) !== canonicalJsonHash(frozen))
    throw new Error("hip4_copy_scope_changed");
  return frozen;
}

/** Server-owned adapter to the existing Copy retention transaction. This does
 * not quote, sign, submit, fund or authorize a source by itself. */
export function buildHip4CopyPreparedTrade(input: {
  userId: string;
  actionId: string;
  marketId: string;
  tokenId: string;
  signerAddress: string;
  cloid: string;
  actionFingerprint: string;
  envelope: Hip4TradeSigningInput;
  snapshot: Record<string, unknown>;
}) {
  const attribution = readHip4CopyAttribution(input.snapshot);
  if (!attribution) return null;
  const envelope = prepareHip4TradeSigning(input.envelope);
  if (
    envelope.environment !== "mainnet" ||
    envelope.action.type !== "order" ||
    envelope.action.orders.length !== 1
  )
    throw new Error("hip4_copy_buy_required");
  const wire = envelope.action.orders[0];
  const identity = hip4Identity(
    "mainnet",
    Number(input.marketId.split(":").at(-1)),
  );
  const token = identity.sides.find((side) => side.tokenId === input.tokenId);
  if (
    !wire.b ||
    !token ||
    wire.a !== token.assetId ||
    wire.c !== input.cloid ||
    identity.marketId !== input.marketId ||
    canonicalJsonHash(input.envelope) !== input.actionFingerprint
  )
    throw new Error("hip4_copy_identity_invalid");
  const instrument = verifiedBuyFactsSchema.shape.instrument.parse(
    input.snapshot.socialInstrument,
  );
  const outcome = token.sideIndex === 0 ? "YES" : "NO";
  const rebuilt = buildHip4SocialInstrument({
    marketId: input.marketId,
    tokenId: input.tokenId,
    outcome,
    expiry: instrument.expiry,
    snapshot: input.snapshot.socialInstrumentSnapshot,
  });
  const profile = z
    .object({ controllerWalletRef: z.string().uuid() })
    .parse(input.snapshot.profile);
  const debitCap = z
    .string()
    .regex(/^[1-9]\d*$/u)
    .parse(input.snapshot.consentedDebitCapRaw);
  if (!rebuilt || canonicalJsonHash(rebuilt) !== canonicalJsonHash(instrument))
    throw new Error("hip4_copy_instrument_unavailable");
  const orderType = { Ioc: "IOC", Gtc: "GTC", Alo: "ALO" } as const;
  const prepared: PreparedTrade = {
    preparedId: input.actionId,
    venue: "hyperliquid",
    quote: null,
    authorizationMode: "client_signed_order",
    authorizationRequests: [],
    reconcileKeys: {},
    expiresAt: null,
    venuePayload: null,
    intent: {
      actor: { kind: "web_app", userId: input.userId },
      venue: "hyperliquid",
      walletAddress: input.signerAddress,
      action: "BUY",
      outcome,
      sourceRef: attribution.sourceRef,
      copyIdempotencyKey: attribution.copyIdempotencyKey,
      idempotencyKey: attribution.copyIdempotencyKey,
      amount: { type: "shares", value: wire.s },
      orderType: orderType[wire.t.limit.tif],
      nativeOrder: {
        kind: "hyperliquid_order",
        controllerWalletRef: profile.controllerWalletRef,
        limitPrice: wire.p,
        consentedDebitCapRaw: debitCap,
      },
      target: {
        venue: "hyperliquid",
        marketId: input.marketId,
        tokenId: input.tokenId,
        outcome,
        eventId: null,
        venueMarketId: null,
        title: null,
      },
    },
  };
  return {
    prepared,
    hip4Instrument: instrument,
    preparedFingerprint: input.actionFingerprint,
    providerReference: hip4SocialProviderReference({
      environment: "mainnet",
      accountAddress: input.signerAddress,
      cloid: input.cloid,
    }),
  };
}
