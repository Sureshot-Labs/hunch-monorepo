// Independent wire fixtures from Lighthouse's Rust Borsh definitions and JS SDK,
// commit 4c579479c98635e419b1b167f08be02a71604a71. These test structure, not
// whether an assertion's condition would hold for a particular on-chain account.
export type LighthouseVector = {
  label: string;
  opcode: number;
  accountCount: number;
  data: Buffer;
};
const bytes = (...parts: (number | Uint8Array)[]) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "number" ? Buffer.from([part]) : Buffer.from(part),
    ),
  );
const zeros = (size: number) => Buffer.alloc(size);
const num = (tag: number, size: number) => bytes(tag, zeros(size), 0);
const key = (tag: number) => bytes(tag, zeros(32), 0);
const option = (tag: number, size: number, present: boolean) =>
  bytes(tag, present ? 1 : 0, zeros(present ? size : 0), 0);

const accountData = [
  bytes(0, 0, 1, 0), // offset, Bool(true, Equal)
  ...[1, 1, 2, 2, 4, 4, 8, 8, 16, 16].map((size, index) =>
    bytes(0, num(index + 1, size)),
  ),
  bytes(0, 11, 2, 0xaa, 0xbb, 1), // CompactBytes length2, NotEqual
  bytes(0, key(12)),
];
const accountInfo = [
  num(0, 8),
  num(1, 8),
  key(2),
  ...Array.from({ length: 9 }, (_, program) => bytes(3, program, 0)),
  num(4, 8),
  bytes(5, 1, 0),
  bytes(6, 0, 1),
  bytes(7, 0, 0),
  bytes(8, zeros(32), 0xe8, 7, 0xff, 1), // hash, CompactU64(1000), CompactU64(255)
];
const delta = [
  bytes(0, 0, num(0, 16)),
  bytes(0, 0, num(1, 16)),
  bytes(0, 0, 2, 0),
  bytes(0, 0, num(3, 16)),
  ...[2, 2, 4, 4, 8, 8, 16, 16].map((size, index) =>
    bytes(1, 0, 0, num(index, size)),
  ),
  bytes(1, 0, 0, 8, 2, 0, 0), // byte delta length u16, Equal
];
const mint = [
  option(0, 32, false),
  option(0, 32, true),
  num(1, 8),
  num(2, 1),
  bytes(3, 1, 0),
  option(4, 32, false),
  option(4, 32, true),
];
const token = [
  key(0),
  key(1),
  num(2, 8),
  option(3, 32, false),
  option(3, 32, true),
  num(4, 1),
  option(5, 8, false),
  option(5, 8, true),
  num(6, 8),
  option(7, 32, false),
  option(7, 32, true),
  bytes(8),
];
const stake = [
  ...Array.from({ length: 4 }, (_, state) => bytes(0, state, 0)),
  ...[num(0, 8), key(1), key(2), num(3, 8), num(4, 8), key(5)].map((value) =>
    bytes(1, value),
  ),
  ...[key(0), num(1, 8), num(2, 8), num(3, 8), num(4, 8)].map((value) =>
    bytes(2, value),
  ),
  num(3, 1),
];
const loader = [
  ...Array.from({ length: 4 }, (_, state) => bytes(0, state, 0)),
  bytes(1, option(0, 32, false)),
  bytes(1, option(0, 32, true)),
  bytes(2, key(0)),
  bytes(3, option(0, 32, false)),
  bytes(3, option(0, 32, true)),
  bytes(3, num(1, 8)),
];
const clock = Array.from({ length: 5 }, (_, variant) => num(variant, 8));
const merkle = [bytes(0, zeros(4), zeros(32))];
const bubblegum = [
  key(0),
  key(1),
  num(2, 8),
  num(3, 8),
  bytes(4, 1, 0),
  bytes(5, 1, 0),
];

const families: readonly [number, Buffer[], number | null][] = [
  [2, accountData, 3],
  [4, delta, null],
  [5, accountInfo, 6],
  [7, mint, 8],
  [9, token, 10],
  [11, stake, 12],
  [13, loader, 14],
  [15, clock, null],
  [16, merkle, null],
  [17, bubblegum, null],
];
export const lighthouseVectors: LighthouseVector[] = families.flatMap(
  ([opcode, values, multi]) => {
    const accountCount =
      opcode === 4 ? 2 : opcode === 15 ? 0 : opcode === 16 ? 3 : 1;
    const singles = values.map((value, index) => ({
      label: `opcode${opcode}/variant${index}`,
      opcode,
      accountCount,
      data: bytes(opcode, 0, value),
    }));
    if (multi !== null) {
      // All lengths here fit a one-byte LEB128 count, not a Borsh u32 length.
      singles.push({
        label: `opcode${multi}/mixed-vector`,
        opcode: multi,
        accountCount,
        data: bytes(multi, 0, values.length, ...values),
      });
      singles.push({
        label: `opcode${multi}/empty-vector`,
        opcode: multi,
        accountCount,
        data: bytes(multi, 0, 0),
      });
    }
    return singles;
  },
);
export const lighthouseSignerGuard = Buffer.from([5, 0, 5, 1, 0]);
export const lighthouseMerkleGuard = bytes(16, 0, merkle[0]);
