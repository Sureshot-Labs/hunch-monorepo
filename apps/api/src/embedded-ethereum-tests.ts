#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { ethers } from "ethers";

import { env } from "./env.js";
import {
  assertEmbeddedEvmSponsorshipAllowed,
  buildEmbeddedEvmTransactionFingerprint,
  embeddedEvmSponsorshipTestHooks,
  type EmbeddedEvmSponsorshipDependencies,
} from "./services/embedded-evm-sponsorship.js";
import {
  buildEmbeddedEthereumSendTransactionRequest,
  prepareEmbeddedEthereumTransactionRequests,
  resolvePrivyTransactionHash,
  transactionHashFromUserOperationReceipt,
  type EmbeddedEthereumWalletContext,
} from "./services/embedded-ethereum.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const walletContext: EmbeddedEthereumWalletContext = {
  signer: "0x8548ed775a5F596F534815aEb8eDb92a8F3760e1",
  walletId: "wallet-id",
  walletProfile: {
    walletId: "wallet-id",
    address: "0x8548ed775a5F596F534815aEb8eDb92a8F3760e1",
    walletType: "ethereum",
    source: "embedded",
    isInternalWallet: true,
  },
};

const denyDynamicDependencies: EmbeddedEvmSponsorshipDependencies = {
  isAuthorizedDestination: async () => false,
  isKnownLimitlessMarket: async () => false,
  isSupportedBridgeToken: async () => false,
  matchesBridgeOrder: async () => false,
  matchesFundingAction: async () => false,
};

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

