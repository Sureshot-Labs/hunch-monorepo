import { ethers } from "ethers";
import {
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmEventLogs,
  parseEvmGetLogsBlockRangeLimit,
} from "../../services/polygon-rpc.js";
import type { JsonValue } from "../domain/types.js";

const SAFE_EXECUTION_EVENTS = new ethers.Interface([
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);
const SAFE_EVENT_TOPICS = [
  "ExecutionSuccess(bytes32,uint256)",
  "ExecutionFailure(bytes32,uint256)",
].map((name) => ethers.id(name));
const SCAN_BLOCKS = 64n;

export function safeFundingExecutionOutcome(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  safe: string,
  safeTransactionHash: string,
): "success" | "failure" | null {
  const outcomes = logs.flatMap((log) => {
    if (log.address.toLowerCase() !== safe.toLowerCase()) return [];
    try {
      const decoded = SAFE_EXECUTION_EVENTS.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (
        String(decoded?.args.txHash).toLowerCase() !==
        safeTransactionHash.toLowerCase()
      )
        return [];
      return decoded?.name === "ExecutionSuccess"
        ? ["success" as const]
        : decoded?.name === "ExecutionFailure"
          ? ["failure" as const]
          : [];
    } catch {
      return [];
    }
  });
  return outcomes.length === 1 ? (outcomes[0] ?? null) : null;
}

type Scanner = Readonly<{
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchBlockTimestamp: typeof fetchEvmBlockTimestamp;
  fetchLogs: typeof fetchEvmEventLogs;
}>;
const defaultScanner: Scanner = {
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchBlockTimestamp: fetchEvmBlockTimestamp,
  fetchLogs: fetchEvmEventLogs,
};

/** Exact Safe hash, no attribution deadline and never an absence-based failure.
 * Each poll reads at most three bounded windows: tip, history, and forward gap.
 * The contiguous history/gap cursor never follows a disconnected moving tip. */
export async function findSafeFundingExecution(
  input: {
    safe: string;
    safeTransactionHash: string;
    attemptStartedAt: Date;
    previousEvidence?: Readonly<Record<string, JsonValue>> | null;
    rpcUrl: string;
    timeoutMs: number;
  },
  scanner: Scanner = defaultScanner,
): Promise<{
  transactionHash: string | null;
  conflictingTransactions: boolean;
  evidence: Record<string, JsonValue>;
}> {
  const deadline = Date.now() + Math.min(input.timeoutMs, 2_000);
  const rpc = () => ({
    rpcUrl: input.rpcUrl,
    maxAttempts: 1,
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
  const latest = await scanner.fetchBlockNumber({
    ...rpc(),
    bypassCache: true,
  });
  const tipFrom = latest >= SCAN_BLOCKS ? latest - SCAN_BLOCKS + 1n : 0n;
  const parseCursor = (value: JsonValue | undefined) =>
    typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
  const priorOldest = parseCursor(
    input.previousEvidence?.safeExecutionScanOldestBlock,
  );
  const priorNewest = parseCursor(
    input.previousEvidence?.safeExecutionScanNewestBlock,
  );
  const hasHistory =
    priorOldest !== null &&
    priorNewest !== null &&
    priorOldest <= priorNewest &&
    priorNewest <= latest;
  const historyComplete =
    hasHistory &&
    input.previousEvidence?.safeExecutionScanHistoryCovered === true;
  let oldest = hasHistory ? priorOldest : null;
  let newest = hasHistory ? priorNewest : null;
  const candidates = new Set<string>();
  const scanRange = async (
    range: { from: bigint; to: bigint },
    direction: "backward" | "forward",
  ) => {
    const read = (fromBlock: bigint, toBlock: bigint) =>
      scanner.fetchLogs({
        ...rpc(),
        contractAddress: input.safe,
        eventTopics: SAFE_EVENT_TOPICS,
        fromBlock,
        toBlock,
      });
    let scannedFrom = range.from;
    let scannedTo = range.to;
    let logs;
    try {
      logs = await read(range.from, range.to);
    } catch (error) {
      const cap = parseEvmGetLogsBlockRangeLimit(error);
      if (cap === null || cap >= range.to - range.from + 1n) throw error;
      // Keep the edge adjacent to the durable cursor, never skip an unqueried
      // gap when the provider lowers its block cap.
      if (direction === "backward") scannedFrom = range.to - cap + 1n;
      else scannedTo = range.from + cap - 1n;
      logs = await read(scannedFrom, scannedTo);
    }
    for (const log of logs) {
      if (log.blockNumber < scannedFrom || log.blockNumber > scannedTo)
        continue;
      if (
        safeFundingExecutionOutcome(
          [log],
          input.safe,
          input.safeTransactionHash,
        ) &&
        /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)
      )
        candidates.add(log.transactionHash.toLowerCase());
    }
    return { from: scannedFrom, to: scannedTo };
  };
  const head = await scanRange({ from: tipFrom, to: latest }, "backward");
  if (oldest === null || newest === null) {
    oldest = head.from;
    newest = head.to;
  } else if (head.from <= newest + 1n && head.to >= oldest - 1n) {
    oldest = oldest < head.from ? oldest : head.from;
    newest = newest > head.to ? newest : head.to;
  }
  if (!historyComplete && oldest > 0n) {
    const history = await scanRange(
      {
        from: oldest >= SCAN_BLOCKS ? oldest - SCAN_BLOCKS : 0n,
        to: oldest - 1n,
      },
      "backward",
    );
    oldest = history.from;
  }
  if (newest < latest) {
    const gap = await scanRange(
      {
        from: newest + 1n,
        to: newest + SCAN_BLOCKS < latest ? newest + SCAN_BLOCKS : latest,
      },
      "forward",
    );
    newest = gap.to;
    // The tip scan can close the remaining gap only after continuity is proven.
    if (head.from <= newest + 1n) newest = latest;
  }
  const timestamp = await scanner.fetchBlockTimestamp({
    ...rpc(),
    blockNumber: oldest,
  });
  // The exact signed hash supplies identity; include the attempt's whole second.
  const covered =
    historyComplete ||
    oldest === 0n ||
    (timestamp !== null &&
      timestamp * 1000n <=
        BigInt(Math.floor(input.attemptStartedAt.getTime() / 1000) * 1000));
  return {
    transactionHash:
      candidates.size === 1 ? ([...candidates][0] ?? null) : null,
    conflictingTransactions: candidates.size > 1,
    evidence: {
      safeExecutionScanOldestBlock: oldest.toString(),
      safeExecutionScanNewestBlock: newest.toString(),
      safeExecutionScanLatestBlock: latest.toString(),
      safeExecutionScanHistoryCovered: covered,
      safeExecutionObserved: candidates.size > 0,
    },
  };
}
