import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import { env } from "../../env.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import { fetchEvmCode } from "../../services/polygon-rpc.js";
import type { AssetRef, ResolvedExternalRecipient } from "../domain/types.js";
import {
  fetchFundingWithdrawalDestinationForUser,
  registerFundingWithdrawalDestination,
  revokeFundingWithdrawalDestinationInTransaction,
} from "../persistence/funding-evidence-repository.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import {
  createWithdrawalDestinationCodec,
  type WithdrawalDestinationCodec,
} from "./withdrawal-destination-codec.js";

const WITHDRAWAL_DESTINATION_TTL_MS = 15 * 60_000;
const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const EVM_DEAD = "0x000000000000000000000000000000000000dead";

export type WithdrawalDestinationErrorCode =
  | "withdrawal_destination_expired"
  | "withdrawal_destination_invalid"
  | "withdrawal_destination_not_found"
  | "withdrawal_destination_policy_disabled"
  | "withdrawal_destination_unsupported";

export class WithdrawalDestinationError extends Error {
  constructor(
    readonly code: WithdrawalDestinationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WithdrawalDestinationError";
  }
}

export type WithdrawalAddressInspection = Readonly<{
  normalizedAddress: string;
  addressKind:
    | "evm_eoa"
    | "solana_system_wallet"
    | "solana_uninitialized_wallet";
  evidenceRevision: string;
}>;

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return (
    left.networkId === right.networkId &&
    left.assetId.toLowerCase() === right.assetId.toLowerCase() &&
    left.decimals === right.decimals
  );
}

export function assertWithdrawalRecipientPolicy(
  policy: FundingRuntimePolicy,
  asset: AssetRef,
  gate: "withdrawalExecution" | "withdrawalRegistration",
): void {
  if (
    policy.creationMode !== "on" ||
    !policy.gates[gate] ||
    policy.gates.emergencyBroadcastPause
  ) {
    throw new WithdrawalDestinationError(
      "withdrawal_destination_policy_disabled",
      `funding ${gate} is disabled`,
    );
  }
  const assetEnabled = policy.assets.some(
    (candidate) => candidate.enabled && sameAsset(candidate.asset, asset),
  );
  const recipientEnabled = policy.locations.some(
    (location) =>
      location.enabled &&
      location.ownership === "external_recipient" &&
      sameAsset(location.asset, asset),
  );
  if (!assetEnabled || !recipientEnabled) {
    throw new WithdrawalDestinationError(
      "withdrawal_destination_unsupported",
      "withdrawal recipient asset or network is not enabled",
    );
  }
}

function evmRpc(networkId: string): Readonly<{
  rpcUrl: string;
  timeoutMs: number;
}> | null {
  if (networkId === "evm:137") {
    return {
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
    };
  }
  if (networkId === "evm:8453") {
    return { rpcUrl: env.baseRpcUrl, timeoutMs: env.baseRpcTimeoutMs };
  }
  return null;
}

export async function inspectWithdrawalAddress(
  input: Readonly<{
    networkId: string;
    address: string;
  }>,
): Promise<WithdrawalAddressInspection> {
  if (input.networkId.startsWith("evm:")) {
    let normalizedAddress: string;
    try {
      normalizedAddress = ethers.getAddress(input.address.trim());
    } catch {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "withdrawal destination is not a valid EVM address",
      );
    }
    if (
      normalizedAddress.toLowerCase() === EVM_ZERO ||
      normalizedAddress.toLowerCase() === EVM_DEAD
    ) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "zero and burn addresses are not valid withdrawal destinations",
      );
    }
    const rpc = evmRpc(input.networkId);
    if (!rpc) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_unsupported",
        "withdrawal destination network has no pinned address inspector",
      );
    }
    let code: string;
    try {
      code = await fetchEvmCode({
        ...rpc,
        address: normalizedAddress,
      });
    } catch {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "withdrawal destination contract evidence is unavailable",
      );
    }
    if (code !== "0x" && code !== "0x0") {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "contract withdrawal destinations are blocked in the initial policy",
      );
    }
    return {
      normalizedAddress,
      addressKind: "evm_eoa",
      evidenceRevision: ethers.keccak256(code === "0x0" ? "0x" : code),
    };
  }

  if (input.networkId === "solana:mainnet") {
    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(input.address.trim());
    } catch {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "withdrawal destination is not a valid Solana public key",
      );
    }
    if (
      publicKey.equals(SystemProgram.programId) ||
      !PublicKey.isOnCurve(publicKey.toBytes())
    ) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "Solana program and PDA addresses are blocked as withdrawal owners",
      );
    }
    let account: Awaited<ReturnType<Connection["getAccountInfo"]>>;
    try {
      account = await new Connection(
        env.solanaRpcUrl,
        "confirmed",
      ).getAccountInfo(publicKey, "confirmed");
    } catch {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "withdrawal destination ownership evidence is unavailable",
      );
    }
    if (account && !account.owner.equals(SystemProgram.programId)) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "program-owned Solana accounts are blocked as withdrawal owners",
      );
    }
    return {
      normalizedAddress: publicKey.toBase58(),
      addressKind: account
        ? "solana_system_wallet"
        : "solana_uninitialized_wallet",
      evidenceRevision: account
        ? `${account.owner.toBase58()}:${account.lamports}:${account.executable}`
        : "uninitialized",
    };
  }

  throw new WithdrawalDestinationError(
    "withdrawal_destination_unsupported",
    "withdrawal destination network is unsupported",
  );
}

function maskedAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export class WithdrawalDestinationRuntime {
  constructor(
    private readonly db: Pool,
    private readonly dependencies: Readonly<{
      codec?: WithdrawalDestinationCodec;
      fetchDestination?: typeof fetchFundingWithdrawalDestinationForUser;
      inspectAddress?: typeof inspectWithdrawalAddress;
      now?: () => Date;
      registerDestination?: typeof registerFundingWithdrawalDestination;
      resolvePolicy?: typeof resolveFundingPolicy;
      revokeDestination?: typeof revokeFundingWithdrawalDestinationInTransaction;
    }> = {},
  ) {}

  private codec() {
    if (this.dependencies.codec) return this.dependencies.codec;
    const lookupKey =
      process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim() ?? "";
    const keyVersion =
      positiveInt(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ?? 1;
    return createWithdrawalDestinationCodec({
      encryptionKey: getCredentialsEncryptionKey(),
      lookupHmacKey: lookupKey,
      keyVersion,
    });
  }

  async register(
    userId: string,
    input: Readonly<{ asset: AssetRef; address: string }>,
  ) {
    const now = this.dependencies.now?.() ?? new Date();
    const resolved = await (
      this.dependencies.resolvePolicy ?? resolveFundingPolicy
    )(this.db);
    assertWithdrawalRecipientPolicy(
      resolved.policy,
      input.asset,
      "withdrawalRegistration",
    );
    const inspected = await (
      this.dependencies.inspectAddress ?? inspectWithdrawalAddress
    )({
      networkId: input.asset.networkId,
      address: input.address,
    });
    const codec = this.codec();
    const expiresAt = new Date(now.getTime() + WITHDRAWAL_DESTINATION_TTL_MS);
    const fingerprint = codec.fingerprint(inspected.normalizedAddress);
    const stored = await (
      this.dependencies.registerDestination ??
      registerFundingWithdrawalDestination
    )(this.db, {
      userId,
      networkId: input.asset.networkId,
      assetId: input.asset.assetId,
      assetDecimals: input.asset.decimals,
      addressCiphertext: codec.encrypt(inspected.normalizedAddress),
      addressLookupHmac: fingerprint,
      lookupKeyVersion: codec.keyVersion,
      validationEvidence: {
        addressKind: inspected.addressKind,
        blockedContractCheck: "passed",
        evidenceRevision: inspected.evidenceRevision,
        policyRevision: resolved.revision,
        validatedAt: now.toISOString(),
      },
      policyVersion: resolved.policy.version,
      expiresAt,
      now,
    });
    return {
      recipientId: stored.destination.id,
      networkId: input.asset.networkId,
      asset: input.asset,
      safeAddress: maskedAddress(inspected.normalizedAddress),
      addressFingerprint: fingerprint,
      validatedAt: now.toISOString(),
      expiresAt: stored.destination.expiresAt.toISOString(),
      validationPolicyVersion: resolved.policy.version,
      replayed: stored.replayed,
    } as const;
  }

  async resolve(
    userId: string,
    recipientId: string,
    options: Readonly<{
      db?: Pick<Pool, "query">;
      lockForShare?: boolean;
    }> = {},
  ): Promise<ResolvedExternalRecipient> {
    const now = this.dependencies.now?.() ?? new Date();
    const db = options.db ?? this.db;
    const [resolved, stored] = await Promise.all([
      (this.dependencies.resolvePolicy ?? resolveFundingPolicy)(db),
      (
        this.dependencies.fetchDestination ??
        fetchFundingWithdrawalDestinationForUser
      )(db, {
        userId,
        destinationId: recipientId,
        lockForShare: options.lockForShare,
      }),
    ]);
    if (!stored) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_not_found",
        "withdrawal destination was not found for authenticated user",
      );
    }
    if (
      stored.revokedAt ||
      !stored.addressCiphertext ||
      stored.expiresAt.getTime() <= now.getTime()
    ) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_expired",
        "withdrawal destination is revoked or expired",
      );
    }
    const asset: AssetRef = {
      networkId: stored.networkId,
      assetId: stored.assetId,
      decimals: stored.assetDecimals,
    };
    assertWithdrawalRecipientPolicy(
      resolved.policy,
      asset,
      "withdrawalExecution",
    );
    const evidenceRevision = stored.validationEvidence.policyRevision;
    if (
      stored.policyVersion !== resolved.policy.version ||
      evidenceRevision !== resolved.revision
    ) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_expired",
        "withdrawal destination policy changed and must be revalidated",
      );
    }
    const codec = this.codec();
    if (codec.keyVersion !== stored.lookupKeyVersion) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_expired",
        "withdrawal destination lookup key changed and must be revalidated",
      );
    }
    const address = codec.decrypt(stored.addressCiphertext);
    if (codec.fingerprint(address) !== stored.addressLookupHmac) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "withdrawal destination ciphertext and fingerprint differ",
      );
    }
    return {
      recipientId: stored.id,
      accountId: userId,
      networkId: stored.networkId,
      asset,
      address,
      addressFingerprint: stored.addressLookupHmac,
      validatedAt:
        typeof stored.validationEvidence.validatedAt === "string"
          ? stored.validationEvidence.validatedAt
          : stored.expiresAt.toISOString(),
      expiresAt: stored.expiresAt.toISOString(),
      validationPolicyVersion: stored.policyVersion,
    };
  }

  async revoke(userId: string, recipientId: string) {
    const destination = await (
      this.dependencies.revokeDestination ??
      revokeFundingWithdrawalDestinationInTransaction
    )(this.db, {
      userId,
      destinationId: recipientId,
      reason: "user_revoked",
      cryptoShred: true,
      now: this.dependencies.now?.() ?? new Date(),
    });
    return {
      recipientId: destination.id,
      revoked: true,
      revokedAt: destination.revokedAt?.toISOString() ?? null,
    } as const;
  }
}
