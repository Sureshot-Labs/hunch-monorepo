import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";

import type {
  FundingSourceRef,
  FundingTarget,
} from "../../funding/domain/types.js";
import { RelayClient } from "./client.js";
import {
  RELAY_ROUTE_SPECS,
  resolveRelaySolanaDirectDestinationContract,
  type RelayRouteSpec,
} from "./mappings.js";
import {
  RELAY_SOLVER,
  SOLANA_NATIVE,
  SOLANA_USDC,
} from "./rehearsal.js";
import {
  RELAY_SOLANA_DEPOSITORY,
  SOLANA_SYSTEM_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SPL_TOKEN_PROGRAM,
  validateRelaySolanaDirectQuote,
} from "./solana-rehearsal.js";
import { RelayWalletQuoteAdapter } from "./wallet-adapter.js";

const USER = "9HXGB1nMpw4vhMUCZC5JLfpZt6RXZoaf2HptmormMReH";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const ORDER_ID = Buffer.alloc(32, 2);
const LOOKUP_TABLE = "Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP";
const DEPOSITORY_CONFIG = "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc";
const DEPOSITORY_VAULT = "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ";
const TOKEN_VAULT = "4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia";

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function directRoute(routeId: keyof typeof RELAY_ROUTE_SPECS): RelayRouteSpec {
  const route = RELAY_ROUTE_SPECS[routeId];
  if (!route) throw new Error(`missing route ${routeId}`);
  return route;
}

function routeSourceCurrency(route: RelayRouteSpec) {
  if (route.source.assetId === SOLANA_NATIVE) return SOLANA_NATIVE;
  if (route.source.assetId === SOLANA_USDC) return SOLANA_USDC;
  throw new Error("test route source is not allowlisted");
}

function sourceAmount(sourceCurrency: typeof SOLANA_NATIVE | typeof SOLANA_USDC): bigint {
  return sourceCurrency === SOLANA_NATIVE ? 14_000_000n : 1_031_000n;
}

