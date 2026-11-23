import { ethers } from "ethers";
import type { PolymarketOrderDomainVersion } from "@hunch/shared";
import {
  buildPolymarketOrderDomain,
  type PolymarketOrderHashV2Input,
} from "./polymarket-order-hash.js";
import {
  POLYMARKET_ORDER_TYPES,
  POLYMARKET_ORDER_TYPE_STRING,
  POLYMARKET_TYPED_DATA_SIGN_TYPES,
} from "./polymarket-signing-schema.js";

export function wrapDepositWalletOrderSignature(input: {
  appDomain: ethers.TypedDataDomain;
  innerSignature: string;
  message: Record<string, unknown>;
}) {
  const typeBytes = ethers.toUtf8Bytes(POLYMARKET_ORDER_TYPE_STRING);
  return ethers.concat([
    input.innerSignature,
    ethers.TypedDataEncoder.hashDomain(input.appDomain),
    ethers.TypedDataEncoder.hashStruct(
      "Order",
      { Order: [...POLYMARKET_ORDER_TYPES.Order] },
      input.message,
    ),
    typeBytes,
    ethers.toBeHex(typeBytes.length, 2),
  ]);
}

export async function signHouseOrder(
  key: Pick<ethers.Wallet, "signTypedData">,
  input: {
    order: PolymarketOrderHashV2Input;
    exchange: string;
    version: PolymarketOrderDomainVersion;
  },
) {
  const { order } = input;
  if (order.signatureType !== 3 || order.maker !== order.signer)
    throw new Error("invalid_house_order");
  const domain = buildPolymarketOrderDomain(input.exchange, input.version);
  const types = Object.fromEntries(
    Object.entries(POLYMARKET_TYPED_DATA_SIGN_TYPES).map(([field, entries]) => [
      field,
      [...entries],
    ]),
  );
  const innerSignature = await key.signTypedData(domain, types, {
    contents: order,
    name: "DepositWallet",
    version: "1",
    chainId: 137,
    verifyingContract: order.signer,
    salt: ethers.ZeroHash,
  });
  return wrapDepositWalletOrderSignature({
    appDomain: domain,
    innerSignature,
    message: order,
  });
}
