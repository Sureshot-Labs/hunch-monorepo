import {
  resolveKnownAccountAsset,
  resolveKnownAccountAssetSymbol,
} from "../../account-value/known-asset-catalog.js";
import {
  canonicalAccountAddress,
  canonicalAssetKey,
  sameAsset,
} from "../domain/asset-identity.js";
import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingDestinationOption,
  FundingReceiveHandling,
  Money,
  SourceOption,
} from "../domain/types.js";
import {
  canonicalJson,
  canonicalJsonHash,
  lookupHmac,
} from "../persistence/canonical.js";
import type { FundingPlanningRuntime } from "../planner/runtime-service.js";

/** The opaque selection and its policy snapshot stay fresh for five minutes. */
export const FUNDING_RECEIVE_OPTION_TTL_MS = 5 * 60_000;

const RECEIVE_OPTION_TOKEN_PREFIX = "receive_option_v1";
const RECEIVE_OPTION_TOKEN_DOMAIN = "hunch:funding:receive-option:v1:";

type PresentedFundingAsset = AssetRef &
  Readonly<{
    symbol: string;
    name: string;
    variant?: "native" | "bridged";
  }>;

export type FundingReceiveOption = Readonly<{
  receiveOptionId: string;
  asset: PresentedFundingAsset;
  network: Readonly<{ networkId: string; name: string }>;
  ingressMethods: readonly (
    | "connected_wallet"
    | "manual_receive"
    | "privy_card"
  )[];
  handling: FundingReceiveHandling;
  minimumDepositRaw: string | null;
  recommendedFor: readonly ("crypto" | "card")[];
  displayOrder: number;
}>;

export type FundingReceiveOptionsResponse = Readonly<{
  revision: string;
  expiresAt: string;
  receiveOptions: readonly FundingReceiveOption[];
}>;

export type ResolvedFundingReceiveOption = Readonly<{
  option: FundingReceiveOption;
  destinationOptionId: string;
  venueBindingOptionId: string;
  receiveTarget: Readonly<{
    networkId: string;
    destinationAddress: string;
  }>;
}>;

type ReceiveOptionCandidate = Omit<ResolvedFundingReceiveOption, "option"> &
  Readonly<{
    selectedReceiveTargetId: string;
    asset: AssetRef;
    handling: FundingReceiveHandling;
    senderNativeFeeRequirement: Money | null;
    cardSupported: boolean;
  }>;

export type FundingReceiveOptionCatalog = Readonly<{
  expiresAt: Date;
  candidates: readonly ResolvedFundingReceiveOption[];
}>;

function optionExpiry(now: Date): Date {
  return new Date(now.getTime() + FUNDING_RECEIVE_OPTION_TTL_MS);
}

function networkName(networkId: string): string {
  switch (networkId) {
    case "evm:137":
      return "Polygon";
    case "evm:8453":
      return "Base";
    case "solana:mainnet":
      return "Solana";
    default:
      return networkId.startsWith("evm:")
        ? `EVM ${networkId.slice("evm:".length)}`
        : networkId;
  }
}

function assetPresentation(asset: AssetRef): PresentedFundingAsset {
  const known = resolveKnownAccountAsset(asset);
  const symbol = resolveKnownAccountAssetSymbol(asset) ?? "Token";
  const variant =
    known?.symbol === "USDC.e"
      ? ("bridged" as const)
      : known?.symbol === "USDC" && asset.networkId === "evm:137"
        ? ("native" as const)
        : undefined;
  return variant
    ? { ...asset, symbol, name: symbol, variant }
    : { ...asset, symbol, name: symbol };
}

function receiveOptionId(input: {
  tokenKey: string;
  userId: string;
  asset: AssetRef;
  destinationOptionId: string;
  venueBindingOptionId: string;
  selectedReceiveTargetId: string;
  handling: FundingReceiveHandling;
  senderNativeFeeRequirement: Money | null;
  cardSupported: boolean;
  expiresAt: Date;
}): string {
  const expiry = input.expiresAt.getTime().toString(36);
  const signature = lookupHmac(
    `${RECEIVE_OPTION_TOKEN_DOMAIN}${canonicalJson({
      userId: input.userId,
      asset: canonicalAssetKey(input.asset),
      destinationOptionId: input.destinationOptionId,
      venueBindingOptionId: input.venueBindingOptionId,
      receiveTargetId: input.selectedReceiveTargetId,
      handling: input.handling,
      senderNativeFeeRequirement: input.senderNativeFeeRequirement,
      cardSupported: input.cardSupported,
      expiresAt: input.expiresAt.toISOString(),
    })}`,
    input.tokenKey,
  );
  // The deadline is public for UX only. The MAC covers it and every private
  // routing field, so changing the suffix cannot extend a token's validity.
  return `${RECEIVE_OPTION_TOKEN_PREFIX}_${signature}_${expiry}`;
}

