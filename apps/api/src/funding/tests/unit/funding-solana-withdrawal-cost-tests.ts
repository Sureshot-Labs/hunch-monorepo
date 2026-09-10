import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
} from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { inspectSolanaWithdrawalCost } from "../../execution/solana-withdrawal-cost.js";
import { SOLANA_NATIVE_ASSET } from "../../domain/network-fees.js";
import type { WalletExecutionProfile } from "../../domain/types.js";
import { solanaSponsorBudgetAvailable } from "../../execution/solana-sponsor-budget.js";

const sender = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const profile: WalletExecutionProfile = {
  walletId: "wallet_test",
  address: sender.toBase58(),
  networkId: "solana:mainnet",
  source: "embedded",
  serverWalletRef: "internal",
  signingModes: ["privy_authorization"],
  sponsorshipPolicyIds: [],
};
let simulated = 0;
let failSimulation = false;
let fee: number | null = 5000;
const connection = {
  getAccountInfo: async () => ({
    lamports: 3280121,
    owner: SystemProgram.programId,
    data: Buffer.alloc(0),
    executable: false,
  }),
  getSlotLeader: async () => payer.toBase58(),
  getMultipleAccountsInfo: async () => [
    {
      lamports: 10000000,
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      executable: false,
    },
  ],
  getLatestBlockhash: async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }),
  getFeeForMessage: async () => ({ value: fee }),
  getSlot: async () => 10,
  simulateTransaction: async () => {
    simulated++;
    return {
      value: { err: failSimulation ? "InsufficientFundsForRent" : null },
    };
  },
} as unknown as Connection;
const input = {
  profile,
  recipient: {
    address: recipient.toBase58(),
    addressFingerprint: "fingerprint",
  },
  asset: SOLANA_NATIVE_ASSET,
  availableRaw: 3280121n,
  availableSolRaw: 3280121n,
  connection,
  sponsorEligible: false,
};
assert.equal(
  (await inspectSolanaWithdrawalCost(input)).maximumSourceRaw,
  3275121n,
);
assert.equal(simulated, 1);
assert.equal(
  (await inspectSolanaWithdrawalCost({ ...input, requestedRaw: 3275122n }))
    .built,
  null,
);
assert.equal(
  simulated,
  1,
  "Over-capacity amount must not become an executable action",
);
const sponsored = await inspectSolanaWithdrawalCost({
  ...input,
  sponsorEligible: true,
});
assert.equal(sponsored.maximumSourceRaw, 3280121n);
assert.equal(sponsored.accountRentRaw, 0n);
assert.equal(sponsored.payer, "privy_sponsor");
failSimulation = true;
await assert.rejects(inspectSolanaWithdrawalCost(input), /simulation failed/);
failSimulation = false;
fee = null;
await assert.rejects(inspectSolanaWithdrawalCost(input), /fee unavailable/);
fee = 15001;
await assert.rejects(inspectSolanaWithdrawalCost(input), /outside policy/);
assert.equal(await solanaSponsorBudgetAvailable(null, "user"), false);
assert.equal(
  await solanaSponsorBudgetAvailable({ get: async () => null }, "user"),
  true,
);
assert.equal(
  await solanaSponsorBudgetAvailable(
    { get: async (key) => (key.includes("user:") ? "20" : "0") },
    "user",
  ),
  false,
);
assert.equal(
  await solanaSponsorBudgetAvailable({ get: async () => "corrupt" }, "user"),
  false,
);

const mint = new PublicKey(RELAY_PINNED_ASSETS.solanaUsdc);
function tokenInfo(owner: PublicKey, state = 1) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 2_000_000n,
      delegateOption: 0,
      delegate: SystemProgram.programId,
      state,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: SystemProgram.programId,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    lamports: 2039280,
    executable: false,
  };
}
fee = 5000;
let destinationExists = true;
let sourceState = 1;
let tokenOwner = sender;
const tokenConnection = {
  ...connection,
  getMultipleAccountsInfo: async () => [
    tokenInfo(tokenOwner, sourceState),
    destinationExists ? tokenInfo(recipient) : null,
  ],
  getMinimumBalanceForRentExemption: async () => 2039280,
} as unknown as Connection;
const tokenInput = {
  ...input,
  connection: tokenConnection,
  asset: { networkId: "solana:mainnet", assetId: mint.toBase58(), decimals: 6 },
  availableRaw: 2_000_000n,
  availableSolRaw: 0n,
  sponsorEligible: true,
};
assert.equal(
  (await inspectSolanaWithdrawalCost(tokenInput)).maximumSourceRaw,
  2_000_000n,
);
destinationExists = false;
const missing = await inspectSolanaWithdrawalCost(tokenInput);
assert.equal(missing.payer, "user");
assert.equal(missing.reasonCode, "insufficient_sol_for_rent");
assert.equal(missing.built, null);
const creation = await inspectSolanaWithdrawalCost({
  ...tokenInput,
  availableSolRaw: 2044280n,
});
assert.equal(creation.maximumSourceRaw, 2_000_000n);
assert.equal(creation.built?.action.instructions.length, 2);
assert.equal(creation.userSolCostRaw, 2044280n);
sourceState = 2;
await assert.rejects(inspectSolanaWithdrawalCost(tokenInput), /source invalid/);
sourceState = 1;
tokenOwner = recipient;
await assert.rejects(inspectSolanaWithdrawalCost(tokenInput), /source invalid/);
