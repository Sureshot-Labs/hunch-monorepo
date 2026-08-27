import type { Pool } from "@hunch/infra";

import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
} from "../policies/funding-policy-sidecar.js";
import {
  loadRelayEvmExecutionConfiguration,
  relayEvmProfileConfigured,
  type RelayEvmExecutionConfiguration,
  loadPolymarketPusdFundExecutionConfiguration,
  polymarketRouterExecutorEnvironmentReady,
  type PolymarketRouterExecutionConfiguration,
} from "./delegated-funding-config.js";
import {
  classifyPolymarketRouterControlPlane,
  combineDelegatedFundingDecisions,
  fundingPolicyRevisionMayResume,
  type DelegatedFundingPreBroadcastDecision,
} from "./delegated-funding-capability.js";
import {
  resolveCurrentTelegramFundingAuthority,
  type TelegramFundingAuthorization,
} from "./telegram-funding-authorization.js";
import { TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
} from "../../funding-providers/relay/rehearsal.js";
import { parseUsdcToMicro } from "../../lib/usdc.js";

export type ResolvedTelegramPolymarketRouterCapability = Readonly<{
  authorization: TelegramFundingAuthorization | null;
  configuration: PolymarketRouterExecutionConfiguration;
  decision: DelegatedFundingPreBroadcastDecision;
  fundingPolicyRevision: string;
}>;

export function relayEvmUsdCapMatchesRaw(
  capUsd: string | null,
  maxSourceRaw: string,
): boolean {
  return (
    capUsd != null && parseUsdcToMicro(capUsd)?.toString() === maxSourceRaw
  );
}

export async function resolveTelegramPolymarketRouterCapability(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    configuration?: PolymarketRouterExecutionConfiguration;
    expectedAuthorizationId?: string;
    expectedAuthorizationFingerprint?: string;
    expectedFundingPolicyRevision?: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<ResolvedTelegramPolymarketRouterCapability> {
  const configuration =
    input.configuration ?? loadPolymarketPusdFundExecutionConfiguration();
  if (input.lock) await lockFundingPolicyForTransaction(db);
  const policy = await resolveFundingControlPlaneSnapshot(db);
  const authority = await resolveCurrentTelegramFundingAuthority(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    configuration,
    expectedAuthorizationId: input.expectedAuthorizationId,
    expectedAuthorizationFingerprint: input.expectedAuthorizationFingerprint,
    now: input.now,
    lock: input.lock,
  });
  const decision = combineDelegatedFundingDecisions(
    classifyPolymarketRouterControlPlane({ configuration, policy }),
    input.expectedFundingPolicyRevision === undefined ||
      input.expectedFundingPolicyRevision === policy.revision ||
      fundingPolicyRevisionMayResume(policy)
      ? { kind: "allowed" }
      : {
          kind: "hard_invalid",
          reasonCode: "funding_policy_changed",
        },
    polymarketRouterExecutorEnvironmentReady()
      ? { kind: "allowed" }
      : {
          kind: "soft_paused",
          reasonCode: "delegated_profile_unavailable",
        },
    authority.kind === "allowed" ? { kind: "allowed" } : authority,
  );
  return {
    authorization:
      decision.kind === "allowed" && authority.kind === "allowed"
        ? authority.authorization
        : null,
    configuration,
    decision,
    fundingPolicyRevision: policy.revision,
  };
}

export type ResolvedTelegramRelayEvmCapability = Readonly<{
  authorization: TelegramFundingAuthorization | null;
  configuration: RelayEvmExecutionConfiguration;
  decision: DelegatedFundingPreBroadcastDecision;
  fundingPolicyRevision: string;
}>;

