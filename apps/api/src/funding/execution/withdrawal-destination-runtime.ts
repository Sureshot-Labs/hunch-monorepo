import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import type { AssetRef, ResolvedExternalRecipient } from "../domain/types.js";
import {
  supportsWithdrawalDestinationAsset,
  WITHDRAWAL_DESTINATION_CONTRACT_REVISION,
  WITHDRAWAL_DESTINATION_CONTRACT_VERSION,
} from "../domain/withdrawal-contract.js";
import {
  fetchFundingWithdrawalDestinationForUser,
  registerFundingWithdrawalDestination,
  revokeFundingWithdrawalDestinationInTransaction,
} from "../persistence/funding-evidence-repository.js";
import { parsePositiveInteger } from "../runtime/positive-integer.js";
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
  addressKind: "evm_address" | "evm_eoa" | "evm_contract" | "solana_address";
  evidenceRevision: string;
}>;

export function assertWithdrawalRecipientContract(asset: AssetRef): void {
  if (!supportsWithdrawalDestinationAsset(asset)) {
    throw new WithdrawalDestinationError(
      "withdrawal_destination_unsupported",
      "withdrawal recipient asset is outside the code-owned contract",
    );
  }
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
    // ERC-20 transfers support both EOAs and contracts (including exchange
    // deposit addresses). A code lookup did not reject either kind, so making
    // registration depend on RPC availability only created a false blocker.
    // The encrypted fingerprint and action preparation still bind the exact
    // recipient selected by the authenticated user.
    return {
      normalizedAddress,
      addressKind: "evm_address",
      evidenceRevision: "evm-address-syntax-v1",
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
    if (publicKey.equals(SystemProgram.programId)) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_invalid",
        "the Solana system program is not a valid withdrawal destination",
      );
    }
    // Native SOL can be transferred to any valid public key, including an
    // exchange deposit address. The exact encrypted recipient remains bound
    // to the user-confirmed action; an RPC ownership lookup would not make the
    // transfer safer and would turn provider availability into a withdrawal
    // blocker.
    return {
      normalizedAddress: publicKey.toBase58(),
      addressKind: "solana_address",
      evidenceRevision: "solana-address-syntax-v1",
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
      revokeDestination?: typeof revokeFundingWithdrawalDestinationInTransaction;
    }> = {},
  ) {}

  private codec() {
    if (this.dependencies.codec) return this.dependencies.codec;
    const lookupKey =
      process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim() ?? "";
    const keyVersion =
      parsePositiveInteger(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ??
      1;
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
    assertWithdrawalRecipientContract(input.asset);
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
        addressValidation: "syntax_and_network",
        evidenceRevision: inspected.evidenceRevision,
        policyRevision: WITHDRAWAL_DESTINATION_CONTRACT_REVISION,
        validatedAt: now.toISOString(),
      },
      policyVersion: WITHDRAWAL_DESTINATION_CONTRACT_VERSION,
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
      validationPolicyVersion: WITHDRAWAL_DESTINATION_CONTRACT_VERSION,
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
    const stored = await (
      this.dependencies.fetchDestination ??
      fetchFundingWithdrawalDestinationForUser
    )(db, {
      userId,
      destinationId: recipientId,
      lockForShare: options.lockForShare,
    });
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
    assertWithdrawalRecipientContract(asset);
    const evidenceRevision = stored.validationEvidence.policyRevision;
    if (
      stored.policyVersion !== WITHDRAWAL_DESTINATION_CONTRACT_VERSION ||
      evidenceRevision !== WITHDRAWAL_DESTINATION_CONTRACT_REVISION
    ) {
      throw new WithdrawalDestinationError(
        "withdrawal_destination_expired",
        "withdrawal destination contract changed and must be revalidated",
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
