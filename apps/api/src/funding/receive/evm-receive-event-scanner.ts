import {
  fetchErc20TransferLogs,
  fetchEvmBlockNumber,
  parseEvmGetLogsBlockRangeLimit,
  type EvmErc20TransferLog,
} from "../../services/polygon-rpc.js";
import {
  canonicalAccountAddress,
  canonicalAssetKey,
} from "../domain/asset-identity.js";
import type { JsonValue } from "../domain/types.js";
import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import { canonicalFundingReceiveObserverId } from "./canonical-receive-capabilities.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const EXTERNAL_INGRESS_CONFIRMATIONS = 2n;
const MAX_BLOCK_RANGE = 2_000n;
const learnedBlockRangeByRpcUrl = new Map<string, bigint>();

type EvmReceiveNetwork = Readonly<{
  rpcUrl: string;
  timeoutMs: number;
}>;

export type FundingReceiveEventRpc = Readonly<{
  blockNumber: (
    network: EvmReceiveNetwork & Readonly<{ bypassCache?: boolean }>,
  ) => Promise<bigint>;
  transferLogs: (
    input: EvmReceiveNetwork &
      Readonly<{
        contractAddress: string;
        recipientAddress: string;
        fromBlock: bigint;
        toBlock: bigint;
      }>,
  ) => Promise<readonly EvmErc20TransferLog[]>;
}>;

const DEFAULT_EVENT_RPC: FundingReceiveEventRpc = {
  blockNumber: fetchEvmBlockNumber,
  transferLogs: fetchErc20TransferLogs,
};

function receiveNetwork(networkId: string): EvmReceiveNetwork | null {
  if (
    canonicalFundingReceiveObserverId(networkId) !== "evm_erc20_transfer_v1"
  ) {
    return null;
  }
  if (networkId === "evm:137") {
    return {
      rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
      timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
    };
  }
  if (networkId === "evm:8453") {
    return {
      rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
      timeoutMs: fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
    };
  }
  // A registered EVM network without runtime configuration stays fail-closed.
  return null;
}

function eventCursorBlock(
  variant: DirectIngressObservationVariant,
): bigint | null {
  const raw = variant.observation.payload.eventCursorBlock;
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
}

function withEventCursor(
  variant: DirectIngressObservationVariant,
  blockNumber: bigint,
): DirectIngressObservationVariant {
  return {
    ...variant,
    observation: {
      ...variant.observation,
      payload: {
        ...variant.observation.payload,
        eventCursorBlock: blockNumber.toString(),
        eventConfirmations: Number(EXTERNAL_INGRESS_CONFIRMATIONS),
        eventIdentity: "evm_erc20_transfer_v1",
      } as JsonRecord,
    },
  };
}

export async function initializeFundingReceiveEventCursors(
  variants: readonly DirectIngressObservationVariant[],
  rpc: FundingReceiveEventRpc = DEFAULT_EVENT_RPC,
): Promise<readonly DirectIngressObservationVariant[]> {
  const byNetwork = new Map<string, Promise<bigint>>();
  return Promise.all(
    variants.map(async (variant) => {
      const network = receiveNetwork(variant.networkId);
      if (!network) {
        throw new Error(
          `canonical receive-event scanner is unavailable for ${variant.networkId}`,
        );
      }
      let block = byNetwork.get(variant.networkId);
      if (!block) {
        block = rpc.blockNumber({ ...network, bypassCache: true });
        byNetwork.set(variant.networkId, block);
      }
      return withEventCursor(variant, await block);
    }),
  );
}

export type FundingReceiveCanonicalEvent = Readonly<{
  variant: DirectIngressObservationVariant;
  transactionHash: string;
  eventIndex: string;
  blockNumber: string;
  blockHash: string;
  sourceAddress: string;
  destinationAddress: string;
  rawAmount: string;
  observedAt: string;
}>;

export type FundingReceiveEventScan = Readonly<{
  events: readonly FundingReceiveCanonicalEvent[];
  variants: readonly DirectIngressObservationVariant[];
  cursorAdvanced: boolean;
}>;

export type FundingReceiveEventScanBatchEntry = Readonly<{
  key: string;
  variants: readonly DirectIngressObservationVariant[];
}>;

