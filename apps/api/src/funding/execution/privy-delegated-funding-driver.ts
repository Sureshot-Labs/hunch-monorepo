import { PrivyClient } from "@privy-io/node";
import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";

import type {
  DelegatedFundingExecutionClaim,
  DelegatedFundingExecutionResult,
  DelegatedFundingNetworkDriver,
  DelegatedFundingProviderLookupClaim,
  DelegatedFundingProviderLookupResult,
  DelegatedFundingRecoveryClaim,
} from "./delegated-funding-executor.js";
import type { PolymarketWrapExecutionConfiguration } from "./delegated-funding-config.js";
import { derivePrivyAuthorizationPublicKey } from "./privy-authorization-key.js";
import {
  knownPrivyPolicyFingerprint,
  polymarketKnownSignerRuntimeSpecs,
  polymarketPersistedSignerRuntimeSpecs,
  validateKnownPrivyWalletSigners,
  validateKnownPrivySignerRuntime,
} from "./known-privy-wallet-signers.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { validateCombinedPolymarketRelayPolicy } from "./combined-privy-policy.js";
import { relayEvmPolicyHasExactAssetPair } from "./delegated-funding-profiles.js";
import { POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import { relayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";

export type PrivyDelegatedFundingDriverConfig = Readonly<{
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  configuration: Pick<
    PolymarketWrapExecutionConfiguration,
    "signerId" | "signerFingerprint" | "policyId" | "policyFingerprint"
  > &
    Readonly<{
      relayMaxSourceRaw?: string;
    }>;
}>;

export type PrivyDelegatedFundingSubmission = Readonly<{
  hash?: string | null;
  transaction_hash?: string | null;
  reference_id?: string | null;
  transaction_id?: string | null;
  user_operation_hash?: string | null;
  status?: string | null;
}>;

export class PrivyDelegatedFundingProfileInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivyDelegatedFundingProfileInvalidError";
  }
}

export type PrivyWalletProfileInspection = "valid" | "invalid" | "unavailable";

export function privyEvmQuantity(raw: string): string {
  if (!/^(0|[1-9]\d*)$/u.test(raw)) {
    throw new Error("Privy EVM quantity source must be an unsigned integer");
  }
  return `0x${BigInt(raw).toString(16)}`;
}

// Provider bodies may echo request data, so diagnostics must stay allowlisted.
function errorRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 96)
    : null;
}

export function privyProviderErrorDiagnostic(error: unknown): Readonly<{
  errorCode: string | null;
  errorName: string;
  httpStatus: number | null;
}> {
  const root = errorRecord(error);
  const provider = errorRecord(root?.error);
  const status = root?.status;
  return {
    errorCode:
      safeString(provider?.code) ??
      safeString(provider?.error_code) ??
      safeString(root?.code),
    errorName:
      error instanceof Error
        ? (safeString(error.constructor.name) ?? "Error")
        : "UnknownError",
    httpStatus:
      typeof status === "number" && Number.isInteger(status) ? status : null,
  };
}

export function resolvePrivyProfileInspectionFailure(
  error: unknown,
  priorSubmissionMayHaveOccurred: boolean,
): DelegatedFundingExecutionResult {
  return error instanceof PrivyDelegatedFundingProfileInvalidError &&
    !priorSubmissionMayHaveOccurred
    ? {
        kind: "proven_nonbroadcast_failure",
        reasonCode: "delegated_profile_invalid",
      }
    : { kind: "pending" };
}

export function selectPrivyDelegatedFundingReference(
  payload: unknown,
  referenceId: string,
): PrivyDelegatedFundingSubmission | null {
  let records: readonly unknown[] = [];
  if (Array.isArray(payload)) {
    records = payload;
  } else if (payload && typeof payload === "object") {
    if ("transactions" in payload && Array.isArray(payload.transactions)) {
      records = payload.transactions;
    } else if ("data" in payload && Array.isArray(payload.data)) {
      records = payload.data;
    }
  }
  const exact = records.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return (entry as Record<string, unknown>).reference_id === referenceId;
  });
  if (exact.length > 1) {
    throw new Error("Privy reference lookup returned duplicate transactions");
  }
  return (exact[0] as PrivyDelegatedFundingSubmission | undefined) ?? null;
}

const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/u;

function transactionHash(value: unknown): string | null {
  return typeof value === "string" && EVM_TRANSACTION_HASH.test(value.trim())
    ? value.trim()
    : null;
}

function userOperationTransactionHash(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const receipt = (result as { receipt?: unknown }).receipt;
  const receiptRecord =
    receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>)
      : null;
  return transactionHash(
    receiptRecord?.transactionHash ??
      receiptRecord?.transaction_hash ??
      (result as Record<string, unknown>).transactionHash,
  );
}

