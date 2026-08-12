import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  PrivyService,
  type PrivyKeyQuorumMetadata,
  type PrivyManagedWalletMetadata,
  type PrivyPolicyMetadata,
  type PrivyUser,
  type PrivyWalletApiClient,
  type PrivyWalletProfile,
} from "../privy-service.js";
import {
  type DepositWalletBatchTypedData,
  validateCanonicalRedemptionBatch,
} from "./polymarket-deposit-wallet-relayer.js";
import type { TradeIntent, TradeSide, TradingVenue } from "./trading-types.js";
import { tradingError } from "./api-trading-utils.js";
import {
  derivePrivyAuthorizationPublicKey,
  normalizePrivyAuthorizationPublicKey,
} from "../funding/execution/privy-authorization-key.js";
import {
  knownPrivyPolicyFingerprint,
  validateKnownPrivyWalletSigners,
} from "../funding/execution/known-privy-wallet-signers.js";
import {
  canonicalAccountAddress,
  isEvmAddress,
  sameAccountAddress,
} from "../funding/domain/asset-identity.js";
import {
  validatePolymarketBotPolicy,
  validatePolymarketBotPolicyProfile,
  validatePolymarketBotRedeemPolicy,
  validatePolymarketBotSellPolicy,
  validatePolymarketBotTypedData,
  type PolicyValidationResult,
  type PrivyBotPolicyProfile,
} from "./polymarket-automation-policy.js";

export {
  validatePolymarketBotPolicy,
  validatePolymarketBotPolicyProfile,
  validatePolymarketBotRedeemPolicy,
  validatePolymarketBotSellPolicy,
  validatePolymarketBotTypedData,
};
export type {
  PolicyValidationResult,
  PrivyBotPolicyProfile,
} from "./polymarket-automation-policy.js";

export { derivePrivyAuthorizationPublicKey } from "../funding/execution/privy-authorization-key.js";

export type PrivySignerState =
  | "not_configured"
  | "policy_invalid"
  | "grant_required"
  | "ready"
  | "revoke_required"
  | "unsafe_configuration";

export type PrivyServerSignerGrant = {
  policyIds: [string];
  policyProfile: PrivyBotPolicyProfile;
  replaceExistingSigner: boolean;
  signerId: string;
  walletAddress: string;
  walletChain: "ethereum";
};

export type PrivyServerSignerStatus = {
  attached: boolean;
  canRemoveAllSigners: boolean;
  grant: PrivyServerSignerGrant | null;
  message: string | null;
  policyId: string | null;
  policyMaxBuyUsd: number | null;
  signerId: string | null;
  state: PrivySignerState;
};

export type PrivySignerInspectorDependencies = {
  classifyWallets: (user: PrivyUser) => PrivyWalletProfile[];
  getKeyQuorumMetadata: (id: string) => Promise<PrivyKeyQuorumMetadata>;
  getManagedWalletMetadata: (
    walletId: string,
  ) => Promise<PrivyManagedWalletMetadata>;
  getPolicyMetadata: (policyId: string) => Promise<PrivyPolicyMetadata>;
  getUserById: (privyUserId: string) => Promise<PrivyUser>;
};

export type PrivyServerSignerConfiguration = {
  authorizationId: string;
  authorizationKey: string;
  exchangeAddresses: [string, string];
  policyId: string;
  policyFingerprint: string;
  policyMaxBuyUsd: number;
  fundingRouterAddress: string;
  builderCode?: string;
  legacyBuyPolicyId?: string;
  legacySellPolicyId?: string;
};

const defaultInspectorDependencies: PrivySignerInspectorDependencies = {
  classifyWallets: (user) => PrivyService.classifyWallets(user),
  getKeyQuorumMetadata: (id) => PrivyService.getKeyQuorumMetadata(id),
  getManagedWalletMetadata: (walletId) =>
    PrivyService.getManagedWalletMetadata(walletId),
  getPolicyMetadata: (policyId) => PrivyService.getPolicyMetadata(policyId),
  getUserById: (privyUserId) => PrivyService.getUserById(privyUserId),
};

