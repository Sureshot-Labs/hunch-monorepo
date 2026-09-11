import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import type { SvmTransactionAction } from "../../funding/domain/types.js";
import { isRelaySplGasTransaction } from "./solana-gas.js";
import { SOLANA_USDC } from "./rehearsal.js";
import { createSolanaRpcConnection } from "../../services/rpc-client-factory.js";

export const RELAY_SOLANA_FEE_ONLY_POLICY = "relay_solana_usdc_fee_only_v1";

/** Narrow server-validated capability; independent kill switch, not Kalshi's. */
export function relaySolanaSponsorshipEnabled(): boolean {
  const setting = process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
  return setting === undefined || setting === "true";
}

export function relaySolanaActionMessage(
  action: SvmTransactionAction,
  signer: string,
  blockhash: string,
): TransactionMessage {
  return new TransactionMessage({
    payerKey: new PublicKey(signer),
    recentBlockhash: blockhash,
    instructions: action.instructions.map(
      (ix) =>
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map((key) => ({
            pubkey: new PublicKey(key.address),
            isSigner: key.signer,
            isWritable: key.writable,
          })),
          data: Buffer.from(ix.data.replace(/^0x/, ""), "hex"),
        }),
    ),
  });
}

/** Shape alone never authorizes spending: caller must load the owned DB action. */
export function isRelaySolanaSponsorAction(
  action: SvmTransactionAction,
  signer: string,
): boolean {
  if (action.networkId !== "solana:mainnet" || action.instructions.length !== 1)
    return false;
  try {
    const message = relaySolanaActionMessage(
      action,
      signer,
      "11111111111111111111111111111111",
    );
    const tx = new VersionedTransaction(message.compileToV0Message());
    return isRelaySplGasTransaction(
      tx,
      TransactionMessage.decompile(tx.message).instructions,
      signer,
    );
  } catch {
    return false;
  }
}

/** Compare the whole message, not just its advertised amount or client ID. */
export function matchesRelaySolanaSponsorTransaction(input: {
  action: SvmTransactionAction;
  signer: string;
  transaction: VersionedTransaction;
  lookupTables: AddressLookupTableAccount[];
}): boolean {
  if (!isRelaySolanaSponsorAction(input.action, input.signer)) return false;
  const expected = relaySolanaActionMessage(
    input.action,
    input.signer,
    input.transaction.message.recentBlockhash,
  ).compileToV0Message(input.lookupTables);
  return (
    Buffer.from(expected.serialize()).equals(
      Buffer.from(input.transaction.message.serialize()),
    ) &&
    input.transaction.signatures.every((signature) =>
      signature.every((byte) => byte === 0),
    )
  );
}

/**
 * Relay supplies the trusted deposit. The client cannot add instructions.
 * Existing canonical ATAs avoid account creation; simulation additionally
 * requires exactly the authorized transferChecked and no other CPI.
 * The vault is an UNSIGNED simulation payer only, never an execution signer.
 */
