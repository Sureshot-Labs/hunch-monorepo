import assert from "node:assert/strict";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  ComputeBudgetProgram,
  type Connection,
} from "@solana/web3.js";
import {
  estimateRelaySplGas,
  isRelaySplGasTransaction,
  relaySplGasRequirement,
} from "./solana-gas.js";
import {
  RELAY_SOLANA_DEPOSITORY,
  SPL_TOKEN_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
} from "./solana-rehearsal.js";
import { SOLANA_USDC } from "./rehearsal.js";

const signer = "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ";
const payer = new PublicKey(signer);
const keys = [
  "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc",
  signer,
  signer,
  "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
  SOLANA_USDC,
  getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC), payer).toBase58(),
  "4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia",
  SPL_TOKEN_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
];
const data = Buffer.alloc(48);
Buffer.from("0b9c60da27a3b413", "hex").copy(data);
data.writeBigUInt64LE(2_000_000n, 8);
const deposit = new TransactionInstruction({
  programId: new PublicKey(RELAY_SOLANA_DEPOSITORY),
  keys: keys.map((address, index) => ({
    pubkey: new PublicKey(address),
    isSigner: index === 1,
    isWritable: [1, 5, 6].includes(index),
  })),
  data,
});
function tx(instructions = [deposit]) {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: SystemProgram.programId.toBase58(),
      instructions,
    }).compileToV0Message(),
  );
}
function allowed(transaction: VersionedTransaction) {
  return isRelaySplGasTransaction(
    transaction,
    TransactionMessage.decompile(transaction.message).instructions,
    signer,
  );
}
assert.equal(allowed(tx()), true);
assert.equal(
  allowed(
    tx([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
      deposit,
    ]),
  ),
  true,
);
assert.equal(allowed(tx([deposit, deposit])), false);
assert.equal(
  allowed(
    tx([
      deposit,
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey("7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ"),
        lamports: 1,
      }),
    ]),
  ),
  false,
);
const native = new TransactionInstruction({
  ...deposit,
  data: Buffer.from(deposit.data),
});
Buffer.from("0d9e0ddf5fd51c06", "hex").copy(native.data);
assert.equal(allowed(tx([native])), false);
const wrongMint = new TransactionInstruction({
  ...deposit,
  keys: deposit.keys.map((key, index) =>
    index === 4 ? { ...key, pubkey: SystemProgram.programId } : key,
  ),
});
assert.equal(allowed(tx([wrongMint])), false);
const separatePayer = new VersionedTransaction(
  new TransactionMessage({
    payerKey: new PublicKey("5CnexXV3q3B4kDRev36fdMUoCpP4qFmS7PKXNpZrgL3H"),
    recentBlockhash: SystemProgram.programId.toBase58(),
    instructions: [deposit],
  }).compileToV0Message(),
);
assert.equal(separatePayer.message.header.numRequiredSignatures, 2);
assert.equal(
  allowed(separatePayer),
  false,
  "a successful separate-fee-payer simulation must not grant the user-paid gas exception or sponsorship",
);

const measured = {
  before: 2_995_000,
  after: 2_990_000,
  fee: 5000,
  rent: 890880,
  available: 2_995_000n,
};
assert.deepEqual(relaySplGasRequirement(measured), {
  requiredLamports: 950880n,
  availableLamports: 2995000n,
  sufficient: true,
});
assert.equal(
  relaySplGasRequirement({ ...measured, rent: 810624 })?.requiredLamports,
  870624n,
  "2026-09-08 authorized live unsigned probe: actual RPC rent, not a hardcoded floor",
);
assert.equal(
  relaySplGasRequirement({ ...measured, available: 950879n })?.sufficient,
  false,
);
assert.equal(
  relaySplGasRequirement({ ...measured, available: 950880n })?.sufficient,
  true,
);
assert.equal(
  relaySplGasRequirement({ ...measured, after: measured.before + 1 }),
  null,
);
assert.equal(relaySplGasRequirement({ ...measured, fee: NaN }), null);
assert.equal(relaySplGasRequirement({ ...measured, fee: 0 }), null);
assert.equal(
  relaySplGasRequirement({ ...measured, available: 0n })?.sufficient,
  false,
  "observed fee-only transfers do not make zero-SOL wallets executable",
);
assert.equal(
  relaySplGasRequirement({ ...measured, fee: 3_000_000 })?.sufficient,
  false,
  "use this message's fee, not the 5,000-lamport historical baseline",
);
assert.equal(
  relaySplGasRequirement({ ...measured, after: 900_000 })?.sufficient,
  false,
  "account setup costs cannot be hidden by the historical fee average",
);

let simulationError: unknown = null;
let missingAfter = false;
let fee: number | null = 5000;
let extraCost = 0;
const connection = {
  getAccountInfoAndContext: async () => ({
    context: { slot: 100 },
    value: {
      owner: SystemProgram.programId,
      executable: false,
      data: Buffer.alloc(0),
      lamports: 2995000,
    },
  }),
  getFeeForMessage: async () => ({ value: fee }),
  getMinimumBalanceForRentExemption: async () => 890880,
  simulateTransaction: async (
    _tx: unknown,
    config: { minContextSlot: number; sigVerify: boolean },
  ) => {
    assert.equal(config.minContextSlot, 100);
    assert.equal(config.sigVerify, false);
    return {
      value: {
        err: simulationError,
        accounts: missingAfter
          ? []
          : [
              {
                owner: SOLANA_SYSTEM_PROGRAM,
                executable: false,
                data: ["", "base64"],
                lamports: 2990000 - extraCost,
              },
            ],
      },
    };
  },
} as unknown as Connection;
assert.equal(
  (await estimateRelaySplGas({ connection, transaction: tx(), signer }))
    ?.sufficient,
  true,
);
extraCost = 2_100_000;
assert.equal(
  (await estimateRelaySplGas({ connection, transaction: tx(), signer }))
    ?.sufficient,
  false,
);
extraCost = 0;
simulationError = { InstructionError: [0, "InsufficientFunds"] };
assert.equal(
  await estimateRelaySplGas({ connection, transaction: tx(), signer }),
  null,
);
simulationError = null;
missingAfter = true;
assert.equal(
  await estimateRelaySplGas({ connection, transaction: tx(), signer }),
  null,
);
missingAfter = false;
fee = null;
assert.equal(
  await estimateRelaySplGas({ connection, transaction: tx(), signer }),
  null,
);
assert.equal(
  await estimateRelaySplGas({ connection, transaction: tx([native]), signer }),
  null,
);
console.log(
  "[solana-gas-tests] measured fees/rent, low-balance boundaries, instruction scope, native/batch rejection, simulation failures and unknown RPC evidence passed",
);
