import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { isRecord } from "../../lib/type-guards.js";
import {
  fetchSolanaAddressSignatures,
  fetchSolanaBlockhash,
  fetchSolanaFinalizedSlot,
  fetchSolanaParsedTransaction,
  type SolanaAddressSignature,
} from "../../services/solana-rpc.js";
import type { JsonValue } from "../domain/types.js";
import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import type {
  FundingReceiveCanonicalEvent,
  FundingReceiveEventScanBatchEntry,
  FundingReceiveEventScanBatchResult,
  FundingReceiveEventScan,
} from "./evm-receive-event-scanner.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const SIGNATURE_PAGE_SIZE = 1_000;
const MAX_SIGNATURE_PAGES = 10;

type SolanaReceiveNetwork = Readonly<{
  rpcUrls: readonly string[];
  timeoutMs: number;
}>;

export type SolanaReceiveEventRpc = Readonly<{
  finalizedSlot: (
    network: SolanaReceiveNetwork & Readonly<{ bypassCache?: boolean }>,
  ) => Promise<bigint>;
  signatures: (
    input: SolanaReceiveNetwork &
      Readonly<{
        address: string;
        before?: string | null;
        until?: string | null;
        limit: number;
      }>,
  ) => Promise<readonly SolanaAddressSignature[]>;
  transaction: (
    input: SolanaReceiveNetwork & Readonly<{ signature: string }>,
  ) => Promise<unknown | null>;
  blockhash: (
    input: SolanaReceiveNetwork & Readonly<{ slot: bigint }>,
  ) => Promise<string | null>;
}>;

const DEFAULT_SOLANA_EVENT_RPC: SolanaReceiveEventRpc = {
  finalizedSlot: (network) =>
    fetchSolanaFinalizedSlot({
      ...network,
      rpcUrls: [...network.rpcUrls],
    }),
  signatures: (input) =>
    fetchSolanaAddressSignatures({
      ...input,
      rpcUrls: [...input.rpcUrls],
    }),
  transaction: (input) =>
    fetchSolanaParsedTransaction({
      ...input,
      rpcUrls: [...input.rpcUrls],
    }),
  blockhash: (input) =>
    fetchSolanaBlockhash({
      ...input,
      rpcUrls: [...input.rpcUrls],
    }),
};

export type SolanaFundingReceiveScanContext = Readonly<{
  transactionsBySignature: Map<string, Promise<unknown | null>>;
  blockhashesBySlot: Map<string, Promise<string | null>>;
}>;

export function createSolanaFundingReceiveScanContext(): SolanaFundingReceiveScanContext {
  return {
    transactionsBySignature: new Map(),
    blockhashesBySlot: new Map(),
  };
}

async function loadBatchValue<T>(
  store: Map<string, Promise<T | null>>,
  key: string,
  loader: () => Promise<T | null>,
): Promise<T | null> {
  const existing = store.get(key);
  if (existing) return existing;
  const pending = loader();
  store.set(key, pending);
  try {
    const value = await pending;
    if (value == null) store.delete(key);
    return value;
  } catch (error) {
    store.delete(key);
    throw error;
  }
}

function solanaNetwork(): SolanaReceiveNetwork {
  return {
    rpcUrls: fundingSidecarRuntimeConfig.solanaRpcUrls,
    timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
  };
}

function tokenAccount(variant: DirectIngressObservationVariant): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(variant.asset.assetId),
    new PublicKey(variant.destinationAddress),
    true,
    TOKEN_PROGRAM_ID,
  ).toBase58();
}

function isNativeSolVariant(variant: DirectIngressObservationVariant): boolean {
  return (
    variant.asset.assetId === SystemProgram.programId.toBase58() &&
    variant.asset.decimals === 9
  );
}

function observationAddress(variant: DirectIngressObservationVariant): string {
  return isNativeSolVariant(variant)
    ? variant.destinationAddress
    : tokenAccount(variant);
}

function cursorSlot(variant: DirectIngressObservationVariant): bigint | null {
  const raw = variant.observation.payload.eventCursorSlot;
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
}

