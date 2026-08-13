import type { Pool } from "@hunch/infra";

import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
} from "../policies/funding-policy-sidecar.js";
import {
  loadRelayEvmExecutionConfiguration,
  relayEvmProfileConfigured,
  type RelayEvmExecutionConfiguration,
  loadPolymarketWrapExecutionConfiguration,
  polymarketWrapExecutorEnvironmentReady,
  type PolymarketWrapExecutionConfiguration,
} from "./delegated-funding-config.js";
import {
  classifyPolymarketWrapControlPlane,
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

export type ResolvedTelegramPolymarketWrapCapability = Readonly<{
  authorization: TelegramFundingAuthorization | null;
  configuration: PolymarketWrapExecutionConfiguration;
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

export async function resolveTelegramPolymarketWrapCapability(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    configuration?: PolymarketWrapExecutionConfiguration;
    expectedAuthorizationId?: string;
    expectedAuthorizationFingerprint?: string;
    expectedFundingPolicyRevision?: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<ResolvedTelegramPolymarketWrapCapability> {
  const configuration =
    input.configuration ?? loadPolymarketWrapExecutionConfiguration();
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
    classifyPolymarketWrapControlPlane({ configuration, policy }),
    input.expectedFundingPolicyRevision === undefined ||
      input.expectedFundingPolicyRevision === policy.revision ||
      fundingPolicyRevisionMayResume(policy)
      ? { kind: "allowed" }
      : {
          kind: "hard_invalid",
          reasonCode: "funding_policy_changed",
        },
    polymarketWrapExecutorEnvironmentReady()
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
    now?: Date;
    lock?: boolean;
  }>,
): Promise<ResolvedTelegramRelayEvmCapability> {
  const configuration =
    input.configuration ?? loadRelayEvmExecutionConfiguration();
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
                route.routeId === "base-usdc-to-polygon-pusd",
            ).length !== 1 ||
            !policy.runtime.venues.some(
              (venue) =>
                venue.venueId === "polymarket" &&
                venue.delegatedExecutionEnabled &&
                venue.delegatedPolicyIds.includes(
                  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
                ),
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
    profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    securityClass: "routed_value_movement",
    sourceAsset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    destinationAsset: {
      networkId: "evm:137",
      assetId: POLYGON_PUSD,
      decimals: 6,
    },
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
      if (
        venue.venueId !== "polymarket" ||
        venue.delegatedDailyCapUsd == null
      ) {
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