export function resolvePrivyBotPolicyProfile(
  requiredActions: readonly (TradeSide | "REDEEM")[],
): PrivyBotPolicyProfile | null {
  const actions = new Set(requiredActions);
  if (actions.size === 0) return null;
  if (actions.has("REDEEM")) {
    throw new Error(
      "REDEEM is not supported by the Privy bot policy resolver.",
    );
  }
  if ([...actions].every((action) => action === "BUY" || action === "SELL")) {
    return "buy_sell";
  }
  throw new Error("Unsupported Privy bot policy action combination.");
}

export function hasConfiguredPrivyBotPolicyForActions(
  requiredActions: readonly (TradeSide | "REDEEM")[],
): boolean {
  let profile: PrivyBotPolicyProfile | null;
  try {
    profile = resolvePrivyBotPolicyProfile(requiredActions);
  } catch {
    return false;
  }
  if (!profile) return false;
  return Boolean(
    env.privyPolymarketBotBuySellPolicyId &&
    env.privyPolymarketBotBuySellPolicyFingerprint,
  );
}

const POLICY_FUNDING_CAP_CACHE_TTL_MS = 15_000;
let policyFundingCapCache: {
  expiresAt: number;
  key: string;
  value: Promise<bigint>;
} | null = null;

export async function resolvePolymarketBotPolicyFundingCapRaw(): Promise<bigint> {
  const policyId = env.privyPolymarketBotBuySellPolicyId.trim();
  const fundingRouterAddress = env.polymarketFundingRouterAddress.trim();
  const policyMaxBuyUsd = env.privyPolymarketBotBuyPolicyMaxUsd;
  const exchangeAddresses = [
    env.polymarketExchangeAddress,
    env.polymarketNegRiskExchangeAddress,
  ] as const;
  if (!policyId || !fundingRouterAddress || policyMaxBuyUsd <= 0) {
    throw new Error("Polymarket bot policy configuration is incomplete.");
  }
  const key = [
    policyId,
    fundingRouterAddress.toLowerCase(),
    String(policyMaxBuyUsd),
    ...exchangeAddresses.map((address) => address.toLowerCase()),
  ].join("|");
  const now = Date.now();
  if (
    policyFundingCapCache?.key === key &&
    policyFundingCapCache.expiresAt > now
  ) {
    return policyFundingCapCache.value;
  }

  const value = (async () => {
    const policy = await PrivyService.getPolicyMetadata(policyId);
    const validation = validatePolymarketBotPolicyProfile({
      builderCode: env.polymarketBuilderCode,
      exchangeAddresses,
      fundingRouterAddress,
      maxBuyUsd: policyMaxBuyUsd,
      policy,
      profile: "buy_sell",
    });
    if (
      policy.id !== policyId ||
      !validation.valid ||
      validation.fundingMaxRaw == null
    ) {
      throw new Error("Configured Privy Polymarket policy is unsafe.");
    }
    return validation.fundingMaxRaw;
  })();
  policyFundingCapCache = {
    expiresAt: now + POLICY_FUNDING_CAP_CACHE_TTL_MS,
    key,
    value,
  };
  try {
    return await value;
  } catch (error) {
    if (policyFundingCapCache?.value === value) policyFundingCapCache = null;
    throw error;
  }
}

function signerStatus(
  input: Partial<PrivyServerSignerStatus> & {
    state: PrivySignerState;
  },
): PrivyServerSignerStatus {
  return {
    attached: input.attached ?? false,
    canRemoveAllSigners: input.canRemoveAllSigners ?? false,
    grant: input.grant ?? null,
    message: input.message ?? null,
    policyId: input.policyId ?? null,
    policyMaxBuyUsd: input.policyMaxBuyUsd ?? null,
    signerId: input.signerId ?? null,
    state: input.state,
  };
}

