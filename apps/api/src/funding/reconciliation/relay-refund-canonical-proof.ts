import { z } from "zod";
import { sameAccountAddress } from "../domain/asset-identity.js";
import type { AssetRef } from "../domain/types.js";
import { isHypercoreMainnetUsdc } from "../domain/hypercore-identity.js";
import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmTransactionReceipt,
} from "../../services/polygon-rpc.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import { Hip4ReadError } from "../../services/hip4-client.js";
import { relayErc20ReceiptEvents } from "./relay-destination-receipts.js";
import { verifyRelayHypercoreTransfer } from "../../funding-providers/relay/hypercore-transfer-evidence.js";

export type RefundCanonicalTarget = Readonly<{
  asset: AssetRef;
  txHash: string;
  eventIndex: string;
  rawAmount: string;
  fromAddress: string;
  toAddress: string;
  ledgerHeight: string | null;
  blockHash: string | null;
  nativeDex: "spot" | "" | null;
  nativeLedgerTime: number | null;
  nativeTransaction: unknown;
}>;
export type RefundCanonicalProof =
  | Readonly<{ kind: "pending"; reason: string }>
  | Readonly<{ kind: "reorged" }>
  | Readonly<{
      kind: "canonical";
      ledgerHeight: string | null;
      blockHash: string | null;
    }>;
const pending = (reason: string): RefundCanonicalProof => ({
  kind: "pending",
  reason,
});
const hash = /^0x[\da-f]{64}$/iu;
const rpcDefaults = {
  receipt: fetchEvmTransactionReceipt,
  head: fetchEvmBlockNumber,
  block: fetchEvmBlockHash,
};

/** Verify a previously recorded exact refund, with NO Relay dependency. A null
 * receipt or RPC error alone never retracts money. Only a different canonical
 * hash at the old finalized height proves that its old block was replaced. */
