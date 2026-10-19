import type { Pool } from "@hunch/infra";
import {
  hip4Identity,
  hip4MetadataSchema,
  hip4SpotMetadataSchema,
} from "@hunch/shared";
import { z } from "zod";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  HYPERCORE_MAINNET_USDC,
  isHypercoreMainnetUsdc,
} from "../funding/domain/hypercore-identity.js";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import {
  createHip4AccountClient,
  createHip4ReadClient,
} from "./hip4-client.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";
import { hip4TradeActionSchema } from "./hip4-trade-signing.js";
import type { Hip4OrderSpotMetadataRead } from "./hip4-order-spot-metadata.js";

// Pinned mainnet outcome-specific evidence: integration spec sections 18–19.
// No copied spot/perp fee table, tier fallback, staking reapplication or builder.
const unsigned = z
  .string()
  .max(128)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/u);
const signed = z
  .string()
  .max(128)
  .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/u);
const fraction = unsigned.refine(
  (value) => value.startsWith("0") || /^1(?:\.0+)?$/u.test(value),
);
const userFeesSchema = z.object({
  userSpotCrossRate: fraction,
  userSpotAddRate: signed,
  activeReferralDiscount: fraction,
});
const marketIdSchema = z
  .string()
  .regex(/^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u);
export const hip4OrderFeeObservationSchema = z
  .object({
    version: z.literal("hip4-outcome-fees-v1"),
    environment: z.literal("mainnet"),
    address: hip4AccountAddressSchema,
    marketId: marketIdSchema,
    quoteAssetId: z.literal(HYPERCORE_MAINNET_USDC.assetId),
    side: z.enum(["BUY", "SELL"]),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    marketRevision: z.string().min(1),
    // Null for opening: missing closing multipliers do not make a known free
    // opening unknown. SELL requires all of these actual provider facts.
    closing: z
      .object({
        userFees: userFeesSchema,
        feeScale: unsigned,
        deployerFeeScale: unsigned,
      })
      .strict()
      .nullable(),
    // Metadata does not supply an authoritative aligned-quote membership list.
    // No discount is applied to the bound; this is NOT a claim of non-alignment.
    alignmentTreatment: z.literal("undiscounted_upper_rate"),
  })
  .strict();
export type Hip4OrderFeeObservation = z.infer<
  typeof hip4OrderFeeObservationSchema
>;

