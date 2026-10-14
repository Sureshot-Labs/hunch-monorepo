import { z } from "zod";
import { hip4RawUnits } from "@hunch/shared";
import { TypedDataEncoder, verifyTypedData } from "ethers";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../../funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/u);
const bytes32 = z.string().regex(/^0x[\da-fA-F]{64}$/u);
const nonce = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dex = z.enum(["spot", ""]);
const zeroAddress = `0x${"0".repeat(40)}`;

const HYPERCORE_SEND_ASSET_TYPES = {
  "HyperliquidTransaction:SendAsset": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationDex", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fromSubAccount", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
};
const NONCE_MAPPING_TYPES = {
  NonceMapping: [
    { name: "chainId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "depositor", type: "address" },
    { name: "id", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};
const parametersSchema = z
  .object({
    hyperliquidChain: z.literal("Mainnet"),
    destination: address,
    sourceDex: dex,
    destinationDex: dex,
    token: z.literal(`USDC:${HYPERCORE_MAINNET_USDC.assetId}`),
    amount: z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/u),
    fromSubAccount: z.literal(""),
    nonce,
  })
  .strict();

/** Protocol typed data only. Caller must freeze and validate route economics,
 * ownership, mode-aware source capacity, expiry and both durable steps BEFORE
 * presenting either signature. This module does not grant execution permission. */
export function hypercoreSendAssetTypedData(
  parameters: z.infer<typeof parametersSchema>,
) {
  const parsed = parametersSchema.parse(parameters);
  if (hip4RawUnits(parsed.amount, 8) <= 0n)
    throw new Error("native_transfer_amount_invalid");
  // SDK user-signed domain, not a network routing selector. Never confuse this
  // signature chain with Core 1337, HyperEVM 999 or the nonce-mapping domain.
  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: 421614,
    verifyingContract: zeroAddress,
  };
  const message = { ...parsed };
  return {
    domain,
    types: structuredClone(HYPERCORE_SEND_ASSET_TYPES),
    primaryType: "HyperliquidTransaction:SendAsset",
    message,
  };
}

export type RelayHypercoreActionBinding = Readonly<{
  requestId: string;
  protocolOrderId: string;
  owner: string;
  authorizationDepositor: string;
  depository: string;
  sourceDex: "spot" | "";
  destinationDex: "spot" | "";
  nonce: number;
  sourceRaw: string;
}>;

export const relayHypercorePairBindingSchema = z
  .object({
    protocolOrderId: bytes32,
    owner: address,
    authorizationDepositor: address,
    depository: address,
    sourceDex: dex,
    destinationDex: dex,
    nonce,
    sourceRaw: z.string().regex(/^[1-9]\d*$/u),
  })
  .strict();

export type RelayHypercorePairBinding = z.infer<
  typeof relayHypercorePairBindingSchema
>;

/** Narrow provider-wire boundary for the two native steps. expected comes from
 * the independently validated/frozen protocol route, not the returned steps.
 * In particular authorizationDepositor and depository are distinct identities.
 * Unknown signing/action fields are rejected, never forwarded to a wallet. */
export function validateRelayHypercoreActions(
  value: unknown,
  expected: RelayHypercoreActionBinding,
) {
  const binding = relayHypercorePairBindingSchema
    .extend({
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,512}$/u),
    })
    .strict()
    .parse(expected);
  const step = z
    .object({
      id: z.string(),
      kind: z.string(),
      requestId: z.string(),
      depositAddress: z.union([z.literal(""), z.null()]).optional(),
      items: z.tuple([
        z
          .object({
            status: z.literal("incomplete"),
            data: z.unknown(),
            check: z
              .object({ endpoint: z.string(), method: z.literal("GET") })
              .strict()
              .optional(),
          })
          .strict(),
      ]),
      // These are provider presentation fields, never signing authority.
      action: z.string().optional(),
      description: z.string().optional(),
    })
    .strict();
  const [authorization, transfer] = z.tuple([step, step]).parse(value);
  if (
    authorization.id !== "authorize" ||
    authorization.kind !== "signature" ||
    transfer.id !== "deposit" ||
    transfer.kind !== "transaction" ||
    authorization.requestId !== binding.requestId ||
    transfer.requestId !== binding.requestId ||
    authorization.items[0].check !== undefined
  )
    throw new Error("native_step_identity_mismatch");
  const check = transfer.items[0].check;
  if (
    check?.endpoint !== `/intents/status/v3?requestId=${binding.requestId}` ||
    check.method !== "GET"
  )
    throw new Error("native_status_endpoint_mismatch");
  const { requestId: _requestId, ...pairBinding } = binding;
  const validated = validateRelayHypercorePayloads(
    {
      authorization: authorization.items[0].data,
      transfer: transfer.items[0].data,
    },
    pairBinding,
  );
  return { ...validated, binding };
}

/** Revalidate the exact saved pair at commit/submit without persisting a plain
 * provider request reference in either action. Network endpoints remain fixed;
 * only the encrypted segment reference may select provider reconciliation. */
