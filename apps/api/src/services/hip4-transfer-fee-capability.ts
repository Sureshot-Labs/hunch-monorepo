import { z } from "zod";
import type { Pool } from "@hunch/infra";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import { createHip4AccountClient } from "./hip4-client.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import { FundingPersistenceError } from "../funding/persistence/funding-operation-repository.js";

const checkSchema = z.object({
  fee: z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/u),
  isSanctioned: z.boolean(),
  userExists: z.boolean(),
  userHasSentTx: z.boolean(),
});
export type NativeTransferFeeBinding = Readonly<{
  owner: string;
  depository: string;
  sourceDex: "spot" | "";
  destinationDex: "spot" | "";
}>;
export type NativeTransferFeeObservation = NativeTransferFeeBinding &
  Readonly<{ observedAt: string; expiresAt: string }>;

export class NativeTransferFeeCapabilityError extends FundingPersistenceError {
  readonly reason = "native_transfer_fee_unverified";
  constructor() {
    super(
      "quote_invalidated",
      "HyperCore transfer fees are not verified for this account. Complete account activation in Hyperliquid, then refresh and review funding again. No transfer was submitted.",
    );
  }
}

function normalizedBinding(input: NativeTransferFeeBinding) {
  const owner = hip4AccountAddressSchema.parse(input.owner);
  const depository = hip4AccountAddressSchema.parse(input.depository);
  // This is native USDC -> an established Relay default-perps account, never
  // Core->EVM forwarding/system transfers. Protocol identities, not a rollout
  // allowlist: the exact depository is independently frozen by /chains.
  if (
    owner === depository ||
    !["spot", ""].includes(input.sourceDex) ||
    input.destinationDex !== "" ||
    /^0x0{40}$/u.test(depository) ||
    /^0x200000000000000000000000[\da-f]{16}$/u.test(depository) ||
    depository === `0x${"2".repeat(40)}`
  )
    throw new NativeTransferFeeCapabilityError();
  return { ...input, owner, depository };
}

/** Positive current-info capability, not a fee guessed from role/balance or
 * a hardcoded $1. preTransferCheck is the official native SendAsset fee-review
 * boundary; forwarding gas is a separate unsupported action. Fee-bearing/new
 * sources are excluded BEFORE signatures, not stranded after admission. */
export function zeroNativeTransferFeeObservation(input: {
  binding: NativeTransferFeeBinding;
  sourceCheck: unknown;
  destinationCheck: unknown;
  observedAt: number;
  expiresAt: number;
  now: number;
}): NativeTransferFeeObservation {
  const binding = normalizedBinding(input.binding);
  for (const value of [input.sourceCheck, input.destinationCheck]) {
    const check = checkSchema.safeParse(value);
    if (
      !check.success ||
      !/^0(?:\.0+)?$/u.test(check.data.fee) ||
      check.data.isSanctioned ||
      !check.data.userExists ||
      !check.data.userHasSentTx
    )
      throw new NativeTransferFeeCapabilityError();
  }
  const result = {
    ...binding,
    observedAt: new Date(input.observedAt).toISOString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
  };
  assertNativeTransferFeeObservation(result, binding, input.now);
  return result;
}

/** Recheck after transaction/lock waits. Submitted replay never asks for this
 * capability again and never turns missing/changed fees into a failed send. */
export function assertNativeTransferFeeObservation(
  observation: NativeTransferFeeObservation | undefined,
  input: NativeTransferFeeBinding,
  now = Date.now(),
): asserts observation is NativeTransferFeeObservation {
  const binding = normalizedBinding(input);
  if (
    !observation ||
    observation.owner !== binding.owner ||
    observation.depository !== binding.depository ||
    observation.sourceDex !== binding.sourceDex ||
    observation.destinationDex !== binding.destinationDex ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(observation.observedAt)) ||
    !Number.isFinite(Date.parse(observation.expiresAt)) ||
    Date.parse(observation.observedAt) > now ||
    Date.parse(observation.expiresAt) <= now ||
    Date.parse(observation.expiresAt) <= Date.parse(observation.observedAt)
  )
    throw new NativeTransferFeeCapabilityError();
}

/** Uncached, shared provider budget, bounded IO before financial locks. The
 * reverse check observes the source's activation state; the forward check is
 * exactly (user=depository, source=owner), not a nearest-address probe. */
export async function readNativeTransferFeeCapability(
  pool: Pick<Pool, "query">,
  input: NativeTransferFeeBinding,
  options: { fetcher?: typeof fetch; deadlineMs?: number } = {},
): Promise<NativeTransferFeeObservation> {
  const binding = normalizedBinding(input);
  const [read, account] = await Promise.all([
    readHip4Policy(pool, "accountRead"),
    readHip4AccountPolicy(pool),
  ]);
  if (
    !read.policy.enabled ||
    !account.policy.enabled ||
    read.policy.environment !== "mainnet"
  )
    throw new NativeTransferFeeCapabilityError();
  const observedAt = Date.now();
  const expiresAt = Math.min(
    observedAt + account.policy.snapshotMaxAgeMs,
    options.deadlineMs ?? Number.MAX_SAFE_INTEGER,
  );
  const client = createHip4AccountClient(
    read.policy,
    (weight) =>
      admitHip4Request(
        pool,
        "mainnet",
        weight,
        read.policy.requestWeightPerMinute,
      ),
    options.fetcher,
    {
      deadlineMs: Math.min(
        expiresAt,
        observedAt + read.policy.requestTimeoutMs,
      ),
    },
  );
  const sourceCheck = await client({
    type: "preTransferCheck",
    user: binding.owner,
    source: binding.depository,
  });
  const destinationCheck = await client({
    type: "preTransferCheck",
    user: binding.depository,
    source: binding.owner,
  });
  return zeroNativeTransferFeeObservation({
    binding,
    sourceCheck,
    destinationCheck,
    observedAt,
    expiresAt,
    now: Date.now(),
  });
}
