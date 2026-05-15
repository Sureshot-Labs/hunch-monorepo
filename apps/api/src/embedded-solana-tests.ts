#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  buildEmbeddedSolanaSignAndSendRequest,
  prepareEmbeddedSolanaTransactionRequests,
  shouldDisableEmbeddedSolanaSponsorshipForTransaction,
  type EmbeddedSolanaWalletContext,
} from "./services/embedded-solana.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const signerKeypair = Keypair.generate();
const walletContext: EmbeddedSolanaWalletContext = {
  signer: signerKeypair.publicKey.toBase58(),
  walletId: "wallet-id",
  walletProfile: {
    walletId: "wallet-id",
    address: signerKeypair.publicKey.toBase58(),
    walletType: "solana",
    source: "embedded",
    isInternalWallet: true,
  },
};

const RECENT_BLOCKHASH = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_SYNC_NATIVE_INSTRUCTION = 17;

function serializeTransaction(
  instructions: TransactionInstruction[],
  payerKey = signerKeypair.publicKey,
): string {
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: RECENT_BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    "base64",
  );
}

function getSponsor(
  request: ReturnType<typeof buildEmbeddedSolanaSignAndSendRequest>,
) {
  return (request.input.body as { sponsor?: boolean }).sponsor;
}

const tests: TestCase[] = [
  {
    name: "embedded solana disables sponsorship for native SOL transfer from signer",
    run: () => {
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
        }),
      ]);

      assert.equal(
        shouldDisableEmbeddedSolanaSponsorshipForTransaction({
          signer: walletContext.signer,
          transaction,
        }),
        true,
      );

      const request = buildEmbeddedSolanaSignAndSendRequest({
        context: walletContext,
        transaction: {
          id: "sol-swap",
          label: "SOL swap",
          transaction,
        },
      });

      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "embedded solana disables sponsorship for wrapped SOL sync native",
    run: () => {
      const wrappedSolAccount = Keypair.generate().publicKey;
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: SPL_TOKEN_PROGRAM_ID,
          keys: [
            {
              pubkey: wrappedSolAccount,
              isSigner: false,
              isWritable: true,
            },
          ],
          data: Buffer.from([TOKEN_SYNC_NATIVE_INSTRUCTION]),
        }),
      ]);

      assert.equal(
        shouldDisableEmbeddedSolanaSponsorshipForTransaction({
          signer: walletContext.signer,
          transaction,
        }),
        true,
      );

      const request = buildEmbeddedSolanaSignAndSendRequest({
        context: walletContext,
        transaction: {
          id: "wrapped-sol-swap",
          label: "Wrapped SOL swap",
          transaction,
        },
      });

      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "embedded solana keeps sponsorship for account creation rent setup",
    run: () => {
      const transaction = serializeTransaction([
        SystemProgram.createAccount({
          fromPubkey: signerKeypair.publicKey,
          newAccountPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
          space: 0,
          programId: SystemProgram.programId,
        }),
      ]);

      assert.equal(
        shouldDisableEmbeddedSolanaSponsorshipForTransaction({
          signer: walletContext.signer,
          transaction,
        }),
        false,
      );

      const request = buildEmbeddedSolanaSignAndSendRequest({
        context: walletContext,
        transaction: {
          id: "account-setup",
          label: "Account setup",
          transaction,
        },
      });

      assert.equal(getSponsor(request), true);
    },
  },
  {
    name: "prepare embedded solana requests preserves explicit sponsor false",
    run: () => {
      const transaction = serializeTransaction([
        SystemProgram.createAccount({
          fromPubkey: signerKeypair.publicKey,
          newAccountPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
          space: 0,
          programId: SystemProgram.programId,
        }),
      ]);

      const requests = prepareEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "account-setup",
            label: "Account setup",
            transaction,
            sponsor: false,
          },
        ],
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[embedded-solana-tests] passed ${passed}/${tests.length}`);
