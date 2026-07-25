#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import type {
  FundingSourceRef,
  FundingTarget,
} from "../../funding/domain/types.js";
import { RelayClient } from "./client.js";
import { RELAY_ROUTE_SPECS } from "./mappings.js";
import {
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
} from "./solana-rehearsal.js";
import { RelayWalletQuoteAdapter } from "./wallet-adapter.js";

const USER = "78Hpb2CbmvW2Gp2aJGZec8nphXdqtRdfjPwwLfxKgo6t";
const RECIPIENT = "0x4D4D9799758f3B4E5DacE902c06D2F213B7C584f";
const REQUEST_ID = `0x${"12".repeat(32)}`;
const ORDER_ID = `0x${"34".repeat(32)}`;
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RELAY_SWAP = "DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const USDC_ATA = getAssociatedTokenAddressSync(
  new PublicKey(SOLANA_USDC),
  new PublicKey(USER),
).toBase58();
const WRAPPED_SOL_ATA = getAssociatedTokenAddressSync(
  new PublicKey(WRAPPED_SOL),
  new PublicKey(USER),
).toBase58();

const key = (pubkey: string, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

function u64le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function quoteFixture() {
  const sourceAmount = 14_398_334n;
  const paymentAmount = "1048240";
  const minimumPaymentAmount = "1037758";
  const expectedOutput = "1010102";
  const minimumOutput = "1000000";
  const transferData = Buffer.alloc(12);
  transferData.writeUInt32LE(2, 0);
  transferData.writeBigUInt64LE(sourceAmount, 4);
  const jupiterData = Buffer.concat([
    Buffer.from("e517cb977ae3ad2a", "hex"),
    Buffer.from("0100000030640001", "hex"),
    u64le(sourceAmount),
    u64le(BigInt(paymentAmount)),
    Buffer.from([100, 0, 0]),
  ]);
  return {
    steps: [
      {
        id: "deposit",
        kind: "transaction",
        requestId: REQUEST_ID,
        depositAddress: "",
        items: [
          {
            status: "incomplete",
            data: {
              instructions: [
                {
                  programId: SPL_ASSOCIATED_TOKEN_PROGRAM,
                  data: "01",
                  keys: [
                    key(USER, true, true),
                    key(USDC_ATA, false, true),
                    key(USER),
                    key(SOLANA_USDC),
                    key(SOLANA_SYSTEM_PROGRAM),
                    key(SPL_TOKEN_PROGRAM),
                  ],
                },
                {
                  programId: SPL_ASSOCIATED_TOKEN_PROGRAM,
                  data: "01",
                  keys: [
                    key(USER, true, true),
                    key(WRAPPED_SOL_ATA, false, true),
                    key(USER),
                    key(WRAPPED_SOL),
                    key(SOLANA_SYSTEM_PROGRAM),
                    key(SPL_TOKEN_PROGRAM),
                  ],
                },
                {
                  programId: SOLANA_SYSTEM_PROGRAM,
                  data: transferData.toString("hex"),
                  keys: [
                    key(USER, true, true),
                    key(WRAPPED_SOL_ATA, false, true),
                  ],
                },
                {
                  programId: SPL_TOKEN_PROGRAM,
                  data: "11",
                  keys: [key(WRAPPED_SOL_ATA, false, true)],
                },
                {
                  programId: JUPITER,
                  data: jupiterData.toString("hex"),
                  keys: [
                    key(SPL_TOKEN_PROGRAM),
                    key(USER, true),
                    key(WRAPPED_SOL_ATA, false, true),
                    key(RELAY_SOLANA_DEPOSITORY, false, true),
                    key(USDC_ATA, false, true),
                    key(SOLANA_USDC),
                    key(JUPITER),
                  ],
                },
                {
                  programId: SPL_TOKEN_PROGRAM,
                  data: "09",
                  keys: [
                    key(WRAPPED_SOL_ATA, false, true),
                    key(USER, false, true),
                    key(USER, true),
                  ],
                },
                {
                  programId: RELAY_SWAP,
                  data: `9d537021bf32ab25${ORDER_ID.slice(2)}`,
                  keys: [
                    key(USER, true, true),
                    key(USER),
                    key(USDC_ATA, false, true),
                    key(JUPITER),
                    key(MEMO),
                    key(SOLANA_USDC),
                    key(USDC_ATA, false, true),
                    key(RELAY_SWAP, false, true),
                    key(RELAY_SOLANA_DEPOSITORY),
                    key(SPL_TOKEN_PROGRAM),
                    key(SPL_ASSOCIATED_TOKEN_PROGRAM),
                    key(SOLANA_SYSTEM_PROGRAM),
                  ],
                },
                {
                  programId: MEMO,
                  data: Buffer.from(REQUEST_ID).toString("hex"),
                  keys: [],
                },
              ],
              addressLookupTableAddresses: [JUPITER, RELAY_SOLANA_DEPOSITORY],
            },
            check: {
              endpoint: `/intents/status/v3?requestId=${REQUEST_ID}`,
              method: "GET",
            },
          },
        ],
      },
    ],
    fees: {
      gas: {
        currency: {
          chainId: 792703809,
          address: SOLANA_NATIVE,
          decimals: 9,
        },
        amount: "48071",
        minimumAmount: "48071",
        amountUsd: "0.00355",
      },
      relayer: {
        currency: {
          chainId: 792703809,
          address: SOLANA_USDC,
          decimals: 6,
        },
        amount: "51897",
        minimumAmount: "51897",
        amountUsd: "0.051897",
      },
      relayerGas: {
        currency: {
          chainId: 792703809,
          address: SOLANA_USDC,
          decimals: 6,
        },
        amount: "31063",
        minimumAmount: "31063",
        amountUsd: "0.031063",
      },
      relayerService: {
        currency: {
          chainId: 792703809,
          address: SOLANA_USDC,
          decimals: 6,
        },
        amount: "20834",
        minimumAmount: "20834",
        amountUsd: "0.020834",
      },
      app: {
        currency: {
          chainId: 792703809,
          address: SOLANA_USDC,
          decimals: 6,
        },
        amount: "0",
        minimumAmount: "0",
        amountUsd: "0",
      },
      subsidized: {
        currency: {
          chainId: 792703809,
          address: SOLANA_USDC,
          decimals: 6,
        },
        amount: "0",
        minimumAmount: "0",
        amountUsd: "0",
      },
    },
    details: {
      operation: "swap",
      sender: USER,
      recipient: RECIPIENT,
      currencyIn: {
        currency: {
          chainId: 792703809,
          address: SOLANA_NATIVE,
          decimals: 9,
        },
        amount: sourceAmount.toString(),
        minimumAmount: sourceAmount.toString(),
        amountUsd: "1.063325",
      },
      currencyOut: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
          decimals: 6,
        },
        amount: expectedOutput,
        minimumAmount: minimumOutput,
        amountUsd: "1.010038",
      },
      route: {
        origin: {
          outputCurrency: {
            currency: {
              chainId: 792703809,
              address: SOLANA_USDC,
              decimals: 6,
            },
            amount: paymentAmount,
            minimumAmount: minimumPaymentAmount,
          },
        },
      },
      timeEstimate: 3,
    },
    protocol: {
      v2: {
        orderId: ORDER_ID,
        hubType: "onchain",
        paymentDetails: {
          chainId: "solana",
          depository: RELAY_SOLANA_DEPOSITORY,
          currency: SOLANA_USDC,
          amount: paymentAmount,
        },
        orderData: {
          version: "v1",
          solverChainId: "base",
          solver: RELAY_SOLVER,
          fees: [],
          inputs: [
            {
              payment: {
                chainId: "solana",
                currency: SOLANA_USDC,
                amount: paymentAmount,
                weight: "1",
              },
              refunds: [
                {
                  chainId: "solana",
                  recipient: USER,
                  currency: SOLANA_USDC,
                },
                {
                  chainId: "polygon",
                  recipient: RECIPIENT,
                  currency: POLYGON_USDCE,
                },
              ],
            },
          ],
          output: {
            chainId: "polygon",
            calls: [],
            payments: [
              {
                recipient: RECIPIENT,
                currency: POLYGON_PUSD,
                expectedAmount: expectedOutput,
                minimumAmount: minimumOutput,
              },
            ],
          },
        },
      },
    },
  };
}

