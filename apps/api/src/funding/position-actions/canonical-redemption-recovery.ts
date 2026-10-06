import type { Pool } from "@hunch/infra";
import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";
import { POLYMARKET_V2_ROUTER_ABI } from "../../services/polymarket-v2-redemption-plan.js";
import {
  polymarketV2RedemptionIdentity,
  POLYMARKET_V2_REDEMPTION_TOPIC,
} from "./polymarket-v2-redemption-evidence.js";
import { env } from "../../env.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  fetchEvmFinalizedBlockNumber,
  fetchEvmBlockHash,
  fetchEvmBlockTimestamp,
  fetchEvmEventLogs,
  fetchEvmTransactionReceipt,
  type EvmRpcTransactionReceipt,
} from "../../services/polygon-rpc.js";
import {
  canonicalRedemptionIdentity as identity,
  positionActionSubmissionStartSeconds,
  matchesCanonicalRedemption,
  CANONICAL_CTF_ABI as CTF,
  CANONICAL_CTF_PAYOUT_TOPIC as PAYOUT_TOPIC,
} from "./canonical-redemption-evidence.js";
export { matchesCanonicalRedemption } from "./canonical-redemption-evidence.js";
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
import {
  recordPositionActionSubmission,
  type StoredPositionAction,
} from "./position-action-repository.js";

export type RedemptionRecoveryRpc = {
  finalizedBlock(): Promise<bigint>;
  timestamp(block: bigint): Promise<bigint | null>;
  logs(
    from: bigint,
    to: bigint,
    ctf: string,
  ): ReturnType<typeof fetchEvmEventLogs>;
  receipt(hash: string): Promise<EvmRpcTransactionReceipt | null>;
  blockHash(block: number): Promise<string | null>;
};

async function lowerBlock(
  rpc: RedemptionRecoveryRpc,
  high: bigint,
  seconds: bigint,
): Promise<bigint | null> {
  let low = 0n;
  // Binary search is bounded by the chain height, not by the operation age.
  for (let calls = 0; low < high && calls < 64; calls++) {
    const middle = (low + high) / 2n;
    const time = await rpc.timestamp(middle);
    if (time === null) return null;
    if (time < seconds) low = middle + 1n;
    else high = middle;
  }
  return low === high ? low : null;
}

