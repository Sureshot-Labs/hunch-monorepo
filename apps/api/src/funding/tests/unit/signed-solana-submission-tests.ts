import assert from "node:assert/strict";
import {
  Keypair,
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  parseVerifiedSolanaSubmission,
  verifySignedSolanaFundingSubmission,
} from "../../execution/signed-solana-submission.js";
import { relaySolanaActionMessage } from "../../../funding-providers/relay/solana-sponsorship.js";
import {
  RELAY_SOLANA_DEPOSITORY,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
} from "../../../funding-providers/relay/solana-rehearsal.js";
import { SOLANA_USDC } from "../../../funding-providers/relay/rehearsal.js";
import type { SvmTransactionAction } from "../../domain/types.js";

const key = Keypair.generate();
const signer = key.publicKey.toBase58();
const vault = new PublicKey("7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ");
const mint = new PublicKey(SOLANA_USDC);
const data = Buffer.alloc(48, 1);
Buffer.from("0b9c60da27a3b413", "hex").copy(data);
data.writeBigUInt64LE(1_398_210n, 8);
const addresses = [
  "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc",
  signer,
  signer,
  vault.toBase58(),
  SOLANA_USDC,
  getAssociatedTokenAddressSync(mint, key.publicKey).toBase58(),
  getAssociatedTokenAddressSync(mint, vault, true).toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SystemProgram.programId.toBase58(),
];
const action: SvmTransactionAction = {
  actionId: "test",
  kind: "svm_transaction",
  networkId: "solana:mainnet",
  signerWalletId: "test-wallet",
  addressLookupTables: [],
  instructions: [
    {
      programId: RELAY_SOLANA_DEPOSITORY,
      data: data.toString("hex"),
      dataEncoding: "hex",
      accounts: addresses.map((address, index) => ({
        address,
        signer: index === 1,
        writable: [1, 5, 6].includes(index),
      })),
    },
  ],
};
const transaction = new VersionedTransaction(
  relaySolanaActionMessage(
    action,
    signer,
    SystemProgram.programId.toBase58(),
  ).compileToV0Message(),
);
const encoded = () => Buffer.from(transaction.serialize()).toString("base64");
const validate = (signedTransaction = encoded()) =>
  verifySignedSolanaFundingSubmission({
    action,
    signer,
    signedTransaction,
    lookupTables: [],
  });
assert.throws(() => validate(), /signature is invalid/);
transaction.sign([key]);
assert.equal(validate().blockhash, SystemProgram.programId.toBase58());
assert.ok(validate().signature.length > 60);
assert.throws(() => validate(encoded() + "junk"));
assert.throws(() =>
  verifySignedSolanaFundingSubmission({
    action,
    signer: Keypair.generate().publicKey.toBase58(),
    signedTransaction: encoded(),
    lookupTables: [],
  }),
);
const first = action.instructions[0];
assert.ok(first);
const changed = {
  ...action,
  instructions: [{ ...first, data: first.data.replace("c25515", "c35515") }],
};
assert.throws(
  () =>
    verifySignedSolanaFundingSubmission({
      action: changed,
      signer,
      signedTransaction: encoded(),
      lookupTables: [],
    }),
  /committed action/,
);

// Native SOL uses the same canonical-message validator; no Relay USDC shape
// is hardcoded into the external signing protocol.
const recipient = Keypair.generate().publicKey;
const nativeInstruction = SystemProgram.transfer({
  fromPubkey: key.publicKey,
  toPubkey: recipient,
  lamports: 123,
});
const lookupTable = new AddressLookupTableAccount({
  key: Keypair.generate().publicKey,
  state: {
    deactivationSlot: 18446744073709551615n,
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    addresses: [recipient],
  },
});
const nativeAction: SvmTransactionAction = {
  ...action,
  addressLookupTables: [lookupTable.key.toBase58()],
  instructions: [
    {
      programId: nativeInstruction.programId.toBase58(),
      data: nativeInstruction.data.toString("hex"),
      dataEncoding: "hex",
      accounts: nativeInstruction.keys.map((row) => ({
        address: row.pubkey.toBase58(),
        signer: row.isSigner,
        writable: row.isWritable,
      })),
    },
  ],
};
const nativeTx = new VersionedTransaction(
  relaySolanaActionMessage(
    nativeAction,
    signer,
    SystemProgram.programId.toBase58(),
  ).compileToV0Message([lookupTable]),
);
nativeTx.sign([key]);
const nativeInput = {
  action: nativeAction,
  signer,
  signedTransaction: Buffer.from(nativeTx.serialize()).toString("base64"),
  lookupTables: [lookupTable],
};
const nativeIdentity = verifySignedSolanaFundingSubmission(nativeInput);
assert.ok(nativeIdentity.signature);
assert.throws(
  () =>
    verifySignedSolanaFundingSubmission({ ...nativeInput, lookupTables: [] }),
  /committed action/,
);
assert.throws(
  () =>
    verifySignedSolanaFundingSubmission({
      ...nativeInput,
      action: {
        ...nativeAction,
        instructions: [
          ...nativeAction.instructions,
          ...nativeAction.instructions,
        ],
      },
    }),
  /committed action/,
);
assert.equal(
  parseVerifiedSolanaSubmission({
    ...nativeIdentity,
    version: 1,
    lastValidBlockHeight: -1,
  }),
  null,
);
assert.deepEqual(
  parseVerifiedSolanaSubmission({
    ...nativeIdentity,
    version: 1,
    lastValidBlockHeight: 100,
  }),
  { ...nativeIdentity, version: 1, lastValidBlockHeight: 100 },
);
