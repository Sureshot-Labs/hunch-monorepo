import assert from "node:assert/strict";
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  type Connection,
} from "@solana/web3.js";
import type {
  SvmTransactionAction,
  WalletExecutionProfile,
} from "../../funding/domain/types.js";
import { resolveActionSponsorship } from "../../funding/execution/sponsorship-policy.js";
import { relaySponsorIdempotencyKey } from "../../funding/execution/relay-solana-sponsorship.js";
import {
  checkRelaySolanaFeeOnly,
  isRelaySolanaSponsorAction,
  matchesRelaySolanaSponsorTransaction,
  proveRelaySolanaFeeOnly,
  relaySolanaActionMessage,
} from "./solana-sponsorship.js";
import {
  RELAY_SOLANA_DEPOSITORY,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
} from "./solana-rehearsal.js";
import { SOLANA_USDC } from "./rehearsal.js";
import { prepareEmbeddedSolanaTransactionRequests } from "../../services/embedded-solana.js";

const signer = "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ";
const vault = new PublicKey("7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ");
const mint = new PublicKey(SOLANA_USDC);
const source = getAssociatedTokenAddressSync(mint, new PublicKey(signer));
const destination = getAssociatedTokenAddressSync(mint, vault, true);
const bytes = Buffer.alloc(48, 1);
Buffer.from("0b9c60da27a3b413", "hex").copy(bytes);
bytes.writeBigUInt64LE(2_000_000n, 8);
const addresses = [
  "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc",
  signer,
  signer,
  vault.toBase58(),
  SOLANA_USDC,
  source.toBase58(),
  destination.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SystemProgram.programId.toBase58(),
];
const action: SvmTransactionAction = {
  actionId: "action_sponsor_test",
  kind: "svm_transaction",
  networkId: "solana:mainnet",
  signerWalletId: "wallet_sponsor_test",
  addressLookupTables: [],
  instructions: [
    {
      programId: RELAY_SOLANA_DEPOSITORY,
      data: bytes.toString("hex"),
      dataEncoding: "hex",
      accounts: addresses.map((address, index) => ({
        address,
        signer: index === 1,
        writable: [1, 5, 6].includes(index),
      })),
    },
  ],
};
const message = relaySolanaActionMessage(
  action,
  signer,
  SystemProgram.programId.toBase58(),
);
const transaction = new VersionedTransaction(message.compileToV0Message());
const match = (candidate: VersionedTransaction) =>
  matchesRelaySolanaSponsorTransaction({
    action,
    signer,
    transaction: candidate,
    lookupTables: [],
  });
assert.equal(isRelaySolanaSponsorAction(action, signer), true);
assert.equal(match(transaction), true);
assert.equal(
  match(
    new VersionedTransaction(
      new TransactionMessage({
        ...message,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 1_000_000_000,
          }),
          ...message.instructions,
        ],
      }).compileToV0Message(),
    ),
  ),
  false,
  "client cannot increase sponsor fees",
);
const altered = structuredClone(action);
const firstInstruction = altered.instructions[0];
assert.ok(firstInstruction);
const changedBytes = Buffer.from(bytes);
changedBytes.writeBigUInt64LE(2_000_001n, 8);
const changedAction = {
  ...altered,
  instructions: [{ ...firstInstruction, data: changedBytes.toString("hex") }],
};
assert.equal(
  match(
    new VersionedTransaction(
      relaySolanaActionMessage(
        changedAction,
        signer,
        message.recentBlockhash,
      ).compileToV0Message(),
    ),
  ),
  false,
  "client cannot change amount",
);
const signature = transaction.signatures[0];
assert.ok(signature);
signature[0] = 1;
assert.equal(
  match(transaction),
  false,
  "only unsigned prepared input is accepted",
);
signature[0] = 0;
for (const replacement of [
  {
    ...firstInstruction,
    accounts: firstInstruction.accounts.map((key, index) =>
      index === 6 ? { ...key, address: source.toBase58() } : key,
    ),
  },
  { ...firstInstruction, programId: SystemProgram.programId.toBase58() },
  { ...firstInstruction, data: bytes.subarray(0, 16).toString("hex") },
]) {
  const candidate = { ...action, instructions: [replacement] };
  assert.equal(
    match(
      new VersionedTransaction(
        relaySolanaActionMessage(
          candidate,
          signer,
          message.recentBlockhash,
        ).compileToV0Message(),
      ),
    ),
    false,
    "recipient, program and provider reference bytes cannot be substituted",
  );
}
assert.equal(
  isRelaySolanaSponsorAction({ ...action, networkId: "evm:137" }, signer),
  false,
);
assert.equal(
  isRelaySolanaSponsorAction(
    {
      ...action,
      instructions: [firstInstruction, firstInstruction],
    },
    signer,
  ),
  false,
);
assert.notEqual(
  relaySponsorIdempotencyKey("user-a", "action-a"),
  relaySponsorIdempotencyKey("user-b", "action-a"),
);
assert.equal(
  relaySponsorIdempotencyKey("user-a", "action-a"),
  relaySponsorIdempotencyKey("user-a", "action-a"),
  "client execution key is deliberately not an input",
);

