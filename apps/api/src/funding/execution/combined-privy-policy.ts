import type { PrivyPolicyMetadata } from "../../privy-service.js";
import {
  type PolicyValidationResult,
  type PrivyBotPolicyProfile,
  validatePolymarketBotPolicyProfile,
} from "../../services/polymarket-automation-policy.js";
import {
  polymarketDepositWalletPullPolicyCap,
  relayEvmPolicyRuleKind,
  validateRelayEvmPolicyRules,
} from "./delegated-funding-profiles.js";

export type CombinedPolymarketRelayPolicyValidation = PolicyValidationResult &
  Readonly<{
    relayMaxSourceRaw: bigint | null;
    relayRulesPresent: boolean;
    fundingPullMaxSourceRaw: bigint | null;
    fundingPullRulesPresent: boolean;
  }>;

/**
 * The shared Privy policy is closed over two exact rule families. Rules are
 * removed from the BUY+SELL validator only after they match the complete Relay
 * ABI/target/chain shape; near-matches remain visible and fail that validator.
 */
export function validateCombinedPolymarketRelayPolicy(
  input: Readonly<{
    builderCode: string;
    exchangeAddresses: readonly string[];
    fundingRouterAddress: string;
    fundingPullerAddress?: string;
    maxBuyUsd: number;
    policy: PrivyPolicyMetadata;
    profile: PrivyBotPolicyProfile;
    relayMaxSourceRaw?: string;
  }>,
): CombinedPolymarketRelayPolicyValidation {
  const relayRules = input.policy.rules.filter(
    (rule) => relayEvmPolicyRuleKind(rule) !== null,
  );
  const fundingPullerAddress = input.fundingPullerAddress?.trim() ?? "";
  const fundingPullRules = fundingPullerAddress
    ? input.policy.rules.filter(
        (rule) =>
          polymarketDepositWalletPullPolicyCap(rule, fundingPullerAddress) !=
          null,
      )
    : [];
  const polymarketValidation = validatePolymarketBotPolicyProfile({
    builderCode: input.builderCode,
    exchangeAddresses: input.exchangeAddresses,
    fundingRouterAddress: input.fundingRouterAddress,
    maxBuyUsd: input.maxBuyUsd,
    policy: {
      ...input.policy,
      rules: input.policy.rules.filter(
        (rule) =>
          relayEvmPolicyRuleKind(rule) === null &&
          !fundingPullRules.includes(rule),
      ),
    },
    profile: input.profile,
  });
  if (relayRules.length === 0) {
    const orphanedPullRules = fundingPullRules.length > 0;
    return {
      ...polymarketValidation,
      issues: orphanedPullRules
        ? [
            ...polymarketValidation.issues,
            "Puller automation requires the exact Relay policy family.",
          ]
        : polymarketValidation.issues,
      valid: polymarketValidation.valid && !orphanedPullRules,
      relayMaxSourceRaw: null,
      relayRulesPresent: false,
      fundingPullMaxSourceRaw: null,
      fundingPullRulesPresent: fundingPullRules.length > 0,
    };
  }

  const relayValidation = validateRelayEvmPolicyRules(input.policy.rules);
  const expectedCap = input.relayMaxSourceRaw?.trim() ?? "";
  const capMatches =
    /^[1-9][0-9]*$/u.test(expectedCap) &&
    relayValidation.maxSourceRaw === BigInt(expectedCap);
  const relayIssues = [...relayValidation.issues];
  if (!capMatches) {
    relayIssues.push(
      "Relay policy cap must equal the configured delegated funding cap.",
    );
  }
  const pullCaps = fundingPullRules.map((rule) =>
    polymarketDepositWalletPullPolicyCap(rule, fundingPullerAddress),
  );
  const fundingPullMaxSourceRaw = pullCaps[0] ?? null;
  const pullRulesValid =
    fundingPullRules.length === 0 ||
    (fundingPullRules.length === 1 &&
      fundingPullMaxSourceRaw !== null &&
      fundingPullMaxSourceRaw === relayValidation.maxSourceRaw);
  if (!pullRulesValid) {
    relayIssues.push(
      "Policy must contain at most one exact Puller rule with the configured Relay cap.",
    );
  }
  return {
    ...polymarketValidation,
    issues: [...polymarketValidation.issues, ...relayIssues],
    valid:
      polymarketValidation.valid &&
      relayValidation.valid &&
      capMatches &&
      pullRulesValid,
    relayMaxSourceRaw: relayValidation.maxSourceRaw,
    relayRulesPresent: true,
    fundingPullMaxSourceRaw,
    fundingPullRulesPresent: fundingPullRules.length > 0,
  };
}
