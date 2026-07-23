import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import { POLYGON_PUSD, RELAY_SOLVER, SOLANA_USDC } from "./rehearsal.js";
import {
  POLYGON_USDCE,
  RELAY_SOLANA_DEPOSITORY,
  SOLANA_SYSTEM_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SPL_TOKEN_PROGRAM,
  validateRelaySolanaRehearsalQuote,
} from "./solana-rehearsal.js";

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

console.log(
  "[relay-solana-rehearsal] program, signer, ATA, protocol/refund binding, correlation, and negative mutations ok",
);
