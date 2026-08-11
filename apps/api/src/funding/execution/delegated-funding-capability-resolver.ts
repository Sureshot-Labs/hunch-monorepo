import type { Pool } from "@hunch/infra";

import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
} from "../policies/funding-policy-service.js";
import {
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

export type ResolvedTelegramPolymarketWrapCapability = Readonly<{
  authorization: TelegramFundingAuthorization | null;
  configuration: PolymarketWrapExecutionConfiguration;
  decision: DelegatedFundingPreBroadcastDecision;
  fundingPolicyRevision: string;
}>;

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
  const policy = await resolveFundingPolicy(db);
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
