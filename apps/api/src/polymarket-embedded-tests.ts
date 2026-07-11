#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface } from "ethers";
import { env } from "./env.js";
import {
  buildEmbeddedPolymarketConnectPayload,
  buildEmbeddedPolymarketConnectRequest,
  buildEmbeddedPolymarketTypedDataRequest,
  prepareEmbeddedPolymarketSignerApprovalRequests,
  prepareEmbeddedPolymarketSignerApprovalTransactions,
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
  "function approve(address spender,uint256 value) returns (bool)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function wrap(address _asset,address _to,uint256 _amount)",
  "function unwrap(address _asset,address _to,uint256 _amount)",
  "function setApprovalForAll(address operator,bool approved)",
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
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
    name: "embedded signer readiness builds approval requests when signer is funder",
    run: () => {
      const requests = prepareEmbeddedPolymarketSignerApprovalRequests({
        context: walletContext,
        funder: walletContext.signer,
        currentApprovals: {
          exchangeApproved: false,
          negRiskExchangeApproved: false,
          negRiskAdapterApproved: false,
          ctfCollateralAdapterApproved: false,
          negRiskCollateralAdapterApproved: false,
          feeCollectorApproved: false,
          exchangeAllowanceOk: false,
          negRiskExchangeAllowanceOk: false,
          negRiskAdapterAllowanceOk: false,
          feeCollectorAllowanceOk: false,
        },
      });

      assert.ok(requests.length >= 4);
      assert.equal(requests[0]?.id, "approval-0");
      assert.equal(requests[0]?.input.body["method"], "eth_sendTransaction");
      assert.ok(
        requests.every((request) => request.id.startsWith("approval-")),
      );
      const transactions = prepareEmbeddedPolymarketSignerApprovalTransactions({
        signer: walletContext.signer,
        funder: walletContext.signer,
        currentApprovals: {
          exchangeApproved: false,
          negRiskExchangeApproved: false,
          negRiskAdapterApproved: false,
          ctfCollateralAdapterApproved: false,
          negRiskCollateralAdapterApproved: false,
          feeCollectorApproved: false,
          exchangeAllowanceOk: false,
          negRiskExchangeAllowanceOk: false,
          negRiskAdapterAllowanceOk: false,
          feeCollectorAllowanceOk: false,
        },
      });
      assert.equal(transactions.length, requests.length);
      const methodNames = transactions.map(
        (transaction) =>
          tokenInterface.parseTransaction({ data: transaction.data })?.name,
      );
      assert.ok(methodNames.includes("approve"));
      assert.ok(methodNames.includes("setApprovalForAll"));
      for (const [index, transaction] of transactions.entries()) {
        const requestTransaction = (
          requests[index]?.input.body.params as {
            transaction: { data: string; to: string };
          }
        ).transaction;
        assert.equal(requestTransaction.to, transaction.to);
        assert.equal(requestTransaction.data, transaction.data);
      }
    },
  },
  {
    name: "embedded signer readiness skips approval requests for distinct funder",
    run: () => {
      const requests = prepareEmbeddedPolymarketSignerApprovalRequests({
        context: walletContext,
        funder: "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A",
        currentApprovals: {
          exchangeApproved: false,
          negRiskExchangeApproved: false,
          negRiskAdapterApproved: false,
          ctfCollateralAdapterApproved: false,
          negRiskCollateralAdapterApproved: false,
          feeCollectorApproved: false,
          exchangeAllowanceOk: false,
          negRiskExchangeAllowanceOk: false,
          negRiskAdapterAllowanceOk: false,
          feeCollectorAllowanceOk: false,
        },
      });

      assert.deepEqual(requests, []);
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
              walletContext.signer,
              1_103_536n,
            ]),
          }),
        });

        assert.equal(request.id, "polymarket-deposit-wallet-batch");
      }
    },
  },
  {
    name: "embedded deposit wallet batch allows USDC.e funding-router approval",
    run: () => {
      const request = buildEmbeddedPolymarketTypedDataRequest({
        context: walletContext,
        typedData: buildDepositWalletBatchTypedData({
          target: env.polymarketUsdceAddress,
          value: "0",
          data: tokenInterface.encodeFunctionData("approve", [
            env.polymarketFundingRouterAddress,
            (BigInt(1) << BigInt(256)) - BigInt(1),
          ]),
        }),
      });
      assert.equal(request.id, "polymarket-typed-data-signature");
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
                walletContext.signer,
                1_103_536n,
              ]),
            }),
          }),
        /Unsupported deposit wallet ERC20 transfer call/,
      );
    },
  },
  {
    name: "embedded deposit wallet batch rejects transfer to non-signer",
    run: () => {
      assert.throws(
        () =>
          buildEmbeddedPolymarketTypedDataRequest({
            context: walletContext,
            typedData: buildDepositWalletBatchTypedData({
              target: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
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
  {
    name: "embedded deposit wallet withdraw batch allows transfer to arbitrary Polygon address",
    run: () => {
      const request = buildEmbeddedPolymarketTypedDataRequest({
        context: walletContext,
        depositWalletBatchPurpose: "withdraw",
        typedData: buildDepositWalletBatchTypedData({
          target: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
          value: "0",
          data: tokenInterface.encodeFunctionData("transfer", [
            "0x709b6aa591a26acd1ea6181192043f50c796d8d9",
            1_103_536n,
          ]),
        }),
      });

      assert.equal(request.id, "polymarket-typed-data-signature");
    },
  },
  {
    name: "embedded deposit wallet withdraw batch allows pUSD unwrap approval",
    run: () => {
      const offramp = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
      const request = buildEmbeddedPolymarketTypedDataRequest({
        context: walletContext,
        depositWalletBatchPurpose: "withdraw",
        typedData: buildDepositWalletBatchTypedData({
          target: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
          value: "0",
          data: tokenInterface.encodeFunctionData("approve", [
            offramp,
            1_103_536n,
          ]),
        }),
      });

      assert.equal(request.id, "polymarket-typed-data-signature");
    },
  },
  {
    name: "embedded deposit wallet withdraw batch allows pUSD unwrap call",
    run: () => {
      const offramp = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
      const usdce = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      const depositWallet = "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A";
      const request = buildEmbeddedPolymarketTypedDataRequest({
        context: walletContext,
        depositWalletBatchPurpose: "withdraw",
        typedData: buildDepositWalletBatchTypedData({
          target: offramp,
          value: "0",
          data: tokenInterface.encodeFunctionData("unwrap", [
            usdce,
            depositWallet,
            1_103_536n,
          ]),
        }),
      });

      assert.equal(request.id, "polymarket-typed-data-signature");
    },
  },
  {
    name: "embedded deposit wallet withdraw batch rejects approvals",
    run: () => {
      assert.throws(
        () =>
          buildEmbeddedPolymarketTypedDataRequest({
            context: walletContext,
            depositWalletBatchPurpose: "withdraw",
            typedData: buildDepositWalletBatchTypedData({
              target: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
              value: "0",
              data: tokenInterface.encodeFunctionData("approve", [
                "0xe2222d279d744050d28e00520010520000310F59",
                1_103_536n,
              ]),
            }),
          }),
        /Unsupported deposit wallet pUSD unwrap approval/,
      );
    },
  },
  {
    name: "embedded deposit wallet withdraw batch rejects wraps",
    run: () => {
      const onramp = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
      const usdce = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      const depositWallet = "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A";
      assert.throws(
        () =>
          buildEmbeddedPolymarketTypedDataRequest({
            context: walletContext,
            depositWalletBatchPurpose: "withdraw",
            typedData: buildDepositWalletBatchTypedData({
              target: onramp,
              value: "0",
              data: tokenInterface.encodeFunctionData("wrap", [
                usdce,
                depositWallet,
                1_103_536n,
              ]),
            }),
          }),
        /withdraw batches only support transfer and pUSD unwrap calls/,
      );
    },
  },
  {
    name: "embedded deposit wallet batch allows USDC.e wrap calls",
    run: () => {
      const onramp = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
      const usdce = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      const depositWallet = "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A";
      for (const call of [
        {
          target: usdce,
          value: "0",
          data: tokenInterface.encodeFunctionData("approve", [
            onramp,
            1_103_536n,
          ]),
        },
        {
          target: onramp,
          value: "0",
          data: tokenInterface.encodeFunctionData("wrap", [
            usdce,
            depositWallet,
            1_103_536n,
          ]),
        },
      ]) {
        const request = buildEmbeddedPolymarketTypedDataRequest({
          context: walletContext,
          typedData: buildDepositWalletBatchTypedData(call),
        });

        assert.equal(request.id, "polymarket-typed-data-signature");
      }
    },
  },
  {
    name: "embedded deposit wallet batch rejects wrap to non-wallet",
    run: () => {
      const onramp = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
      const usdce = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      assert.throws(
        () =>
          buildEmbeddedPolymarketTypedDataRequest({
            context: walletContext,
            typedData: buildDepositWalletBatchTypedData({
              target: onramp,
              value: "0",
              data: tokenInterface.encodeFunctionData("wrap", [
                usdce,
                walletContext.signer,
                1_103_536n,
              ]),
            }),
          }),
        /Unsupported deposit wallet pUSD wrap call/,
      );
    },
  },
  {
    name: "embedded deposit wallet batch rejects native USDC wrap calls",
    run: () => {
      const onramp = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
      const nativeUsdc = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
      const depositWallet = "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A";
      assert.throws(
        () =>
          buildEmbeddedPolymarketTypedDataRequest({
            context: walletContext,
            typedData: buildDepositWalletBatchTypedData({
              target: onramp,
              value: "0",
              data: tokenInterface.encodeFunctionData("wrap", [
                nativeUsdc,
                depositWallet,
                1_103_536n,
              ]),
            }),
          }),
        /Unsupported deposit wallet pUSD wrap call/,
      );
    },
  },
  {
    name: "embedded deposit wallet redeem batch allows direct and adapter redemption calls",
    run: () => {
      const pusd = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
      const conditionId =
        "0x1111111111111111111111111111111111111111111111111111111111111111";
      const zeroParent =
        "0x0000000000000000000000000000000000000000000000000000000000000000";
      const standardRedeemData = tokenInterface.encodeFunctionData(
        "redeemPositions(address,bytes32,bytes32,uint256[])",
        [pusd, zeroParent, conditionId, [1n]],
      );
      const legacyNegRiskRedeemData = tokenInterface.encodeFunctionData(
        "redeemPositions(bytes32,uint256[])",
        [conditionId, [1n, 0n]],
      );
      for (const call of [
        {
          target: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
          data: standardRedeemData,
        },
        {
          target: "0xAdA100Db00Ca00073811820692005400218FcE1f",
          data: standardRedeemData,
        },
        {
          target: "0xadA2005600Dec949baf300f4C6120000bDB6eAab",
          data: standardRedeemData,
        },
        {
          target: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
          data: legacyNegRiskRedeemData,
        },
      ]) {
        const request = buildEmbeddedPolymarketTypedDataRequest({
          context: walletContext,
          depositWalletBatchPurpose: "redeem",
          typedData: buildDepositWalletBatchTypedData({
            target: call.target,
            value: "0",
            data: call.data,
          }),
        });

        assert.equal(request.id, "polymarket-typed-data-signature");
      }
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[polymarket-embedded-tests] passed ${passed}/${tests.length}`);
