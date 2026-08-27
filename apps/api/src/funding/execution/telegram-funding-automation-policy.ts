import type { AssetRef } from "../domain/types.js";
import { isPositiveRawAmount, isRawAmount } from "../domain/raw-amount.js";
import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import { sameAsset } from "../domain/asset-identity.js";
import type { TelegramFundingAuthorization } from "./telegram-funding-authorization.js";
import { telegramFundingAuthorizationFingerprint } from "./telegram-funding-authorization.js";
import { TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS } from "./delegated-funding-profile-ids.js";

export const TELEGRAM_RELAY_EVM_AUTOMATION_POLICY_VERSION = 3;

type TelegramRelayEvmFundingProfileId =
  (typeof TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS)[number];
type TelegramRelayIngressNetworkId = "evm:137" | "evm:8453";
type TelegramRelayVenueId = "limitless" | "polymarket";

function isTelegramRelayEvmFundingProfileId(
  value: unknown,
): value is TelegramRelayEvmFundingProfileId {
  return (
    typeof value === "string" &&
    TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS.includes(
      value as TelegramRelayEvmFundingProfileId,
    )
  );
}

function isTelegramRelayIngressNetworkId(
  value: unknown,
): value is TelegramRelayIngressNetworkId {
  return value === "evm:137" || value === "evm:8453";
}

function isTelegramRelayVenueId(value: unknown): value is TelegramRelayVenueId {
  return value === "limitless" || value === "polymarket";
}

function cursor(variant: DirectIngressObservationVariant): string | null {
  const raw = variant.observation.payload.eventCursorBlock;
  return isRawAmount(raw) ? raw : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asset(value: unknown): AssetRef | null {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.networkId !== "string" ||
    typeof candidate.assetId !== "string" ||
    !Number.isInteger(candidate.decimals) ||
    Number(candidate.decimals) < 0 ||
    Number(candidate.decimals) > 36
  ) {
    return null;
  }
  return {
    networkId: candidate.networkId,
    assetId: candidate.assetId,
    decimals: Number(candidate.decimals),
  };
}

export type TelegramRelayEvmAutomationPolicyV3 = Readonly<{
  version: 3;
  kind: "polymarket_base_usdc_relay";
  profileId: TelegramRelayEvmFundingProfileId;
  fullReceipt: false;
  maxSourceRaw: string;
  authorizationId: string;
  authorizationFingerprint: string;
  signerId: string;
  signerFingerprint: string;
  policyId: string;
  policyFingerprint: string;
  fundingPolicyRevision: string;
  venueId: TelegramRelayVenueId;
  destinationOptionId: string;
  venueBindingOptionId: string;
  sourceAsset: AssetRef;
  destinationAsset: AssetRef;
  variantCursors: readonly Readonly<{
    variantId: string;
    networkId: TelegramRelayIngressNetworkId;
    ledgerHeightExclusive: string;
  }>[];
}>;

export function buildTelegramRelayEvmAutomationPolicyV3(
  input: Readonly<{
    authorization: TelegramFundingAuthorization;
    destinationAsset: AssetRef;
    fundingPolicyRevision: string;
    sourceAsset: AssetRef;
    variants: readonly DirectIngressObservationVariant[];
  }>,
): TelegramRelayEvmAutomationPolicyV3 {
  const sourceNetworkId = input.sourceAsset.networkId;
  if (
    !isTelegramRelayEvmFundingProfileId(input.authorization.profileId) ||
    input.authorization.securityClass !== "routed_value_movement" ||
    input.authorization.maxSourceRaw == null ||
    !isPositiveRawAmount(input.authorization.maxSourceRaw) ||
    !isTelegramRelayIngressNetworkId(sourceNetworkId) ||
    !isTelegramRelayVenueId(input.authorization.venueId) ||
    !sameAsset(input.sourceAsset, input.authorization.sourceAsset) ||
    !sameAsset(input.destinationAsset, input.authorization.destinationAsset)
  ) {
    throw new Error("Relay EVM automation requires bounded routed authority");
  }
  const variantCursors = input.variants
    .filter(
      (variant) =>
        variant.networkId === sourceNetworkId &&
        sameAsset(variant.asset, input.sourceAsset),
    )
    .map((variant) => {
      const ledgerHeightExclusive = cursor(variant);
      if (!ledgerHeightExclusive) {
        throw new Error("Relay EVM consent requires a current source cursor");
      }
      return {
        variantId: variant.variantId,
        networkId: sourceNetworkId,
        ledgerHeightExclusive,
      };
    })
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  if (variantCursors.length === 0) {
    throw new Error("Relay EVM consent requires an exact source variant");
  }
  return {
    version: 3,
    kind: "polymarket_base_usdc_relay",
    profileId: input.authorization.profileId,
    fullReceipt: false,
    maxSourceRaw: input.authorization.maxSourceRaw,
    authorizationId: input.authorization.id,
    authorizationFingerprint: telegramFundingAuthorizationFingerprint(
      input.authorization,
    ),
    signerId: input.authorization.signerId,
    signerFingerprint: input.authorization.signerFingerprint,
    policyId: input.authorization.policyId,
    policyFingerprint: input.authorization.policyFingerprint,
    fundingPolicyRevision: input.fundingPolicyRevision,
    venueId: input.authorization.venueId,
    destinationOptionId: input.authorization.destinationOptionId,
    venueBindingOptionId: input.authorization.venueBindingOptionId,
    sourceAsset: input.sourceAsset,
    destinationAsset: input.destinationAsset,
    variantCursors,
  };
}