function evmRpcForNetwork(networkId: string): Readonly<{
  url: string;
  timeoutMs: number;
}> | null {
  if (networkId === "evm:137") {
    return {
      url: fundingSidecarRuntimeConfig.polygonRpcUrl,
      timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
    };
  }
  if (networkId === "evm:8453") {
    return {
      url: fundingSidecarRuntimeConfig.baseRpcUrl,
      timeoutMs: fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
    };
  }
  return null;
}

function evmChainId(networkId: string): number | null {
  const match = /^evm:([1-9][0-9]*)$/u.exec(networkId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function resolveUserOperationHash(
  userOperationHash: string,
  networkId = "evm:137",
): Promise<string | null> {
  if (!EVM_TRANSACTION_HASH.test(userOperationHash)) return null;
  const rpc = evmRpcForNetwork(networkId);
  if (!rpc) return null;
  const response = await fetch(rpc.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getUserOperationReceipt",
      params: [userOperationHash],
    }),
    signal: AbortSignal.timeout(rpc.timeoutMs),
  });
  if (!response.ok) return null;
  return userOperationTransactionHash(await response.json().catch(() => null));
}

export async function resolvePrivyDelegatedFundingSubmission(
  result: PrivyDelegatedFundingSubmission,
  dependencies: Readonly<{
    transactionById: (transactionId: string) => Promise<
      Readonly<{
        status: string;
        transaction_hash: string | null;
      }>
    >;
    userOperationTransactionHash: (
      userOperationHash: string,
      networkId: string,
    ) => Promise<string | null>;
  }>,
  networkId = "evm:137",
): Promise<DelegatedFundingExecutionResult> {
  const directHash = transactionHash(result.hash ?? result.transaction_hash);
  if (directHash) {
    return { kind: "submitted", transactionReference: directHash };
  }
  const transactionId = result.transaction_id?.trim();
  if (transactionId) {
    try {
      const transaction = await dependencies.transactionById(transactionId);
      const resolvedHash = transactionHash(transaction.transaction_hash);
      if (resolvedHash) {
        return { kind: "submitted", transactionReference: resolvedHash };
      }
    } catch {
      return { kind: "pending" };
    }
  }
  const userOperationHash = result.user_operation_hash?.trim();
  if (userOperationHash) {
    try {
      const resolvedHash = await dependencies.userOperationTransactionHash(
        userOperationHash,
        networkId,
      );
      if (resolvedHash) {
        return { kind: "submitted", transactionReference: resolvedHash };
      }
    } catch {
      return { kind: "pending" };
    }
  }
  return { kind: "pending" };
}

function complete(input: PrivyDelegatedFundingDriverConfig): boolean {
  return (
    input.appId.trim().length > 0 &&
    input.appSecret.trim().length > 0 &&
    input.authorizationPrivateKey.trim().length > 0
  );
}

export class PrivyDelegatedFundingDriver implements DelegatedFundingNetworkDriver {
  private readonly client: PrivyClient;
  private readonly derivedPublicKey: string;

  constructor(private readonly input: PrivyDelegatedFundingDriverConfig) {
    if (!complete(input)) {
      throw new Error("Privy delegated funding driver is not configured");
    }
    this.client = new PrivyClient({
      appId: input.appId,
      appSecret: input.appSecret,
    });
    this.derivedPublicKey = derivePrivyAuthorizationPublicKey(
      input.authorizationPrivateKey,
    );
  }

