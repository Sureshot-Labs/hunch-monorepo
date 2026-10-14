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
import type { RelayStatusResponse } from "../../funding-providers/relay/schemas.js";
import {
  hypercoreLocationDex,
  isHypercoreFundingNetwork,
} from "../domain/hypercore-identity.js";
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

export type RelayDestinationReceiptRead = Readonly<{
  asset: AssetRef;
  destinationAddress: string;
  transactionHashes: readonly string[];
  now: Date;
  native?: Readonly<{
    requestId: string;
    status: RelayStatusResponse;
    dex: "spot" | "";
    knownTransactionHashes: readonly string[];
    ledgerAfterSecond?: number;
  }>;
}>;
export type RelayDestinationReceiptObserver = (
  input: RelayDestinationReceiptRead,
) => Promise<
  | readonly OwnedRouteCanonicalDestinationEvent[]
  | Readonly<{
      events: readonly OwnedRouteCanonicalDestinationEvent[];
      pendingReason: string | null;
      ledgerAfterSecond?: number;
    }>
>;

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
    requestId?: string;
    status?: RelayStatusResponse;
  }>,
  observe: RelayDestinationReceiptObserver = observeRelayErc20DestinationReceipts,
): Promise<void> {
  if (input.transactionHashes.length === 0) return;
  const { rows } = await pool.query<{
    user_id: string;
    destination_target_snapshot: unknown;
    segment_support_metadata: unknown;
  }>(
    `select operation_row.user_id, operation_row.destination_target_snapshot,
            segment_row.support_metadata as segment_support_metadata
       from funding_operations operation_row
       join funding_operation_segments segment_row
         on segment_row.operation_id=operation_row.id and segment_row.id=$2::uuid
        and segment_row.provider_id='relay'
      where operation_row.id=$1::uuid and operation_row.plan_kind in ('wallet_route', 'composite_route')`,
    [input.operationId, input.segmentId],
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
  let native: RelayDestinationReceiptRead["native"];
  if (isHypercoreFundingNetwork(asset.networkId)) {
    const dex = hypercoreLocationDex({
      kind: target.location.kind,
      asset: {
        networkId: asset.networkId,
        assetId: asset.assetId,
        decimals: asset.decimals,
      },
      details,
    });
    if (!input.requestId || !input.status || dex === null)
      throw new Error("native_destination_context_missing");
    const known = await pool.query<{ tx_hash: string }>(
      `select tx_hash from funding_observations where operation_id=$1 and segment_id=$2
        and network_id=$3 and kind='destination_credit' and canonical and finality_status='finalized'
        and tx_hash=any($4::text[])`,
      [
        input.operationId,
        input.segmentId,
        asset.networkId,
        input.transactionHashes.map((hash) => hash.toLowerCase()),
      ],
    );
    const receiptDiagnostics =
      isRecord(row.segment_support_metadata) &&
      isRecord(row.segment_support_metadata.nativeDestinationReceipts)
        ? row.segment_support_metadata.nativeDestinationReceipts
        : {};
    const prior =
      receiptDiagnostics[input.referenceCodec.fingerprint(input.requestId)];
    native = {
      requestId: input.requestId,
      status: input.status,
      dex,
      knownTransactionHashes: known.rows.map((row) => row.tx_hash),
      ...(isRecord(prior) &&
      Number.isSafeInteger(prior.ledgerAfterSecond) &&
      Number(prior.ledgerAfterSecond) >= 0
        ? { ledgerAfterSecond: Number(prior.ledgerAfterSecond) }
        : {}),
    };
  }
  const observation = await observe({
    asset: {
      networkId: asset.networkId,
      assetId: asset.assetId,
      decimals: asset.decimals,
    },
    destinationAddress: details.address,
    transactionHashes: input.transactionHashes,
    now: input.now,
    ...(native ? { native } : {}),
  });
  const events = "events" in observation ? observation.events : observation;
  if ("events" in observation && native) {
    await pool.query(
      `update funding_operation_segments set support_metadata=jsonb_set(support_metadata,
          '{nativeDestinationReceipts}',
          (case when jsonb_typeof(support_metadata->'nativeDestinationReceipts')='object'
            then support_metadata->'nativeDestinationReceipts' else '{}'::jsonb end)
          || jsonb_build_object($3::text,
            (case when jsonb_typeof(support_metadata->'nativeDestinationReceipts'->$3::text)='object'
              then support_metadata->'nativeDestinationReceipts'->$3::text else '{}'::jsonb end) || $4::jsonb), true)
        where operation_id=$1 and id=$2 and provider_id='relay'`,
      [
        input.operationId,
        input.segmentId,
        input.referenceCodec.fingerprint(native.requestId),
        {
          reason: observation.pendingReason,
          checkedAt: input.now.toISOString(),
          ...(observation.ledgerAfterSecond === undefined
            ? {}
            : {
                ledgerAfterSecond: observation.ledgerAfterSecond,
              }),
        },
      ],
    );
  }
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
