import { z } from "zod";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/u);
const bytes32 = z.string().regex(/^0x[\da-fA-F]{64}$/u);
const raw = z.string().regex(/^(0|[1-9]\d*)$/u);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Strict wire shape shared by native/EVM directions. Callers must still bind
// all monetary identities, deadlines and refunds to the independent intent.
const refundSchema = z
  .object({
    chainId: z.string(),
    recipient: address,
    currency: z.string(),
    minimumAmount: raw,
    deadline: timestamp,
    extraData: z.string(),
  })
  .strict();
export function relayHexV2ProtocolSchema(
  shape: Readonly<{
    sourceChain: z.ZodType<string>;
    sourceCurrency: z.ZodType<string>;
    outputCurrency: z.ZodType<string>;
  }>,
) {
  return z
    .object({
      v2: z
        .object({
          orderId: bytes32,
          // Provider's solver authorization is wire metadata, not a user action.
          // Bind the monetary contract by its order hash below; never execute or
          // persist this optional signature as the user's authorization.
          orderSignature: z
            .string()
            .regex(/^0x[\da-fA-F]{130}$/u)
            .optional(),
          hubType: z.literal("onchain"),
          orderData: z
            .object({
              version: z.literal("v1"),
              solverChainId: z.literal("base"),
              solver: address,
              salt: bytes32,
              inputs: z.tuple([
                z
                  .object({
                    payment: z
                      .object({
                        chainId: shape.sourceChain,
                        currency: shape.sourceCurrency,
                        amount: raw,
                        weight: z.literal("1"),
                      })
                      .strict(),
                    refunds: z.tuple([refundSchema, refundSchema]),
                  })
                  .strict(),
              ]),
              output: z
                .object({
                  chainId: z.string(),
                  payments: z.tuple([
                    z
                      .object({
                        recipient: address,
                        currency: shape.outputCurrency,
                        minimumAmount: raw,
                        expectedAmount: raw,
                      })
                      .strict(),
                  ]),
                  calls: z.tuple([]),
                  deadline: timestamp,
                  extraData: z.string(),
                })
                .strict(),
              fees: z.tuple([]),
            })
            .strict(),
          paymentDetails: z
            .object({
              chainId: shape.sourceChain,
              depository: address,
              currency: shape.sourceCurrency,
              amount: raw,
            })
            .strict(),
        })
        .strict(),
    })
    .strict();
}