export async function inspectServerEvmWalletAuthorization(input: {
  action?: TradeSide;
  requiredActions?: Array<TradeSide | "REDEEM">;
  authorizationEnabled: boolean;
  configuration?: PrivyServerSignerConfiguration;
  dependencies?: PrivySignerInspectorDependencies;
  privyUserId: string | null | undefined;
  signer: string;
  walletId: string;
}): Promise<PrivyServerSignerStatus> {
  const configuration = input.configuration ?? {
    authorizationId: env.privyWalletAuthorizationId,
    authorizationKey: env.privyWalletAuthorizationKey,
    exchangeAddresses: [
      env.polymarketExchangeAddress,
      env.polymarketNegRiskExchangeAddress,
    ],
    policyId: env.privyPolymarketBotBuySellPolicyId,
    policyFingerprint: env.privyPolymarketBotBuySellPolicyFingerprint,
    policyMaxBuyUsd: env.privyPolymarketBotBuyPolicyMaxUsd,
    fundingRouterAddress: env.polymarketFundingRouterAddress,
    builderCode: env.polymarketBuilderCode,
    legacyBuyPolicyId: env.privyPolymarketBotBuyPolicyId,
    legacySellPolicyId: env.privyPolymarketBotSellPolicyId,
  };
  const signerId = configuration.authorizationId.trim();
  const combinedPolicyId = configuration.policyId.trim();
  const combinedPolicyFingerprint = configuration.policyFingerprint.trim();
  const legacyBuyPolicyId = configuration.legacyBuyPolicyId?.trim() ?? "";
  const legacySellPolicyId = configuration.legacySellPolicyId?.trim() ?? "";
  const policyMaxBuyUsd = configuration.policyMaxBuyUsd;
  const requiredActions = Array.from(
    new Set(input.requiredActions ?? [input.action ?? "BUY"]),
  );
  let requiredProfile: PrivyBotPolicyProfile | null;
  try {
    requiredProfile = resolvePrivyBotPolicyProfile(requiredActions);
  } catch {
    requiredProfile = null;
  }
  const configuredPolicies = new Map<PrivyBotPolicyProfile, string>([
    ["buy", legacyBuyPolicyId],
    ["sell", legacySellPolicyId],
    ["buy_sell", combinedPolicyId],
  ]);
  const targetPolicyId = requiredProfile
    ? (configuredPolicies.get(requiredProfile) ?? "")
    : "";
  const configuredPolicyEntries = [...configuredPolicies].filter(([, id]) =>
    Boolean(id),
  );
  const configuredPolicyIds = configuredPolicyEntries.map(([, id]) => id);
  const hasDuplicatePolicyIds =
    new Set(configuredPolicyIds).size !== configuredPolicyIds.length;
  const common = {
    policyId: targetPolicyId || null,
    policyMaxBuyUsd,
    signerId,
  };
  if (
    !requiredProfile ||
    !signerId ||
    !configuration.authorizationKey ||
    !targetPolicyId ||
    !combinedPolicyFingerprint ||
    hasDuplicatePolicyIds ||
    policyMaxBuyUsd <= 0 ||
    !configuration.fundingRouterAddress ||
    !/^0x[a-fA-F0-9]{64}$/.test(configuration.builderCode?.trim() ?? "")
  ) {
    return signerStatus({
      ...common,
      message: "Server-side Polymarket signer configuration is incomplete.",
      state: "not_configured",
    });
  }

  const privyUserId = input.privyUserId?.trim() ?? "";
  const walletId = input.walletId.trim();
  const walletAddress = canonicalAccountAddress("evm:137", input.signer);
  if (!privyUserId || !walletId || !isEvmAddress(input.signer)) {
    return signerStatus({
      ...common,
      message: "Trading Wallet ownership information is incomplete.",
      state: "unsafe_configuration",
    });
  }

  const dependencies = input.dependencies ?? defaultInspectorDependencies;
  let derivedPublicKey: string;
  try {
    derivedPublicKey = derivePrivyAuthorizationPublicKey(
      configuration.authorizationKey,
    );
  } catch {
    return signerStatus({
      ...common,
      message: "Configured Privy authorization key is invalid.",
      state: "policy_invalid",
    });
  }

  let user: PrivyUser;
  let wallet: PrivyManagedWalletMetadata;
  let quorum: PrivyKeyQuorumMetadata;
  try {
    [user, wallet, quorum] = await Promise.all([
      dependencies.getUserById(privyUserId),
      dependencies.getManagedWalletMetadata(walletId),
      dependencies.getKeyQuorumMetadata(signerId),
    ]);
  } catch {
    return signerStatus({
      ...common,
      message: "Privy signer configuration could not be verified.",
      state: "policy_invalid",
    });
  }

  // Privy Wallet API owner_id is a key-quorum ID, not the user's did:privy ID.
  // Establish user ownership from the authenticated user's internal wallets.
  const ownedWallet = dependencies
    .classifyWallets(user)
    .find(
      (candidate) =>
        candidate.walletType === "ethereum" &&
        candidate.isInternalWallet &&
        isEvmAddress(candidate.address) &&
        sameAccountAddress("evm:137", candidate.address, walletAddress) &&
        candidate.walletId?.trim() === walletId,
    );
  if (
    !ownedWallet ||
    wallet.id !== walletId ||
    wallet.chainType !== "ethereum" ||
    !isEvmAddress(wallet.address) ||
    !sameAccountAddress("evm:137", wallet.address, walletAddress)
  ) {
    return signerStatus({
      ...common,
      message:
        "Selected Trading Wallet does not match the authenticated Privy user.",
      state: "unsafe_configuration",
    });
  }

  const matchingSigners = wallet.additionalSigners.filter(
    (candidate) => candidate.signerId === signerId,
  );
  const otherSigners = wallet.additionalSigners.filter(
    (candidate) => candidate.signerId !== signerId,
  );
  const signerRegistry = validateKnownPrivyWalletSigners({
    signers: wallet.additionalSigners,
    specs: [
      {
        purpose: "polymarket_automation",
        signerId,
        policyIds: configuredPolicyIds,
      },
    ],
  });
  const canRemoveAllSigners =
    otherSigners.length === 0 && matchingSigners.length <= 1;
  const grant: PrivyServerSignerGrant = {
    policyIds: [targetPolicyId],
    policyProfile: requiredProfile,
    replaceExistingSigner: false,
    signerId,
    walletAddress,
    walletChain: "ethereum",
  };
  if (!signerRegistry.valid || matchingSigners.length > 1) {
    return signerStatus({
      ...common,
      attached: matchingSigners.length > 0,
      canRemoveAllSigners: false,
      grant,
      message:
        "Trading Wallet contains foreign or duplicate additional signers.",
      state: "unsafe_configuration",
    });
  }
  const matchingSigner = matchingSigners[0];
  const attachedPolicyIds = matchingSigner?.overridePolicyIds ?? [];
  const configuredProfileByPolicyId = new Map(
    configuredPolicyEntries.map(([profile, id]) => [id, profile]),
  );
  const attachedPolicyId =
    attachedPolicyIds.length === 1 ? (attachedPolicyIds[0] ?? null) : null;
  const attachedProfile = attachedPolicyId
    ? (configuredProfileByPolicyId.get(attachedPolicyId) ?? null)
    : null;
  grant.replaceExistingSigner = Boolean(
    matchingSigner && attachedProfile !== requiredProfile,
  );
  if (!input.authorizationEnabled && matchingSigner) {
    return signerStatus({
      ...common,
      attached: true,
      canRemoveAllSigners,
      grant,
      message: "Bot access is still attached and must be revoked.",
      state: "revoke_required",
    });
  }

  if (
    quorum.id !== signerId ||
    quorum.authorizationThreshold !== 1 ||
    quorum.authorizationPublicKeys.length !== 1 ||
    quorum.nestedKeyQuorumIds.length !== 0 ||
    quorum.userIds.length !== 0 ||
    !quorum.authorizationPublicKeys.some(
      (publicKey) =>
        normalizePrivyAuthorizationPublicKey(publicKey) ===
        normalizePrivyAuthorizationPublicKey(derivedPublicKey),
    )
  ) {
    return signerStatus({
      ...common,
      attached: Boolean(matchingSigner),
      canRemoveAllSigners,
      grant,
      message: "Configured Privy authorization key does not match its quorum.",
      state: "policy_invalid",
    });
  }

  if (matchingSigner && attachedPolicyIds.length !== 1) {
    return signerStatus({
      ...common,
      attached: true,
      canRemoveAllSigners,
      grant,
      message: "Hunch signer must have exactly one Privy override policy.",
      state: "unsafe_configuration",
    });
  }
  if (matchingSigner && (!attachedPolicyId || !attachedProfile)) {
    return signerStatus({
      ...common,
      attached: true,
      canRemoveAllSigners,
      grant,
      message: "Hunch signer is attached with an unexpected Privy policy.",
      state: "unsafe_configuration",
    });
  }

  const policyIdsToValidate = new Set([targetPolicyId]);
  if (attachedPolicyId) policyIdsToValidate.add(attachedPolicyId);
  let policies: PrivyPolicyMetadata[];
  try {
    policies = await Promise.all(
      [...policyIdsToValidate].map((id) => dependencies.getPolicyMetadata(id)),
    );
  } catch {
    policies = [];
  }
  const policiesById = new Map(policies.map((policy) => [policy.id, policy]));
  const validationsById = new Map<string, PolicyValidationResult>();
  for (const id of policyIdsToValidate) {
    const policy = policiesById.get(id);
    const profile = configuredProfileByPolicyId.get(id);
    if (!policy || !profile) continue;
    const validation = validatePolymarketBotPolicyProfile({
      builderCode: configuration.builderCode?.trim() ?? "",
      exchangeAddresses: configuration.exchangeAddresses,
      fundingRouterAddress: configuration.fundingRouterAddress,
      maxBuyUsd: policyMaxBuyUsd,
      policy,
      profile,
    });
    if (
      id === combinedPolicyId &&
      knownPrivyPolicyFingerprint(policy) !== combinedPolicyFingerprint
    ) {
      validation.issues.push(
        "Combined policy fingerprint differs from configuration.",
      );
      validation.valid = false;
    }
    validationsById.set(id, validation);
  }
  if (
    policies.length !== policyIdsToValidate.size ||
    validationsById.size !== policyIdsToValidate.size ||
    [...validationsById.values()].some((validation) => !validation.valid)
  ) {
    return signerStatus({
      ...common,
      attached: Boolean(matchingSigner),
      canRemoveAllSigners,
      grant,
      message: "Configured Privy Polymarket policy is missing or unsafe.",
      state: "policy_invalid",
    });
  }

  const attachedCoversRequired = attachedProfile === requiredProfile;
  if (!matchingSigner || !attachedCoversRequired) {
    grant.replaceExistingSigner = Boolean(matchingSigner);
    return signerStatus({
      ...common,
      attached: Boolean(matchingSigner),
      canRemoveAllSigners,
      grant,
      message: matchingSigner
        ? "Replace the Hunch signer policy for the enabled bot actions."
        : "Grant bot access to this Trading Wallet in Hunch Settings.",
      state: "grant_required",
    });
  }
  return signerStatus({
    ...common,
    attached: true,
    canRemoveAllSigners,
    grant,
    state: "ready",
  });
}