function tokenData(owner: PublicKey) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 3_000_000n,
      delegateOption: 0,
      delegate: SystemProgram.programId,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: SystemProgram.programId,
    },
    data,
  );
  return data;
}
let missingAccount = false;
let fee = 10_000;
let extraCpi = false;
let simulationError: unknown = null;
let signerLamports = 2_995_000;
let absentSigner = false;
let invalidSigner = false;
const connection = {
  getMultipleAccountsInfoAndContext: async () => ({
    context: { slot: 123 },
    value: [
      ...[new PublicKey(signer), vault].map((owner, index) =>
        missingAccount && index === 1
          ? null
          : {
              data: tokenData(owner),
              lamports: 2_039_280,
              owner: TOKEN_PROGRAM_ID,
              executable: false,
            },
      ),
      absentSigner
        ? null
        : {
            data: Buffer.alloc(0),
            lamports: signerLamports,
            owner: SystemProgram.programId,
            executable: invalidSigner,
          },
    ],
  }),
  getMinimumBalanceForRentExemption: async (space: number) =>
    space === 0 ? 810624 : 2_039_280,
  getLatestBlockhash: async () => ({
    blockhash: SystemProgram.programId.toBase58(),
  }),
  getFeeForMessage: async () => ({ value: fee }),
  simulateTransaction: async (
    tx: VersionedTransaction,
    config: { sigVerify: boolean; innerInstructions: boolean },
  ) => {
    assert.equal(tx.message.staticAccountKeys[0]?.toBase58(), vault.toBase58());
    assert.equal(tx.message.header.numRequiredSignatures, 2);
    assert.equal(config.sigVerify, false);
    assert.equal(config.innerInstructions, true);
    const transfer = {
      programId: TOKEN_PROGRAM_ID,
      parsed: {
        type: "transferChecked",
        info: {
          source: source.toBase58(),
          destination: destination.toBase58(),
          authority: signer,
          mint: SOLANA_USDC,
          tokenAmount: { amount: "2000000" },
        },
      },
    };
    return {
      value: {
        err: simulationError,
        innerInstructions: [
          { instructions: extraCpi ? [transfer, transfer] : [transfer] },
        ],
      },
    };
  },
} as unknown as Connection;
const prove = () => proveRelaySolanaFeeOnly({ connection, action, signer });
assert.equal(await prove(), true);
signerLamports = 0;
assert.equal(
  await prove(),
  true,
  "zero-SOL authority uses existing USDC ATAs with a separate fee payer",
);
absentSigner = true;
assert.equal(
  await prove(),
  true,
  "a never-funded authority need not exist on chain",
);
absentSigner = false;
signerLamports = 1;
assert.equal(await prove(), true, "the token authority is not the fee payer");
invalidSigner = true;
assert.equal(await prove(), false, "do not accept an executable authority");
invalidSigner = false;
signerLamports = 2_995_000;
missingAccount = true;
assert.equal(await prove(), false, "missing ATA is not sponsored");
missingAccount = false;
fee = 15001;
assert.equal(await prove(), false);
fee = 10000;
extraCpi = true;
assert.equal(
  await prove(),
  false,
  "unexpected inner instruction is not sponsored",
);
extraCpi = false;
simulationError = "InsufficientFundsForRent";
assert.equal(await prove(), false);

const profile: WalletExecutionProfile = {
  walletId: action.signerWalletId,
  address: signer,
  networkId: action.networkId,
  source: "embedded",
  signingModes: ["privy_authorization"],
  serverWalletRef: "privy-test",
  sponsorshipPolicyIds: [],
};
const walletContext = {
  signer,
  walletId: "privy-test",
  walletProfile: {
    walletId: "privy-test",
    address: signer,
    walletType: "solana" as const,
    source: "embedded" as const,
    isInternalWallet: true,
  },
};
const requestInputs = {
  context: walletContext,
  transactions: [
    {
      id: action.actionId,
      label: "Funding",
      transaction: Buffer.from(transaction.serialize()).toString("base64"),
      sponsor: true,
    },
  ],
  fetchSponsorBalanceLamports: async () => 0n,
};
const prepared = await prepareEmbeddedSolanaTransactionRequests({
  ...requestInputs,
  embeddedSolanaSponsorshipEnabled: true,
});
assert.equal(
  (prepared[0]?.input.body as { sponsor?: boolean }).sponsor,
  true,
  "server-approved zero-SOL action requests managed sponsorship",
);
await assert.rejects(
  prepareEmbeddedSolanaTransactionRequests({
    ...requestInputs,
    embeddedSolanaSponsorshipEnabled: false,
    checkRelayGas: async () => null,
  }),
  /SOL/,
  "client sponsor flag alone cannot bypass zero-SOL guard",
);
const previous = process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
try {
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
  assert.equal(
    resolveActionSponsorship({ action, profile }).payerRequirement,
    "privy_sponsor",
  );
  assert.equal(
    resolveActionSponsorship({
      action,
      profile: {
        ...profile,
        source: "external",
        serverWalletRef: null,
        signingModes: ["web_client"],
      },
    }).payerRequirement,
    "user",
  );
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "false";
  assert.equal(
    resolveActionSponsorship({ action, profile }).payerRequirement,
    "user",
  );
} finally {
  if (previous === undefined)
    delete process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
  else process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = previous;
}
const savedRpc = process.env.SOLANA_RPC_URL;
const savedFetch = globalThis.fetch;
try {
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
  delete process.env.SOLANA_RPC_URL;
  assert.equal(await checkRelaySolanaFeeOnly({ action, signer }), null);
  process.env.SOLANA_RPC_URL = "https://rpc.invalid";
  globalThis.fetch = async () => {
    throw new Error("synthetic RPC failure");
  };
  assert.equal(await checkRelaySolanaFeeOnly({ action, signer }), null);
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "false";
  assert.equal(await checkRelaySolanaFeeOnly({ action, signer }), false);
} finally {
  globalThis.fetch = savedFetch;
  if (savedRpc === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = savedRpc;
  if (previous === undefined)
    delete process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
  else process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = previous;
}
console.log(
  "[solana-sponsorship-tests] exact server message, fees, ATA/CPI scope, idempotency, ownership capability and independent gate passed",
);
