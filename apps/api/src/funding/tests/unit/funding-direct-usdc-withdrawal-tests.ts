import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { relaySponsorIdempotencyKey } from "../../execution/relay-solana-sponsorship.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import {
  buildExactUsdcWithdrawalAction,
  assertDirectWithdrawalActionMatchesRecipient,
} from "../../execution/direct-withdrawal-transfer.js";
import type {
  ResolvedExternalRecipient,
  WalletExecutionProfile,
} from "../../domain/types.js";

const address = Keypair.generate().publicKey.toBase58();
assert.equal(
  relaySponsorIdempotencyKey("user", "same-transfer", "step-a"),
  relaySponsorIdempotencyKey("user", "same-transfer", "step-a"),
);
assert.notEqual(
  relaySponsorIdempotencyKey("user", "same-transfer", "step-a"),
  relaySponsorIdempotencyKey("user", "same-transfer", "step-b"),
);
assert.notEqual(
  relaySponsorIdempotencyKey("user", "same-transfer", "step-a"),
  relaySponsorIdempotencyKey("another-user", "same-transfer", "step-a"),
);
const receiver = Keypair.generate().publicKey.toBase58();
const asset = {
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaUsdc,
  decimals: 6,
};
const profile: WalletExecutionProfile = {
  walletId: "wallet_test",
  address,
  networkId: asset.networkId,
  source: "embedded",
  signingModes: ["privy_authorization"],
  serverWalletRef: "internal",
  sponsorshipPolicyIds: [],
};
const recipient = {
  address: receiver,
  addressFingerprint: "fingerprint",
  asset,
  networkId: asset.networkId,
} as ResolvedExternalRecipient;
for (const createRecipientAta of [false, true]) {
  const built = buildExactUsdcWithdrawalAction({
    amount: { asset, raw: "5790262" },
    profile,
    recipient,
    createRecipientAta,
  });
  assert.equal(built.action.instructions.length, createRecipientAta ? 2 : 1);
  assert.doesNotThrow(() =>
    assertDirectWithdrawalActionMatchesRecipient({
      action: built.action,
      actionValidationResult: built.validation,
      recipient,
      required: true,
    }),
  );
  assert.throws(() =>
    assertDirectWithdrawalActionMatchesRecipient({
      action: built.action,
      actionValidationResult: built.validation,
      recipient: { ...recipient, address },
      required: true,
    }),
  );
  const changed = buildExactUsdcWithdrawalAction({
    amount: { asset, raw: "5790263" },
    profile,
    recipient,
    createRecipientAta,
  });
  assert.throws(() =>
    assertDirectWithdrawalActionMatchesRecipient({
      action: changed.action,
      actionValidationResult: built.validation,
      recipient,
      required: true,
    }),
  );
  assert.throws(() =>
    assertDirectWithdrawalActionMatchesRecipient({
      action: {
        ...built.action,
        instructions: [
          ...built.action.instructions,
          ...built.action.instructions,
        ],
      },
      actionValidationResult: built.validation,
      recipient,
      required: true,
    }),
  );
}
assert.throws(() =>
  buildExactUsdcWithdrawalAction({
    amount: { asset: { ...asset, decimals: 9 }, raw: "1" },
    profile,
    recipient,
    createRecipientAta: false,
  }),
);
assert.throws(() =>
  buildExactUsdcWithdrawalAction({
    amount: { asset, raw: "1" },
    profile,
    recipient: { ...recipient, address },
    createRecipientAta: false,
  }),
);