export function parseTelegramRelayEvmAutomationPolicyV3(
  value: unknown,
): TelegramRelayEvmAutomationPolicyV3 | null {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.version !== 3 ||
    candidate.kind !== "polymarket_base_usdc_relay" ||
    !isTelegramRelayEvmFundingProfileId(candidate.profileId) ||
    candidate.fullReceipt !== false ||
    !isTelegramRelayVenueId(candidate.venueId) ||
    !isPositiveRawAmount(candidate.maxSourceRaw)
  )
    return null;
  const sourceAsset = asset(candidate.sourceAsset);
  const destinationAsset = asset(candidate.destinationAsset);
  const requiredStrings = [
    "authorizationId",
    "authorizationFingerprint",
    "signerId",
    "signerFingerprint",
    "policyId",
    "policyFingerprint",
    "fundingPolicyRevision",
    "destinationOptionId",
    "venueBindingOptionId",
  ] as const;
  if (
    !sourceAsset ||
    !destinationAsset ||
    requiredStrings.some(
      (key) =>
        typeof candidate[key] !== "string" || !String(candidate[key]).trim(),
    ) ||
    !Array.isArray(candidate.variantCursors)
  )
    return null;
  const variantCursors = candidate.variantCursors.flatMap((entry) => {
    const item = record(entry);
    const networkId = item?.networkId;
    return item &&
      typeof item.variantId === "string" &&
      isTelegramRelayIngressNetworkId(networkId) &&
      typeof item.ledgerHeightExclusive === "string" &&
      isRawAmount(item.ledgerHeightExclusive)
      ? [
          {
            variantId: item.variantId,
            networkId: networkId as TelegramRelayIngressNetworkId,
            ledgerHeightExclusive: item.ledgerHeightExclusive,
          },
        ]
      : [];
  });
  if (
    !variantCursors.length ||
    variantCursors.length !== candidate.variantCursors.length
  )
    return null;
  return {
    version: 3,
    kind: "polymarket_base_usdc_relay",
    profileId: candidate.profileId,
    fullReceipt: false,
    maxSourceRaw: candidate.maxSourceRaw,
    authorizationId: String(candidate.authorizationId),
    authorizationFingerprint: String(candidate.authorizationFingerprint),
    signerId: String(candidate.signerId),
    signerFingerprint: String(candidate.signerFingerprint),
    policyId: String(candidate.policyId),
    policyFingerprint: String(candidate.policyFingerprint),
    fundingPolicyRevision: String(candidate.fundingPolicyRevision),
    venueId: candidate.venueId,
    destinationOptionId: String(candidate.destinationOptionId),
    venueBindingOptionId: String(candidate.venueBindingOptionId),
    sourceAsset,
    destinationAsset,
    variantCursors,
  };
}

export function telegramRelayEvmPolicyMatchesAuthorization(
  policy: TelegramRelayEvmAutomationPolicyV3,
  authorization: TelegramFundingAuthorization,
): boolean {
  return (
    policy.authorizationId === authorization.id &&
    policy.authorizationFingerprint ===
      telegramFundingAuthorizationFingerprint(authorization) &&
    policy.maxSourceRaw === authorization.maxSourceRaw &&
    policy.profileId === authorization.profileId &&
    policy.venueId === authorization.venueId &&
    policy.destinationOptionId === authorization.destinationOptionId &&
    policy.venueBindingOptionId === authorization.venueBindingOptionId &&
    policy.signerId === authorization.signerId &&
    policy.signerFingerprint === authorization.signerFingerprint &&
    policy.policyId === authorization.policyId &&
    policy.policyFingerprint === authorization.policyFingerprint &&
    sameAsset(policy.sourceAsset, authorization.sourceAsset) &&
    sameAsset(policy.destinationAsset, authorization.destinationAsset)
  );
}

export function telegramRelayEvmReceiptIsAuthorized(
  input: Readonly<{
    policy: TelegramRelayEvmAutomationPolicyV3;
    variantId: string;
    ledgerHeight: string | null;
    rawAmount: string;
  }>,
): boolean {
  const cursorEntry = input.policy.variantCursors.find(
    (entry) => entry.variantId === input.variantId,
  );
  return Boolean(
    cursorEntry &&
    input.ledgerHeight &&
    isRawAmount(input.ledgerHeight) &&
    isPositiveRawAmount(input.rawAmount) &&
    BigInt(input.ledgerHeight) > BigInt(cursorEntry.ledgerHeightExclusive) &&
    BigInt(input.rawAmount) > 0n &&
    BigInt(input.rawAmount) <= BigInt(input.policy.maxSourceRaw),
  );
}