function directQuote(route: RelayRouteSpec) {
  const sourceCurrency = routeSourceCurrency(route);
  const sourceRaw = sourceAmount(sourceCurrency);
  const destination = resolveRelaySolanaDirectDestinationContract(route);
  const native = sourceCurrency === SOLANA_NATIVE;
  const instructionData = Buffer.alloc(48);
  Buffer.from(native ? "0d9e0ddf5fd51c06" : "0b9c60da27a3b413", "hex").copy(
    instructionData,
  );
  instructionData.writeBigUInt64LE(sourceRaw, 8);
  ORDER_ID.copy(instructionData, 16);
  const sourceAta = getAssociatedTokenAddressSync(
    new PublicKey(SOLANA_USDC),
    new PublicKey(USER),
  ).toBase58();
  const keys = native
    ? [
        { pubkey: DEPOSITORY_CONFIG, isSigner: false, isWritable: false },
        { pubkey: USER, isSigner: true, isWritable: true },
        { pubkey: USER, isSigner: false, isWritable: false },
        { pubkey: DEPOSITORY_VAULT, isSigner: false, isWritable: true },
        { pubkey: SOLANA_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ]
    : [
        { pubkey: DEPOSITORY_CONFIG, isSigner: false, isWritable: false },
        { pubkey: USER, isSigner: true, isWritable: true },
        { pubkey: USER, isSigner: false, isWritable: false },
        { pubkey: DEPOSITORY_VAULT, isSigner: false, isWritable: false },
        { pubkey: SOLANA_USDC, isSigner: false, isWritable: false },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_VAULT, isSigner: false, isWritable: true },
        { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        {
          pubkey: SPL_ASSOCIATED_TOKEN_PROGRAM,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: SOLANA_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ];
  const expectedOutputRaw = 1_010_102n;
  const minimumOutputRaw = 1_000_000n;
  const requestId = `fixture-${route.routeId}-direct-depository`;
  return {
    details: {
      sender: USER,
      recipient: RECIPIENT,
      currencyIn: {
        currency: {
          chainId: 792703809,
          address: sourceCurrency,
          decimals: native ? 9 : 6,
        },
        amount: sourceRaw.toString(),
        minimumAmount: sourceRaw.toString(),
        amountUsd: "1.03",
      },
      currencyOut: {
        currency: {
          chainId: destination.destinationChainId,
          address: destination.destinationCurrency,
          decimals: destination.destinationDecimals,
        },
        amount: expectedOutputRaw.toString(),
        minimumAmount: minimumOutputRaw.toString(),
      },
    },
    protocol: {
      v2: {
        orderId: `0x${ORDER_ID.toString("hex")}`,
        hubType: "onchain",
        paymentDetails: {
          chainId: "solana",
          depository: RELAY_SOLANA_DEPOSITORY,
          currency: sourceCurrency,
          amount: sourceRaw.toString(),
        },
        orderData: {
          version: "v1",
          solver: RELAY_SOLVER,
          // Relay's settlement hub remains Base for both output chains.
          solverChainId: "base",
          fees: [],
          inputs: [
            {
              payment: {
                chainId: "solana",
                currency: sourceCurrency,
                amount: sourceRaw.toString(),
                weight: "1",
              },
              refunds: [
                {
                  chainId: "solana",
                  recipient: USER,
                  currency: sourceCurrency,
                },
                {
                  chainId: destination.destinationChain,
                  recipient: RECIPIENT,
                  currency: destination.destinationRefundCurrency,
                },
              ],
            },
          ],
          output: {
            chainId: destination.destinationChain,
            payments: [
              {
                recipient: RECIPIENT,
                currency: destination.destinationCurrency,
                minimumAmount: minimumOutputRaw.toString(),
                expectedAmount: expectedOutputRaw.toString(),
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
              addressLookupTableAddresses: [LOOKUP_TABLE],
              instructions: [
                {
                  programId: RELAY_SOLANA_DEPOSITORY,
                  data: instructionData.toString("hex"),
                  keys,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function validate(route: RelayRouteSpec, quote = directQuote(route)) {
  const sourceCurrency = routeSourceCurrency(route);
  const sourceRaw = sourceAmount(sourceCurrency);
  return validateRelaySolanaDirectQuote({
    amountMode: route.quoteMode,
    authorizedSourceAmountRaw:
      route.quoteMode === "exact_input" ? sourceRaw : sourceRaw + 1_000_000n,
    destination: resolveRelaySolanaDirectDestinationContract(route),
    expectedOutputTargetRaw: 1_010_102n,
    minimumOutputFloorRaw: 1_000_000n,
    quote,
    recipient: RECIPIENT,
    sourceCurrency,
    user: USER,
  });
}

const routeIds = [
  "solana-usdc-to-polygon-pusd",
  "solana-usdc-to-base-usdc",
  "solana-sol-to-polygon-pusd",
  "solana-sol-to-base-usdc",
] as const;

for (const routeId of routeIds) {
  const route = directRoute(routeId);
  const validated = validate(route);
  assert.equal(validated.expectedOutputRaw, 1_010_102n, routeId);
  assert.equal(validated.minimumOutputRaw, 1_000_000n, routeId);
  assert.equal(validated.instruction.programId, RELAY_SOLANA_DEPOSITORY, routeId);
  assert.equal(validated.instruction.addressLookupTableAddresses.length, 1, routeId);
  assert.equal(validated.instruction.data.byteLength, 48, routeId);
}

const polygonNative = directRoute("solana-sol-to-polygon-pusd");
for (const mutation of [
  {
    name: "destination asset",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      candidate.details.currencyOut.currency.address =
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    },
  },
  {
    name: "destination network",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      candidate.details.currencyOut.currency.chainId = 8453;
    },
  },
  {
    name: "refund asset",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const input = required(candidate.protocol.v2.orderData.inputs[0], "input");
      const refund = required(input.refunds[1], "destination refund");
      refund.currency = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    },
  },
  {
    name: "discriminator",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const instruction = required(
        required(required(candidate.steps[0], "step").items[0], "item").data
          .instructions[0],
        "instruction",
      );
      instruction.data = `ff${instruction.data.slice(2)}`;
    },
  },
  {
    name: "instruction amount",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const instruction = required(
        required(required(candidate.steps[0], "step").items[0], "item").data
          .instructions[0],
        "instruction",
      );
      const data = Buffer.from(instruction.data, "hex");
      data.writeBigUInt64LE(1n, 8);
      instruction.data = data.toString("hex");
    },
  },
  {
    name: "order id",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      candidate.protocol.v2.orderId = `0x${"03".repeat(32)}`;
    },
  },
  {
    name: "program id",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const instruction = required(
        required(required(candidate.steps[0], "step").items[0], "item").data
          .instructions[0],
        "instruction",
      );
      instruction.programId = SOLANA_SYSTEM_PROGRAM;
    },
  },
  {
    name: "signer flags",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const instruction = required(
        required(required(candidate.steps[0], "step").items[0], "item").data
          .instructions[0],
        "instruction",
      );
      required(instruction.keys[0], "first key").isSigner = true;
    },
  },
  {
    name: "account order",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const instruction = required(
        required(required(candidate.steps[0], "step").items[0], "item").data
          .instructions[0],
        "instruction",
      );
      [instruction.keys[1], instruction.keys[2]] = [
        instruction.keys[2],
        instruction.keys[1],
      ];
    },
  },
  {
    name: "extra instruction",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      const instructions = required(
        required(candidate.steps[0], "step").items[0],
        "item",
      ).data.instructions;
      instructions.push({ ...required(instructions[0], "instruction") });
    },
  },
  {
    name: "second lookup table",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      required(
        required(candidate.steps[0], "step").items[0],
        "item",
      ).data.addressLookupTableAddresses.push(LOOKUP_TABLE);
    },
  },
  {
    name: "output below frozen floor",
    apply: (candidate: ReturnType<typeof directQuote>) => {
      candidate.details.currencyOut.minimumAmount = "999999";
    },
  },
]) {
  const candidate = directQuote(polygonNative);
  mutation.apply(candidate);
  assert.throws(() => validate(polygonNative, candidate), Error, mutation.name);
}

{
  // The July eight-instruction Jupiter envelope remains a negative drift case.
  const historicJupiter = directQuote(polygonNative);
  const instructions = required(
    required(historicJupiter.steps[0], "step").items[0],
    "item",
  ).data.instructions;
  while (instructions.length < 8) {
    instructions.push({
      ...required(instructions[0], "direct instruction"),
      programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    });
  }
  assert.throws(
    () => validate(polygonNative, historicJupiter),
    /one Relay instruction/u,
  );
}

for (const routeId of routeIds) {
  const route = directRoute(routeId);
  const sourceCurrency = routeSourceCurrency(route);
  const sourceRaw = sourceAmount(sourceCurrency);
  const source: FundingSourceRef = {
    kind: "owned_location",
    location: {
      kind: "wallet",
      locationId: `location-${routeId}`,
      accountId: "account-direct-svm",
      asset: route.source,
      details: { walletId: "wallet-direct-svm", address: USER },
    },
  };
  const destination: FundingTarget = {
    kind: "owned_location",
    location: {
      kind: "wallet",
      locationId: `destination-${routeId}`,
      accountId: "account-direct-svm",
      asset: route.destination,
      details: { walletId: "wallet-direct-evm", address: RECIPIENT },
    },
  };
  const client = new RelayClient({
    apiKey: "test-relay-key",
    fetchImpl: async () =>
      new Response(JSON.stringify(directQuote(route)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const normalized = await new RelayWalletQuoteAdapter(client).quote({
    route,
    source,
    destination,
    sourceAmount: { asset: route.source, raw: sourceRaw.toString() },
    minimumOutput: { asset: route.destination, raw: "1000000" },
    userAddress: USER,
    recipientAddress: RECIPIENT,
    senderWalletId: "wallet-direct-svm",
    quoteCorrelationId: `quote-${routeId}`,
    deadline: new Date(Date.now() + 60_000),
    maximumSlippageBps: 100,
  });
  assert.equal(normalized.actions.length, 1, routeId);
  assert.equal(normalized.actions[0]?.kind, "svm_transaction", routeId);
  if (normalized.actions[0]?.kind === "svm_transaction") {
    assert.equal(normalized.actions[0].instructions.length, 1, routeId);
    assert.equal(normalized.actions[0].addressLookupTables.length, 1, routeId);
  }
}

console.log(
  "[relay-solana-rehearsal] four direct SVM routes and strict Depository drift checks passed",
);
