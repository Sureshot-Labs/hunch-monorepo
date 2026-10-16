import { isAddress } from "ethers";
import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmTransactionReceipt,
} from "../../services/polygon-rpc.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import type { FundingReceiveCanonicalEventInput } from "../persistence/funding-receive-session-repository.js";
import { relayErc20ReceiptEvents } from "../reconciliation/relay-destination-receipts.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import { EVM_FUNDING_RECEIVE_CONFIRMATIONS } from "./canonical-receive-capabilities.js";
import { receiveRoleEventFingerprint } from "./receive-role-progress.js";

export type EvmFundingReceiveAnchorProof =
  | Readonly<{ kind: "deferred"; reason: string }>
  | Readonly<{
      kind: "canonical";
      eventFingerprint: string;
    }>
  | Readonly<{
      kind: "replacement_verified";
      eventFingerprint: string;
      previousCanonicalHash: string;
      ledgerHeight: string;
      blockHash: string;
    }>;

const DEFAULT_RPC = {
  receipt: fetchEvmTransactionReceipt,
  head: fetchEvmBlockNumber,
  block: fetchEvmBlockHash,
};
const HASH = /^0x[\da-f]{64}$/iu;
const INTEGER = /^(0|[1-9][0-9]*)$/u;

/** Bounded read-only proof for one KNOWN physical event. A replaced block is
 * not a replacement transfer. This grants no anchor-write/allocation/Buy
 * authority; its eventual caller must still CAS the stored envelope under E.
 * The existing receive threshold applies to BOTH old and replacement blocks.
 */
export async function inspectEvmFundingReceiveAnchor(
  input: Readonly<{
    expected: FundingReceiveCanonicalEventInput;
    deadlineMs: number;
  }>,
  rpc = DEFAULT_RPC,
): Promise<EvmFundingReceiveAnchorProof> {
  const event = input.expected;
  const deferred = (reason: string): EvmFundingReceiveAnchorProof => ({
    kind: "deferred",
    reason,
  });
  const config = fundingSidecarRuntimeConfig;
  const network =
    event.networkId === "evm:137"
      ? { rpcUrl: config.polygonRpcUrl, timeoutMs: config.polygonRpcTimeoutMs }
      : event.networkId === "evm:8453"
        ? { rpcUrl: config.baseRpcUrl, timeoutMs: config.baseRpcTimeoutMs }
        : null;
  if (
    !network ||
    event.asset.networkId !== event.networkId ||
    !HASH.test(event.transactionHash) ||
    !HASH.test(event.blockHash) ||
    !INTEGER.test(event.ledgerHeight) ||
    !Number.isSafeInteger(Number(event.ledgerHeight)) ||
    !INTEGER.test(event.eventIndex) ||
    !Number.isSafeInteger(Number(event.eventIndex)) ||
    !/^[1-9][0-9]*$/u.test(event.rawAmount) ||
    !Number.isSafeInteger(event.asset.decimals) ||
    event.asset.decimals < 0 ||
    event.asset.decimals > 255 ||
    !isAddress(event.asset.assetId) ||
    !isAddress(event.destinationAddress) ||
    event.sourceAddress === null ||
    !isAddress(event.sourceAddress)
  )
    return deferred("receive_anchor_invalid_identity");
  if (!Number.isFinite(input.deadlineMs))
    return deferred("receive_anchor_invalid_deadline");
  const sourceAddress = event.sourceAddress;
  const remaining = () => Math.max(0, Math.ceil(input.deadlineMs - Date.now()));
  try {
    if (!remaining()) return deferred("receive_anchor_deadline");
    network.timeoutMs = Math.min(network.timeoutMs, remaining());
    const oldHeight = Number(event.ledgerHeight);
    const [head, oldHash, receipt] = await Promise.all([
      rpc.head({
        ...network,
        bypassCache: true,
        isolateBudget: true,
        maxAttempts: 1,
      }),
      rpc.block({ ...network, blockNumber: oldHeight, maxAttempts: 1 }),
      rpc.receipt({
        ...network,
        transactionHash: event.transactionHash,
        maxAttempts: 1,
      }),
    ]);
    if (!remaining()) return deferred("receive_anchor_deadline");
    if (
      typeof head !== "bigint" ||
      !oldHash ||
      !HASH.test(oldHash) ||
      head < BigInt(oldHeight) + EVM_FUNDING_RECEIVE_CONFIRMATIONS - 1n
    )
      return deferred("receive_anchor_old_block_unavailable");
    if (
      !receipt?.succeeded ||
      !receipt.transactionHash ||
      !HASH.test(receipt.transactionHash) ||
      receipt.transactionHash.toLowerCase() !==
        event.transactionHash.toLowerCase() ||
      !Number.isSafeInteger(receipt.blockNumber) ||
      receipt.blockNumber < 0 ||
      !HASH.test(receipt.blockHash)
    )
      return deferred("receive_anchor_receipt_unavailable_or_conflicting");
    network.timeoutMs = Math.min(network.timeoutMs, remaining());
    const canonicalHash =
      receipt.blockNumber === oldHeight
        ? oldHash
        : await rpc.block({
            ...network,
            blockNumber: receipt.blockNumber,
            maxAttempts: 1,
          });
    if (!remaining()) return deferred("receive_anchor_deadline");
    if (
      !canonicalHash ||
      !HASH.test(canonicalHash) ||
      head <
        BigInt(receipt.blockNumber) + EVM_FUNDING_RECEIVE_CONFIRMATIONS - 1n ||
      canonicalHash.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      return deferred("receive_anchor_receipt_not_final");
    const replaced = oldHash.toLowerCase() !== event.blockHash.toLowerCase();
    if (
      !replaced &&
      (receipt.blockNumber !== oldHeight ||
        receipt.blockHash.toLowerCase() !== event.blockHash.toLowerCase())
    )
      return deferred("receive_anchor_inconsistent_blocks");
    const sameIndex = receipt.logs.filter(
      (log) => String(log.logIndex) === event.eventIndex,
    );
    const exact = relayErc20ReceiptEvents(
      {
        asset: event.asset,
        destinationAddress: event.destinationAddress,
        transactionHash: event.transactionHash,
        now: event.observedAt,
      },
      receipt,
    ).filter(
      (entry) =>
        entry.eventIndex === event.eventIndex &&
        entry.rawAmount === event.rawAmount &&
        entry.sourceAddress !== null &&
        sameAccountAddress(event.networkId, entry.sourceAddress, sourceAddress),
    );
    if (sameIndex.length !== 1 || exact.length !== 1)
      return deferred("receive_anchor_economic_identity_conflict");
    const eventFingerprint = receiveRoleEventFingerprint(event);
    return replaced
      ? {
          kind: "replacement_verified",
          eventFingerprint,
          previousCanonicalHash: oldHash.toLowerCase(),
          ledgerHeight: String(receipt.blockNumber),
          blockHash: receipt.blockHash.toLowerCase(),
        }
      : { kind: "canonical", eventFingerprint };
  } catch {
    return deferred("receive_anchor_transport_or_payload_error");
  }
}