export function getPrivyWalletId(intent: TradeIntent): string {
  const walletId =
    typeof intent.executionAuthorization?.privyWalletId === "string"
      ? intent.executionAuthorization.privyWalletId.trim()
      : isRecord(intent.raw) && typeof intent.raw.privyWalletId === "string"
        ? intent.raw.privyWalletId.trim()
        : "";
  if (!walletId) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Privy wallet id is required for bot trading.",
      venue: intent.venue,
    });
  }
  return walletId;
}

export function hasServerWalletClientConfig(): boolean {
  return Boolean(
    env.privyWalletAuthorizationId &&
    env.privyWalletAuthorizationKey &&
    env.privyPolymarketBotBuySellPolicyId &&
    env.privyPolymarketBotBuySellPolicyFingerprint &&
    env.privyPolymarketBotBuyPolicyMaxUsd > 0 &&
    env.polymarketFundingRouterAddress,
  );
}

export function createServerWalletClient(): PrivyWalletApiClient {
  if (!hasServerWalletClientConfig()) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Server-side Privy wallet authorization is not configured.",
      statusCode: 503,
    });
  }
  return PrivyService.createClient({
    walletAuthorizationKey: env.privyWalletAuthorizationKey,
  });
}

export async function assertServerEvmWalletOwnership(input: {
  dependencies?: Pick<
    PrivySignerInspectorDependencies,
    "classifyWallets" | "getUserById"
  >;
  privyUserId: string | null | undefined;
  signer: string;
  walletId: string;
}): Promise<void> {
  const privyUserId = input.privyUserId?.trim() ?? "";
  if (!privyUserId) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Trading authorization is missing a Privy user id.",
    });
  }
  const walletId = input.walletId.trim();
  const signer = canonicalAccountAddress("evm:137", input.signer);
  if (!isEvmAddress(input.signer)) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Trading authorization has an invalid EVM signer.",
    });
  }
  const dependencies = input.dependencies ?? defaultInspectorDependencies;
  const privyUser = await dependencies.getUserById(privyUserId);
  const wallet = dependencies
    .classifyWallets(privyUser)
    .find(
      (candidate) =>
        candidate.walletType === "ethereum" &&
        candidate.isInternalWallet &&
        isEvmAddress(candidate.address) &&
        sameAccountAddress("evm:137", candidate.address, signer),
    );
  if (!wallet || wallet.walletId?.trim() !== walletId) {
    throw tradingError({
      code: "insufficient_readiness",
      message:
        "Selected Trading Wallet does not match its Privy authorization.",
    });
  }
}