export type FundingReceiveEventScanBatchResult = Readonly<{
  scans: ReadonlyMap<string, FundingReceiveEventScan | null>;
  failedKeys: ReadonlySet<string>;
  errors: ReadonlyMap<string, unknown>;
}>;

function canonicalEvent(
  variant: DirectIngressObservationVariant,
  log: EvmErc20TransferLog,
  observedAt: string,
): FundingReceiveCanonicalEvent {
  return {
    variant,
    transactionHash: log.transactionHash,
    eventIndex: log.logIndex.toString(),
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash,
    sourceAddress: log.fromAddress,
    destinationAddress: log.toAddress,
    rawAmount: log.rawAmount.toString(),
    observedAt,
  };
}

export async function scanFundingReceiveCanonicalEvents(
  variants: readonly DirectIngressObservationVariant[],
  now = new Date(),
  rpc: FundingReceiveEventRpc = DEFAULT_EVENT_RPC,
): Promise<FundingReceiveEventScan | null> {
  if (variants.length === 0) return null;
  const result = await scanFundingReceiveCanonicalEventBatch(
    [{ key: "single", variants }],
    now,
    rpc,
  );
  if (result.failedKeys.has("single")) {
    throw (
      result.errors.get("single") ?? new Error("EVM receive-event scan failed")
    );
  }
  return result.scans.get("single") ?? null;
}

type EvmBatchItem = Readonly<{
  entryKey: string;
  variant: DirectIngressObservationVariant;
  network: EvmReceiveNetwork;
  cursor: bigint;
}>;

type BlockRange = Readonly<{ fromBlock: bigint; toBlock: bigint }>;

function physicalRouteKey(variant: DirectIngressObservationVariant): string {
  return JSON.stringify([
    variant.networkId,
    canonicalAssetKey(variant.asset),
    canonicalAccountAddress(variant.networkId, variant.destinationAddress),
  ]);
}

function mergeBlockRanges(ranges: readonly BlockRange[]): BlockRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.fromBlock < right.fromBlock
      ? -1
      : left.fromBlock > right.fromBlock
        ? 1
        : 0,
  );
  const merged: BlockRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.fromBlock > previous.toBlock + 1n) {
      merged.push(range);
      continue;
    }
    if (range.toBlock > previous.toBlock) {
      merged[merged.length - 1] = {
        fromBlock: previous.fromBlock,
        toBlock: range.toBlock,
      };
    }
  }
  return merged;
}

async function transferLogsForRange(
  rpc: FundingReceiveEventRpc,
  input: EvmReceiveNetwork &
    Readonly<{
      contractAddress: string;
      recipientAddress: string;
      fromBlock: bigint;
      toBlock: bigint;
      maximumRange: bigint;
    }>,
): Promise<readonly EvmErc20TransferLog[]> {
  const logs: EvmErc20TransferLog[] = [];
  for (
    let fromBlock = input.fromBlock;
    fromBlock <= input.toBlock;
    fromBlock += input.maximumRange
  ) {
    const toBlock =
      fromBlock + input.maximumRange - 1n < input.toBlock
        ? fromBlock + input.maximumRange - 1n
        : input.toBlock;
    logs.push(
      ...(await rpc.transferLogs({
        rpcUrl: input.rpcUrl,
        timeoutMs: input.timeoutMs,
        contractAddress: input.contractAddress,
        recipientAddress: input.recipientAddress,
        fromBlock,
        toBlock,
      })),
    );
  }
  return logs;
}

