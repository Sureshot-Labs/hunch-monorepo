import {
  TransactionMessage,
  type AddressLookupTableAccount,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  isReadOnlyLighthouseAssertion,
  SVM_LIGHTHOUSE_PROGRAM_ID,
} from "./solana-wallet-assertions.js";

// External, user-paid transactions only. Never use this to authorize sponsorship.
export function matchesFundingMessageWithComputeBudget(
  expected: VersionedMessage,
  actual: VersionedMessage,
  lookupTables: AddressLookupTableAccount[],
): boolean {
  const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);
  if (equal(expected.serialize(), actual.serialize())) return true;
  if (expected.version !== 0 || actual.version !== 0) return false;
  const program = "ComputeBudget111111111111111111111111111111";
  try {
    const wanted = TransactionMessage.decompile(expected, {
      addressLookupTableAccounts: lookupTables,
    });
    const received = TransactionMessage.decompile(actual, {
      addressLookupTableAccounts: lookupTables,
    });
    // Preserve every original instruction, including any provider budget.
    // Only known read-only wallet assertions may be normalized away.
    const originalAssertions = wanted.instructions.some(
      (ix) => ix.programId.toBase58() === SVM_LIGHTHOUSE_PROGRAM_ID,
    );
    const originalBudget = wanted.instructions.some(
      (ix) => ix.programId.toBase58() === program,
    );
    const injectedBudget =
      !originalBudget &&
      received.instructions.some((ix) => ix.programId.toBase58() === program);
    const withoutAssertions = received.instructions.filter(
      (ix) =>
        originalAssertions ||
        !isReadOnlyLighthouseAssertion({
          programId: ix.programId.toBase58(),
          accountCount: ix.keys.length,
          data: ix.data,
        }),
    );
    if (injectedBudget) {
      let units = BigInt(1_400_000); // Conservative ceiling if the wallet supplies price only.
      let price = BigInt(0);
      const seen = new Set<number>();
      for (const ix of received.instructions) {
        if (ix.programId.toBase58() !== program) continue;
        const tag = ix.data[0];
        if (ix.keys.length || seen.has(tag)) return false;
        seen.add(tag);
        const view = new DataView(
          ix.data.buffer,
          ix.data.byteOffset,
          ix.data.byteLength,
        );
        if (tag === 2 && ix.data.length === 5) {
          units = BigInt(view.getUint32(1, true));
          if (units === BigInt(0) || units > BigInt(1_400_000)) return false;
        } else if (tag === 3 && ix.data.length === 9) {
          price = view.getBigUint64(1, true);
        } else return false;
      }
      if (
        !seen.size ||
        (units * price + BigInt(999_999)) / BigInt(1_000_000) > BigInt(100_000)
      )
        return false;
    }
    const count = received.instructions.length;
    received.instructions = withoutAssertions.filter(
      (ix) => !injectedBudget || ix.programId.toBase58() !== program,
    );
    if (received.instructions.length === count) return false;
    // Recompile to normalize shifted account indices; all business bytes,
    // accounts, privileges, payer and blockhash must still match exactly.
    return equal(
      expected.serialize(),
      received.compileToV0Message(lookupTables).serialize(),
    );
  } catch {
    return false;
  }
}