type Ratio = { n: bigint; d: bigint };
const one: Ratio = { n: 1n, d: 1n };
const zero: Ratio = { n: 0n, d: 1n };
function ratio(value: string): Ratio {
  const [whole, fraction = ""] = value.split(".");
  return { n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length) };
}
function multiply(a: Ratio, b: Ratio): Ratio {
  return { n: a.n * b.n, d: a.d * b.d };
}
function add(a: Ratio, b: Ratio): Ratio {
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}
function greater(a: Ratio, b: Ratio): boolean {
  return a.n * b.d > b.n * a.d;
}
function render(value: Ratio): string {
  // Denominators remain exact powers of ten; no float or arbitrary precision.
  const decimals = value.d.toString().length - 1;
  if (decimals === 0) return value.n.toString();
  const digits = value.n.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/u, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

/** Current-terms quote, NOT an enforceable lifetime base-fee cap. The native
 * wire does not carry such a cap and GTC may rest after these terms change.
 * Price improvement changes SELL notional; actual executions own accounting.
 * Aggregate ceiling below is an estimate, not proof of per-fill rounding. */
export function quoteHip4OrderFees(input: {
  observation: Hip4OrderFeeObservation;
  address: string;
  action: unknown;
  now?: number;
}) {
  const observed = hip4OrderFeeObservationSchema.parse(input.observation);
  const action = hip4TradeActionSchema.parse(input.action);
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(now) ||
    action.type !== "order" ||
    action.orders.length !== 1 ||
    observed.address !== hip4AccountAddressSchema.parse(input.address) ||
    Date.parse(observed.observedAt) > now ||
    Date.parse(observed.expiresAt) <= now ||
    Date.parse(observed.expiresAt) <= Date.parse(observed.observedAt)
  )
    throw new Error("hip4_fee_observation_unavailable");
  const order = action.orders[0];
  const identity = hip4Identity(
    "mainnet",
    Number(observed.marketId.split(":").at(-1)),
  );
  if (
    !identity.sides.some((side) => side.assetId === order.a) ||
    observed.side !== (order.b ? "BUY" : "SELL")
  )
    throw new Error("hip4_fee_observation_identity_mismatch");
  let maker = zero,
    taker = zero;
  if (!order.b) {
    if (!observed.closing) throw new Error("hip4_fee_terms_unavailable");
    const { userFees, feeScale, deployerFeeScale } = observed.closing;
    const deployer = ratio(deployerFeeScale);
    const referral = ratio(userFees.activeReferralDiscount);
    const multiplier = multiply(
      multiply(
        ratio(feeScale),
        add(deployer, greater(deployer, one) ? deployer : one),
      ),
      { n: referral.d - referral.n, d: referral.d },
    );
    maker = userFees.userSpotAddRate.startsWith("-")
      ? zero
      : multiply(ratio(userFees.userSpotAddRate), multiplier);
    taker = multiply(ratio(userFees.userSpotCrossRate), multiplier);
  }
  // A GTC can cross immediately and then rest. ALO cannot cross; IOC cannot rest.
  const selected =
    order.t.limit.tif === "Alo"
      ? maker
      : order.t.limit.tif === "Ioc"
        ? taker
        : greater(maker, taker)
          ? maker
          : taker;
  const price = ratio(order.p);
  const quoteAtoms = multiply(
    { n: BigInt(order.s) * 100000000n, d: 1n },
    price,
  );
  const fee = multiply(quoteAtoms, selected);
  const estimate = (fee.n + fee.d - 1n) / fee.d;
  const gross = quoteAtoms.n / quoteAtoms.d;
  return {
    version: observed.version,
    observationRevision: canonicalJsonHash(observed),
    marketRevision: observed.marketRevision,
    orderFingerprint: canonicalJsonHash({
      address: observed.address,
      marketId: observed.marketId,
      a: order.a,
      b: order.b,
      p: order.p,
      s: order.s,
      tif: order.t.limit.tif,
    }),
    observedAt: observed.observedAt,
    expiresAt: observed.expiresAt,
    feeRoleAssumption:
      order.t.limit.tif === "Alo"
        ? ("maker" as const)
        : order.t.limit.tif === "Ioc"
          ? ("taker" as const)
          : ("maker_or_taker" as const),
    makerRate: render(maker),
    takerRate: render(taker),
    currentRateUpperBound: render(selected),
    alignmentTreatment: observed.alignmentTreatment,
    estimatedFeeAtLimitRaw: estimate.toString(),
    estimatedNetProceedsAtLimitRaw: order.b
      ? null
      : (gross - estimate).toString(),
    // Known zero opening under the no-builder wire contract, not a fallback.
    buyFeeCapRaw: order.b ? "0" : null,
    lifetimeFeeCapRaw: null,
    feeAccounting: "actual_execution_fee" as const,
    fundingCostsIncluded: false as const,
    builderFeesEnabled: false as const,
  };
}

/** Re-review if refreshed current fees exceed the user's frozen current-rate
 * consent. This does not make future venue fees enforceable by the order wire. */
export function assertHip4CurrentFeeConsent(
  frozen: unknown,
  current: ReturnType<typeof quoteHip4OrderFees>,
) {
  const previous = z
    .object({
      version: z.literal("hip4-outcome-fees-v1"),
      orderFingerprint: z.string(),
      currentRateUpperBound: z
        .string()
        .max(1024)
        .regex(/^(0|[1-9]\d*)(\.\d+)?$/u),
    })
    .safeParse(frozen);
  if (
    !previous.success ||
    previous.data.orderFingerprint !== current.orderFingerprint ||
    greater(
      ratio(current.currentRateUpperBound),
      ratio(previous.data.currentRateUpperBound),
    )
  )
    throw new Error("hip4_fee_consent_changed");
}