const route = RELAY_ROUTE_SPECS["solana-sol-to-polygon-pusd"];
assert.ok(route);
const source: FundingSourceRef = {
  kind: "owned_location",
  location: {
    kind: "wallet",
    locationId: "location_solana_native_12345678",
    accountId: "account_solana_native_12345678",
    asset: route.source,
    details: { walletId: "wallet_solana_native_12345678", address: USER },
  },
};
const destination: FundingTarget = {
  kind: "owned_location",
  location: {
    kind: "wallet",
    locationId: "location_polygon_pusd_12345678",
    accountId: "account_solana_native_12345678",
    asset: route.destination,
    details: {
      walletId: "wallet_polygon_pusd_12345678",
      address: RECIPIENT,
    },
  },
};

let requestBody: Record<string, unknown> = {};
const client = new RelayClient({
  apiKey: "test-relay-key",
  fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(quoteFixture()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
const result = await new RelayWalletQuoteAdapter(client).quote({
  route,
  source,
  destination,
  sourceAmount: { asset: route.source, raw: "20000000" },
  minimumOutput: { asset: route.destination, raw: "1000000" },
  userAddress: USER,
  recipientAddress: RECIPIENT,
  senderWalletId: "wallet_solana_native_12345678",
  quoteCorrelationId: "quote_solana_native_12345678",
  deadline: new Date(Date.now() + 60_000),
  maximumSlippageBps: 100,
});

assert.equal(requestBody.tradeType, "EXPECTED_OUTPUT");
assert.equal(requestBody.amount, "1010102");
assert.equal(requestBody.slippageTolerance, "100");
assert.equal(result.candidate.amountMode, "exact_output");
assert.equal(result.sourceAmount.raw, "14398334");
assert.equal(result.sourceEstimatedUsd, "1.063325");
assert.deepEqual(result.feeUsd, ["0.00355", "0.051897"]);
assert.equal(result.candidate.minimumOutput.raw, "1000000");
assert.equal(result.actions[0]?.kind, "svm_transaction");
if (result.actions[0]?.kind !== "svm_transaction") {
  throw new Error("native SOL action must be an SVM transaction");
}
assert.equal(result.actions[0].instructions.length, 8);
assert.equal(result.actions[0].addressLookupTables.length, 2);

async function assertQuoteRejected(
  mutated: ReturnType<typeof quoteFixture>,
  expected: RegExp,
): Promise<void> {
  const rejectingClient = new RelayClient({
    apiKey: "test-relay-key",
    fetchImpl: async () =>
      new Response(JSON.stringify(mutated), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    () =>
      new RelayWalletQuoteAdapter(rejectingClient).quote({
        route,
        source,
        destination,
        sourceAmount: { asset: route.source, raw: "20000000" },
        minimumOutput: { asset: route.destination, raw: "1000000" },
        userAddress: USER,
        recipientAddress: RECIPIENT,
        senderWalletId: "wallet_solana_native_12345678",
        quoteCorrelationId: "quote_solana_native_mutation_12345678",
        deadline: new Date(Date.now() + 60_000),
        maximumSlippageBps: 100,
      }),
    expected,
  );
}

{
  const mutated = quoteFixture();
  const transfer = mutated.steps[0]?.items[0]?.data.instructions[2];
  if (!transfer) throw new Error("transfer fixture missing");
  transfer.data = Buffer.alloc(12).toString("hex");
  await assertQuoteRejected(
    mutated,
    /native SOL transfer instruction mismatch/u,
  );
}

{
  const mutated = quoteFixture();
  mutated.details.currencyIn.amount = "20000001";
  mutated.details.currencyIn.minimumAmount = "20000001";
  await assertQuoteRejected(mutated, /authorized source cap/u);
}

{
  const mutated = quoteFixture();
  mutated.details.currencyOut.minimumAmount = "999999";
  await assertQuoteRejected(mutated, /authorized floor/u);
}

{
  const mutated = quoteFixture();
  const swap = mutated.steps[0]?.items[0]?.data.instructions[4];
  if (!swap) throw new Error("Jupiter fixture missing");
  const data = Buffer.from(swap.data, "hex");
  data.writeBigUInt64LE(1n, data.byteLength - 19);
  swap.data = data.toString("hex");
  await assertQuoteRejected(mutated, /Jupiter swap economics mismatch/u);
}

{
  const mutated = quoteFixture();
  const deposit = mutated.steps[0]?.items[0]?.data.instructions[6];
  if (!deposit) throw new Error("Relay deposit fixture missing");
  deposit.data = `${deposit.data.slice(0, -2)}ff`;
  await assertQuoteRejected(mutated, /Relay deposit order binding mismatch/u);
}

{
  const mutated = quoteFixture();
  const deposit = mutated.steps[0]?.items[0]?.data.instructions[6];
  if (!deposit) throw new Error("Relay deposit fixture missing");
  const routerAccount = deposit.keys[3];
  if (!routerAccount) throw new Error("Relay router account missing");
  routerAccount.pubkey = RELAY_SOLANA_DEPOSITORY;
  await assertQuoteRejected(mutated, /Relay deposit\[3\] account mismatch/u);
}

console.log(
  "[solana-native-validator-tests] expected-output quote, source cap, fee USD, and pinned SVM action passed",
);
