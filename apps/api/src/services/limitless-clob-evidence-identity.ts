import { getAddress, TypedDataEncoder } from "ethers";
import { isRecord } from "../lib/type-guards.js";
import {
  LIMITLESS_CLOB_CHAIN_ID,
  LIMITLESS_CLOB_EIP712_NAME,
  LIMITLESS_CLOB_EIP712_VERSION,
  LIMITLESS_CLOB_ORDER_TYPES,
} from "./limitless-order-contract.js";
import { resolveLimitlessMarketExchangeAddress } from "./limitless-market-contracts.js";

export const LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM = "venue_share_collateral";
export const LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY =
  "_hunchLimitlessReceiptLocatorHashes";

export type LimitlessClobSubmissionContext = {
  contextVersion: 1;
  chainId: typeof LIMITLESS_CLOB_CHAIN_ID;
  exchangeAddress: string;
  orderHash: string;
  collateralFeeModule?: string;
};

export type RetainedLimitlessClobSubmission = {
  context: LimitlessClobSubmissionContext;
  order: Record<string, string>;
  /** Resolved by the server before dispatch, for scoped history reads only. */
  providerOwnerId?: number;
  providerMarketSlug?: string;
};

export function normalizeLimitlessReceiptLocatorHashes(
  values: readonly unknown[],
): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)
          ? [value.toLowerCase()]
          : [],
      ),
    ),
  ];
}

/** Match these only against finalized receipts for the frozen order hash. */
export function readLimitlessHistoryTxHashes(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const history = isRecord(payload.history) ? payload.history : {};
  const retained = payload._hunchLimitlessHistoryTxHashes;
  return normalizeLimitlessReceiptLocatorHashes([
    ...(Array.isArray(retained) ? retained.slice(0, 6) : []),
    history.txHash,
    history.transactionHash,
    history.tx_hash,
    ...limitlessClobSubmittedPayloads(payload).flatMap((record) => {
      const recovered = record[LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY];
      const direct = isRecord(record._hunchLimitlessDirectLocator)
        ? record._hunchLimitlessDirectLocator
        : null;
      return [
        ...(Array.isArray(recovered) ? recovered.slice(0, 8) : []),
        direct?.txHash,
        ...(Array.isArray(direct?.txHashes) ? direct.txHashes.slice(0, 8) : []),
      ];
    }),
  ]);
}

/** Recovery needs venue status/receipt locators, not signatures echoed in
 * the response. This also covers nested result/order arrays. */
export function withoutLimitlessRecoverySignatures(
  value: unknown,
  depth = 0,
): unknown {
  if (depth >= 16 && (isRecord(value) || Array.isArray(value))) return null;
  if (Array.isArray(value))
    return value.map((entry) =>
      withoutLimitlessRecoverySignatures(entry, depth + 1),
    );
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/^(?:order_?)?signatures?$/i.test(key))
      .map(([key, entry]) => [
        key,
        withoutLimitlessRecoverySignatures(entry, depth + 1),
      ]),
  );
}

function orderHash(exchangeAddress: string, order: Record<string, unknown>) {
  return TypedDataEncoder.hash(
    {
      name: LIMITLESS_CLOB_EIP712_NAME,
      version: LIMITLESS_CLOB_EIP712_VERSION,
      chainId: LIMITLESS_CLOB_CHAIN_ID,
      verifyingContract: exchangeAddress,
    },
    { Order: LIMITLESS_CLOB_ORDER_TYPES.Order.map((field) => ({ ...field })) },
    order,
  );
}
export function limitlessClobOrderStructHash(
  order: Record<string, unknown>,
): string | null {
  try {
    // Domain-free so the exact submitted order remains findable even if
    // today's market metadata changed. EIP-712 ignores unsigned extras and
    // normalizes equivalent uint/address encodings.
    return TypedDataEncoder.hashStruct(
      "Order",
      {
        Order: LIMITLESS_CLOB_ORDER_TYPES.Order.map((field) => ({ ...field })),
      },
      order,
    );
  } catch {
    return null;
  }
}

export function directLimitlessClobClientOrderId(
  order: Record<string, unknown>,
): string | null {
  const structHash = limitlessClobOrderStructHash(order);
  return structHash ? `hunch-direct-${structHash.slice(2, 34)}` : null;
}

/** Call only with the server-resolved exchange actually used to sign this order. */
export function buildLimitlessClobSubmissionContext(
  exchangeAddress: string,
  signedOrder: Record<string, unknown>,
  collateralFeeModule?: string,
): LimitlessClobSubmissionContext {
  const address = getAddress(exchangeAddress);
  return {
    contextVersion: 1,
    chainId: LIMITLESS_CLOB_CHAIN_ID,
    exchangeAddress: address,
    orderHash: orderHash(address, signedOrder),
    ...(collateralFeeModule
      ? { collateralFeeModule: getAddress(collateralFeeModule) }
      : {}),
  };
}

/** Durable recovery keeps the signed fields and server domain, never the
 * signature itself or arbitrary request/provider properties. */
