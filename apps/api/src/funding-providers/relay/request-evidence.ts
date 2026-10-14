import { z } from "zod";

const text = z.string().trim().min(1).max(512);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currencyAmount = z.object({
  amount: z.string().regex(/^(0|[1-9]\d*)$/u),
  currency: z.object({
    chainId: integer.positive(),
    address: text,
    decimals: integer.max(255),
  }),
});
const transaction = z.object({
  txHash: text,
  chainId: integer.positive(),
  status: text,
  timestamp: integer,
  block: integer.nullable().optional(),
  // Venue-specific native/RPC evidence must be validated at its own boundary.
  // Do not infer successful execution from the request's presentation status.
  data: z.unknown(),
});

const relayRequestBaseSchema = z.object({
  id: text,
  status: text,
  user: text.optional(),
  sender: text.nullable().optional(),
  recipient: text.nullable().optional(),
  data: z.object({
    inTxs: z.array(transaction).max(64).optional(),
    outTxs: z.array(transaction).max(64).optional(),
    route: z
      .object({
        actual: z
          .object({
            origin: z.object({ inputCurrency: currencyAmount }),
            destination: z
              .object({ outputCurrency: currencyAmount })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .optional(),
  }),
});

// Refund-only additions must not break ordinary source/destination reads.
// A malformed projection explicitly disables refund proof, not the base read.
const relayRefundProjectionSchema = z.object({
  refundTo: text.nullable().optional(),
  supersededByRequestId: text.nullable().optional(),
  duplicateDeposits: z
    .object({
      parentRequestId: text.nullable().optional(),
      refundRequestIds: z.array(text).max(64).optional(),
    })
    .nullable()
    .optional(),
  protocol: z
    .object({
      orderId: text.nullable().optional(),
      settlement: z
        .object({
          destination: z
            .object({
              refunds: z
                .array(
                  z.object({
                    chainId: integer.positive(),
                    transactionId: text,
                  }),
                )
                .max(64)
                .optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
  data: z.object({
    refundCurrencyData: currencyAmount.nullable().optional(),
  }),
});
type Base = z.infer<typeof relayRequestBaseSchema>;
type Refund = z.infer<typeof relayRefundProjectionSchema>;
export type RelayRequestEvidence = Base &
  Omit<Refund, "data"> & {
    data: Base["data"] & Refund["data"];
    refundProjectionInvalid?: true;
  };
export const relayRequestEvidenceSchema = z
  .unknown()
  .transform((value, ctx): RelayRequestEvidence => {
    const base = relayRequestBaseSchema.safeParse(value);
    if (!base.success) {
      ctx.addIssue({
        code: "custom",
        message: "Relay request evidence has an invalid base envelope",
      });
      return z.NEVER;
    }
    const refund = relayRefundProjectionSchema.safeParse(value);
    if (!refund.success) return { ...base.data, refundProjectionInvalid: true };
    return {
      ...base.data,
      ...refund.data,
      data: { ...base.data.data, ...refund.data.data },
    };
  });

/** Exact lookup only. A child, neighbouring request or truncated/ambiguous page
 * must never become the financial evidence for the requested operation. */
export function parseRelayRequestEvidence(
  value: unknown,
  requestId: string,
): RelayRequestEvidence | null {
  const page = z
    .object({
      requests: z.array(relayRequestEvidenceSchema).max(1),
      continuation: z.string().nullable().optional(),
    })
    .parse(value);
  if (page.continuation)
    throw new Error("Relay exact request lookup was incomplete");
  const row = page.requests[0];
  if (row && row.id !== requestId)
    throw new Error("Relay exact request identity mismatch");
  return row ?? null;
}
