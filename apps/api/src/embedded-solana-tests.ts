#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
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
import { env } from "./env.js";
import { solanaPrefundRouteTestExports } from "./routes/embedded-wallets.js";
import { isResolvedKalshiLossProof } from "./services/kalshi-loss-close.js";

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
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
const TOKEN_SYNC_NATIVE_INSTRUCTION = 17;
const TOKEN_TRANSFER_INSTRUCTION = 3;
const TOKEN_CLOSE_ACCOUNT_INSTRUCTION = 9;
const SOLANA_WRAPPED_SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
const JUPITER_V6_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
const JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR = Buffer.from(
  "e517cb977ae3ad2a",
  "hex",
);
const JUPITER_EXACT_OUT_ROUTE_DISCRIMINATOR = Buffer.from(
  "c1209b3341d69c81",
  "hex",
);
const MAX_PREFUND_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 100_000n;
const USER_TX_FEE_BUFFER_LAMPORTS = 3_000_000n;
const SPONSOR_BASE_REQUIREMENT_LAMPORTS = 8_000_000n;

function serializeTransaction(
  instructions: TransactionInstruction[],
  payerKey = signerKeypair.publicKey,
  addressLookupTableAccounts: AddressLookupTableAccount[] = [],
): string {
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: RECENT_BLOCKHASH,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    "base64",
  );
}

function createAddressLookupTableAccount(
  addresses: PublicKey[],
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

function getSponsor(
  request: ReturnType<typeof buildEmbeddedSolanaSignAndSendRequest>,
) {
  return (request.input.body as { sponsor?: boolean }).sponsor;
}

function getUserUsdcAta(owner = signerKeypair.publicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    new PublicKey(env.solanaUsdcMint),
    owner,
    false,
    SPL_TOKEN_PROGRAM_ID,
  );
}

function getUserWsolAta(owner = signerKeypair.publicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    SOLANA_WRAPPED_SOL_MINT,
    owner,
    false,
    SPL_TOKEN_PROGRAM_ID,
  );
}

function encodeTokenTransferAmount(amount: bigint): Buffer {
  const data = Buffer.alloc(9);
  data[0] = TOKEN_TRANSFER_INSTRUCTION;
  data.writeBigUInt64LE(amount, 1);
  return data;
}

function encodeU64Le(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value, 0);
  return data;
}

function buildComputeUnitPriceInstruction(
  microLamports: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(microLamports, 1);
  return new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data,
  });
}

function encodeJupiterSharedAccountsRouteData(inputs: {
  amount: bigint;
  quotedOut?: bigint;
  discriminator?: Buffer;
  slippageBps?: number;
  platformFeeBps?: number;
  prefix?: Buffer;
  slippageEncoding?: "u16-platform-fee" | "u32";
}): Buffer {
  const slippageEncoding = inputs.slippageEncoding ?? "u16-platform-fee";
  const slippage =
    slippageEncoding === "u32" ? Buffer.alloc(4) : Buffer.alloc(2);
  if (slippageEncoding === "u32") {
    slippage.writeUInt32LE(inputs.slippageBps ?? 50, 0);
  } else {
    slippage.writeUInt16LE(inputs.slippageBps ?? 50, 0);
  }
  const platformFee =
    slippageEncoding === "u16-platform-fee"
      ? Buffer.from([inputs.platformFeeBps ?? 0])
      : Buffer.alloc(0);
  return Buffer.concat([
    inputs.discriminator ?? JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR,
    inputs.prefix ??
      Buffer.from([
        1, 0, 0, 0, 0x1a, 0x64, 0, 1, 0, 0, 0, 0, 0x2a, 0, 0, 0,
      ]),
    encodeU64Le(inputs.amount),
    encodeU64Le(inputs.quotedOut ?? 9_134_000n),
    slippage,
    platformFee,
  ]);
}

