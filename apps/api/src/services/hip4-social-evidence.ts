import {
  hip4EnvironmentSchema,
  hip4Identity,
  hip4RawUnits,
  type Hip4Environment,
} from "@hunch/shared";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { isHypercoreMainnetUsdc } from "../funding/domain/hypercore-identity.js";
import type { AssetRef } from "../funding/domain/types.js";
import { isRecord } from "../lib/type-guards.js";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import type { VerifiedPurchaseEvidence } from "./verified-buy.js";
import {
  classifyHip4NativeOrderStatus,
  interpretHip4ExactOrderFills,
  interpretHip4ExactOrderStatus,
} from "./hip4-order-evidence.js";
import {
  prepareHip4TradeSigning,
  type Hip4TradeSigningInput,
} from "./hip4-trade-signing.js";

/** A caller supplies its frozen, stable instrument generation, not the read
 * indexer's replaceable refresh generation UUID. No mutable Hunch user ID is
 * part of an economic purchase or provider reference. */
export type Hip4SocialInstrument = Omit<
  VerifiedPurchaseEvidence["instrument"],
  "venue"
> & { venue: "hyperliquid" };
export type Hip4SocialPurchaseEvidence = Omit<
  VerifiedPurchaseEvidence,
  "instrument"
> & { instrument: Hip4SocialInstrument };

