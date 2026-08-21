import type { AssetRef, JsonValue } from "../domain/types.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import { sameAsset } from "../domain/asset-identity.js";
import type { TelegramFundingAuthorization } from "./telegram-funding-authorization.js";
import { telegramFundingAuthorizationFingerprint } from "./telegram-funding-authorization.js";
import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import { TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS } from "./delegated-funding-profile-ids.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export const TELEGRAM_FUNDING_AUTOMATION_POLICY_VERSION = 2;
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

export type TelegramFundingVariantCursor = Readonly<{
  variantId: string;
  networkId: "evm:137";
  ledgerHeightExclusive: string;
}>;

export type TelegramFundingAutomationPolicyV2 = Readonly<{
  version: 2;
  kind: "polymarket_usdce_full_receipt_wrap";
  profileId: typeof POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
  fullReceipt: true;
  authorizationId: string;
  authorizationFingerprint: string;
  signerId: string;
  signerFingerprint: string;
  policyId: string;
  policyFingerprint: string;
  fundingPolicyRevision: string;
  venueId: "polymarket";
  destinationOptionId: string;
  venueBindingOptionId: string;
  sourceAsset: AssetRef;
  destinationAsset: AssetRef;
  variantCursors: readonly TelegramFundingVariantCursor[];
}>;

function cursor(variant: DirectIngressObservationVariant): string | null {
  const raw = variant.observation.payload.eventCursorBlock;
  return typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw) ? raw : null;
}

export function buildTelegramFundingAutomationPolicyV2(
  input: Readonly<{
    authorization: TelegramFundingAuthorization;
    destinationAsset: AssetRef;
    fundingPolicyRevision: string;
    sourceAsset: AssetRef;
    variants: readonly DirectIngressObservationVariant[];
  }>,
): TelegramFundingAutomationPolicyV2 {
  const variantCursors = input.variants
    .filter(
      (variant) =>
        sameAsset(variant.asset, input.sourceAsset) &&
        variant.networkId === "evm:137",
    )
    .map((variant) => {
      const ledgerHeightExclusive = cursor(variant);
      if (!ledgerHeightExclusive) {
        throw new Error(
          "automatic funding consent requires a current chain cursor",
        );
      }
      return {
        variantId: variant.variantId,
        networkId: "evm:137" as const,
        ledgerHeightExclusive,
      };
    })
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  if (variantCursors.length === 0) {
    throw new Error(
      "automatic funding consent requires an exact USDC.e variant",
    );
  }
  return {
    version: TELEGRAM_FUNDING_AUTOMATION_POLICY_VERSION,
    kind: "polymarket_usdce_full_receipt_wrap",
    profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    fullReceipt: true,
    authorizationId: input.authorization.id,
    authorizationFingerprint: telegramFundingAuthorizationFingerprint(
      input.authorization,
    ),
    signerId: input.authorization.signerId,
    signerFingerprint: input.authorization.signerFingerprint,
    policyId: input.authorization.policyId,
    policyFingerprint: input.authorization.policyFingerprint,
    fundingPolicyRevision: input.fundingPolicyRevision,
    venueId: "polymarket",
    destinationOptionId: input.authorization.destinationOptionId,
    venueBindingOptionId: input.authorization.venueBindingOptionId,
    sourceAsset: input.sourceAsset,
    destinationAsset: input.destinationAsset,
    variantCursors,
  };
}

export function telegramFundingAutomationPolicyMatchesAuthorization(
  policy: TelegramFundingAutomationPolicyV2,
  authorization: TelegramFundingAuthorization,
): boolean {
  return (
    policy.authorizationId === authorization.id &&
    policy.authorizationFingerprint ===
      telegramFundingAuthorizationFingerprint(authorization) &&
    policy.signerId === authorization.signerId &&
    policy.signerFingerprint === authorization.signerFingerprint &&
    policy.policyId === authorization.policyId &&
    policy.policyFingerprint === authorization.policyFingerprint &&
    policy.destinationOptionId === authorization.destinationOptionId &&
    policy.venueBindingOptionId === authorization.venueBindingOptionId &&
    sameAsset(policy.sourceAsset, authorization.sourceAsset) &&
    sameAsset(policy.destinationAsset, authorization.destinationAsset)
  );
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

export function parseTelegramFundingAutomationPolicyV2(
  value: unknown,
): TelegramFundingAutomationPolicyV2 | null {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.version !== TELEGRAM_FUNDING_AUTOMATION_POLICY_VERSION ||
    candidate.kind !== "polymarket_usdce_full_receipt_wrap" ||
    candidate.profileId !== POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID ||
    candidate.fullReceipt !== true ||
    candidate.venueId !== "polymarket"
  ) {
    return null;
  }
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
        typeof candidate[key] !== "string" ||
        String(candidate[key]).trim().length === 0,
    ) ||
    !Array.isArray(candidate.variantCursors)
  ) {
    return null;
  }
  const variantCursors = candidate.variantCursors.flatMap((entry) => {
    const item = record(entry);
    if (
      !item ||
      typeof item.variantId !== "string" ||
      item.networkId !== "evm:137" ||
      typeof item.ledgerHeightExclusive !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(item.ledgerHeightExclusive)
    ) {
      return [];
    }
    return [
      {
        variantId: item.variantId,
        networkId: "evm:137" as const,
        ledgerHeightExclusive: item.ledgerHeightExclusive,
      },
    ];
  });
  if (
    variantCursors.length === 0 ||
    variantCursors.length !== candidate.variantCursors.length
  ) {
    return null;
  }
  return {
    version: 2,
    kind: "polymarket_usdce_full_receipt_wrap",
    profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    fullReceipt: true,
    authorizationId: String(candidate.authorizationId),
    authorizationFingerprint: String(candidate.authorizationFingerprint),
    signerId: String(candidate.signerId),
    signerFingerprint: String(candidate.signerFingerprint),
    policyId: String(candidate.policyId),
    policyFingerprint: String(candidate.policyFingerprint),
    fundingPolicyRevision: String(candidate.fundingPolicyRevision),
    venueId: "polymarket",
    destinationOptionId: String(candidate.destinationOptionId),
    venueBindingOptionId: String(candidate.venueBindingOptionId),
    sourceAsset,
    destinationAsset,
    variantCursors,
  };
}

export function telegramFundingReceiptIsProspectivelyAuthorized(
  input: Readonly<{
    policy: TelegramFundingAutomationPolicyV2;
    variantId: string;
    ledgerHeight: string | null;
  }>,
): boolean {
  if (!input.ledgerHeight || !/^(0|[1-9][0-9]*)$/u.test(input.ledgerHeight)) {
    return false;
  }
  const cursorEntry = input.policy.variantCursors.find(
    (entry) => entry.variantId === input.variantId,
  );
  return (
    cursorEntry != null &&
    BigInt(input.ledgerHeight) > BigInt(cursorEntry.ledgerHeightExclusive)
  );
}

export function telegramFundingAutomationPolicyJson(
  policy: TelegramFundingAutomationPolicyV2,
): JsonRecord {
  return policy as unknown as JsonRecord;
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
      /^(0|[1-9][0-9]*)$/u.test(item.ledgerHeightExclusive)
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
    /^(0|[1-9][0-9]*)$/u.test(input.ledgerHeight) &&
    /^(0|[1-9][0-9]*)$/u.test(input.rawAmount) &&
    BigInt(input.ledgerHeight) > BigInt(cursorEntry.ledgerHeightExclusive) &&
    BigInt(input.rawAmount) > 0n &&
    BigInt(input.rawAmount) <= BigInt(input.policy.maxSourceRaw),
  );
}