const tests: TestCase[] = [
  {
    name: "embedded ethereum transaction request uses sponsored Privy RPC payload",
    run: () => {
      const request = buildEmbeddedEthereumSendTransactionRequest({
        context: walletContext,
        chainId: 8453,
        transaction: {
          id: "limitless-redemption",
          label: "Limitless redemption",
          to: "0x1111111111111111111111111111111111111111",
          data: "0xabcdef12",
          value: "1000000",
          gas: "21000",
        },
      });

      const body = request.input.body as {
        method: string;
        caip2: string;
        sponsor: boolean;
        params: {
          transaction: {
            from: string;
            to: string;
            data: string;
            value?: string;
            gas_limit?: string;
          };
        };
      };

      assert.equal(request.id, "limitless-redemption");
      assert.equal(body.method, "eth_sendTransaction");
      assert.equal(body.caip2, "eip155:8453");
      assert.equal(body.sponsor, true);
      assert.equal(
        body.params.transaction.from,
        "0x8548ed775a5F596F534815aEb8eDb92a8F3760e1",
      );
      assert.equal(
        body.params.transaction.to,
        "0x1111111111111111111111111111111111111111",
      );
      assert.equal(body.params.transaction.data, "0xabcdef12");
      assert.equal(body.params.transaction.value, "0xf4240");
      assert.equal(body.params.transaction.gas_limit, "0x5208");
    },
  },
  {
    name: "ERC-4337 receipt resolves the onchain transaction hash",
    run: () => {
      const transactionHash = `0x${"ab".repeat(32)}`;
      assert.equal(
        transactionHashFromUserOperationReceipt({
          userOpHash: `0x${"cd".repeat(32)}`,
          success: true,
          receipt: { transactionHash },
        }),
        transactionHash,
      );
      assert.equal(
        transactionHashFromUserOperationReceipt({
          success: true,
          receipt: { transactionHash: "0x1234" },
        }),
        null,
      );
      assert.equal(transactionHashFromUserOperationReceipt(null), null);
    },
  },
  {
    name: "prepare embedded ethereum transaction requests preserves ids and order",
    run: () => {
      const requests = prepareEmbeddedEthereumTransactionRequests({
        context: walletContext,
        chainId: 137,
        transactions: [
          {
            id: "approval-1",
            label: "Approval one",
            to: "0x1111111111111111111111111111111111111111",
            data: "0x01",
          },
          {
            id: "approval-2",
            label: "Approval two",
            to: "0x2222222222222222222222222222222222222222",
            data: "0x02",
            sponsor: false,
          },
        ],
      });

      assert.deepEqual(
        requests.map((entry) => entry.id),
        ["approval-1", "approval-2"],
      );
      const secondBody = requests[1]?.input.body as {
        sponsor?: boolean;
        caip2?: string;
      };
      assert.equal(secondBody.caip2, "eip155:137");
      assert.equal(secondBody.sponsor, false);
    },
  },
  {
    name: "atomic embedded ethereum execution prepares one wallet_sendCalls request",
    run: () => {
      const requests = prepareEmbeddedEthereumTransactionRequests({
        context: walletContext,
        chainId: 137,
        executionMode: "atomic",
        transactions: [
          {
            id: "approve",
            label: "Approve",
            to: "0x1111111111111111111111111111111111111111",
            data: "0x01",
          },
          {
            id: "relay",
            label: "Relay",
            to: "0x2222222222222222222222222222222222222222",
            data: "0x02",
            value: "7",
          },
        ],
      });

      assert.equal(requests.length, 1);
      const body = requests[0]?.input.body as {
        method: string;
        caip2: string;
        sponsor: boolean;
        params: {
          calls: Array<{ to: string; data: string; value?: string }>;
        };
      };
      assert.equal(body.method, "wallet_sendCalls");
      assert.equal(body.caip2, "eip155:137");
      assert.equal(body.sponsor, true);
      assert.deepEqual(body.params.calls, [
        {
          to: "0x1111111111111111111111111111111111111111",
          data: "0x01",
        },
        {
          to: "0x2222222222222222222222222222222222222222",
          data: "0x02",
          value: "0x7",
        },
      ]);
    },
  },
  {
    name: "sponsorship rejects an arbitrary client-selected contract call",
    run: async () => {
      await assert.rejects(
        () =>
          assertEmbeddedEvmSponsorshipAllowed({
            userId: TEST_USER_ID,
            signer: walletContext.signer,
            chainId: 8453,
            transactions: [
              {
                id: "arbitrary-call",
                label: "Arbitrary call",
                to: "0x1111111111111111111111111111111111111111",
                data: "0xabcdef12",
              },
            ],
            dependencies: denyDynamicDependencies,
          }),
        /not an allowed Hunch operation/,
      );
    },
  },
  {
    name: "explicitly self-paid transactions keep the backwards-compatible generic path",
    run: async () => {
      await assert.doesNotReject(() =>
        assertEmbeddedEvmSponsorshipAllowed({
          userId: TEST_USER_ID,
          signer: walletContext.signer,
          chainId: 8453,
          transactions: [
            {
              id: "self-paid-call",
              label: "Self-paid call",
              to: "0x1111111111111111111111111111111111111111",
              data: "0xabcdef12",
              sponsor: false,
            },
          ],
          dependencies: denyDynamicDependencies,
        }),
      );
    },
  },
  {
    name: "Polymarket wrap is sponsored only for the canonical contract and an authorized recipient",
    run: async () => {
      const recipient = walletContext.signer;
      const wrap = new ethers.Interface([
        "function wrap(address asset,address recipient,uint256 amount)",
      ]).encodeFunctionData("wrap", [
        env.polymarketUsdceAddress,
        recipient,
        1_000_000n,
      ]);
      const dependencies: EmbeddedEvmSponsorshipDependencies = {
        ...denyDynamicDependencies,
        isAuthorizedDestination: async (address) =>
          address.toLowerCase() === recipient.toLowerCase(),
      };

      await assert.doesNotReject(() =>
        assertEmbeddedEvmSponsorshipAllowed({
          userId: TEST_USER_ID,
          signer: walletContext.signer,
          chainId: 137,
          transactions: [
            {
              id: "polymarket-wrap",
              label: "Wrap pUSD",
              to: env.polymarketCollateralOnrampAddress,
              data: wrap,
            },
          ],
          dependencies,
        }),
      );
      await assert.rejects(
        () =>
          assertEmbeddedEvmSponsorshipAllowed({
            userId: TEST_USER_ID,
            signer: walletContext.signer,
            chainId: 137,
            transactions: [
              {
                id: "polymarket-wrap-wrong-recipient",
                label: "Wrap pUSD",
                to: env.polymarketCollateralOnrampAddress,
                data: new ethers.Interface([
                  "function wrap(address asset,address recipient,uint256 amount)",
                ]).encodeFunctionData("wrap", [
                  env.polymarketUsdceAddress,
                  "0x2222222222222222222222222222222222222222",
                  1_000_000n,
                ]),
              },
            ],
            dependencies,
          }),
        /not an allowed Hunch operation/,
      );
    },
  },
  {
    name: "Limitless AMM call requires a Hunch-known market address",
    run: async () => {
      const market = "0x3333333333333333333333333333333333333333";
      const data = new ethers.Interface([
        "function buy(uint256 investmentAmount,uint256 outcomeIndex,uint256 minOutcomeTokens)",
      ]).encodeFunctionData("buy", [1_000_000n, 0n, 900_000n]);
      const allowedDependencies: EmbeddedEvmSponsorshipDependencies = {
        ...denyDynamicDependencies,
        isKnownLimitlessMarket: async (address) =>
          address.toLowerCase() === market.toLowerCase(),
      };

      await assert.doesNotReject(() =>
        assertEmbeddedEvmSponsorshipAllowed({
          userId: TEST_USER_ID,
          signer: walletContext.signer,
          chainId: 8453,
          transactions: [
            {
              id: "limitless-buy",
              label: "Limitless buy",
              to: market,
              data,
            },
          ],
          dependencies: allowedDependencies,
        }),
      );
      await assert.rejects(
        () =>
          assertEmbeddedEvmSponsorshipAllowed({
            userId: TEST_USER_ID,
            signer: walletContext.signer,
            chainId: 8453,
            transactions: [
              {
                id: "limitless-buy-unknown-market",
                label: "Limitless buy",
                to: "0x4444444444444444444444444444444444444444",
                data,
              },
            ],
            dependencies: allowedDependencies,
          }),
        /not an allowed Hunch operation/,
      );
    },
  },
  {
    name: "server-frozen funding and bridge transactions pass without widening protocol allowlists",
    run: async () => {
      for (const dependency of [
        "matchesFundingAction",
        "matchesBridgeOrder",
      ] as const) {
        await assert.doesNotReject(() =>
          assertEmbeddedEvmSponsorshipAllowed({
            userId: TEST_USER_ID,
            signer: walletContext.signer,
            chainId: 42161,
            transactions: [
              {
                id: `exact-${dependency}`,
                label: "Exact server transaction",
                to: "0x5555555555555555555555555555555555555555",
                data: "0xabcdef12",
              },
            ],
            dependencies: {
              ...denyDynamicDependencies,
              [dependency]: async () => true,
            },
          }),
        );
      }
    },
  },
  {
    name: "server-frozen EVM batch children match only their exact sponsored call",
    run: () => {
      const action = {
        kind: "evm_transaction_batch",
        actionId: "batch-relay",
        networkId: "evm:137",
        senderWalletId: "wallet-1",
        calls: [
          {
            actionId: "relay:quote:approve",
            to: "0x5555555555555555555555555555555555555555",
            data: "0xabcdef12",
            valueRaw: "0",
          },
          {
            actionId: "relay:quote",
            to: "0x6666666666666666666666666666666666666666",
            data: "0xabcdef34",
            valueRaw: "7",
          },
        ],
      };
      const input = {
        userId: TEST_USER_ID,
        signer: walletContext.signer,
        chainId: 137,
        transaction: {
          id: "relay:quote:approve",
          label: "Relay approval",
          to: "0x5555555555555555555555555555555555555555",
          data: "0xabcdef12",
          value: "0",
        },
      };

      assert.equal(
        embeddedEvmSponsorshipTestHooks.fundingActionMatchesTransaction(
          action,
          input,
        ),
        true,
      );
      assert.equal(
        embeddedEvmSponsorshipTestHooks.fundingActionMatchesTransaction(
          action,
          {
            ...input,
            transaction: { ...input.transaction, data: "0xabcdef13" },
          },
        ),
        false,
      );
      assert.equal(
        embeddedEvmSponsorshipTestHooks.fundingActionMatchesTransaction(
          action,
          {
            ...input,
            transaction: { ...input.transaction, gas: "21000" },
          },
        ),
        false,
      );
      assert.equal(
        embeddedEvmSponsorshipTestHooks.fundingActionMatchesTransaction(
          action,
          {
            ...input,
            transaction: {
              ...input.transaction,
              id: "relay:quote:unknown",
            },
          },
        ),
        false,
      );
    },
  },
  {
    name: "bridge exact-match check binds calldata, value, gas, target, and chain",
    run: () => {
      const transaction = {
        id: "bridge-submit",
        label: "Bridge transaction",
        to: "0x6666666666666666666666666666666666666666",
        data: "0xabcdef12",
        value: "7",
        gas: "21000",
      };
      const payload = {
        chainId: 137,
        to: transaction.to,
        data: transaction.data,
        value: "7",
        gas: "21000",
      };
      assert.equal(
        embeddedEvmSponsorshipTestHooks.exactTransactionMatches(
          137,
          transaction,
          payload,
        ),
        true,
      );
      assert.equal(
        embeddedEvmSponsorshipTestHooks.exactTransactionMatches(
          137,
          transaction,
          { ...payload, data: "0xabcdef13" },
        ),
        false,
      );
    },
  },
  {
    name: "single-flight fingerprint cannot be bypassed by changing client ids or labels",
    run: () => {
      const base = {
        to: "0x7777777777777777777777777777777777777777",
        data: "0x095ea7b3",
      };
      const first = buildEmbeddedEvmTransactionFingerprint({
        signer: walletContext.signer,
        chainId: 137,
        transactions: [{ id: "one", label: "One", ...base }],
      });
      const second = buildEmbeddedEvmTransactionFingerprint({
        signer: walletContext.signer,
        chainId: 137,
        transactions: [{ id: "two", label: "Two", ...base }],
      });
      const changed = buildEmbeddedEvmTransactionFingerprint({
        signer: walletContext.signer,
        chainId: 137,
        transactions: [
          { id: "two", label: "Two", ...base, data: "0x095ea7b4" },
        ],
      });
      assert.equal(first, second);
      assert.notEqual(first, changed);
    },
  },
  {
    name: "invalid value and excessive gas fail before Privy authorization",
    run: async () => {
      await assert.rejects(
        () =>
          assertEmbeddedEvmSponsorshipAllowed({
            userId: TEST_USER_ID,
            signer: walletContext.signer,
            chainId: 137,
            transactions: [
              {
                id: "bad-value",
                label: "Bad value",
                to: env.polymarketPusdAddress,
                data: "0x",
                value: "not-a-number",
              },
            ],
            dependencies: denyDynamicDependencies,
          }),
        /value is invalid/,
      );
      await assert.rejects(
        () =>
          assertEmbeddedEvmSponsorshipAllowed({
            userId: TEST_USER_ID,
            signer: walletContext.signer,
            chainId: 137,
            transactions: [
              {
                id: "too-much-gas",
                label: "Too much gas",
                to: env.polymarketPusdAddress,
                data: "0x",
                gas: "5000001",
              },
            ],
            dependencies: denyDynamicDependencies,
          }),
        /gas limit is too high/,
      );
    },
  },
  {
    name: "Privy polling hands off to the chain receipt as soon as a hash exists",
    run: () => {
      assert.equal(
        resolvePrivyTransactionHash(
          {
            status: "pending",
            transactionHash: "0xabc",
            transactionId: "privy-transaction-id",
          },
          "Limitless buy",
        ),
        "0xabc",
      );
      assert.equal(
        resolvePrivyTransactionHash(
          {
            status: "pending",
            transactionHash: null,
            transactionId: "privy-transaction-id",
          },
          "Limitless buy",
        ),
        null,
      );
      assert.throws(
        () =>
          resolvePrivyTransactionHash(
            {
              status: "failed",
              transactionHash: null,
              transactionId: "privy-transaction-id",
            },
            "Limitless buy",
          ),
        /failed in Privy with status failed/,
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[embedded-ethereum-tests] passed ${passed}/${tests.length}`);