/** Call after existing ownership resolution, outside any admission transaction.
 * Reuses common lifecycle and the SAME persisted info budget as the indexer and
 * account reads. Native withdrawals never call this trading-only observation. */
export async function readHip4OrderFeeObservation(
  pool: Pick<Pool, "query">,
  input: { address: string; marketId: string; side: "BUY" | "SELL" },
  fetcher?: typeof fetch,
  spotMetadataRead?: Hip4OrderSpotMetadataRead,
): Promise<Hip4OrderFeeObservation> {
  const address = hip4AccountAddressSchema.parse(input.address);
  const marketId = marketIdSchema.parse(input.marketId);
  const side = z.enum(["BUY", "SELL"]).parse(input.side);
  const identity = hip4Identity("mainnet", Number(marketId.split(":").at(-1)));
  const [read, account] = await Promise.all([
    readHip4Policy(pool, "accountRead"),
    readHip4AccountPolicy(pool),
  ]);
  if (!read.policy.enabled || read.policy.environment !== "mainnet")
    throw new Error("hip4_fee_read_unavailable");
  const admit = (weight: number) =>
    admitHip4Request(
      pool,
      "mainnet",
      weight,
      read.policy.requestWeightPerMinute,
    );
  const publicRead = createHip4ReadClient(read.policy, admit, fetcher);
  const accountRead = createHip4AccountClient(read.policy, admit, fetcher);
  let observedAt = Date.now();
  const metadata = hip4MetadataSchema.parse(
    await publicRead({ type: "outcomeMeta" }),
  );
  const outcomes = metadata.outcomes.filter(
    (outcome) => outcome.outcome === identity.outcome,
  );
  if (outcomes.length !== 1 || outcomes[0].quoteToken !== "USDC")
    throw new Error("hip4_fee_market_unavailable");
  const spotMetadata = spotMetadataRead
    ? await spotMetadataRead()
    : {
        metadata: hip4SpotMetadataSchema.parse(
          await publicRead({ type: "spotMeta" }),
        ),
        observedAt,
      };
  observedAt = Math.min(observedAt, spotMetadata.observedAt);
  const spot = spotMetadata.metadata;
  const quotes = spot.tokens.filter(
    (token) => token.index === 0 || token.name === "USDC",
  );
  const quote = quotes[0];
  if (
    quotes.length !== 1 ||
    quote.index !== 0 ||
    quote.name !== "USDC" ||
    !isHypercoreMainnetUsdc({
      networkId: "hyperliquid:mainnet",
      assetId: quote.tokenId,
      decimals: quote.weiDecimals,
    })
  )
    throw new Error("hip4_fee_quote_identity_mismatch");
  const closing =
    side === "SELL"
      ? {
          userFees: userFeesSchema.parse(
            await accountRead({ type: "userFees", user: address }),
          ),
          feeScale: unsigned.parse(metadata.feeScale),
          deployerFeeScale: unsigned.parse(outcomes[0].deployerFeeScale),
        }
      : null;
  const expiresAt = observedAt + account.policy.snapshotMaxAgeMs;
  if (expiresAt <= Date.now()) throw new Error("hip4_fee_observation_expired");
  return hip4OrderFeeObservationSchema.parse({
    version: "hip4-outcome-fees-v1",
    environment: "mainnet",
    address,
    marketId,
    quoteAssetId: quote.tokenId,
    side,
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    marketRevision: canonicalJsonHash({
      outcome: outcomes[0],
      quote,
      feeScale: metadata.feeScale ?? null,
    }),
    closing,
    alignmentTreatment: "undiscounted_upper_rate",
  });
}