function buildUsdcDebitTransaction(inputs: {
  amount?: bigint;
  source?: PublicKey;
  signer?: PublicKey;
  programId?: PublicKey;
} = {}): string {
  const signer = inputs.signer ?? signerKeypair.publicKey;
  return serializeTransaction(
    [
      new TransactionInstruction({
        programId: inputs.programId ?? SPL_TOKEN_PROGRAM_ID,
        keys: [
          {
            pubkey: inputs.source ?? getUserUsdcAta(signer),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: Keypair.generate().publicKey,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: signer,
            isSigner: true,
            isWritable: false,
          },
        ],
        data: encodeTokenTransferAmount(inputs.amount ?? 1_000_000n),
      }),
    ],
    signer,
  );
}

function buildJupiterPrefundTransaction(inputs: {
  amount?: bigint;
  source?: PublicKey;
  signer?: PublicKey;
  wsolAta?: PublicKey;
  discriminator?: Buffer;
  quotedOut?: bigint;
  data?: Buffer;
  ataAccount?: PublicKey;
  includeAtaCreate?: boolean;
  extraCloseAccount?: PublicKey;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
  computeBudgetInstructions?: TransactionInstruction[];
} = {}): string {
  const signer = inputs.signer ?? signerKeypair.publicKey;
  const amount = inputs.amount ?? 1_000_000n;
  const source = inputs.source ?? getUserUsdcAta(signer);
  const wsolAta = inputs.wsolAta ?? getUserWsolAta(signer);
  const discriminator =
    inputs.discriminator ?? JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR;
  const instructions: TransactionInstruction[] = [];
  instructions.push(...(inputs.computeBudgetInstructions ?? []));
  if (inputs.includeAtaCreate !== false) {
    instructions.push(
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: signer, isSigner: true, isWritable: true },
          {
            pubkey: inputs.ataAccount ?? wsolAta,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: signer, isSigner: false, isWritable: false },
          { pubkey: SOLANA_WRAPPED_SOL_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    );
  }

  const isExactOut = discriminator.equals(JUPITER_EXACT_OUT_ROUTE_DISCRIMINATOR);
  instructions.push(
    new TransactionInstruction({
      programId: JUPITER_V6_PROGRAM_ID,
      keys: isExactOut
        ? [
            { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
            { pubkey: signer, isSigner: true, isWritable: false },
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
            { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
            { pubkey: wsolAta, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(env.solanaUsdcMint), isSigner: false, isWritable: false },
            { pubkey: SOLANA_WRAPPED_SOL_MINT, isSigner: false, isWritable: false },
            { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
          ]
        : [
            { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: signer, isSigner: true, isWritable: false },
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: wsolAta, isSigner: false, isWritable: true },
            { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SOLANA_WRAPPED_SOL_MINT, isSigner: false, isWritable: false },
            { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
      data:
        inputs.data ??
        encodeJupiterSharedAccountsRouteData({
          amount,
          quotedOut: inputs.quotedOut,
          discriminator,
        }),
    }),
  );
  if (inputs.extraCloseAccount) {
    instructions.push(
      new TransactionInstruction({
        programId: SPL_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: inputs.extraCloseAccount, isSigner: false, isWritable: true },
          { pubkey: signer, isSigner: false, isWritable: true },
          { pubkey: signer, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([TOKEN_CLOSE_ACCOUNT_INSTRUCTION]),
      }),
    );
  }
  instructions.push(
    new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true },
        { pubkey: signer, isSigner: false, isWritable: true },
        { pubkey: signer, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([TOKEN_CLOSE_ACCOUNT_INSTRUCTION]),
    }),
  );

  return serializeTransaction(
    instructions,
    signer,
    inputs.addressLookupTableAccounts,
  );
}

function buildPrefundPayload(inputs: {
  feePayer?: PublicKey;
  tokenInAddress?: string;
  tokenInAmount?: string;
  tokenOutAddress?: string;
  tokenOutAmount?: string;
  txData?: string;
}) {
  const payer = inputs.feePayer ?? signerKeypair.publicKey;
  const txData =
    inputs.txData ??
    serializeTransaction(
      [
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.alloc(0),
        }),
      ],
      payer,
    );
  return {
    tokenIn: {
      address: inputs.tokenInAddress ?? env.solanaUsdcMint,
      amount: inputs.tokenInAmount ?? "1000000",
    },
    tokenOut: {
      address: inputs.tokenOutAddress ?? "11111111111111111111111111111111",
      minAmount: inputs.tokenOutAmount ?? "5000000",
    },
    tx: { data: txData },
  };
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
  {
    name: "solana prefund bounds reject ready wallets and use configured top-up cap",
    run: () => {
      const bounds =
        solanaPrefundRouteTestExports.resolveSolanaPrefundTopUpBounds({
          currentSolLamports: 1_000_000n,
          minSolLamports: 5_000_000n,
          targetSolLamports: 10_000_000n,
          maxTopUpLamports: 30_000_000n,
        });
      assert.deepEqual(bounds, {
        minOutLamports: 4_000_000n,
        maxOutLamports: 30_000_000n,
      });

      assert.equal(
        solanaPrefundRouteTestExports.resolveSolanaPrefundTopUpBounds({
          currentSolLamports: 5_000_000n,
          minSolLamports: 5_000_000n,
          targetSolLamports: 10_000_000n,
          maxTopUpLamports: 30_000_000n,
        }),
        null,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.resolveSolanaPrefundTopUpBounds({
            currentSolLamports: 0n,
            minSolLamports: 5_000_000n,
            targetSolLamports: 10_000_000n,
            maxTopUpLamports: 3_000_000n,
          }),
        /maximum is below/,
      );
    },
  },
  {
    name: "solana prefund validator rejects arbitrary transaction payloads",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({ tokenOutAmount: "9134000" }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /unsupported program/,
      );
    },
  },
  {
    name: "solana prefund validator accepts sanitized Jupiter USDC to SOL prefund shape",
    run: () => {
      const validated =
        solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
          payload: buildPrefundPayload({
            tokenOutAmount: "9134000",
            txData: buildJupiterPrefundTransaction(),
          }),
          signer: walletContext.signer,
          amountInRaw: 1_000_000n,
          minOutLamports: 4_000_000n,
          maxOutLamports: 30_000_000n,
        });

      assert.equal(validated.estimatedOutLamports, 9_134_000n);
      assert.equal(validated.decodedMinOutLamports, 9_088_330n);
      assert.deepEqual(validated.requiredSigners, [walletContext.signer]);
      assert.equal(validated.feePayer, walletContext.signer);
    },
  },
  {
    name: "solana prefund validator caps sponsored ComputeBudget fees",
    run: () => {
      const validated =
        solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
          payload: buildPrefundPayload({
            tokenOutAmount: "9134000",
            txData: buildJupiterPrefundTransaction({
              computeBudgetInstructions: [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
                buildComputeUnitPriceInstruction(
                  MAX_PREFUND_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
                ),
              ],
            }),
          }),
          signer: walletContext.signer,
          amountInRaw: 1_000_000n,
          minOutLamports: 4_000_000n,
          maxOutLamports: 30_000_000n,
        });

      assert.equal(validated.estimatedOutLamports, 9_134_000n);

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                computeBudgetInstructions: [
                  buildComputeUnitPriceInstruction(
                    MAX_PREFUND_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS + 1n,
                  ),
                ],
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /compute unit price exceeds/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                computeBudgetInstructions: [
                  new TransactionInstruction({
                    programId: ComputeBudgetProgram.programId,
                    keys: [],
                    data: Buffer.from([0]),
                  }),
                ],
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /ComputeBudget instruction is not allowed/,
      );
    },
  },
  {
    name: "solana prefund validator resolves address lookup tables before checking route shape",
    run: () => {
      const lookupTable = createAddressLookupTableAccount([
        SPL_TOKEN_PROGRAM_ID,
        JUPITER_V6_PROGRAM_ID,
        SOLANA_WRAPPED_SOL_MINT,
        SystemProgram.programId,
        getUserUsdcAta(),
        getUserWsolAta(),
      ]);
      const txData = buildJupiterPrefundTransaction({
        addressLookupTableAccounts: [lookupTable],
      });
      const tx = VersionedTransaction.deserialize(Buffer.from(txData, "base64"));
      assert.ok(tx.message.addressTableLookups.length > 0);

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData,
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /address lookup table was not resolved/,
      );

      const validated =
        solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
          payload: buildPrefundPayload({
            tokenOutAmount: "9134000",
            txData,
          }),
          signer: walletContext.signer,
          amountInRaw: 1_000_000n,
          minOutLamports: 4_000_000n,
          maxOutLamports: 30_000_000n,
          addressLookupTableAccounts: [lookupTable],
        });

      assert.equal(validated.estimatedOutLamports, 9_134_000n);
      assert.deepEqual(validated.requiredSigners, [walletContext.signer]);
    },
  },
  {
    name: "solana prefund validator requires decoded Jupiter transaction shape",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                discriminator: JUPITER_EXACT_OUT_ROUTE_DISCRIMINATOR,
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /not an allowed route/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildUsdcDebitTransaction(),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /token instruction is not allowed|allowed Jupiter prefund/,
      );
    },
  },
  {
    name: "solana prefund validator rejects unsafe Solana transaction shapes",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: serializeTransaction([
                SystemProgram.transfer({
                  fromPubkey: signerKeypair.publicKey,
                  toPubkey: Keypair.generate().publicKey,
                  lamports: 1_000_000,
                }),
              ]),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /spends signer SOL/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: serializeTransaction([
                SystemProgram.createAccount({
                  fromPubkey: signerKeypair.publicKey,
                  newAccountPubkey: Keypair.generate().publicKey,
                  lamports: 1_000_000,
                  space: 0,
                  programId: SystemProgram.programId,
                }),
              ]),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /signer does not match|rent-funded accounts/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                ataAccount: Keypair.generate().publicKey,
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /associated token instruction/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                extraCloseAccount: getUserUsdcAta(),
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /multiple token close|token close does not target/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: serializeTransaction([
                new TransactionInstruction({
                  programId: SPL_TOKEN_PROGRAM_ID,
                  keys: [
                    {
                      pubkey: Keypair.generate().publicKey,
                      isSigner: false,
                      isWritable: true,
                    },
                  ],
                  data: Buffer.from([TOKEN_SYNC_NATIVE_INSTRUCTION]),
                }),
              ]),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /token instruction is not allowed/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildUsdcDebitTransaction({
                programId: TOKEN_2022_PROGRAM_ID,
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /Token-2022/,
      );
    },
  },
  {
    name: "solana prefund validator rejects wrong USDC account and amount",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                source: Keypair.generate().publicKey,
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /selected wallet USDC account/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({ amount: 999_999n }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /amount does not match/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: buildJupiterPrefundTransaction({
                data: encodeJupiterSharedAccountsRouteData({
                  amount: 999_999n,
                  prefix: encodeU64Le(1_000_000n),
                }),
              }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /amount does not match/,
      );

      const validated =
        solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
          payload: buildPrefundPayload({
            tokenOutAmount: "9134000",
            txData: buildJupiterPrefundTransaction({ quotedOut: 9_000_000n }),
          }),
          signer: walletContext.signer,
          amountInRaw: 1_000_000n,
          minOutLamports: 4_000_000n,
          maxOutLamports: 30_000_000n,
        });
      assert.equal(validated.estimatedOutLamports, 9_000_000n);
    },
  },
  {
    name: "solana prefund validator rejects malformed transaction payloads",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: "not-base64",
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /valid serialized Solana transaction/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: "0x123",
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /valid serialized Solana transaction/,
      );
    },
  },
  {
    name: "solana prefund validator rejects extra required signers",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "9134000",
              txData: serializeTransaction([
                new TransactionInstruction({
                  programId: SPL_TOKEN_PROGRAM_ID,
                  keys: [
                    {
                      pubkey: getUserUsdcAta(),
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: Keypair.generate().publicKey,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: signerKeypair.publicKey,
                      isSigner: true,
                      isWritable: false,
                    },
                    {
                      pubkey: Keypair.generate().publicKey,
                      isSigner: true,
                      isWritable: false,
                    },
                  ],
                  data: encodeTokenTransferAmount(1_000_000n),
                }),
              ]),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /signer does not match/,
      );
    },
  },
  {
    name: "solana prefund validator rejects dust and over-cap outputs",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "1000",
              txData: buildJupiterPrefundTransaction({ quotedOut: 1000n }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 9_000_000n,
          }),
        /below the required minimum/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              tokenOutAmount: "31000000",
              txData: buildJupiterPrefundTransaction({ quotedOut: 31_000_000n }),
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 30_000_000n,
          }),
        /exceeds the configured top-up cap/,
      );
    },
  },
  {
    name: "solana prefund validator rejects wrong signer and token route",
    run: () => {
      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({
              feePayer: Keypair.generate().publicKey,
            }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 9_000_000n,
          }),
        /signer does not match/,
      );

      assert.throws(
        () =>
          solanaPrefundRouteTestExports.validateDebridgeSolanaPrefundPayload({
            payload: buildPrefundPayload({ tokenOutAddress: env.solanaUsdcMint }),
            signer: walletContext.signer,
            amountInRaw: 1_000_000n,
            minOutLamports: 4_000_000n,
            maxOutLamports: 9_000_000n,
          }),
        /output token/,
      );
    },
  },
  {
    name: "solana prefund memory limiter enforces daily cap without a retry cooldown",
    run: () => {
      const originalNow = Date.now;
      const now = 1_000_000_000;
      Date.now = () => now;
      try {
        solanaPrefundRouteTestExports.resetMemoryPrefundRateLimits();
        assert.deepEqual(
          solanaPrefundRouteTestExports.getMemoryPrefundRateLimitState(
            walletContext.signer,
          ),
          { limited: false, retryAfterSec: null },
        );

        solanaPrefundRouteTestExports.recordMemoryPrefundAttempt(
          walletContext.signer,
        );
        assert.equal(
          solanaPrefundRouteTestExports.getMemoryPrefundRateLimitState(
            walletContext.signer,
          ).limited,
          false,
        );

        for (let attempt = 2; attempt <= 20; attempt += 1) {
          solanaPrefundRouteTestExports.recordMemoryPrefundAttempt(
            walletContext.signer,
          );
        }
        assert.equal(
          solanaPrefundRouteTestExports.getMemoryPrefundRateLimitState(
            walletContext.signer,
          ).limited,
          true,
        );
      } finally {
        Date.now = originalNow;
        solanaPrefundRouteTestExports.resetMemoryPrefundRateLimits();
      }
    },
  },
  {
    name: "kalshi loss close proof fails closed on unresolved, winning, missing, and conflicting mappings",
    run: () => {
      assert.equal(
        isResolvedKalshiLossProof([
          { side: "YES", resolved_outcome: "NO", resolved_outcome_pct: null },
        ]),
        true,
      );
      assert.equal(
        isResolvedKalshiLossProof([
          { side: "YES", resolved_outcome: "NO", resolved_outcome_pct: null },
          { side: "YES", resolved_outcome: "NO", resolved_outcome_pct: null },
        ]),
        true,
      );
      assert.equal(isResolvedKalshiLossProof([]), false);
      assert.equal(
        isResolvedKalshiLossProof([
          { side: "YES", resolved_outcome: null, resolved_outcome_pct: null },
        ]),
        false,
      );
      assert.equal(
        isResolvedKalshiLossProof([
          { side: "YES", resolved_outcome: "YES", resolved_outcome_pct: null },
        ]),
        false,
      );
      assert.equal(
        isResolvedKalshiLossProof([
          { side: "YES", resolved_outcome: "NO", resolved_outcome_pct: null },
          { side: "YES", resolved_outcome: "YES", resolved_outcome_pct: null },
        ]),
        false,
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