export function validateRelayHypercorePayloads(
  payloads: Readonly<{ authorization: unknown; transfer: unknown }>,
  expected: RelayHypercorePairBinding,
) {
  const binding = relayHypercorePairBindingSchema.parse(expected);
  const auth = z
    .object({
      sign: z
        .object({
          signatureKind: z.literal("eip712"),
          domain: z
            .object({
              name: z.literal("RelayNonceMapping"),
              version: z.literal("2"),
              chainId: z.literal(1),
              verifyingContract: z.literal(zeroAddress),
            })
            .strict(),
          types: z.unknown(),
          primaryType: z.literal("NonceMapping"),
          value: z
            .object({
              chainId: z.literal("hyperliquid"),
              wallet: address,
              depositor: address,
              id: bytes32,
              nonce,
            })
            .strict(),
        })
        .strict(),
      post: z
        .object({
          endpoint: z.literal("/authorize"),
          method: z.literal("POST"),
          body: z
            .object({
              type: z.literal("nonce-mapping"),
              walletChainId: z.literal(1337),
              signatureChainId: z.literal(1),
              wallet: address,
              depositor: address,
              id: bytes32,
              nonce,
            })
            .strict(),
        })
        .strict(),
    })
    .strict()
    .parse(payloads.authorization);
  const send = z
    .object({
      action: z
        .object({ type: z.literal("sendAsset"), parameters: parametersSchema })
        .strict(),
      nonce,
      eip712Types: z.unknown(),
      eip712PrimaryType: z.literal("HyperliquidTransaction:SendAsset"),
    })
    .strict()
    .parse(payloads.transfer);
  // These two fields have EIP-712 `address` type: casing is not signed data.
  // Native owners need not use an EVM checksum. The SendAsset destination has
  // `string` type and must instead retain its exact signed bytes below.
  const message = {
    ...auth.sign.value,
    wallet: auth.sign.value.wallet.toLowerCase(),
    depositor: auth.sign.value.depositor.toLowerCase(),
  };
  const body = auth.post.body;
  const sameAddress = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  if (
    !canonicalJsonEqual(auth.sign.types, NONCE_MAPPING_TYPES) ||
    !canonicalJsonEqual(send.eip712Types, HYPERCORE_SEND_ASSET_TYPES)
  )
    throw new Error("native_signing_schema_mismatch");
  if (
    ![message, body].every(
      (part) =>
        sameAddress(part.wallet, binding.owner) &&
        sameAddress(part.depositor, binding.authorizationDepositor) &&
        part.id.toLowerCase() === binding.protocolOrderId.toLowerCase() &&
        part.nonce === binding.nonce,
    )
  )
    throw new Error("native_authorization_binding_mismatch");
  const parameters = send.action.parameters;
  if (
    send.nonce !== binding.nonce ||
    parameters.nonce !== binding.nonce ||
    !sameAddress(parameters.destination, binding.depository) ||
    parameters.sourceDex !== binding.sourceDex ||
    parameters.destinationDex !== binding.destinationDex ||
    hip4RawUnits(parameters.amount, 8) !== BigInt(binding.sourceRaw)
  )
    throw new Error("native_transfer_binding_mismatch");
  const authorizationTypedData = {
    domain: auth.sign.domain,
    types: structuredClone(NONCE_MAPPING_TYPES),
    primaryType: "NonceMapping",
    message,
  };
  const transferTypedData = hypercoreSendAssetTypedData(parameters);
  return {
    binding,
    payloads: { authorization: auth, transfer: send },
    authorization: {
      typedData: authorizationTypedData,
      post: {
        ...auth.post,
        body: {
          ...auth.post.body,
          wallet: message.wallet,
          depositor: message.depositor,
        },
      },
      digest: TypedDataEncoder.hash(
        authorizationTypedData.domain,
        authorizationTypedData.types,
        message,
      ),
    },
    transfer: {
      typedData: transferTypedData,
      action: {
        type: "sendAsset" as const,
        ...parameters,
        signatureChainId: "0x66eee",
      },
      digest: TypedDataEncoder.hash(
        transferTypedData.domain,
        transferTypedData.types,
        transferTypedData.message,
      ),
    },
    fingerprint: canonicalJsonHash({
      binding,
      authorization: auth,
      transfer: send,
    }),
  };
}

/** Verify sign-only output before any later server submit. Never rewrites the
 * signed decimal string, nonce or field order after the user signs. */
export function verifyHypercoreActionSignature(
  typedData:
    | ReturnType<typeof hypercoreSendAssetTypedData>
    | ReturnType<
        typeof validateRelayHypercoreActions
      >["authorization"]["typedData"],
  signature: string,
  expectedOwner: string,
) {
  const owner = address.parse(expectedOwner);
  if (
    verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      signature,
    ).toLowerCase() !== owner.toLowerCase()
  )
    throw new Error("native_signature_owner_mismatch");
  return signature;
}
