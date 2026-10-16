import { z } from "zod";
import { sameAsset, sameAccountAddress } from "./asset-identity.js";
import {
  hypercoreLocationDex,
  isHypercoreFundingNetwork,
} from "./hypercore-identity.js";
import type { AssetRef, Money } from "./types.js";

/** Immutable opt-in on the existing segment refund snapshot. Legacy routes
 * retain their contract; a malformed/future marker never means legacy. */
export const EXACT_REFUND_RECEIPTS_CONTRACT = "relay_exact_refund_receipts_v1";
export const EXACT_REFUND_OBSERVER_ID = "relay_exact_refund_observation_v1";

const assetSchema = z.object({
  networkId: z.string().min(1),
  assetId: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
});
const moneySchema = z.object({
  asset: assetSchema,
  raw: z.string().regex(/^[1-9]\d*$/u),
});
const locationSchema = z.object({
  kind: z.string(),
  locationId: z.string().min(1),
  asset: assetSchema,
  details: z.record(z.string(), z.unknown()),
});
const requestBindingSchema = z.object({
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  lookupKeyVersion: z.number().int().positive(),
  protocolOrderId: z.string().regex(/^0x[a-f0-9]{64}$/u),
});
const receiptSchema = requestBindingSchema.extend({
  version: z.literal(1),
  refundLocationId: z.string().min(1),
});
const completionSchema = receiptSchema.extend({
  expectedReturned: moneySchema,
  observationIds: z.array(z.string().uuid()).min(1),
});

export type FundingRefundReceiptIdentity = z.infer<typeof receiptSchema>;
export type FundingRefundCompletionProof = z.infer<typeof completionSchema>;
export type FundingRefundLocation = Readonly<{
  locationId: string;
  asset: AssetRef;
  address: string;
  nativeDex: "spot" | "" | null;
}>;
export type FundingRefundContract = Readonly<{
  supported: boolean;
  requestBinding: z.infer<typeof requestBindingSchema> | null;
  locations: readonly FundingRefundLocation[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readFundingRefundContract(
  snapshot: unknown,
  requestBinding?: unknown,
): FundingRefundContract | null {
  if (!record(snapshot) || !Object.hasOwn(snapshot, "refundEvidenceContract"))
    return null;
  const unsupported: FundingRefundContract = {
    supported: false,
    requestBinding: null,
    locations: [],
  };
  if (snapshot.refundEvidenceContract !== EXACT_REFUND_RECEIPTS_CONTRACT)
    return unsupported;
  const binding = requestBindingSchema.safeParse({
    ...(record(requestBinding) ? requestBinding : {}),
    protocolOrderId: snapshot.relayProtocolOrderId,
  });
  if (!binding.success) return unsupported;
  const candidates: unknown[] = [snapshot];
  if (snapshot.alternativeRefundLocations !== undefined) {
    const alternatives = snapshot.alternativeRefundLocations;
    if (
      !record(alternatives) ||
      alternatives.version !== 1 ||
      !Array.isArray(alternatives.locations)
    )
      return unsupported;
    candidates.push(...alternatives.locations);
  }
  const locations: FundingRefundLocation[] = [];
  for (const candidate of candidates) {
    const parsed = locationSchema.safeParse(candidate);
    if (!parsed.success) return unsupported;
    const { locationId, asset, details } = parsed.data;
    const nativeDex = hypercoreLocationDex(parsed.data);
    if (
      typeof details.address !== "string" ||
      !details.address ||
      (isHypercoreFundingNetwork(asset.networkId) && nativeDex === null) ||
      locations.some((location) => location.locationId === locationId)
    )
      return unsupported;
    locations.push({ locationId, asset, address: details.address, nativeDex });
  }
  return { supported: true, requestBinding: binding.data, locations };
}

export function readFundingRefundReceiptIdentity(
  value: unknown,
): FundingRefundReceiptIdentity | null {
  const parsed = receiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Append-only map, not a mutable complete boolean. New receipt sets may be
 * appended after recovery without rewriting the old proof or its members. */
export function readFundingRefundCompletionProofs(
  value: unknown,
): readonly FundingRefundCompletionProof[] {
  if (!record(value)) return [];
  const proofs: FundingRefundCompletionProof[] = [];
  for (const [fingerprint, proof] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) continue;
    const parsed = completionSchema.safeParse(proof);
    if (parsed.success) proofs.push(parsed.data);
  }
  return proofs;
}

export type FundingRefundSettledReceipt = Readonly<{
  observationId: string;
  money: Money;
  destinationAddress: string;
  nativeDestinationDex: "spot" | "" | null;
  identity: FundingRefundReceiptIdentity | null;
  completionProofs: readonly FundingRefundCompletionProof[];
}>;

/** Validate one receipt without asserting that the whole refund is complete. */
export function fundingRefundReceiptMatchesContract(
  contract: FundingRefundContract,
  receipt: FundingRefundSettledReceipt,
): boolean {
  const binding = contract.requestBinding;
  const identity = receipt.identity;
  if (
    !contract.supported ||
    !binding ||
    !identity ||
    identity.version !== 1 ||
    identity.requestFingerprint !== binding.requestFingerprint ||
    identity.lookupKeyVersion !== binding.lookupKeyVersion ||
    identity.protocolOrderId !== binding.protocolOrderId ||
    typeof receipt.money.raw !== "string" ||
    !/^[1-9]\d*$/u.test(receipt.money.raw)
  )
    return false;
  const target = contract.locations.find(
    (location) => location.locationId === identity.refundLocationId,
  );
  return (
    !!target &&
    sameAsset(receipt.money.asset, target.asset) &&
    sameAccountAddress(
      target.asset.networkId,
      target.address,
      receipt.destinationAddress,
    ) &&
    receipt.nativeDestinationDex === target.nativeDex
  );
}

/** Caller supplies ALL current canonical final refund receipts in one leg.
 * No source nominal, status cache or subset of an old proof completes a refund.
 * Reorged/unknown transfers remain conflicts in the common lifecycle. */
export function fundingRefundReceiptSetComplete(
  contract: FundingRefundContract,
  receipts: readonly FundingRefundSettledReceipt[],
): boolean {
  if (!contract.supported || !contract.requestBinding || !receipts.length)
    return false;
  const binding = contract.requestBinding;
  const ids = new Set(receipts.map((receipt) => receipt.observationId));
  if (ids.size !== receipts.length) return false;
  return receipts.some((anchor) =>
    anchor.completionProofs.some((proof) => {
      if (
        proof.requestFingerprint !== binding.requestFingerprint ||
        proof.lookupKeyVersion !== binding.lookupKeyVersion ||
        proof.protocolOrderId !== binding.protocolOrderId
      )
        return false;
      const members = new Set(proof.observationIds);
      if (
        members.size !== proof.observationIds.length ||
        members.size !== ids.size ||
        !members.has(anchor.observationId) ||
        [...ids].some((id) => !members.has(id))
      )
        return false;
      const target = contract.locations.find(
        (location) => location.locationId === proof.refundLocationId,
      );
      if (!target || !sameAsset(target.asset, proof.expectedReturned.asset))
        return false;
      let total = 0n;
      for (const receipt of receipts) {
        if (
          !fundingRefundReceiptMatchesContract(contract, receipt) ||
          receipt.identity?.refundLocationId !== proof.refundLocationId
        )
          return false;
        total += BigInt(receipt.money.raw);
      }
      return total === BigInt(proof.expectedReturned.raw);
    }),
  );
}
