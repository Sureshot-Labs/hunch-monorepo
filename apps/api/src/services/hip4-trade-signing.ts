import { encode } from "@msgpack/msgpack";
import { hip4EnvironmentSchema, parseHip4Coin } from "@hunch/shared";
import {
  concat,
  hexlify,
  keccak256,
  Signature,
  toBeHex,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";
import { z } from "zod";

// L1 order/cancel signing is NOT the SendAsset signing domain used by funding.
// Reference: pinned official SDK 0.24.0; the independent SDK fixtures exercise
// the complete action -> MessagePack -> Agent EIP-712 chain, not just a hash.
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cloid = z.string().regex(/^0x[0-9a-f]{32}$/u);
const asset = uint.refine((value) => {
  try {
    parseHip4Coin(`#${value - 100_000_000}`);
    return true;
  } catch {
    return false;
  }
}, "Expected a HIP-4 outcome asset, not a spot/perp index");
const wireOrder = z
  .object({
    a: asset,
    b: z.boolean(),
    p: z.string().regex(/^0\.\d{0,4}[1-9]$/u),
    s: z
      .string()
      .regex(/^[1-9]\d*$/u)
      .max(128),
    r: z.literal(false),
    t: z
      .object({
        limit: z.object({ tif: z.enum(["Gtc", "Ioc", "Alo"]) }).strict(),
      })
      .strict(),
    c: cloid,
  })
  .strict();
// Only the first-release outcome actions are accepted. Builder fees, triggers,
// modify, leverage and transfers cannot enter through an opaque action object.
export const hip4TradeActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("order"),
      orders: z.array(wireOrder).nonempty(),
      grouping: z.literal("na"),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel"),
      cancels: z.array(z.object({ a: asset, o: uint }).strict()).nonempty(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancelByCloid"),
      cancels: z.array(z.object({ asset, cloid }).strict()).nonempty(),
    })
    .strict(),
]);
export type Hip4TradeAction = z.infer<typeof hip4TradeActionSchema>;
const envelopeSchema = z
  .object({
    environment: hip4EnvironmentSchema,
    action: hip4TradeActionSchema,
    nonce: uint,
    vaultAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/u)
      .nullable(),
    expiresAfter: uint.nullable(),
  })
  .strict();
export type Hip4TradeSigningInput = z.input<typeof envelopeSchema>;

/** Explicit SDK field order survives JSONB's key reordering. A stored/retried
 * action must produce exactly the same bytes regardless of JSON object order.
 * Caller must separately admit ownership, quote, policy, nonce and cash; this
 * pure serializer never grants execution authority or accesses a signer. */
export function canonicalHip4TradeAction(value: unknown): Hip4TradeAction {
  const action = hip4TradeActionSchema.parse(value);
  if (action.type === "order")
    return {
      type: "order",
      orders: action.orders.map((order) => ({
        a: order.a,
        b: order.b,
        p: order.p,
        s: order.s,
        r: order.r,
        t: { limit: { tif: order.t.limit.tif } },
        c: order.c,
      })),
      grouping: "na",
    };
  if (action.type === "cancel")
    return {
      type: "cancel",
      cancels: action.cancels.map((cancel) => ({ a: cancel.a, o: cancel.o })),
    };
  return {
    type: "cancelByCloid",
    cancels: action.cancels.map((cancel) => ({
      asset: cancel.asset,
      cloid: cancel.cloid,
    })),
  };
}

export function prepareHip4TradeSigning(input: Hip4TradeSigningInput) {
  const checked = envelopeSchema.parse(input);
  const action = canonicalHip4TradeAction(checked.action);
  const packedAction = hexlify(encode(action, { sortKeys: false }));
  const vaultAddress = checked.vaultAddress?.toLowerCase() ?? null;
  const suffix = [
    toBeHex(checked.nonce, 8),
    vaultAddress ? concat(["0x01", vaultAddress]) : "0x00",
  ];
  if (checked.expiresAfter !== null)
    suffix.push("0x00", toBeHex(checked.expiresAfter, 8));
  const connectionId = keccak256(concat([packedAction, ...suffix]));
  const typedData = {
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: {
      source: checked.environment === "mainnet" ? "a" : "b",
      connectionId,
    },
  };
  return {
    environment: checked.environment,
    action,
    nonce: checked.nonce,
    vaultAddress,
    expiresAfter: checked.expiresAfter,
    packedAction,
    connectionId,
    typedData,
    digest: TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    ),
  };
}

/** Server must rebuild the envelope from the admitted record, not accept a
 * client-supplied typedData/digest. Returned payload is suitable for the native
 * exchange only AFTER the durable submission boundary and current admission. */
export function bindHip4TradeSignature(
  input: Hip4TradeSigningInput,
  signature: string,
  expectedSigner: string,
) {
  const prepared = prepareHip4TradeSigning(input);
  const { domain, types, message } = prepared.typedData;
  let decoded: Signature;
  try {
    if (
      !/^0x[0-9a-fA-F]{40}$/u.test(expectedSigner) ||
      verifyTypedData(domain, types, message, signature).toLowerCase() !==
        expectedSigner.toLowerCase()
    )
      throw new Error("signer_mismatch");
    decoded = Signature.from(signature);
  } catch {
    // ethers errors may contain the original sign-only authorization. Do not
    // expose that signature through route errors, causes or diagnostics.
    throw new Error("hip4_trade_signature_invalid");
  }
  return {
    action: prepared.action,
    nonce: prepared.nonce,
    signature: { r: decoded.r, s: decoded.s, v: decoded.v },
    vaultAddress: prepared.vaultAddress,
    ...(prepared.expiresAfter === null
      ? {}
      : { expiresAfter: prepared.expiresAfter }),
  };
}
