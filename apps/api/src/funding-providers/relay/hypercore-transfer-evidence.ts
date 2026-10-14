import { z } from "zod";
import { hip4RawUnits } from "@hunch/shared";
import { parseHip4LedgerObservation } from "../../services/hip4-account-contract.js";
import type { AssetRef } from "../../funding/domain/types.js";
import { isHypercoreMainnetUsdc } from "../../funding/domain/hypercore-identity.js";
import { sameAccountAddress } from "../../funding/domain/asset-identity.js";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../funding/reconciliation/owned-route-destination-observer.js";

const account = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/);
const dex = z.enum(["spot", ""]);

// This schema selects native evidence from Requests v3, not its summary status.
// Unknown enclosing presentation fields do not become signing authority.
export const relayHypercoreTransactionSchema = z.object({
  txHash: hash,
  chainId: z.literal(1337),
  status: z.literal("success"),
  block: integer,
  data: z.object({
    hash,
    error: z.null(),
    user: account,
    action: z.object({
      type: z.literal("sendAsset"),
      hyperliquidChain: z.literal("Mainnet"),
      destination: account,
      sourceDex: dex,
      destinationDex: dex,
      token: z.string(),
      amount,
      fromSubAccount: z.literal(""),
      nonce: integer,
    }),
  }),
});

export type HypercoreTransferExpectation = Readonly<{
  asset: AssetRef;
  owner: string;
  dex: "spot" | "";
  direction: "credit" | "debit";
  /** From the exact operation's provider status, never a nearest-time match. */
  transactionHash: string;
  /** Exact observed native amount in Requests v3, not the nominal source input. */
  actualRaw: string;
}>;

/** Provider observation time/block presentation is not transfer identity. */
export function hypercoreTransactionFingerprint(
  transaction: z.infer<typeof relayHypercoreTransactionSchema>,
  rawAmount: string,
): string {
  const { data } = transaction;
  return canonicalJsonHash({
    chainId: transaction.chainId,
    hash: data.hash.toLowerCase(),
    user: data.user.toLowerCase(),
    action: {
      ...data.action,
      amount: rawAmount,
      destination: data.action.destination.toLowerCase(),
    },
  });
}

export type HypercoreTransferEvidence = Readonly<{
  networkId: string;
  asset: AssetRef;
  owner: string;
  direction: "credit" | "debit";
  transactionHash: string;
  nonce: number;
  sourceAddress: string;
  destinationAddress: string;
  sourceDex: "spot" | "";
  destinationDex: "spot" | "";
  rawAmount: string;
  ledgerTime: number;
  /** Relay corroboration only: never manufacture an EVM block hash/finality. */
  providerBlock: number;
  evidenceFingerprint: string;
}>;

export type HypercoreTransferEvidenceResult =
  | Readonly<{ kind: "verified"; evidence: HypercoreTransferEvidence }>
  | Readonly<{
      kind: "unverified";
      reason:
        | "unsupported_native_asset"
        | "invalid_expectation"
        | "provider_native_evidence_invalid"
        | "native_identity_mismatch"
        | "native_amount_mismatch"
        | "native_ledger_missing"
        | "native_ledger_invalid"
        | "native_ledger_conflict"
        | "native_transfer_fee_semantics_unknown";
    }>;

/** Uses the existing global funding-event identity and allocator. The proof
 * fingerprint is provenance, never the economic idempotency key. */
export function hypercoreDestinationEvent(
  evidence: HypercoreTransferEvidence,
  observedAt: Date,
): OwnedRouteCanonicalDestinationEvent {
  if (evidence.direction !== "credit")
    throw new Error("Native debit is not destination credit");
  return {
    networkId: evidence.networkId,
    asset: evidence.asset,
    destinationAddress: evidence.destinationAddress,
    sourceAddress: evidence.sourceAddress,
    rawAmount: evidence.rawAmount,
    transactionHash: evidence.transactionHash,
    eventIndex: "hypercore:send:destination_credit",
    ledgerHeight: null,
    blockHash: null,
    observedAt,
    nativeEvidence: evidence,
  };
}

/** Native evidence boundary for the existing funding receipt allocator.
 * Pure, no network/writes: caller must bind provider reference and owned target,
 * then allocate the verified fact once through the shared operation machinery.
 * This proof is not available balance, a signature, or permission to spend. */
