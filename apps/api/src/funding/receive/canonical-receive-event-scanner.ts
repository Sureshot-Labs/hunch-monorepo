import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import { canonicalFundingReceiveObserverId } from "./canonical-receive-capabilities.js";
import {
  initializeFundingReceiveEventCursors as initializeEvmCursors,
  scanFundingReceiveCanonicalEventBatch as scanEvmEventBatch,
  scanFundingReceiveCanonicalEvents as scanEvmEvents,
  type FundingReceiveEventScanBatchEntry,
  type FundingReceiveEventScan,
} from "./evm-receive-event-scanner.js";
import {
  initializeSolanaFundingReceiveEventCursors,
  scanSolanaFundingReceiveCanonicalEventBatch as scanSolanaEventBatch,
  scanSolanaFundingReceiveCanonicalEvents,
} from "./solana-receive-event-scanner.js";

function partitionVariants(
  variants: readonly DirectIngressObservationVariant[],
): Readonly<{
  evm: DirectIngressObservationVariant[];
  solana: DirectIngressObservationVariant[];
}> {
  const evm: DirectIngressObservationVariant[] = [];
  const solana: DirectIngressObservationVariant[] = [];
  for (const variant of variants) {
    const observerId = canonicalFundingReceiveObserverId(variant.networkId);
    if (observerId === "evm_erc20_transfer_v1") {
      evm.push(variant);
      continue;
    }
    if (observerId === "solana_transfer_v1") {
      solana.push(variant);
      continue;
    }
    throw new Error(
      `canonical receive-event scanner is unavailable for ${variant.networkId}`,
    );
  }
  return { evm, solana };
}

export async function initializeCanonicalFundingReceiveEventCursors(
  variants: readonly DirectIngressObservationVariant[],
): Promise<readonly DirectIngressObservationVariant[]> {
  const groups = partitionVariants(variants);
  const initialized = [
    ...(groups.evm.length > 0 ? await initializeEvmCursors(groups.evm) : []),
    ...(groups.solana.length > 0
      ? await initializeSolanaFundingReceiveEventCursors(groups.solana)
      : []),
  ];
  const byId = new Map(
    initialized.map((variant) => [variant.variantId, variant]),
  );
  return variants.map((variant) => {
    const resolved = byId.get(variant.variantId);
    if (!resolved) {
      throw new Error(
        `canonical receive cursor initialization lost ${variant.variantId}`,
      );
    }
    return resolved;
  });
}

export async function scanCanonicalFundingReceiveEvents(
  variants: readonly DirectIngressObservationVariant[],
  now = new Date(),
): Promise<FundingReceiveEventScan | null> {
  if (variants.length === 0) return null;
  const groups = partitionVariants(variants);
  const scans = await Promise.all([
    groups.evm.length > 0 ? scanEvmEvents(groups.evm, now) : null,
    groups.solana.length > 0
      ? scanSolanaFundingReceiveCanonicalEvents(groups.solana, now)
      : null,
  ]);
  const active = scans.filter(
    (scan): scan is FundingReceiveEventScan => scan != null,
  );
  if (active.length === 0) return null;
  const byId = new Map(
    active.flatMap((scan) =>
      scan.variants.map((variant) => [variant.variantId, variant] as const),
    ),
  );
  return {
    events: active.flatMap((scan) => scan.events),
    variants: variants.map((variant) => byId.get(variant.variantId) ?? variant),
    cursorAdvanced: active.some((scan) => scan.cursorAdvanced),
  };
}

export type CanonicalFundingReceiveScanBatchResult = Readonly<{
  scans: ReadonlyMap<string, FundingReceiveEventScan | null>;
  failedKeys: ReadonlySet<string>;
  errors: ReadonlyMap<string, unknown>;
}>;

export async function scanCanonicalFundingReceiveEventsBatch(
  entries: readonly FundingReceiveEventScanBatchEntry[],
  now = new Date(),
): Promise<CanonicalFundingReceiveScanBatchResult> {
  const groupsByKey = new Map<string, ReturnType<typeof partitionVariants>>();
  const failedKeys = new Set<string>();
  const errors = new Map<string, unknown>();
  for (const entry of entries) {
    try {
      groupsByKey.set(entry.key, partitionVariants(entry.variants));
    } catch (error) {
      failedKeys.add(entry.key);
      errors.set(entry.key, error);
    }
  }
  const evmEntries = entries.flatMap((entry) => {
    if (failedKeys.has(entry.key)) return [];
    const variants = groupsByKey.get(entry.key)?.evm ?? [];
    return variants.length > 0 ? [{ key: entry.key, variants }] : [];
  });
  const evmResult = await scanEvmEventBatch(evmEntries, now);
  for (const key of evmResult.failedKeys) failedKeys.add(key);
  for (const [key, error] of evmResult.errors) errors.set(key, error);
  const solanaEntries = entries.flatMap((entry) => {
    if (failedKeys.has(entry.key)) return [];
    const variants = groupsByKey.get(entry.key)?.solana ?? [];
    return variants.length > 0 ? [{ key: entry.key, variants }] : [];
  });
  const solanaResult = await scanSolanaEventBatch(solanaEntries, now);
  for (const key of solanaResult.failedKeys) failedKeys.add(key);
  for (const [key, error] of solanaResult.errors) errors.set(key, error);

  const scans = new Map<string, FundingReceiveEventScan | null>();
  for (const entry of entries) {
    if (failedKeys.has(entry.key)) continue;
    const active = [
      evmResult.scans.get(entry.key) ?? null,
      solanaResult.scans.get(entry.key) ?? null,
    ].filter((scan): scan is FundingReceiveEventScan => scan != null);
    if (active.length === 0) {
      scans.set(entry.key, null);
      continue;
    }
    const variantsById = new Map(
      active.flatMap((scan) =>
        scan.variants.map((variant) => [variant.variantId, variant] as const),
      ),
    );
    scans.set(entry.key, {
      events: active.flatMap((scan) => scan.events),
      variants: entry.variants.map(
        (variant) => variantsById.get(variant.variantId) ?? variant,
      ),
      cursorAdvanced: active.some((scan) => scan.cursorAdvanced),
    });
  }
  return { scans, failedKeys, errors };
}

export type {
  FundingReceiveCanonicalEvent,
  FundingReceiveEventScan,
} from "./evm-receive-event-scanner.js";