  private async verifyLiveProfile(
    input: Readonly<{
      walletAddress: string;
      walletId: string;
      requiredProfileId?: string;
    }>,
    authority: Pick<
      PolymarketWrapExecutionConfiguration,
      "signerId" | "signerFingerprint" | "policyId" | "policyFingerprint"
    > = this.input.configuration,
    registry: "current" | "persisted_recovery" = "current",
  ) {
    const wallet = await this.client.wallets().get(input.walletId);
    const persistedAuthority = {
      authorizationPublicKey: this.derivedPublicKey,
      policyFingerprint: authority.policyFingerprint,
      policyId: authority.policyId,
      signerFingerprint: authority.signerFingerprint,
      signerId: authority.signerId,
    };
    const runtimeSpecs =
      registry === "persisted_recovery"
        ? polymarketPersistedSignerRuntimeSpecs(persistedAuthority)
        : polymarketKnownSignerRuntimeSpecs(process.env, persistedAuthority);
    const signerRegistry = validateKnownPrivyWalletSigners({
      signers: wallet.additional_signers.map((signer) => ({
        signerId: signer.signer_id,
        overridePolicyIds: signer.override_policy_ids ?? [],
      })),
      specs: runtimeSpecs,
      requiredPurposes: ["polymarket_automation"],
    });
    if (
      wallet.id !== input.walletId ||
      wallet.chain_type !== "ethereum" ||
      !sameAccountAddress("evm:1", wallet.address, input.walletAddress) ||
      !signerRegistry.valid
    ) {
      throw new PrivyDelegatedFundingProfileInvalidError(
        "Privy wallet signer registry is incomplete or unsafe",
      );
    }
    const specsBySigner = new Map(
      runtimeSpecs.map((spec) => [spec.signerId, spec]),
    );
    await Promise.all(
      wallet.additional_signers.map(async (signer) => {
        const spec = specsBySigner.get(signer.signer_id);
        const policyId = signer.override_policy_ids?.[0] ?? "";
        if (!spec || !policyId) {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy wallet signer is not registered",
          );
        }
        const [quorum, policy] = await Promise.all([
          this.client.keyQuorums().get(spec.signerId),
          this.client.policies().get(policyId),
        ]);
        const normalizedPolicy = {
          chainType: policy.chain_type,
          id: policy.id,
          rules: policy.rules.map((rule) => ({
            action: rule.action,
            conditions: rule.conditions,
            id: rule.id,
            method: rule.method,
            name: rule.name,
          })),
        };
        const policyFingerprint = knownPrivyPolicyFingerprint(normalizedPolicy);
        const quorumSnapshot = {
          id: quorum.id,
          authorizationPublicKeys: quorum.authorization_keys.map(
            (key) => key.public_key,
          ),
          authorizationThreshold: quorum.authorization_threshold,
          nestedKeyQuorumIds: quorum.key_quorum_ids ?? [],
          userIds: quorum.user_ids ?? [],
        };
        if (
          !validateKnownPrivySignerRuntime({
            attachedPolicyId: policyId,
            policyChainType: policy.chain_type,
            policyFingerprint,
            quorum: quorumSnapshot,
            spec,
          })
        ) {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy wallet signer or policy fingerprint changed",
          );
        }
        if (normalizedPolicy.chainType !== "ethereum") {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy automation policy is not an Ethereum policy",
          );
        }
        const policyValidation = validateCombinedPolymarketRelayPolicy({
          builderCode: fundingSidecarRuntimeConfig.polymarketBuilderCode,
          exchangeAddresses: [
            fundingSidecarRuntimeConfig.polymarketExchangeAddress,
            fundingSidecarRuntimeConfig.polymarketNegRiskExchangeAddress,
          ],
          fundingRouterAddress: POLYMARKET_FUNDING_ROUTER.polygon,
          maxBuyUsd: fundingSidecarRuntimeConfig.polymarketBotBuyPolicyMaxUsd,
          policy: { ...normalizedPolicy, chainType: "ethereum" },
          profile: "buy_sell",
          relayMaxSourceRaw: this.input.configuration.relayMaxSourceRaw,
        });
        if (!policyValidation.valid) {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy automation policy is not the exact combined BUY+SELL+FUNDING profile",
          );
        }
        if (
          input.requiredProfileId === POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID &&
          (!policyValidation.fundingRouterPusdFundPresent ||
            !policyValidation.fundingRouterUsdceApprovalPresent ||
            !policyValidation.fundingRouterControllerApprovalPresent)
        ) {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy automation policy lacks the exact Funding Router pUSD approval/fund rules",
          );
        }
        const relayProfile = relayEvmFundingProfileSpec(
          input.requiredProfileId ?? "",
        );
        if (
          relayProfile &&
          (!policyValidation.relayRulesPresent ||
            !relayEvmPolicyHasExactAssetPair(normalizedPolicy.rules, {
              chainId: relayProfile.sourceAsset.networkId.slice(4),
              token: relayProfile.sourceAsset.assetId,
              maxSourceRaw: this.input.configuration.relayMaxSourceRaw ?? "",
            }))
        ) {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy automation policy lacks the exact Relay EVM rules",
          );
        }
      }),
    );
  }

  private async resolveSubmission(
    result: PrivyDelegatedFundingSubmission,
    networkId: string,
  ): Promise<DelegatedFundingExecutionResult> {
    return resolvePrivyDelegatedFundingSubmission(
      result,
      {
        transactionById: (transactionId) =>
          this.client.transactions().get(transactionId),
        userOperationTransactionHash: resolveUserOperationHash,
      },
      networkId,
    );
  }

  private async lookupByReference(
    referenceId: string,
  ): Promise<PrivyDelegatedFundingSubmission | null> {
    const url = new URL("https://api.privy.io/v1/transactions");
    url.searchParams.set("reference_id", referenceId);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.input.appId}:${this.input.appSecret}`,
        ).toString("base64")}`,
        Accept: "application/json",
        "privy-app-id": this.input.appId,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Privy reference lookup failed");
    return selectPrivyDelegatedFundingReference(
      await response.json().catch(() => null),
      referenceId,
    );
  }

  async verifyWalletProfile(
    input: Readonly<{
      walletAddress: string;
      walletId: string;
    }>,
  ): Promise<boolean> {
    return (await this.inspectWalletProfile(input)) === "valid";
  }

  async inspectWalletProfile(
    input: Readonly<{
      walletAddress: string;
      walletId: string;
    }>,
  ): Promise<PrivyWalletProfileInspection> {
    try {
      await this.verifyLiveProfile(input);
      return "valid";
    } catch (error) {
      return error instanceof PrivyDelegatedFundingProfileInvalidError
        ? "invalid"
        : "unavailable";
    }
  }

  async inspectWalletProfileForProfile(
    input: Readonly<{
      walletAddress: string;
      walletId: string;
      profileId: string;
    }>,
  ): Promise<PrivyWalletProfileInspection> {
    try {
      await this.verifyLiveProfile({
        walletAddress: input.walletAddress,
        walletId: input.walletId,
        requiredProfileId: input.profileId,
      });
      return "valid";
    } catch (error) {
      return error instanceof PrivyDelegatedFundingProfileInvalidError
        ? "invalid"
        : "unavailable";
    }
  }

  private async submit(
    claim: DelegatedFundingExecutionClaim,
    priorSubmissionMayHaveOccurred: boolean,
  ): Promise<DelegatedFundingExecutionResult> {
    try {
      await this.verifyLiveProfile(
        {
          walletAddress: claim.walletAddress,
          walletId: claim.privyWalletId,
          requiredProfileId: claim.profileId,
        },
        {
          policyFingerprint: claim.policyFingerprint,
          policyId: claim.policyId,
          signerFingerprint: claim.signerFingerprint,
          signerId: claim.signerId,
        },
        priorSubmissionMayHaveOccurred ? "persisted_recovery" : "current",
      );
    } catch (error) {
      return resolvePrivyProfileInspectionFailure(
        error,
        priorSubmissionMayHaveOccurred,
      );
    }
    if (claim.action.kind !== "evm_transaction") {
      return priorSubmissionMayHaveOccurred
        ? { kind: "pending" }
        : {
            kind: "proven_nonbroadcast_failure",
            reasonCode: "delegated_action_invalid",
          };
    }
    const chainId = evmChainId(claim.action.networkId);
    if (!chainId || !evmRpcForNetwork(claim.action.networkId)) {
      return priorSubmissionMayHaveOccurred
        ? { kind: "pending" }
        : {
            kind: "proven_nonbroadcast_failure",
            reasonCode: "delegated_action_invalid",
          };
    }
    const result = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(claim.privyWalletId, {
        address: claim.walletAddress,
        caip2: `eip155:${chainId}`,
        sponsor: claim.sponsor,
        reference_id: claim.attemptId,
        idempotency_key: claim.attemptId,
        params: {
          transaction: {
            chain_id: chainId,
            to: claim.action.to,
            data: claim.action.data,
            // Funding actions store raw amounts as decimal strings; Privy requires
            // string quantities to use the canonical 0x-prefixed EVM form.
            value: privyEvmQuantity(claim.action.valueRaw),
          },
        },
        authorization_context: {
          authorization_private_keys: [this.input.authorizationPrivateKey],
        },
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: "delegated_funding_provider_error",
            provider: "privy",
            stage: "submission",
            attemptId: claim.attemptId,
            operationId: claim.operationId,
            profileId: claim.profileId,
            stepId: claim.stepId,
            ...privyProviderErrorDiagnostic(error),
          }),
        );
        throw error;
      });
    return this.resolveSubmission(result, claim.action.networkId);
  }

  async execute(
    claim: DelegatedFundingExecutionClaim,
  ): Promise<DelegatedFundingExecutionResult> {
    return this.submit(claim, false);
  }

  async lookupProviderReference(
    claim: DelegatedFundingProviderLookupClaim,
  ): Promise<DelegatedFundingProviderLookupResult> {
    const transaction = await this.lookupByReference(claim.attemptId);
    if (!transaction) return { kind: "pending" };
    const resolved = await this.resolveSubmission(
      transaction,
      claim.action.networkId,
    );
    return resolved.kind === "submitted" ? resolved : { kind: "pending" };
  }

  async recover(
    claim: DelegatedFundingRecoveryClaim,
  ): Promise<DelegatedFundingExecutionResult> {
    const transaction = await this.lookupByReference(claim.attemptId);
    // Replaying the exact same Privy idempotency/reference key is the durable
    // outbox recovery path for a crash between the committed attempt and the
    // external call. It cannot create a second logical submission.
    return transaction
      ? this.resolveSubmission(transaction, claim.action.networkId)
      : this.submit(claim, true);
  }
}

export function createPrivyDelegatedFundingDriver(
  input: PrivyDelegatedFundingDriverConfig,
): PrivyDelegatedFundingDriver | null {
  try {
    return new PrivyDelegatedFundingDriver(input);
  } catch {
    return null;
  }
}