export async function assertServerEvmWalletAuthorization(input: {
  action?: TradeSide;
  requiredActions?: Array<TradeSide | "REDEEM">;
  privyUserId: string | null | undefined;
  signer: string;
  venue: TradingVenue;
  walletId: string;
}): Promise<void> {
  if (input.venue !== "polymarket") {
    throw tradingError({
      code: "privy_policy_unsupported_for_venue",
      message: `Server-side Privy policy is not enabled for ${input.venue}.`,
      venue: input.venue,
    });
  }
  const status = await inspectServerEvmWalletAuthorization({
    action: input.action,
    requiredActions: input.requiredActions,
    authorizationEnabled: true,
    privyUserId: input.privyUserId,
    signer: input.signer,
    walletId: input.walletId,
  });
  if (status.state !== "ready") {
    throw tradingError({
      code: `privy_server_signer_${status.state}`,
      message: status.message ?? "Privy server signer is not ready.",
      venue: input.venue,
    });
  }
}

export async function signEvmTypedData(input: {
  action?: TradeSide;
  walletClient: PrivyWalletApiClient;
  walletId: string;
  signer: string;
  typedData: {
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType: string;
    types: Record<string, readonly { name: string; type: string }[]>;
  };
}): Promise<string> {
  const validation = validatePolymarketBotTypedData({
    action: input.action,
    builderCode: env.polymarketBuilderCode,
    exchangeAddresses: [
      env.polymarketExchangeAddress,
      env.polymarketNegRiskExchangeAddress,
    ],
    maxBuyUsd: env.privyPolymarketBotBuyPolicyMaxUsd,
    signer: input.signer,
    typedData: input.typedData,
  });
  if (!validation.valid) {
    throw tradingError({
      code: "privy_polymarket_typed_data_rejected",
      message: `Server signer rejected typed data outside the Polymarket ${input.action ?? "BUY"} policy.`,
      venue: "polymarket",
    });
  }
  const result = await input.walletClient.walletApi.ethereum.signTypedData({
    walletId: input.walletId,
    address: input.signer,
    chainType: "ethereum",
    typedData: input.typedData,
  });
  return result.signature;
}

