import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import type {
  FundingSourceRef,
  FundingTarget,
} from "../../funding/domain/types.js";
import { RelayClient } from "./client.js";
import { RELAY_ROUTE_SPECS } from "./mappings.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  RELAY_SOLVER,
  SOLANA_NATIVE,
  SOLANA_USDC,
} from "./rehearsal.js";
import {
  POLYGON_USDCE,
  RELAY_SOLANA_DEPOSITORY,
  SOLANA_SYSTEM_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SPL_TOKEN_PROGRAM,
  validateRelaySolanaDirectBaseQuote,
  validateRelaySolanaRehearsalQuote,
} from "./solana-rehearsal.js";
import { RelayWalletQuoteAdapter } from "./wallet-adapter.js";

const user = "9HXGB1nMpw4vhMUCZC5JLfpZt6RXZoaf2HptmormMReH";
const recipient = "0x2222222222222222222222222222222222222222";
const requestId = "fixture-solana-rehearsal-request";
const sourceAta = getAssociatedTokenAddressSync(
  new PublicKey(SOLANA_USDC),
  new PublicKey(user),
).toBase58();

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function quote() {
  return {
    details: {
      sender: user,
      recipient,
      currencyIn: {
        currency: {
          chainId: 792703809,
          address: SOLANA_USDC,
        },
        amount: "250000",
        minimumAmount: "250000",
      },
      currencyOut: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
        },
        amount: "200000",
        minimumAmount: "190000",
      },
    },
    protocol: {
      v2: {
        orderId:
          "0x0101010101010101010101010101010101010101010101010101010101010101",
        hubType: "onchain",
        paymentDetails: {
          chainId: "solana",
          depository: RELAY_SOLANA_DEPOSITORY,
          currency: SOLANA_USDC,
          amount: "250000",
        },
        orderData: {
          version: "v1",
          solver: RELAY_SOLVER,
          solverChainId: "base",
          fees: [],
          inputs: [
            {
              payment: {
                chainId: "solana",
                currency: SOLANA_USDC,
                amount: "250000",
                weight: "1",
              },
              refunds: [
                {
                  chainId: "solana",
                  recipient: user,
                  currency: SOLANA_USDC,
                },
                {
                  chainId: "polygon",
                  recipient,
                  currency: POLYGON_USDCE,
                },
              ],
            },
          ],
          output: {
            chainId: "polygon",
            payments: [
              {
                recipient,
                currency: POLYGON_PUSD,
                minimumAmount: "190000",
                expectedAmount: "200000",
              },
            ],
            calls: [],
          },
        },
      },
    },
    steps: [
      {
        id: "deposit",
        kind: "transaction",
        requestId,
        items: [
          {
            status: "incomplete",
            check: {
              method: "GET",
              endpoint: `/intents/status/v3?requestId=${requestId}`,
            },
            data: {
              addressLookupTableAddresses: [
                "Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP",
              ],
              instructions: [
                {
                  programId: RELAY_SOLANA_DEPOSITORY,
                  data: Buffer.alloc(48, 1).toString("hex"),
                  keys: [
                    {
                      pubkey: "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc",
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: user,
                      isSigner: true,
                      isWritable: true,
                    },
                    {
                      pubkey: user,
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: SOLANA_USDC,
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: sourceAta,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: "4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia",
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: SPL_TOKEN_PROGRAM,
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: SPL_ASSOCIATED_TOKEN_PROGRAM,
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: SOLANA_SYSTEM_PROGRAM,
                      isSigner: false,
                      isWritable: false,
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

{
  const validated = validateRelaySolanaRehearsalQuote({
    amount: 250_000n,
    minimumOutputFloor: 180_000n,
    quote: quote(),
    recipient,
    user,
  });
  assert.equal(validated.expectedOutputRaw, 200_000n);
  assert.equal(validated.minimumOutputRaw, 190_000n);
  assert.equal(validated.instruction.keys[5]?.pubkey, sourceAta);
  assert.equal(validated.instruction.data.byteLength, 48);
}

for (const mutation of [
  {
    name: "uncontrolled signer",
    apply: (candidate: ReturnType<typeof quote>) => {
      const step = required(candidate.steps[0], "deposit step");
      const item = required(step.items[0], "deposit item");
      const instruction = required(item.data.instructions[0], "instruction");
      required(instruction.keys[0], "instruction key 0").isSigner = true;
    },
  },
  {
    name: "wrong source token account",
    apply: (candidate: ReturnType<typeof quote>) => {
      const step = required(candidate.steps[0], "deposit step");
      const item = required(step.items[0], "deposit item");
      const instruction = required(item.data.instructions[0], "instruction");
      required(instruction.keys[5], "instruction key 5").pubkey =
        "4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia";
    },
  },
  {
    name: "wrong output recipient",
    apply: (candidate: ReturnType<typeof quote>) => {
      required(
        candidate.protocol.v2.orderData.output.payments[0],
        "output payment",
      ).recipient = "0x3333333333333333333333333333333333333333";
    },
  },
  {
    name: "amount mismatch",
    apply: (candidate: ReturnType<typeof quote>) => {
      candidate.protocol.v2.paymentDetails.amount = "250001";
    },
  },
  {
    name: "unexpected capability",
    apply: (candidate: ReturnType<typeof quote>) => {
      const step = required(candidate.steps[0], "deposit step");
      const item = required(step.items[0], "deposit item");
      Object.assign(item.data, {
        authorizationList: [],
      });
    },
  },
]) {
  const candidate = quote();
  mutation.apply(candidate);
  assert.throws(
    () =>
      validateRelaySolanaRehearsalQuote({
        amount: 250_000n,
        minimumOutputFloor: 180_000n,
        quote: candidate,
        recipient,
        user,
      }),
    Error,
    mutation.name,
  );
}

assert.throws(
  () =>
    validateRelaySolanaRehearsalQuote({
      amount: 250_000n,
      minimumOutputFloor: 195_000n,
      quote: quote(),
      recipient,
      user,
    }),
  /minimum output below authorized floor/,
);

const directOrderId = Buffer.alloc(32, 2);

function directQuote(
  sourceCurrency: typeof SOLANA_NATIVE | typeof SOLANA_USDC,
) {
  const native = sourceCurrency === SOLANA_NATIVE;
  const sourceAmount = native ? 14_000_000n : 1_031_000n;
  const instructionData = Buffer.alloc(48);
  Buffer.from(native ? "0d9e0ddf5fd51c06" : "0b9c60da27a3b413", "hex").copy(
    instructionData,
    0,
  );
  instructionData.writeBigUInt64LE(sourceAmount, 8);
  directOrderId.copy(instructionData, 16);
  const sourceKeys = native
    ? [
        {
          pubkey: "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc",
          isSigner: false,
          isWritable: false,
        },
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: false },
        {
          pubkey: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: SOLANA_SYSTEM_PROGRAM,
          isSigner: false,
          isWritable: false,
        },
      ]
    : [
        {
          pubkey: "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc",
          isSigner: false,
          isWritable: false,
        },
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: false },
        {
          pubkey: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
          isSigner: false,
          isWritable: false,
        },
        { pubkey: SOLANA_USDC, isSigner: false, isWritable: false },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        {
          pubkey: "4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia",
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: SPL_TOKEN_PROGRAM,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: SPL_ASSOCIATED_TOKEN_PROGRAM,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: SOLANA_SYSTEM_PROGRAM,
          isSigner: false,
          isWritable: false,
        },
      ];
  return {
    details: {
      sender: user,
      recipient,
      currencyIn: {
        currency: {
          chainId: 792703809,
          address: sourceCurrency,
          decimals: native ? 9 : 6,
        },
        amount: sourceAmount.toString(),
        minimumAmount: sourceAmount.toString(),
        amountUsd: "1.03",
      },
      currencyOut: {
        currency: {
          chainId: 8453,
          address: BASE_USDC,
          decimals: 6,
        },
        amount: "1010102",
        minimumAmount: "1000000",
      },
    },
    protocol: {
      v2: {
        orderId: `0x${directOrderId.toString("hex")}`,
        hubType: "onchain",
        paymentDetails: {
          chainId: "solana",
          depository: RELAY_SOLANA_DEPOSITORY,
          currency: sourceCurrency,
          amount: sourceAmount.toString(),
        },
        orderData: {
          version: "v1",
          solver: RELAY_SOLVER,
          solverChainId: "base",
          fees: [],
          inputs: [
            {
              payment: {
                chainId: "solana",
                currency: sourceCurrency,
                amount: sourceAmount.toString(),
                weight: "1",
              },
              refunds: [
                {
                  chainId: "solana",
                  recipient: user,
                  currency: sourceCurrency,
                },
                {
                  chainId: "base",
                  recipient,
                  currency: BASE_USDC,
                },
              ],
            },
          ],
          output: {
            chainId: "base",
            payments: [
              {
                recipient,
                currency: BASE_USDC,
                minimumAmount: "1000000",
                expectedAmount: "1010102",
              },
            ],
            calls: [],
          },
        },
      },
    },
    steps: [
      {
        id: "deposit",
        kind: "transaction",
        requestId: "fixture-direct-solana-base-request",
        items: [
          {
            status: "incomplete",
            check: {
              method: "GET",
              endpoint:
                "/intents/status/v3?requestId=fixture-direct-solana-base-request",
            },
            data: {
              addressLookupTableAddresses: [
                "Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP",
              ],
              instructions: [
                {
                  programId: RELAY_SOLANA_DEPOSITORY,
                  data: instructionData.toString("hex"),
                  keys: sourceKeys,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

for (const sourceCurrency of [SOLANA_NATIVE, SOLANA_USDC] as const) {
  const native = sourceCurrency === SOLANA_NATIVE;
  const validated = validateRelaySolanaDirectBaseQuote({
    amountMode: "expected_output",
    authorizedSourceAmountRaw: native ? 20_000_000n : 1_100_000n,
    expectedOutputTargetRaw: 1_010_102n,
    minimumOutputFloorRaw: 1_000_000n,
    quote: directQuote(sourceCurrency),
    recipient,
    sourceCurrency,
    user,
  });
  assert.equal(validated.expectedOutputRaw, 1_010_102n);
  assert.equal(validated.minimumOutputRaw, 1_000_000n);
  assert.equal(validated.sourceAmountRaw, native ? 14_000_000n : 1_031_000n);
  assert.equal(validated.instruction.programId, RELAY_SOLANA_DEPOSITORY);
  assert.equal(validated.instruction.keys.length, native ? 5 : 10);
  assert.equal(validated.instruction.data.byteLength, 48);

  const wrongAmount = directQuote(sourceCurrency);
  const wrongAmountInstruction = required(
    required(wrongAmount.steps[0], "direct step").items[0],
    "direct item",
  ).data.instructions[0];
  required(wrongAmountInstruction, "direct instruction").data = Buffer.alloc(
    48,
    3,
  ).toString("hex");
  assert.throws(
    () =>
      validateRelaySolanaDirectBaseQuote({
        amountMode: "expected_output",
        authorizedSourceAmountRaw: native ? 20_000_000n : 1_100_000n,
        expectedOutputTargetRaw: 1_010_102n,
        minimumOutputFloorRaw: 1_000_000n,
        quote: wrongAmount,
        recipient,
        sourceCurrency,
        user,
      }),
    /economics binding mismatch/,
  );
}

{
  const validated = validateRelaySolanaDirectBaseQuote({
    amountMode: "exact_input",
    authorizedSourceAmountRaw: 14_000_000n,
    // Exact-input discovery uses a one-unit destination floor. The provider's
    // actual output is validated and frozen from the returned quote instead.
    expectedOutputTargetRaw: 1n,
    minimumOutputFloorRaw: 1n,
    quote: directQuote(SOLANA_NATIVE),
    recipient,
    sourceCurrency: SOLANA_NATIVE,
    user,
  });
  assert.equal(validated.sourceAmountRaw, 14_000_000n);
  assert.equal(validated.expectedOutputRaw, 1_010_102n);

  assert.throws(
    () =>
      validateRelaySolanaDirectBaseQuote({
        amountMode: "exact_input",
        authorizedSourceAmountRaw: 14_000_001n,
        expectedOutputTargetRaw: 1n,
        minimumOutputFloorRaw: 1n,
        quote: directQuote(SOLANA_NATIVE),
        recipient,
        sourceCurrency: SOLANA_NATIVE,
        user,
      }),
    /differs from the authorized exact source amount/u,
  );
}

{
  const configuredRoute = required(
    RELAY_ROUTE_SPECS["solana-sol-to-base-usdc"],
    "direct SOL to Base route",
  );
  const route = { ...configuredRoute, quoteMode: "exact_input" as const };
  const source: FundingSourceRef = {
    kind: "owned_location",
    location: {
      kind: "wallet",
      locationId: "location_direct_solana_source",
      accountId: "account_direct_solana",
      asset: route.source,
      details: { walletId: "wallet_direct_solana", address: user },
    },
  };
  const destination: FundingTarget = {
    kind: "owned_location",
    location: {
      kind: "wallet",
      locationId: "location_direct_base_destination",
      accountId: "account_direct_solana",
      asset: route.destination,
      details: { walletId: "wallet_direct_base", address: recipient },
    },
  };
  let requestBody: Record<string, unknown> = {};
  const client = new RelayClient({
    apiKey: "test-relay-key",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(directQuote(SOLANA_NATIVE)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const normalized = await new RelayWalletQuoteAdapter(client).quote({
    route,
    source,
    destination,
    sourceAmount: { asset: route.source, raw: "14000000" },
    minimumOutput: { asset: route.destination, raw: "1" },
    userAddress: user,
    recipientAddress: recipient,
    senderWalletId: "wallet_direct_solana",
    quoteCorrelationId: "quote_direct_solana_exact_input",
    deadline: new Date(Date.now() + 60_000),
    maximumSlippageBps: 100,
  });
  assert.equal(requestBody.tradeType, "EXACT_INPUT");
  assert.equal(requestBody.amount, "14000000");
  assert.equal(normalized.candidate.amountMode, "exact_input");
  assert.equal(
    normalized.routeShape,
    "relay-solana-native-direct-depository-v1",
  );
  assert.equal(normalized.sourceAmount.raw, "14000000");
  assert.equal(normalized.candidate.expectedOutput.raw, "1010102");
  assert.equal(normalized.actions[0]?.kind, "svm_transaction");
}

console.log(
  "[relay-solana-rehearsal] Polygon and direct Base program, signer, ATA, economics, protocol/refund binding, correlation, and negative mutations ok",
);
