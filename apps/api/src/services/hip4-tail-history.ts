import { z } from "zod";
import {
  hip4FillRepairSchema,
  type Hip4FillRepair,
} from "../schemas/hip4-account.js";
import { hip4AccountFillSchema } from "./hip4-account-contract.js";
import { hip4BasisFillFingerprint } from "./hip4-position-accounting.js";
import { HIP4_FILL_PAGE_MAX } from "./hip4-account-history.js";

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const address = z.string().regex(/^0x[0-9a-f]{40}$/u);
// An unfiltered account tail includes ordinary spot and perp fills as well as
// HIP. Validate the whole wire page, not just the economically selected rows.
const mixedFill = hip4AccountFillSchema.extend({
  coin: z.string().min(1),
  px: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/u),
});

/** Internal derived proof, deliberately not the ByTime cursor or a public DTO. */
export const hip4FillTailCoverageSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("hyperliquid_user_fills"),
    environment: z.enum(["mainnet", "testnet"]),
    address,
    lookbackMs: time,
    baseCoveredFrom: time,
    baseCoveredThrough: time,
    coveredThrough: time,
    requestStartedAt: time,
    receivedAt: time,
    oldestFillTime: time,
    newestFillTime: time,
    returnedRows: z
      .number()
      .int()
      .min(1)
      .max(HIP4_FILL_PAGE_MAX - 1),
  })
  .strict();

/** A documented unfiltered MOST-RECENT, nonempty, uncapped tail overlapping a
 * proven range can bridge only that range's end through THIS balance snapshot.
 * It proves no earlier retention, lifetime PnL or current financial capacity.
 */
export function proveHip4FillTailCoverage(input: {
  environment: "mainnet" | "testnet";
  address: string;
  request: {
    environment: "mainnet" | "testnet";
    address: string;
    startedAt: number;
  };
  snapshotTime: number;
  receivedAt: number;
  lookbackMs: number;
  previous: unknown;
  page: unknown;
}) {
  const previous = hip4FillRepairSchema.safeParse(input.previous).data;
  if (
    !previous ||
    previous.coveredFrom == null ||
    previous.coveredThrough == null ||
    previous.lookbackMs !== input.lookbackMs ||
    previous.coveredFrom > previous.coveredThrough ||
    previous.coveredThrough >= input.snapshotTime ||
    input.environment !== input.request.environment ||
    input.address.toLowerCase() !== input.request.address.toLowerCase() ||
    !address.safeParse(input.address.toLowerCase()).success ||
    ![input.snapshotTime, input.request.startedAt, input.receivedAt].every(
      (value) => time.safeParse(value).success,
    ) ||
    input.snapshotTime > input.request.startedAt ||
    input.request.startedAt > input.receivedAt ||
    !Array.isArray(input.page) ||
    input.page.length === 0 ||
    input.page.length >= HIP4_FILL_PAGE_MAX
  )
    return null;
  const identities = new Map<string, string>();
  let oldestFillTime = Number.MAX_SAFE_INTEGER;
  let newestFillTime = 0;
  for (const value of input.page) {
    const parsed = mixedFill.safeParse(value);
    if (!parsed.success || parsed.data.time > input.receivedAt) return null;
    const fill = parsed.data;
    // Do not let a permissive mixed-asset branch accept an invalid HIP fact.
    if (
      fill.coin.startsWith("#") &&
      !hip4AccountFillSchema.safeParse(value).success
    )
      return null;
    const key = `${fill.time}:${fill.coin}:${fill.tid}:${fill.oid}`;
    const fingerprint = fill.coin.startsWith("#")
      ? hip4BasisFillFingerprint(value)
      : JSON.stringify(fill);
    if (fingerprint == null) return null;
    const prior = identities.get(key);
    if (prior != null && prior !== fingerprint) return null;
    identities.set(key, fingerprint);
    oldestFillTime = Math.min(oldestFillTime, fill.time);
    newestFillTime = Math.max(newestFillTime, fill.time);
  }
  if (oldestFillTime > previous.coveredThrough) return null;
  return hip4FillTailCoverageSchema.parse({
    version: 1,
    source: "hyperliquid_user_fills",
    environment: input.environment,
    address: input.address.toLowerCase(),
    lookbackMs: input.lookbackMs,
    baseCoveredFrom: previous.coveredFrom,
    baseCoveredThrough: previous.coveredThrough,
    coveredThrough: input.snapshotTime,
    requestStartedAt: input.request.startedAt,
    receivedAt: input.receivedAt,
    oldestFillTime,
    newestFillTime,
    returnedRows: input.page.length,
  });
}

/** Compose only with the same surviving ByTime epoch; never move its cursor,
 * replace its source, clear gaps/conflicts, or reuse proof for a newer snapshot.
 */
export function hip4FillCoveredThrough(input: {
  environment: "mainnet" | "testnet";
  address: string;
  snapshotTime: number;
  repair: Hip4FillRepair | undefined;
  tail: unknown;
}) {
  const { repair } = input;
  const tail = hip4FillTailCoverageSchema.safeParse(input.tail).data;
  const priorEnd = repair?.coveredThrough ?? null;
  if (
    !repair ||
    priorEnd == null ||
    repair.coveredFrom == null ||
    !tail ||
    tail.environment !== input.environment ||
    tail.address !== input.address.toLowerCase() ||
    tail.lookbackMs !== repair.lookbackMs ||
    tail.baseCoveredFrom !== repair.coveredFrom ||
    tail.baseCoveredThrough > priorEnd ||
    tail.baseCoveredThrough < tail.baseCoveredFrom ||
    tail.oldestFillTime > tail.baseCoveredThrough ||
    tail.coveredThrough !== input.snapshotTime ||
    tail.coveredThrough > tail.requestStartedAt ||
    tail.requestStartedAt > tail.receivedAt ||
    tail.newestFillTime > tail.receivedAt ||
    tail.oldestFillTime > tail.newestFillTime
  )
    return priorEnd;
  return Math.max(priorEnd, tail.coveredThrough);
}