export async function signPolymarketRedemptionBatch(input: {
  adapterAddress: string;
  calldata: string;
  depositWalletAddress: string;
  signer: string;
  typedData: DepositWalletBatchTypedData;
  walletClient: PrivyWalletApiClient;
  walletId: string;
}): Promise<string> {
  if (
    !validateCanonicalRedemptionBatch({
      adapterAddress: input.adapterAddress,
      calldata: input.calldata,
      depositWalletAddress: input.depositWalletAddress,
      typedData: input.typedData,
    })
  ) {
    throw tradingError({
      code: "privy_polymarket_redemption_batch_rejected",
      message:
        "Server signer rejected a DepositWallet batch outside the canonical Polymarket redemption adapter path.",
      venue: "polymarket",
    });
  }
  const result = await input.walletClient.walletApi.ethereum.signTypedData({
    walletId: input.walletId,
    address: input.signer,
    chainType: "ethereum",
    typedData: input.typedData,
  });
  return result.signature;
}

export async function signEvmMessage(input: {
  walletClient: PrivyWalletApiClient;
  walletId: string;
  signer: string;
  message: string | Uint8Array;
}): Promise<string> {
  const result = await input.walletClient.walletApi.ethereum.signMessage({
    walletId: input.walletId,
    address: input.signer,
    chainType: "ethereum",
    message: input.message,
  });
  return result.signature;
}
