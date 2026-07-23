import { z } from "zod";

const canonicalIdPattern = /^[a-z0-9][a-z0-9:_-]{1,159}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,191}$/;
const unsignedIntegerPattern = /^(0|[1-9]\d*)$/;
const unsignedDecimalPattern = /^(0|[1-9]\d*)(\.\d+)?$/;
const hexDataPattern = /^0x(?:[0-9a-fA-F]{2})*$/;
const unprefixedHexPattern = /^(?:[0-9a-fA-F]{2})*$/;

export const canonicalIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(160)
  .regex(canonicalIdPattern);

export const opaqueIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(192)
  .regex(opaqueIdPattern);

export const rawAmountSchema = z.string().regex(unsignedIntegerPattern);

export const usdAmountSchema = z
  .string()
  .regex(unsignedDecimalPattern)
  .refine((value) => !value.includes(".") || !value.endsWith("."));

export const networkIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export const assetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 32 && codePoint !== 127 && character.trim() !== "";
    }),
  );

export const assetRefSchema = z
  .object({
    networkId: networkIdSchema,
    assetId: assetIdSchema,
    decimals: z.number().int().min(0).max(36),
  })
  .strict();

export const moneySchema = z
  .object({
    asset: assetRefSchema,
    raw: rawAmountSchema,
  })
  .strict();

export const assetLocationSchema = z
  .object({
    kind: canonicalIdSchema,
    locationId: opaqueIdSchema,
    accountId: opaqueIdSchema,
    asset: assetRefSchema,
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

export const validatedExternalRecipientSchema = z
  .object({
    recipientId: opaqueIdSchema,
    accountId: opaqueIdSchema,
    networkId: canonicalIdSchema,
    asset: assetRefSchema,
    address: z.string().trim().min(1).max(256),
    addressFingerprint: z.string().trim().min(8).max(128),
    validatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    validationPolicyVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((recipient, context) => {
    if (recipient.networkId !== recipient.asset.networkId) {
      context.addIssue({
        code: "custom",
        path: ["asset", "networkId"],
        message: "recipient network and asset network must match",
      });
    }
    if (Date.parse(recipient.expiresAt) <= Date.parse(recipient.validatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "recipient expiry must be after validation",
      });
    }
  });

export const fundingPurposeSchema = z.enum([
  "add_funds",
  "trade_shortfall",
  "convert_asset",
  "withdrawal",
  "manual_rebalance",
]);

export const fundingDiscoveryRequestSchema = z
  .object({
    purpose: fundingPurposeSchema,
    requestedDestinationAmount: moneySchema.nullable(),
    confirmedSourceAmount: moneySchema.nullable(),
    marketContextId: opaqueIdSchema.nullable(),
    destinationOptionId: opaqueIdSchema.nullable(),
    withdrawalRecipientId: opaqueIdSchema.nullable(),
    venueBindingOptionId: opaqueIdSchema.nullable(),
    maxFeeUsd: usdAmountSchema.nullable(),
    maxSlippageBps: z.number().int().min(0).max(10_000).nullable(),
    deadline: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    const withdrawal = request.purpose === "withdrawal";
    if (withdrawal && !request.withdrawalRecipientId) {
      context.addIssue({
        code: "custom",
        path: ["withdrawalRecipientId"],
        message: "withdrawal requires an opaque recipient ID",
      });
    }
    if (
      withdrawal &&
      (request.destinationOptionId || request.venueBindingOptionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["destinationOptionId"],
        message:
          "withdrawal recipient is mutually exclusive with venue destination",
      });
    }
    if (!withdrawal && request.withdrawalRecipientId) {
      context.addIssue({
        code: "custom",
        path: ["withdrawalRecipientId"],
        message: "withdrawal recipient is allowed only for withdrawal",
      });
    }
    if (
      request.purpose === "trade_shortfall" &&
      (!request.marketContextId || !request.requestedDestinationAmount)
    ) {
      context.addIssue({
        code: "custom",
        path: ["marketContextId"],
        message:
          "trade shortfall requires market context and exact requested collateral",
      });
    }
    if (
      request.purpose === "convert_asset" &&
      (!request.confirmedSourceAmount || !request.requestedDestinationAmount)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSourceAmount"],
        message:
          "conversion requires confirmed source and requested destination amounts",
      });
    }
  });

export const fundingQuoteRequestSchema = z
  .object({
    liquidityProjectionId: opaqueIdSchema,
    selectedSourceOptionId: opaqueIdSchema,
    confirmedSourceAmount: moneySchema.nullable(),
    requestedDestinationAmount: moneySchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.confirmedSourceAmount === null &&
      request.requestedDestinationAmount === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSourceAmount"],
        message: "quote must bind an exact source or destination amount",
      });
    }
  });

export const fundingCommitRequestSchema = z
  .object({
    quoteId: opaqueIdSchema,
    consentToken: opaqueIdSchema,
    idempotencyKey: z.string().trim().min(16).max(192),
  })
  .strict();

export const marketContextBindingSchema = z
  .object({
    marketContextId: opaqueIdSchema,
    venueId: canonicalIdSchema,
    marketId: opaqueIdSchema,
    side: z.string().trim().min(1).max(80),
    executionProfileId: canonicalIdSchema,
    marketPriceRevision: opaqueIdSchema,
    collateralAsset: assetRefSchema,
    requestedCollateralRaw: rawAmountSchema,
    compatibleVenueBindingOptionIds: z.array(opaqueIdSchema).min(1).max(32),
    expiresAt: z.string().datetime(),
  })
  .strict();

const normalizedActionBaseSchema = z.object({
  actionId: opaqueIdSchema,
  networkId: canonicalIdSchema,
});

export const evmTransactionActionSchema = normalizedActionBaseSchema
  .extend({
    kind: z.literal("evm_transaction"),
    senderWalletId: opaqueIdSchema,
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    data: z.string().regex(hexDataPattern),
    valueRaw: rawAmountSchema,
    gasLimitRaw: rawAmountSchema.nullable(),
  })
  .strict();

export const svmTransactionActionSchema = normalizedActionBaseSchema
  .extend({
    kind: z.literal("svm_transaction"),
    signerWalletId: opaqueIdSchema,
    instructions: z
      .array(
        z
          .object({
            programId: z.string().trim().min(32).max(64),
            accounts: z
              .array(
                z
                  .object({
                    address: z.string().trim().min(32).max(64),
                    signer: z.boolean(),
                    writable: z.boolean(),
                  })
                  .strict(),
              )
              .min(1)
              .max(64),
            data: z.string().regex(unprefixedHexPattern),
            dataEncoding: z.literal("hex"),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    addressLookupTables: z.array(z.string().trim().min(32).max(64)).max(16),
  })
  .strict();

export const signatureActionSchema = normalizedActionBaseSchema
  .extend({
    kind: z.literal("signature"),
    signerWalletId: opaqueIdSchema,
    payloadKind: z.enum(["eip712", "personal_message", "solana_message"]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const normalizedActionSchema = z.discriminatedUnion("kind", [
  evmTransactionActionSchema,
  svmTransactionActionSchema,
  signatureActionSchema,
]);
