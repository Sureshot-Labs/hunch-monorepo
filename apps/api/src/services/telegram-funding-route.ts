import type { Pool } from "@hunch/infra";

import {
  isEvmAddress,
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import {
  parseFundingReceiveReviewContinuation,
  type AssetRef,
  type FundingDestinationOption,
  type FundingReceiveQuotePlan,
  type FundingReceiveReviewContinuation,
  type FundingReceiveSession,
  type JsonValue,
} from "../funding/domain/types.js";
import type { DelegatedFundingPreBroadcastDecision } from "../funding/execution/delegated-funding-capability.js";
import { SOLANA_NATIVE_ASSET } from "../funding/domain/network-fees.js";
import { resolveTelegramRelayEvmCapability } from "../funding/execution/delegated-funding-capability-resolver.js";
import {
  loadRelayEvmExecutionConfiguration,
  type RelayEvmExecutionConfiguration,
} from "../funding/execution/delegated-funding-config.js";
import {
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID,
} from "../funding/execution/delegated-funding-profile-ids.js";
import type { TelegramFundingAuthorization } from "../funding/execution/telegram-funding-authorization.js";
import { isTelegramFundingManagedSolanaWalletCurrent } from "../funding/execution/telegram-funding-managed-wallet.js";
import {
  buildTelegramRelayEvmAutomationPolicyV3,
  parseTelegramRelayEvmAutomationPolicyV3,
  telegramRelayEvmPolicyMatchesAuthorization,
  telegramRelayEvmReceiptIsAuthorized,
  type TelegramRelayEvmAutomationPolicyV3,
} from "../funding/execution/telegram-funding-automation-policy.js";
import type { FundingReceiveReceiptRoutingTarget } from "../funding/persistence/funding-receive-session-repository.js";
import { loadFundingLifecycleProjectionForOperation } from "../funding/lifecycle/funding-lifecycle-read-model.js";
import type {
  FundingReceiveReceiptAutomaticExecution,
  FundingReceiveReceiptDisposition,
} from "../funding/receive/receive-receipt-router.js";
import { initializeCanonicalFundingReceiveEventCursors } from "../funding/receive/canonical-receive-event-scanner.js";
import type { DirectIngressObservationVariant } from "../funding/reconciliation/direct-ingress-observer.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import type { FundingRuntimePolicy } from "../funding/policies/funding-policy.js";
import {
  fundingReceiveAssetEnabled,
  fundingVenueReceiveEnabled,
} from "../funding/policies/funding-policy-v2.js";
import { resolveFundingControlPlaneSnapshot } from "../funding/policies/funding-policy-sidecar.js";
import {
  RELAY_RECEIVE_OPERATION_ADAPTER_KEY,
  relayReceiveQuotePlan,
} from "../funding-providers/relay/receive-routing.js";
import {
  BASE_USDC,
  POLYGON_USDC,
  POLYGON_PUSD,
} from "../funding-providers/relay/rehearsal.js";
import type { TelegramFundingConsent } from "./telegram-funding-sessions.js";
import { hasReadyPolymarketDirectDestinationReceipt } from "./telegram-funding-polymarket-evidence.js";

export type TelegramFundingReceivePresentationMode =
  | "pusd_direct"
  // Historical presentation values remain parseable so an already-sent card
  // can render an honest terminal state. No registered adapter can select,
  // authorize, or execute these removed Deposit Wallet source routes.
  | "pusd_or_usdce_automatic"
  | "usdce_wrap_automatic"
  | "relay_evm_automatic"
  | "base_usdc_relay_automatic"
  | "limitless_base_usdc_direct"
  | "polymarket_solana_sol_retained"
  | "limitless_solana_sol_retained";

export function isTelegramSolanaRetainedFundingMode(
  mode: TelegramFundingReceivePresentationMode,
): mode is "polymarket_solana_sol_retained" | "limitless_solana_sol_retained" {
  return (
    mode === "polymarket_solana_sol_retained" ||
    mode === "limitless_solana_sol_retained"
  );
}

export function isTelegramSolanaRetainedFundingRouteKey(
  routeKey: string,
): boolean {
  return (
    routeKey === "polymarket_solana_sol_retained_v1" ||
    routeKey === "limitless_solana_sol_retained_v1"
  );
}

export type TelegramFundingRoutePresentation = Readonly<{
  version: 1;
  routeKey: string;
  venueId: string;
  venueLabel: string;
  networkId: string;
  networkLabel: string;
  destinationAssetSymbol: string;
  acceptedAssetSymbols: readonly string[];
  automaticSourceAssetSymbol?: string;
  selectionButtonLabel?: string;
  settlementLabel?: string;
  instructions?: readonly string[];
  reviewAction?: FundingReceiveReviewContinuation;
  decimals: number;
}>;

export type TelegramFundingRoute = Readonly<{
  destinationAsset: AssetRef;
  automaticSourceAsset: AssetRef | null;
  mode: TelegramFundingReceivePresentationMode;
  presentation: TelegramFundingRoutePresentation;
}>;

export type TelegramFundingTargetCapability = TelegramFundingRoute &
  Readonly<{
    address: string;
    receiveTargetId: string;
  }>;

export type TelegramFundingTargetChoice = Readonly<{
  address: string;
  asset: AssetRef;
  automaticConversion: boolean;
  mode: TelegramFundingReceivePresentationMode;
  presentation: TelegramFundingRoutePresentation;
  receiveTargetId: string;
  automaticVariants: readonly DirectIngressObservationVariant[];
  variantIds: readonly string[];
}>;

export type TelegramFundingDepositRouteKey =
  | "limitless_base_usdc_direct_v1"
  | "limitless_solana_sol_retained_v1"
  | "polymarket_polygon_pusd_direct_v1"
  | "polymarket_solana_sol_retained_v1";

type TelegramFundingRouteDescriptor = Readonly<{
  automaticServerExecution: boolean;
  choiceToken: string;
  venueId: "limitless" | "polymarket";
}> &
  (
    | Readonly<{
        depositMenu: true;
        routeKey: TelegramFundingDepositRouteKey;
      }>
    | Readonly<{
        depositMenu: false;
        routeKey: string;
      }>
  );

const TELEGRAM_FUNDING_ROUTE_DESCRIPTORS = Object.freeze([
  {
    automaticServerExecution: false,
    choiceToken: "ld",
    depositMenu: true,
    routeKey: "limitless_base_usdc_direct_v1",
    venueId: "limitless",
  },
  {
    automaticServerExecution: true,
    choiceToken: "lp",
    depositMenu: false,
    routeKey: "limitless_polygon_pusd_relay_v1",
    venueId: "limitless",
  },
  {
    automaticServerExecution: true,
    choiceToken: "ln",
    depositMenu: false,
    routeKey: "limitless_polygon_usdc_relay_v1",
    venueId: "limitless",
  },
  {
    automaticServerExecution: true,
    choiceToken: "le",
    depositMenu: false,
    routeKey: "limitless_polygon_usdce_relay_v1",
    venueId: "limitless",
  },
  {
    automaticServerExecution: true,
    choiceToken: "pb",
    depositMenu: false,
    routeKey: "polymarket_base_usdc_relay_v1",
    venueId: "polymarket",
  },
  {
    automaticServerExecution: false,
    choiceToken: "pd",
    depositMenu: true,
    routeKey: "polymarket_polygon_pusd_direct_v1",
    venueId: "polymarket",
  },
  {
    automaticServerExecution: true,
    choiceToken: "pn",
    depositMenu: false,
    routeKey: "polymarket_polygon_usdc_relay_v1",
    venueId: "polymarket",
  },
  {
    automaticServerExecution: false,
    choiceToken: "ps",
    depositMenu: true,
    routeKey: "polymarket_solana_sol_retained_v1",
    venueId: "polymarket",
  },
  {
    automaticServerExecution: false,
    choiceToken: "ls",
    depositMenu: true,
    routeKey: "limitless_solana_sol_retained_v1",
    venueId: "limitless",
  },
] as const satisfies readonly TelegramFundingRouteDescriptor[]);

const TELEGRAM_FUNDING_CHOICE_ALIASES: Readonly<Record<string, string>> = {
  b: "pb",
  d: "pd",
  l: "ld",
  p: "pd",
};

export function telegramFundingRouteDescriptorForChoiceToken(
  choiceToken: string,
): TelegramFundingRouteDescriptor | null {
  const normalized = choiceToken.trim().toLowerCase();
  const canonical = TELEGRAM_FUNDING_CHOICE_ALIASES[normalized] ?? normalized;
  return (
    TELEGRAM_FUNDING_ROUTE_DESCRIPTORS.find(
      (descriptor) => descriptor.choiceToken === canonical,
    ) ?? null
  );
}

export function telegramFundingDepositRouteDescriptorForChoiceToken(
  choiceToken: string,
): Extract<TelegramFundingRouteDescriptor, { depositMenu: true }> | null {
  const descriptor = telegramFundingRouteDescriptorForChoiceToken(choiceToken);
  return descriptor?.depositMenu ? descriptor : null;
}

export function telegramFundingRouteDescriptorForRouteKey(
  routeKey: string,
): TelegramFundingRouteDescriptor | null {
  return (
    TELEGRAM_FUNDING_ROUTE_DESCRIPTORS.find(
      (descriptor) => descriptor.routeKey === routeKey,
    ) ?? null
  );
}

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type TelegramFundingRouteCapability = Readonly<{
  authorization: TelegramFundingAuthorization | null;
  decision: DelegatedFundingPreBroadcastDecision;
  fundingPolicyRevision: string;
  target: TelegramFundingTargetCapability;
}>;

type TelegramFundingRouteCapabilityInput = Readonly<{
  userId: string;
  telegramAccountId: string;
  telegramUserId: string;
  session: FundingReceiveSession;
  expectedAuthorizationId?: string;
  expectedAuthorizationFingerprint?: string;
  expectedFundingPolicyRevision?: string;
  now?: Date;
  lock?: boolean;
  routeKey?: string;
}>;

type TelegramFundingAutomaticCapabilityInput = Readonly<{
  policySnapshot: unknown;
  userId: string;
  telegramAccountId: string;
  telegramUserId: string;
  destinationOptionId: string;
  venueBindingOptionId: string;
  now?: Date;
  lock?: boolean;
}>;

type TelegramFundingAutomaticCapability = Readonly<{
  authorization: TelegramFundingAuthorization | null;
  decision: DelegatedFundingPreBroadcastDecision;
  expectedFundingPolicyRevision: string;
  fundingPolicyRevision: string;
}>;

export function classifyTelegramRelayFrozenCapability(
  policy: TelegramRelayEvmAutomationPolicyV3,
  capability: Readonly<{
    authorization: TelegramFundingAuthorization | null;
    decision: DelegatedFundingPreBroadcastDecision;
    fundingPolicyRevision: string;
  }>,
): TelegramFundingAutomaticCapability {
  if (capability.decision.kind !== "allowed") {
    return {
      authorization: null,
      decision: capability.decision,
      expectedFundingPolicyRevision: policy.fundingPolicyRevision,
      fundingPolicyRevision: capability.fundingPolicyRevision,
    };
  }
  const authorization =
    capability.authorization &&
    telegramRelayEvmPolicyMatchesAuthorization(policy, capability.authorization)
      ? capability.authorization
      : null;
  return {
    authorization,
    decision: authorization
      ? capability.decision
      : { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" },
    expectedFundingPolicyRevision: policy.fundingPolicyRevision,
    fundingPolicyRevision: capability.fundingPolicyRevision,
  };
}

export function relayEvmFrozenConsentConfiguration(
  runtime: RelayEvmExecutionConfiguration,
  policy: TelegramRelayEvmAutomationPolicyV3,
): RelayEvmExecutionConfiguration {
  return {
    ...runtime,
    // A delivery-only sidecar intentionally has no signing secret bundle.
    // The signer id is non-secret and frozen inside the exact consent. The
    // resolver still re-loads the current DB authorization and verifies its
    // complete fingerprint plus every other current runtime policy field.
    signerId: runtime.signerId || policy.signerId,
  };
}

type TelegramFundingAutomaticPolicyInput = Readonly<{
  authorization: TelegramFundingAuthorization;
  choice: Pick<
    TelegramFundingTargetChoice,
    "automaticVariants" | "presentation"
  >;
  destinationAsset: AssetRef;
  fundingPolicyRevision: string;
}>;

export type TelegramFundingReceiptExecution =
  FundingReceiveReceiptAutomaticExecution;
export type TelegramFundingReceiptOperationPreparer = NonNullable<
  FundingReceiveReceiptAutomaticExecution["prepareOperation"]
>;

const POLYMARKET_POLYGON_PUSD_DIRECT_PRESENTATION = {
  version: 1,
  routeKey: "polymarket_polygon_pusd_direct_v1",
  venueId: "polymarket",
  venueLabel: "Polymarket",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "pUSD",
  acceptedAssetSymbols: ["pUSD"],
  selectionButtonLabel: "pUSD · Polygon",
  settlementLabel: "Direct",
  instructions: [
    "Send only pUSD on Polygon.",
    "Other assets cannot be routed from this Telegram flow.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

// These two presentations are decode-only compatibility for frozen consents
// and cards created before Deposit Wallet conversion was retired. They are not
// registered in TELEGRAM_FUNDING_ROUTE_DESCRIPTORS, so no new callback,
// consent, receipt execution, or funding operation can select either route.
const POLYMARKET_POLYGON_PUSD_USDCE_PRESENTATION = {
  version: 1,
  routeKey: "polymarket_polygon_pusd_usdce_v1",
  venueId: "polymarket",
  venueLabel: "Polymarket",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "pUSD",
  acceptedAssetSymbols: ["pUSD", "USDC.e"],
  automaticSourceAssetSymbol: "USDC.e",
  selectionButtonLabel: "pUSD / USDC.e · Polygon",
  settlementLabel: "Unavailable legacy route",
  instructions: [
    "This older Deposit Wallet conversion route is no longer executable.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const POLYMARKET_POLYGON_USDCE_WRAP_PRESENTATION = {
  version: 1,
  routeKey: "polymarket_polygon_usdce_wrap_v1",
  venueId: "polymarket",
  venueLabel: "Polymarket",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "pUSD",
  acceptedAssetSymbols: ["USDC.e"],
  automaticSourceAssetSymbol: "USDC.e",
  selectionButtonLabel: "USDC.e · Polygon",
  settlementLabel: "Unavailable legacy route",
  instructions: [
    "This older Deposit Wallet conversion route is no longer executable.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

// Provider/network rules stay in adapters like this one. The durable progress
// and Telegram delivery state machines consume only the frozen generic
// presentation, so adding Base/Solana must not add branches to those cores.

const POLYMARKET_BASE_USDC_PRESENTATION = {
  version: 1,
  routeKey: "polymarket_base_usdc_relay_v1",
  venueId: "polymarket",
  venueLabel: "Polymarket",
  networkId: "evm:8453",
  networkLabel: "Base",
  destinationAssetSymbol: "pUSD",
  acceptedAssetSymbols: ["USDC"],
  automaticSourceAssetSymbol: "USDC",
  selectionButtonLabel: "USDC on Base",
  settlementLabel: "Automatic Relay to Polygon pUSD",
  instructions: [
    "Send only native USDC on Base.",
    "It is automatically routed to Polygon pUSD after receipt finality.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const POLYMARKET_POLYGON_USDC_RELAY_PRESENTATION = {
  version: 1,
  routeKey: "polymarket_polygon_usdc_relay_v1",
  venueId: "polymarket",
  venueLabel: "Polymarket",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "pUSD",
  acceptedAssetSymbols: ["USDC"],
  automaticSourceAssetSymbol: "USDC",
  selectionButtonLabel: "USDC (native) · Polygon",
  settlementLabel: "Automatic Relay to pUSD",
  instructions: [
    "Send only native USDC (not USDC.e) on Polygon.",
    "It is automatically routed to Polygon pUSD.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const LIMITLESS_BASE_USDC_DIRECT_PRESENTATION = {
  version: 1,
  routeKey: "limitless_base_usdc_direct_v1",
  venueId: "limitless",
  venueLabel: "Limitless",
  networkId: "evm:8453",
  networkLabel: "Base",
  destinationAssetSymbol: "USDC",
  acceptedAssetSymbols: ["USDC"],
  selectionButtonLabel: "USDC on Base — direct",
  settlementLabel: "Direct",
  instructions: [
    "Send only native USDC on Base.",
    "Funds arrive directly in your managed Limitless trading wallet.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const LIMITLESS_POLYGON_PUSD_RELAY_PRESENTATION = {
  version: 1,
  routeKey: "limitless_polygon_pusd_relay_v1",
  venueId: "limitless",
  venueLabel: "Limitless",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "USDC",
  acceptedAssetSymbols: ["pUSD"],
  automaticSourceAssetSymbol: "pUSD",
  selectionButtonLabel: "pUSD · Polygon",
  settlementLabel: "Automatic Relay to Base USDC",
  instructions: [
    "Send only pUSD on Polygon.",
    "It is automatically routed to Base USDC.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const LIMITLESS_POLYGON_USDC_RELAY_PRESENTATION = {
  version: 1,
  routeKey: "limitless_polygon_usdc_relay_v1",
  venueId: "limitless",
  venueLabel: "Limitless",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "USDC",
  acceptedAssetSymbols: ["USDC"],
  automaticSourceAssetSymbol: "USDC",
  selectionButtonLabel: "USDC · Polygon",
  settlementLabel: "Automatic Relay to Base USDC",
  instructions: [
    "Send only native USDC on Polygon.",
    "It is automatically routed to Base USDC.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const LIMITLESS_POLYGON_USDCE_RELAY_PRESENTATION = {
  version: 1,
  routeKey: "limitless_polygon_usdce_relay_v1",
  venueId: "limitless",
  venueLabel: "Limitless",
  networkId: "evm:137",
  networkLabel: "Polygon",
  destinationAssetSymbol: "USDC",
  acceptedAssetSymbols: ["USDC.e"],
  automaticSourceAssetSymbol: "USDC.e",
  selectionButtonLabel: "USDC.e · Polygon",
  settlementLabel: "Automatic Relay to Base USDC",
  instructions: [
    "Send only USDC.e on Polygon.",
    "It is automatically routed to Base USDC.",
  ],
  decimals: 6,
} as const satisfies TelegramFundingRoutePresentation;

const POLYMARKET_SOLANA_SOL_RETAINED_PRESENTATION = {
  version: 1,
  routeKey: "polymarket_solana_sol_retained_v1",
  venueId: "polymarket",
  // SOL is received into an owned Hunch wallet, not either venue. The
  // venue-specific route key only identifies the later Mini App destination.
  venueLabel: "Hunch wallet",
  networkId: "solana:mainnet",
  networkLabel: "Solana",
  destinationAssetSymbol: "SOL",
  acceptedAssetSymbols: ["SOL"],
  automaticSourceAssetSymbol: "SOL",
  selectionButtonLabel: "SOL · Solana",
  settlementLabel: "Kept on Solana · continue in Hunch",
  instructions: [
    "Send only native SOL on Solana.",
    "SOL stays in your managed Solana wallet until you continue funding in Hunch.",
  ],
  decimals: 9,
} as const satisfies TelegramFundingRoutePresentation;

const LIMITLESS_SOLANA_SOL_RETAINED_PRESENTATION = {
  ...POLYMARKET_SOLANA_SOL_RETAINED_PRESENTATION,
  routeKey: "limitless_solana_sol_retained_v1",
  venueId: "limitless",
} as const satisfies TelegramFundingRoutePresentation;

function exactPolygonPusd(asset: AssetRef): boolean {
  const configured = fundingSidecarRuntimeConfig.polymarketPusdAddress;
  return (
    isEvmAddress(configured) &&
    sameAsset(asset, {
      networkId: "evm:137",
      assetId: configured,
      decimals: 6,
    })
  );
}

function exactPolygonUsdce(asset: AssetRef): boolean {
  const configured = fundingSidecarRuntimeConfig.polymarketUsdceAddress;
  return (
    isEvmAddress(configured) &&
    sameAsset(asset, {
      networkId: "evm:137",
      assetId: configured,
      decimals: 6,
    })
  );
}

function exactPolygonUsdc(asset: AssetRef): boolean {
  return sameAsset(asset, {
    networkId: "evm:137",
    assetId: POLYGON_USDC,
    decimals: 6,
  });
}

function exactBaseUsdc(asset: AssetRef): boolean {
  return sameAsset(asset, {
    networkId: "evm:8453",
    assetId: BASE_USDC,
    decimals: 6,
  });
}

function exactLimitlessBaseUsdc(asset: AssetRef): boolean {
  const configured = fundingSidecarRuntimeConfig.limitlessUsdcAddress;
  return (
    isEvmAddress(configured) &&
    sameAsset(asset, {
      networkId: "evm:8453",
      assetId: configured,
      decimals: 6,
    })
  );
}

function exactPolygonPusdRelay(asset: AssetRef): boolean {
  return sameAsset(asset, {
    networkId: "evm:137",
    assetId: POLYGON_PUSD,
    decimals: 6,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 64 ? label : null;
}

function boundedInstruction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const instruction = value.trim();
  return instruction.length >= 1 && instruction.length <= 256
    ? instruction
    : null;
}

export function parseTelegramFundingRoutePresentation(
  value: unknown,
): TelegramFundingRoutePresentation | null {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1) return null;
  const routeKey = boundedLabel(candidate.routeKey);
  const venueId = boundedLabel(candidate.venueId);
  const venueLabel = boundedLabel(candidate.venueLabel);
  const networkId = boundedLabel(candidate.networkId);
  const networkLabel = boundedLabel(candidate.networkLabel);
  const destinationAssetSymbol = boundedLabel(candidate.destinationAssetSymbol);
  const automaticSourceAssetSymbol =
    candidate.automaticSourceAssetSymbol === undefined
      ? undefined
      : boundedLabel(candidate.automaticSourceAssetSymbol);
  const selectionButtonLabel =
    candidate.selectionButtonLabel === undefined
      ? undefined
      : boundedLabel(candidate.selectionButtonLabel);
  const settlementLabel =
    candidate.settlementLabel === undefined
      ? undefined
      : boundedLabel(candidate.settlementLabel);
  const reviewAction =
    parseFundingReceiveReviewContinuation(candidate.reviewAction) ?? undefined;
  if (
    !routeKey ||
    !/^[a-z0-9_:-]+$/u.test(routeKey) ||
    !venueId ||
    !venueLabel ||
    !networkId ||
    !networkLabel ||
    !destinationAssetSymbol ||
    (candidate.automaticSourceAssetSymbol !== undefined &&
      !automaticSourceAssetSymbol) ||
    (candidate.selectionButtonLabel !== undefined && !selectionButtonLabel) ||
    (candidate.settlementLabel !== undefined && !settlementLabel) ||
    (candidate.reviewAction !== undefined && !reviewAction) ||
    !Number.isInteger(candidate.decimals) ||
    Number(candidate.decimals) < 0 ||
    Number(candidate.decimals) > 36 ||
    !Array.isArray(candidate.acceptedAssetSymbols)
  ) {
    return null;
  }
  const acceptedAssetSymbols = candidate.acceptedAssetSymbols.flatMap(
    (entry) => {
      const label = boundedLabel(entry);
      return label ? [label] : [];
    },
  );
  const instructions = Array.isArray(candidate.instructions)
    ? candidate.instructions.flatMap((entry) => {
        const instruction = boundedInstruction(entry);
        return instruction ? [instruction] : [];
      })
    : undefined;
  if (
    acceptedAssetSymbols.length === 0 ||
    acceptedAssetSymbols.length !== candidate.acceptedAssetSymbols.length ||
    new Set(acceptedAssetSymbols).size !== acceptedAssetSymbols.length ||
    (automaticSourceAssetSymbol != null &&
      !acceptedAssetSymbols.includes(automaticSourceAssetSymbol)) ||
    (candidate.instructions !== undefined &&
      (!Array.isArray(candidate.instructions) ||
        !instructions ||
        instructions.length === 0 ||
        instructions.length > 6 ||
        instructions.length !== candidate.instructions.length))
  ) {
    return null;
  }
  return {
    version: 1,
    routeKey,
    venueId,
    venueLabel,
    networkId,
    networkLabel,
    destinationAssetSymbol,
    acceptedAssetSymbols,
    ...(automaticSourceAssetSymbol ? { automaticSourceAssetSymbol } : {}),
    ...(selectionButtonLabel ? { selectionButtonLabel } : {}),
    ...(settlementLabel ? { settlementLabel } : {}),
    ...(instructions ? { instructions } : {}),
    ...(reviewAction ? { reviewAction } : {}),
    decimals: Number(candidate.decimals),
  };
}

export function telegramPolygonFundingPresentation(
  mode: TelegramFundingReceivePresentationMode,
): TelegramFundingRoutePresentation {
  if (mode === "limitless_base_usdc_direct") {
    return LIMITLESS_BASE_USDC_DIRECT_PRESENTATION;
  }
  if (mode === "base_usdc_relay_automatic") {
    return POLYMARKET_BASE_USDC_PRESENTATION;
  }
  if (mode === "polymarket_solana_sol_retained") {
    return POLYMARKET_SOLANA_SOL_RETAINED_PRESENTATION;
  }
  if (mode === "limitless_solana_sol_retained") {
    return LIMITLESS_SOLANA_SOL_RETAINED_PRESENTATION;
  }
  if (mode === "pusd_or_usdce_automatic") {
    return POLYMARKET_POLYGON_PUSD_USDCE_PRESENTATION;
  }
  if (mode === "usdce_wrap_automatic") {
    return POLYMARKET_POLYGON_USDCE_WRAP_PRESENTATION;
  }
  return POLYMARKET_POLYGON_PUSD_DIRECT_PRESENTATION;
}

function resolvePolymarketDirectConsentRoute(
  consent: TelegramFundingConsent,
): TelegramFundingRoute | null {
  const presentation = parseTelegramFundingRoutePresentation(
    consent.policySnapshot.presentation,
  );
  return !consent.automationEnabled &&
    exactPolygonPusd(consent.asset) &&
    consent.policySnapshot.presentationMode === "pusd_direct" &&
    presentation?.routeKey ===
      POLYMARKET_POLYGON_PUSD_DIRECT_PRESENTATION.routeKey
    ? {
        destinationAsset: consent.asset,
        automaticSourceAsset: null,
        mode: "pusd_direct",
        presentation,
      }
    : null;
}

function resolvePolymarketPolygonDirectTarget(input: {
  session: FundingReceiveSession;
}): TelegramFundingTargetCapability | null {
  const matches = input.session.receiveTargets.flatMap((target) => {
    if (target.networkId !== "evm:137") return [];
    const pusd = target.acceptedAssets.filter(
      (accepted) =>
        accepted.handling === "direct" && exactPolygonPusd(accepted.asset),
    );
    if (pusd.length !== 1) return [];
    const destinationAsset = pusd[0]?.asset ?? null;
    if (!destinationAsset) return [];
    return [{ target, destinationAsset }];
  });
  if (matches.length !== 1 || !matches[0]) return null;
  const match = matches[0];
  return {
    address: match.target.destinationAddress,
    destinationAsset: match.destinationAsset,
    automaticSourceAsset: null,
    mode: "pusd_direct",
    presentation: POLYMARKET_POLYGON_PUSD_DIRECT_PRESENTATION,
    receiveTargetId: match.target.receiveTargetId,
  };
}

function resolvePolymarketPolygonDirectChoice(input: {
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}): TelegramFundingTargetChoice | null {
  const target = resolvePolymarketPolygonDirectTarget(input);
  if (!target) return null;
  const variants = input.observationVariants
    .filter(
      (variant) =>
        sameAsset(variant.asset, target.destinationAsset) &&
        sameAccountAddress(
          variant.networkId,
          variant.destinationAddress,
          target.address,
        ) &&
        variant.completion.kind === "direct_destination_credit",
    )
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  const variantIds = variants.map((variant) => variant.variantId);
  if (variantIds.length === 0) return null;
  return {
    address: target.address,
    asset: target.destinationAsset,
    automaticConversion: false,
    mode: target.mode,
    presentation: target.presentation,
    receiveTargetId: target.receiveTargetId,
    automaticVariants: [],
    variantIds,
  };
}

function resolvePolymarketBaseFundingTarget(input: {
  automaticConversionEnabled: boolean;
  session: FundingReceiveSession;
}): TelegramFundingTargetCapability | null {
  if (!input.automaticConversionEnabled) return null;
  const matches = input.session.receiveTargets.flatMap((target) => {
    if (target.networkId !== "evm:8453") return [];
    const usdc = target.acceptedAssets.filter(
      (accepted) =>
        accepted.handling === "automatic_conversion" &&
        exactBaseUsdc(accepted.asset),
    );
    const sourceAsset = usdc.length === 1 ? usdc[0]?.asset : undefined;
    return usdc.length === 1 && target.acceptedAssets.length === 1
      ? sourceAsset
        ? [{ target, sourceAsset }]
        : []
      : [];
  });
  const match = matches.length === 1 ? matches[0] : null;
  if (!match || !exactPolygonPusdRelay(input.session.destinationAsset)) {
    return null;
  }
  return {
    address: match.target.destinationAddress,
    destinationAsset: input.session.destinationAsset,
    automaticSourceAsset: match.sourceAsset,
    mode: "base_usdc_relay_automatic",
    presentation: POLYMARKET_BASE_USDC_PRESENTATION,
    receiveTargetId: match.target.receiveTargetId,
  };
}

function resolvePolymarketBaseFundingTargetChoice(input: {
  automaticConversionEnabled: boolean;
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}): TelegramFundingTargetChoice | null {
  const target = resolvePolymarketBaseFundingTarget(input);
  if (!target?.automaticSourceAsset) return null;
  const variants = input.observationVariants
    .filter(
      (variant) =>
        sameAsset(variant.asset, target.automaticSourceAsset as AssetRef) &&
        sameAccountAddress(
          variant.networkId,
          variant.destinationAddress,
          target.address,
        ) &&
        variant.completion.kind === "child_funding_operation",
    )
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  if (!variants.length) return null;
  return {
    address: target.address,
    asset: target.destinationAsset,
    automaticConversion: true,
    mode: target.mode,
    presentation: target.presentation,
    receiveTargetId: target.receiveTargetId,
    automaticVariants: variants,
    variantIds: variants.map((variant) => variant.variantId),
  };
}

function resolvePolymarketBaseConsentRoute(
  consent: TelegramFundingConsent,
): TelegramFundingRoute | null {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(
    consent.policySnapshot,
  );
  const presentation = parseTelegramFundingRoutePresentation(
    consent.policySnapshot.presentation,
  );
  if (
    !consent.automationEnabled ||
    !policy ||
    !presentation ||
    presentation.routeKey !== POLYMARKET_BASE_USDC_PRESENTATION.routeKey ||
    !sameAsset(consent.asset, policy.destinationAsset)
  )
    return null;
  return {
    destinationAsset: policy.destinationAsset,
    automaticSourceAsset: policy.sourceAsset,
    mode: "base_usdc_relay_automatic",
    presentation,
  };
}

async function resolvePolymarketBaseRouteCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingRouteCapabilityInput,
): Promise<TelegramFundingRouteCapability | null> {
  if (
    !resolvePolymarketBaseFundingTarget({
      automaticConversionEnabled: true,
      session: input.session,
    })
  ) {
    return null;
  }
  const capability = await resolveTelegramRelayEvmCapability(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.session.destinationOptionId,
    venueBindingOptionId: input.session.venueBindingOptionId,
    expectedAuthorizationId: input.expectedAuthorizationId,
    expectedAuthorizationFingerprint: input.expectedAuthorizationFingerprint,
    expectedFundingPolicyRevision: input.expectedFundingPolicyRevision,
    now: input.now,
    lock: input.lock,
  });
  const target = resolvePolymarketBaseFundingTarget({
    automaticConversionEnabled: capability.authorization !== null,
    session: input.session,
  });
  return target
    ? {
        authorization: capability.authorization,
        decision: capability.decision,
        fundingPolicyRevision: capability.fundingPolicyRevision,
        target,
      }
    : null;
}

async function resolvePolymarketBaseAutomaticCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingAutomaticCapabilityInput,
): Promise<TelegramFundingAutomaticCapability | null> {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(input.policySnapshot);
  if (
    !policy ||
    policy.destinationOptionId !== input.destinationOptionId ||
    policy.venueBindingOptionId !== input.venueBindingOptionId
  )
    return null;
  const runtimeConfiguration = loadRelayEvmExecutionConfiguration();
  const capability = await resolveTelegramRelayEvmCapability(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    expectedAuthorizationId: policy.authorizationId,
    expectedAuthorizationFingerprint: policy.authorizationFingerprint,
    expectedFundingPolicyRevision: policy.fundingPolicyRevision,
    configuration: relayEvmFrozenConsentConfiguration(
      runtimeConfiguration,
      policy,
    ),
    now: input.now,
    lock: input.lock,
  });
  return classifyTelegramRelayFrozenCapability(policy, capability);
}

async function resolvePolygonRelayAutomaticCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingAutomaticCapabilityInput,
): Promise<TelegramFundingAutomaticCapability | null> {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(input.policySnapshot);
  const presentation = parseTelegramFundingRoutePresentation(
    record(input.policySnapshot)?.presentation,
  );
  const spec = TELEGRAM_POLYGON_RELAY_ROUTE_SPECS.find(
    (candidate) =>
      policy?.profileId === candidate.profileId &&
      presentation?.routeKey === candidate.presentation.routeKey &&
      candidate.sourceMatches(policy.sourceAsset) &&
      sameAsset(policy.destinationAsset, candidate.destinationAsset),
  );
  if (
    !policy ||
    !spec ||
    policy.destinationOptionId !== input.destinationOptionId ||
    policy.venueBindingOptionId !== input.venueBindingOptionId
  )
    return null;
  const runtimeConfiguration = loadRelayEvmExecutionConfiguration();
  const capability = await resolveTelegramRelayEvmCapability(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    expectedAuthorizationId: policy.authorizationId,
    expectedAuthorizationFingerprint: policy.authorizationFingerprint,
    expectedFundingPolicyRevision: policy.fundingPolicyRevision,
    configuration: relayEvmFrozenConsentConfiguration(
      runtimeConfiguration,
      policy,
    ),
    profileId: spec.profileId,
    routeId: spec.routeId,
    sourceAsset: policy.sourceAsset,
    destinationAsset: policy.destinationAsset,
    venueId: spec.presentation.venueId,
    now: input.now,
    lock: input.lock,
  });
  return classifyTelegramRelayFrozenCapability(policy, capability);
}

function buildPolymarketBaseAutomaticPolicy(
  input: TelegramFundingAutomaticPolicyInput,
): JsonRecord | null {
  const source = input.choice.automaticVariants[0]?.asset;
  return source
    ? (buildTelegramRelayEvmAutomationPolicyV3({
        authorization: input.authorization,
        sourceAsset: source,
        destinationAsset: input.destinationAsset,
        fundingPolicyRevision: input.fundingPolicyRevision,
        variants: input.choice.automaticVariants,
      }) as unknown as JsonRecord)
    : null;
}

async function relayReceiptRoutingDecision(
  db: Pick<Pool, "query">,
  target: FundingReceiveReceiptRoutingTarget,
): Promise<DelegatedFundingPreBroadcastDecision> {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(
    target.telegramAutomationPolicy,
  );
  if (
    !policy ||
    !target.telegramAccountId ||
    !target.telegramUserId ||
    target.telegramFundingAuthorizationId !== policy.authorizationId ||
    !sameAsset(policy.sourceAsset, target.receipt.asset) ||
    !sameAsset(policy.destinationAsset, target.destinationAsset) ||
    !telegramRelayEvmReceiptIsAuthorized({
      policy,
      variantId: target.receipt.variantId,
      ledgerHeight: target.receipt.ledgerHeight ?? null,
      rawAmount: target.receipt.rawAmount,
    })
  )
    return { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" };
  const presentation = parseTelegramFundingRoutePresentation(
    record(target.telegramAutomationPolicy)?.presentation,
  );
  const polygonSpec = TELEGRAM_POLYGON_RELAY_ROUTE_SPECS.find(
    (candidate) =>
      candidate.profileId === policy.profileId &&
      candidate.presentation.routeKey === presentation?.routeKey &&
      candidate.sourceMatches(policy.sourceAsset) &&
      sameAsset(candidate.destinationAsset, policy.destinationAsset),
  );
  const capability = await resolveTelegramRelayEvmCapability(db, {
    userId: target.userId,
    telegramAccountId: target.telegramAccountId,
    telegramUserId: target.telegramUserId,
    destinationOptionId: target.destinationOptionId,
    venueBindingOptionId: target.venueBindingOptionId,
    expectedAuthorizationId: policy.authorizationId,
    expectedAuthorizationFingerprint: policy.authorizationFingerprint,
    expectedFundingPolicyRevision: policy.fundingPolicyRevision,
    ...(polygonSpec
      ? {
          profileId: polygonSpec.profileId,
          routeId: polygonSpec.routeId,
          sourceAsset: policy.sourceAsset,
          destinationAsset: policy.destinationAsset,
          venueId: polygonSpec.presentation.venueId,
        }
      : {}),
  });
  return classifyTelegramRelayFrozenCapability(policy, capability).decision;
}

async function validateRelayFundingOperationLink(
  db: Pick<Pool, "query">,
  input: Readonly<{
    operationId: string;
    target: FundingReceiveReceiptRoutingTarget;
  }>,
): Promise<boolean> {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(
    input.target.telegramAutomationPolicy,
  );
  const presentation = parseTelegramFundingRoutePresentation(
    record(input.target.telegramAutomationPolicy)?.presentation,
  );
  const polygonSpec = TELEGRAM_POLYGON_RELAY_ROUTE_SPECS.find(
    (candidate) =>
      candidate.profileId === policy?.profileId &&
      candidate.presentation.routeKey === presentation?.routeKey,
  );
  const routeId = polygonSpec?.routeId ?? "base-usdc-to-polygon-pusd";
  const profileId =
    polygonSpec?.profileId ?? TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID;
  const { rows } = await db.query<{ operation_id: string }>(
    `select operation.id as operation_id
       from funding_operations operation
       where operation.id = $1::uuid
         and operation.user_id = $2::uuid
         and operation.support_metadata ->> 'routeId' = $4
         and operation.requested_source_amount ->> 'raw' = $3
       limit 1`,
    [
      input.operationId,
      input.target.userId,
      input.target.receipt.rawAmount,
      routeId,
      profileId,
    ],
  );
  const operationId = rows[0]?.operation_id;
  if (!operationId) return false;
  const projected = await loadFundingLifecycleProjectionForOperation(db, {
    operationId,
  });
  if (!projected) return false;
  const relayActions = projected.facts.actions.filter(
    (action) => action.executorId === profileId,
  );
  return (
    relayActions.length === 2 &&
    relayActions.every((action) => action.attempts.length === 0) &&
    !projected.lifecycle.safety.terminal
  );
}

function resolveRelayReceiptExecution(
  target: FundingReceiveReceiptRoutingTarget,
): TelegramFundingReceiptExecution | null {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(
    target.telegramAutomationPolicy,
  );
  if (!policy) return null;
  const presentation = parseTelegramFundingRoutePresentation(
    record(target.telegramAutomationPolicy)?.presentation,
  );
  const polygonSpec = TELEGRAM_POLYGON_RELAY_ROUTE_SPECS.find(
    (candidate) =>
      candidate.profileId === policy.profileId &&
      candidate.presentation.routeKey === presentation?.routeKey,
  );
  const receiptBinding =
    target.telegramFundingConsentId && target.telegramFundingConsentFingerprint
      ? {
          consentId: target.telegramFundingConsentId,
          consentFingerprint: target.telegramFundingConsentFingerprint,
        }
      : null;
  return {
    adapterKey: RELAY_RECEIVE_OPERATION_ADAPTER_KEY,
    authorizationId: policy.authorizationId,
    authorizationFingerprint: policy.authorizationFingerprint,
    ...(receiptBinding ? { receiptBinding } : {}),
    serverExecutionProfileId:
      polygonSpec?.profileId ?? TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    quotePlan: (receiptTarget) => {
      const quotePlan = relayReceiveQuotePlan({
        receiptAsset: receiptTarget.receipt.asset,
        destinationAsset: receiptTarget.destinationAsset,
        rawAmount: receiptTarget.receipt.rawAmount,
      });
      if (!quotePlan) {
        throw new Error("frozen Relay Telegram receipt is no longer routable");
      }
      return quotePlan;
    },
    decision: relayReceiptRoutingDecision,
    validateOperationLink: validateRelayFundingOperationLink,
  };
}

async function hasReadyRelayFundingDestinationReceipt(
  db: Pick<Pool, "query">,
  contextId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ operation_id: string }>(
    `select operation.id::text as operation_id
       from telegram_funding_sessions context
       join funding_receive_receipts receipt
         on receipt.receive_session_id = context.receive_session_id
        and receipt.user_id = context.user_id
       join funding_operations operation
         on operation.id = receipt.child_funding_operation_id
       where context.id = $1::uuid
         and receipt.status = 'ready'
         and operation.support_metadata ->> 'fundingAuthorizationId' is not null
       order by operation.created_at desc
       limit 16`,
    [contextId],
  );
  for (const row of rows) {
    const projected = await loadFundingLifecycleProjectionForOperation(db, {
      operationId: row.operation_id,
    });
    if (projected?.lifecycle.status === "completed") {
      return true;
    }
  }
  return false;
}

function resolveLimitlessFundingConsentRoute(
  consent: TelegramFundingConsent,
): TelegramFundingRoute | null {
  const presentation = parseTelegramFundingRoutePresentation(
    consent.policySnapshot.presentation,
  );
  return consent.policySnapshot.presentationMode ===
    "limitless_base_usdc_direct" &&
    !consent.automationEnabled &&
    exactLimitlessBaseUsdc(consent.asset) &&
    presentation?.routeKey ===
      LIMITLESS_BASE_USDC_DIRECT_PRESENTATION.routeKey &&
    presentation.venueId === LIMITLESS_BASE_USDC_DIRECT_PRESENTATION.venueId &&
    presentation.networkId === LIMITLESS_BASE_USDC_DIRECT_PRESENTATION.networkId
    ? {
        destinationAsset: consent.asset,
        automaticSourceAsset: null,
        mode: "limitless_base_usdc_direct",
        presentation,
      }
    : null;
}

function resolveLimitlessFundingTarget(input: {
  session: FundingReceiveSession;
}): TelegramFundingTargetCapability | null {
  const matches = input.session.receiveTargets.flatMap((target) => {
    if (target.networkId !== "evm:8453") return [];
    const accepted = target.acceptedAssets.filter(
      (candidate) =>
        candidate.handling === "direct" &&
        exactLimitlessBaseUsdc(candidate.asset),
    );
    return accepted.length === 1 && target.acceptedAssets.length === 1
      ? [{ asset: accepted[0]?.asset, target }]
      : [];
  });
  const match = matches.length === 1 ? matches[0] : null;
  if (
    !match?.asset ||
    !exactLimitlessBaseUsdc(input.session.destinationAsset)
  ) {
    return null;
  }
  return {
    address: match.target.destinationAddress,
    destinationAsset: match.asset,
    automaticSourceAsset: null,
    mode: "limitless_base_usdc_direct",
    presentation: LIMITLESS_BASE_USDC_DIRECT_PRESENTATION,
    receiveTargetId: match.target.receiveTargetId,
  };
}

function resolveLimitlessFundingTargetChoice(input: {
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}): TelegramFundingTargetChoice | null {
  const target = resolveLimitlessFundingTarget(input);
  if (!target) return null;
  const variants = input.observationVariants.filter(
    (variant) =>
      sameAsset(variant.asset, target.destinationAsset) &&
      sameAccountAddress(
        variant.networkId,
        variant.destinationAddress,
        target.address,
      ) &&
      variant.completion.kind === "direct_destination_credit",
  );
  if (variants.length !== 1 || !variants[0]) return null;
  return {
    address: target.address,
    asset: target.destinationAsset,
    automaticConversion: false,
    mode: target.mode,
    presentation: target.presentation,
    receiveTargetId: target.receiveTargetId,
    automaticVariants: [],
    variantIds: [variants[0].variantId],
  };
}

type TelegramPolygonRelayRouteSpec = Readonly<{
  destinationAsset: AssetRef;
  presentation: TelegramFundingRoutePresentation;
  profileId: string;
  routeId: string;
  sourceMatches: (asset: AssetRef) => boolean;
}>;

const TELEGRAM_POLYGON_RELAY_ROUTE_SPECS: readonly TelegramPolygonRelayRouteSpec[] =
  Object.freeze([
    {
      destinationAsset: {
        networkId: "evm:137",
        assetId: POLYGON_PUSD,
        decimals: 6,
      },
      presentation: POLYMARKET_POLYGON_USDC_RELAY_PRESENTATION,
      profileId: TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
      routeId: "polygon-usdc-to-polygon-pusd",
      sourceMatches: exactPolygonUsdc,
    },
    {
      destinationAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      presentation: LIMITLESS_POLYGON_PUSD_RELAY_PRESENTATION,
      profileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
      routeId: "polygon-pusd-to-base-usdc",
      sourceMatches: exactPolygonPusd,
    },
    {
      destinationAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      presentation: LIMITLESS_POLYGON_USDC_RELAY_PRESENTATION,
      profileId: TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
      routeId: "polygon-usdc-to-base-usdc",
      sourceMatches: exactPolygonUsdc,
    },
    {
      destinationAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      presentation: LIMITLESS_POLYGON_USDCE_RELAY_PRESENTATION,
      profileId: TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID,
      routeId: "polygon-usdce-to-base-usdc",
      sourceMatches: exactPolygonUsdce,
    },
  ]);

function resolvePolygonRelayFundingTarget(
  input: Readonly<{
    automaticConversionEnabled: boolean;
    session: FundingReceiveSession;
  }>,
  spec: TelegramPolygonRelayRouteSpec,
): TelegramFundingTargetCapability | null {
  if (
    !input.automaticConversionEnabled ||
    !sameAsset(input.session.destinationAsset, spec.destinationAsset)
  )
    return null;
  const matches = input.session.receiveTargets.flatMap((target) => {
    if (target.networkId !== "evm:137") return [];
    const accepted = target.acceptedAssets.filter(
      (candidate) =>
        candidate.handling === "automatic_conversion" &&
        spec.sourceMatches(candidate.asset),
    );
    return accepted.length === 1 && accepted[0]
      ? [{ asset: accepted[0].asset, target }]
      : [];
  });
  const match = matches.length === 1 ? matches[0] : null;
  return match
    ? {
        address: match.target.destinationAddress,
        destinationAsset: spec.destinationAsset,
        automaticSourceAsset: match.asset,
        mode: "relay_evm_automatic",
        presentation: spec.presentation,
        receiveTargetId: match.target.receiveTargetId,
      }
    : null;
}

function resolvePolygonRelayFundingTargetChoice(
  input: Readonly<{
    automaticConversionEnabled: boolean;
    session: FundingReceiveSession;
    observationVariants: readonly DirectIngressObservationVariant[];
  }>,
  spec: TelegramPolygonRelayRouteSpec,
): TelegramFundingTargetChoice | null {
  const target = resolvePolygonRelayFundingTarget(input, spec);
  if (!target?.automaticSourceAsset) return null;
  const variants = input.observationVariants
    .filter(
      (variant) =>
        sameAsset(variant.asset, target.automaticSourceAsset as AssetRef) &&
        sameAccountAddress(
          variant.networkId,
          variant.destinationAddress,
          target.address,
        ) &&
        variant.completion.kind === "child_funding_operation",
    )
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  if (!variants.length) return null;
  return {
    address: target.address,
    asset: target.destinationAsset,
    automaticConversion: true,
    mode: target.mode,
    presentation: target.presentation,
    receiveTargetId: target.receiveTargetId,
    automaticVariants: variants,
    variantIds: variants.map((variant) => variant.variantId),
  };
}

function resolvePolygonRelayConsentRoute(
  consent: TelegramFundingConsent,
  spec: TelegramPolygonRelayRouteSpec,
): TelegramFundingRoute | null {
  const policy = parseTelegramRelayEvmAutomationPolicyV3(
    consent.policySnapshot,
  );
  const presentation = parseTelegramFundingRoutePresentation(
    consent.policySnapshot.presentation,
  );
  return consent.automationEnabled &&
    policy &&
    presentation?.routeKey === spec.presentation.routeKey &&
    consent.policySnapshot.presentationMode === "relay_evm_automatic" &&
    policy.profileId === spec.profileId &&
    spec.sourceMatches(policy.sourceAsset) &&
    sameAsset(policy.destinationAsset, spec.destinationAsset) &&
    sameAsset(consent.asset, spec.destinationAsset)
    ? {
        destinationAsset: policy.destinationAsset,
        automaticSourceAsset: policy.sourceAsset,
        mode: "relay_evm_automatic",
        presentation,
      }
    : null;
}

async function resolvePolygonRelayRouteCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingRouteCapabilityInput,
  spec: TelegramPolygonRelayRouteSpec,
): Promise<TelegramFundingRouteCapability | null> {
  const sourceTarget = resolvePolygonRelayFundingTarget(
    { automaticConversionEnabled: true, session: input.session },
    spec,
  );
  if (!sourceTarget?.automaticSourceAsset) return null;
  const capability = await resolveTelegramRelayEvmCapability(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.session.destinationOptionId,
    venueBindingOptionId: input.session.venueBindingOptionId,
    expectedAuthorizationId: input.expectedAuthorizationId,
    expectedAuthorizationFingerprint: input.expectedAuthorizationFingerprint,
    expectedFundingPolicyRevision: input.expectedFundingPolicyRevision,
    profileId: spec.profileId,
    routeId: spec.routeId,
    sourceAsset: sourceTarget.automaticSourceAsset,
    destinationAsset: spec.destinationAsset,
    venueId: spec.presentation.venueId,
    now: input.now,
    lock: input.lock,
  });
  const target = resolvePolygonRelayFundingTarget(
    {
      automaticConversionEnabled: capability.authorization !== null,
      session: input.session,
    },
    spec,
  );
  return target
    ? {
        authorization: capability.authorization,
        decision: capability.decision,
        fundingPolicyRevision: capability.fundingPolicyRevision,
        target,
      }
    : null;
}

async function hasReadyLimitlessFundingDestinationReceipt(
  db: Pick<Pool, "query">,
  contextId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ready: boolean }>(
    `select exists (
       select 1
       from telegram_funding_sessions funding_context
       join funding_receive_receipts funding_receipt
         on funding_receipt.receive_session_id = funding_context.receive_session_id
        and funding_receipt.user_id = funding_context.user_id
       where funding_context.id = $1::uuid
         and funding_receipt.status = 'ready'
         and funding_receipt.handling = 'direct'
         and funding_receipt.network_id = 'evm:8453'
         and lower(funding_receipt.asset_id) = lower($2)
     ) as ready`,
    [contextId, fundingSidecarRuntimeConfig.limitlessUsdcAddress],
  );
  return rows[0]?.ready === true;
}

type TelegramSolanaRetainedRouteSpec = Readonly<{
  destinationAsset: AssetRef;
  mode: "polymarket_solana_sol_retained" | "limitless_solana_sol_retained";
  presentation: TelegramFundingRoutePresentation;
  venueId: "limitless" | "polymarket";
}>;

const TELEGRAM_SOLANA_RETAINED_ROUTE_SPECS: readonly TelegramSolanaRetainedRouteSpec[] =
  Object.freeze([
    {
      destinationAsset: {
        networkId: "evm:137",
        assetId: POLYGON_PUSD,
        decimals: 6,
      },
      mode: "polymarket_solana_sol_retained",
      presentation: POLYMARKET_SOLANA_SOL_RETAINED_PRESENTATION,
      venueId: "polymarket",
    },
    {
      destinationAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      mode: "limitless_solana_sol_retained",
      presentation: LIMITLESS_SOLANA_SOL_RETAINED_PRESENTATION,
      venueId: "limitless",
    },
  ]);

function exactSolanaNativeSol(asset: AssetRef): boolean {
  return sameAsset(asset, SOLANA_NATIVE_ASSET);
}

function fundingPolicyAllowsSolanaRetainedRoute(
  policy: FundingRuntimePolicy,
  spec: TelegramSolanaRetainedRouteSpec,
): boolean {
  const sourceAsset = SOLANA_NATIVE_ASSET;
  return (
    policy.creationMode === "on" &&
    fundingReceiveAssetEnabled(policy, sourceAsset) &&
    fundingVenueReceiveEnabled(policy, spec.venueId) &&
    policy.routes.some(
      (route) =>
        route.enabled &&
        route.providerId === "relay" &&
        sameAsset(route.sourceAsset, sourceAsset) &&
        sameAsset(route.destinationAsset, spec.destinationAsset),
    )
  );
}

export function telegramSolanaRetainedDepositRouteForPolicy(
  policy: FundingRuntimePolicy,
): Readonly<{
  choiceToken: string;
  routeKey: TelegramFundingDepositRouteKey;
  venueId: "limitless" | "polymarket";
}> | null {
  for (const spec of TELEGRAM_SOLANA_RETAINED_ROUTE_SPECS) {
    if (!fundingPolicyAllowsSolanaRetainedRoute(policy, spec)) continue;
    const descriptor = telegramFundingRouteDescriptorForRouteKey(
      spec.presentation.routeKey,
    );
    if (descriptor?.depositMenu) return descriptor;
  }
  return null;
}

function resolveSolanaRetainedTarget(
  input: Readonly<{ session: FundingReceiveSession }>,
  spec: TelegramSolanaRetainedRouteSpec,
): TelegramFundingTargetCapability | null {
  if (!sameAsset(input.session.destinationAsset, spec.destinationAsset)) {
    return null;
  }
  const matches = input.session.receiveTargets.flatMap((target) => {
    if (target.networkId !== "solana:mainnet") return [];
    const accepted = target.acceptedAssets.filter(
      (candidate) =>
        candidate.handling === "direct" &&
        exactSolanaNativeSol(candidate.asset),
    );
    return accepted.length === 1 && accepted[0]
      ? [{ asset: accepted[0].asset, target }]
      : [];
  });
  const match = matches.length === 1 ? matches[0] : null;
  return match
    ? {
        address: match.target.destinationAddress,
        destinationAsset: spec.destinationAsset,
        automaticSourceAsset: match.asset,
        mode: spec.mode,
        presentation: spec.presentation,
        receiveTargetId: match.target.receiveTargetId,
      }
    : null;
}

function resolveSolanaRetainedChoice(
  input: Readonly<{
    session: FundingReceiveSession;
    observationVariants: readonly DirectIngressObservationVariant[];
  }>,
  spec: TelegramSolanaRetainedRouteSpec,
): TelegramFundingTargetChoice | null {
  const target = resolveSolanaRetainedTarget(input, spec);
  if (!target?.automaticSourceAsset) return null;
  const variants = input.observationVariants.filter(
    (variant) =>
      exactSolanaNativeSol(variant.asset) &&
      sameAccountAddress(
        variant.networkId,
        variant.destinationAddress,
        target.address,
      ) &&
      variant.completion.kind === "retained_owned_source_credit",
  );
  if (variants.length !== 1 || !variants[0]) return null;
  return {
    address: target.address,
    asset: target.automaticSourceAsset,
    automaticConversion: false,
    mode: spec.mode,
    presentation: spec.presentation,
    receiveTargetId: target.receiveTargetId,
    automaticVariants: [],
    variantIds: [variants[0].variantId],
  };
}

function resolveSolanaRetainedConsentRoute(
  consent: TelegramFundingConsent,
  spec: TelegramSolanaRetainedRouteSpec,
): TelegramFundingRoute | null {
  const presentation = parseTelegramFundingRoutePresentation(
    consent.policySnapshot.presentation,
  );
  return !consent.automationEnabled &&
    consent.policySnapshot.presentationMode === spec.mode &&
    presentation?.routeKey === spec.presentation.routeKey &&
    exactSolanaNativeSol(consent.asset)
    ? {
        destinationAsset: spec.destinationAsset,
        automaticSourceAsset: SOLANA_NATIVE_ASSET,
        mode: spec.mode,
        presentation,
      }
    : null;
}

type TelegramFundingRouteAdapter = Readonly<{
  adapterKey: string;
  listedByDefault: boolean;
  profileId: string;
  routeKeys: ReadonlySet<string>;
  venueId: string;
  resolveDestination: (input: {
    controllerWalletId: string | null;
    destinations: readonly FundingDestinationOption[];
  }) => FundingDestinationOption | null;
  resolveCurrentController: (input: {
    currentControllerWalletId: string | null;
    frozenControllerWalletId: string;
  }) => string | null;
  resolveConsentRoute: (
    consent: TelegramFundingConsent,
  ) => TelegramFundingRoute | null;
  resolveTarget: (input: {
    automaticConversionEnabled: boolean;
    session: FundingReceiveSession;
  }) => TelegramFundingTargetCapability | null;
  resolveTargetChoice: (input: {
    automaticConversionEnabled: boolean;
    session: FundingReceiveSession;
    observationVariants: readonly DirectIngressObservationVariant[];
  }) => TelegramFundingTargetChoice | null;
  resolveCapability: (
    db: Pick<Pool, "query">,
    input: TelegramFundingRouteCapabilityInput,
  ) => Promise<TelegramFundingRouteCapability | null>;
  resolveAutomaticCapability: (
    db: Pick<Pool, "query">,
    input: TelegramFundingAutomaticCapabilityInput,
  ) => Promise<TelegramFundingAutomaticCapability | null>;
  buildAutomaticPolicy: (
    input: TelegramFundingAutomaticPolicyInput,
  ) => JsonRecord | null;
  prepareAutomaticVariants: (
    variants: readonly DirectIngressObservationVariant[],
  ) => Promise<readonly DirectIngressObservationVariant[]>;
  resolveReceiptDisposition: (
    target: FundingReceiveReceiptRoutingTarget,
  ) => FundingReceiveReceiptDisposition;
  reviewQuotePlan: (
    target: FundingReceiveReceiptRoutingTarget,
  ) => FundingReceiveQuotePlan | null;
  hasReadyDestinationReceipt: (
    db: Pick<Pool, "query">,
    contextId: string,
  ) => Promise<boolean>;
}>;

function createPolygonRelayFundingAdapter(
  spec: TelegramPolygonRelayRouteSpec,
): TelegramFundingRouteAdapter {
  return Object.freeze({
    adapterKey: RELAY_RECEIVE_OPERATION_ADAPTER_KEY,
    listedByDefault: true,
    profileId: spec.profileId,
    venueId: spec.presentation.venueId,
    routeKeys: new Set<string>([spec.presentation.routeKey]),
    resolveConsentRoute: (consent) =>
      resolvePolygonRelayConsentRoute(consent, spec),
    resolveDestination: () => null,
    resolveCurrentController: ({
      currentControllerWalletId,
      frozenControllerWalletId,
    }) =>
      currentControllerWalletId === frozenControllerWalletId
        ? frozenControllerWalletId
        : null,
    resolveTarget: (input) => resolvePolygonRelayFundingTarget(input, spec),
    resolveTargetChoice: (input) =>
      resolvePolygonRelayFundingTargetChoice(input, spec),
    resolveCapability: (db, input) =>
      resolvePolygonRelayRouteCapability(db, input, spec),
    resolveAutomaticCapability: resolvePolygonRelayAutomaticCapability,
    buildAutomaticPolicy: buildPolymarketBaseAutomaticPolicy,
    prepareAutomaticVariants: initializeCanonicalFundingReceiveEventCursors,
    hasReadyDestinationReceipt: hasReadyRelayFundingDestinationReceipt,
    reviewQuotePlan: (target) =>
      relayReceiveQuotePlan({
        receiptAsset: target.receipt.asset,
        destinationAsset: target.destinationAsset,
        rawAmount: target.receipt.rawAmount,
      }),
    resolveReceiptDisposition: (target) => {
      const execution = resolveRelayReceiptExecution(target);
      return execution
        ? {
            kind: "automatic_execution",
            execution,
            quotePlan: execution.quotePlan(target),
          }
        : { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" };
    },
  });
}

function createSolanaRetainedFundingAdapter(
  spec: TelegramSolanaRetainedRouteSpec,
): TelegramFundingRouteAdapter {
  return Object.freeze({
    adapterKey: "solana_sol_retained_v1",
    listedByDefault: true,
    profileId: "solana_sol_retained_v1",
    venueId: spec.venueId,
    routeKeys: new Set<string>([spec.presentation.routeKey]),
    resolveConsentRoute: (consent) =>
      resolveSolanaRetainedConsentRoute(consent, spec),
    // Existing venue adapters own destination selection. This adapter adds an
    // owned receive source for that already selected destination.
    resolveDestination: () => null,
    resolveCurrentController: ({
      currentControllerWalletId,
      frozenControllerWalletId,
    }) =>
      currentControllerWalletId === frozenControllerWalletId
        ? frozenControllerWalletId
        : null,
    resolveTarget: (input) => resolveSolanaRetainedTarget(input, spec),
    resolveTargetChoice: (input) => resolveSolanaRetainedChoice(input, spec),
    resolveCapability: async (db, input) => {
      const target = resolveSolanaRetainedTarget(input, spec);
      if (!target?.automaticSourceAsset) return null;
      if (
        !(await isTelegramFundingManagedSolanaWalletCurrent(db, {
          telegramAccountId: input.telegramAccountId,
          telegramUserId: input.telegramUserId,
          userId: input.userId,
          walletAddress: target.address,
        }))
      ) {
        return null;
      }
      const fundingPolicy = await resolveFundingControlPlaneSnapshot(db);
      return fundingPolicyAllowsSolanaRetainedRoute(fundingPolicy.runtime, spec)
        ? {
            authorization: null,
            decision: { kind: "allowed" },
            fundingPolicyRevision: fundingPolicy.revision,
            target,
          }
        : null;
    },
    resolveAutomaticCapability: async () => null,
    buildAutomaticPolicy: () => null,
    prepareAutomaticVariants: async (variants) => variants,
    resolveReceiptDisposition: (target) =>
      target.receipt.handling === "direct" &&
      exactSolanaNativeSol(target.receipt.asset)
        ? { kind: "direct" }
        : { kind: "hard_invalid", reasonCode: "unsupported_asset" },
    reviewQuotePlan: () => null,
    // Retained SOL is an owned source, never proof that venue funding is
    // ready. The generic Mini App planner performs the later conversion.
    hasReadyDestinationReceipt: async () => false,
  });
}

function resolvePolymarketPusdDestination(input: {
  controllerWalletId: string | null;
  destinations: readonly FundingDestinationOption[];
}): FundingDestinationOption | null {
  const matches = input.destinations.filter(
    (destination) =>
      destination.venueId === "polymarket" &&
      destination.selectable &&
      exactPolygonPusd(destination.requiredAsset) &&
      (input.controllerWalletId === null ||
        destination.controllerWalletId === input.controllerWalletId),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const POLYMARKET_POLYGON_DIRECT_FUNDING_ADAPTER = Object.freeze({
  adapterKey: "polymarket_polygon_pusd_direct_v1",
  listedByDefault: true,
  profileId: "polymarket_polygon_pusd_direct_v1",
  venueId: "polymarket",
  routeKeys: new Set<string>([
    POLYMARKET_POLYGON_PUSD_DIRECT_PRESENTATION.routeKey,
  ]),
  resolveConsentRoute: resolvePolymarketDirectConsentRoute,
  resolveDestination: resolvePolymarketPusdDestination,
  resolveCurrentController: ({
    currentControllerWalletId,
    frozenControllerWalletId,
  }) =>
    currentControllerWalletId === frozenControllerWalletId
      ? frozenControllerWalletId
      : null,
  resolveTarget: resolvePolymarketPolygonDirectTarget,
  resolveTargetChoice: resolvePolymarketPolygonDirectChoice,
  resolveCapability: resolvePolymarketDirectRouteCapability,
  resolveAutomaticCapability: async () => null,
  buildAutomaticPolicy: () => null,
  prepareAutomaticVariants: async (variants) => variants,
  hasReadyDestinationReceipt: hasReadyPolymarketDirectDestinationReceipt,
  reviewQuotePlan: () => null,
  resolveReceiptDisposition: (target) =>
    target.receipt.handling === "direct"
      ? { kind: "direct" }
      : { kind: "hard_invalid", reasonCode: "unsupported_asset" },
}) satisfies TelegramFundingRouteAdapter;

const POLYMARKET_BASE_RELAY_FUNDING_ADAPTER = Object.freeze({
  adapterKey: RELAY_RECEIVE_OPERATION_ADAPTER_KEY,
  listedByDefault: true,
  profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  venueId: "polymarket",
  routeKeys: new Set<string>([POLYMARKET_BASE_USDC_PRESENTATION.routeKey]),
  resolveConsentRoute: resolvePolymarketBaseConsentRoute,
  // Destination selection is venue-owned by the Polygon adapter; this adapter
  // owns only the Base ingress choice for that same frozen destination.
  resolveDestination: () => null,
  resolveCurrentController: ({
    currentControllerWalletId,
    frozenControllerWalletId,
  }) =>
    currentControllerWalletId === frozenControllerWalletId
      ? frozenControllerWalletId
      : null,
  resolveTarget: resolvePolymarketBaseFundingTarget,
  resolveTargetChoice: resolvePolymarketBaseFundingTargetChoice,
  resolveCapability: resolvePolymarketBaseRouteCapability,
  resolveAutomaticCapability: resolvePolymarketBaseAutomaticCapability,
  buildAutomaticPolicy: buildPolymarketBaseAutomaticPolicy,
  prepareAutomaticVariants: initializeCanonicalFundingReceiveEventCursors,
  hasReadyDestinationReceipt: hasReadyRelayFundingDestinationReceipt,
  reviewQuotePlan: (target) =>
    relayReceiveQuotePlan({
      receiptAsset: target.receipt.asset,
      destinationAsset: target.destinationAsset,
      rawAmount: target.receipt.rawAmount,
    }),
  resolveReceiptDisposition: (target) => {
    const execution = resolveRelayReceiptExecution(target);
    return execution
      ? {
          kind: "automatic_execution",
          execution,
          quotePlan: execution.quotePlan(target),
        }
      : {
          kind: "hard_invalid",
          reasonCode: "delegated_authority_invalid",
        };
  },
}) satisfies TelegramFundingRouteAdapter;

const LIMITLESS_BASE_DIRECT_FUNDING_ADAPTER = Object.freeze({
  adapterKey: "limitless_base_usdc_direct_v1",
  listedByDefault: true,
  profileId: "limitless_base_usdc_direct_v1",
  venueId: "limitless",
  routeKeys: new Set<string>([
    LIMITLESS_BASE_USDC_DIRECT_PRESENTATION.routeKey,
  ]),
  resolveConsentRoute: resolveLimitlessFundingConsentRoute,
  resolveDestination: ({ controllerWalletId, destinations }) => {
    const matches = destinations.filter(
      (destination) =>
        destination.venueId === "limitless" &&
        destination.selectable &&
        exactLimitlessBaseUsdc(destination.requiredAsset) &&
        (controllerWalletId === null ||
          destination.controllerWalletId === controllerWalletId),
    );
    return matches.length === 1 ? (matches[0] ?? null) : null;
  },
  resolveCurrentController: ({
    currentControllerWalletId,
    frozenControllerWalletId,
  }) =>
    currentControllerWalletId === frozenControllerWalletId
      ? frozenControllerWalletId
      : null,
  resolveTarget: resolveLimitlessFundingTarget,
  resolveTargetChoice: resolveLimitlessFundingTargetChoice,
  resolveCapability: async (_db, input) => {
    const target = resolveLimitlessFundingTarget(input);
    return target
      ? {
          authorization: null,
          decision: { kind: "allowed" },
          fundingPolicyRevision: "limitless_direct_receive_v1",
          target,
        }
      : null;
  },
  resolveAutomaticCapability: async () => null,
  buildAutomaticPolicy: () => null,
  prepareAutomaticVariants: async (variants) => variants,
  hasReadyDestinationReceipt: hasReadyLimitlessFundingDestinationReceipt,
  reviewQuotePlan: () => null,
  resolveReceiptDisposition: (target) =>
    target.receipt.handling === "direct"
      ? { kind: "direct" }
      : { kind: "hard_invalid", reasonCode: "unsupported_asset" },
}) satisfies TelegramFundingRouteAdapter;

const POLYGON_RELAY_FUNDING_ADAPTERS = Object.freeze(
  TELEGRAM_POLYGON_RELAY_ROUTE_SPECS.map(createPolygonRelayFundingAdapter),
);
const SOLANA_RETAINED_FUNDING_ADAPTERS = Object.freeze(
  TELEGRAM_SOLANA_RETAINED_ROUTE_SPECS.map(createSolanaRetainedFundingAdapter),
);

// This registry is intentionally data-small. A route adapter owns all
// provider/venue-specific facts; the surrounding session, projection,
// delivery, and receipt state machines select it by immutable route/profile
// identity and never branch on Polygon, Polymarket, or asset symbols.
const TELEGRAM_FUNDING_ROUTE_ADAPTERS = Object.freeze([
  POLYMARKET_POLYGON_DIRECT_FUNDING_ADAPTER,
  POLYMARKET_BASE_RELAY_FUNDING_ADAPTER,
  LIMITLESS_BASE_DIRECT_FUNDING_ADAPTER,
  ...POLYGON_RELAY_FUNDING_ADAPTERS,
  ...SOLANA_RETAINED_FUNDING_ADAPTERS,
]);

function adapterForRouteKey(
  routeKey: string,
): TelegramFundingRouteAdapter | null {
  const matches = TELEGRAM_FUNDING_ROUTE_ADAPTERS.filter((adapter) =>
    adapter.routeKeys.has(routeKey),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function adapterForConsent(
  consent: TelegramFundingConsent,
): TelegramFundingRouteAdapter | null {
  return adapterForPolicySnapshot(consent.policySnapshot);
}

function adapterForPolicySnapshot(
  policySnapshot: unknown,
): TelegramFundingRouteAdapter | null {
  const snapshot = record(policySnapshot);
  if (!snapshot) return null;
  const presentation = parseTelegramFundingRoutePresentation(
    snapshot.presentation,
  );
  return presentation ? adapterForRouteKey(presentation.routeKey) : null;
}

export function resolveTelegramFundingConsentRoute(
  consent: TelegramFundingConsent,
): TelegramFundingRoute | null {
  return adapterForConsent(consent)?.resolveConsentRoute(consent) ?? null;
}

/** Compatibility export for existing Polygon-specific tests and callers. */
export function resolveTelegramPolygonFundingTarget(input: {
  automaticUsdceEnabled: boolean;
  session: FundingReceiveSession;
}): TelegramFundingTargetCapability | null {
  void input.automaticUsdceEnabled;
  return POLYMARKET_POLYGON_DIRECT_FUNDING_ADAPTER.resolveTarget(input);
}

export function resolveTelegramFundingTarget(input: {
  automaticConversionEnabled: boolean;
  session: FundingReceiveSession;
}): TelegramFundingTargetCapability | null {
  const targets = resolveTelegramFundingTargets(input);
  return targets.length === 1 ? (targets[0] ?? null) : null;
}

export function resolveTelegramFundingTargets(input: {
  automaticConversionEnabled: boolean;
  session: FundingReceiveSession;
}): readonly TelegramFundingTargetCapability[] {
  return TELEGRAM_FUNDING_ROUTE_ADAPTERS.filter(
    (adapter) => adapter.listedByDefault,
  ).flatMap((adapter) => {
    const target = adapter.resolveTarget(input);
    return target ? [target] : [];
  });
}

export function resolveTelegramFundingDestination(input: {
  controllerWalletId: string | null;
  destinations: readonly FundingDestinationOption[];
  venueId: string;
}): FundingDestinationOption | null {
  const matches = TELEGRAM_FUNDING_ROUTE_ADAPTERS.flatMap((adapter) => {
    if (adapter.venueId !== input.venueId) return [];
    const destination = adapter.resolveDestination(input);
    return destination ? [destination] : [];
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function resolveTelegramFundingCurrentController(input: {
  currentControllerWalletId: string | null;
  frozenControllerWalletId: string;
  session: FundingReceiveSession;
}): string | null {
  const controllers = new Set(
    TELEGRAM_FUNDING_ROUTE_ADAPTERS.flatMap((adapter) => {
      if (
        adapter.resolveTarget({
          automaticConversionEnabled: true,
          session: input.session,
        }) === null
      ) {
        return [];
      }
      const controller = adapter.resolveCurrentController(input);
      return controller ? [controller] : [];
    }),
  );
  return controllers.size === 1 ? ([...controllers][0] ?? null) : null;
}

export function resolveTelegramFundingTargetChoice(input: {
  automaticConversionEnabled: boolean;
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
  routeKey?: string;
}): TelegramFundingTargetChoice | null {
  const adapters = input.routeKey
    ? TELEGRAM_FUNDING_ROUTE_ADAPTERS.filter((adapter) =>
        adapter.routeKeys.has(input.routeKey as string),
      )
    : TELEGRAM_FUNDING_ROUTE_ADAPTERS.filter(
        (adapter) => adapter.listedByDefault,
      );
  const choices = adapters.flatMap((adapter) => {
    const choice = adapter.resolveTargetChoice(input);
    return choice ? [choice] : [];
  });
  return choices.length === 1 ? (choices[0] ?? null) : null;
}

async function resolvePolymarketDirectRouteCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingRouteCapabilityInput,
): Promise<TelegramFundingRouteCapability | null> {
  const target = resolvePolymarketPolygonDirectTarget({
    session: input.session,
  });
  if (!target) return null;
  const fundingPolicy = await resolveFundingControlPlaneSnapshot(db);
  return {
    authorization: null,
    decision: { kind: "allowed" },
    fundingPolicyRevision: fundingPolicy.revision,
    target,
  };
}

export async function resolveTelegramFundingRouteCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingRouteCapabilityInput,
): Promise<TelegramFundingRouteCapability | null> {
  const capabilities = await resolveTelegramFundingRouteCapabilities(db, input);
  return capabilities.length === 1 ? (capabilities[0] ?? null) : null;
}

export async function resolveTelegramFundingRouteCapabilities(
  db: Pick<Pool, "query">,
  input: TelegramFundingRouteCapabilityInput,
): Promise<readonly TelegramFundingRouteCapability[]> {
  const adapters = input.routeKey
    ? TELEGRAM_FUNDING_ROUTE_ADAPTERS.filter((adapter) =>
        adapter.routeKeys.has(input.routeKey as string),
      )
    : TELEGRAM_FUNDING_ROUTE_ADAPTERS.filter(
        (adapter) => adapter.listedByDefault,
      );
  return (
    await Promise.all(
      adapters.map((adapter) => adapter.resolveCapability(db, input)),
    )
  ).filter((value): value is TelegramFundingRouteCapability => value != null);
}

export async function resolveTelegramFundingConsentCapability(
  db: Pick<Pool, "query">,
  input: Readonly<{
    consent: TelegramFundingConsent;
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<Readonly<{
  authorization: TelegramFundingAuthorization | null;
  decision: DelegatedFundingPreBroadcastDecision;
  expectedFundingPolicyRevision: string;
  fundingPolicyRevision: string;
}> | null> {
  return resolveTelegramFundingAutomaticCapability(db, {
    ...input,
    policySnapshot: input.consent.policySnapshot,
  });
}

export async function resolveTelegramFundingAutomaticCapability(
  db: Pick<Pool, "query">,
  input: TelegramFundingAutomaticCapabilityInput,
): Promise<TelegramFundingAutomaticCapability | null> {
  return (
    (await adapterForPolicySnapshot(
      input.policySnapshot,
    )?.resolveAutomaticCapability(db, input)) ?? null
  );
}

export function buildTelegramFundingAutomaticPolicyForRoute(
  input: TelegramFundingAutomaticPolicyInput,
): JsonRecord | null {
  return (
    adapterForRouteKey(
      input.choice.presentation.routeKey,
    )?.buildAutomaticPolicy(input) ?? null
  );
}

export async function prepareTelegramFundingAutomaticVariantsForRoute(input: {
  presentation: TelegramFundingRoutePresentation;
  variants: readonly DirectIngressObservationVariant[];
}): Promise<readonly DirectIngressObservationVariant[] | null> {
  const adapter = adapterForRouteKey(input.presentation.routeKey);
  if (!adapter) return null;
  return adapter.prepareAutomaticVariants(input.variants);
}

export async function hasReadyTelegramFundingDestinationReceipt(
  db: Pick<Pool, "query">,
  contextId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ presentation: unknown }>(
    `
      select consent.automation_policy_snapshot -> 'presentation' as presentation
      from telegram_funding_sessions context
      join telegram_funding_consents consent
        on consent.telegram_funding_session_id = context.id
       and consent.revision = context.active_consent_revision
      where context.id = $1::uuid
      limit 1
    `,
    [contextId],
  );
  const presentation = parseTelegramFundingRoutePresentation(
    rows[0]?.presentation,
  );
  const adapter = presentation
    ? adapterForRouteKey(presentation.routeKey)
    : null;
  return adapter ? adapter.hasReadyDestinationReceipt(db, contextId) : false;
}

export function resolveTelegramFundingReceiptExecution(
  target: FundingReceiveReceiptRoutingTarget,
): TelegramFundingReceiptExecution | null {
  const presentation = parseTelegramFundingRoutePresentation(
    target.telegramAutomationPolicy?.presentation,
  );
  return presentation
    ? (() => {
        const disposition = adapterForRouteKey(
          presentation.routeKey,
        )?.resolveReceiptDisposition(target);
        return disposition?.kind === "automatic_execution"
          ? disposition.execution
          : null;
      })()
    : null;
}

export function resolveTelegramFundingReceiptDisposition(
  target: FundingReceiveReceiptRoutingTarget,
  operationPreparers: ReadonlyMap<
    string,
    TelegramFundingReceiptOperationPreparer
  > = new Map(),
): FundingReceiveReceiptDisposition {
  const presentation = parseTelegramFundingRoutePresentation(
    target.telegramAutomationPolicy?.presentation,
  );
  const adapter = presentation
    ? adapterForRouteKey(presentation.routeKey)
    : null;
  if (!adapter) {
    return {
      kind: "hard_invalid",
      reasonCode: "funding_route_adapter_unavailable",
    };
  }
  if (target.receipt.handling === "review_required") {
    const quotePlan = adapter.reviewQuotePlan(target);
    return presentation?.reviewAction && quotePlan
      ? {
          kind: "review_required",
          continuation: presentation.reviewAction,
          quotePlan,
        }
      : {
          kind: "hard_invalid",
          reasonCode: "funding_review_action_unavailable",
        };
  }
  const disposition = adapter.resolveReceiptDisposition(target);
  if (disposition.kind !== "automatic_execution" || !disposition.execution) {
    return disposition;
  }
  const prepareOperation = operationPreparers.get(
    disposition.execution.adapterKey,
  );
  return prepareOperation
    ? {
        ...disposition,
        execution: { ...disposition.execution, prepareOperation },
      }
    : disposition;
}

/** Compatibility name for pUSD-only callers and tests. */
export function resolveTelegramDirectPusdChoice(input: {
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}) {
  return resolveTelegramFundingTargetChoice({
    ...input,
    automaticConversionEnabled: false,
  });
}
