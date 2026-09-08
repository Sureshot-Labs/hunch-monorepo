import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { SvmTransactionAction } from "../../funding/domain/types.js";
import { createSolanaRpcConnection } from "../../services/rpc-client-factory.js";
import {
  RELAY_SOLANA_DEPOSITORY,
  SPL_TOKEN_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
} from "./solana-rehearsal.js";
import { SOLANA_USDC } from "./rehearsal.js";

// Additional headroom, not a replacement for measured fees or rent.
const GAS_HEADROOM_LAMPORTS = 50_000n;

export type RelaySplGasEstimate = Readonly<{
  requiredLamports: bigint;
  availableLamports: bigint;
  sufficient: boolean;
}>;

export function relaySplGasRequirement(input: {
  before: number;
  after: number;
  fee: number;
  rent: number;
  available: bigint;
}): RelaySplGasEstimate | null {
  if (
    ![input.before, input.after, input.fee, input.rent].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    input.fee === 0 ||
    input.after > input.before
  )
    return null;
  // Simulation may already include the fee: adding it again is conservative.
  const requiredLamports =
    BigInt(input.before - input.after) +
    BigInt(input.fee) +
    BigInt(input.rent) +
    GAS_HEADROOM_LAMPORTS;
  const availableLamports =
    input.available < BigInt(input.before)
      ? input.available
      : BigInt(input.before);
  return {
    requiredLamports,
    availableLamports,
    sufficient: availableLamports >= requiredLamports,
  };
}

/** Gas exception only; this is NOT a substitute for funding action validation. */
export function isRelaySplGasTransaction(
  tx: VersionedTransaction,
  instructions: readonly TransactionInstruction[],
  signer: string,
): boolean {
  if (
    tx.message.header.numRequiredSignatures !== 1 ||
    tx.message.staticAccountKeys[0]?.toBase58() !== signer
  )
    return false;
  const deposits = instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );
  const ix = deposits[0];
  if (
    deposits.length !== 1 ||
    !ix ||
    ix.programId.toBase58() !== RELAY_SOLANA_DEPOSITORY ||
    ix.data.length !== 48 ||
    ix.data.subarray(0, 8).toString("hex") !== "0b9c60da27a3b413" ||
    ix.keys.length !== 10
  )
    return false;
  const exact: Record<number, string> = {
    1: signer,
    2: signer,
    4: SOLANA_USDC,
    5: getAssociatedTokenAddressSync(
      new PublicKey(SOLANA_USDC),
      new PublicKey(signer),
    ).toBase58(),
    7: SPL_TOKEN_PROGRAM,
    8: SPL_ASSOCIATED_TOKEN_PROGRAM,
    9: SOLANA_SYSTEM_PROGRAM,
  };
  return (
    Object.entries(exact).every(
      ([index, address]) =>
        ix.keys[Number(index)]?.pubkey.toBase58() === address,
    ) &&
    // Decompilation restores message-global privileges: signer and depositor
    // are the same address, so both positions are writable signers.
    ix.keys.flatMap((key, index) => (key.isSigner ? [index] : [])).join(",") ===
      "1,2" &&
    ix.keys
      .flatMap((key, index) => (key.isWritable ? [index] : []))
      .join(",") === "1,2,5,6"
  );
}

export async function estimateRelaySplGas(input: {
  connection: Connection;
  transaction: VersionedTransaction;
  signer: string;
  availableLamports?: bigint;
}): Promise<RelaySplGasEstimate | null> {
  const { connection, transaction: tx, signer } = input;
  const lookups = tx.message.addressTableLookups;
  if (lookups.length > 4) return null;
  const tables = await Promise.all(
    lookups.map(async (lookup) => {
      const result = await connection.getAddressLookupTable(lookup.accountKey);
      if (!result.value) throw new Error("Solana lookup unavailable");
      return result.value;
    }),
  );
  const message = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: tables,
  });
  if (!isRelaySplGasTransaction(tx, message.instructions, signer)) return null;
  const payer = new PublicKey(signer);
  const before = await connection.getAccountInfoAndContext(payer, "confirmed");
  if (
    !before.value ||
    before.value.executable ||
    before.value.owner.toBase58() !== SOLANA_SYSTEM_PROGRAM ||
    before.value.data.length !== 0
  )
    return null;
  const [fee, rent, simulation] = await Promise.all([
    connection.getFeeForMessage(tx.message, "confirmed"),
    connection.getMinimumBalanceForRentExemption(0, "confirmed"),
    connection.simulateTransaction(tx, {
      commitment: "confirmed",
      minContextSlot: before.context.slot,
      sigVerify: false,
      accounts: { encoding: "base64", addresses: [signer] },
    }),
  ]);
  const after = simulation.value.accounts?.[0];
  if (
    fee.value == null ||
    simulation.value.err ||
    !after ||
    after.owner !== SOLANA_SYSTEM_PROGRAM ||
    after.executable ||
    after.data[0] !== ""
  )
    return null;
  return relaySplGasRequirement({
    before: before.value.lamports,
    after: after.lamports,
    fee: fee.value,
    rent,
    available: input.availableLamports ?? BigInt(before.value.lamports),
  });
}

/** All RPC calls share one deadline; no public-RPC fallback or persistent cache. */
export async function checkRelaySplGas(input: {
  signer: string;
  transaction?: string;
  action?: SvmTransactionAction;
  availableLamports?: bigint;
  signal?: AbortSignal;
}): Promise<RelaySplGasEstimate | null> {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (!rpcUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  try {
    const connection = createSolanaRpcConnection(rpcUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal }),
    });
    let tx: VersionedTransaction;
    if (input.transaction)
      tx = VersionedTransaction.deserialize(
        Buffer.from(input.transaction, "base64"),
      );
    else if (input.action) {
      // These few account keys fit without lookup tables. The validated actions
      // are unchanged; the real serialized transaction is checked before signing.
      const latest = await connection.getLatestBlockhash("confirmed");
      tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: new PublicKey(input.signer),
          recentBlockhash: latest.blockhash,
          instructions: input.action.instructions.map(
            (ix) =>
              new TransactionInstruction({
                programId: new PublicKey(ix.programId),
                keys: ix.accounts.map((key) => ({
                  pubkey: new PublicKey(key.address),
                  isSigner: key.signer,
                  isWritable: key.writable,
                })),
                data: Buffer.from(ix.data, ix.dataEncoding),
              }),
          ),
        }).compileToV0Message(),
      );
    } else return null;
    return await estimateRelaySplGas({ ...input, connection, transaction: tx });
  } catch {
    // Never leak RPC URLs; unknown costs cannot relax the existing gas floor.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
