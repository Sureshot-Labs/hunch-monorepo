import type { PrivyPolicyMetadata } from "../../privy-service.js";
import {
  type PolicyValidationResult,
  type PrivyBotPolicyProfile,
  validatePolymarketBotPolicyProfile,
} from "../../services/polymarket-automation-policy.js";
import {
  relayEvmPolicyRuleKind,
  validateRelayEvmPolicyRules,
} from "./delegated-funding-profiles.js";

export type CombinedPolymarketRelayPolicyValidation = PolicyValidationResult &
  Readonly<{
    relayMaxSourceRaw: bigint | null;
    relayRulesPresent: boolean;
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
    maxBuyUsd: number;
    policy: PrivyPolicyMetadata;
    profile: PrivyBotPolicyProfile;
    relayMaxSourceRaw?: string;
  }>,
): CombinedPolymarketRelayPolicyValidation {
  const relayRules = input.policy.rules.filter(
    (rule) => relayEvmPolicyRuleKind(rule) !== null,
  );
  const polymarketValidation = validatePolymarketBotPolicyProfile({
    builderCode: input.builderCode,
    exchangeAddresses: input.exchangeAddresses,
    fundingRouterAddress: input.fundingRouterAddress,
    maxBuyUsd: input.maxBuyUsd,
    policy: {
      ...input.policy,
      rules: input.policy.rules.filter(
        (rule) => relayEvmPolicyRuleKind(rule) === null,
      ),
    },
    profile: input.profile,
  });
  if (relayRules.length === 0) {
    return {
      ...polymarketValidation,
      relayMaxSourceRaw: null,
      relayRulesPresent: false,
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
  return {
    ...polymarketValidation,
    issues: [...polymarketValidation.issues, ...relayIssues],
    valid: polymarketValidation.valid && relayValidation.valid && capMatches,
    relayMaxSourceRaw: relayValidation.maxSourceRaw,
    relayRulesPresent: true,
  };
}
