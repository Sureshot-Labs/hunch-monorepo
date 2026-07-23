import { z } from "zod";

const unsignedIntegerStringSchema = z.string().regex(/^(0|[1-9]\d*)$/u);
const relayAddressSchema = z.string().trim().min(1).max(512);
const relayRequestIdSchema = z.string().trim().min(8).max(512);
const relayStatusSchema = z.string().trim().min(1).max(128);
const relayTransactionReferenceSchema = z.string().trim().min(1).max(256);

const relayDepositAddressObservationSchema = z
  .object({
    address: relayAddressSchema,
    depositAddressType: z.string().trim().min(1).max(64).optional(),
    depositor: relayAddressSchema.optional(),
    depositTxHash: relayTransactionReferenceSchema.optional(),
  })
  .passthrough()
  .nullable();

const relayCurrencySchema = z
  .object({
    chainId: z.number().int().positive(),
    address: relayAddressSchema,
    symbol: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(128).optional(),
    decimals: z.number().int().min(0).max(255).optional(),
  })
  .passthrough();

const relayCurrencyAmountSchema = z
  .object({
    currency: relayCurrencySchema,
    amount: unsignedIntegerStringSchema,
    minimumAmount: unsignedIntegerStringSchema,
  })
  .passthrough();

const relayStepItemSchema = z
  .object({
    status: relayStatusSchema,
    data: z.record(z.string(), z.unknown()),
    check: z
      .object({
        endpoint: z.string().trim().min(1).max(2048),
        method: z.string().trim().min(1).max(16),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const relayStepSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: z.string().trim().min(1).max(64),
    requestId: relayRequestIdSchema,
    depositAddress: relayAddressSchema.nullable().optional(),
    items: z.array(relayStepItemSchema).min(1).max(8),
  })
  .passthrough();

const relayFeeSchema = z
  .object({
    currency: relayCurrencySchema,
    amount: unsignedIntegerStringSchema,
    minimumAmount: unsignedIntegerStringSchema.optional(),
  })
  .passthrough();

export const relayQuoteResponseSchema = z
  .object({
    steps: z.array(relayStepSchema).min(1).max(8),
    details: z
      .object({
        operation: z.string().trim().min(1).max(64).optional(),
        sender: relayAddressSchema.optional(),
        recipient: relayAddressSchema.optional(),
        currencyIn: relayCurrencyAmountSchema,
        currencyOut: relayCurrencyAmountSchema,
        timeEstimate: z.number().finite().nonnegative().max(86_400).optional(),
      })
      .passthrough(),
    fees: z
      .record(z.string().trim().min(1).max(64), relayFeeSchema)
      .refine((fees) => Object.keys(fees).length <= 16, {
        message: "Relay fee collection exceeds policy",
      })
      .optional(),
    protocol: z.unknown().optional(),
    depositAddress: relayAddressSchema.nullable().optional(),
  })
  .passthrough();

export const relayStatusResponseSchema = z
  .object({
    status: relayStatusSchema,
    requestId: relayRequestIdSchema.optional(),
    inTxHashes: z.array(relayTransactionReferenceSchema).max(64).optional(),
    txHashes: z.array(relayTransactionReferenceSchema).max(64).optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    originChainId: z.number().int().positive().optional(),
    destinationChainId: z.number().int().positive().optional(),
    failReason: z.string().trim().min(1).max(128).nullable().optional(),
    refundFailReason: z.string().trim().min(1).max(128).nullable().optional(),
    depositAddress: relayDepositAddressObservationSchema.optional(),
  })
  .passthrough();

const relayRequestListItemWireSchema = z
  .object({
    id: relayRequestIdSchema,
    status: relayStatusSchema,
    updatedAt: z
      .union([
        z.number().int().nonnegative(),
        z.string().trim().min(1).max(64).datetime({ offset: true }),
      ])
      .optional(),
    depositAddress: relayDepositAddressObservationSchema.optional(),
    data: z
      .object({
        failReason: z.string().trim().min(1).max(128).nullable().optional(),
        refundFailReason: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .transform((item) => {
    let updatedAt: number | undefined;
    if (typeof item.updatedAt === "number") {
      updatedAt = item.updatedAt;
    } else if (item.updatedAt !== undefined) {
      const parsed = Date.parse(item.updatedAt);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("Relay Requests v2 updatedAt is invalid");
      }
      updatedAt = parsed;
    }
    return {
      requestId: item.id,
      status: item.status,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(item.depositAddress !== undefined
        ? { depositAddress: item.depositAddress }
        : {}),
      ...(item.data?.failReason !== undefined
        ? { failReason: item.data.failReason }
        : {}),
      ...(item.data?.refundFailReason !== undefined
        ? { refundFailReason: item.data.refundFailReason }
        : {}),
    };
  });

export const relayRequestsResponseSchema = z.union([
  z.array(relayRequestListItemWireSchema).max(512),
  z
    .object({
      requests: z.array(relayRequestListItemWireSchema).max(512),
    })
    .passthrough(),
]);

export const relayWebhookPayloadSchema = z
  .object({
    event: z.literal("request.status.updated"),
    timestamp: z.number().int().nonnegative(),
    data: relayStatusResponseSchema.extend({
      requestId: relayRequestIdSchema,
    }),
  })
  .passthrough();

export type RelayQuoteResponse = z.infer<typeof relayQuoteResponseSchema>;
export type RelayStatusResponse = z.infer<typeof relayStatusResponseSchema>;
export type RelayRequestListItem = z.output<
  typeof relayRequestListItemWireSchema
>;
export type RelayWebhookPayload = z.infer<typeof relayWebhookPayloadSchema>;

export function parseRelayRequestList(
  value: unknown,
): readonly RelayRequestListItem[] {
  const parsed = relayRequestsResponseSchema.parse(value);
  return Array.isArray(parsed) ? parsed : parsed.requests;
}

const DISABLED_CAPABILITY_FIELDS = {
  authorization_list: new Set([
    "authorizationList",
    "authorization_list",
    "authorizations",
  ]),
  deposit_fee_payer: new Set(["depositFeePayer", "deposit_fee_payer"]),
  gasless: new Set(["gasless", "useGasless", "use_gasless"]),
  subsidy: new Set(["subsidizeFees", "subsidize_fees"]),
  topup: new Set(["topupGas", "topup_gas", "topUpGas"]),
} as const;

export type RelayDisabledCapability = keyof typeof DISABLED_CAPABILITY_FIELDS;

export class RelayCapabilityRejectedError extends Error {
  readonly code = "relay_capability_rejected";

  constructor(readonly capability: RelayDisabledCapability) {
    super(`Relay ${capability} capability is disabled`);
  }
}

function capabilityForKey(key: string): RelayDisabledCapability | null {
  for (const [capability, fields] of Object.entries(
    DISABLED_CAPABILITY_FIELDS,
  )) {
    if (fields.has(key)) return capability as RelayDisabledCapability;
  }
  return null;
}

/**
 * Provider capabilities are rejected by field presence, even when Relay
 * returns `false` or `0`. This prevents a schema drift from silently opting a
 * route into semantics Hunch has not implemented.
 */
export function rejectDisabledRelayCapabilities(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      const capability = capabilityForKey(key);
      if (capability) throw new RelayCapabilityRejectedError(capability);
      pending.push(child);
    }
  }
}