function cursorSignature(
  variant: DirectIngressObservationVariant,
): string | null {
  const raw = variant.observation.payload.eventCursorSignature;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function withCursor(
  variant: DirectIngressObservationVariant,
  input: Readonly<{ slot: bigint; signature: string | null }>,
): DirectIngressObservationVariant {
  return {
    ...variant,
    observation: {
      ...variant.observation,
      payload: {
        ...variant.observation.payload,
        eventCursorSlot: input.slot.toString(),
        eventCursorSignature: input.signature,
        eventIdentity: "solana_transfer_v1",
        eventObservedAddress: observationAddress(variant),
      } as JsonRecord,
    },
  };
}

export async function initializeSolanaFundingReceiveEventCursors(
  variants: readonly DirectIngressObservationVariant[],
  rpc: SolanaReceiveEventRpc = DEFAULT_SOLANA_EVENT_RPC,
): Promise<readonly DirectIngressObservationVariant[]> {
  if (variants.some((variant) => variant.networkId !== "solana:mainnet")) {
    throw new Error("Solana receive scanner received a non-Solana variant");
  }
  const slot = await rpc.finalizedSlot({
    ...solanaNetwork(),
    bypassCache: true,
  });
  return variants.map((variant) =>
    withCursor(variant, { slot, signature: null }),
  );
}

type ParsedTransfer = Readonly<{
  eventIndex: string;
  sourceAddress: string;
  rawAmount: bigint;
}>;

function parseTransferInstruction(
  instruction: unknown,
  eventIndex: string,
  input: Readonly<{
    tokenAccount: string;
    mint: string;
    decimals: number;
  }>,
): ParsedTransfer | null {
  if (!isRecord(instruction)) return null;
  if (
    instruction.program !== "spl-token" &&
    instruction.program !== "spl-token-2022"
  ) {
    return null;
  }
  const parsed = instruction.parsed;
  if (!isRecord(parsed)) return null;
  if (parsed.type !== "transfer" && parsed.type !== "transferChecked") {
    return null;
  }
  const info = parsed.info;
  if (!isRecord(info)) return null;
  if (info.destination !== input.tokenAccount) return null;
  const source = info.source;
  if (typeof source !== "string" || source.trim().length === 0) return null;
  if (
    typeof info.mint === "string" &&
    info.mint.trim().length > 0 &&
    info.mint !== input.mint
  ) {
    return null;
  }
  const tokenAmount = isRecord(info.tokenAmount) ? info.tokenAmount : null;
  const amountRaw =
    typeof info.amount === "string"
      ? info.amount
      : typeof tokenAmount?.amount === "string"
        ? tokenAmount.amount
        : null;
  if (!amountRaw || !/^[0-9]+$/.test(amountRaw)) return null;
  if (
    typeof tokenAmount?.decimals === "number" &&
    Math.trunc(tokenAmount.decimals) !== input.decimals
  ) {
    return null;
  }
  const rawAmount = BigInt(amountRaw);
  return rawAmount > 0n
    ? { eventIndex, sourceAddress: source, rawAmount }
    : null;
}

function parseNativeTransferInstruction(
  instruction: unknown,
  eventIndex: string,
  destinationAddress: string,
): ParsedTransfer | null {
  if (!isRecord(instruction) || instruction.program !== "system") return null;
  const parsed = instruction.parsed;
  if (!isRecord(parsed) || parsed.type !== "transfer") return null;
  const info = parsed.info;
  if (!isRecord(info) || info.destination !== destinationAddress) return null;
  const source = info.source;
  if (typeof source !== "string" || source.trim().length === 0) return null;
  const lamports =
    typeof info.lamports === "string"
      ? info.lamports
      : typeof info.lamports === "number" &&
          Number.isSafeInteger(info.lamports) &&
          info.lamports >= 0
        ? info.lamports.toString()
        : null;
  if (!lamports || !/^[0-9]+$/.test(lamports)) return null;
  const rawAmount = BigInt(lamports);
  return rawAmount > 0n
    ? { eventIndex, sourceAddress: source, rawAmount }
    : null;
}

function parseVariantTransferInstruction(
  instruction: unknown,
  eventIndex: string,
  input: Readonly<{
    variant: DirectIngressObservationVariant;
    tokenInput: Readonly<{
      tokenAccount: string;
      mint: string;
      decimals: number;
    }> | null;
  }>,
): ParsedTransfer | null {
  return input.tokenInput
    ? parseTransferInstruction(instruction, eventIndex, input.tokenInput)
    : parseNativeTransferInstruction(
        instruction,
        eventIndex,
        input.variant.destinationAddress,
      );
}

function parseTransactionTransfers(
  transaction: unknown,
  input: Readonly<{
    variant: DirectIngressObservationVariant;
  }>,
): readonly ParsedTransfer[] | null {
  if (!isRecord(transaction)) return null;
  const transactionValue = transaction.transaction;
  const meta = transaction.meta;
  if (!isRecord(transactionValue) || !isRecord(meta) || meta.err != null) {
    return null;
  }
  const message = transactionValue.message;
  if (!isRecord(message) || !Array.isArray(message.instructions)) return null;
  const transfers: ParsedTransfer[] = [];
  const native = isNativeSolVariant(input.variant);
  const tokenInput = native
    ? null
    : {
        tokenAccount: tokenAccount(input.variant),
        mint: input.variant.asset.assetId,
        decimals: input.variant.asset.decimals,
      };
  message.instructions.forEach((instruction, index) => {
    const eventIndex = `outer:${index}`;
    const parsed = parseVariantTransferInstruction(instruction, eventIndex, {
      variant: input.variant,
      tokenInput,
    });
    if (parsed) transfers.push(parsed);
  });
  if (Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      if (!isRecord(group) || !Array.isArray(group.instructions)) continue;
      const outerIndex =
        typeof group.index === "number" && Number.isSafeInteger(group.index)
          ? group.index
          : null;
      if (outerIndex == null) continue;
      group.instructions.forEach((instruction, index) => {
        const eventIndex = `inner:${outerIndex}:${index}`;
        const parsed = parseVariantTransferInstruction(
          instruction,
          eventIndex,
          {
            variant: input.variant,
            tokenInput,
          },
        );
        if (parsed) transfers.push(parsed);
      });
    }
  }
  return transfers;
}

