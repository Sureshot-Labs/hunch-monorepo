import * as contractsModule from "@hunch/contracts";
import type { abis as contractsAbis } from "@hunch/contracts";

type ContractsInterop = {
  abis?: typeof contractsAbis;
  default?: { abis?: typeof contractsAbis };
};

const interop = contractsModule as ContractsInterop;
const resolvedAbis = interop.abis ?? interop.default?.abis;

if (!resolvedAbis) {
  throw new Error(
    "Failed to load @hunch/contracts abis export (CJS/ESM interop mismatch).",
  );
}

export const abis: typeof contractsAbis = resolvedAbis;
