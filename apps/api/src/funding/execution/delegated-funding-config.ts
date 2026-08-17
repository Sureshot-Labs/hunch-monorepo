import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";

import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
} from "./delegated-funding-profile-ids.js";
import { DELEGATED_PROVIDER_REPLAY_MS } from "./delegated-funding-recovery-policy.js";
import { privyAuthorizationPrivateKeyIsValid } from "./privy-authorization-key.js";

type Environment = Readonly<Record<string, string | undefined>>;

function value(source: Environment, key: string): string {
  return source[key]?.trim() ?? "";
}

function enabled(source: Environment, key: string): boolean {
  return ["1", "true", "yes", "on"].includes(value(source, key).toLowerCase());
}

export type PolymarketWrapExecutionConfiguration = Readonly<{
  enabled: boolean;
  profileId: typeof POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
  signerId: string;
  signerFingerprint: string;
  policyId: string;
  policyFingerprint: string;
}>;

export type RelayEvmExecutionConfiguration = Readonly<{
  enabled: boolean;
  profileId: typeof TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID;
  signerId: string;
  signerFingerprint: string;
  policyId: string;
  policyFingerprint: string;
  maxSourceRaw: string;
  minimumSequentialTtlMs: number;
}>;

/**
 * A Relay EVM route contains two signed calls (approve, then deposit). Its
 * provider quote must survive both calls and the conservative replay window
 * used after a durable provider boundary. This is distinct from a market
 * quote's short user-confirmation TTL.
 */
export function relayEvmSequentialQuoteTtlMs(
  configuration: Pick<RelayEvmExecutionConfiguration, "minimumSequentialTtlMs">,
): number {
  return (
    DELEGATED_PROVIDER_REPLAY_MS + configuration.minimumSequentialTtlMs + 30_000
  );
}

export function loadRelayEvmExecutionConfiguration(
  source: Environment = process.env,
): RelayEvmExecutionConfiguration {
  const maxSourceRaw = value(source, "HUNCH_FUNDING_RELAY_EVM_MAX_SOURCE_RAW");
  const ttl = Number(value(source, "HUNCH_FUNDING_RELAY_EVM_MIN_TTL_MS"));
  return {
    enabled:
      enabled(source, "HUNCH_FINANCE_EXECUTE") &&
      enabled(source, "HUNCH_FUNDING_RELAY_EVM_EXECUTE"),
    profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    signerId: value(source, "PRIVY_WALLET_AUTHORIZATION_ID"),
    signerFingerprint: value(source, "PRIVY_WALLET_AUTHORIZATION_FINGERPRINT"),
    policyId: value(source, "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID"),
    policyFingerprint: value(
      source,
      "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT",
    ),
    maxSourceRaw,
    minimumSequentialTtlMs: Number.isSafeInteger(ttl) && ttl > 0 ? ttl : 45_000,
  };
}

export function relayEvmProfileConfigured(
  config: RelayEvmExecutionConfiguration,
): boolean {
  return (
    config.signerId.length >= 3 &&
    config.signerFingerprint.length >= 32 &&
    config.policyId.length >= 3 &&
    config.policyFingerprint.length >= 32 &&
    /^[1-9][0-9]*$/u.test(config.maxSourceRaw) &&
    config.minimumSequentialTtlMs >= 30_000
  );
}

export function relayEvmExecutionConfigurationReady(
  config: RelayEvmExecutionConfiguration,
): boolean {
  return config.enabled && relayEvmProfileConfigured(config);
}

export function loadPolymarketWrapExecutionConfiguration(
  source: Environment = process.env,
): PolymarketWrapExecutionConfiguration {
  return {
    enabled:
      enabled(source, "HUNCH_FINANCE_EXECUTE") &&
      enabled(source, "HUNCH_FUNDING_PM_WRAP_EXECUTE"),
    profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    signerId: value(source, "PRIVY_WALLET_AUTHORIZATION_ID"),
    signerFingerprint: value(source, "PRIVY_WALLET_AUTHORIZATION_FINGERPRINT"),
    policyId: value(source, "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID"),
    policyFingerprint: value(
      source,
      "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT",
    ),
  };
}

export function polymarketWrapExecutionConfigurationReady(
  config: PolymarketWrapExecutionConfiguration,
): boolean {
  return config.enabled && polymarketWrapProfileConfigured(config);
}

export function polymarketWrapProfileConfigured(
  config: PolymarketWrapExecutionConfiguration,
): boolean {
  return (
    config.signerId.length >= 3 &&
    config.signerFingerprint.length >= 32 &&
    config.policyId.length >= 3 &&
    config.policyFingerprint.length >= 32
  );
}

export function polymarketWrapExecutorEnvironmentReady(
  source: Environment = process.env,
): boolean {
  const required = [
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "CREDENTIALS_ENCRYPTION_KEY",
    "FUNDING_REFERENCE_LOOKUP_HMAC_KEY",
  ].every((key) => value(source, key).length > 0);
  return (
    required &&
    value(source, "POLYMARKET_FUNDING_ROUTER_ADDRESS").toLowerCase() ===
      POLYMARKET_FUNDING_ROUTER.polygon.toLowerCase() &&
    privyAuthorizationPrivateKeyIsValid(
      value(source, "PRIVY_WALLET_AUTHORIZATION_KEY"),
    )
  );
}