export async function proveRelaySolanaFeeOnly(input: {
  connection: Connection;
  action: SvmTransactionAction;
  signer: string;
}): Promise<boolean> {
  if (!isRelaySolanaSponsorAction(input.action, input.signer)) return false;
  const instruction = input.action.instructions[0];
  const sourceAddress = instruction?.accounts[5]?.address;
  const vaultAddress = instruction?.accounts[3]?.address;
  const destinationAddress = instruction?.accounts[6]?.address;
  if (!instruction || !sourceAddress || !vaultAddress || !destinationAddress)
    return false;
  const source = new PublicKey(sourceAddress);
  const vault = new PublicKey(vaultAddress);
  const destination = new PublicKey(destinationAddress);
  if (
    vault.toBase58() === input.signer ||
    !destination.equals(
      getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC), vault, true),
    )
  )
    return false;
  const before = await input.connection.getMultipleAccountsInfoAndContext(
    [source, destination, new PublicKey(input.signer)],
    "confirmed",
  );
  const rent = await input.connection.getMinimumBalanceForRentExemption(
    165,
    "confirmed",
  );
  const [sourceInfo, destinationInfo, signerInfo] = before.value;
  // A token authority need not hold SOL or have a materialized system account:
  // the separate payer pays the fee. Existing token accounts and the exact
  // simulated CPI below, not the authority's balance, establish no rent work.
  if (
    signerInfo &&
    (signerInfo.owner.toBase58() !== "11111111111111111111111111111111" ||
      signerInfo.executable ||
      signerInfo.data.length !== 0)
  )
    return false;
  if (
    !sourceInfo ||
    !destinationInfo ||
    sourceInfo.lamports < rent ||
    destinationInfo.lamports < rent
  )
    return false;
  const sourceToken = unpackAccount(source, sourceInfo);
  const destinationToken = unpackAccount(destination, destinationInfo);
  const amount = Buffer.from(
    instruction.data.replace(/^0x/, ""),
    "hex",
  ).readBigUInt64LE(8);
  if (
    amount <= 0n ||
    !sourceToken.isInitialized ||
    sourceToken.isFrozen ||
    !destinationToken.isInitialized ||
    destinationToken.isFrozen ||
    sourceToken.isNative ||
    destinationToken.isNative ||
    sourceToken.amount < amount ||
    !sourceToken.owner.equals(new PublicKey(input.signer)) ||
    !destinationToken.owner.equals(vault) ||
    sourceToken.mint.toBase58() !== SOLANA_USDC ||
    destinationToken.mint.toBase58() !== SOLANA_USDC ||
    destinationToken.closeAuthority !== null ||
    destinationToken.delegate !== null
  )
    return false;
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const message = relaySolanaActionMessage(
    input.action,
    input.signer,
    latest.blockhash,
  );
  message.payerKey = vault;
  const transaction = new VersionedTransaction(message.compileToV0Message());
  const [fee, simulation] = await Promise.all([
    input.connection.getFeeForMessage(transaction.message, "confirmed"),
    input.connection.simulateTransaction(transaction, {
      commitment: "confirmed",
      minContextSlot: before.context.slot,
      sigVerify: false,
      innerInstructions: true,
    }),
  ]);
  if (!fee.value || fee.value > 15_000 || simulation.value.err) return false;
  const calls = simulation.value.innerInstructions?.flatMap(
    (group) => group.instructions,
  );
  if (calls?.length !== 1) return false;
  const call = calls[0];
  if (
    !call ||
    !("parsed" in call) ||
    call.programId.toBase58() !== sourceInfo.owner.toBase58()
  )
    return false;
  const parsed = call.parsed as {
    type?: string;
    info?: {
      authority?: string;
      source?: string;
      destination?: string;
      mint?: string;
      tokenAmount?: { amount?: string };
    };
  };
  return (
    parsed.type === "transferChecked" &&
    parsed.info?.authority === input.signer &&
    parsed.info.source === source.toBase58() &&
    parsed.info.destination === destination.toBase58() &&
    parsed.info.mint === SOLANA_USDC &&
    parsed.info.tokenAmount?.amount === amount.toString()
  );
}

export async function checkRelaySolanaFeeOnly(input: {
  action: SvmTransactionAction;
  signer: string;
  signal?: AbortSignal;
}): Promise<boolean | null> {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (!relaySolanaSponsorshipEnabled()) return false;
  if (!rpcUrl) return null;
  const deadline = AbortSignal.timeout(4000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  try {
    const connection = createSolanaRpcConnection(rpcUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal }),
    });
    return await proveRelaySolanaFeeOnly({
      connection,
      action: input.action,
      signer: input.signer,
    });
  } catch {
    // Do not leak RPC URLs or conflate an unavailable proof with a rejection.
    console.warn("[funding-relay] sponsorship verification unavailable", {
      reason: signal.aborted
        ? "timeout_or_cancelled"
        : "rpc_or_validation_error",
    });
    return null;
  }
}