export async function resolveTelegramRelayEvmCapability(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    configuration?: RelayEvmExecutionConfiguration;
    expectedAuthorizationId?: string;
    expectedAuthorizationFingerprint?: string;
    expectedFundingPolicyRevision?: string;
    profileId?: string;
    routeId?: string;
    sourceAsset?: Readonly<{
      networkId: string;
      assetId: string;
      decimals: number;
    }>;
    destinationAsset?: Readonly<{
      networkId: string;
      assetId: string;
      decimals: number;
    }>;
    venueId?: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<ResolvedTelegramRelayEvmCapability> {
  const configuration =
    input.configuration ?? loadRelayEvmExecutionConfiguration();
  const profileId = input.profileId ?? TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID;
  const routeId = input.routeId ?? "base-usdc-to-polygon-pusd";
  const venueId = input.venueId ?? "polymarket";
  const sourceAsset = input.sourceAsset ?? {
    networkId: "evm:8453",
    assetId: BASE_USDC,
    decimals: 6,
  };
  const destinationAsset = input.destinationAsset ?? {
    networkId: "evm:137",
    assetId: POLYGON_PUSD,
    decimals: 6,
  };
  if (input.lock) await lockFundingPolicyForTransaction(db);
  const policy = await resolveFundingControlPlaneSnapshot(db);
  const controlDecision: DelegatedFundingPreBroadcastDecision =
    policy.invalidStoredPolicy ||
    policy.policy.paused ||
    policy.runtime.creationMode !== "on" ||
    !policy.runtime.gates.startUnsubmittedAction ||
    policy.runtime.gates.emergencyBroadcastPause
      ? { kind: "soft_paused", reasonCode: "funding_policy_paused" }
      : !configuration.enabled || !relayEvmProfileConfigured(configuration)
        ? { kind: "soft_paused", reasonCode: "delegated_profile_unavailable" }
        : policy.runtime.routes.filter(
              (route) =>
                route.enabled &&
                route.providerId === "relay" &&
                route.routeId === routeId &&
                route.sourceAsset.networkId === sourceAsset.networkId &&
                route.sourceAsset.assetId.toLowerCase() ===
                  sourceAsset.assetId.toLowerCase() &&
                route.destinationAsset.networkId ===
                  destinationAsset.networkId &&
                route.destinationAsset.assetId.toLowerCase() ===
                  destinationAsset.assetId.toLowerCase(),
            ).length !== 1 ||
            !policy.runtime.venues.some(
              (venue) =>
                venue.venueId === venueId &&
                venue.delegatedExecutionEnabled &&
                venue.delegatedPolicyIds.includes(profileId),
            )
          ? { kind: "hard_invalid", reasonCode: "delegated_route_changed" }
          : { kind: "allowed" };
  const authority = await resolveCurrentTelegramFundingAuthority(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    configuration,
    profileId,
    securityClass: "routed_value_movement",
    sourceAsset,
    destinationAsset,
    venueId: venueId as "limitless" | "polymarket",
    expectedAuthorizationId: input.expectedAuthorizationId,
    expectedAuthorizationFingerprint: input.expectedAuthorizationFingerprint,
    now: input.now,
    lock: input.lock,
  });
  const revisionDecision: DelegatedFundingPreBroadcastDecision =
    input.expectedFundingPolicyRevision === undefined ||
    input.expectedFundingPolicyRevision === policy.revision ||
    fundingPolicyRevisionMayResume(policy)
      ? { kind: "allowed" }
      : { kind: "hard_invalid", reasonCode: "funding_policy_changed" };
  const capDecision: DelegatedFundingPreBroadcastDecision =
    authority.kind === "allowed" &&
    authority.authorization.maxSourceRaw === configuration.maxSourceRaw &&
    policy.runtime.venues.some((venue) => {
      if (venue.venueId !== venueId || venue.delegatedDailyCapUsd == null) {
        return false;
      }
      return relayEvmUsdCapMatchesRaw(
        venue.delegatedDailyCapUsd,
        configuration.maxSourceRaw,
      );
    })
      ? { kind: "allowed" }
      : { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" };
  const decision = combineDelegatedFundingDecisions(
    controlDecision,
    revisionDecision,
    authority.kind === "allowed" ? { kind: "allowed" } : authority,
    capDecision,
  );
  return {
    authorization:
      decision.kind === "allowed" && authority.kind === "allowed"
        ? authority.authorization
        : null,
    configuration,
    decision,
    fundingPolicyRevision: policy.revision,
  };
}
