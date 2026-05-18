#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  buildEmbeddedPolymarketConnectPayload,
  buildEmbeddedPolymarketConnectRequest,
  buildEmbeddedPolymarketTypedDataRequest,
  type EmbeddedPolymarketTypedData,
  type EmbeddedPolymarketWalletContext,
} from "./services/polymarket-embedded.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const walletContext: EmbeddedPolymarketWalletContext = {
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

const tokenInterface = new Interface([
  "function transfer(address to,uint256 value) returns (bool)",
]);

function buildDepositWalletBatchTypedData(
  call: Record<string, unknown>,
): EmbeddedPolymarketTypedData {
  const depositWallet = "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A";
  return {
    primaryType: "Batch",
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: 137,
      verifyingContract: depositWallet,
    },
    types: {
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      Batch: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "calls", type: "Call[]" },
      ],
    },
    message: {
      wallet: depositWallet,
      nonce: "2",
      deadline: "1779124339",
      calls: [call],
    },
  };
}

const tests: TestCase[] = [
  {
    name: "embedded polymarket connect payload uses auth domain without verifyingContract",
    run: () => {
      const payload = buildEmbeddedPolymarketConnectPayload({
        signer: walletContext.signer,
        timestamp: "1775078598",
        nonce: 735473520,
      });

      assert.deepEqual(payload.domain, {
        name: "ClobAuthDomain",
        version: "1",
        chainId: 137,
      });
      assert.deepEqual(payload.types.EIP712Domain, [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ]);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          payload.domain,
          "verifyingContract",
        ),
        false,
      );
    },
  },
  {
    name: "embedded polymarket connect request keeps auth domain shape in Privy RPC body",
    run: () => {
      const request = buildEmbeddedPolymarketConnectRequest({
        context: walletContext,
        timestamp: "1775078598",
        nonce: 735473520,
      });

      const body = request.input.body as {
        method: string;
        params: {
          typed_data: {
            domain: Record<string, unknown>;
            types: { EIP712Domain: Array<Record<string, unknown>> };
          };
        };
      };

      assert.equal(body.method, "eth_signTypedData_v4");
      assert.deepEqual(body.params.typed_data.domain, {
        name: "ClobAuthDomain",
        version: "1",
        chainId: 137,
      });
      assert.deepEqual(body.params.typed_data.types.EIP712Domain, [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ]);
    },
  },
  {
    name: "embedded deposit wallet batch allows supported ERC20 transfer calls",
    run: () => {
      for (const token of [
        "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      ]) {
        const request = buildEmbeddedPolymarketTypedDataRequest({
          context: walletContext,
          id: "polymarket-deposit-wallet-batch",
          label: "Polymarket deposit wallet transaction batch",
          typedData: buildDepositWalletBatchTypedData({
            target: token,
            value: "0",
            data: tokenInterface.encodeFunctionData("transfer", [
              "0x709b6aa591a26acd1ea6181192043f50c796d8d9",
              1_103_536n,
            ]),
          }),
        });

        assert.equal(request.id, "polymarket-deposit-wallet-batch");
      }
    },
  },
  {
    name: "embedded deposit wallet batch rejects unsupported ERC20 transfer calls",
    run: () => {
      assert.throws(
        () =>
          buildEmbeddedPolymarketTypedDataRequest({
            context: walletContext,
            typedData: buildDepositWalletBatchTypedData({
              target: "0x0000000000000000000000000000000000000001",
              value: "0",
              data: tokenInterface.encodeFunctionData("transfer", [
                "0x709b6aa591a26acd1ea6181192043f50c796d8d9",
                1_103_536n,
              ]),
            }),
          }),
        /Unsupported deposit wallet ERC20 transfer call/,
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[polymarket-embedded-tests] passed ${passed}/${tests.length}`);
