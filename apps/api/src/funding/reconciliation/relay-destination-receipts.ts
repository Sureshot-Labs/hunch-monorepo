import { tx, type Pool } from "@hunch/infra";
import { ethers } from "ethers";

import { isRecord } from "../../lib/type-guards.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmTransactionReceipt,
} from "../../services/polygon-rpc.js";
import type { AssetRef } from "../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  classifyOwnedRouteCanonicalDestinationEvents,
  recordOwnedRouteCanonicalDestinationCredit,
  type OwnedRouteCanonicalDestinationEvent,
} from "./owned-route-destination-observer.js";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const DEFAULT_RPC = {
  receipt: fetchEvmTransactionReceipt,
  blockNumber: fetchEvmBlockNumber,
  blockHash: fetchEvmBlockHash,
};

/** Read exact provider destination receipts, not an aggregate balance delta.
 * A different leg, expired quote, or competing route cannot hide a transfer
 * already made. The canonical allocator still decides ownership exactly once.
 */
export async function observeRelayErc20DestinationReceipts(
  input: Readonly<{
    asset: AssetRef;
    destinationAddress: string;
    transactionHashes: readonly string[];
    now: Date;
  }>,
  rpc = DEFAULT_RPC,
): Promise<readonly OwnedRouteCanonicalDestinationEvent[]> {
  const config = fundingSidecarRuntimeConfig;
  const network =
    input.asset.networkId === "evm:137"
      ? { rpcUrl: config.polygonRpcUrl, timeoutMs: config.polygonRpcTimeoutMs }
      : input.asset.networkId === "evm:8453"
        ? { rpcUrl: config.baseRpcUrl, timeoutMs: config.baseRpcTimeoutMs }
        : null;
  // Native and other-network routes retain their existing observers.
  if (!network || !ethers.isAddress(input.asset.assetId)) return [];
  const recipient = ethers.getAddress(input.destinationAddress).toLowerCase();
  const events: OwnedRouteCanonicalDestinationEvent[] = [];
  for (const transactionHash of new Set(input.transactionHashes)) {
    if (!/^0x[\da-f]{64}$/iu.test(transactionHash)) continue;
    const receipt = await rpc.receipt({
      ...network,
      transactionHash,
      maxAttempts: 1,
    });
    if (!receipt?.succeeded) continue;
    const [head, canonicalHash] = await Promise.all([
      rpc.blockNumber({ ...network, bypassCache: true }),
      rpc.blockHash({
        ...network,
        blockNumber: receipt.blockNumber,
        maxAttempts: 1,
      }),
    ]);
    // Same two-block threshold as the canonical EVM receive scanner.
    if (
      head < BigInt(receipt.blockNumber) + 1n ||
      canonicalHash !== receipt.blockHash
    )
      continue;
    for (const log of receipt.logs) {
      const sourceTopic = log.topics[1];
      const destinationTopic = log.topics[2];
      if (
        !sourceTopic ||
        !destinationTopic ||
        log.address.toLowerCase() !== input.asset.assetId.toLowerCase() ||
        log.topics.length !== 3 ||
        log.topics[0] !== TRANSFER_TOPIC ||
        log.logIndex == null ||
        !Number.isSafeInteger(log.logIndex) ||
        log.logIndex < 0 ||
        !/^0x[\da-f]{64}$/iu.test(log.data) ||
        !log.topics
          .slice(1)
          .every((topic) => /^0x0{24}[\da-f]{40}$/iu.test(topic))
      )
        continue;
      const destinationAddress = ethers.getAddress(
        `0x${destinationTopic.slice(-40)}`,
      );
      const rawAmount = BigInt(log.data);
      if (destinationAddress.toLowerCase() !== recipient || rawAmount <= 0n)
        continue;
      events.push({
        networkId: input.asset.networkId,
        asset: input.asset,
        destinationAddress,
        sourceAddress: ethers.getAddress(`0x${sourceTopic.slice(-40)}`),
        rawAmount: rawAmount.toString(),
        transactionHash,
        eventIndex: String(log.logIndex),
        ledgerHeight: String(receipt.blockNumber),
        blockHash: receipt.blockHash,
        observedAt: input.now,
      });
    }
  }
  return events;
}

export async function reconcileRelayDestinationReceipts(
  pool: Pool,
  input: Readonly<{
    operationId: string;
    segmentId: string;
    transactionHashes: readonly string[];
    now: Date;
    referenceCodec: Pick<RelayReferenceCodec, "fingerprint">;
  }>,
  observe = observeRelayErc20DestinationReceipts,
): Promise<void> {
  if (input.transactionHashes.length === 0) return;
  const { rows } = await pool.query<{
    user_id: string;
    destination_target_snapshot: unknown;
  }>(
    `select user_id, destination_target_snapshot from funding_operations
      where id = $1::uuid and plan_kind in ('wallet_route', 'composite_route')`,
    [input.operationId],
  );
  const row = rows[0];
  const target = row?.destination_target_snapshot;
  if (!row || !isRecord(target) || !isRecord(target.location)) return;
  const { asset, details } = target.location;
  if (
    !isRecord(asset) ||
    !isRecord(details) ||
    typeof asset.networkId !== "string" ||
    typeof asset.assetId !== "string" ||
    typeof asset.decimals !== "number" ||
    typeof details.address !== "string"
  )
    return;
  const events = await observe({
    asset: {
      networkId: asset.networkId,
      assetId: asset.assetId,
      decimals: asset.decimals,
    },
    destinationAddress: details.address,
    transactionHashes: input.transactionHashes,
    now: input.now,
  });
  if (events.length === 0) return;
  await tx(pool, async (client) => {
    const matches = await classifyOwnedRouteCanonicalDestinationEvents(client, {
      events,
      userId: row.user_id,
      referenceCodec: input.referenceCodec,
    });
    for (const event of events) {
      const match = matches.get(
        [event.networkId, event.transactionHash, event.eventIndex].join(":"),
      );
      if (
        match?.kind !== "internal" ||
        match.operationId !== input.operationId ||
        match.segmentId !== input.segmentId
      )
        continue;
      await recordOwnedRouteCanonicalDestinationCredit(client, {
        event,
        match,
        now: input.now,
      });
    }
  });
}
