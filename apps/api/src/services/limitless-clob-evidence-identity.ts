import { getAddress, TypedDataEncoder } from "ethers";
import { isRecord } from "../lib/type-guards.js";
import {
  LIMITLESS_CLOB_CHAIN_ID,
  LIMITLESS_CLOB_EIP712_NAME,
  LIMITLESS_CLOB_EIP712_VERSION,
  LIMITLESS_CLOB_ORDER_TYPES,
} from "./limitless-order-contract.js";
import { resolveLimitlessMarketExchangeAddress } from "./limitless-market-contracts.js";

export type LimitlessClobSubmissionContext = {
  contextVersion: 1;
  chainId: typeof LIMITLESS_CLOB_CHAIN_ID;
  exchangeAddress: string;
  orderHash: string;
};

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

/** Call only with the server-resolved exchange actually used to sign this order. */
export function buildLimitlessClobSubmissionContext(
  exchangeAddress: string,
  signedOrder: Record<string, unknown>,
): LimitlessClobSubmissionContext {
  const address = getAddress(exchangeAddress);
  return {
    contextVersion: 1,
    chainId: LIMITLESS_CLOB_CHAIN_ID,
    exchangeAddress: address,
    orderHash: orderHash(address, signedOrder),
  };
}

function submittedPayloads(payload: Record<string, unknown>) {
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
  const submitted = submittedPayloads(payload).at(-1) ?? payload;
  const order = isRecord(submitted.order) ? submitted.order : submitted;
  return order.salt != null ? order : null;
}

export function limitlessClobFrozenContext(
  payload: Record<string, unknown>,
): unknown {
  return submittedPayloads(payload).find((record) =>
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