export function verifyRelayHypercoreTransfer(input: {
  expected: HypercoreTransferExpectation;
  nativeTransaction: unknown;
  ledger: readonly unknown[];
}): HypercoreTransferEvidenceResult {
  const fail = (
    reason: Extract<
      HypercoreTransferEvidenceResult,
      { kind: "unverified" }
    >["reason"],
  ): HypercoreTransferEvidenceResult => ({ kind: "unverified", reason });
  const { expected } = input;
  if (!isHypercoreMainnetUsdc(expected.asset))
    return fail("unsupported_native_asset");
  if (
    !account.safeParse(expected.owner).success ||
    !hash.safeParse(expected.transactionHash).success ||
    !/^[1-9]\d*$/.test(expected.actualRaw) ||
    !dex.safeParse(expected.dex).success ||
    !["credit", "debit"].includes(expected.direction)
  )
    return fail("invalid_expectation");
  const parsed = relayHypercoreTransactionSchema.safeParse(
    input.nativeTransaction,
  );
  if (!parsed.success) return fail("provider_native_evidence_invalid");
  const transaction = parsed.data;
  const action = transaction.data.action;
  const sameAccount = (left: string, right: string) =>
    sameAccountAddress(expected.asset.networkId, left, right);
  const transactionHash = expected.transactionHash.toLowerCase();
  const ownedAddress =
    expected.direction === "credit"
      ? action.destination
      : transaction.data.user;
  const ownedDex =
    expected.direction === "credit" ? action.destinationDex : action.sourceDex;
  if (
    transaction.txHash.toLowerCase() !== transactionHash ||
    transaction.data.hash.toLowerCase() !== transactionHash ||
    !sameAccount(ownedAddress, expected.owner) ||
    ownedDex !== expected.dex ||
    action.token !== `USDC:${expected.asset.assetId.toLowerCase()}` ||
    sameAccount(transaction.data.user, action.destination)
  )
    return fail("native_identity_mismatch");
  // Internal class transfers are neither external route credits nor withdrawals.
  let raw: bigint;
  try {
    raw = hip4RawUnits(action.amount, expected.asset.decimals);
  } catch {
    return fail("native_amount_mismatch");
  }
  if (raw !== BigInt(expected.actualRaw)) return fail("native_amount_mismatch");

  const facts = new Map<
    string,
    Omit<HypercoreTransferEvidence, "evidenceFingerprint">
  >();
  for (const candidate of input.ledger) {
    // Unrelated ledger activity is not part of this exact transfer's proof.
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("hash" in candidate) ||
      typeof candidate.hash !== "string" ||
      candidate.hash.toLowerCase() !== transactionHash
    )
      continue;
    let parsedLedger: ReturnType<typeof parseHip4LedgerObservation>;
    try {
      parsedLedger = parseHip4LedgerObservation(candidate);
    } catch {
      return fail("native_ledger_invalid");
    }
    if (!parsedLedger.supported || parsedLedger.entry.delta.type !== "send")
      return fail("native_ledger_conflict");
    const { delta } = parsedLedger.entry;
    if (
      !sameAccount(delta.user, transaction.data.user) ||
      !sameAccount(delta.destination, action.destination) ||
      delta.sourceDex !== action.sourceDex ||
      delta.destinationDex !== action.destinationDex ||
      delta.nonce !== action.nonce ||
      delta.token !== "USDC"
    )
      return fail("native_ledger_conflict");
    try {
      if (hip4RawUnits(delta.amount, expected.asset.decimals) !== raw)
        return fail("native_amount_mismatch");
      // P0 receipts only establish zero-fee transfer amount semantics. Preserve
      // unknown nonzero fees for repair instead of treating them as zero costs.
      if (
        !/^0(?:\.0+)?$/.test(delta.fee) ||
        !/^0(?:\.0+)?$/.test(delta.nativeTokenFee)
      )
        return fail("native_transfer_fee_semantics_unknown");
    } catch {
      return fail("native_amount_mismatch");
    }
    const fact = {
      networkId: expected.asset.networkId,
      asset: {
        ...expected.asset,
        assetId: expected.asset.assetId.toLowerCase(),
      },
      owner: expected.owner.toLowerCase(),
      direction: expected.direction,
      transactionHash,
      nonce: action.nonce,
      sourceAddress: transaction.data.user.toLowerCase(),
      destinationAddress: action.destination.toLowerCase(),
      sourceDex: action.sourceDex,
      destinationDex: action.destinationDex,
      rawAmount: raw.toString(),
      ledgerTime: parsedLedger.entry.time,
      providerBlock: transaction.block,
    };
    facts.set(canonicalJsonHash(fact), fact);
  }
  if (facts.size === 0) return fail("native_ledger_missing");
  if (facts.size !== 1) return fail("native_ledger_conflict");
  const entry = facts.entries().next().value;
  if (!entry) return fail("native_ledger_missing");
  const [evidenceFingerprint, fact] = entry;
  return { kind: "verified", evidence: { ...fact, evidenceFingerprint } };
}