export function readRetainedLimitlessClobSubmission(
  value: unknown,
  identity: { walletAddress: string; tokenId: string; side: "BUY" | "SELL" },
): RetainedLimitlessClobSubmission | null {
  if (!isRecord(value) || !isRecord(value.order) || !isRecord(value.context))
    return null;
  const { context } = value;
  if (
    context.contextVersion !== 1 ||
    context.chainId !== LIMITLESS_CLOB_CHAIN_ID ||
    typeof context.exchangeAddress !== "string" ||
    typeof context.orderHash !== "string" ||
    (Object.hasOwn(context, "collateralFeeModule") &&
      typeof context.collateralFeeModule !== "string")
  )
    return null;
  try {
    const order: Record<string, string> = {};
    for (const { name } of LIMITLESS_CLOB_ORDER_TYPES.Order) {
      const field = value.order[name];
      if (
        typeof field !== "string" &&
        typeof field !== "number" &&
        typeof field !== "bigint"
      )
        return null;
      order[name] = String(field);
    }
    const wallet = getAddress(identity.walletAddress);
    if (
      getAddress(order.maker) !== wallet ||
      getAddress(order.signer) !== wallet ||
      BigInt(order.tokenId) !==
        BigInt(identity.tokenId.replace(/^limitless:/, "")) ||
      BigInt(order.side) !== (identity.side === "BUY" ? 0n : 1n)
    )
      return null;
    const module =
      typeof context.collateralFeeModule === "string"
        ? getAddress(context.collateralFeeModule)
        : undefined;
    const expected = buildLimitlessClobSubmissionContext(
      context.exchangeAddress,
      order,
      module,
    );
    if (
      expected.orderHash !== context.orderHash.toLowerCase() ||
      (module &&
        (module === expected.exchangeAddress ||
          BigInt(module) === 0n ||
          BigInt(order.feeRateBps) !== 0n))
    )
      return null;
    return { order, context: expected };
  } catch {
    return null;
  }
}

export function limitlessClobSubmittedPayloads(
  payload: Record<string, unknown>,
) {
  // The direct route nests client order extras under `order`; they cannot
  // supply the server-owned top-level _hunchLimitlessClob field.
  const result = [payload];
  let current = payload;
  for (let depth = 0; depth < 4; depth++) {
    const next = [
      current._hunchSubmitted,
      current.submitted,
      current.payload,
    ].find(isRecord);
    if (!next) break;
    result.push(next);
    current = next;
  }
  return result;
}

export function limitlessClobSubmittedOrder(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const submitted = limitlessClobSubmittedPayloads(payload).at(-1) ?? payload;
  const order = isRecord(submitted.order) ? submitted.order : submitted;
  return order.salt != null ? order : null;
}

export function limitlessClobFrozenContext(
  payload: Record<string, unknown>,
): unknown {
  return limitlessClobSubmittedPayloads(payload).find((record) =>
    Object.hasOwn(record, "_hunchLimitlessClob"),
  )?._hunchLimitlessClob;
}

function completeOrder(
  order: Record<string, unknown> | null,
): order is Record<string, unknown> {
  return (
    !!order &&
    LIMITLESS_CLOB_ORDER_TYPES.Order.every((field) => order[field.name] != null)
  );
}

/** Pure, sidecar-safe identity resolver. Provider domains/exchanges are never authority. */
export function resolveLimitlessClobEvidenceIdentity(input: {
  orderPayload: Record<string, unknown>;
  marketMetadata: unknown;
  legacyExchangeAddress: string;
  providerOrder: Record<string, unknown>;
}): { exchangeAddress: string; orderHash: string } | null {
  const frozen = limitlessClobFrozenContext(input.orderPayload);
  const localOrder = limitlessClobSubmittedOrder(input.orderPayload);
  let exchangeAddress: string;
  let frozenHash: string | null = null;
  try {
    if (frozen !== undefined) {
      if (
        !isRecord(frozen) ||
        frozen.contextVersion !== 1 ||
        frozen.chainId !== LIMITLESS_CLOB_CHAIN_ID ||
        typeof frozen.exchangeAddress !== "string" ||
        typeof frozen.orderHash !== "string" ||
        !completeOrder(localOrder)
      )
        return null;
      exchangeAddress = getAddress(frozen.exchangeAddress);
      frozenHash = frozen.orderHash.toLowerCase();
    } else {
      // Existing orders recover on the normal bounded repair pass from exact
      // market metadata, without a provider fetch or a migration/repair gate.
      const address = resolveLimitlessMarketExchangeAddress(
        input.marketMetadata,
        input.legacyExchangeAddress,
      );
      if (!address) return null;
      exchangeAddress = address;
    }
    const localHash = completeOrder(localOrder)
      ? orderHash(exchangeAddress, localOrder)
      : null;
    if (frozenHash && frozenHash !== localHash) return null;
    const provider = input.providerOrder;
    const supplied = provider.orderHash ?? provider.hash;
    if (
      supplied != null &&
      (typeof supplied !== "string" || !/^0x[0-9a-f]{64}$/i.test(supplied))
    )
      return null;
    const suppliedHash =
      typeof supplied === "string" ? supplied.toLowerCase() : null;
    const providerHash = completeOrder(provider)
      ? orderHash(exchangeAddress, provider)
      : null;
    const hashes = [frozenHash, localHash, suppliedHash, providerHash].filter(
      (value): value is string => value !== null,
    );
    const expectedHash = hashes[0];
    if (!expectedHash || hashes.some((hash) => hash !== expectedHash))
      return null;
    return { exchangeAddress, orderHash: expectedHash };
  } catch {
    return null;
  }
}
