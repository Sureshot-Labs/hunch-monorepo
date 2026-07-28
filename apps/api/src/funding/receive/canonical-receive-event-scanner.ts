import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import { canonicalFundingReceiveObserverId } from "./canonical-receive-capabilities.js";
import {
  initializeFundingReceiveEventCursors as initializeEvmCursors,
  scanFundingReceiveCanonicalEvents as scanEvmEvents,
  type FundingReceiveEventScan,
} from "./evm-receive-event-scanner.js";
import {
  initializeSolanaFundingReceiveEventCursors,
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

export type {
  FundingReceiveCanonicalEvent,
  FundingReceiveEventScan,
} from "./evm-receive-event-scanner.js";
