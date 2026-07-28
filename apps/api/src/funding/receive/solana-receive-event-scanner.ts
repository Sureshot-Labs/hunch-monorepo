import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { env } from "../../env.js";
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
  FundingReceiveEventScan,
} from "./evm-receive-event-scanner.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const SIGNATURE_PAGE_SIZE = 1_000;
const MAX_SIGNATURE_PAGES = 10;

type SolanaReceiveNetwork = Readonly<{
  rpcUrls: readonly string[];
  timeoutMs: number;
}>;

export type SolanaReceiveEventRpc = Readonly<{
  finalizedSlot: (network: SolanaReceiveNetwork) => Promise<bigint>;
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

function solanaNetwork(): SolanaReceiveNetwork {
  return {
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
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
  const slot = await rpc.finalizedSlot(solanaNetwork());
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
): Promise<FundingReceiveEventScan | null> {
  if (variants.length === 0) return null;
  if (variants.some((variant) => variant.networkId !== "solana:mainnet")) {
    return null;
  }
  let cursorAdvanced = false;
  const groups = await Promise.all(
    variants.map(async (variant) => {
      const signatures = await listNewSignatures(variant, rpc);
      if (signatures.length === 0) {
        return { variant, events: [] as FundingReceiveCanonicalEvent[] };
      }
      const network = solanaNetwork();
      const blockhashBySlot = new Map<string, Promise<string | null>>();
      const events: FundingReceiveCanonicalEvent[] = [];
      for (const signature of [...signatures].reverse()) {
        if (signature.failed) continue;
        const transaction = await rpc.transaction({
          ...network,
          signature: signature.signature,
        });
        if (transaction == null) {
          throw new Error(
            `Solana finalized transaction ${signature.signature} is unavailable`,
          );
        }
        const transfers = parseTransactionTransfers(transaction, { variant });
        if (transfers == null) {
          throw new Error(
            `Solana finalized transaction ${signature.signature} is malformed`,
          );
        }
        let blockhash = blockhashBySlot.get(signature.slot.toString());
        if (!blockhash) {
          blockhash = rpc.blockhash({ ...network, slot: signature.slot });
          blockhashBySlot.set(signature.slot.toString(), blockhash);
        }
        const resolvedBlockhash = await blockhash;
        if (!resolvedBlockhash) {
          throw new Error(
            `Solana finalized block ${signature.slot.toString()} is unavailable`,
          );
        }
        for (const transfer of transfers) {
          events.push({
            variant,
            transactionHash: signature.signature,
            eventIndex: transfer.eventIndex,
            blockNumber: signature.slot.toString(),
            blockHash: resolvedBlockhash,
            sourceAddress: transfer.sourceAddress,
            destinationAddress: variant.destinationAddress,
            rawAmount: transfer.rawAmount.toString(),
            observedAt:
              signature.blockTime == null
                ? now.toISOString()
                : new Date(signature.blockTime * 1_000).toISOString(),
          });
        }
      }
      const newest = signatures[0];
      if (!newest) {
        return { variant, events };
      }
      cursorAdvanced = true;
      return {
        events,
        variant: withCursor(variant, {
          slot: newest.slot,
          signature: newest.signature,
        }),
      };
    }),
  );
  return {
    events: groups.flatMap((group) => group.events),
    variants: groups.map((group) => group.variant),
    cursorAdvanced,
  };
}
