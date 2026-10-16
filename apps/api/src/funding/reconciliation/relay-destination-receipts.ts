import type { Pool } from "@hunch/infra";
import { fundingPhysicalEventIsBusy } from "../persistence/funding-physical-event-gate.js";
import { ethers } from "ethers";

import { isRecord } from "../../lib/type-guards.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmTransactionReceipt,
  type EvmRpcTransactionReceipt,
} from "../../services/polygon-rpc.js";
import type { AssetRef } from "../domain/types.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  commitFundingClassificationTransaction,
  FundingClassificationChangedError,
  lockFundingClassificationOperations,
  readFundingClassificationRevision,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  lockFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
} from "../persistence/funding-receive-session-repository.js";
import { loadCanonicalPolymarketHandoffClassifications } from "../receive/receive-handoff-classification.js";
import { refundCanonicalEventKey } from "./relay-exact-refund-classification.js";
import { supportsRefundSourceEnvelope } from "./relay-refund-source-candidates.js";
import { lockSessionlessFundingRoleMembershipForPublication } from "../receive/receive-refund-scan.js";
import type { FundingEvidenceWorkContext } from "./funding-reducer.js";
import {
  fundingEvidenceBudgetClient,
  FundingEvidenceBudgetExpiredError,
  setFundingEvidenceQueryBudget,
} from "./funding-evidence-budget.js";
import {
  readSessionlessRolePublicationPhase,
  checkpointSessionlessRolePublicationPhase,
} from "../receive/receive-role-publication-phase.js";
import { prepareReceiveAnchors } from "../receive/prepare-receive-anchors.js";
import type { inspectEvmFundingReceiveAnchor } from "../receive/evm-receive-anchor-proof.js";
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
    deadlineMs?: number;
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
  const events: OwnedRouteCanonicalDestinationEvent[] = [];
  for (const transactionHash of new Set(input.transactionHashes)) {
    if (!/^0x[\da-f]{64}$/iu.test(transactionHash)) continue;
    const remaining = () =>
      input.deadlineMs === undefined
        ? network.timeoutMs
        : Math.min(network.timeoutMs, Math.ceil(input.deadlineMs - Date.now()));
    if (remaining() <= 0) break;
    const receipt = await rpc.receipt({
      ...network,
      timeoutMs: remaining(),
      transactionHash,
      maxAttempts: 1,
    });
    if (!receipt?.succeeded) continue;
    if (remaining() <= 0) break;
    const [head, canonicalHash] = await Promise.all([
      rpc.blockNumber({
        ...network,
        timeoutMs: remaining(),
        bypassCache: true,
        ...(input.deadlineMs === undefined
          ? {}
          : { isolateBudget: true, maxAttempts: 1 }),
      }),
      rpc.blockHash({
        ...network,
        timeoutMs: remaining(),
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
    events.push(
      ...relayErc20ReceiptEvents({ ...input, transactionHash }, receipt),
    );
  }
  return events;
}

/** Decode exact transfer logs once for destination discovery and canonical watch.
 * Finality/canonical block checks belong to the caller, never to an empty list. */
export function relayErc20ReceiptEvents(
  input: {
    asset: AssetRef;
    destinationAddress: string;
    transactionHash: string;
    now: Date;
  },
  receipt: EvmRpcTransactionReceipt,
): readonly OwnedRouteCanonicalDestinationEvent[] {
  if (!receipt.succeeded) return [];
  const recipient = ethers.getAddress(input.destinationAddress).toLowerCase();
  const transactionHash = input.transactionHash;
  const events: OwnedRouteCanonicalDestinationEvent[] = [];
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
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
    requestId?: string;
    status?: RelayStatusResponse;
    /** Existing reconciliation lease and runtime page policy, not submission authority. */
    work?: FundingEvidenceWorkContext & Readonly<{ limit: number }>;
    /** Internal read-only verifier injection for deterministic fixtures. */
    inspectCanonicalAnchor?: typeof inspectEvmFundingReceiveAnchor;
  }>,
  observe: RelayDestinationReceiptObserver = observeRelayErc20DestinationReceipts,
): Promise<Readonly<{ roleScanPending: boolean; reason?: string }>> {
  const unchanged = { roleScanPending: false } as const;
  if (input.transactionHashes.length === 0) return unchanged;
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
  if (!row || !isRecord(target) || !isRecord(target.location)) return unchanged;
  const { asset, details } = target.location;
  if (
    !isRecord(asset) ||
    !isRecord(details) ||
    typeof asset.networkId !== "string" ||
    typeof asset.assetId !== "string" ||
    typeof asset.decimals !== "number" ||
    typeof details.address !== "string"
  )
    return unchanged;
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
  const events = (
    "events" in observation ? observation.events : observation
  ).map((event) =>
    event.networkId.startsWith("evm:")
      ? { ...event, transactionHash: event.transactionHash.toLowerCase() }
      : event,
  );
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
  if (events.length === 0) return unchanged;
  if (
    (await prepareReceiveAnchors(pool, {
      events: events.flatMap((event) =>
        event.networkId.startsWith("evm:") &&
        event.ledgerHeight !== null &&
        event.blockHash !== null
          ? [
              {
                ...event,
                ledgerHeight: event.ledgerHeight,
                blockHash: event.blockHash,
                now: input.now,
              },
            ]
          : [],
      ),
      deadlineMs: input.work?.deadlineMs,
      inspect: input.inspectCanonicalAnchor,
    })) !== "ready"
  )
    return { roleScanPending: true, reason: "role_canonical_anchor_pending" };
  let progressPages = 0;
  // Bounded local drain under the SAME existing job deadline. Each checkpoint
  // COMMITs before a fresh publication transaction. No provider IO is repeated.
  // Reuse the runtime batch policy for rows/page and pages/observation wave.
  publication: for (;;) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set transaction isolation level read committed");
      const budgeted = input.work
        ? fundingEvidenceBudgetClient(client, input.work.deadlineMs)
        : client;
      // Match receive/refund ordering: the ENTIRE physical footprint precedes O.
      // Native credits have no EVM canonical-event row; their existing exact
      // observation key remains authoritative. Do not fabricate a receive session.
      const evmEvents = events.flatMap((event) => {
        if (!event.networkId.startsWith("evm:")) return [];
        if (event.ledgerHeight === null || event.blockHash === null)
          throw new Error("relay_destination_canonical_proof_missing");
        return [{ ...event, now: input.now }];
      });
      await lockFundingReceiveCanonicalEvents(budgeted, evmEvents);
      // The E prelock has checked every repeated EVM envelope. Collapse aliases
      // only afterwards: duplicate SQL inputs otherwise look like two matching
      // routes. Native proof validation remains with its existing reader/writer.
      const evmKeys = new Set<string>();
      const publicationEvents = events.filter((event) => {
        if (!event.networkId.startsWith("evm:")) return true;
        const key = refundCanonicalEventKey(event);
        if (evmKeys.has(key)) return false;
        evmKeys.add(key);
        return true;
      });
      const facts = await readFundingClassificationRevision(budgeted, {
        operationId: input.operationId,
        userId: row.user_id,
      });
      if (!facts) throw new FundingClassificationChangedError();
      const dependencies: FundingClassificationRevision[] = [facts];
      const phase = await readSessionlessRolePublicationPhase(budgeted, {
        operationId: input.operationId,
        userId: row.user_id,
        events: publicationEvents,
        now: input.now,
        work: input.work,
        pageOrdinal: progressPages,
        referenceCodec: input.referenceCodec,
        transactionReferenceCodec: input.transactionReferenceCodec,
      });
      if (phase.kind !== "ready") {
        if (
          phase.kind === "pending" ||
          !input.work ||
          progressPages >= input.work.limit
        ) {
          await client.query("commit");
          return { roleScanPending: true, reason: phase.reason };
        }
        await checkpointSessionlessRolePublicationPhase(budgeted, phase);
        await client.query("commit");
        progressPages++;
        continue publication;
      }
      const jointInputs = phase.scans,
        jointDecisions = phase.decisions;
      dependencies.push(...phase.dependencies);
      const legacyEvents = publicationEvents.filter(
        (event) => !supportsRefundSourceEnvelope(event),
      );
      const matches = await classifyOwnedRouteCanonicalDestinationEvents(
        budgeted,
        {
          events: legacyEvents,
          userId: row.user_id,
          referenceCodec: input.referenceCodec,
        },
      );
      // Native/unsupported legacy readers keep their existing semantics. Their
      // effect owners still join the same sorted O lock set. Supported EVM roles
      // use all completed positive AND negative dependencies, never this fallback.
      const handoffs = await loadCanonicalPolymarketHandoffClassifications(
        budgeted,
        {
          userId: row.user_id,
          now: input.now,
          transactionReferenceCodec: input.transactionReferenceCodec,
          events: evmEvents
            .filter((event) => !supportsRefundSourceEnvelope(event))
            .map((event) => {
              if (event.sourceAddress === null)
                throw new Error("relay_destination_canonical_source_missing");
              return {
                ...event,
                sourceAddress: event.sourceAddress,
                variant: { networkId: event.networkId, asset: event.asset },
              };
            }),
        },
      );
      await lockFundingClassificationOperations(
        budgeted,
        dependencies,
        [...matches.values()].flatMap((match) =>
          match.kind === "internal"
            ? [{ operationId: match.operationId, userId: row.user_id }]
            : [],
        ),
      );
      for (const scan of jointInputs)
        await lockSessionlessFundingRoleMembershipForPublication(
          budgeted,
          scan,
        );
      for (const event of publicationEvents) {
        const eventIdentity = refundCanonicalEventKey(event);
        const decision = jointDecisions.get(eventIdentity);
        if (
          decision &&
          decision.kind !== "external" &&
          decision.kind !== "internal_destination"
        )
          throw new Error("relay_destination_internal_role_conflict");
        const match =
          decision?.kind === "internal_destination"
            ? decision.match
            : matches.get(eventIdentity);
        if (
          match?.kind !== "internal" ||
          match.operationId !== input.operationId ||
          match.segmentId !== input.segmentId
        )
          continue;
        if (
          !decision &&
          event.networkId.startsWith("evm:") &&
          handoffs.get(eventIdentity)?.kind !== "external"
        )
          throw new Error("relay_destination_internal_role_conflict");
        if (
          event.networkId.startsWith("evm:") &&
          event.ledgerHeight !== null &&
          event.blockHash !== null
        ) {
          const suppressed =
            await quarantineFundingReceiveCanonicalInternalEvent(budgeted, {
              ...event,
              ledgerHeight: event.ledgerHeight,
              blockHash: event.blockHash,
              reason: "internal_owned_route_destination_suppressed",
              now: input.now,
            });
          if (!suppressed)
            throw new Error("relay_destination_already_allocated");
        }
        await recordOwnedRouteCanonicalDestinationCredit(budgeted, {
          event,
          match,
          now: input.now,
        });
      }
      // Full positive/negative union. No SQL/provider IO between F and COMMIT.
      if (input.work)
        await setFundingEvidenceQueryBudget(client, input.work.deadlineMs);
      await commitFundingClassificationTransaction(client, dependencies);
      return unchanged;
    } catch (error) {
      await client.query("rollback");
      if (fundingPhysicalEventIsBusy(error))
        return { roleScanPending: true, reason: "role_physical_evidence_busy" };
      if (
        error instanceof FundingEvidenceBudgetExpiredError ||
        (input.work &&
          Date.now() >= input.work.deadlineMs &&
          isRecord(error) &&
          ["57014", "55P03"].includes(String(error.code)))
      )
        return { roleScanPending: true, reason: "role_work_budget_exhausted" };
      throw error;
    } finally {
      client.release();
    }
  }
}