export async function scanFundingReceiveCanonicalEventBatch(
  entries: readonly FundingReceiveEventScanBatchEntry[],
  now = new Date(),
  rpc: FundingReceiveEventRpc = DEFAULT_EVENT_RPC,
): Promise<FundingReceiveEventScanBatchResult> {
  const entryStates = new Map<
    string,
    {
      originalVariants: readonly DirectIngressObservationVariant[];
      nextVariants: Map<string, DirectIngressObservationVariant>;
      events: FundingReceiveCanonicalEvent[];
      cursorAdvanced: boolean;
      invalid: boolean;
    }
  >();
  const routeItems = new Map<string, EvmBatchItem[]>();
  for (const entry of entries) {
    const state = {
      originalVariants: entry.variants,
      nextVariants: new Map<string, DirectIngressObservationVariant>(),
      events: [] as FundingReceiveCanonicalEvent[],
      cursorAdvanced: false,
      invalid: false,
    };
    entryStates.set(entry.key, state);
    for (const variant of entry.variants) {
      const network = receiveNetwork(variant.networkId);
      const cursor = eventCursorBlock(variant);
      if (!network || cursor == null) {
        state.invalid = true;
        continue;
      }
      const routeKey = physicalRouteKey(variant);
      const items = routeItems.get(routeKey) ?? [];
      items.push({ entryKey: entry.key, variant, network, cursor });
      routeItems.set(routeKey, items);
    }
  }

  const headsByNetwork = new Map<string, Promise<bigint>>();
  const failedKeys = new Set<string>();
  const errors = new Map<string, unknown>();
  // Routes remain serial. Deduplication reduces request count without turning
  // a worker pass into a new provider burst.
  for (const items of routeItems.values()) {
    const first = items[0];
    if (!first) continue;
    try {
      let head = headsByNetwork.get(first.variant.networkId);
      if (!head) {
        head = rpc.blockNumber(first.network);
        headsByNetwork.set(first.variant.networkId, head);
      }
      const latestBlock = await head;
      const safeHead =
        latestBlock >= EXTERNAL_INGRESS_CONFIRMATIONS - 1n
          ? latestBlock - (EXTERNAL_INGRESS_CONFIRMATIONS - 1n)
          : 0n;
      let maximumRange =
        learnedBlockRangeByRpcUrl.get(first.network.rpcUrl) ?? MAX_BLOCK_RANGE;
      let logs: EvmErc20TransferLog[] | null = null;
      for (let rangeAttempt = 0; rangeAttempt < 2; rangeAttempt += 1) {
        const intervals = items.flatMap((item) => {
          if (safeHead <= item.cursor) return [];
          return [
            {
              fromBlock: item.cursor + 1n,
              toBlock:
                safeHead < item.cursor + maximumRange
                  ? safeHead
                  : item.cursor + maximumRange,
            },
          ];
        });
        try {
          const routeLogs: EvmErc20TransferLog[] = [];
          for (const range of mergeBlockRanges(intervals)) {
            routeLogs.push(
              ...(await transferLogsForRange(rpc, {
                ...first.network,
                contractAddress: first.variant.asset.assetId,
                recipientAddress: first.variant.destinationAddress,
                maximumRange,
                ...range,
              })),
            );
          }
          logs = routeLogs;
          break;
        } catch (error) {
          const providerLimit = parseEvmGetLogsBlockRangeLimit(error);
          if (
            providerLimit == null ||
            providerLimit <= 0n ||
            providerLimit >= maximumRange ||
            rangeAttempt > 0
          ) {
            throw error;
          }
          maximumRange = providerLimit;
          learnedBlockRangeByRpcUrl.set(first.network.rpcUrl, providerLimit);
        }
      }
      if (!logs) throw new Error("EVM receive-event range scan failed");
      const observedAt = now.toISOString();
      for (const item of items) {
        const state = entryStates.get(item.entryKey);
        if (!state || safeHead <= item.cursor) continue;
        const toBlock =
          safeHead < item.cursor + maximumRange
            ? safeHead
            : item.cursor + maximumRange;
        state.cursorAdvanced = true;
        state.nextVariants.set(
          item.variant.variantId,
          withEventCursor(item.variant, toBlock),
        );
        state.events.push(
          ...logs
            .filter(
              (log) =>
                log.rawAmount > 0n &&
                log.blockNumber > item.cursor &&
                log.blockNumber <= toBlock,
            )
            .map((log) => canonicalEvent(item.variant, log, observedAt)),
        );
      }
    } catch (error) {
      for (const item of items) {
        failedKeys.add(item.entryKey);
        errors.set(item.entryKey, error);
      }
    }
  }

  const scans = new Map<string, FundingReceiveEventScan | null>();
  for (const [entryKey, state] of entryStates) {
    if (failedKeys.has(entryKey)) continue;
    if (state.invalid) {
      scans.set(entryKey, null);
      continue;
    }
    scans.set(entryKey, {
      events: state.events,
      variants: state.originalVariants.map(
        (variant) => state.nextVariants.get(variant.variantId) ?? variant,
      ),
      cursorAdvanced: state.cursorAdvanced,
    });
  }
  return { scans, failedKeys, errors };
}