async function listNewSignatures(
  variant: DirectIngressObservationVariant,
  rpc: SolanaReceiveEventRpc,
): Promise<readonly SolanaAddressSignature[]> {
  const network = solanaNetwork();
  const baselineSlot = cursorSlot(variant);
  if (baselineSlot == null) {
    throw new Error("Solana receive cursor is missing");
  }
  const until = cursorSignature(variant);
  const address = observationAddress(variant);
  const signatures: SolanaAddressSignature[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const entries = await rpc.signatures({
      ...network,
      address,
      before,
      until,
      limit: SIGNATURE_PAGE_SIZE,
    });
    const newer = entries.filter((entry) => entry.slot > baselineSlot);
    signatures.push(...newer);
    if (
      entries.length < SIGNATURE_PAGE_SIZE ||
      entries.some((entry) => entry.slot <= baselineSlot)
    ) {
      return signatures;
    }
    const last = entries.at(-1);
    if (!last) return signatures;
    before = last.signature;
  }
  throw new Error("Solana receive signature scan exceeded its safe page bound");
}

export async function scanSolanaFundingReceiveCanonicalEvents(
  variants: readonly DirectIngressObservationVariant[],
  now = new Date(),
  rpc: SolanaReceiveEventRpc = DEFAULT_SOLANA_EVENT_RPC,
  context = createSolanaFundingReceiveScanContext(),
): Promise<FundingReceiveEventScan | null> {
  if (variants.length === 0) return null;
  const result = await scanSolanaFundingReceiveCanonicalEventBatch(
    [{ key: "single", variants }],
    now,
    rpc,
    context,
  );
  if (result.failedKeys.has("single")) {
    throw (
      result.errors.get("single") ??
      new Error("Solana receive-event scan failed")
    );
  }
  return result.scans.get("single") ?? null;
}

type SolanaBatchItem = Readonly<{
  entryKey: string;
  variant: DirectIngressObservationVariant;
  cursor: bigint;
}>;

function physicalRouteKey(variant: DirectIngressObservationVariant): string {
  return JSON.stringify([
    variant.networkId,
    variant.asset.assetId,
    variant.asset.decimals,
    variant.destinationAddress,
  ]);
}

