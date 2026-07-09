#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  DEFAULT_SOLANA_USDC_MINT,
  deriveKalshiDflowTransactionContext,
  kalshiDflowTransactionSafetyTestHooks,
  KALSHI_DFLOW_MAX_SOL_DEBIT_LAMPORTS,
  KalshiDflowTransactionValidationError,
  validateKalshiDflowTransaction,
} from "./services/kalshi-dflow-transaction-safety.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const RECENT_BLOCKHASH = "11111111111111111111111111111111";

function u64Le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function buildTransaction(input: {
  amountInRaw: bigint;
  includeUnexpectedWalletTokenAccount?: boolean;
  minOutRaw: bigint;
  outputMint: PublicKey;
  unexpectedMint?: PublicKey;
  wallet: PublicKey;
}): string {
  const inputMint = new PublicKey(DEFAULT_SOLANA_USDC_MINT);
  const inputAta = getAssociatedTokenAddressSync(inputMint, input.wallet);
  const outputAta = getAssociatedTokenAddressSync(
    input.outputMint,
    input.wallet,
  );
  const venueUsdcVault = Keypair.generate().publicKey;
  const instructions: TransactionInstruction[] = [
    createTransferCheckedInstruction(
      inputAta,
      inputMint,
      venueUsdcVault,
      input.wallet,
      input.amountInRaw,
      6,
    ),
    new TransactionInstruction({
      data: u64Le(input.minOutRaw),
      keys: [
        { isSigner: false, isWritable: true, pubkey: outputAta },
        { isSigner: false, isWritable: false, pubkey: input.outputMint },
      ],
      programId: TOKEN_PROGRAM_ID,
    }),
  ];

  if (input.includeUnexpectedWalletTokenAccount) {
    const unexpectedMint = input.unexpectedMint ?? Keypair.generate().publicKey;
    const unexpectedAta = getAssociatedTokenAddressSync(
      unexpectedMint,
      input.wallet,
    );
    instructions.push(
      new TransactionInstruction({
        data: Buffer.from([1, 2, 3]),
        keys: [{ isSigner: false, isWritable: true, pubkey: unexpectedAta }],
        programId: TOKEN_PROGRAM_ID,
      }),
    );
  }

  const message = new TransactionMessage({
    instructions,
    payerKey: input.wallet,
    recentBlockhash: RECENT_BLOCKHASH,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  return Buffer.from(transaction.serialize()).toString("base64");
}

const tests: TestCase[] = [
  {
    name: "derives deterministic DFlow context from nested quote response",
    run: () => {
      const outputMint = Keypair.generate().publicKey.toBase58();
      assert.deepEqual(
        deriveKalshiDflowTransactionContext({
          quoteResponse: {
            route: {
              inAmount: "1000000",
              inputMint: DEFAULT_SOLANA_USDC_MINT,
              outAmount: "500000",
              outputMint,
            },
          },
        }),
        {
          amountInRaw: "1000000",
          amountOutRaw: "500000",
          inputMint: DEFAULT_SOLANA_USDC_MINT,
          minOutRaw: null,
          outputMint,
        },
      );
    },
  },
  {
    name: "validates expected wallet signer, fee payer, mints, and amounts",
    run: async () => {
      const wallet = Keypair.generate().publicKey;
      const outputMint = Keypair.generate().publicKey;
      const transaction = buildTransaction({
        amountInRaw: 1_000_000n,
        minOutRaw: 500_000n,
        outputMint,
        wallet,
      });
      const facts = await validateKalshiDflowTransaction({
        amountInRaw: "1000000",
        expectedInputMint: DEFAULT_SOLANA_USDC_MINT,
        inputMint: DEFAULT_SOLANA_USDC_MINT,
        minOutRaw: "500000",
        outputMint: outputMint.toBase58(),
        tokenAccountInfoLoader: async () => null,
        transactionSimulationLoader: async () => ({
          inputTokenSpendRaw: 1_000_000n,
          outputTokenReceiveRaw: 500_000n,
          solDebitLamports: 5_000n,
        }),
        transaction,
        walletAddress: wallet.toBase58(),
      });
      assert.equal(facts.amountInRaw, "1000000");
      assert.equal(facts.minOutRaw, "500000");
      assert.equal(facts.feePayer, wallet.toBase58());
      assert.deepEqual(facts.requiredSigners, [wallet.toBase58()]);
      assert.match(facts.transactionDigest, /^[0-9a-f]{64}$/);
    },
  },
  {
    name: "rejects arbitrary embedded amount bytes without simulated output",
    run: async () => {
      const wallet = Keypair.generate().publicKey;
      const outputMint = Keypair.generate().publicKey;
      const transaction = buildTransaction({
        amountInRaw: 1_000_000n,
        minOutRaw: 500_000n,
        outputMint,
        wallet,
      });
      await assert.rejects(
        () =>
          validateKalshiDflowTransaction({
            amountInRaw: "1000000",
            expectedInputMint: DEFAULT_SOLANA_USDC_MINT,
            inputMint: DEFAULT_SOLANA_USDC_MINT,
            minOutRaw: "500000",
            outputMint: outputMint.toBase58(),
            tokenAccountInfoLoader: async () => null,
            transactionSimulationLoader: async () => ({
              inputTokenSpendRaw: 1_000_000n,
              outputTokenReceiveRaw: 0n,
              solDebitLamports: 5_000n,
            }),
            transaction,
            walletAddress: wallet.toBase58(),
          }),
        /output amount is too low/,
      );
    },
  },
  {
    name: "rejects signer mismatch",
    run: async () => {
      const wallet = Keypair.generate().publicKey;
      const outputMint = Keypair.generate().publicKey;
      const transaction = buildTransaction({
        amountInRaw: 1_000_000n,
        minOutRaw: 500_000n,
        outputMint,
        wallet,
      });
      await assert.rejects(
        () =>
          validateKalshiDflowTransaction({
            amountInRaw: "1000000",
            expectedInputMint: DEFAULT_SOLANA_USDC_MINT,
            inputMint: DEFAULT_SOLANA_USDC_MINT,
            minOutRaw: "500000",
            outputMint: outputMint.toBase58(),
            tokenAccountInfoLoader: async () => null,
            transaction,
            walletAddress: Keypair.generate().publicKey.toBase58(),
          }),
        KalshiDflowTransactionValidationError,
      );
    },
  },
  {
    name: "rejects unexpected wallet-owned writable token account",
    run: async () => {
      const wallet = Keypair.generate().publicKey;
      const outputMint = Keypair.generate().publicKey;
      const unexpectedMint = Keypair.generate().publicKey;
      const unexpectedAta = getAssociatedTokenAddressSync(
        unexpectedMint,
        wallet,
      ).toBase58();
      const transaction = buildTransaction({
        amountInRaw: 1_000_000n,
        includeUnexpectedWalletTokenAccount: true,
        minOutRaw: 500_000n,
        outputMint,
        unexpectedMint,
        wallet,
      });
      await assert.rejects(
        () =>
          validateKalshiDflowTransaction({
            amountInRaw: "1000000",
            expectedInputMint: DEFAULT_SOLANA_USDC_MINT,
            inputMint: DEFAULT_SOLANA_USDC_MINT,
            minOutRaw: "500000",
            outputMint: outputMint.toBase58(),
            tokenAccountInfoLoader: async (account) =>
              account === unexpectedAta
                ? {
                    closeAuthority: null,
                    mint: unexpectedMint.toBase58(),
                    owner: wallet.toBase58(),
                    programId: TOKEN_PROGRAM_ID.toBase58(),
                  }
                : null,
            transaction,
            walletAddress: wallet.toBase58(),
          }),
        /unexpected wallet-owned token account/,
      );
    },
  },
  {
    name: "treats only confirmed missing output account as zero pre-balance",
    run: async () => {
      const account = Keypair.generate().publicKey.toBase58();
      const missingConnection = {
        getTokenAccountBalance: async () => {
          throw new Error("Invalid param: could not find account");
        },
      };
      assert.equal(
        await kalshiDflowTransactionSafetyTestHooks.fetchTokenBalanceRaw({
          account,
          connection: missingConnection as never,
          missingAccountAsZero: true,
        }),
        0n,
      );

      const transientConnection = {
        getTokenAccountBalance: async () => {
          throw new Error("socket timeout");
        },
      };
      await assert.rejects(
        () =>
          kalshiDflowTransactionSafetyTestHooks.fetchTokenBalanceRaw({
            account,
            connection: transientConnection as never,
            missingAccountAsZero: true,
          }),
        /socket timeout/,
      );
      await assert.rejects(
        () =>
          kalshiDflowTransactionSafetyTestHooks.fetchTokenBalanceRaw({
            account,
            connection: missingConnection as never,
            missingAccountAsZero: false,
          }),
        /could not find account/,
      );
    },
  },
  {
    name: "rejects excessive simulated SOL debit",
    run: async () => {
      const wallet = Keypair.generate().publicKey;
      const outputMint = Keypair.generate().publicKey;
      const transaction = buildTransaction({
        amountInRaw: 1_000_000n,
        minOutRaw: 500_000n,
        outputMint,
        wallet,
      });
      await assert.rejects(
        () =>
          validateKalshiDflowTransaction({
            amountInRaw: "1000000",
            expectedInputMint: DEFAULT_SOLANA_USDC_MINT,
            inputMint: DEFAULT_SOLANA_USDC_MINT,
            minOutRaw: "500000",
            outputMint: outputMint.toBase58(),
            tokenAccountInfoLoader: async () => null,
            transactionSimulationLoader: async () => ({
              inputTokenSpendRaw: 1_000_000n,
              outputTokenReceiveRaw: 500_000n,
              solDebitLamports: KALSHI_DFLOW_MAX_SOL_DEBIT_LAMPORTS + 1n,
            }),
            transaction,
            walletAddress: wallet.toBase58(),
          }),
        /SOL debit is too high/,
      );
    },
  },
  {
    name: "rejects missing simulation path",
    run: async () => {
      const wallet = Keypair.generate().publicKey;
      const outputMint = Keypair.generate().publicKey;
      const transaction = buildTransaction({
        amountInRaw: 1_000_000n,
        minOutRaw: 500_000n,
        outputMint,
        wallet,
      });
      await assert.rejects(
        () =>
          validateKalshiDflowTransaction({
            amountInRaw: "1000000",
            expectedInputMint: DEFAULT_SOLANA_USDC_MINT,
            inputMint: DEFAULT_SOLANA_USDC_MINT,
            minOutRaw: "500000",
            outputMint: outputMint.toBase58(),
            rpcUrls: [],
            tokenAccountInfoLoader: async () => null,
            transaction,
            walletAddress: wallet.toBase58(),
          }),
        /Solana RPC is required/,
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(
      `[kalshi-dflow-transaction-safety-tests] failed: ${test.name}`,
    );
    throw error;
  }
}

console.log(
  `[kalshi-dflow-transaction-safety-tests] passed ${passed}/${tests.length}`,
);
