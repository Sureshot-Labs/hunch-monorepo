import { SVM_LIGHTHOUSE_PROGRAM_ID } from "../../execution/solana-wallet-assertions.js";
import { matchesFundingMessageWithComputeBudget } from "../../execution/solana-compute-budget.js";
import {
  lighthouseVectors,
  lighthouseMerkleGuard,
} from "../fixtures/lighthouse.js";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
  PublicKey,
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

// Phantom adds read-only Lighthouse assertions as well as priority-fee settings.
const lighthouse = new PublicKey(SVM_LIGHTHOUSE_PROGRAM_ID);
const guard = new TransactionInstruction({
  programId: lighthouse,
  keys: [{ pubkey: payer, isSigner: false, isWritable: false }],
  // AccountInfo::IsSigner(true, Equal), not a truncated u64 Lamports payload.
  data: Buffer.from([5, 0, 5, 1, 0]),
});
for (const instructions of [
  [transfer, guard],
  [limit, price, transfer, guard, guard, guard, guard],
]) {
  assert.equal(
    matchesFundingMessageWithComputeBudget(expected, message(instructions), []),
    true,
  );
}
// Existing provider assertions are retained byte-for-byte, just as in the
// worker, while the existing bounded wallet priority-fee path still applies.
const committedGuard = message([transfer, guard]);
assert.equal(
  matchesFundingMessageWithComputeBudget(
    committedGuard,
    message([limit, price, transfer, guard]),
    [],
  ),
  true,
);
for (const instructions of [
  [limit, transfer], // omitted committed assertion
  [
    limit,
    transfer,
    new TransactionInstruction({
      ...guard,
      data: Buffer.from([5, 0, 5, 0, 0]),
    }),
  ],
  [
    limit,
    transfer,
    new TransactionInstruction({
      ...guard,
      programId: Keypair.generate().publicKey,
    }),
  ],
  [
    limit,
    transfer,
    guard,
    new TransactionInstruction({ ...guard, data: Buffer.from([0, 0, 0]) }),
  ],
  [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
    transfer,
    guard,
  ],
])
  assert.equal(
    matchesFundingMessageWithComputeBudget(
      committedGuard,
      message(instructions),
      [],
    ),
    false,
  );
assert.equal(
  matchesFundingMessageWithComputeBudget(
    message([limit, transfer]),
    message([limit, transfer, guard]),
    [],
  ),
  true,
);
for (const instruction of [
  new TransactionInstruction({ ...guard, data: Buffer.from([0, 0, 0]) }),
  new TransactionInstruction({ ...guard, data: Buffer.from([1, 0, 0]) }),
  new TransactionInstruction({ ...guard, data: Buffer.from([18, 0, 0]) }),
  new TransactionInstruction({ ...guard, data: Buffer.from([5, 0]) }),
  new TransactionInstruction({ ...guard, data: Buffer.from([5, 0, 0, 1, 0]) }),
  new TransactionInstruction({ ...guard, data: Buffer.from([5, 0, 5, 1, 2]) }),
  new TransactionInstruction({ ...guard, keys: [] }),
  new TransactionInstruction({
    ...guard,
    programId: Keypair.generate().publicKey,
  }),
]) {
  assert.equal(
    matchesFundingMessageWithComputeBudget(
      expected,
      message([transfer, instruction]),
      [],
    ),
    false,
  );
}
assert.equal(
  matchesFundingMessageWithComputeBudget(
    expected,
    message([changedAmount, guard]),
    [],
  ),
  false,
);

// Every supported assertion family is inert only for comparison. The original
// guard bytes remain in actual; account metas/business privileges cannot change.
const proofKeys = [
  payer,
  ...Array.from({ length: 7 }, () => Keypair.generate().publicKey),
];
const withGuard = (data: Buffer, accountCount: number) =>
  new TransactionInstruction({
    programId: lighthouse,
    keys: proofKeys
      .slice(0, accountCount)
      .map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    data,
  });
for (const vector of lighthouseVectors) {
  assert.equal(
    matchesFundingMessageWithComputeBudget(
      expected,
      message([transfer, withGuard(vector.data, vector.accountCount)]),
      [],
    ),
    true,
    vector.label,
  );
}
for (const accountCount of [3, 4, 8]) {
  assert.equal(
    matchesFundingMessageWithComputeBudget(
      expected,
      message([transfer, withGuard(lighthouseMerkleGuard, accountCount)]),
      [],
    ),
    true,
    `Merkle proof ${accountCount}`,
  );
}
assert.equal(
  matchesFundingMessageWithComputeBudget(
    expected,
    message([transfer, withGuard(lighthouseMerkleGuard.subarray(0, -1), 4)]),
    [],
  ),
  false,
);
// Adding writable access to a business account is not hidden by normalization.
const readonlyBusiness = new TransactionInstruction({
  programId: SystemProgram.programId,
  keys: [{ pubkey: proofKeys[1], isSigner: false, isWritable: false }],
  data: Buffer.from([1]),
});
const escalated = new TransactionInstruction({
  ...guard,
  keys: [{ pubkey: proofKeys[1], isSigner: false, isWritable: true }],
});
assert.equal(
  matchesFundingMessageWithComputeBudget(
    message([readonlyBusiness]),
    message([readonlyBusiness, escalated]),
    [],
  ),
  false,
);
assert.equal(
  matchesFundingMessageWithComputeBudget(
    expected,
    message([transfer, guard, transfer]),
    [],
  ),
  false,
);
assert.equal(
  matchesFundingMessageWithComputeBudget(
    message([limit, transfer]),
    message([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      transfer,
      guard,
    ]),
    [],
  ),
  false,
);