export async function scanSolanaFundingReceiveCanonicalEventBatch(
  entries: readonly FundingReceiveEventScanBatchEntry[],
  now = new Date(),
  rpc: SolanaReceiveEventRpc = DEFAULT_SOLANA_EVENT_RPC,
  context = createSolanaFundingReceiveScanContext(),
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
  const routeItems = new Map<string, SolanaBatchItem[]>();
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
      const cursor = cursorSlot(variant);
      if (variant.networkId !== "solana:mainnet" || cursor == null) {
        state.invalid = true;
        continue;
      }
      const key = physicalRouteKey(variant);
      const items = routeItems.get(key) ?? [];
      items.push({ entryKey: entry.key, variant, cursor });
      routeItems.set(key, items);
    }
  }

  const failedKeys = new Set<string>();
  const errors = new Map<string, unknown>();
  const network = solanaNetwork();
  // Routes remain serial. Within one route, the oldest cursor produces a
  // superset that is filtered independently for every receive session.
  for (const items of routeItems.values()) {
    const activeItems = items.filter((item) => !failedKeys.has(item.entryKey));
    const ordered = [...activeItems].sort((left, right) =>
      left.cursor < right.cursor ? -1 : left.cursor > right.cursor ? 1 : 0,
    );
    const first = ordered[0];
    if (!first) continue;
    try {
      const signatures = await listNewSignatures(first.variant, rpc);
      const decoded = new Map<
        string,
        Readonly<{
          signature: SolanaAddressSignature;
          transfers: readonly ParsedTransfer[];
          blockhash: string;
        }>
      >();
      for (const signature of [...signatures].reverse()) {
        if (signature.failed) continue;
        const interestedItems = activeItems.filter(
          (item) => signature.slot > item.cursor,
        );
        if (interestedItems.length === 0) continue;
        const failInterestedItems = (error: Error) => {
          for (const item of interestedItems) {
            failedKeys.add(item.entryKey);
            if (!errors.has(item.entryKey)) {
              errors.set(item.entryKey, error);
            }
          }
        };
        const transaction = await loadBatchValue(
          context.transactionsBySignature,
          signature.signature,
          () => rpc.transaction({ ...network, signature: signature.signature }),
        );
        if (transaction == null) {
          failInterestedItems(
            new Error(
              `Solana finalized transaction ${signature.signature} is unavailable`,
            ),
          );
          continue;
        }
        const transfers = parseTransactionTransfers(transaction, {
          variant: first.variant,
        });
        if (transfers == null) {
          failInterestedItems(
            new Error(
              `Solana finalized transaction ${signature.signature} is malformed`,
            ),
          );
          continue;
        }
        const blockhash = await loadBatchValue(
          context.blockhashesBySlot,
          signature.slot.toString(),
          () => rpc.blockhash({ ...network, slot: signature.slot }),
        );
        if (!blockhash) {
          failInterestedItems(
            new Error(
              `Solana finalized block ${signature.slot.toString()} is unavailable`,
            ),
          );
          continue;
        }
        decoded.set(signature.signature, { signature, transfers, blockhash });
      }

      for (const item of activeItems) {
        if (failedKeys.has(item.entryKey)) continue;
        const state = entryStates.get(item.entryKey);
        if (!state) continue;
        const relevant = signatures.filter(
          (signature) => signature.slot > item.cursor,
        );
        const newest = relevant[0];
        if (!newest) continue;
        state.cursorAdvanced = true;
        state.nextVariants.set(
          item.variant.variantId,
          withCursor(item.variant, {
            slot: newest.slot,
            signature: newest.signature,
          }),
        );
        for (const signature of [...relevant].reverse()) {
          const resolved = decoded.get(signature.signature);
          if (!resolved) continue;
          for (const transfer of resolved.transfers) {
            state.events.push({
              variant: item.variant,
              transactionHash: resolved.signature.signature,
              eventIndex: transfer.eventIndex,
              blockNumber: resolved.signature.slot.toString(),
              blockHash: resolved.blockhash,
              sourceAddress: transfer.sourceAddress,
              destinationAddress: item.variant.destinationAddress,
              rawAmount: transfer.rawAmount.toString(),
              observedAt:
                resolved.signature.blockTime == null
                  ? now.toISOString()
                  : new Date(
                      resolved.signature.blockTime * 1_000,
                    ).toISOString(),
            });
          }
        }
      }
    } catch (error) {
      for (const item of activeItems) {
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
