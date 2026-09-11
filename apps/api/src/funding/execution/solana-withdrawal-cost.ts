import {
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { createSolanaRpcConnection } from "../../services/rpc-client-factory.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import { relaySolanaActionMessage } from "../../funding-providers/relay/solana-sponsorship.js";
import { calculateWithdrawalCapacity } from "../domain/withdrawal-capacity.js";
import type { Money, WalletExecutionProfile } from "../domain/types.js";
import {
  buildExactSolWithdrawalAction,
  buildExactUsdcWithdrawalAction,
} from "./direct-withdrawal-transfer.js";

export type SolanaWithdrawalCostInput = {
  profile: WalletExecutionProfile;
  recipient: { address: string; addressFingerprint: string };
  asset: Money["asset"];
  availableRaw: bigint;
  availableSolRaw: bigint;
  sponsorEligible: boolean;
  requestedRaw?: bigint;
  /** Read-only preflight only. Committed actions must remain exact. */
  normalizeAmount?: boolean;
  connection?: Connection;
};

/** This public account is used ONLY as an unsigned simulation fee payer.
 * It is never an execution signer or a transfer source. */
async function simulationPayer(connection: Connection, excluded: string[]) {
  const address = new PublicKey(await connection.getSlotLeader("confirmed"));
  const info = await connection.getAccountInfo(address, "confirmed");
  if (
    excluded.includes(address.toBase58()) ||
    !info ||
    info.executable ||
    info.data.length !== 0 ||
    !info.owner.equals(SystemProgram.programId) ||
    info.lamports <= 1_000_000
  )
    throw new Error("Withdrawal simulation payer unavailable");
  return address;
}

export async function inspectSolanaWithdrawalCost(
  input: SolanaWithdrawalCostInput,
) {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (!input.connection && !rpcUrl)
    throw new Error("Withdrawal RPC unavailable");
  const signal = AbortSignal.timeout(6_000);
  const connection =
    input.connection ??
    createSolanaRpcConnection(rpcUrl as string, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal }),
    });
  const signer = new PublicKey(input.profile.address);
  const recipient = new PublicKey(input.recipient.address);
  if (signer.equals(recipient))
    throw new Error("Withdrawal recipient must differ from source");
  const nativeAsset =
    input.asset.assetId === SystemProgram.programId.toBase58() &&
    input.asset.decimals === 9;
  if (
    input.asset.networkId !== "solana:mainnet" ||
    (!nativeAsset &&
      (input.asset.assetId !== RELAY_PINNED_ASSETS.solanaUsdc ||
        input.asset.decimals !== 6))
  )
    throw new Error("Unsupported direct withdrawal asset");
  const senderInfo = await connection.getAccountInfo(signer, "confirmed");
  if (
    senderInfo &&
    (senderInfo.executable ||
      senderInfo.data.length !== 0 ||
      !senderInfo.owner.equals(SystemProgram.programId))
  )
    throw new Error("Withdrawal signer must be a system wallet");
  const nativeBalance = BigInt(senderInfo?.lamports ?? 0);
  let availableRaw =
    nativeAsset && input.availableRaw > nativeBalance
      ? nativeBalance
      : input.availableRaw;
  let createRecipientAta = false;
  let accountRentRaw = 0n;
  if (!nativeAsset) {
    const mint = new PublicKey(RELAY_PINNED_ASSETS.solanaUsdc);
    const source = getAssociatedTokenAddressSync(mint, signer);
    const destination = getAssociatedTokenAddressSync(mint, recipient);
    const infos = await connection.getMultipleAccountsInfo(
      [source, destination],
      "confirmed",
    );
    const sourceInfo = infos[0];
    if (!sourceInfo) throw new Error("Withdrawal USDC source unavailable");
    const token = unpackAccount(source, sourceInfo);
    if (
      !token.isInitialized ||
      token.isFrozen ||
      !token.mint.equals(mint) ||
      !token.owner.equals(signer)
    )
      throw new Error("Withdrawal USDC source invalid");
    if (availableRaw > token.amount) availableRaw = token.amount;
    const destinationInfo = infos[1];
    if (destinationInfo) {
      const account = unpackAccount(destination, destinationInfo);
      if (
        !account.isInitialized ||
        account.isFrozen ||
        !account.mint.equals(mint) ||
        !account.owner.equals(recipient)
      )
        throw new Error("Withdrawal recipient token account invalid");
    } else {
      createRecipientAta = true;
      accountRentRaw = BigInt(
        await connection.getMinimumBalanceForRentExemption(
          ACCOUNT_SIZE,
          "confirmed",
        ),
      );
    }
  }
  const payer =
    input.sponsorEligible && !createRecipientAta
      ? ("privy_sponsor" as const)
      : ("user" as const);
  const build = (raw: bigint) => {
    const common = {
      amount: { asset: input.asset, raw: raw.toString() },
      profile: input.profile,
      recipient: input.recipient,
    };
    return nativeAsset
      ? buildExactSolWithdrawalAction(common)
      : buildExactUsdcWithdrawalAction({ ...common, createRecipientAta });
  };
  const latest = await connection.getLatestBlockhash("confirmed");
  const payerKey =
    payer === "privy_sponsor"
      ? await simulationPayer(connection, [
          signer.toBase58(),
          recipient.toBase58(),
        ])
      : signer;
  const messageFor = (raw: bigint) => {
    const message = relaySolanaActionMessage(
      build(raw).action,
      signer.toBase58(),
      latest.blockhash,
    );
    message.payerKey = payerKey;
    return message.compileToV0Message();
  };
  const fee = (await connection.getFeeForMessage(messageFor(1n), "confirmed"))
    .value;
  if (fee == null || !Number.isSafeInteger(fee) || fee <= 0 || fee > 15_000)
    throw new Error("Withdrawal network fee unavailable or outside policy");
  const capacity = calculateWithdrawalCapacity({
    nativeAsset,
    availableRaw,
    availableSolRaw:
      input.availableSolRaw < nativeBalance
        ? input.availableSolRaw
        : nativeBalance,
    networkFeeRaw: BigInt(fee),
    accountRentRaw,
    payer,
  });
  let raw = input.requestedRaw ?? capacity.maximumSourceRaw;
  if (input.normalizeAmount && raw > capacity.maximumSourceRaw)
    raw = capacity.maximumSourceRaw;
  if (raw > 0n && raw <= capacity.maximumSourceRaw) {
    const simulate = (amount: bigint) =>
      connection.simulateTransaction(
        new VersionedTransaction(messageFor(amount)),
        {
          sigVerify: false,
          commitment: "confirmed",
          minContextSlot,
        },
      );
    const minContextSlot = await connection.getSlot("confirmed");
    let simulation = await simulate(raw);
    const error = simulation.value.err;
    const rentError =
      error && typeof error === "object" && "InsufficientFundsForRent" in error
        ? error.InsufficientFundsForRent
        : null;
    const rentAccountIndex =
      rentError &&
      typeof rentError === "object" &&
      "account_index" in rentError &&
      typeof rentError.account_index === "number" &&
      Number.isInteger(rentError.account_index) &&
      rentError.account_index >= 0
        ? rentError.account_index
        : null;
    // A near-full native withdrawal can leave a nonzero, rent-ineligible
    // sender balance. Reduce only during preflight, never after confirmation.
    if (
      input.normalizeAmount &&
      nativeAsset &&
      rentAccountIndex !== null &&
      messageFor(raw).staticAccountKeys[rentAccountIndex]?.equals(signer)
    ) {
      const rent = BigInt(
        await connection.getMinimumBalanceForRentExemption(0, "confirmed"),
      );
      const spendable = nativeBalance - capacity.userSolCostRaw - rent;
      raw = spendable > 0n && spendable < raw ? spendable : 0n;
      if (input.requestedRaw == null) capacity.maximumSourceRaw = raw;
      if (raw > 0n) simulation = await simulate(raw);
      else capacity.reasonCode = "insufficient_sol_for_rent";
    }
    if (raw > 0n && simulation.value.err)
      throw new Error("Withdrawal simulation failed");
  }
  return {
    ...capacity,
    networkFeeRaw: BigInt(fee),
    accountRentRaw,
    payer,
    sourceAmountRaw: raw,
    createRecipientAta,
    built: raw > 0n && raw <= capacity.maximumSourceRaw ? build(raw) : null,
  };
}
