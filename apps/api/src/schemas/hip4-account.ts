import { z } from "zod";

const decimal = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
const amount = decimal.refine((value) => !value.startsWith("-"));
export const hip4AccountAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((value) => value.toLowerCase());
export const hip4AccountMarketIdSchema = z
  .string()
  .regex(/^hyperliquid:(mainnet|testnet):outcome:(0|[1-9]\d*)$/)
  .max(80);
export const hip4AccountObservationSchema = z
  .object({
    observedAt: z.string().datetime(),
    role: z.enum(["user", "missing"]),
    mode: z.enum([
      "default",
      "disabled",
      "dexAbstraction",
      "unifiedAccount",
      "portfolioMargin",
    ]),
    cash: z
      .object({
        assetId: z.string(),
        decimals: z.number().int(),
        total: decimal,
        held: amount,
        unheld: amount.nullable(),
        ownedCash: amount.nullable(),
        availableAfterMaintenance: decimal.nullable(),
        borrowed: amount.nullable(),
        supplied: amount.nullable(),
        spendable: z.null(),
        canTrade: z.literal(false),
      })
      .strict(),
    balances: z.array(
      z
        .object({
          coin: z.string(),
          total: decimal,
          held: decimal,
          reportedEntryNotional: decimal,
        })
        .strict(),
    ),
    positions: z.array(
      z
        .object({
          coin: z.string(),
          marketId: hip4AccountMarketIdSchema,
          tokenId: z.string(),
          sideIndex: z.number().int().min(0).max(1),
          quantity: amount,
          held: amount,
          reportedEntryNotional: decimal,
          costBasis: z.null(),
          realizedPnl: z.null(),
          unrealizedPnl: z.null(),
        })
        .strict(),
    ),
    unresolvedBalances: z.array(z.string()),
  })
  .strict();
export type Hip4AccountObservation = z.infer<
  typeof hip4AccountObservationSchema
>;

export const hip4AccountExecutionSchema = z
  .object({
    id: z.string(),
    marketId: hip4AccountMarketIdSchema,
    coin: z.string(),
    time: z.number().int().nonnegative(),
    orderId: z.string(),
    tradeId: z.string(),
    transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    reportedClosedPnl: decimal,
    kind: z.string(),
    side: z.enum(["A", "B"]),
    price: amount,
    quantity: amount,
    grossNotional: amount,
    fee: decimal,
    feeToken: z.string(),
    builderFee: amount.nullable(),
    netQuoteCash: decimal.nullable(),
    source: z.literal("hyperliquid_user_fills"),
  })
  .strict();
export type Hip4AccountExecution = z.infer<typeof hip4AccountExecutionSchema>;

// A completed scan only exhausts the provider-visible range. Hyperliquid
// exposes at most the latest 10,000 fills; this is never all-time coverage.
const historyTime = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hip4FillRepairSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("hyperliquid_user_fills_by_time"),
    providerRetentionLimited: z.literal(true),
    lookbackMs: historyTime,
    startTime: historyTime,
    endTime: historyTime,
    nextTime: historyTime.nullable(),
    pagesRead: z.number().int().nonnegative(),
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
    gaps: z
      .array(
        z
          .object({
            time: historyTime,
            reason: z.literal("timestamp_saturated"),
          })
          .strict(),
      )
      .max(100),
    gapCount: z.number().int().nonnegative(),
    gapDetailsTruncated: z.boolean(),
    cursorResetCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type Hip4FillRepair = z.infer<typeof hip4FillRepairSchema>;

export const hip4AccountResponseSchema = z
  .object({
    version: z.literal(1),
    environment: z.enum(["mainnet", "testnet"]),
    address: hip4AccountAddressSchema,
    policyRevision: z.string(),
    refreshAfterMs: z.number().int().positive(),
    state: z.enum(["fresh", "stale", "unavailable"]),
    observation: hip4AccountObservationSchema.nullable(),
    validUntil: z.string().datetime().nullable(),
    refreshState: z.enum(["idle", "refreshing", "failed"]),
    lastAttemptAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
    history: z
      .object({
        allTimeComplete: z.literal(false),
        executionsObservedAt: z.string().datetime().nullable(),
        ledgerObservedAt: z.string().datetime().nullable(),
        lookbackStart: z.string().datetime().nullable(),
        fillsProviderCapped: z.boolean(),
        ledgerProviderCapped: z.boolean(),
        fillRepair: hip4FillRepairSchema.nullable().optional(),
        interpretation: z.literal("native_records_cost_basis_unverified"),
      })
      .strict(),
  })
  .strict();
export const hip4AccountExecutionPageSchema = z
  .object({
    environment: z.enum(["mainnet", "testnet"]),
    address: hip4AccountAddressSchema,
    items: z.array(hip4AccountExecutionSchema),
    nextCursor: z.string().nullable(),
    allTimeComplete: z.literal(false),
  })
  .strict();
