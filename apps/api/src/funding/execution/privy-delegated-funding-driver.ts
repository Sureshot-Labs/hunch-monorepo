import { PrivyClient } from "@privy-io/node";
import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";

import type {
  DelegatedFundingExecutionClaim,
  DelegatedFundingExecutionResult,
  DelegatedFundingNetworkDriver,
  DelegatedFundingRecoveryClaim,
} from "./delegated-funding-executor.js";
import type { PolymarketWrapExecutionConfiguration } from "./delegated-funding-config.js";
import { validatePolymarketDepositUsdceWrapPolicy } from "./delegated-funding-profiles.js";
import { derivePrivyAuthorizationPublicKey } from "./privy-authorization-key.js";
import {
  knownPrivyPolicyFingerprint,
  polymarketKnownSignerRuntimeSpecs,
  validateKnownPrivyWalletSigners,
  validateKnownPrivySignerRuntime,
} from "./known-privy-wallet-signers.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

export type PrivyDelegatedFundingDriverConfig = Readonly<{
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  configuration: PolymarketWrapExecutionConfiguration;
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

async function resolveUserOperationHash(
  userOperationHash: string,
): Promise<string | null> {
  if (!EVM_TRANSACTION_HASH.test(userOperationHash)) return null;
  const response = await fetch(fundingSidecarRuntimeConfig.polygonRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getUserOperationReceipt",
      params: [userOperationHash],
    }),
    signal: AbortSignal.timeout(
      fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
    ),
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
    ) => Promise<string | null>;
  }>,
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
      const resolvedHash =
        await dependencies.userOperationTransactionHash(userOperationHash);
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
    }>,
    authority: Pick<
      PolymarketWrapExecutionConfiguration,
      "signerId" | "signerFingerprint" | "policyId" | "policyFingerprint"
    > = this.input.configuration,
  ) {
    const wallet = await this.client.wallets().get(input.walletId);
    const runtimeSpecs = polymarketKnownSignerRuntimeSpecs(process.env, {
      authorizationPublicKey: this.derivedPublicKey,
      policyFingerprint: authority.policyFingerprint,
      policyId: authority.policyId,
      signerFingerprint: authority.signerFingerprint,
      signerId: authority.signerId,
    });
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
      wallet.address.toLowerCase() !== input.walletAddress.toLowerCase() ||
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
        const policyValidation = validatePolymarketDepositUsdceWrapPolicy({
          policy: { ...normalizedPolicy, chainType: "ethereum" },
          policyId,
          routerAddress: POLYMARKET_FUNDING_ROUTER.polygon,
        });
        if (!policyValidation.valid) {
          throw new PrivyDelegatedFundingProfileInvalidError(
            "Privy automation policy is missing the exact wrap rule",
          );
        }
      }),
    );
  }

  private async resolveSubmission(
    result: PrivyDelegatedFundingSubmission,
  ): Promise<DelegatedFundingExecutionResult> {
    return resolvePrivyDelegatedFundingSubmission(result, {
      transactionById: (transactionId) =>
        this.client.transactions().get(transactionId),
      userOperationTransactionHash: resolveUserOperationHash,
    });
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
    try {
      await this.verifyLiveProfile(input);
      return true;
    } catch {
      return false;
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
        },
        {
          policyFingerprint: claim.policyFingerprint,
          policyId: claim.policyId,
          signerFingerprint: claim.signerFingerprint,
          signerId: claim.signerId,
        },
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
    const result = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(claim.privyWalletId, {
        address: claim.walletAddress,
        caip2: "eip155:137",
        sponsor: claim.sponsor,
        reference_id: claim.attemptId,
        idempotency_key: claim.attemptId,
        params: {
          transaction: {
            to: claim.action.to,
            data: claim.action.data,
            value: claim.action.valueRaw,
          },
        },
        authorization_context: {
          authorization_private_keys: [this.input.authorizationPrivateKey],
        },
      });
    return this.resolveSubmission(result);
  }

  async execute(
    claim: DelegatedFundingExecutionClaim,
  ): Promise<DelegatedFundingExecutionResult> {
    return this.submit(claim, false);
  }

  async recover(
    claim: DelegatedFundingRecoveryClaim,
  ): Promise<DelegatedFundingExecutionResult> {
    const transaction = await this.lookupByReference(claim.attemptId);
    // Replaying the exact same Privy idempotency/reference key is the durable
    // outbox recovery path for a crash between the committed attempt and the
    // external call. It cannot create a second logical submission.
    return transaction
      ? this.resolveSubmission(transaction)
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
