#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
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
  buildEmbeddedSolanaSignTransactionRequest,
  getEmbeddedSolanaSponsorshipRequirementLamports,
  prepareEmbeddedSolanaTransactionRequests,
  shouldDisableEmbeddedSolanaSponsorshipForTransaction,
  type EmbeddedSolanaWalletContext,
} from "./services/embedded-solana.js";
import { env } from "./env.js";
import {
  assertEmbeddedSolanaSponsoredCachedRequestValid,
  analyzeEmbeddedSolanaTransaction,
  computeEmbeddedSolanaMessageDigest,
  computeEmbeddedSolanaTransactionDigest,
  createEmbeddedSolanaSponsorshipIntent,
  createEmbeddedSolanaSponsorshipRepairToken,
  getEmbeddedSolanaDirectTransferAmountRaw,
  reserveEmbeddedSolanaSponsorshipBudget,
  validateEmbeddedSolanaSponsorshipIntentCandidate,
  verifyEmbeddedSolanaSponsorshipRepairToken,
} from "./services/embedded-solana-sponsorship.js";
import { repairSubmittedSolanaSponsorshipLedger } from "./routes/embedded-wallets.js";

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
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const SOLANA_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const DFLOW_PROGRAM_ID = new PublicKey(
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
);
const TOKEN_SYNC_NATIVE_INSTRUCTION = 17;
const MIN_SOL_SOURCE_BALANCE_LAMPORTS = 20_000_000n;
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

function buildTransferCheckedData(amount: bigint, decimals = 6): Buffer {
  const data = new Uint8Array(10);
  data[0] = 12;
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amount, true);
  data[9] = decimals;
  return Buffer.from(data);
}

function createUsdcTransferCheckedInstruction(inputs?: {
  source?: PublicKey;
  destination?: PublicKey;
  mint?: PublicKey;
  authority?: PublicKey;
  amount?: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      {
        pubkey: inputs?.source ?? Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: inputs?.mint ?? SOLANA_USDC_MINT,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: inputs?.destination ?? Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: inputs?.authority ?? signerKeypair.publicKey,
        isSigner: true,
        isWritable: false,
      },
    ],
    data: buildTransferCheckedData(inputs?.amount ?? 1_000_000n),
  });
}

