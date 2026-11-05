// Structural decoder only; the original guards stay in the signed transaction
// and are evaluated on chain. Never use normalization to authorize sponsorship.
// ABI: Jac0xb/lighthouse@4c579479c98635e419b1b167f08be02a71604a71,
// programs/lighthouse/src/{instruction.rs,types/assert}, lighthouse-common/src.
// LogLevel uses Borsh enum ordinals 0..6 (also the generated SDK), not the
// explicit Rust repr values 0x10..0x12. Ordinary u64/i64 remain eight bytes;
// only CompactU64 and LEB128Vec lengths use unsigned LEB128.
export const SVM_LIGHTHOUSE_PROGRAM_ID =
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

type Shape =
  | number
  | "bool"
  | "compact"
  | readonly Shape[]
  | { readonly variants: readonly Shape[] }
  | { readonly optional: Shape }
  | { readonly vector: Shape };

const enumeration = (...variants: Shape[]): Shape => ({ variants });
const integerOperator = enumeration(0, 0, 0, 0, 0, 0, 0, 0);
const equalOperator = enumeration(0, 0);
const numeric = (size: number): Shape => [size, integerOperator];
const equatable = (value: Shape): Shape => [value, equalOperator];
const optionalKey: Shape = { optional: 32 };
const accountData = [
  "compact",
  enumeration(
    equatable("bool"),
    ...[1, 1, 2, 2, 4, 4, 8, 8, 16, 16].map(numeric),
    equatable({ vector: 1 }),
    equatable(32),
  ),
] satisfies Shape;
const accountInfo = enumeration(
  numeric(8),
  numeric(8),
  equatable(32),
  equatable(enumeration(0, 0, 0, 0, 0, 0, 0, 0, 0)), // KnownProgram
  numeric(8),
  equatable("bool"),
  equatable("bool"),
  equatable("bool"),
  [32, "compact", "compact"],
);
const accountDelta = enumeration(
  [
    "compact",
    enumeration(numeric(16), numeric(16), equalOperator, numeric(16)),
  ],
  [
    "compact",
    "compact",
    enumeration(...[2, 2, 4, 4, 8, 8, 16, 16].map(numeric), equatable(2)),
  ],
);
const mint = enumeration(
  equatable(optionalKey),
  numeric(8),
  numeric(1),
  equatable("bool"),
  equatable(optionalKey),
);
const token = enumeration(
  equatable(32),
  equatable(32),
  numeric(8),
  equatable(optionalKey),
  numeric(1),
  equatable({ optional: 8 }),
  numeric(8),
  equatable(optionalKey),
  0, // TokenAccountOwnerIsDerived
);
const stake = enumeration(
  equatable(enumeration(0, 0, 0, 0)),
  enumeration(
    numeric(8),
    equatable(32),
    equatable(32),
    numeric(8),
    numeric(8),
    equatable(32),
  ),
  enumeration(equatable(32), numeric(8), numeric(8), numeric(8), numeric(8)),
  numeric(1),
);
const upgradeableLoader = enumeration(
  equatable(enumeration(0, 0, 0, 0)),
  enumeration(equatable(optionalKey)),
  enumeration(equatable(32)),
  enumeration(equatable(optionalKey), numeric(8)),
);
const assertionShapes: readonly Shape[] = [
  accountData,
  { vector: accountData },
  accountDelta,
  accountInfo,
  { vector: accountInfo },
  mint,
  { vector: mint },
  token,
  { vector: token },
  stake,
  { vector: stake },
  upgradeableLoader,
  { vector: upgradeableLoader },
  enumeration(...Array.from({ length: 5 }, () => numeric(8))), // SysvarClock
  enumeration([4, 32]), // MerkleTree VerifyLeaf
  enumeration(
    equatable(32),
    equatable(32),
    numeric(8),
    numeric(8),
    equatable("bool"),
    equatable(1),
  ),
];

class AssertionReader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}
  skip(bytes: number): void {
    if (bytes < 0 || bytes > this.data.length - this.offset)
      throw Error("truncated_lighthouse_assertion");
    this.offset += bytes;
  }
  byte(): number {
    this.skip(1);
    return this.data[this.offset - 1];
  }
  compact(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = this.byte();
      if (index === 9 && byte > 1) throw Error("lighthouse_integer_overflow");
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if (!(byte & 0x80)) return value;
    }
    throw Error("lighthouse_integer_overflow");
  }
  read(shape: Shape): void {
    if (typeof shape === "number") return this.skip(shape);
    if (shape === "compact") {
      this.compact();
      return;
    }
    if (shape === "bool") {
      if (this.byte() > 1) throw Error("invalid_lighthouse_bool");
      return;
    }
    if (Array.isArray(shape)) {
      for (const field of shape) this.read(field);
      return;
    }
    if ("variants" in shape) {
      const variant = shape.variants[this.byte()];
      if (variant === undefined) throw Error("unknown_lighthouse_variant");
      return this.read(variant);
    }
    if ("optional" in shape) {
      const present = this.byte();
      if (present > 1) throw Error("invalid_lighthouse_option");
      if (present) this.read(shape.optional);
      return;
    }
    if ("vector" in shape) {
      const count = this.compact();
      // Every allowed vector element consumes at least a byte. This bounds
      // work by actual packet bytes, with no allocation from untrusted lengths.
      if (count > BigInt(this.data.length - this.offset))
        throw Error("truncated_lighthouse_vector");
      for (let index = 0; index < Number(count); index++)
        this.read(shape.vector);
      return;
    }
    throw Error("unknown_lighthouse_shape");
  }
}

export function isReadOnlyLighthouseAssertion(
  input: Readonly<{
    programId: string;
    accountCount: number;
    data: Uint8Array;
  }>,
): boolean {
  // 1232 is Solana's complete transaction packet ceiling, not an assertion-
  // count policy. Neither API nor receipt paths may allocate from encoded lengths.
  if (
    input.programId !== SVM_LIGHTHOUSE_PROGRAM_ID ||
    input.data.length < 2 ||
    input.data.length > 1232
  )
    return false;
  const tag = input.data[0];
  // MemoryWrite/MemoryClose can move rent; never normalize them away.
  if (tag < 2 || tag > 17) return false;
  const accounts = tag === 4 ? 2 : tag === 15 ? 0 : tag === 16 ? 3 : 1;
  if (
    !Number.isSafeInteger(input.accountCount) ||
    (tag === 16
      ? input.accountCount < accounts
      : input.accountCount !== accounts)
  )
    return false;
  try {
    const reader = new AssertionReader(input.data);
    reader.byte(); // opcode
    if (reader.byte() > 6) return false; // Borsh LogLevel ordinal
    reader.read(assertionShapes[tag - 2]);
    return reader.offset === input.data.length;
  } catch {
    return false;
  }
}
