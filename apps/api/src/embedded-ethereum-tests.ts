#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildEmbeddedEthereumSendTransactionRequest,
  prepareEmbeddedEthereumTransactionRequests,
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
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[embedded-ethereum-tests] passed ${passed}/${tests.length}`);
