import { z } from "zod";
import { hip4RawUnits } from "@hunch/shared";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { isHypercoreMainnetUsdc } from "../funding/domain/hypercore-identity.js";
import { parseHip4LedgerObservation } from "./hip4-account-contract.js";

/** Existing exact physical-hash index bounds each lookup; two rows are an
 * ambiguity sentinel, never an invitation to choose the convenient receipt. */
export const HIP4_BASIS_CASH_RECEIPTS_SQL = `select receipt_row.*
  from (select distinct hash_row.hash from unnest($1::text[]) as hash_row(hash)) requested_hash
  cross join lateral (
    select observation_row.network_id,observation_row.asset_id,observation_row.asset_decimals,
      observation_row.tx_hash,observation_row.event_index,observation_row.kind,
      observation_row.from_address,observation_row.to_address,observation_row.raw_amount,
      observation_row.canonical,observation_row.finality_status,observation_row.reorged_at,
      observation_row.metadata
    from funding_observations observation_row
    where observation_row.network_id='hyperliquid:mainnet' and observation_row.tx_hash is not null
      and md5(lower(observation_row.tx_hash))=md5(requested_hash.hash)
      and lower(observation_row.tx_hash)=requested_hash.hash
      and observation_row.event_index='hypercore:send:destination_credit'
      and observation_row.kind='destination_credit' and observation_row.canonical
      and observation_row.finality_status='finalized' and observation_row.reorged_at is null
    limit 2
  ) receipt_row`;

const account = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/u);
const dex = z.enum(["spot", ""]);
const receiptSchema = z.object({
  network_id: z.literal("hyperliquid:mainnet"),
  asset_id: z.string(),
  asset_decimals: z.literal(8),
  tx_hash: hash,
  event_index: z.literal("hypercore:send:destination_credit"),
  kind: z.literal("destination_credit"),
  from_address: account,
  to_address: account,
  raw_amount: z.string().regex(/^[1-9]\d*$/u),
  canonical: z.literal(true),
  finality_status: z.literal("finalized"),
  reorged_at: z.null(),
  metadata: z.object({
    observerId: z.literal("relay_owned_destination_observation_v1"),
    nativeEvidenceKind: z.literal("hypercore_send_ledger_v1"),
    relayTransactionReferenceMatched: z.literal(true),
    nativeNonce: integer,
    nativeLedgerTime: integer,
    nativeProviderBlock: integer,
    nativeSourceDex: dex,
    nativeDestinationDex: z.literal("spot"),
    nativeFeeObservation: z.object({
      fee: amount,
      nativeTokenFee: amount,
      feeToken: z.string(),
    }),
    nativeEvidenceFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});

export type Hip4BasisLedgerEntry = {
  time: number;
  hash?: string;
  delta: Record<string, unknown>;
};
export function hip4BasisLedgerEvidenceKey(
  entry: Hip4BasisLedgerEntry,
): string {
  return canonicalJsonHash({
    time: entry.time,
    hash: entry.hash?.toLowerCase() ?? null,
    delta: entry.delta,
  });
}

/** Accounting-only reuse of an existing verified incoming quote receipt. The
 * receipt verifier already bound canonical native action token ID to this bare
 * USDC ledger alias. This grants no credit, capacity, send or continuation and
 * cannot prove a sender debit. No amount/fee is added to or subtracted from PnL.
 */
export function hip4ProvenCashLedgerEntries(input: {
  environment: "mainnet" | "testnet";
  address: string;
  assetId: string;
  decimals: number;
  ledger: readonly Hip4BasisLedgerEntry[];
  observations: readonly unknown[];
}): ReadonlySet<string> {
  const proven = new Set<string>();
  const asset = {
    networkId: `hyperliquid:${input.environment}`,
    assetId: input.assetId,
    decimals: input.decimals,
  };
  if (
    !isHypercoreMainnetUsdc(asset) ||
    !account.safeParse(input.address).success
  )
    return proven;
  const byHash = new Map<string, unknown[]>();
  for (const value of input.observations) {
    if (
      !value ||
      typeof value !== "object" ||
      !("tx_hash" in value) ||
      typeof value.tx_hash !== "string"
    )
      continue;
    const key = value.tx_hash.toLowerCase();
    byHash.set(key, [...(byHash.get(key) ?? []), value]);
  }
  for (const entry of input.ledger) {
    try {
      const parsed = parseHip4LedgerObservation(entry);
      if (!parsed.supported || parsed.entry.delta.type !== "send") continue;
      const { delta } = parsed.entry;
      const candidates = byHash.get(parsed.entry.hash.toLowerCase()) ?? [];
      if (candidates.length !== 1) continue;
      const receipt = receiptSchema.safeParse(candidates[0]).data;
      if (!receipt) continue;
      const metadata = receipt.metadata;
      const same = (left: unknown, right: string) =>
        typeof left === "string" && left.toLowerCase() === right.toLowerCase();
      if (
        receipt.asset_id.toLowerCase() !== asset.assetId.toLowerCase() ||
        !same(receipt.to_address, input.address) ||
        !same(delta.destination, input.address) ||
        !same(delta.user, receipt.from_address) ||
        same(delta.user, input.address) ||
        delta.token !== "USDC" ||
        delta.sourceDex !== metadata.nativeSourceDex ||
        delta.destinationDex !== metadata.nativeDestinationDex ||
        delta.nonce !== metadata.nativeNonce ||
        entry.time !== metadata.nativeLedgerTime ||
        hip4RawUnits(String(delta.amount), 8).toString() !==
          receipt.raw_amount ||
        delta.fee !== metadata.nativeFeeObservation.fee ||
        delta.nativeTokenFee !== metadata.nativeFeeObservation.nativeTokenFee ||
        delta.feeToken !== metadata.nativeFeeObservation.feeToken
      )
        continue;
      const fingerprint = canonicalJsonHash({
        networkId: asset.networkId,
        asset: { ...asset, assetId: asset.assetId.toLowerCase() },
        owner: input.address.toLowerCase(),
        direction: "credit",
        transactionHash: parsed.entry.hash.toLowerCase(),
        nonce: metadata.nativeNonce,
        sourceAddress: receipt.from_address.toLowerCase(),
        destinationAddress: input.address.toLowerCase(),
        sourceDex: metadata.nativeSourceDex,
        destinationDex: metadata.nativeDestinationDex,
        rawAmount: receipt.raw_amount,
        feeObservation: metadata.nativeFeeObservation,
        ledgerTime: entry.time,
        providerBlock: metadata.nativeProviderBlock,
      });
      if (fingerprint !== metadata.nativeEvidenceFingerprint) continue;
      proven.add(hip4BasisLedgerEvidenceKey(entry));
    } catch {
      // A malformed/contradictory optional proof leaves the event unknown.
    }
  }
  return proven;
}
