import {
  fetchErc20TransferLogs,
  fetchEvmBlockNumber,
  parseEvmGetLogsBlockRangeLimit,
  type EvmErc20TransferLog,
} from "../../services/polygon-rpc.js";
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
  blockNumber: (network: EvmReceiveNetwork) => Promise<bigint>;
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
        block = rpc.blockNumber(network);
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
  const networks = new Map<string, Promise<bigint>>();
  let cursorAdvanced = false;
  const eventGroups: Array<{
    events: FundingReceiveCanonicalEvent[];
    variant: DirectIngressObservationVariant;
  } | null> = [];
  // Receive variants share provider capacity. Serial scans avoid turning one
  // worker pass into an RPC burst when a session accepts several assets.
  for (const variant of variants) {
    const network = receiveNetwork(variant.networkId);
    const cursor = eventCursorBlock(variant);
    if (!network || cursor == null) {
      eventGroups.push(null);
      continue;
    }
    let latest = networks.get(variant.networkId);
    if (!latest) {
      latest = rpc.blockNumber(network);
      networks.set(variant.networkId, latest);
    }
    const latestBlock = await latest;
    const safeHead =
      latestBlock >= EXTERNAL_INGRESS_CONFIRMATIONS - 1n
        ? latestBlock - (EXTERNAL_INGRESS_CONFIRMATIONS - 1n)
        : 0n;
    if (safeHead <= cursor) {
      eventGroups.push({
        events: [] as FundingReceiveCanonicalEvent[],
        variant,
      });
      continue;
    }
    const fromBlock = cursor + 1n;
    let maximumRange =
      learnedBlockRangeByRpcUrl.get(network.rpcUrl) ?? MAX_BLOCK_RANGE;
    let toBlock =
      safeHead < cursor + maximumRange ? safeHead : cursor + maximumRange;
    let logs: readonly EvmErc20TransferLog[];
    try {
      logs = await rpc.transferLogs({
        ...network,
        contractAddress: variant.asset.assetId,
        recipientAddress: variant.destinationAddress,
        fromBlock,
        toBlock,
      });
    } catch (error) {
      const providerLimit = parseEvmGetLogsBlockRangeLimit(error);
      if (providerLimit == null || toBlock <= fromBlock) throw error;
      maximumRange =
        providerLimit < MAX_BLOCK_RANGE ? providerLimit : MAX_BLOCK_RANGE;
      learnedBlockRangeByRpcUrl.set(network.rpcUrl, maximumRange);
      toBlock =
        safeHead < cursor + maximumRange ? safeHead : cursor + maximumRange;
      logs = await rpc.transferLogs({
        ...network,
        contractAddress: variant.asset.assetId,
        recipientAddress: variant.destinationAddress,
        fromBlock,
        toBlock,
      });
    }
    cursorAdvanced = true;
    eventGroups.push({
      events: logs
        .filter((log) => log.rawAmount > 0n)
        .map((log) => canonicalEvent(variant, log, now.toISOString())),
      variant: withEventCursor(variant, toBlock),
    });
  }
  if (eventGroups.some((group) => group == null)) return null;
  const groups = eventGroups.filter(
    (
      group,
    ): group is {
      events: FundingReceiveCanonicalEvent[];
      variant: DirectIngressObservationVariant;
    } => group != null,
  );
  return {
    events: groups.flatMap((group) => group.events),
    variants: groups.map((group) => group.variant),
    cursorAdvanced,
  };
}
