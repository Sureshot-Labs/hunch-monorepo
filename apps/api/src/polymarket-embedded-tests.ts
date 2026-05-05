#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  buildEmbeddedPolymarketConnectPayload,
  buildEmbeddedPolymarketConnectRequest,
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
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[polymarket-embedded-tests] passed ${passed}/${tests.length}`);