export function fundingReceiveOptionExpiry(
  receiveOptionId: string,
): Date | null {
  const encoded = receiveOptionId.match(
    /^receive_option_v1_[0-9a-f]{64}_([0-9a-z]+)$/u,
  )?.[1];
  if (!encoded) return null;
  const milliseconds = Number.parseInt(encoded, 36);
  const expiresAt = new Date(milliseconds);
  return Number.isSafeInteger(milliseconds) &&
    milliseconds > 0 &&
    Number.isFinite(expiresAt.getTime())
    ? expiresAt
    : null;
}

function manualReceiveCandidates(
  destination: FundingDestinationOption,
  sourceOptions: readonly SourceOption[],
): readonly Omit<ReceiveOptionCandidate, "option">[] {
  const manualOptions = sourceOptions.filter(
    (sourceOption) =>
      sourceOption.selectable &&
      sourceOption.kind === "manual_receive" &&
      sourceOption.source.kind === "external_ingress" &&
      sourceOption.ingress?.receiveTargets?.length,
  );
  // A session has exactly one durable manual method. Do not publish a target
  // whose current planner result cannot satisfy the same creation invariant.
  if (manualOptions.length !== 1) return [];
  const manualOption = manualOptions[0];
  if (!manualOption?.ingress?.receiveTargets) return [];
  return manualOption.ingress.receiveTargets.flatMap((target) =>
    target.acceptedAssets.map((accepted) => {
      const receiveTarget = {
        networkId: target.networkId,
        destinationAddress: target.destinationAddress,
      };
      return {
        asset: accepted.asset,
        handling: accepted.handling,
        senderNativeFeeRequirement: accepted.senderNativeFeeRequirement ?? null,
        cardSupported: cardSupportsReceiveCandidate(sourceOptions, {
          asset: accepted.asset,
          receiveTarget,
        }),
        destinationOptionId: destination.destinationOptionId,
        venueBindingOptionId: destination.venueBindingOptionId,
        selectedReceiveTargetId: target.receiveTargetId,
        receiveTarget,
      };
    }),
  );
}

/**
 * A Card method is usable only when its own ingress advertises the exact
 * asset at the exact receiver selected by the user. A shared destination
 * address alone is not sufficient: it can accept several crypto assets while
 * Privy is configured for just one of them.
 */
export function ingressSupportsFundingReceiveSelection(input: {
  ingress: ExternalIngressInstruction | undefined;
  asset: AssetRef;
  receiveTarget: Readonly<{ networkId: string; destinationAddress: string }>;
}): boolean {
  return (
    input.ingress?.receiveTargets?.some(
      (target) =>
        target.networkId === input.receiveTarget.networkId &&
        canonicalAccountAddress(target.networkId, target.destinationAddress) ===
          canonicalAccountAddress(
            input.receiveTarget.networkId,
            input.receiveTarget.destinationAddress,
          ) &&
        target.acceptedAssets.some((accepted) =>
          sameAsset(accepted.asset, input.asset),
        ),
    ) ?? false
  );
}

function cardSupportsReceiveCandidate(
  sourceOptions: readonly SourceOption[],
  candidate: Pick<ReceiveOptionCandidate, "asset" | "receiveTarget">,
): boolean {
  return sourceOptions.some(
    (sourceOption) =>
      sourceOption.selectable &&
      sourceOption.kind === "privy_funding_method" &&
      sourceOption.source.kind === "external_ingress" &&
      ingressSupportsFundingReceiveSelection({
        ingress: sourceOption.ingress,
        asset: candidate.asset,
        receiveTarget: candidate.receiveTarget,
      }),
  );
}

function publicOption(input: {
  tokenKey: string;
  userId: string;
  candidate: ReceiveOptionCandidate;
  expiresAt: Date;
  recommendedFor: readonly ("crypto" | "card")[];
  displayOrder: number;
}): FundingReceiveOption {
  const { candidate } = input;
  return {
    receiveOptionId: receiveOptionId({
      tokenKey: input.tokenKey,
      userId: input.userId,
      ...candidate,
      expiresAt: input.expiresAt,
    }),
    asset: assetPresentation(candidate.asset),
    network: {
      networkId: candidate.asset.networkId,
      name: networkName(candidate.asset.networkId),
    },
    // Both crypto methods use this verified target. Card is advertised only
    // when the live Privy ingress supports this exact asset variant.
    ingressMethods: candidate.cardSupported
      ? ["connected_wallet", "manual_receive", "privy_card"]
      : ["connected_wallet", "manual_receive"],
    handling: candidate.handling,
    minimumDepositRaw: null,
    recommendedFor: input.recommendedFor,
    displayOrder: input.displayOrder,
  };
}