function createAssociatedTokenAccountInstruction(): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: signerKeypair.publicKey, isSigner: true, isWritable: true },
      {
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SOLANA_USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
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

async function prepareSponsoredEmbeddedSolanaTransactionRequests(
  inputs: PrepareEmbeddedSolanaRequestsInput,
) {
  const previous = env.embeddedSolanaSponsorshipObserveCanSponsor;
  env.embeddedSolanaSponsorshipObserveCanSponsor = true;
  try {
    return await prepareEmbeddedSolanaTransactionRequests({
      ...inputs,
      embeddedSolanaSponsorshipEnabled: true,
      embeddedSolanaSponsorshipMode: "observe",
    });
  } finally {
    env.embeddedSolanaSponsorshipObserveCanSponsor = previous;
  }
}

function directTransferSponsorshipPolicy() {
  return {
    embeddedSolanaSponsorship: true,
    embeddedSolanaSponsorshipMode: "enforce" as const,
    embeddedSolanaSponsorshipFlows: {
      dflow: false,
      across: false,
      directTransfer: true,
      debridge: false,
    },
    observeCanSponsor: false,
  };
}

async function prepareDirectTransferSponsoredRequest(inputs: {
  transaction: string;
  sponsorshipIntentId: string;
}) {
  const requests = await prepareEmbeddedSolanaTransactionRequests({
    context: walletContext,
    transactions: [
      {
        id: "direct-usdc-transfer",
        label: "USDC withdraw",
        transaction: inputs.transaction,
        sponsorshipIntentId: inputs.sponsorshipIntentId,
      },
    ],
    userId: "user-id",
    embeddedSolanaSponsorshipEnabled: true,
    embeddedSolanaSponsorshipMode: "enforce",
    embeddedSolanaSponsorshipFlows: {
      dflow: false,
      across: false,
      directTransfer: true,
      debridge: false,
    },
    fetchSponsorBalanceLamports: async () =>
      SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
  });
  const request = requests[0];
  assert.ok(request);
  assert.equal(getSponsor(request), true);
  return request;
}

const tests: TestCase[] = [
  {
    name: "privy signTransaction omits caip2 while signAndSendTransaction includes caip2",
    run: () => {
      const transaction = serializeTransaction([]);
      const signRequest = buildEmbeddedSolanaSignTransactionRequest({
        context: walletContext,
        transaction: {
          id: "dflow-sponsored-sign",
          label: "DFlow order",
          transaction,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        },
      });
      const signBody = signRequest.input.body as Record<string, unknown>;
      assert.equal(signBody.method, "signTransaction");
      assert.deepEqual(Object.keys(signBody).sort(), [
        "chain_type",
        "method",
        "params",
      ]);

      const signAndSendRequest = buildEmbeddedSolanaSignAndSendRequest({
        context: walletContext,
        transaction: {
          id: "generic-sign-send",
          label: "Generic Solana tx",
          transaction,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        },
      });
      const signAndSendBody = signAndSendRequest.input.body as Record<
        string,
        unknown
      >;
      assert.equal(signAndSendBody.method, "signAndSendTransaction");
      assert.equal(
        signAndSendBody.caip2,
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      );
      assert.equal(typeof signAndSendBody.sponsor, "boolean");
    },
  },
  {
    name: "embedded solana message digest stays stable after user signature",
    run: () => {
      const message = new TransactionMessage({
        payerKey: signerKeypair.publicKey,
        recentBlockhash: RECENT_BLOCKHASH,
        instructions: [
          new TransactionInstruction({
            programId: DFLOW_PROGRAM_ID,
            keys: [],
            data: Buffer.alloc(0),
          }),
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      const unsigned = Buffer.from(tx.serialize()).toString("base64");
      const unsignedMessageDigest =
        computeEmbeddedSolanaMessageDigest(unsigned);
      const unsignedTransactionDigest =
        computeEmbeddedSolanaTransactionDigest(unsigned);

      tx.sign([signerKeypair]);
      const signed = Buffer.from(tx.serialize()).toString("base64");

      assert.ok(unsignedMessageDigest);
      assert.equal(
        computeEmbeddedSolanaMessageDigest(signed),
        unsignedMessageDigest,
      );
      assert.notEqual(
        computeEmbeddedSolanaTransactionDigest(signed),
        unsignedTransactionDigest,
      );
    },
  },
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
              SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
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
          SPONSOR_BASE_REQUIREMENT_LAMPORTS,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "prepare embedded solana requests rejects native SOL source below hard minimum",
    run: async () => {
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
        }),
      ]);

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
              MIN_SOL_SOURCE_BALANCE_LAMPORTS - 1n,
          }),
        /SOL balance is reserved for network fees/,
      );
    },
  },
  {
    name: "prepare embedded solana requests allows native SOL source at hard minimum without sponsorship",
    run: async () => {
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
        }),
      ]);

      const requests = await prepareSponsoredEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "sol-swap",
            label: "SOL swap",
            transaction,
          },
        ],
        fetchSponsorBalanceLamports: async () =>
          MIN_SOL_SOURCE_BALANCE_LAMPORTS,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "prepare embedded solana requests rejects wrapped SOL source below hard minimum",
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
              MIN_SOL_SOURCE_BALANCE_LAMPORTS - 1n,
          }),
        /SOL balance is reserved for network fees/,
      );
    },
  },
  {
    name: "prepare embedded solana requests does not sponsor account creation without an allowed intent",
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
      assert.equal(getSponsor(request), false);
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
    name: "embedded solana does not sponsor low-sol transactions without an allowed intent",
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
      assert.equal(getSponsor(request), false);
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
      assert.equal(getSponsor(lowBalanceRequest), false);

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
    name: "prepare embedded solana requests does not sponsor on balance fetch failure without allowed intent",
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
      assert.equal(getSponsor(request), false);
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
  {
    name: "solana sponsorship analyzer detects native SOL transfer",
    run: () => {
      const transaction = serializeTransaction([
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1_000_000,
        }),
      ]);

      const analysis = analyzeEmbeddedSolanaTransaction({
        signer: walletContext.signer,
        transaction,
      });

      assert.equal(analysis.ok, true);
      assert.equal(analysis.hasNativeSolTransfer, true);
      assert.equal(analysis.usesAddressLookupTables, false);
      assert.equal(analysis.signerAddresses[0], walletContext.signer);
    },
  },
  {
    name: "enforce mode rejects sponsorship without an intent when signer cannot pay",
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
              },
            ],
            embeddedSolanaSponsorshipEnabled: true,
            embeddedSolanaSponsorshipMode: "enforce",
            embeddedSolanaSponsorshipFlows: {
              dflow: true,
              across: true,
              directTransfer: false,
              debridge: false,
            },
            fetchSponsorBalanceLamports: async () =>
              SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
  {
    name: "enforce mode downgrades to user-funded without an intent when signer can pay",
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
          },
        ],
        embeddedSolanaSponsorshipEnabled: true,
        embeddedSolanaSponsorshipMode: "enforce",
        embeddedSolanaSponsorshipFlows: {
          dflow: true,
          across: true,
          directTransfer: false,
          debridge: false,
        },
        fetchSponsorBalanceLamports: async () =>
          SPONSOR_BASE_REQUIREMENT_LAMPORTS,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), false);
    },
  },
  {
    name: "observe mode does not sponsor DFlow transaction without a matched intent",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: DFLOW_PROGRAM_ID,
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
                id: "dflow-trade",
                label: "DFlow trade",
                transaction,
              },
            ],
            userId: "user-id",
            embeddedSolanaSponsorshipEnabled: true,
            embeddedSolanaSponsorshipMode: "observe",
            embeddedSolanaSponsorshipFlows: {
              dflow: true,
              across: true,
              directTransfer: false,
              debridge: false,
            },
            fetchSponsorBalanceLamports: async () =>
              SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
          }),
        /This Kalshi market needs one-time Solana account setup/,
      );
    },
  },
  {
    name: "observe mode does not sponsor DFlow transaction for uninitialized market intent",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: DFLOW_PROGRAM_ID,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "dflow",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: { marketInitialized: false },
      });
      assert.ok(intent);

      const previous = env.embeddedSolanaSponsorshipObserveCanSponsor;
      env.embeddedSolanaSponsorshipObserveCanSponsor = false;
      try {
        await assert.rejects(
          async () =>
            prepareEmbeddedSolanaTransactionRequests({
              context: walletContext,
              transactions: [
                {
                  id: "dflow-trade",
                  label: "DFlow trade",
                  transaction,
                  sponsorshipIntentId: intent.id,
                },
              ],
              userId: "user-id",
              embeddedSolanaSponsorshipEnabled: true,
              embeddedSolanaSponsorshipMode: "observe",
              embeddedSolanaSponsorshipFlows: {
                dflow: true,
                across: true,
                directTransfer: false,
                debridge: false,
              },
              fetchSponsorBalanceLamports: async () =>
                SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
            }),
          /This Kalshi market needs one-time Solana account setup/,
        );
      } finally {
        env.embeddedSolanaSponsorshipObserveCanSponsor = previous;
      }
    },
  },
  {
    name: "observe mode is log-only by default for initialized market intent",
    run: async () => {
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: DFLOW_PROGRAM_ID,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "dflow",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: { marketInitialized: true },
      });
      assert.ok(intent);

      const previous = env.embeddedSolanaSponsorshipObserveCanSponsor;
      env.embeddedSolanaSponsorshipObserveCanSponsor = false;
      try {
        const requests = await prepareEmbeddedSolanaTransactionRequests({
          context: walletContext,
          transactions: [
            {
              id: "dflow-trade",
              label: "DFlow trade",
              transaction,
              sponsorshipIntentId: intent.id,
            },
          ],
          userId: "user-id",
          embeddedSolanaSponsorshipEnabled: true,
          embeddedSolanaSponsorshipMode: "observe",
          embeddedSolanaSponsorshipFlows: {
            dflow: true,
            across: true,
            directTransfer: false,
            debridge: false,
          },
          fetchSponsorBalanceLamports: async () =>
            SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
        });
        const request = requests[0];
        assert.ok(request);
        assert.equal(getSponsor(request), false);
      } finally {
        env.embeddedSolanaSponsorshipObserveCanSponsor = previous;
      }
    },
  },
  {
    name: "enforce mode requires intent for direct USDC transfer sponsorship",
    run: async () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction(),
      ]);

      await assert.rejects(
        async () =>
          prepareEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "direct-usdc-transfer",
                label: "USDC withdraw",
                transaction,
              },
            ],
            userId: "user-id",
            embeddedSolanaSponsorshipEnabled: true,
            embeddedSolanaSponsorshipMode: "enforce",
            embeddedSolanaSponsorshipFlows: {
              dflow: false,
              across: false,
              directTransfer: true,
              debridge: false,
            },
            fetchSponsorBalanceLamports: async () =>
              SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
  {
    name: "enforce mode sponsors direct USDC transfer with matched intent",
    run: async () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 1_000_000n }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "1000000",
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      const requests = await prepareEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "direct-usdc-transfer",
            label: "USDC withdraw",
            transaction,
            sponsorshipIntentId: intent.id,
          },
        ],
        userId: "user-id",
        embeddedSolanaSponsorshipEnabled: true,
        embeddedSolanaSponsorshipMode: "enforce",
        embeddedSolanaSponsorshipFlows: {
          dflow: false,
          across: false,
          directTransfer: true,
          debridge: false,
        },
        fetchSponsorBalanceLamports: async () =>
          SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), true);
    },
  },
  {
    name: "cached sponsored execute revalidation rejects missing intent",
    run: async () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 1_000_000n }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "1000000",
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      const request = await prepareDirectTransferSponsoredRequest({
        transaction,
        sponsorshipIntentId: intent.id,
      });
      assert.ok(request.solanaSponsorship);
      request.solanaSponsorship.sponsorshipIntentId = "solsp_missing";

      await assert.rejects(
        () =>
          assertEmbeddedSolanaSponsoredCachedRequestValid({
            request,
            userId: "user-id",
            signer: walletContext.signer,
            policy: directTransferSponsorshipPolicy(),
          }),
        /expired|missing/,
      );
    },
  },
  {
    name: "cached sponsored execute revalidation rejects digest changes",
    run: async () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 1_000_000n }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "1000000",
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      const request = await prepareDirectTransferSponsoredRequest({
        transaction,
        sponsorshipIntentId: intent.id,
      });
      const body = request.input.body as {
        params?: { transaction?: string };
      };
      assert.ok(body.params);
      body.params.transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 2_000_000n }),
      ]);

      await assert.rejects(
        () =>
          assertEmbeddedSolanaSponsoredCachedRequestValid({
            request,
            userId: "user-id",
            signer: walletContext.signer,
            policy: directTransferSponsorshipPolicy(),
          }),
        /transaction changed/,
      );
    },
  },
  {
    name: "cached sponsored execute revalidation checks current policy",
    run: async () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 1_000_000n }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "1000000",
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      const request = await prepareDirectTransferSponsoredRequest({
        transaction,
        sponsorshipIntentId: intent.id,
      });

      await assert.rejects(
        () =>
          assertEmbeddedSolanaSponsoredCachedRequestValid({
            request,
            userId: "user-id",
            signer: walletContext.signer,
            policy: {
              ...directTransferSponsorshipPolicy(),
              embeddedSolanaSponsorship: false,
            },
          }),
        /disabled/,
      );
    },
  },
  {
    name: "embedded solana sponsorship repair token binds submit metadata",
    run: () => {
      const token = createEmbeddedSolanaSponsorshipRepairToken({
        userId: "user-id",
        signer: walletContext.signer,
        requestId: "direct-usdc-transfer",
        transactionId: "privy-tx-1",
        sponsorshipIntentId: "solsp_1",
        signature: "sig-1",
        transactionDigest: "digest-1",
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      const verified = verifyEmbeddedSolanaSponsorshipRepairToken({
        repairToken: token,
        userId: "user-id",
        signer: walletContext.signer,
        requestId: "direct-usdc-transfer",
        transactionId: "privy-tx-1",
        sponsorshipIntentId: "solsp_1",
        signature: "sig-1",
        nowMs: 2_000,
      });
      assert.equal(verified?.transactionDigest, "digest-1");
      assert.equal(
        verifyEmbeddedSolanaSponsorshipRepairToken({
          repairToken: token,
          userId: "user-id",
          signer: walletContext.signer,
          requestId: "direct-usdc-transfer",
          transactionId: "privy-tx-2",
          sponsorshipIntentId: "solsp_1",
          signature: "sig-1",
          nowMs: 2_000,
        }),
        null,
      );
      assert.equal(
        verifyEmbeddedSolanaSponsorshipRepairToken({
          repairToken: token,
          userId: "user-id",
          signer: walletContext.signer,
          requestId: "direct-usdc-transfer",
          transactionId: "privy-tx-1",
          sponsorshipIntentId: "solsp_1",
          signature: "sig-1",
          nowMs: 7_000,
        }),
        null,
      );
    },
  },
  {
    name: "embedded solana ledger repair writes durable metadata only",
    run: async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      const db = {
        query: async <T>(sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          return { rows: [{ repaired: true } as T] };
        },
      };

      const repaired = await repairSubmittedSolanaSponsorshipLedger({
        userId: "user-id",
        signer: walletContext.signer,
        sponsorshipIntentId: "solsp_1",
        signature: "sig-1",
        transactionDigest: "digest-1",
        transactionId: "privy-tx-1",
        requestId: "direct-usdc-transfer",
        db,
      });

      assert.equal(repaired, true);
      const call = calls[0];
      assert.ok(call);
      assert.match(call.sql, /update solana_sponsorship_ledger/i);
      assert.doesNotMatch(call.sql, /status\s*=\s*'submitted'/i);
      assert.doesNotMatch(call.sql, /tx_signature\s*=/i);
      assert.match(call.sql, /status = 'intent_created'/);
      assert.match(
        call.sql,
        /flow in \('across', 'directTransfer', 'debridge'\)/,
      );
      assert.match(call.sql, /\{submission,signature\}/);
      assert.match(call.sql, /to_jsonb\(\$5::text\)/);
      assert.equal(call.params?.[3], "digest-1");
      assert.equal(call.params?.[4], "sig-1");
      const repairedSubmission = JSON.parse(String(call.params?.[5])) as {
        requestId?: string;
      };
      assert.equal(repairedSubmission.requestId, "direct-usdc-transfer");
    },
  },
  {
    name: "embedded solana ledger repair returns false when no row is eligible",
    run: async () => {
      const repaired = await repairSubmittedSolanaSponsorshipLedger({
        userId: "user-id",
        signer: walletContext.signer,
        sponsorshipIntentId: "solsp_1",
        signature: "sig-1",
        transactionDigest: "digest-1",
        requestId: "direct-usdc-transfer",
        db: {
          query: async <T>() => ({ rows: [] as T[] }),
        },
      });

      assert.equal(repaired, false);
    },
  },
  {
    name: "direct USDC transfer candidate exposes raw amount and validates shape",
    run: () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 750_000n }),
      ]);
      const validation = validateEmbeddedSolanaSponsorshipIntentCandidate({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "750000",
          maxSystemCreateLamports: "0",
        },
      });

      assert.equal(validation.ok, true);
      assert.equal(
        getEmbeddedSolanaDirectTransferAmountRaw({
          analysis: validation.analysis,
          signer: walletContext.signer,
        }),
        "750000",
      );
    },
  },
  {
    name: "embedded solana validation rejects hex transaction payloads",
    run: () => {
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({ amount: 750_000n }),
      ]);
      const hexTransaction = `0x${Buffer.from(transaction, "base64").toString(
        "hex",
      )}`;
      const validation = validateEmbeddedSolanaSponsorshipIntentCandidate({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction: hexTransaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "750000",
          maxSystemCreateLamports: "0",
        },
      });

      assert.equal(validation.ok, false);
      assert.equal(
        computeEmbeddedSolanaTransactionDigest(hexTransaction),
        null,
      );
    },
  },
  {
    name: "direct USDC transfer candidate binds recipient wallet to destination ATA",
    run: () => {
      const recipient = Keypair.generate().publicKey;
      const recipientTokenAccount = getAssociatedTokenAddressSync(
        SOLANA_USDC_MINT,
        recipient,
      );
      const transaction = serializeTransaction([
        createUsdcTransferCheckedInstruction({
          amount: 750_000n,
          destination: recipientTokenAccount,
        }),
      ]);
      const matching = validateEmbeddedSolanaSponsorshipIntentCandidate({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "750000",
          recipientAddress: recipient.toBase58(),
          maxSystemCreateLamports: "0",
        },
      });
      const mismatched = validateEmbeddedSolanaSponsorshipIntentCandidate({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "750000",
          recipientAddress: Keypair.generate().publicKey.toBase58(),
          maxSystemCreateLamports: "0",
        },
      });

      assert.equal(matching.ok, true);
      assert.equal(mismatched.ok, false);
      assert.ok(
        mismatched.reasons.includes("direct_transfer_recipient_mismatch"),
      );
    },
  },
  {
    name: "direct transfer sponsorship budget blocks excessive attempts",
    run: async () => {
      const walletAddress = Keypair.generate().publicKey.toBase58();
      const first = await reserveEmbeddedSolanaSponsorshipBudget({
        flow: "directTransfer",
        walletAddress,
        estimatedLamports: "5000",
        limits: {
          dflow: {
            maxPerHour: 5,
            maxPerDay: 5,
            maxLamportsPerWalletPerDay: 50_000,
          },
          across: {
            maxPerHour: 5,
            maxPerDay: 5,
            maxLamportsPerWalletPerDay: 50_000,
          },
          directTransfer: {
            maxPerHour: 1,
            maxPerDay: 1,
            maxLamportsPerWalletPerDay: 5_000,
            minAmountRaw: "500000",
          },
          debridge: {
            maxPerHour: 5,
            maxPerDay: 5,
            maxLamportsPerWalletPerDay: 50_000,
          },
        },
      });
      assert.equal(first.ok, true);

      const second = await reserveEmbeddedSolanaSponsorshipBudget({
        flow: "directTransfer",
        walletAddress,
        estimatedLamports: "5000",
        limits: {
          dflow: {
            maxPerHour: 5,
            maxPerDay: 5,
            maxLamportsPerWalletPerDay: 50_000,
          },
          across: {
            maxPerHour: 5,
            maxPerDay: 5,
            maxLamportsPerWalletPerDay: 50_000,
          },
          directTransfer: {
            maxPerHour: 1,
            maxPerDay: 1,
            maxLamportsPerWalletPerDay: 5_000,
            minAmountRaw: "500000",
          },
          debridge: {
            maxPerHour: 5,
            maxPerDay: 5,
            maxLamportsPerWalletPerDay: 50_000,
          },
        },
      });
      assert.equal(second.ok, false);
      assert.ok(second.reasons.includes("sponsorship_hour_budget_exceeded"));
    },
  },
  {
    name: "direct transfer sponsorship memory budget allows only one concurrent reservation",
    run: async () => {
      const walletAddress = Keypair.generate().publicKey.toBase58();
      const limits = {
        dflow: {
          maxPerHour: 5,
          maxPerDay: 5,
          maxLamportsPerWalletPerDay: 50_000,
        },
        across: {
          maxPerHour: 5,
          maxPerDay: 5,
          maxLamportsPerWalletPerDay: 50_000,
        },
        directTransfer: {
          maxPerHour: 1,
          maxPerDay: 1,
          maxLamportsPerWalletPerDay: 5_000,
          minAmountRaw: "500000",
        },
        debridge: {
          maxPerHour: 5,
          maxPerDay: 5,
          maxLamportsPerWalletPerDay: 50_000,
        },
      };
      const results = await Promise.all([
        reserveEmbeddedSolanaSponsorshipBudget({
          flow: "directTransfer",
          walletAddress,
          estimatedLamports: "5000",
          limits,
        }),
        reserveEmbeddedSolanaSponsorshipBudget({
          flow: "directTransfer",
          walletAddress,
          estimatedLamports: "5000",
          limits,
        }),
      ]);
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(results.filter((result) => !result.ok).length, 1);
    },
  },
  {
    name: "enforce mode rejects direct USDC transfer with account setup rent",
    run: async () => {
      const transaction = serializeTransaction([
        createAssociatedTokenAccountInstruction(),
        createUsdcTransferCheckedInstruction(),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "directTransfer",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          directTransferSponsorshipEligible: true,
          amountRaw: "1000000",
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      await assert.rejects(
        async () =>
          prepareEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "direct-usdc-transfer-with-ata",
                label: "USDC withdraw",
                transaction,
                sponsorshipIntentId: intent.id,
              },
            ],
            userId: "user-id",
            embeddedSolanaSponsorshipEnabled: true,
            embeddedSolanaSponsorshipMode: "enforce",
            embeddedSolanaSponsorshipFlows: {
              dflow: false,
              across: false,
              directTransfer: true,
              debridge: false,
            },
            fetchSponsorBalanceLamports: async () =>
              SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
  {
    name: "enforce mode sponsors deBridge gas-only transaction with provider program allowlist",
    run: async () => {
      const debridgeProgramId = Keypair.generate().publicKey;
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: debridgeProgramId,
          keys: [],
          data: Buffer.from([1]),
        }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "debridge",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          debridgeSponsorshipEligible: true,
          allowedProgramIds: [debridgeProgramId.toBase58()],
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      const requests = await prepareEmbeddedSolanaTransactionRequests({
        context: walletContext,
        transactions: [
          {
            id: "debridge-bridge",
            label: "deBridge bridge",
            transaction,
            sponsorshipIntentId: intent.id,
          },
        ],
        userId: "user-id",
        embeddedSolanaSponsorshipEnabled: true,
        embeddedSolanaSponsorshipMode: "enforce",
        embeddedSolanaSponsorshipFlows: {
          dflow: false,
          across: false,
          directTransfer: false,
          debridge: true,
        },
        fetchSponsorBalanceLamports: async () =>
          SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
      });

      const request = requests[0];
      assert.ok(request);
      assert.equal(getSponsor(request), true);
    },
  },
  {
    name: "enforce mode rejects deBridge sponsorship without provider program allowlist",
    run: async () => {
      const debridgeProgramId = Keypair.generate().publicKey;
      const transaction = serializeTransaction([
        new TransactionInstruction({
          programId: debridgeProgramId,
          keys: [],
          data: Buffer.from([1]),
        }),
      ]);
      const intent = await createEmbeddedSolanaSponsorshipIntent({
        flow: "debridge",
        userId: "user-id",
        signer: walletContext.signer,
        transaction,
        metadata: {
          debridgeSponsorshipEligible: true,
          maxSystemCreateLamports: "0",
        },
      });
      assert.ok(intent);

      await assert.rejects(
        async () =>
          prepareEmbeddedSolanaTransactionRequests({
            context: walletContext,
            transactions: [
              {
                id: "debridge-bridge",
                label: "deBridge bridge",
                transaction,
                sponsorshipIntentId: intent.id,
              },
            ],
            userId: "user-id",
            embeddedSolanaSponsorshipEnabled: true,
            embeddedSolanaSponsorshipMode: "enforce",
            embeddedSolanaSponsorshipFlows: {
              dflow: false,
              across: false,
              directTransfer: false,
              debridge: true,
            },
            fetchSponsorBalanceLamports: async () =>
              SPONSOR_BASE_REQUIREMENT_LAMPORTS - 1n,
          }),
        /Add SOL to this Solana wallet for network fees and account setup/,
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[embedded-solana-tests] passed ${passed}/${tests.length}`);
