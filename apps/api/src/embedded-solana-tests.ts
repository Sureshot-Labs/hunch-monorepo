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
  getEmbeddedSolanaSponsorshipRequirementLamports,
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
const USER_TX_FEE_BUFFER_LAMPORTS = 3_000_000n;
const SPONSOR_BASE_REQUIREMENT_LAMPORTS = 8_000_000n;

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

type BuildEmbeddedSolanaRequestInput = Omit<
  Parameters<typeof buildEmbeddedSolanaSignAndSendRequest>[0],
  "embeddedSolanaSponsorshipEnabled"
>;

function buildSponsoredEmbeddedSolanaSignAndSendRequest(
  inputs: BuildEmbeddedSolanaRequestInput,
) {
  return buildEmbeddedSolanaSignAndSendRequest({
    ...inputs,
    embeddedSolanaSponsorshipEnabled: true,
  });
}

type PrepareEmbeddedSolanaRequestsInput = Omit<
  Parameters<typeof prepareEmbeddedSolanaTransactionRequests>[0],
  "embeddedSolanaSponsorshipEnabled"
>;

function prepareSponsoredEmbeddedSolanaTransactionRequests(
  inputs: PrepareEmbeddedSolanaRequestsInput,
) {
  return prepareEmbeddedSolanaTransactionRequests({
    ...inputs,
    embeddedSolanaSponsorshipEnabled: true,
  });
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

      const request = buildSponsoredEmbeddedSolanaSignAndSendRequest({
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

      const request = buildSponsoredEmbeddedSolanaSignAndSendRequest({
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

      const request = buildSponsoredEmbeddedSolanaSignAndSendRequest({
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
    name: "embedded solana disables sponsorship by default",
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

      const request = buildEmbeddedSolanaSignAndSendRequest({
        context: walletContext,
        transaction: {
          id: "account-setup",
          label: "Account setup",
          transaction,
          sponsor: true,
        },
      });

      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "prepare embedded solana requests preserves explicit sponsor false",
    run: async () => {
      const transaction = serializeTransaction([
        SystemProgram.createAccount({
          fromPubkey: signerKeypair.publicKey,
          newAccountPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
          space: 0,
          programId: SystemProgram.programId,
        }),
      ]);

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
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
  {
    name: "prepare embedded solana requests rejects low SOL when sponsorship is disabled",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);

      await assert.rejects(
        async () =>
          prepareEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "normal-trade",
                label: "Normal trade",
                transaction,
                sponsor: true,
              },
            ],
            fetchSponsorBalanceLamports: async () =>
              USER_TX_FEE_BUFFER_LAMPORTS - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
  {
    name: "prepare embedded solana requests ignores client sponsor true when sponsorship is disabled",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);

      const requests = await prepareEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "normal-trade",
            label: "Normal trade",
            transaction,
            sponsor: true,
          },
        ],
        fetchSponsorBalanceLamports: async () =>
          USER_TX_FEE_BUFFER_LAMPORTS,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "prepare embedded solana requests rejects native SOL source below spend plus fee buffer",
    run: async () => {
      const transferLamports = 1_000_000n;
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: Number(transferLamports),
        }),
      ]);
      const requiredLamports = transferLamports + USER_TX_FEE_BUFFER_LAMPORTS;

      await assert.rejects(
        async () =>
          prepareSponsoredEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "sol-swap",
                label: "SOL swap",
                transaction,
              },
            ],
            fetchSponsorBalanceLamports: async () =>
              requiredLamports - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
  {
    name: "prepare embedded solana requests allows native SOL source at spend plus fee buffer without sponsorship",
    run: async () => {
      const transferLamports = 1_000_000n;
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: Number(transferLamports),
        }),
      ]);
      const requiredLamports = transferLamports + USER_TX_FEE_BUFFER_LAMPORTS;

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "sol-swap",
            label: "SOL swap",
            transaction,
          },
        ],
        fetchSponsorBalanceLamports: async () => requiredLamports,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "prepare embedded solana requests rejects wrapped SOL source below fee buffer",
    run: async () => {
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

      await assert.rejects(
        async () =>
          prepareSponsoredEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "wrapped-sol-swap",
                label: "Wrapped SOL swap",
                transaction,
              },
            ],
            fetchSponsorBalanceLamports: async () =>
              USER_TX_FEE_BUFFER_LAMPORTS - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
  {
    name: "prepare embedded solana requests does not hard reject account creation setup below SOL minimum",
    run: async () => {
      const transaction = serializeTransaction([
        SystemProgram.createAccount({
          fromPubkey: signerKeypair.publicKey,
          newAccountPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
          space: 0,
          programId: SystemProgram.programId,
        }),
      ]);

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "account-setup",
            label: "Account setup",
            transaction,
          },
        ],
        fetchSponsorBalanceLamports: async () => BigInt(0),
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), true);
    },
  },
  {
    name: "embedded solana disables sponsorship when signer can pay normal fees",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);

      assert.equal(
        getEmbeddedSolanaSponsorshipRequirementLamports({
          signer: walletContext.signer,
          transaction,
        }),
        SPONSOR_BASE_REQUIREMENT_LAMPORTS,
      );

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "normal-trade",
            label: "Normal trade",
            transaction,
          },
        ],
        fetchSponsorBalanceLamports: async () =>
          SPONSOR_BASE_REQUIREMENT_LAMPORTS,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "embedded solana keeps sponsorship when signer cannot pay normal fees",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "normal-trade",
            label: "Normal trade",
            transaction,
          },
        ],
        fetchSponsorBalanceLamports: async () =>
          SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), true);
    },
  },
  {
    name: "embedded solana includes account creation rent in sponsorship threshold",
    run: async () => {
      const accountCreationLamports = 20_000_000n;
      const transaction = serializeTransaction([
        SystemProgram.createAccount({
          fromPubkey: signerKeypair.publicKey,
          newAccountPubkey: Keypair.generate().publicKey,
          lamports: Number(accountCreationLamports),
          space: 0,
          programId: SystemProgram.programId,
        }),
      ]);
      const requiredLamports =
        SPONSOR_BASE_REQUIREMENT_LAMPORTS + accountCreationLamports;

      assert.equal(
        getEmbeddedSolanaSponsorshipRequirementLamports({
          signer: walletContext.signer,
          transaction,
        }),
        requiredLamports,
      );

      const lowBalanceRequests =
        await prepareSponsoredEmbeddedSolanaTransactionRequests({
          context: walletContext,
          transactions: [
            {
              id: "account-setup",
              label: "Account setup",
              transaction,
            },
          ],
          fetchSponsorBalanceLamports: async () => requiredLamports - 1n,
        });
      const lowBalanceRequest = lowBalanceRequests[0];
      assert.ok(lowBalanceRequest);
      assert.equal(getSponsor(lowBalanceRequest), true);

      const highBalanceRequests =
        await prepareSponsoredEmbeddedSolanaTransactionRequests({
          context: walletContext,
          transactions: [
            {
              id: "account-setup",
              label: "Account setup",
              transaction,
            },
          ],
          fetchSponsorBalanceLamports: async () => requiredLamports,
        });
      const highBalanceRequest = highBalanceRequests[0];
      assert.ok(highBalanceRequest);
      assert.equal(getSponsor(highBalanceRequest), false);
    },
  },
  {
    name: "prepare embedded solana requests allows sponsorship when balance fetch fails",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);
      let sawError = false;

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "normal-trade",
            label: "Normal trade",
            transaction,
          },
        ],
        fetchSponsorBalanceLamports: async () => {
          throw new Error("rpc down");
        },
        onSponsorBalanceFetchError: () => {
          sawError = true;
        },
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(sawError, true);
      assert.equal(getSponsor(request), true);
    },
  },
  {
    name: "prepare embedded solana requests fails closed for SOL source when balance fetch fails",
    run: async () => {
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
        }),
      ]);
      let sawError = false;

      await assert.rejects(
        async () =>
          prepareSponsoredEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "sol-swap",
                label: "SOL swap",
                transaction,
              },
            ],
            fetchSponsorBalanceLamports: async () => {
              throw new Error("rpc down");
            },
            onSponsorBalanceFetchError: () => {
              sawError = true;
            },
          }),
        /Unable to verify Solana balance/,
      );
      assert.equal(sawError, true);
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[embedded-solana-tests] passed ${passed}/${tests.length}`);
