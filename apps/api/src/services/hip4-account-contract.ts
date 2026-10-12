// P0 wire contracts only: no account fetch, ownership grant, cash projection or
// funding receipt confirmation. See docs/hyperliquid-hip4-integration.md §18 for
// provenance and the distinction between documented shapes and live evidence.
import { z } from "zod";
import { parseHip4Coin } from "@hunch/shared";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const decimal = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
// Keep composed Zod instances in this package: shared currently resolves a
// different Zod minor, which is not tuple-type compatible with the API version.
const unsignedDecimal = decimal.refine((value) => !value.startsWith("-"));
const token = z.string().min(1);
const outcomeCoin = z.string().refine((value) => {
  try {
    parseHip4Coin(value);
    return true;
  } catch {
    return false;
  }
});
const probability = unsignedDecimal.refine(
  (value) => value.startsWith("0") || /^1(?:\.0+)?$/.test(value),
);
const clientOrderId = z
  .string()
  .regex(/^0x[a-fA-F0-9]{32}$/)
  .nullable()
  .optional();

export const hip4AccountRoleSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("missing") }).passthrough(),
  z.object({ role: z.literal("user") }).passthrough(),
  z.object({ role: z.literal("vault") }).passthrough(),
  z
    .object({
      role: z.literal("agent"),
      data: z.object({ user: address }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("subAccount"),
      data: z.object({ master: address }).passthrough(),
    })
    .passthrough(),
]);

// Keep the documented legacy mode; do not coerce default/missing into Standard.
export const hip4AccountAbstractionSchema = z.enum([
  "default",
  "disabled",
  "dexAbstraction",
  "unifiedAccount",
  "portfolioMargin",
]);

const amounts = { total: decimal, hold: decimal, entryNtl: decimal };
const balance = z
  .object({
    coin: token,
    token: integer.optional(),
    ...amounts,
    spotHold: decimal.optional(),
    ltv: unsignedDecimal.optional(),
    borrowed: unsignedDecimal.optional(),
    supplied: unsignedDecimal.optional(),
  })
  .passthrough()
  .refine(
    (row) =>
      row.token !== undefined || /^(?:\+|o)(?:0|[1-9]\d*)$/.test(row.coin),
    {
      path: ["token"],
      message: "Ordinary spot balances require a token index",
    },
  );
// Outcome rows may omit the ordinary spot token index. Validate every supplied
// known field once: a permissive union fallback must not accept an invalid
// token/hold/borrow value. Neither oN nor entryNtl proves a settled cash receipt.

export const hip4SpotAccountStateSchema = z
  .object({
    balances: z.array(balance),
    portfolioMarginEnabled: z.boolean().optional(),
    evmEscrows: z
      .array(
        z.object({ coin: token, token: integer, total: decimal }).passthrough(),
      )
      .optional(),
    tokenToAvailableAfterMaintenance: z
      .array(z.tuple([integer, decimal]))
      .optional(),
    tokenToPortfolioBorrowRatio: z
      .array(z.tuple([integer, unsignedDecimal]))
      .optional(),
    tokenToPortfolioSupplyRatio: z
      .array(z.tuple([integer, unsignedDecimal]))
      .optional(),
    portfolioMarginRatio: unsignedDecimal.optional(),
  })
  .passthrough();

export const hip4BorrowLendStateSchema = z
  .object({
    tokenToState: z.array(
      z.tuple([
        integer,
        z
          .object({
            borrow: z
              .object({ basis: unsignedDecimal, value: unsignedDecimal })
              .passthrough(),
            supply: z
              .object({ basis: unsignedDecimal, value: unsignedDecimal })
              .passthrough(),
          })
          .passthrough(),
      ]),
    ),
    health: z.string(),
    healthFactor: unsignedDecimal.nullable(),
  })
  .passthrough();

export const hip4AccountFillSchema = z
  .object({
    coin: outcomeCoin,
    px: probability,
    sz: unsignedDecimal,
    side: z.enum(["A", "B"]),
    time: integer,
    startPosition: decimal,
    // Settlement and Merge Outcome are actual native fill kinds, not sales.
    // Future kinds remain readable; financial interpretation is a separate step.
    dir: z.string().min(1),
    closedPnl: decimal,
    hash,
    oid: integer,
    crossed: z.boolean(),
    fee: decimal,
    tid: integer,
    feeToken: z.string(),
    builderFee: unsignedDecimal.optional(),
    cloid: clientOrderId,
    twapId: integer.nullable().optional(),
  })
  .passthrough();

// Historical events are not a current-open-order snapshot. Multiple native
// orders can share cloid after replacement; preserve oid and statusTimestamp.
export const hip4HistoricalOrderObservationSchema = z
  .object({
    status: z.string().min(1),
    statusTimestamp: integer,
    order: z
      .object({
        coin: outcomeCoin,
        side: z.enum(["A", "B"]),
        limitPx: probability,
        sz: unsignedDecimal,
        origSz: unsignedDecimal,
        timestamp: integer,
        oid: integer,
        cloid: clientOrderId,
        orderType: z.string().min(1),
        reduceOnly: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const transferred = {
  user: address,
  destination: address,
  token,
  amount: unsignedDecimal,
  usdcValue: unsignedDecimal,
  fee: unsignedDecimal,
  nativeTokenFee: unsignedDecimal,
  // Native ledger actually emits "" even with nonzero nativeTokenFee. Preserve
  // it as unknown denomination; do not invent USDC or discard the transfer.
  feeToken: z.string(),
};
const ledgerDeltaSchemas = {
  send: z
    .object({
      type: z.literal("send"),
      ...transferred,
      sourceDex: z.string(),
      destinationDex: z.string(),
      nonce: integer,
    })
    .passthrough(),
  spotTransfer: z
    .object({
      type: z.literal("spotTransfer"),
      ...transferred,
      nonce: integer.nullable(),
    })
    .passthrough(),
  internalTransfer: z
    .object({
      type: z.literal("internalTransfer"),
      user: address,
      destination: address,
      usdc: unsignedDecimal,
      fee: unsignedDecimal,
    })
    .passthrough(),
  accountClassTransfer: z
    .object({
      type: z.literal("accountClassTransfer"),
      usdc: unsignedDecimal,
      toPerp: z.boolean(),
    })
    .passthrough(),
  deposit: z
    .object({ type: z.literal("deposit"), usdc: unsignedDecimal })
    .passthrough(),
  withdraw: z
    .object({
      type: z.literal("withdraw"),
      usdc: unsignedDecimal,
      nonce: integer,
      fee: unsignedDecimal,
    })
    .passthrough(),
};
const envelopeSchema = z
  .object({
    time: integer,
    hash,
    delta: z.object({ type: z.string().min(1) }).passthrough(),
  })
  .passthrough();

/** Parse a wire shape, NOT a credit proof. Keep unknown ledger kinds observable. */
export function parseHip4LedgerObservation(input: unknown) {
  const envelope = envelopeSchema.parse(input);
  const kind = envelope.delta.type;
  if (!Object.hasOwn(ledgerDeltaSchemas, kind))
    return { supported: false as const, entry: envelope };
  // A malformed known kind must not fall through the unknown-kind path.
  const schema = ledgerDeltaSchemas[kind as keyof typeof ledgerDeltaSchemas];
  return {
    supported: true as const,
    entry: { ...envelope, delta: schema.parse(envelope.delta) },
  };
}
