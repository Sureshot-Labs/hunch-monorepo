import { matchesFundingMessageWithComputeBudget } from "../../execution/solana-compute-budget.js";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";
const payer = Keypair.generate().publicKey;
const transfer = SystemProgram.transfer({
  fromPubkey: payer,
  toPubkey: Keypair.generate().publicKey,
  lamports: 1,
});
const message = (instructions: (typeof transfer)[]) =>
  new TransactionMessage({
    payerKey: payer,
    recentBlockhash: SystemProgram.programId.toBase58(),
    instructions,
  }).compileToV0Message();
const expected = message([transfer]);
const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });
const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });

for (const [microLamports, accepted] of [
  [500000, true],
  [500001, false],
] as const) {
  assert.equal(
    matchesFundingMessageWithComputeBudget(
      expected,
      message([
        limit,
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
        transfer,
      ]),
      [],
    ),
    accepted,
  );
}
const changedBlockhash = message([limit, price, transfer]);
changedBlockhash.recentBlockhash = Keypair.generate().publicKey.toBase58();
assert.equal(
  matchesFundingMessageWithComputeBudget(expected, changedBlockhash, []),
  false,
);
const changedAmount = SystemProgram.transfer({
  fromPubkey: payer,
  toPubkey: transfer.keys[1].pubkey,
  lamports: 2,
});
assert.equal(
  matchesFundingMessageWithComputeBudget(
    expected,
    message([limit, price, changedAmount]),
    [],
  ),
  false,
);

assert.equal(
  matchesFundingMessageWithComputeBudget(
    expected,
    message([limit, price, transfer]),
    [],
  ),
  true,
);
assert.equal(
  matchesFundingMessageWithComputeBudget(
    expected,
    message([transfer, limit, price]),
    [],
  ),
  true,
);
for (const instructions of [
  [limit, limit, transfer],
  [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400001 }), transfer],
  [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
    transfer,
  ],
  [ComputeBudgetProgram.requestHeapFrame({ bytes: 32768 }), transfer],
  [limit, price, transfer, transfer],
  [
    limit,
    price,
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  ],
  [{ ...limit, keys: transfer.keys }, transfer],
])
  assert.equal(
    matchesFundingMessageWithComputeBudget(expected, message(instructions), []),
    false,
  );