/** A missing/ambiguous scan returns unknown; it never authorizes another send. */
export async function discoverCanonicalRedemption(
  operation: StoredPositionAction,
  startedAt: Date,
  ctfAddress: string,
  rpc: RedemptionRecoveryRpc,
): Promise<string | null> {
  const v2Identity = polymarketV2RedemptionIdentity(operation);
  if (!v2Identity && !identity(operation, ctfAddress)) return null;
  const deadline = Date.now() + 18_000;
  const budgeted =
    <T extends unknown[], R>(read: (...args: T) => Promise<R>) =>
    async (...args: T): Promise<R> => {
      if (Date.now() >= deadline)
        throw new Error("Redemption evidence read budget exhausted");
      return read(...args);
    };
  rpc = {
    finalizedBlock: budgeted(rpc.finalizedBlock),
    timestamp: budgeted(rpc.timestamp),
    logs: budgeted(rpc.logs),
    receipt: budgeted(rpc.receipt),
    blockHash: budgeted(rpc.blockHash),
  };
  const finalized = await rpc.finalizedBlock();
  const start = positionActionSubmissionStartSeconds(operation, startedAt);
  if (start == null || start < 60n) return null;
  const from = await lowerBlock(rpc, finalized, start - 60n);
  const end = await lowerBlock(rpc, finalized, start + 10n * 60n);
  if (from === null || end === null || end < from || end - from > 5000n)
    return null;
  const candidates = new Set<string>();
  for (let cursor = from; cursor <= end; cursor += 200n) {
    const logs = await rpc.logs(
      cursor,
      cursor + 199n > end ? end : cursor + 199n,
      v2Identity ? POLYMARKET_PROTOCOL_CONTRACTS.router : ctfAddress,
    );
    for (const log of logs) {
      try {
        const parsed = (v2Identity ? POLYMARKET_V2_ROUTER_ABI : CTF).parseLog(
          log,
        );
        if (
          v2Identity
            ? parsed?.name === "RouterPositionRedeemed" &&
              eq(parsed.args.initiator, operation.ownerAddress) &&
              parsed.args.positionId === v2Identity.positionId
            : parsed?.name === "PayoutRedemption" &&
              eq(parsed.args.redeemer, operation.ownerAddress)
        )
          candidates.add(log.transactionHash);
      } catch {
        return null;
      }
    }
    if (candidates.size > 20) return null;
  }
  const matches: string[] = [];
  for (const hash of candidates) {
    const receipt = await rpc.receipt(hash);
    if (
      !receipt ||
      BigInt(receipt.blockNumber) < from ||
      BigInt(receipt.blockNumber) > end ||
      BigInt(receipt.blockNumber) > finalized
    )
      return null;
    if (!matchesCanonicalRedemption(operation, ctfAddress, receipt)) continue;
    const timestamp = await rpc.timestamp(BigInt(receipt.blockNumber));
    if (timestamp == null) return null;
    if (timestamp < start) continue;
    const canonicalHash = await rpc.blockHash(receipt.blockNumber);
    if (!canonicalHash || !eq(canonicalHash, receipt.blockHash)) return null;
    matches.push(hash);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function recoverMissingPositionSubmission(
  db: Pool,
  operation: StoredPositionAction,
  ctfAddress: string,
): Promise<StoredPositionAction> {
  if (
    operation.submissionFingerprint ||
    !operation.broadcastMayHaveOccurred ||
    operation.status !== "reconcile_required"
  )
    return operation;
  const plan = operation.planSnapshot.plan;
  if (!isRecord(plan)) return operation;
  const network =
    plan.chainId === 8453
      ? {
          rpcUrl: env.baseRpcUrl,
          timeoutMs: Math.min(env.baseRpcTimeoutMs, 4000),
          maxAttempts: 1,
        }
      : plan.chainId === 137
        ? {
            rpcUrl: env.polygonRpcUrl,
            timeoutMs: Math.min(env.polygonRpcTimeoutMs, 4000),
            maxAttempts: 1,
          }
        : null;
  if (!network) return operation;
  const attempts = await db.query<{ attempt_number: number; started_at: Date }>(
    `select attempt_number, started_at from position_action_attempts where action_operation_id = $1
      and outcome in ('started', 'ambiguous') and submission_fingerprint is null
      order by attempt_number desc limit 1`,
    [operation.id],
  );
  const attempt = attempts.rows[0];
  if (!attempt) return operation;
  const rpc: RedemptionRecoveryRpc = {
    finalizedBlock: () => fetchEvmFinalizedBlockNumber(network),
    timestamp: (blockNumber) =>
      fetchEvmBlockTimestamp({ ...network, blockNumber }),
    logs: (fromBlock, toBlock, contractAddress) =>
      fetchEvmEventLogs({
        ...network,
        fromBlock,
        toBlock,
        contractAddress,
        eventTopics: [
          polymarketV2RedemptionIdentity(operation)
            ? POLYMARKET_V2_REDEMPTION_TOPIC
            : PAYOUT_TOPIC,
        ],
      }),
    receipt: (transactionHash) =>
      fetchEvmTransactionReceipt({ ...network, transactionHash }),
    blockHash: (blockNumber) => fetchEvmBlockHash({ ...network, blockNumber }),
  };
  const hash = await discoverCanonicalRedemption(
    operation,
    attempt.started_at,
    ctfAddress,
    rpc,
  );
  if (!hash) return operation;
  // The submission journal serializes receipt attribution and fences late
  // browser reports. This recovery path never has execution authority.
  return recordPositionActionSubmission(db, {
    userId: operation.userId,
    operationId: operation.id,
    attemptNumber: attempt.attempt_number,
    outcome: "submitted",
    submissionFingerprint: hash,
    errorCode: null,
  });
}
