import { SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import type { SvmTransactionAction } from "../domain/types.js";

export const DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY =
  "direct_solana_withdrawal_fee_only_v1";

/** Shape is capability only. The execution boundary must bind the entire
 * message to the owned, committed withdrawal and its encrypted recipient. */
export function isDirectSolanaFeeOnlyAction(
  action: SvmTransactionAction,
  signer: string,
): boolean {
  if (
    action.networkId !== "solana:mainnet" ||
    action.instructions.length !== 1 ||
    action.addressLookupTables.length !== 0
  )
    return false;
  const ix = action.instructions[0];
  if (
    !ix ||
    ix.dataEncoding !== "hex" ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(ix.data)
  )
    return false;
  const data = Buffer.from(ix.data, "hex");
  if (ix.programId === SystemProgram.programId.toBase58()) {
    return (
      data.length === 12 &&
      data.readUInt32LE(0) === 2 &&
      data.readBigUInt64LE(4) > 0n &&
      ix.accounts.length === 2 &&
      ix.accounts[0]?.address === signer &&
      ix.accounts[0].signer &&
      ix.accounts[0].writable &&
      ix.accounts[1]?.writable === true &&
      !ix.accounts[1].signer &&
      ix.accounts[1].address !== signer
    );
  }
  return (
    ix.programId === TOKEN_PROGRAM_ID.toBase58() &&
    data.length === 10 &&
    data[0] === 12 &&
    data[9] === 6 &&
    data.readBigUInt64LE(1) > 0n &&
    ix.accounts.length === 4 &&
    ix.accounts[1]?.address === RELAY_PINNED_ASSETS.solanaUsdc &&
    ix.accounts[3]?.address === signer &&
    ix.accounts[3].signer &&
    ix.accounts.slice(0, 3).every((key) => !key.signer)
  );
}