/**
 * Builds generic Add Funds choices from the current policy and destination
 * adapters. It does not create a session, disclose an address, or initialize
 * an observer cursor; all three remain POST-time responsibilities.
 */
export async function listFundingReceiveOptions(input: {
  runtime: Pick<FundingPlanningRuntime, "destinationAccess" | "liquidity">;
  /** API-owned HMAC key; injected so shared funding code stays sidecar-safe. */
  tokenKey: string;
  userId: string;
  now?: Date;
  /**
   * POST re-materializes a still-live opaque choice with its hash-bound
   * expiry. GET omits this and issues a fresh five-minute catalogue.
   */
  expiresAt?: Date;
}): Promise<FundingReceiveOptionCatalog> {
  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ?? optionExpiry(now);
  const destinationAccess = await input.runtime.destinationAccess(
    input.userId,
    {
      purpose: "fund",
    },
  );
  const discoveries = await Promise.all(
    destinationAccess.options.map(async (destination) => {
      try {
        const liquidity = await input.runtime.liquidity(input.userId, {
          purpose: "add_funds",
          marketContextId: null,
          confirmedSourceAmount: null,
          requestedDestinationAmount: {
            asset: destination.requiredAsset,
            raw: "1",
          },
          destinationOptionId: destination.destinationOptionId,
          venueBindingOptionId: destination.venueBindingOptionId,
          withdrawalRecipientId: null,
          maxFeeUsd: null,
          maxSlippageBps: null,
          deadline: null,
        });
        return manualReceiveCandidates(destination, liquidity.sourceOptions);
      } catch (error) {
        // A partial provider outage must not hide independently usable assets.
        console.warn("[funding-receive] receive option discovery failed", {
          userId: input.userId,
          venueId: destination.venueId,
          destinationOptionId: destination.destinationOptionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );
  const firstByAsset = new Map<string, ReceiveOptionCandidate>();
  for (const discovery of discoveries) {
    for (const candidate of discovery) {
      const key = canonicalAssetKey(candidate.asset);
      const existing = firstByAsset.get(key);
      // One public option represents one exact asset+network. Prefer a route
      // that supports Card over an otherwise equal crypto-only route, so the
      // frontend never has to reveal or choose a venue for the same asset.
      if (!existing || (!existing.cardSupported && candidate.cardSupported)) {
        firstByAsset.set(key, candidate);
      }
    }
  }
  const selectedCandidates = [...firstByAsset.values()];
  const recommendedCardIndex = selectedCandidates.findIndex(
    (candidate) => candidate.cardSupported,
  );
  const candidates = selectedCandidates.map((candidate, index) => ({
    ...candidate,
    option: publicOption({
      tokenKey: input.tokenKey,
      userId: input.userId,
      candidate,
      expiresAt,
      recommendedFor: [
        ...(index === 0 ? (["crypto"] as const) : []),
        ...(index === recommendedCardIndex ? (["card"] as const) : []),
      ],
      displayOrder: index,
    }),
  }));
  return { expiresAt, candidates };
}

export function fundingReceiveOptionsResponse(
  catalog: FundingReceiveOptionCatalog,
): FundingReceiveOptionsResponse {
  const receiveOptions = catalog.candidates.map(
    (candidate) => candidate.option,
  );
  return {
    revision: canonicalJsonHash({
      expiresAt: catalog.expiresAt.toISOString(),
      options: receiveOptions.map((option) => ({
        receiveOptionId: option.receiveOptionId,
        asset: canonicalAssetKey(option.asset),
        ingressMethods: option.ingressMethods,
        recommendedFor: option.recommendedFor,
      })),
    }),
    expiresAt: catalog.expiresAt.toISOString(),
    receiveOptions,
  };
}

export function findFundingReceiveOption(
  catalog: FundingReceiveOptionCatalog,
  receiveOptionId: string,
): ResolvedFundingReceiveOption | null {
  return (
    catalog.candidates.find(
      (candidate) => candidate.option.receiveOptionId === receiveOptionId,
    ) ?? null
  );
}