function primaryOrderId(value: string): string {
  if (
    value.length > 16 ||
    !/^(0|[1-9]\d*)$/u.test(value) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("hip4_social_primary_order_id_invalid");
  return value;
}

export function hip4SocialPurchaseKey(input: {
  environment: Hip4Environment;
  accountAddress: string;
  primaryOrderId: string;
}): string {
  const environment = hip4EnvironmentSchema.parse(input.environment);
  const owner = hip4AccountAddressSchema.parse(input.accountAddress);
  return `hyperliquid:purchase:v1:${environment}:${owner}:${primaryOrderId(input.primaryOrderId)}`;
}

export function hip4SocialProviderReference(input: {
  environment: Hip4Environment;
  accountAddress: string;
  cloid: string;
}): string {
  const environment = hip4EnvironmentSchema.parse(input.environment);
  const owner = hip4AccountAddressSchema.parse(input.accountAddress);
  if (!/^0x[0-9a-fA-F]{32}$/u.test(input.cloid))
    throw new Error("hip4_social_cloid_invalid");
  return `hyperliquid:cloid:v1:${environment}:${owner}:${input.cloid.toLowerCase()}`;
}

/** Parsers accept only the pinned canonical spelling, not a near-match that
 * could reserve a second reference for the same native economic identity. */
export function parseHip4SocialPurchaseKey(value: string): {
  environment: Hip4Environment;
  accountAddress: string;
  primaryOrderId: string;
} | null {
  const match =
    /^hyperliquid:purchase:v1:(mainnet|testnet):(0x[0-9a-f]{40}):(0|[1-9]\d*)$/u.exec(
      value,
    );
  if (!match) return null;
  const parsed = {
    environment: match[1] as Hip4Environment,
    accountAddress: match[2],
    primaryOrderId: match[3],
  };
  try {
    return hip4SocialPurchaseKey(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

export function parseHip4SocialProviderReference(value: string): {
  environment: Hip4Environment;
  accountAddress: string;
  cloid: string;
} | null {
  const match =
    /^hyperliquid:cloid:v1:(mainnet|testnet):(0x[0-9a-f]{40}):(0x[0-9a-f]{32})$/u.exec(
      value,
    );
  if (!match) return null;
  const parsed = {
    environment: match[1] as Hip4Environment,
    accountAddress: match[2],
    cloid: match[3],
  };
  return hip4SocialProviderReference(parsed) === value ? parsed : null;
}

export type Hip4SocialPurchaseResult =
  | { kind: "pending" | "invalid"; reason: string }
  | {
      kind: "observed";
      primaryOrderId: string;
      providerReference: string;
      actionFingerprint: string;
      evidence: Hip4SocialPurchaseEvidence;
      coverage: {
        historyCompleteness: "not_asserted";
        dualAliases: "unverified";
        unrelatedFillCount: number;
        uncountedRepresentationCount: number;
      };
    };

const pending = (reason: string): Hip4SocialPurchaseResult => ({
  kind: "pending",
  reason,
});
const invalid = (reason: string): Hip4SocialPurchaseResult => ({
  kind: "invalid",
  reason,
});

/** PURE observation adapter, never execution authority. The caller must load
 * the immutable original action and query native status/fills for this exact
 * environment AND economic account. Native fills contain no owner field.
 *
 * An account-wide fill page is accepted: unrelated orders are not combined or
 * treated as evidence against this purchase. Unproved dual/other economic
 * representations remain uncounted, and cannot revoke a proven original BUY.
 * No public wire contract currently proves their association to a primary OID.
 * Partial original BUY fills suffice; neither terminal/full-history coverage
 * nor the publication threshold belongs in this normalizer.
 *
 * `invalid` means a positive contradiction of the bound original order/fills;
 * `pending` means missing, malformed or unsupported evidence, not revocation.
 */
export function interpretHip4SocialPurchase(input: {
  accountAddress: string;
  envelope: Hip4TradeSigningInput;
  knownPrimaryOrderId: string | null;
  orderStatus: unknown;
  fills: readonly unknown[];
  instrument: Hip4SocialInstrument;
  quoteAsset: AssetRef;
  observedAt: number;
  maxEvidenceItems: number;
}): Hip4SocialPurchaseResult {
  if (
    !Number.isSafeInteger(input.maxEvidenceItems) ||
    input.maxEvidenceItems <= 0 ||
    input.fills.length > input.maxEvidenceItems
  )
    return pending("hip4_social_evidence_budget_exhausted");
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0)
    return pending("hip4_social_observation_time_invalid");
  let prepared: ReturnType<typeof prepareHip4TradeSigning>;
  let owner: string;
  try {
    prepared = prepareHip4TradeSigning(input.envelope);
    owner = hip4AccountAddressSchema.parse(input.accountAddress);
    if (input.knownPrimaryOrderId !== null)
      primaryOrderId(input.knownPrimaryOrderId);
  } catch {
    return pending("hip4_social_original_binding_invalid");
  }
  if (
    prepared.environment !== "mainnet" ||
    prepared.vaultAddress !== null ||
    prepared.action.type !== "order" ||
    prepared.action.orders.length !== 1
  )
    return pending("hip4_social_order_scope_unsupported");
  const wire = prepared.action.orders[0];
  if (!wire.b) return pending("hip4_social_buy_required");
  if (!isHypercoreMainnetUsdc(input.quoteAsset))
    return pending("hip4_social_quote_valuation_unsupported");
  const encoding = wire.a - 100_000_000;
  const identity = hip4Identity("mainnet", Math.floor(encoding / 10));
  const token = identity.sides[encoding % 10];
  const instrument = input.instrument;
  if (
    !token ||
    instrument.venue !== "hyperliquid" ||
    instrument.marketId !== identity.marketId ||
    instrument.tokenId !== token.tokenId ||
    instrument.outcome !== (token.sideIndex === 0 ? "YES" : "NO") ||
    !instrument.generation.trim() ||
    (instrument.expiry !== null &&
      (!Number.isFinite(Date.parse(instrument.expiry)) ||
        new Date(instrument.expiry).toISOString() !== instrument.expiry))
  )
    return invalid("hip4_social_instrument_binding_conflict");
  const envelope: Hip4TradeSigningInput = {
    environment: prepared.environment,
    action: prepared.action,
    nonce: prepared.nonce,
    expiresAfter: prepared.expiresAfter,
    vaultAddress: prepared.vaultAddress,
  };
  // A raw alternate-side status is not a proved original-order contradiction.
  // Do not guess its primary/dual relationship from price, time, hash or cloid.
  const statusRoot = isRecord(input.orderStatus) ? input.orderStatus : {};
  const statusWrapper = isRecord(statusRoot.order) ? statusRoot.order : {};
  const statusOrder = isRecord(statusWrapper.order) ? statusWrapper.order : {};
  if (
    statusOrder.coin === identity.sides[token.sideIndex === 0 ? 1 : 0].coin ||
    (statusOrder.coin === token.coin && statusOrder.side === "A")
  )
    return pending("hip4_social_dual_alias_unverified");
  const status = interpretHip4ExactOrderStatus({
    envelope,
    body: input.orderStatus,
    knownOrderId: input.knownPrimaryOrderId,
  });
  if (status.kind === "pending")
    return status.reason === "order_identity_conflict"
      ? invalid(status.reason)
      : pending(status.reason);
  if (status.observedStatusTime > input.observedAt)
    return pending("hip4_social_order_status_in_future");
  let unrelatedFillCount = 0;
  let uncountedRepresentationCount = 0;
  const originalBuys: unknown[] = [];
  for (const value of input.fills) {
    if (!isRecord(value) || String(value.oid) !== status.orderId) {
      unrelatedFillCount++;
      continue;
    }
    if (
      !isHip4OriginalBuyFill(value, {
        coin: status.coin,
        orderId: status.orderId,
        cloid: wire.c,
      })
    ) {
      uncountedRepresentationCount++;
      continue;
    }
    originalBuys.push(value);
  }
  if (classifyHip4NativeOrderStatus(status.status) === "rejected")
    return invalid(
      originalBuys.length
        ? "rejected_order_execution_conflict"
        : "provider_order_rejected",
    );
  if (!originalBuys.length)
    return pending(
      uncountedRepresentationCount
        ? "hip4_social_dual_alias_unverified"
        : "hip4_social_original_fills_not_observed",
    );
  const fills = interpretHip4ExactOrderFills({
    envelope,
    accountAddress: owner,
    orderId: status.orderId,
    fills: originalBuys,
  });
  if (fills.kind === "pending")
    return [
      "fill_identity_conflict",
      "fill_amount_conflict",
      "fill_time_conflict",
      "fill_quantity_exceeded",
    ].includes(fills.reason)
      ? invalid(fills.reason)
      : pending(fills.reason);
  if (
    fills.executions.some(
      (entry) =>
        entry.time < status.orderTime ||
        entry.time >
          (status.terminal ? status.observedStatusTime : input.observedAt),
    )
  )
    return invalid("fill_time_conflict");
  const summary = fills.executionSummary;
  if (!summary) return pending("hip4_social_original_fills_not_observed");
  const purchaseKey = hip4SocialPurchaseKey({
    environment: prepared.environment,
    accountAddress: owner,
    primaryOrderId: status.orderId,
  });
  const providerReference = hip4SocialProviderReference({
    environment: prepared.environment,
    accountAddress: owner,
    cloid: wire.c,
  });
  const fee = summary.fee;
  const feesUsdRaw =
    fee === null
      ? null
      : hip4RawUnits(fee.replace(/^-/, ""), 8) *
        (fee.startsWith("-") ? -1n : 1n) *
        100_000n;
  const sharesRaw = BigInt(fills.quantityRaw);
  return {
    kind: "observed",
    primaryOrderId: status.orderId,
    providerReference,
    actionFingerprint: canonicalJsonHash(envelope),
    evidence: {
      canonicalPurchaseKey: purchaseKey,
      instrument: { ...instrument },
      owner,
      notionalRaw: hip4RawUnits(summary.grossNotional, 13),
      grossSharesRaw: sharesRaw,
      // Native original outcome BUY size is the delivered side-token amount;
      // WsFill fee is separately denominated. Unknown fee asset is not USD.
      netSharesRaw: sharesRaw,
      collateralDecimals: 13,
      shareDecimals: 5,
      feesUsdRaw,
      purchasedAt: new Date(
        fills.executions.reduce(
          (earliest, entry) => Math.min(earliest, entry.time),
          input.observedAt,
        ),
      ).toISOString(),
      evidenceIds: fills.executions.map((entry) => entry.id).sort(),
    },
    coverage: {
      historyCompleteness: "not_asserted",
      dualAliases: "unverified",
      unrelatedFillCount,
      uncountedRepresentationCount,
    },
  };
}

/** Only exact original BUY representations may contribute money or contradict
 * that money. An unproved dual/replacement row is not an original-fill alias. */
export function isHip4OriginalBuyFill(
  value: unknown,
  scope: { coin: string; orderId: string; cloid: string },
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.coin === scope.coin &&
    String(value.oid) === scope.orderId &&
    value.side === "B" &&
    value.dir === "Buy" &&
    (value.cloid == null ||
      (typeof value.cloid === "string" &&
        value.cloid.toLowerCase() === scope.cloid.toLowerCase()))
  );
}
