import assert from "node:assert/strict";
import {
  isReadOnlyLighthouseAssertion,
  SVM_LIGHTHOUSE_PROGRAM_ID,
} from "../../execution/solana-wallet-assertions.js";
import {
  lighthouseVectors,
  lighthouseMerkleGuard,
} from "../fixtures/lighthouse.js";

const accepts = (
  data: Uint8Array,
  accountCount = 1,
  programId = SVM_LIGHTHOUSE_PROGRAM_ID,
) => isReadOnlyLighthouseAssertion({ programId, accountCount, data });
let truncations = 0;
for (const vector of lighthouseVectors) {
  assert.equal(accepts(vector.data, vector.accountCount), true, vector.label);
  for (let length = 0; length < vector.data.length; length++) {
    assert.equal(
      accepts(vector.data.subarray(0, length), vector.accountCount),
      false,
      `${vector.label} truncated at ${length}`,
    );
    truncations++;
  }
  assert.equal(
    accepts(
      Buffer.concat([vector.data, Buffer.from([0])]),
      vector.accountCount,
    ),
    false,
    `${vector.label} trailing bytes`,
  );
  assert.equal(
    accepts(
      vector.data,
      vector.accountCount,
      "11111111111111111111111111111111",
    ),
    false,
  );
}
for (const count of [3, 4, 8, 35])
  assert.equal(
    accepts(lighthouseMerkleGuard, count),
    true,
    `Merkle proof accounts ${count}`,
  );
for (const count of [0, 1, 2, -1, NaN, Infinity, 3.5])
  assert.equal(accepts(lighthouseMerkleGuard, count), false);
// Complete Borsh payloads, including fixed u64 versus CompactU64 and nested enum boundaries.
const invalid = [
  [0, 0, 0],
  [1, 0, 0],
  [18, 0, 0], // mutators/unknown instructions
  [5, 0],
  [5, 0, 0, 1, 0], // missing assertion and truncated u64 (handoff fixture)
  [5, 0, 5, 2, 0],
  [5, 0, 5, 1, 2], // invalid bool/operator
  [5, 0, 9],
  [5, 0, 3, 9, 0], // unknown assertion/KnownProgram
  [7, 0, 0, 2, 0], // invalid Option tag
  [11, 0, 0, 4, 0],
  [13, 0, 0, 4, 0], // unknown nested state
  [15, 0, 5],
  [16, 0, 1], // unknown clock/Merkle variants
  [2, 0, ...Array(10).fill(0x80)], // unterminated/overflowing CompactU64
  [2, 0, ...Array(9).fill(0xff), 2], // >u64
  [3, 0, ...Array(9).fill(0xff), 1], // vector count exceeds actual bytes
  [2, 0, 0, 11, 10, 1, 2, 0], // encoded bytes length exceeds payload
];
for (const data of invalid) {
  const count = data[0] === 4 ? 2 : data[0] === 15 ? 0 : data[0] === 16 ? 3 : 1;
  assert.equal(
    accepts(Buffer.from(data), count),
    false,
    Buffer.from(data).toString("hex"),
  );
}
for (let level = 0; level <= 255; level++) {
  const data = Buffer.from([5, level, 5, 1, 0]);
  assert.equal(accepts(data), level <= 6, `Borsh LogLevel ordinal ${level}`);
}
for (let operator = 0; operator < 256; operator++) {
  assert.equal(
    accepts(Buffer.from([5, 0, 0, ...Array(8).fill(0), operator])),
    operator < 8,
  );
}
// Rust's LEB128 reader accepts non-minimal encodings: do not invent a canonicalization gate.
assert.equal(accepts(Buffer.from([2, 0, 0x80, 0, 1, 0, 0])), true);
assert.equal(
  accepts(Buffer.from([2, 0, ...Array(9).fill(0xff), 1, 1, 0, 0])),
  true,
);
// 128 compact vector elements; every TokenAccountOwnerIsDerived consumes one byte.
assert.equal(
  accepts(Buffer.from([10, 0, 0x80, 1, ...Array(128).fill(8)])),
  true,
);
assert.equal(accepts(Buffer.alloc(1233)), false);
console.log(
  JSON.stringify({
    suite: "solana-wallet-assertions",
    vectors: lighthouseVectors.length,
    truncations,
    opcodes: "2..17",
    merkleProofs: "3+ accounts",
    networkCalls: 0,
  }),
);