export async function inspectEvmRefundCanonicality(
  target: RefundCanonicalTarget,
  now: Date,
  rpc = rpcDefaults,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<RefundCanonicalProof> {
  const config = fundingSidecarRuntimeConfig;
  const network =
    target.asset.networkId === "evm:137"
      ? { rpcUrl: config.polygonRpcUrl, timeoutMs: config.polygonRpcTimeoutMs }
      : target.asset.networkId === "evm:8453"
        ? { rpcUrl: config.baseRpcUrl, timeoutMs: config.baseRpcTimeoutMs }
        : null;
  if (
    !network ||
    !target.ledgerHeight ||
    !/^\d+$/.test(target.ledgerHeight) ||
    !Number.isSafeInteger(Number(target.ledgerHeight)) ||
    !target.blockHash ||
    !hash.test(target.blockHash) ||
    !hash.test(target.txHash)
  )
    return pending("refund_watch_invalid_evm_anchor");
  try {
    const remaining = () => Math.max(0, Math.ceil(deadlineMs - Date.now()));
    if (!remaining()) return pending("refund_watch_deadline");
    network.timeoutMs = Math.min(network.timeoutMs, remaining());
    const oldHeight = Number(target.ledgerHeight);
    const [head, oldHash, receipt] = await Promise.all([
      rpc.head({ ...network, bypassCache: true, maxAttempts: 1 }),
      rpc.block({ ...network, blockNumber: oldHeight, maxAttempts: 1 }),
      rpc.receipt({
        ...network,
        transactionHash: target.txHash,
        maxAttempts: 1,
      }),
    ]);
    if (!oldHash || !hash.test(oldHash) || head < BigInt(oldHeight) + 1n)
      return pending("refund_watch_evm_anchor_unavailable");
    const replaced = oldHash.toLowerCase() !== target.blockHash.toLowerCase();
    if (!receipt)
      return replaced
        ? { kind: "reorged" }
        : pending("refund_watch_evm_receipt_unavailable");
    if (!remaining()) return pending("refund_watch_deadline");
    network.timeoutMs = Math.min(network.timeoutMs, remaining());
    const canonicalHash =
      receipt.blockNumber === oldHeight
        ? oldHash
        : await rpc.block({
            ...network,
            blockNumber: receipt.blockNumber,
            maxAttempts: 1,
          });
    if (
      !canonicalHash ||
      !hash.test(canonicalHash) ||
      head < BigInt(receipt.blockNumber) + 1n ||
      canonicalHash.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      return replaced
        ? { kind: "reorged" }
        : pending("refund_watch_evm_receipt_not_final");
    const exact = relayErc20ReceiptEvents(
      {
        asset: target.asset,
        destinationAddress: target.toAddress,
        transactionHash: target.txHash,
        now,
      },
      receipt,
    ).filter(
      (event) =>
        event.eventIndex === target.eventIndex &&
        event.rawAmount === target.rawAmount &&
        event.sourceAddress !== null &&
        sameAccountAddress(
          target.asset.networkId,
          event.sourceAddress,
          target.fromAddress,
        ),
    );
    if (exact.length !== 1)
      return replaced
        ? { kind: "reorged" }
        : pending("refund_watch_evm_receipt_conflict");
    // A second block claiming the same transaction while its old block remains
    // canonical is inconsistent RPC evidence, not permission to rewrite proof.
    if (
      !replaced &&
      (String(receipt.blockNumber) !== target.ledgerHeight ||
        receipt.blockHash.toLowerCase() !== target.blockHash.toLowerCase())
    )
      return pending("refund_watch_evm_anchor_conflict");
    return {
      kind: "canonical",
      ledgerHeight: String(receipt.blockNumber),
      blockHash: receipt.blockHash,
    };
  } catch {
    return pending("refund_watch_evm_transport_or_payload_error");
  }
}

/** Exact stored native second/action; no account history scan, provider status,
 * balance delta or fabricated EVM finality. An absent/truncated info page is
 * inconclusive, so it keeps verification pending rather than inventing a reorg. */
export async function inspectNativeRefundCanonicality(
  target: RefundCanonicalTarget,
  read: (owner: string, start: number, end: number) => Promise<unknown>,
): Promise<RefundCanonicalProof> {
  if (
    !isHypercoreMainnetUsdc(target.asset) ||
    target.nativeDex === null ||
    target.nativeLedgerTime === null ||
    !Number.isSafeInteger(target.nativeLedgerTime) ||
    target.nativeLedgerTime < 0 ||
    target.eventIndex !== "hypercore:send:destination_credit" ||
    target.ledgerHeight !== null ||
    target.blockHash !== null
  )
    return pending("refund_watch_invalid_native_anchor");
  const start = Math.floor(target.nativeLedgerTime / 1000) * 1000;
  if (!Number.isSafeInteger(start + 999))
    return pending("refund_watch_invalid_native_anchor");
  try {
    const ledger = z
      .array(z.unknown())
      .max(2000)
      .parse(await read(target.toAddress, start, start + 999));
    const proof = verifyRelayHypercoreTransfer({
      expected: {
        asset: target.asset,
        owner: target.toAddress,
        dex: target.nativeDex,
        direction: "credit",
        transactionHash: target.txHash,
        actualRaw: target.rawAmount,
      },
      nativeTransaction: target.nativeTransaction,
      ledger,
    });
    if (proof.kind !== "verified")
      return pending(`refund_watch_${proof.reason}`);
    if (
      proof.evidence.ledgerTime !== target.nativeLedgerTime ||
      !sameAccountAddress(
        target.asset.networkId,
        proof.evidence.sourceAddress,
        target.fromAddress,
      )
    )
      return pending("refund_watch_native_anchor_conflict");
    return { kind: "canonical", ledgerHeight: null, blockHash: null };
  } catch (error) {
    if (error instanceof Hip4ReadError && error.reason === "budget_exhausted")
      return pending("refund_watch_budget_exhausted");
    return pending("refund_watch_native_transport_or_payload_error");
  }
}
