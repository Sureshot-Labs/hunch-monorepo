#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import {
  fetchErc20TransferLogs,
  fetchEvmBlockNumber,
  parseEvmGetLogsBlockRangeLimit,
} from "./services/polygon-rpc.js";
import { walletIntelRetryConfig } from "./services/wallet-intel-retry.js";
import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import type { PrivyPolicyMetadata } from "./privy-service.js";
import {
  findTradeMarketById,
  findTradeMarketByRef,
  isKalshiMarketMintContextValid,
  loadMarketForVenue,
  type ApiTradeMarket,
} from "./services/api-trading-market-repo.js";
import { executePreparedTradeLifecycle } from "./services/api-trading-utils.js";
import {
  inspectServerEvmWalletAuthorization,
  signEvmMessage,
  signPolymarketRedemptionBatch,
  validatePolymarketBotPolicy,
  validatePolymarketBotPolicyProfile,
  validatePolymarketBotRedeemPolicy,
  validatePolymarketBotSellPolicy,
  validatePolymarketBotTypedData,
  resolvePrivyBotPolicyProfile,
  type PrivyServerSignerConfiguration,
  type PrivySignerInspectorDependencies,
} from "./services/api-trading-wallet-signing.js";
import {
  buildDepositWalletBatchTypedData,
  buildDepositWalletSubmitBody,
  POLYMARKET_DEPOSIT_WALLET_BATCH_TYPES,
  POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS,
  validateCanonicalRedemptionBatch,
} from "./services/polymarket-deposit-wallet-relayer.js";
import { sumErc20TransfersTo } from "./funding/execution/evm-erc20-receipt.js";
import { knownPrivyPolicyFingerprint } from "./funding/execution/known-privy-wallet-signers.js";
import { validateCombinedPolymarketRelayPolicy } from "./funding/execution/combined-privy-policy.js";
import {
  BASE_USDC,
  RELAY_DEPOSITORY_V2,
  RELAY_SELF_DEPOSITOR,
} from "./funding-providers/relay/rehearsal.js";
import { FundingPersistenceError } from "./funding/persistence/funding-operation-repository.js";
import { FundingTradeAttemptError } from "./funding/persistence/funding-trade-attempt-repository.js";
import { kalshiTradingExecutionTestHooks } from "./services/kalshi-trading-execution-service.js";
import { toPublicFundingTradeError } from "./services/funding-trade-public-errors.js";
import {
  isLimitlessBotClobExecutable,
  limitlessTradingExecutionTestHooks,
} from "./services/limitless-trading-execution-service.js";
import { fetchLimitlessAmmQuote } from "./services/limitless-onchain.js";
import { polymarketTradingExecutionTestHooks } from "./services/polymarket-trading-execution-service.js";
import {
  computePolymarketClobOpenPositionLocks,
  polymarketPositionLockKey,
} from "./services/polymarket-max-spend.js";
import {
  POLYMARKET_AUTH_MESSAGE,
  POLYMARKET_AUTH_TYPES,
  POLYMARKET_ORDER_TYPES,
  POLYMARKET_TYPED_DATA_SIGN_TYPES,
} from "./services/polymarket-signing-schema.js";
import { POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW } from "./services/polymarket-automation-policy.js";
import type { PreparedTrade, SubmitResult } from "./services/trading-types.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const testRetryConfig = walletIntelRetryConfig as {
  baseBackoffMs: number;
  maxAttempts: number;
  maxBackoffMs: number;
};

const apiSrcDir = dirname(fileURLToPath(import.meta.url));

const policyExchangeAddresses = [
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
] as const;
const policyFundingRouterAddress = "0x0000000000000000000000000000000000000003";
const policyPusdAddress = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const policyUsdceAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const policyFundingMaxRaw = 2_200_000n;
const policyBuilderCode = `0x${"11".repeat(32)}`;
const policyFundingAbi = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "expectedNonce", type: "uint256" },
      { name: "totalAmount", type: "uint256" },
      { name: "pUsdAmount", type: "uint256" },
    ],
    outputs: [],
  },
];

const policyFundingRouterApprovalAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

function fundingRouterControllerApprovalRule(
  tokenAddress = policyPusdAddress,
  tokenLabel = "pUSD",
): PrivyPolicyMetadata["rules"][number] {
  return {
    action: "ALLOW",
    conditions: [
      {
        field: "chain_id",
        field_source: "ethereum_transaction",
        operator: "eq",
        value: "137",
      },
      {
        field: "to",
        field_source: "ethereum_transaction",
        operator: "eq",
        value: tokenAddress,
      },
      {
        field: "value",
        field_source: "ethereum_transaction",
        operator: "eq",
        value: "0x0",
      },
      {
        abi: policyFundingRouterApprovalAbi,
        field: "function_name",
        field_source: "ethereum_calldata",
        operator: "eq",
        value: "approve",
      },
      {
        abi: policyFundingRouterApprovalAbi,
        field: "approve.spender",
        field_source: "ethereum_calldata",
        operator: "eq",
        value: policyFundingRouterAddress,
      },
      {
        abi: policyFundingRouterApprovalAbi,
        field: "approve.amount",
        field_source: "ethereum_calldata",
        operator: "eq",
        value: POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW.toString(),
      },
    ],
    id: `funding-router-controller-${tokenLabel.toLowerCase()}-approval`,
    method: "eth_sendTransaction",
    name: `Funding Router controller ${tokenLabel} approval`,
  };
}
const policyRedemptionAdapterAddresses = [
  "0x0000000000000000000000000000000000000004",
  "0x0000000000000000000000000000000000000005",
] as const;

function typedMessageCondition(input: {
  field: string;
  operator: "eq" | "lte";
  primaryType: "ClobAuth" | "Order" | "TypedDataSign";
  value: string;
}) {
  return {
    field: input.field,
    field_source: "ethereum_typed_data_message",
    operator: input.operator,
    typed_data: {
      primary_type: input.primaryType,
      types:
        input.primaryType === "ClobAuth"
          ? POLYMARKET_AUTH_TYPES
          : input.primaryType === "Order"
            ? POLYMARKET_ORDER_TYPES
            : POLYMARKET_TYPED_DATA_SIGN_TYPES,
    },
    value: input.value,
  };
}

function buildValidPolymarketBotPolicy(): PrivyPolicyMetadata {
  const chainCondition = {
    field: "chain_id",
    field_source: "ethereum_typed_data_domain",
    operator: "eq",
    value: "137",
  };
  const exchangeCondition = {
    field: "verifying_contract",
    field_source: "ethereum_typed_data_domain",
    operator: "in",
    value: [...policyExchangeAddresses],
  };
  const orderConditions = (
    primaryType: "Order" | "TypedDataSign",
    prefix: "" | "contents.",
    signatureType: "2" | "3",
  ) => [
    chainCondition,
    exchangeCondition,
    typedMessageCondition({
      field: `${prefix}side`,
      operator: "eq",
      primaryType,
      value: "0",
    }),
    typedMessageCondition({
      field: `${prefix}signatureType`,
      operator: "eq",
      primaryType,
      value: signatureType,
    }),
    typedMessageCondition({
      field: `${prefix}makerAmount`,
      operator: "lte",
      primaryType,
      value: "2000000",
    }),
  ];
  return {
    chainType: "ethereum",
    id: "policy-1",
    rules: [
      {
        action: "ALLOW",
        conditions: [
          chainCondition,
          typedMessageCondition({
            field: "message",
            operator: "eq",
            primaryType: "ClobAuth",
            value: POLYMARKET_AUTH_MESSAGE,
          }),
        ],
        id: "clob-auth",
        method: "eth_signTypedData_v4",
        name: "ClobAuth",
      },
      {
        action: "ALLOW",
        conditions: orderConditions("Order", "", "2"),
        id: "direct-order",
        method: "eth_signTypedData_v4",
        name: "Direct order",
      },
      {
        action: "ALLOW",
        conditions: orderConditions("TypedDataSign", "contents.", "3"),
        id: "deposit-order",
        method: "eth_signTypedData_v4",
        name: "Deposit wallet order",
      },
      {
        action: "ALLOW",
        conditions: [
          {
            field: "chain_id",
            field_source: "ethereum_transaction",
            operator: "eq",
            value: "137",
          },
          {
            field: "to",
            field_source: "ethereum_transaction",
            operator: "eq",
            value: policyFundingRouterAddress,
          },
          {
            field: "value",
            field_source: "ethereum_transaction",
            operator: "eq",
            value: "0x0",
          },
          {
            abi: policyFundingAbi,
            field: "function_name",
            field_source: "ethereum_calldata",
            operator: "eq",
            value: "fund",
          },
          {
            abi: policyFundingAbi,
            field: "fund.totalAmount",
            field_source: "ethereum_calldata",
            operator: "lte",
            value: "2200000",
          },
        ],
        id: "funding-router",
        method: "eth_sendTransaction",
        name: "Funding router",
      },
    ],
  };
}

function buildValidPolymarketSellPolicy(): PrivyPolicyMetadata {
  return {
    chainType: "ethereum",
    id: "sell-policy",
    rules: [
      {
        action: "ALLOW",
        conditions: [
          {
            field: "chain_id",
            field_source: "ethereum_typed_data_domain",
            operator: "eq",
            value: "137",
          },
          typedMessageCondition({
            field: "message",
            operator: "eq",
            primaryType: "ClobAuth",
            value: POLYMARKET_AUTH_MESSAGE,
          }),
        ],
        id: "sell-clob-auth",
        method: "eth_signTypedData_v4",
        name: "SELL ClobAuth",
      },
      {
        action: "ALLOW",
        conditions: [
          {
            field: "chain_id",
            field_source: "ethereum_typed_data_domain",
            operator: "eq",
            value: "137",
          },
          {
            field: "verifying_contract",
            field_source: "ethereum_typed_data_domain",
            operator: "in",
            value: [...policyExchangeAddresses],
          },
          typedMessageCondition({
            field: "contents.side",
            operator: "eq",
            primaryType: "TypedDataSign",
            value: "1",
          }),
          typedMessageCondition({
            field: "contents.signatureType",
            operator: "eq",
            primaryType: "TypedDataSign",
            value: "3",
          }),
          typedMessageCondition({
            field: "contents.builder",
            operator: "eq",
            primaryType: "TypedDataSign",
            value: policyBuilderCode,
          }),
        ],
        id: "deposit-sell",
        method: "eth_signTypedData_v4",
        name: "Deposit wallet SELL",
      },
    ],
  };
}

function buildValidPolymarketBuySellPolicy(): PrivyPolicyMetadata {
  const buy = buildValidPolymarketBotPolicy();
  const sell = buildValidPolymarketSellPolicy();
  return {
    ...buy,
    id: "buy-sell-policy",
    rules: [
      ...buy.rules,
      fundingRouterControllerApprovalRule(),
      fundingRouterControllerApprovalRule(policyUsdceAddress, "USDC.e"),
      structuredClone(sell.rules[1] as never),
      {
        action: "ALLOW",
        conditions: [
          {
            field: "chain_id",
            field_source: "ethereum_transaction",
            operator: "eq",
            value: "137",
          },
          {
            field: "to",
            field_source: "ethereum_transaction",
            operator: "eq",
            value: policyFundingRouterAddress,
          },
          {
            field: "value",
            field_source: "ethereum_transaction",
            operator: "eq",
            value: "0x0",
          },
          {
            abi: policyFundingAbi,
            field: "function_name",
            field_source: "ethereum_calldata",
            operator: "eq",
            value: "fund",
          },
          {
            abi: policyFundingAbi,
            field: "fund.pUsdAmount",
            field_source: "ethereum_calldata",
            operator: "eq",
            value: "0",
          },
        ],
        id: "funding-router-full-receipt-wrap",
        method: "eth_sendTransaction",
        name: "Funding router full receipt wrap",
      },
    ],
  };
}

const relayPolicyCapRaw = "2000000";
const relayApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];
const relayDepositAbi = [
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [],
  },
];
function buildCombinedPolicyWithRelay(): PrivyPolicyMetadata {
  const condition = (
    field: string,
    fieldSource: string,
    operator: string,
    value: string,
    abi?: readonly unknown[],
  ) => ({
    ...(abi ? { abi } : {}),
    field,
    field_source: fieldSource,
    operator,
    value,
  });
  const policy = buildValidPolymarketBuySellPolicy();
  policy.rules.push(
    {
      action: "ALLOW",
      conditions: [
        condition("chain_id", "ethereum_transaction", "eq", "8453"),
        condition("value", "ethereum_transaction", "eq", "0x0"),
        condition("to", "ethereum_transaction", "eq", BASE_USDC),
        condition(
          "function_name",
          "ethereum_calldata",
          "eq",
          "approve",
          relayApproveAbi,
        ),
        condition(
          "approve.spender",
          "ethereum_calldata",
          "eq",
          RELAY_DEPOSITORY_V2,
          relayApproveAbi,
        ),
        condition(
          "approve.amount",
          "ethereum_calldata",
          "lte",
          relayPolicyCapRaw,
          relayApproveAbi,
        ),
      ],
      id: "relay-approve",
      method: "eth_sendTransaction",
      name: "Relay approve",
    },
    {
      action: "ALLOW",
      conditions: [
        condition("chain_id", "ethereum_transaction", "eq", "8453"),
        condition("value", "ethereum_transaction", "eq", "0x0"),
        condition("to", "ethereum_transaction", "eq", RELAY_DEPOSITORY_V2),
        condition(
          "function_name",
          "ethereum_calldata",
          "eq",
          "depositErc20",
          relayDepositAbi,
        ),
        condition(
          "depositErc20.token",
          "ethereum_calldata",
          "eq",
          BASE_USDC,
          relayDepositAbi,
        ),
        condition(
          "depositErc20.depositor",
          "ethereum_calldata",
          "eq",
          RELAY_SELF_DEPOSITOR,
          relayDepositAbi,
        ),
        condition(
          "depositErc20.amount",
          "ethereum_calldata",
          "lte",
          relayPolicyCapRaw,
          relayDepositAbi,
        ),
      ],
      id: "relay-deposit",
      method: "eth_sendTransaction",
      name: "Relay deposit",
    },
  );
  return policy;
}

function buildValidPolymarketRedeemPolicy(): PrivyPolicyMetadata {
  const typedData = {
    primary_type: "Batch",
    types: POLYMARKET_DEPOSIT_WALLET_BATCH_TYPES,
  };
  return {
    chainType: "ethereum",
    id: "redeem-policy",
    rules: [
      {
        action: "ALLOW",
        conditions: [
          {
            field: "chain_id",
            field_source: "ethereum_typed_data_domain",
            operator: "eq",
            value: "137",
          },
          {
            field: "calls.target",
            field_source: "ethereum_typed_data_message",
            operator: "in",
            typed_data: typedData,
            value: [...policyRedemptionAdapterAddresses],
          },
          {
            field: "calls.value",
            field_source: "ethereum_typed_data_message",
            operator: "eq",
            typed_data: typedData,
            value: "0",
          },
        ],
        id: "deposit-wallet-redemption",
        method: "eth_signTypedData_v4",
        name: "DepositWallet canonical redemption adapters",
      },
    ],
  };
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates =
    extname(base) === ""
      ? [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]
      : [base.replace(/\.js$/, ".ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function collectRuntimeRelativeImports(source: string): string[] {
  const imports: string[] = [];
  const importRegex =
    /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source))) {
    imports.push(match[1]);
  }
  const dynamicImportRegex = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;
  while ((match = dynamicImportRegex.exec(source))) {
    imports.push(match[1]);
  }
  return imports;
}

function collectRuntimeImportGraph(entryRelativePath: string): Set<string> {
  const visited = new Set<string>();
  const pending = [resolve(apiSrcDir, entryRelativePath)];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of collectRuntimeRelativeImports(source)) {
      const resolved = resolveRelativeImport(file, specifier);
      if (resolved && resolved.startsWith(apiSrcDir)) pending.push(resolved);
    }
  }
  return visited;
}

function sourceSlice(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

const tests: TestCase[] = [
  {
    name: "EVM block head reads are shared across one worker scan wave",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: "0x64",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };
      try {
        const rpcUrl = "https://polygon-block-cache-test.example";
        assert.deepEqual(
          await Promise.all([
            fetchEvmBlockNumber({ rpcUrl, timeoutMs: 100 }),
            fetchEvmBlockNumber({ rpcUrl, timeoutMs: 100 }),
            fetchEvmBlockNumber({ rpcUrl, timeoutMs: 100 }),
          ]),
          [100n, 100n, 100n],
        );
        assert.equal(
          await fetchEvmBlockNumber({ rpcUrl, timeoutMs: 100 }),
          100n,
        );
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "Polygon RPC preserves provider getLogs range errors for adaptive scanning",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32600,
              message:
                "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
            },
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/json" },
          },
        );
      try {
        await assert.rejects(
          fetchErc20TransferLogs({
            rpcUrl: "https://polygon-range-test.example",
            timeoutMs: 100,
            contractAddress: "0x0000000000000000000000000000000000000001",
            recipientAddress: "0x0000000000000000000000000000000000000002",
            fromBlock: 1n,
            toBlock: 20n,
          }),
          (error: unknown) => parseEvmGetLogsBlockRangeLimit(error) === 10n,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "embedded Polymarket preparation classifies RPC throttling as retryable service unavailability",
    run: () => {
      assert.deepEqual(
        polymarketTradingExecutionTestHooks.embeddedPreparationFailure(
          new Error("Polygon RPC error: 429 Too Many Requests"),
        ),
        {
          ok: false,
          statusCode: 503,
          payload: {
            error: "Polygon RPC error: 429 Too Many Requests",
            code: "polymarket_rpc_rate_limited",
            retryable: true,
          },
        },
      );
    },
  },
  {
    name: "embedded Polymarket readiness commits a newly deployed funder to existing credentials",
    run: () => {
      const depositWallet = "0x586F49fD5f9816ee9032A4dD4c0e904BA68F93a6";
      assert.equal(
        polymarketTradingExecutionTestHooks.shouldPersistFunderBinding({
          hasCredentials: true,
          storedFunder: null,
          effectiveDistinctFunder: depositWallet,
        }),
        true,
      );
      assert.equal(
        polymarketTradingExecutionTestHooks.shouldPersistFunderBinding({
          hasCredentials: true,
          storedFunder: depositWallet.toLowerCase(),
          effectiveDistinctFunder: depositWallet,
        }),
        false,
      );
      assert.equal(
        polymarketTradingExecutionTestHooks.shouldPersistFunderBinding({
          hasCredentials: false,
          storedFunder: null,
          effectiveDistinctFunder: depositWallet,
        }),
        false,
      );
    },
  },
  {
    name: "embedded Polymarket readiness persists only canonical distinct funders",
    run: () => {
      const canonicalAddress = "0x586F49fD5f9816ee9032A4dD4c0e904BA68F93a6";
      const candidate = {
        funder: canonicalAddress,
        signatureType: 3 as const,
        source: "stored" as const,
        expectedContract: true,
        deployed: true,
        contractKind: "CONTRACT" as const,
      };
      const canonicalDepositWallet = {
        address: canonicalAddress,
        deployed: true,
        generation: "uups" as const,
        factory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
        implementation: "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB",
        beacon: null,
      };
      assert.equal(
        polymarketTradingExecutionTestHooks.isCanonicalDistinctFunder({
          candidate,
          canonicalDepositWallet,
          signer: "0x0000000000000000000000000000000000000011",
        }),
        true,
      );
      assert.equal(
        polymarketTradingExecutionTestHooks.isCanonicalDistinctFunder({
          candidate: {
            ...candidate,
            funder: "0x0000000000000000000000000000000000000042",
          },
          canonicalDepositWallet,
          signer: "0x0000000000000000000000000000000000000011",
        }),
        false,
      );
      assert.equal(
        polymarketTradingExecutionTestHooks.isCanonicalDistinctFunder({
          candidate: {
            ...candidate,
            signatureType: 2,
            source: "stored",
            contractKind: "SAFE_LIKE",
          },
          canonicalDepositWallet: null,
          signer: "0x0000000000000000000000000000000000000011",
        }),
        false,
      );
      assert.equal(
        polymarketTradingExecutionTestHooks.isCanonicalDistinctFunder({
          candidate: {
            ...candidate,
            funder: "0x0000000000000000000000000000000000000043",
            signatureType: 2,
            source: "safe_proxy",
            contractKind: "SAFE_LIKE",
            safeOwners: ["0x0000000000000000000000000000000000000011"],
          },
          canonicalDepositWallet: null,
          signer: "0x0000000000000000000000000000000000000011",
        }),
        true,
      );
      assert.equal(
        polymarketTradingExecutionTestHooks.isCanonicalDistinctFunder({
          candidate: {
            ...candidate,
            funder: "0x0000000000000000000000000000000000000043",
            signatureType: 2,
            source: "safe_proxy",
            contractKind: "SAFE_LIKE",
            safeOwners: ["0x0000000000000000000000000000000000000099"],
          },
          canonicalDepositWallet: null,
          signer: "0x0000000000000000000000000000000000000011",
        }),
        false,
      );
    },
  },
  {
    name: "Limitless AMM quote retries HTTP 429 and coalesces identical reads",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalMaxAttempts = testRetryConfig.maxAttempts;
      const originalBaseBackoff = testRetryConfig.baseBackoffMs;
      const originalMaxBackoff = testRetryConfig.maxBackoffMs;
      const iface = new ethers.Interface([
        "function calcBuyAmount(uint256 investmentAmount,uint256 outcomeIndex) view returns (uint256)",
      ]);
      let calls = 0;

      testRetryConfig.maxAttempts = 2;
      testRetryConfig.baseBackoffMs = 10;
      testRetryConfig.maxBackoffMs = 10;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "0" },
          });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: iface.encodeFunctionResult("calcBuyAmount", [4_000_000n]),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      const input = {
        rpcUrl: "https://base.example",
        timeoutMs: 100,
        marketAddress: "0x0000000000000000000000000000000000000001",
        outcomeIndex: 0,
        side: "BUY" as const,
        amountUsdRaw: 1_000_000n,
      };

      try {
        const [first, second] = await Promise.all([
          fetchLimitlessAmmQuote(input),
          fetchLimitlessAmmQuote(input),
        ]);
        assert.equal(first.sharesRaw, 4_000_000n);
        assert.equal(second.sharesRaw, 4_000_000n);
        assert.equal(calls, 2);
        const cached = await fetchLimitlessAmmQuote(input);
        assert.equal(cached.sharesRaw, 4_000_000n);
        assert.equal(calls, 2);
      } finally {
        globalThis.fetch = originalFetch;
        testRetryConfig.maxAttempts = originalMaxAttempts;
        testRetryConfig.baseBackoffMs = originalBaseBackoff;
        testRetryConfig.maxBackoffMs = originalMaxBackoff;
      }
    },
  },
  {
    name: "Privy bot policy resolver always selects the combined automation policy",
    run: () => {
      assert.equal(resolvePrivyBotPolicyProfile(["BUY"]), "buy_sell");
      assert.equal(resolvePrivyBotPolicyProfile(["SELL"]), "buy_sell");
      assert.equal(resolvePrivyBotPolicyProfile(["SELL", "BUY"]), "buy_sell");
      assert.equal(resolvePrivyBotPolicyProfile([]), null);
      assert.throws(() => resolvePrivyBotPolicyProfile(["REDEEM"]));
      const secretsSource = readFileSync(
        resolve(apiSrcDir, "../../../packages/config/src/secrets.ts"),
        "utf8",
      );
      assert.match(secretsSource, /PRIVY_POLYMARKET_BOT_SELL_POLICY_ID/);
      assert.match(secretsSource, /PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID/);
    },
  },
  {
    name: "Polymarket bot policy accepts only the canonical Polygon BUY surface",
    run: () => {
      const validPolicy = buildValidPolymarketBotPolicy();
      const validation = validatePolymarketBotPolicy({
        exchangeAddresses: policyExchangeAddresses,
        fundingRouterAddress: policyFundingRouterAddress,
        maxBuyUsd: 2,
        policy: validPolicy,
      });
      assert.equal(validation.valid, true);
      assert.equal(validation.fundingMaxRaw, policyFundingMaxRaw);
      assert.equal(validation.fundingRouterControllerApprovalPresent, false);

      const controllerApprovalPolicy = structuredClone(validPolicy);
      controllerApprovalPolicy.rules.push(
        fundingRouterControllerApprovalRule(),
      );
      const controllerApprovalValidation = validatePolymarketBotPolicy({
        exchangeAddresses: policyExchangeAddresses,
        fundingRouterAddress: policyFundingRouterAddress,
        maxBuyUsd: 2,
        policy: controllerApprovalPolicy,
      });
      assert.equal(controllerApprovalValidation.valid, true);
      assert.equal(
        controllerApprovalValidation.fundingRouterControllerApprovalPresent,
        true,
      );

      const unsafeControllerApprovalPolicy = structuredClone(
        controllerApprovalPolicy,
      );
      const controllerApprovalConditions =
        unsafeControllerApprovalPolicy.rules.at(-1)?.conditions;
      assert.ok(Array.isArray(controllerApprovalConditions));
      (controllerApprovalConditions[4] as Record<string, unknown>).value =
        policyExchangeAddresses[0];
      assert.equal(
        validatePolymarketBotPolicy({
          exchangeAddresses: policyExchangeAddresses,
          fundingRouterAddress: policyFundingRouterAddress,
          maxBuyUsd: 2,
          policy: unsafeControllerApprovalPolicy,
        }).valid,
        false,
      );

      const raisedFundingPolicy = structuredClone(validPolicy);
      const fundingConditions = raisedFundingPolicy.rules[3]?.conditions;
      assert.ok(Array.isArray(fundingConditions));
      (fundingConditions[4] as Record<string, unknown>).value = "50000000";
      const raisedValidation = validatePolymarketBotPolicy({
        exchangeAddresses: policyExchangeAddresses,
        fundingRouterAddress: policyFundingRouterAddress,
        maxBuyUsd: 2,
        policy: raisedFundingPolicy,
      });
      assert.equal(raisedValidation.valid, true);
      assert.equal(raisedValidation.fundingMaxRaw, 50_000_000n);

      for (const mutate of [
        (policy: PrivyPolicyMetadata) => {
          policy.rules[0] = {
            ...(policy.rules[0] ?? {}),
            method: "personal_sign",
          };
        },
        (policy: PrivyPolicyMetadata) => {
          const condition = policy.rules[1]?.conditions;
          if (Array.isArray(condition) && condition[0]) {
            (condition[0] as Record<string, unknown>).value = "1";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          const condition = policy.rules[1]?.conditions;
          if (Array.isArray(condition) && condition[0]) {
            (condition[0] as Record<string, unknown>).field = "chainId";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          const condition = policy.rules[1]?.conditions;
          if (Array.isArray(condition) && condition[1]) {
            (condition[1] as Record<string, unknown>).field =
              "verifyingContract";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          const condition = policy.rules[1]?.conditions;
          if (Array.isArray(condition) && condition[2]) {
            (condition[2] as Record<string, unknown>).value = "1";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          const condition = policy.rules[1]?.conditions;
          if (Array.isArray(condition) && condition[4]) {
            (condition[4] as Record<string, unknown>).value = "2000001";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[3]?.conditions;
          if (Array.isArray(conditions) && conditions[3]) {
            (conditions[3] as Record<string, unknown>).value = "wrap";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[3]?.conditions;
          if (Array.isArray(conditions) && conditions[4]) {
            (conditions[4] as Record<string, unknown>).field = "totalAmount";
          }
        },
        (policy: PrivyPolicyMetadata) => {
          policy.rules.push({
            action: "DENY",
            conditions: [],
            id: "deny-all",
            method: "*",
            name: "Deny all",
          });
        },
      ]) {
        const unsafePolicy = structuredClone(validPolicy);
        mutate(unsafePolicy);
        assert.equal(
          validatePolymarketBotPolicy({
            exchangeAddresses: policyExchangeAddresses,
            fundingRouterAddress: policyFundingRouterAddress,
            maxBuyUsd: 2,
            policy: unsafePolicy,
          }).valid,
          false,
        );
      }
    },
  },
  {
    name: "Polymarket SELL and REDEEM policies reject broader permissions",
    run: () => {
      const sell = buildValidPolymarketSellPolicy();
      assert.equal(
        validatePolymarketBotSellPolicy({
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          policy: sell,
        }).valid,
        true,
      );
      const sellWithoutClobAuth = structuredClone(sell);
      sellWithoutClobAuth.rules.shift();
      assert.equal(
        validatePolymarketBotSellPolicy({
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          policy: sellWithoutClobAuth,
        }).valid,
        false,
      );
      for (const mutate of [
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[1]?.conditions;
          assert.ok(Array.isArray(conditions));
          (conditions[2] as Record<string, unknown>).value = "0";
        },
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[1]?.conditions;
          assert.ok(Array.isArray(conditions));
          (conditions[4] as Record<string, unknown>).value =
            `0x${"22".repeat(32)}`;
        },
        (policy: PrivyPolicyMetadata) => {
          policy.rules.push({
            action: "ALLOW",
            conditions: [],
            id: "wildcard",
            method: "*",
            name: "Wildcard",
          });
        },
      ]) {
        const unsafe = structuredClone(sell);
        mutate(unsafe);
        assert.equal(
          validatePolymarketBotSellPolicy({
            builderCode: policyBuilderCode,
            exchangeAddresses: policyExchangeAddresses,
            policy: unsafe,
          }).valid,
          false,
        );
      }

      const combined = buildValidPolymarketBuySellPolicy();
      const combinedValidation = validatePolymarketBotPolicyProfile({
        builderCode: policyBuilderCode,
        exchangeAddresses: policyExchangeAddresses,
        fundingRouterAddress: policyFundingRouterAddress,
        maxBuyUsd: 2,
        policy: combined,
        profile: "buy_sell",
      });
      assert.equal(combinedValidation.valid, true);
      assert.equal(combinedValidation.fundingMaxRaw, policyFundingMaxRaw);
      assert.equal(
        combinedValidation.fundingRouterUsdceApprovalPresent,
        true,
        "the exact controller-USDC.e Router approval survives BUY+SELL policy partitioning",
      );
      assert.equal(
        combinedValidation.fundingRouterPusdFundPresent,
        true,
        "the existing bounded Router totalAmount rule also covers exact controller-pUSD funding",
      );
      const combinedWithRelay = buildCombinedPolicyWithRelay();
      const combinedRelayValidation = validateCombinedPolymarketRelayPolicy({
        builderCode: policyBuilderCode,
        exchangeAddresses: policyExchangeAddresses,
        fundingRouterAddress: policyFundingRouterAddress,
        maxBuyUsd: 2,
        policy: combinedWithRelay,
        profile: "buy_sell",
        relayMaxSourceRaw: relayPolicyCapRaw,
      });
      assert.equal(combinedRelayValidation.valid, true);
      assert.equal(
        combinedRelayValidation.fundingMaxRaw,
        policyFundingMaxRaw,
        "Relay partitioning preserves the Slice C funding cap",
      );
      const foreignRelayRule = structuredClone(combinedWithRelay);
      const foreignDepositorConditions =
        foreignRelayRule.rules.at(-1)?.conditions;
      assert.ok(Array.isArray(foreignDepositorConditions));
      (
        foreignDepositorConditions.find(
          (entry) =>
            (entry as Record<string, unknown>).field ===
            "depositErc20.depositor",
        ) as Record<string, unknown>
      ).value = "0x0000000000000000000000000000000000000020";
      assert.equal(
        validateCombinedPolymarketRelayPolicy({
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          fundingRouterAddress: policyFundingRouterAddress,
          maxBuyUsd: 2,
          policy: foreignRelayRule,
          profile: "buy_sell",
          relayMaxSourceRaw: relayPolicyCapRaw,
        }).valid,
        false,
        "an exact but foreign Relay depositor cannot be hidden from policy closure",
      );
      const combinedWithWildcard = structuredClone(combined);
      combinedWithWildcard.rules.push({
        action: "ALLOW",
        conditions: [],
        id: "combined-wildcard",
        method: "*",
        name: "Wildcard",
      });
      assert.equal(
        validatePolymarketBotPolicyProfile({
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          fundingRouterAddress: policyFundingRouterAddress,
          maxBuyUsd: 2,
          policy: combinedWithWildcard,
          profile: "buy_sell",
        }).valid,
        false,
      );
      const combinedWithDeny = structuredClone(combined);
      combinedWithDeny.rules.push({
        action: "DENY",
        conditions: [],
        id: "combined-deny",
        method: "personal_sign",
        name: "Unexpected deny",
      });
      assert.equal(
        validatePolymarketBotPolicyProfile({
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          fundingRouterAddress: policyFundingRouterAddress,
          maxBuyUsd: 2,
          policy: combinedWithDeny,
          profile: "buy_sell",
        }).valid,
        false,
        "the combined profile is an exact policy shape, not a subset check",
      );

      const redeem = buildValidPolymarketRedeemPolicy();
      assert.equal(
        validatePolymarketBotRedeemPolicy({
          adapterAddresses: policyRedemptionAdapterAddresses,
          policy: redeem,
        }).valid,
        true,
      );
      for (const mutate of [
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[0]?.conditions;
          assert.ok(Array.isArray(conditions));
          (conditions[1] as Record<string, unknown>).value = [
            "0x0000000000000000000000000000000000000099",
          ];
        },
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[0]?.conditions;
          assert.ok(Array.isArray(conditions));
          (conditions[2] as Record<string, unknown>).value = "1";
        },
        (policy: PrivyPolicyMetadata) => {
          const conditions = policy.rules[0]?.conditions;
          assert.ok(Array.isArray(conditions));
          (conditions[1] as Record<string, unknown>).field = "calls.data";
        },
      ]) {
        const unsafe = structuredClone(redeem);
        mutate(unsafe);
        assert.equal(
          validatePolymarketBotRedeemPolicy({
            adapterAddresses: policyRedemptionAdapterAddresses,
            policy: unsafe,
          }).valid,
          false,
        );
      }
    },
  },
  {
    name: "Polymarket SELL keeps exact raw shares and subtracts live locks",
    run: () => {
      const raw = 9_007_199_254_740_993n;
      assert.equal(
        polymarketTradingExecutionTestHooks.sharesAmountRaw({
          amount: { type: "shares", value: ethers.formatUnits(raw, 6) },
          raw: { sharesRaw: raw.toString() },
        } as never),
        raw,
      );
      assert.throws(() =>
        polymarketTradingExecutionTestHooks.sharesAmountRaw({
          amount: { type: "shares", value: "1" },
          raw: { sharesRaw: "1000001" },
        } as never),
      );

      const wallet = "0x0000000000000000000000000000000000000010";
      const locks = computePolymarketClobOpenPositionLocks({
        wallet,
        orders: [
          {
            asset_id: "123",
            maker_address: wallet,
            original_size: "10.500000",
            side: "SELL",
            size_matched: "2.250000",
            type: "GTC",
          },
          {
            asset_id: "123",
            maker_address: wallet,
            original_size: "99",
            side: "BUY",
            size_matched: "0",
            type: "GTC",
          },
        ],
      });
      assert.equal(
        locks.get(polymarketPositionLockKey(wallet, "123")),
        8_250_000n,
      );
    },
  },
  {
    name: "Privy server signer inspector enforces quorum, policy, grant and revoke lifecycle",
    run: async () => {
      const keyPair = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      const authorizationKey = `wallet-auth:${keyPair.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64")}`;
      const publicKey = keyPair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64");
      const configuration: PrivyServerSignerConfiguration = {
        authorizationId: "signer-1",
        authorizationKey,
        builderCode: policyBuilderCode,
        exchangeAddresses: [...policyExchangeAddresses],
        legacyBuyPolicyId: "policy-1",
        legacySellPolicyId: "sell-policy",
        policyId: "buy-sell-policy",
        policyFingerprint: knownPrivyPolicyFingerprint(
          buildValidPolymarketBuySellPolicy(),
        ),
        policyMaxBuyUsd: 2,
        fundingRouterAddress: policyFundingRouterAddress,
      };
      const walletAddress = "0x0000000000000000000000000000000000000010";
      let additionalSigners: Array<{
        overridePolicyIds: string[];
        signerId: string;
      }> = [];
      let quorumPublicKeys = [publicKey];
      let classifiedWalletId = "wallet-1";
      const policies = new Map<string, PrivyPolicyMetadata>([
        ["policy-1", buildValidPolymarketBotPolicy()],
        ["sell-policy", buildValidPolymarketSellPolicy()],
        ["buy-sell-policy", buildValidPolymarketBuySellPolicy()],
      ]);
      const dependencies: PrivySignerInspectorDependencies = {
        classifyWallets: () => [
          {
            address: walletAddress,
            isInternalWallet: true,
            source: "embedded",
            walletId: classifiedWalletId,
            walletType: "ethereum",
          },
        ],
        getKeyQuorumMetadata: async () => ({
          authorizationPublicKeys: quorumPublicKeys,
          authorizationThreshold: 1,
          id: "signer-1",
          nestedKeyQuorumIds: [],
          userIds: [],
        }),
        getManagedWalletMetadata: async () => ({
          additionalSigners,
          address: walletAddress,
          chainType: "ethereum",
          id: "wallet-1",
          policyIds: [],
        }),
        getPolicyMetadata: async (id) => {
          const policy = policies.get(id);
          if (!policy) throw new Error(`Missing policy ${id}`);
          return policy;
        },
        getUserById: async () => ({ id: "user-1" }) as never,
      };
      const inspect = (
        authorizationEnabled: boolean,
        requiredActions: Array<"BUY" | "SELL"> = ["BUY"],
      ) =>
        inspectServerEvmWalletAuthorization({
          authorizationEnabled,
          configuration,
          dependencies,
          privyUserId: "user-1",
          requiredActions,
          signer: walletAddress,
          walletId: "wallet-1",
        });

      const grantRequired = await inspect(true);
      assert.equal(grantRequired.state, "grant_required");
      assert.deepEqual(grantRequired.grant, {
        policyIds: ["buy-sell-policy"],
        policyProfile: "buy_sell",
        replaceExistingSigner: false,
        signerId: "signer-1",
        walletAddress,
        walletChain: "ethereum",
      });
      assert.equal(
        (
          await inspectServerEvmWalletAuthorization({
            authorizationEnabled: true,
            configuration,
            dependencies,
            privyUserId: "user-1",
            requiredActions: ["BUY"],
            signer: walletAddress.toUpperCase(),
            walletId: "wallet-1",
          })
        ).state,
        "unsafe_configuration",
      );

      classifiedWalletId = "another-wallet";
      assert.equal((await inspect(true)).state, "unsafe_configuration");
      classifiedWalletId = "wallet-1";

      additionalSigners = [
        { overridePolicyIds: ["policy-1"], signerId: "signer-1" },
      ];
      const combinedReplacement = await inspect(true);
      assert.equal(combinedReplacement.state, "grant_required");
      assert.deepEqual(combinedReplacement.grant, {
        policyIds: ["buy-sell-policy"],
        policyProfile: "buy_sell",
        replaceExistingSigner: true,
        signerId: "signer-1",
        walletAddress,
        walletChain: "ethereum",
      });
      additionalSigners = [
        {
          overridePolicyIds: ["buy-sell-policy"],
          signerId: "signer-1",
        },
      ];
      assert.equal((await inspect(true, ["BUY", "SELL"])).state, "ready");
      assert.equal((await inspect(true, ["SELL"])).state, "ready");
      assert.equal((await inspect(true, ["BUY"])).state, "ready");
      const revisedCombinedPolicy = buildCombinedPolicyWithRelay();
      policies.set("buy-sell-policy", revisedCombinedPolicy);
      configuration.policyFingerprint = knownPrivyPolicyFingerprint(
        revisedCombinedPolicy,
      );
      configuration.relayMaxSourceRaw = relayPolicyCapRaw;
      assert.equal(
        (await inspect(true, ["BUY", "SELL"])).state,
        "ready",
        "the same attached combined policy remains trading-ready after exact Relay rules are added",
      );
      const broadenedCombinedPolicy = structuredClone(revisedCombinedPolicy);
      const broadenedConditions =
        broadenedCombinedPolicy.rules.at(-1)?.conditions;
      assert.ok(Array.isArray(broadenedConditions));
      (
        broadenedConditions.find(
          (entry) =>
            (entry as Record<string, unknown>).field === "depositErc20.amount",
        ) as Record<string, unknown>
      ).value = "2000001";
      policies.set("buy-sell-policy", broadenedCombinedPolicy);
      configuration.policyFingerprint = knownPrivyPolicyFingerprint(
        broadenedCombinedPolicy,
      );
      assert.equal(
        (await inspect(true, ["BUY", "SELL"])).state,
        "policy_invalid",
        "a Relay cap mismatch keeps the shared policy fail-closed",
      );
      policies.set("buy-sell-policy", buildValidPolymarketBuySellPolicy());
      configuration.policyFingerprint = knownPrivyPolicyFingerprint(
        buildValidPolymarketBuySellPolicy(),
      );
      configuration.relayMaxSourceRaw = undefined;
      additionalSigners = [
        { overridePolicyIds: ["sell-policy"], signerId: "signer-1" },
      ];
      assert.equal((await inspect(true, ["SELL"])).state, "grant_required");
      assert.equal((await inspect(true, ["BUY"])).state, "grant_required");
      additionalSigners = [
        { overridePolicyIds: ["policy-1"], signerId: "signer-1" },
      ];
      const revokeRequired = await inspect(false);
      assert.equal(revokeRequired.state, "revoke_required");
      assert.equal(revokeRequired.canRemoveAllSigners, true);

      additionalSigners.push({
        overridePolicyIds: [],
        signerId: "foreign-signer",
      });
      const unsafe = await inspect(true);
      assert.equal(unsafe.state, "unsafe_configuration");
      assert.equal(unsafe.canRemoveAllSigners, false);

      additionalSigners = [
        { overridePolicyIds: ["wrong-policy"], signerId: "signer-1" },
      ];
      assert.equal((await inspect(true)).state, "unsafe_configuration");

      additionalSigners = [
        {
          overridePolicyIds: ["policy-1", "buy-sell-policy"],
          signerId: "signer-1",
        },
      ];
      assert.equal((await inspect(true)).state, "unsafe_configuration");

      const mismatchedCombinedCap = buildValidPolymarketBuySellPolicy();
      const combinedFundingConditions =
        mismatchedCombinedCap.rules[3]?.conditions;
      assert.ok(Array.isArray(combinedFundingConditions));
      (combinedFundingConditions[4] as Record<string, unknown>).value =
        "50000000";
      policies.set("buy-sell-policy", mismatchedCombinedCap);
      additionalSigners = [
        {
          overridePolicyIds: ["buy-sell-policy"],
          signerId: "signer-1",
        },
      ];
      assert.equal(
        (await inspect(true, ["BUY", "SELL"])).state,
        "policy_invalid",
      );
      policies.set("buy-sell-policy", buildValidPolymarketBuySellPolicy());

      additionalSigners = [
        { overridePolicyIds: ["policy-1"], signerId: "signer-1" },
      ];
      quorumPublicKeys = [Buffer.from("wrong-key").toString("base64")];
      const mismatchedKey = await inspect(true);
      assert.equal(mismatchedKey.state, "policy_invalid");
      assert.equal(mismatchedKey.attached, true);

      quorumPublicKeys = [publicKey];
      const unsafeBuyPolicy = structuredClone(
        policies.get("policy-1") as PrivyPolicyMetadata,
      );
      unsafeBuyPolicy.rules.push({
        action: "ALLOW",
        conditions: [],
        id: "unsafe-method",
        method: "eth_sendTransaction",
        name: "Unsafe",
      });
      policies.set("policy-1", unsafeBuyPolicy);
      assert.equal((await inspect(true)).state, "policy_invalid");
    },
  },
  {
    name: "server signer rejects typed data outside canonical Polymarket action domains",
    run: () => {
      const signer = "0x0000000000000000000000000000000000000010";
      const typedData = {
        domain: {
          chainId: 137,
          name: "Polymarket CTF Exchange",
          verifyingContract: String(policyExchangeAddresses[0]),
          version: "2",
        },
        message: {
          builder: `0x${"0".repeat(64)}`,
          maker: signer,
          makerAmount: "1000000",
          metadata: `0x${"0".repeat(64)}`,
          salt: "1",
          side: 0,
          signatureType: 2,
          signer,
          takerAmount: "15000000",
          timestamp: "0",
          tokenId: "1",
        },
        primaryType: "Order",
        types: POLYMARKET_ORDER_TYPES,
      };
      assert.equal(
        validatePolymarketBotTypedData({
          exchangeAddresses: policyExchangeAddresses,
          maxBuyUsd: 2,
          signer,
          typedData,
        }).valid,
        true,
      );
      assert.equal(
        validatePolymarketBotTypedData({
          exchangeAddresses: policyExchangeAddresses,
          maxBuyUsd: 2,
          signer: signer.toUpperCase(),
          typedData,
        }).valid,
        false,
      );
      const malformedDomain = structuredClone(typedData);
      malformedDomain.domain.verifyingContract = String(
        malformedDomain.domain.verifyingContract,
      ).toUpperCase();
      assert.equal(
        validatePolymarketBotTypedData({
          exchangeAddresses: policyExchangeAddresses,
          maxBuyUsd: 2,
          signer,
          typedData: malformedDomain,
        }).valid,
        false,
      );
      const depositWallet = "0x0000000000000000000000000000000000000020";
      const wrappedTypedData = {
        domain: typedData.domain,
        message: {
          chainId: 137,
          contents: {
            ...typedData.message,
            maker: depositWallet,
            signatureType: 3,
            signer: depositWallet,
          },
          name: "DepositWallet",
          salt: `0x${"0".repeat(64)}`,
          verifyingContract: depositWallet,
          version: "1",
        },
        primaryType: "TypedDataSign",
        types: POLYMARKET_TYPED_DATA_SIGN_TYPES,
      };
      assert.equal(
        validatePolymarketBotTypedData({
          exchangeAddresses: policyExchangeAddresses,
          maxBuyUsd: 2,
          signer,
          typedData: wrappedTypedData,
        }).valid,
        true,
      );
      const sellTypedData = structuredClone(wrappedTypedData);
      sellTypedData.message.contents.side = 1;
      sellTypedData.message.contents.builder = policyBuilderCode;
      assert.equal(
        validatePolymarketBotTypedData({
          action: "SELL",
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          maxBuyUsd: 2,
          signer,
          typedData: sellTypedData,
        }).valid,
        true,
      );
      sellTypedData.message.contents.builder = `0x${"22".repeat(32)}`;
      assert.equal(
        validatePolymarketBotTypedData({
          action: "SELL",
          builderCode: policyBuilderCode,
          exchangeAddresses: policyExchangeAddresses,
          maxBuyUsd: 2,
          signer,
          typedData: sellTypedData,
        }).valid,
        false,
      );
      for (const mutate of [
        (value: typeof typedData) => {
          value.domain.chainId = 1;
        },
        (value: typeof typedData) => {
          value.domain.verifyingContract =
            "0x0000000000000000000000000000000000000099";
        },
        (value: typeof typedData) => {
          value.message.side = 1;
        },
        (value: typeof typedData) => {
          value.message.makerAmount = "2000001";
        },
      ]) {
        const rejected = structuredClone(typedData);
        mutate(rejected);
        assert.equal(
          validatePolymarketBotTypedData({
            exchangeAddresses: policyExchangeAddresses,
            maxBuyUsd: 2,
            signer,
            typedData: rejected,
          }).valid,
          false,
        );
      }
    },
  },
  {
    name: "Polymarket bot stringifies policy-controlled EIP-712 integers",
    run: () => {
      const order = {
        salt: "1",
        makerAmount: "1000000",
        side: 0,
        signatureType: 3,
        expiration: "0",
      };
      assert.deepEqual(
        polymarketTradingExecutionTestHooks.normalizeOrderForPrivyPolicy(order),
        {
          ...order,
          side: "0",
          signatureType: "3",
        },
      );
      assert.deepEqual(
        polymarketTradingExecutionTestHooks.normalizeOrderForPayload(
          {
            ...order,
            salt: "777109195663",
            timestamp: "1783768779432",
          },
          "BUY",
        ),
        {
          ...order,
          salt: 777109195663,
          side: "BUY",
          timestamp: "1783768779432",
        },
      );
    },
  },
  {
    name: "Polymarket bot keeps CLOB and order-hash side representations separate",
    run: () => {
      const payloads =
        polymarketTradingExecutionTestHooks.buildSignedOrderPayloads({
          order: {
            salt: "777109195663",
            maker: "0x0000000000000000000000000000000000000001",
            signer: "0x0000000000000000000000000000000000000001",
            tokenId:
              "44632793419668141561343859504077903947361590865219599333832862239708628173864",
            makerAmount: "1000000",
            takerAmount: "1003000",
            side: 0,
            signatureType: 3,
            timestamp: "1783768779432",
            metadata:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            builder:
              "0x0383467ec0c0a88fe7030bf324e02425af407431d6f3182a2a1d0c307e9091f8",
            expiration: "0",
          },
          side: "BUY",
          signature: "0xsigned",
        });

      assert.equal(payloads.clobOrder.side, "BUY");
      assert.equal(payloads.hashOrder.side, 0);
      assert.equal(payloads.clobOrder.signatureType, 3);
      assert.equal(payloads.hashOrder.signatureType, 3);
      assert.equal(payloads.clobOrder.signature, "0xsigned");
      assert.equal(payloads.hashOrder.signature, "0xsigned");
    },
  },
  {
    name: "trading market loaders share the canonical venue-aware projection",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const market: ApiTradeMarket = {
        accepting_orders: true,
        best_ask: "0.55",
        best_bid: "0.45",
        clob_token_ids: '["yes-token","no-token"]',
        close_time: new Date(Date.now() + 60_000),
        event_end_time: new Date(Date.now() + 60_000),
        event_id: "polymarket:event-1",
        event_title: "Event",
        expiration_time: new Date(Date.now() + 60_000),
        id: "polymarket:market-1",
        is_initialized: true,
        last_price: "0.5",
        metadata: {},
        outcomes: '["Yes","No"]',
        slug: "market-1",
        status: "ACTIVE",
        title: "Market",
        token_no: "no-token",
        token_yes: "yes-token",
        updated_at: new Date(),
        venue: "polymarket",
        venue_market_id: "venue-market-1",
      };
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ params, sql });
          if (/WHERE m\.id = \$1/.test(sql)) {
            const rows = params[0] === market.id ? [market] : [];
            return { rowCount: rows.length, rows };
          }
          if (/WHERE venue_market_id = \$1/.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/WHERE slug = \$1/.test(sql)) {
            const rows = params[0] === market.slug ? [{ id: market.id }] : [];
            return { rowCount: rows.length, rows };
          }
          throw new Error(`Unexpected market lookup query: ${sql}`);
        },
      };

      assert.equal(
        (await findTradeMarketById(db as never, market.id))?.id,
        market.id,
      );
      assert.equal(
        (await findTradeMarketByRef(db as never, market.slug ?? ""))?.id,
        market.id,
      );
      assert.equal(
        (await loadMarketForVenue(db as never, market.id, "polymarket")).id,
        market.id,
      );
      assert.equal(queries.length, 6);
      const projectionQueries = queries.filter((query) =>
        query.sql.includes("LEFT JOIN polymarket_markets pm"),
      );
      assert.equal(projectionQueries.length, 4);
      for (const query of projectionQueries) {
        assert.match(
          query.sql,
          /LEFT JOIN polymarket_markets pm\s+ON pm\.id = m\.venue_market_id\s+AND m\.venue = 'polymarket'/,
        );
        assert.match(query.sql, /pm\.accepting_orders AS accepting_orders/);
        assert.match(
          query.sql,
          /coalesce\(m\.condition_id, pm\.condition_id\) AS condition_id/,
        );
        assert.match(
          query.sql,
          /pm_parent\.condition_id AS neg_risk_parent_condition_id/,
        );
        assert.doesNotMatch(query.sql, /(^|[^a-z_])m\.accepting_orders/i);
        assert.doesNotMatch(query.sql, /^\s*accepting_orders[,\s]/m);
      }
      assert.match(queries[1]?.sql ?? "", /WHERE m\.id = \$1/);
      assert.deepEqual(queries[1]?.params, [market.slug]);
      assert.match(queries[2]?.sql ?? "", /WHERE venue_market_id = \$1/);
      assert.deepEqual(queries[2]?.params, [market.slug]);
      assert.match(queries[3]?.sql ?? "", /WHERE slug = \$1/);
      assert.deepEqual(queries[3]?.params, [market.slug]);
      assert.match(queries[4]?.sql ?? "", /WHERE m\.id = \$1/);
      assert.deepEqual(queries[4]?.params, [market.id]);
      assert.deepEqual(queries[5]?.params, [market.id]);
    },
  },
  {
    name: "Kalshi strict submit market binding accepts only server USDC and selected market mints",
    run: () => {
      const market = {
        token_yes: "sol:YesMint11111111111111111111111111111111111",
        token_no: "NoMint111111111111111111111111111111111111",
      };
      assert.equal(
        isKalshiMarketMintContextValid({
          inputMint: "UsdcMint1111111111111111111111111111111111",
          market,
          outputMint: "YesMint11111111111111111111111111111111111",
          usdcMint: "UsdcMint1111111111111111111111111111111111",
        }),
        true,
      );
      assert.equal(
        isKalshiMarketMintContextValid({
          inputMint: "FakeUsdc11111111111111111111111111111111111",
          market,
          outputMint: "YesMint11111111111111111111111111111111111",
          usdcMint: "UsdcMint1111111111111111111111111111111111",
        }),
        false,
      );
      assert.equal(
        isKalshiMarketMintContextValid({
          inputMint: "UsdcMint1111111111111111111111111111111111",
          market,
          outputMint: "OtherMarketMint11111111111111111111111111111",
          usdcMint: "UsdcMint1111111111111111111111111111111111",
        }),
        false,
      );
    },
  },
  {
    name: "Polymarket readiness decisions are fail-closed and side-effect free",
    run: async () => {
      const signer = "0x0000000000000000000000000000000000000001";
      const storedFunder = "0x0000000000000000000000000000000000000002";
      const readyCandidate = {
        contractKind: "CONTRACT" as const,
        deployed: true,
        expectedContract: true,
        funder: storedFunder,
        signatureType: 3 as const,
        source: "stored" as const,
      };
      let caughtErrors = 0;
      const unavailable =
        await polymarketTradingExecutionTestHooks.inspectFunderReadiness({
          deriveFunders: async () => {
            throw new Error("rpc timeout");
          },
          onError: () => {
            caughtErrors += 1;
          },
          setupApprovalsReady: true,
          storedFunder,
        });
      assert.equal(caughtErrors, 1);
      assert.equal(
        unavailable.readiness?.reasonCode,
        "polymarket_funder_status_unavailable",
      );
      assert.equal(unavailable.readiness?.repair ?? null, null);

      const missingDeposit =
        await polymarketTradingExecutionTestHooks.inspectFunderReadiness({
          deriveFunders: async () => ({
            candidates: [],
            recommended: null,
            signer,
            storedFunder: null,
            warnings: [],
          }),
          setupApprovalsReady: false,
          storedFunder: null,
        });
      assert.equal(
        missingDeposit.readiness?.reasonCode,
        "polymarket_funder_not_ready",
      );
      assert.equal(missingDeposit.readiness?.repair?.kind, "app_required");

      const missingApprovals =
        await polymarketTradingExecutionTestHooks.inspectFunderReadiness({
          deriveFunders: async () => ({
            candidates: [readyCandidate],
            recommended: readyCandidate,
            signer,
            storedFunder,
            warnings: [],
          }),
          setupApprovalsReady: false,
          storedFunder,
        });
      assert.equal(
        missingApprovals.readiness?.reasonCode,
        "polymarket_approvals_missing",
      );
      assert.equal(missingApprovals.readiness?.repair?.kind, "app_required");

      const setupReady =
        await polymarketTradingExecutionTestHooks.inspectFunderReadiness({
          deriveFunders: async () => ({
            candidates: [readyCandidate],
            recommended: readyCandidate,
            signer,
            storedFunder,
            warnings: [],
          }),
          setupApprovalsReady: true,
          storedFunder,
        });
      assert.equal(setupReady.readiness, null);
      assert.equal(setupReady.funderExecutionKind, "deposit_wallet");

      const repairCalls: string[] = [];
      const repaired =
        await polymarketTradingExecutionTestHooks.repairCredentials(
          { signer, userId: "user-1", walletId: "wallet-1" },
          {
            createCredentials: async () => {
              repairCalls.push("save-credentials");
              return undefined;
            },
            createWalletClient: () => ({}) as never,
            deriveFunders: async () => {
              repairCalls.push("derive-funder");
              return {
                candidates: [readyCandidate],
                recommended: readyCandidate,
                signer,
                storedFunder,
                warnings: [],
              };
            },
            getCredentials: async () => {
              repairCalls.push("read-credentials");
              return null;
            },
            nonce: () => 7,
            nowMs: () => 1_700_000_000_000,
            requestCredentials: async () => {
              repairCalls.push("request-credentials");
              return {
                apiKey: "key",
                apiSecret: "secret",
                passphrase: "passphrase",
              };
            },
            resolveState: async () => {
              repairCalls.push("inspect-setup");
              return {
                credsInfo: null,
                effectiveDistinctFunder: storedFunder,
                setupApprovalsReady: true,
              } as never;
            },
            signTypedData: async () => {
              repairCalls.push("sign-credential");
              return "0xsignature";
            },
          } as never,
        );
      assert.deepEqual(repaired.sideEffects, ["credential"]);
      assert.deepEqual(repairCalls, [
        "inspect-setup",
        "derive-funder",
        "read-credentials",
        "sign-credential",
        "request-credentials",
        "save-credentials",
      ]);

      let unsafeSigningCalls = 0;
      await assert.rejects(
        () =>
          polymarketTradingExecutionTestHooks.repairCredentials(
            { signer, userId: "user-1", walletId: "wallet-1" },
            {
              deriveFunders: async () => ({
                candidates: [readyCandidate],
                recommended: readyCandidate,
                signer,
                storedFunder,
                warnings: [],
              }),
              resolveState: async () =>
                ({
                  credsInfo: null,
                  effectiveDistinctFunder: storedFunder,
                  setupApprovalsReady: false,
                }) as never,
              signTypedData: async () => {
                unsafeSigningCalls += 1;
                return "0xunsafe";
              },
            } as never,
          ),
        /deposit wallet and approvals must be completed/i,
      );
      assert.equal(unsafeSigningCalls, 0);

      const credentials =
        polymarketTradingExecutionTestHooks.evaluateCredentialReadiness({
          canAutoRepair: true,
          credentialsReady: false,
        });
      assert.equal(credentials?.repair?.kind, "auto");
      assert.equal(credentials?.repair?.sideEffect, "credential");

      const missingFundsApproval =
        polymarketTradingExecutionTestHooks.evaluateFundsReadiness({
          buyApprovalOk: false,
          executableFundsRaw: 10_000_000n,
        });
      assert.equal(
        missingFundsApproval.reasonCode,
        "polymarket_approvals_missing",
      );
      assert.equal(missingFundsApproval.repair?.kind, "app_required");
      const unfunded =
        polymarketTradingExecutionTestHooks.evaluateFundsReadiness({
          buyApprovalOk: true,
          executableFundsRaw: 0n,
        });
      assert.equal(unfunded.executable, false);
      assert.equal(unfunded.maxExecutableBuyUsd, 0);
      const funded = polymarketTradingExecutionTestHooks.evaluateFundsReadiness(
        {
          buyApprovalOk: true,
          executableFundsRaw: 12_500_000n,
        },
      );
      assert.equal(funded.executable, true);
      assert.equal(funded.maxExecutableBuyUsd, 12.5);

      const preparedQuote =
        polymarketTradingExecutionTestHooks.inspectPreparedQuote({
          candidate: readyCandidate,
          rawQuote: {
            feePolicySnapshot: {
              builderCode: `0x${"11".repeat(32)}`,
              builderMakerFeeBps: 0,
              builderTakerFeeBps: 50,
              collectionMode: "builder",
              venue: "polymarket",
            },
            makerAmount: "10000000",
            takerAmount: "20000000",
            totalRequiredUsdcRaw: "10500000",
          },
        });
      assert.equal(preparedQuote.requiredSpendRaw, 10_500_000n);
      assert.equal(preparedQuote.funderExecutionKind, "deposit_wallet");
      assert.throws(
        () =>
          polymarketTradingExecutionTestHooks.inspectPreparedQuote({
            candidate: readyCandidate,
            rawQuote: {
              makerAmount: "10000000",
              totalRequiredUsdcRaw: "10500000",
            },
          }),
        /fee policy is unavailable/,
      );
      assert.throws(
        () =>
          polymarketTradingExecutionTestHooks.assertPreparedFunds({
            buyApprovalOk: true,
            executableFundsRaw: 10_000_000n,
            requiredSpendRaw: preparedQuote.requiredSpendRaw,
          }),
        /Insufficient executable Polymarket funds/,
      );
    },
  },
  {
    name: "Limitless and Kalshi readiness decisions expose repair and funding states",
    run: () => {
      assert.equal(isLimitlessBotClobExecutable(), false);
      const clobHandoffBalance =
        limitlessTradingExecutionTestHooks.clobBotTradingDisabledReadiness({
          maxExecutableBuyUsd: 12.5,
        });
      assert.equal(
        clobHandoffBalance.reasonCode,
        "limitless_clob_slippage_guard_unavailable",
        "the direct-bot CLOB guard remains in force",
      );
      assert.equal(clobHandoffBalance.executable, false);
      assert.equal(
        clobHandoffBalance.maxExecutableBuyUsd,
        12.5,
        "Telegram app handoff can safely calculate a funding shortfall from observed Base USDC without enabling direct CLOB execution",
      );
      const connect =
        limitlessTradingExecutionTestHooks.buildConnectionReadiness({
          autoRepairable: true,
          code: "limitless_connect_required",
          message: "Connect Limitless.",
        });
      assert.equal(connect.executable, false);
      assert.equal(connect.repair?.kind, "auto");
      assert.equal(connect.repair?.sideEffect, "connection");
      const reconnect =
        limitlessTradingExecutionTestHooks.buildConnectionReadiness({
          autoRepairable: false,
          code: "limitless_reconnect_required",
          message: "Reconnect Limitless.",
        });
      assert.equal(reconnect.repair?.kind, "app_required");
      const noLimitlessFunds =
        limitlessTradingExecutionTestHooks.evaluateBalanceReadiness(0n);
      assert.equal(
        noLimitlessFunds.reasonCode,
        "limitless_no_executable_funds",
      );
      assert.equal(noLimitlessFunds.maxExecutableBuyUsd, 0);
      const limitlessFunded =
        limitlessTradingExecutionTestHooks.evaluateBalanceReadiness(
          12_500_000n,
        );
      assert.equal(limitlessFunded.executable, true);
      assert.equal(limitlessFunded.maxExecutableBuyUsd, 12.5);

      const staleEligibility =
        kalshiTradingExecutionTestHooks.eligibilityReadiness({
          checkedAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-01T01:00:00.000Z",
          geoAllowed: true,
          proofVerified: true,
        });
      assert.equal(
        staleEligibility?.reasonCode,
        "kalshi_eligibility_refresh_required",
      );
      assert.equal(staleEligibility?.repair?.kind, "app_required");
      const freshEligibility =
        kalshiTradingExecutionTestHooks.eligibilityReadiness({
          checkedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          geoAllowed: true,
          proofVerified: true,
        });
      assert.equal(freshEligibility, null);

      const initFunding =
        kalshiTradingExecutionTestHooks.evaluateFundingReadiness({
          marketInitialized: false,
          solLamports: 19_999_999n,
          usdcAmount: 5_000_000n,
          usdcDecimals: 6,
        });
      assert.equal(initFunding.reasonCode, "kalshi_sol_funding_required");
      assert.equal(initFunding.maxExecutableBuyUsd, 5);
      assert.match(initFunding.message ?? "", /0\.02 SOL/);
      const noKalshiFunds =
        kalshiTradingExecutionTestHooks.evaluateFundingReadiness({
          marketInitialized: true,
          solLamports: 5_000_000n,
          usdcAmount: 0n,
          usdcDecimals: 6,
        });
      assert.equal(noKalshiFunds.reasonCode, "kalshi_no_executable_funds");
      const kalshiFunded =
        kalshiTradingExecutionTestHooks.evaluateFundingReadiness({
          marketInitialized: true,
          solLamports: 5_000_000n,
          usdcAmount: 7_500_000n,
          usdcDecimals: 6,
        });
      assert.equal(kalshiFunded.executable, true);
      assert.equal(kalshiFunded.maxExecutableBuyUsd, 7.5);
    },
  },
  {
    name: "Limitless AMM approval and buy callbacks preserve the submit boundary",
    run: async () => {
      const amountUsdRaw = 10_000_000n;
      const prepared = {
        authorizationMode: "embedded_privy_evm",
        authorizationRequests: [],
        expiresAt: null,
        intent: {
          action: "BUY",
          actor: { kind: "telegram_bot", userId: "user-1" },
          amount: { type: "usd", value: "10" },
          executionAuthorization: {
            privyUserId: "privy-1",
            privyWalletId: "wallet-1",
          },
          id: "intent-1",
          idempotencyKey: "telegram-bot:intent-1",
          orderType: "FOK",
          target: {
            marketId: "market-1",
            outcome: "YES",
            tokenId: "token-1",
            venue: "limitless",
          },
          venue: "limitless",
          walletAddress: "0x0000000000000000000000000000000000000001",
          walletChain: "ethereum",
        },
        preparedId: "prepared-1",
        quote: null,
        reconcileKeys: {},
        venue: "limitless",
        venuePayload: {},
      } as unknown as PreparedTrade;
      const payload = {
        allowanceRaw: "0",
        amountUsd: 10,
        amountUsdRaw: amountUsdRaw.toString(),
        approvalAmountRaw: amountUsdRaw.toString(),
        approvalRequired: true,
        kind: "limitless",
        marketAddress: "0x0000000000000000000000000000000000000002",
        minOutcomeTokensRaw: "19000000",
        outcomeIndex: 0,
        price: 0.5,
        sharesRaw: "20000000",
        size: 20,
        tokenId: "token-1",
        tradeType: "amm",
      };
      const events: string[] = [];
      let snapshots = 0;
      const result =
        await limitlessTradingExecutionTestHooks.submitAmmPreparedTrade(
          {
            onBeforeBroadcast: () => {
              events.push("before-buy");
            },
            onBroadcastSubmitted: (submitted) => {
              events.push(`buy-ref:${submitted.txSignature}`);
            },
            onSetupTransactionSubmitted: (setup) => {
              events.push(`setup-ref:${setup.txHash}`);
            },
            payload: payload as never,
            prepared,
          },
          {
            fetchOnchainSnapshot: async () => {
              snapshots += 1;
              return {
                allowanceAmm: snapshots === 1 ? 0n : amountUsdRaw,
                usdcBalance: amountUsdRaw,
              } as never;
            },
            sendTransaction: async (transaction) => {
              events.push(transaction.label);
              if (transaction.label.includes("approval")) {
                const decoded = new ethers.Interface([
                  "function approve(address spender,uint256 value)",
                ]).decodeFunctionData("approve", transaction.data);
                assert.equal(decoded[1], amountUsdRaw);
                await transaction.onSubmitted?.("0xapproval");
                return "0xapproval";
              }
              await transaction.onSubmitted?.("0xbuy");
              return "0xbuy";
            },
          },
        );
      assert.equal(result.txSignature, "0xbuy");
      assert.deepEqual(events, [
        "Limitless AMM USDC approval",
        "setup-ref:0xapproval",
        "before-buy",
        "Limitless AMM buy",
        "buy-ref:0xbuy",
      ]);

      const timeoutEvents: string[] = [];
      await assert.rejects(
        () =>
          limitlessTradingExecutionTestHooks.submitAmmPreparedTrade(
            {
              onBeforeBroadcast: () => {
                timeoutEvents.push("before-buy");
              },
              onBroadcastSubmitted: (submitted) => {
                timeoutEvents.push(`buy-ref:${submitted.txSignature}`);
              },
              payload: payload as never,
              prepared,
            },
            {
              fetchOnchainSnapshot: async () =>
                ({
                  allowanceAmm: amountUsdRaw,
                  usdcBalance: amountUsdRaw,
                }) as never,
              sendTransaction: async (transaction) => {
                await transaction.onSubmitted?.("0xtimeout");
                throw new Error("receipt timeout");
              },
            },
          ),
        /receipt timeout/,
      );
      assert.deepEqual(timeoutEvents, ["before-buy", "buy-ref:0xtimeout"]);

      const approvalFailureEvents: string[] = [];
      await assert.rejects(
        () =>
          limitlessTradingExecutionTestHooks.submitAmmPreparedTrade(
            {
              onBeforeBroadcast: () => {
                approvalFailureEvents.push("before-buy");
              },
              onSetupTransactionSubmitted: (setup) => {
                approvalFailureEvents.push(`setup-ref:${setup.txHash}`);
              },
              payload: payload as never,
              prepared,
            },
            {
              fetchOnchainSnapshot: async () =>
                ({ allowanceAmm: 0n, usdcBalance: amountUsdRaw }) as never,
              sendTransaction: async (transaction) => {
                await transaction.onSubmitted?.("0xapproval-failed");
                throw new Error("approval receipt failed");
              },
            },
          ),
        /approval receipt failed/,
      );
      assert.deepEqual(approvalFailureEvents, ["setup-ref:0xapproval-failed"]);
    },
  },
  {
    name: "Polymarket bot redemption signs exactly one canonical adapter Batch",
    run: async () => {
      const owner = "0x0000000000000000000000000000000000000010";
      const deposit = "0x0000000000000000000000000000000000000020";
      const adapter = policyRedemptionAdapterAddresses[0];
      const calldata = "0x12345678";
      const calls = [{ target: adapter, value: "0", data: calldata }];
      const typedData = buildDepositWalletBatchTypedData({
        depositWalletAddress: deposit,
        nonce: "7",
        deadline: "2000000000",
        calls,
      });
      assert.equal(
        validateCanonicalRedemptionBatch({
          adapterAddress: adapter,
          calldata,
          depositWalletAddress: deposit,
          typedData,
        }),
        true,
      );
      let signed = false;
      const signature = await signPolymarketRedemptionBatch({
        adapterAddress: adapter,
        calldata,
        depositWalletAddress: deposit,
        signer: owner,
        typedData,
        walletClient: {
          walletApi: {
            ethereum: {
              signTypedData: async () => {
                signed = true;
                return { signature: "0xsigned" };
              },
            },
          },
        } as never,
        walletId: "wallet-1",
      });
      assert.equal(signature, "0xsigned");
      assert.equal(signed, true);
      const submit = buildDepositWalletSubmitBody({
        ownerAddress: owner,
        depositWalletAddress: deposit,
        nonce: "7",
        deadline: "2000000000",
        calls,
        signature,
      });
      assert.equal(submit.type, "WALLET");
      assert.equal(submit.to, POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS);
      assert.equal(submit.depositWalletParams.calls.length, 1);

      const unsafeTypedData = buildDepositWalletBatchTypedData({
        depositWalletAddress: deposit,
        nonce: "7",
        deadline: "2000000000",
        calls: [
          ...calls,
          {
            target: "0x0000000000000000000000000000000000000099",
            value: "0",
            data: "0x",
          },
        ],
      });
      await assert.rejects(
        () =>
          signPolymarketRedemptionBatch({
            adapterAddress: adapter,
            calldata,
            depositWalletAddress: deposit,
            signer: owner,
            typedData: unsafeTypedData,
            walletClient: {} as never,
            walletId: "wallet-1",
          }),
        /outside the canonical Polymarket redemption adapter path/,
      );

      const transferTopic = ethers.id("Transfer(address,address,uint256)");
      const addressTopic = (address: string) =>
        ethers.zeroPadValue(address, 32);
      assert.equal(
        sumErc20TransfersTo({
          logs: [
            {
              address: "0x0000000000000000000000000000000000000030",
              topics: [
                transferTopic,
                addressTopic(owner),
                addressTopic(deposit),
              ],
              data: ethers.zeroPadValue(ethers.toBeHex(1_250_000n), 32),
            },
          ],
          recipient: deposit,
          tokenAddress: "0x0000000000000000000000000000000000000030",
        }),
        1_250_000n,
      );
    },
  },
  {
    name: "server EVM message signing returns the Privy signature",
    run: async () => {
      let captured: unknown = null;
      const signature = await signEvmMessage({
        walletClient: {
          walletApi: {
            ethereum: {
              signMessage: async (input: unknown) => {
                captured = input;
                return { signature: "0xsigned" };
              },
            },
          },
        } as never,
        walletId: "wallet-1",
        signer: "0x0000000000000000000000000000000000000001",
        message: "Sign in to Limitless",
      });
      assert.equal(signature, "0xsigned");
      assert.deepEqual(captured, {
        walletId: "wallet-1",
        address: "0x0000000000000000000000000000000000000001",
        chainType: "ethereum",
        message: "Sign in to Limitless",
      });
    },
  },
  {
    name: "trading lifecycle persists accepted submit when onSubmitted throws",
    run: async () => {
      const calls: string[] = [];
      const prepared: PreparedTrade = {
        authorizationMode: "embedded_privy_evm",
        authorizationRequests: [],
        expiresAt: null,
        intent: {
          action: "BUY",
          actor: { kind: "telegram_bot", userId: "user-1" },
          amount: { type: "usd", value: "10" },
          id: "intent-1",
          idempotencyKey: "telegram-bot:intent-1",
          target: {
            eventId: "event-1",
            marketId: "market-1",
            outcome: "YES",
            title: "Market",
            tokenId: "token-1",
            venue: "polymarket",
            venueMarketId: "venue-market-1",
          },
          venue: "polymarket",
          walletAddress: "0x0000000000000000000000000000000000000001",
          walletChain: "ethereum",
        },
        preparedId: "prepared-1",
        quote: null,
        reconcileKeys: {
          idempotencyKey: "telegram-bot:intent-1",
          orderHash: "0xorder",
          venue: "polymarket",
        },
        venue: "polymarket",
        venuePayload: {},
      };
      const submitResult: SubmitResult = {
        orderHash: "0xorder",
        price: 0.5,
        size: 20,
        status: "submitted",
        txSignature: null,
        venue: "polymarket",
        venueOrderId: "venue-order-1",
      };

      const result = await executePreparedTradeLifecycle({
        applyTradeEffects: async () => {
          calls.push("effects");
          return { ok: true };
        },
        executeInput: {
          onSubmitted: async () => {
            calls.push("onSubmitted");
            throw new Error("telegram intent update failed");
          },
          prepared,
        },
        persistTrade: async () => {
          calls.push("persist");
          return {
            executionId: null,
            orderId: "order-1",
            raw: null,
            status: "submitted",
            venue: "polymarket",
            venueOrderId: "venue-order-1",
          };
        },
        submitPreparedTrade: async () => {
          calls.push("submit");
          return submitResult;
        },
      });

      assert.deepEqual(calls, ["submit", "onSubmitted", "persist", "effects"]);
      assert.equal(result.persisted?.orderId, "order-1");
      assert.equal(result.effects?.ok, true);
      assert.equal(result.postSubmitError?.code, "trade_submission_failed");
      assert.match(
        result.postSubmitError?.message ?? "",
        /telegram intent update failed/,
      );
    },
  },
  {
    name: "API-owned trading execution advertises venue action capabilities",
    run: async () => {
      const trading = createApiTradingApplicationService({
        pool: {} as Pool,
      });
      const capabilities = trading
        .listCapabilities()
        .sort((left, right) => left.venue.localeCompare(right.venue));
      assert.deepEqual(
        capabilities.map((capability) => capability.venue),
        ["kalshi", "limitless", "polymarket"],
      );
      for (const capability of capabilities) {
        assert.equal(capability.supportsBuy, true);
        assert.equal(
          capability.supportsSell,
          capability.venue === "polymarket",
        );
        assert.equal(capability.supportsSetup, false);
        assert.equal(
          capability.authorizationModes.includes("unsupported"),
          false,
        );
      }
      const readiness = await trading.getReadiness({
        actor: {
          kind: "telegram_bot",
          userId: "user-1",
        },
        venue: "polymarket" as const,
        walletAddress: null,
        walletChain: "ethereum",
      });
      assert.equal(readiness.ready, false);
      assert.equal(readiness.executable, false);
      assert.equal(readiness.reasonCode, "insufficient_readiness");
    },
  },
  {
    name: "Polymarket quote route remains token-only REST compatible through shared quote service",
    run: () => {
      const routeSource = readFileSync(
        resolve(apiSrcDir, "routes/polymarket-private.ts"),
        "utf8",
      );
      const serviceSource = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      assert.match(routeSource, /quotePolymarketOrderRoute/);
      assert.doesNotMatch(routeSource, /quotePolymarketOrder\(pool,/);
      assert.match(serviceSource, /quotePolymarketOrder\(input\.pool,/);
    },
  },
  {
    name: "migrated REST execution endpoints delegate to shared venue services",
    run: () => {
      const polymarketRoute = readFileSync(
        resolve(apiSrcDir, "routes/polymarket-private.ts"),
        "utf8",
      );
      const polymarketMarketInfoBlock = sourceSlice(
        polymarketRoute,
        "   * GET /market-info",
        "   * GET /order-params",
      );
      assert.match(polymarketMarketInfoBlock, /fetchPolymarketMarketInfoRoute/);
      assert.doesNotMatch(
        polymarketMarketInfoBlock,
        /fetchPolymarketMarketInfo\(/,
      );
      assert.doesNotMatch(
        polymarketMarketInfoBlock,
        /exchangeAddressForNegRisk/,
      );

      const polymarketOrderParamsBlock = sourceSlice(
        polymarketRoute,
        "   * GET /order-params",
        "   * POST /order-hash",
      );
      assert.match(
        polymarketOrderParamsBlock,
        /buildPolymarketOrderParamsRoute/,
      );
      assert.doesNotMatch(
        polymarketOrderParamsBlock,
        /fetchPolymarketMarketInfo\(/,
      );
      assert.doesNotMatch(
        polymarketOrderParamsBlock,
        /resolvePolymarketFeePolicySnapshot/,
      );

      const polymarketOrderBlock = sourceSlice(
        polymarketRoute,
        "   * POST /order\n   * Place a signed Polymarket order",
        "   * DELETE /order",
      );
      const polymarketOpenOrdersBlock = sourceSlice(
        polymarketRoute,
        "   * GET /orders/open",
        "   * POST /balance-allowance/sync",
      );
      assert.match(polymarketOpenOrdersBlock, /fetchPolymarketOpenOrdersRoute/);
      assert.doesNotMatch(polymarketOpenOrdersBlock, /polymarketL2Request/);

      const polymarketBalanceSyncBlock = sourceSlice(
        polymarketRoute,
        "   * POST /balance-allowance/sync",
        "   * POST /order",
      );
      assert.match(
        polymarketBalanceSyncBlock,
        /syncPolymarketBalanceAllowanceRoute/,
      );
      assert.doesNotMatch(polymarketBalanceSyncBlock, /polymarketL2Request/);

      assert.match(polymarketRoute, /submitPolymarketClientSignedOrder/);
      assert.match(polymarketOrderBlock, /submitPolymarketClientSignedOrder/);
      assert.doesNotMatch(polymarketOrderBlock, /polymarketL2Request/);
      assert.doesNotMatch(polymarketOrderBlock, /storeOrder/);

      const polymarketCancelBlock = sourceSlice(
        polymarketRoute,
        "   * DELETE /order",
        "\n};\n",
      );
      assert.match(polymarketCancelBlock, /cancelPolymarketOrderRoute/);
      assert.doesNotMatch(polymarketCancelBlock, /polymarketL2Request/);
      assert.doesNotMatch(
        polymarketCancelBlock,
        /fetchStoredOrderWalletContext/,
      );
      assert.doesNotMatch(
        polymarketCancelBlock,
        /syncPolymarketTradesForSigner/,
      );
      assert.doesNotMatch(polymarketCancelBlock, /createNotificationSafe/);

      const polymarketOrderHashBlock = sourceSlice(
        polymarketRoute,
        "   * POST /order-hash",
        "   * GET /funder-derive",
      );
      assert.match(polymarketOrderHashBlock, /computePolymarketOrderHashRoute/);
      assert.doesNotMatch(
        polymarketOrderHashBlock,
        /fetchPolymarketOrderHashV2/,
      );
      assert.doesNotMatch(polymarketOrderHashBlock, /normalizeOrderForHash/);
      assert.doesNotMatch(polymarketOrderHashBlock, /markHotTokens/);

      const polymarketFunderDeriveBlock = sourceSlice(
        polymarketRoute,
        "   * GET /funder-derive",
        "   * POST /funder-derive/batch",
      );
      assert.match(polymarketFunderDeriveBlock, /derivePolymarketFundersRoute/);
      assert.doesNotMatch(
        polymarketFunderDeriveBlock,
        /derivePolymarketFunders\(/,
      );
      assert.doesNotMatch(
        polymarketFunderDeriveBlock,
        /getVenueCredentialsInfo/,
      );

      const polymarketFunderDeriveBatchBlock = sourceSlice(
        polymarketRoute,
        "   * POST /funder-derive/batch",
        "   * POST /quote",
      );
      assert.match(
        polymarketFunderDeriveBatchBlock,
        /derivePolymarketFundersBatchRoute/,
      );
      assert.doesNotMatch(
        polymarketFunderDeriveBatchBlock,
        /derivePolymarketFunders\(/,
      );
      assert.doesNotMatch(
        polymarketFunderDeriveBatchBlock,
        /getVenueCredentialsInfo/,
      );

      const polymarketQuoteBlock = sourceSlice(
        polymarketRoute,
        "   * POST /quote",
        "   * POST /max-spend",
      );
      assert.match(polymarketQuoteBlock, /quotePolymarketOrderRoute/);
      assert.doesNotMatch(polymarketQuoteBlock, /quotePolymarketOrder\(/);
      assert.doesNotMatch(polymarketQuoteBlock, /PolymarketQuoteError/);
      assert.doesNotMatch(polymarketQuoteBlock, /markHotTokens/);

      const polymarketMaxSpendBlock = sourceSlice(
        polymarketRoute,
        "   * POST /max-spend",
        "   * GET /account",
      );
      assert.match(polymarketMaxSpendBlock, /computePolymarketMaxSpendRoute/);
      assert.doesNotMatch(polymarketMaxSpendBlock, /derivePolymarketFunders/);
      assert.doesNotMatch(
        polymarketMaxSpendBlock,
        /findMaxPolymarketMarketBuyUsdForFunds/,
      );
      assert.doesNotMatch(
        polymarketMaxSpendBlock,
        /fetchOpenOrderCollateralLocks/,
      );
      assert.doesNotMatch(polymarketMaxSpendBlock, /markHotTokens/);

      const polymarketAccountBlock = sourceSlice(
        polymarketRoute,
        "   * GET /account",
        '  z.get(\n    "/redemption-plan"',
      );
      assert.match(polymarketAccountBlock, /fetchPolymarketAccountRoute/);
      assert.doesNotMatch(polymarketAccountBlock, /fetchEvmCode/);
      assert.doesNotMatch(
        polymarketAccountBlock,
        /fetchPolymarketOnchainSnapshot/,
      );

      const polymarketRedemptionPlanBlock = sourceSlice(
        polymarketRoute,
        '  z.get(\n    "/redemption-plan"',
        '    "/embedded/ensure-ready/prepare"',
      );
      assert.match(
        polymarketRedemptionPlanBlock,
        /buildPolymarketRedemptionPlanRoute/,
      );
      assert.doesNotMatch(
        polymarketRedemptionPlanBlock,
        /buildPolymarketRedemptionPlan\(/,
      );
      assert.doesNotMatch(polymarketRedemptionPlanBlock, /polygonRpcUrl/);

      const polymarketEmbeddedEnsureReadyBlock = sourceSlice(
        polymarketRoute,
        '    "/embedded/ensure-ready/prepare"',
        '    "/embedded/sign-order/prepare"',
      );
      assert.match(
        polymarketEmbeddedEnsureReadyBlock,
        /prepareEmbeddedPolymarketEnsureReadyRoute/,
      );
      assert.match(
        polymarketEmbeddedEnsureReadyBlock,
        /executeEmbeddedPolymarketEnsureReadyRoute/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedEnsureReadyBlock,
        /fetchPolymarketOnchainSnapshot/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedEnsureReadyBlock,
        /prepareEmbeddedPolymarketSignerApprovalRequests/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedEnsureReadyBlock,
        /requestPolymarketCredentials/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedEnsureReadyBlock,
        /runEmbeddedExecutionSingleFlight/,
      );

      const polymarketEmbeddedSignOrderBlock = sourceSlice(
        polymarketRoute,
        '    "/embedded/sign-order/prepare"',
        '    "/embedded/sign-fee-auth/prepare"',
      );
      assert.match(
        polymarketEmbeddedSignOrderBlock,
        /prepareEmbeddedPolymarketOrderSignatureRoute/,
      );
      assert.match(
        polymarketEmbeddedSignOrderBlock,
        /executeEmbeddedPolymarketOrderSignatureRoute/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedSignOrderBlock,
        /buildEmbeddedPolymarketOrderRequest/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedSignOrderBlock,
        /executeEmbeddedPolymarketOrderRequest/,
      );

      const polymarketEmbeddedSignTypedDataBlock = sourceSlice(
        polymarketRoute,
        '    "/embedded/sign-typed-data/prepare"',
        "   * POST /orders/sync",
      );
      assert.match(
        polymarketEmbeddedSignTypedDataBlock,
        /prepareEmbeddedPolymarketTypedDataSignatureRoute/,
      );
      assert.match(
        polymarketEmbeddedSignTypedDataBlock,
        /executeEmbeddedPolymarketTypedDataSignatureRoute/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedSignTypedDataBlock,
        /buildEmbeddedPolymarketTypedDataRequest/,
      );
      assert.doesNotMatch(
        polymarketEmbeddedSignTypedDataBlock,
        /executeEmbeddedPolymarketTypedDataRequest/,
      );

      const polymarketOrdersSyncBlock = sourceSlice(
        polymarketRoute,
        "   * POST /orders/sync",
        "   * GET /orders/open",
      );
      assert.match(polymarketOrdersSyncBlock, /syncPolymarketOrdersRoute/);
      assert.doesNotMatch(polymarketOrdersSyncBlock, /polymarketL2Request/);
      assert.doesNotMatch(polymarketOrdersSyncBlock, /storeOrder/);
      assert.doesNotMatch(
        polymarketOrdersSyncBlock,
        /syncPolymarketTradesForSigner/,
      );

      const limitlessRoute = readFileSync(
        resolve(apiSrcDir, "routes/limitless-private.ts"),
        "utf8",
      );
      assert.doesNotMatch(limitlessRoute, /limitlessRequest/);
      assert.match(limitlessRoute, /connectLimitlessPartnerAccountRoute/);

      const limitlessAccountBlock = sourceSlice(
        limitlessRoute,
        "   * GET /account",
        "   * GET /amm/quote",
      );
      assert.match(limitlessAccountBlock, /fetchLimitlessAccountRoute/);
      assert.match(limitlessAccountBlock, /db: pool/);
      assert.doesNotMatch(limitlessAccountBlock, /fetchEvmCode/);
      assert.doesNotMatch(
        limitlessAccountBlock,
        /fetchLimitlessOnchainSnapshot/,
      );
      assert.doesNotMatch(limitlessAccountBlock, /fetchErc1155BalancesByOwner/);

      const limitlessService = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );
      const limitlessAccountServiceBlock = sourceSlice(
        limitlessService,
        "export async function fetchLimitlessAccountRoute",
        "function isBytes32",
      );
      assert.match(
        limitlessAccountServiceBlock,
        /fetchOpenOrderCollateralLocks/,
      );
      assert.match(
        limitlessAccountServiceBlock,
        /collateralLocks == null[\s\S]*limitless\.get\([\s\S]*\) \?\? 0n/,
        "a successful lock query with no open orders must report zero locked collateral",
      );
      assert.doesNotMatch(limitlessAccountServiceBlock, /locked-balance/);
      const limitlessAccountPayloadType = sourceSlice(
        limitlessService,
        "type LimitlessAccountPayload = {",
        "type LimitlessAccountCacheEntry",
      );
      assert.doesNotMatch(
        limitlessAccountPayloadType,
        /\brpcUrl\b/,
        "the authenticated account DTO must never expose server RPC URLs",
      );

      const polymarketService = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const polymarketAccountServiceBlock = sourceSlice(
        polymarketService,
        "export async function fetchPolymarketAccountRoute",
        "export async function syncPolymarketOrdersRoute",
      );
      assert.doesNotMatch(
        polymarketAccountServiceBlock,
        /funderIsContract:[\s\S]*?\brpcUrl\s*:/,
        "Polymarket account responses must not expose the server RPC URL",
      );

      const dflowRoute = readFileSync(
        resolve(apiSrcDir, "routes/dflow-private.ts"),
        "utf8",
      );
      const kalshiAccountBlock = sourceSlice(
        dflowRoute,
        "   * GET /account",
        "   * GET /order",
      );
      assert.doesNotMatch(
        kalshiAccountBlock,
        /\brpcUrl:\s*env\.solanaRpcUrl/,
        "Kalshi account responses must not expose the server RPC URL",
      );

      const fundingRuntime = readFileSync(
        resolve(apiSrcDir, "funding/preparation/runtime-service.ts"),
        "utf8",
      );
      assert.match(fundingRuntime, /fetchOpenOrderCollateralLocks/);
      assert.doesNotMatch(fundingRuntime, /locked-balance/);

      const limitlessAmmQuoteBlock = sourceSlice(
        limitlessRoute,
        "   * GET /amm/quote",
        "   * GET /redemption/status",
      );
      assert.match(limitlessAmmQuoteBlock, /quoteLimitlessAmmRoute/);
      assert.doesNotMatch(limitlessAmmQuoteBlock, /quoteLimitlessAmmTrade/);

      const limitlessRedemptionStatusBlock = sourceSlice(
        limitlessRoute,
        "   * GET /redemption/status",
        '    "/redemption-plan"',
      );
      assert.match(
        limitlessRedemptionStatusBlock,
        /fetchLimitlessRedemptionStatusRoute/,
      );
      assert.doesNotMatch(
        limitlessRedemptionStatusBlock,
        /fetchErc1155IsApprovedForAll/,
      );

      const limitlessRedemptionPlanBlock = sourceSlice(
        limitlessRoute,
        '    "/redemption-plan"',
        "   * POST /order",
      );
      assert.match(
        limitlessRedemptionPlanBlock,
        /buildLimitlessRedemptionPlanRoute/,
      );
      assert.doesNotMatch(
        limitlessRedemptionPlanBlock,
        /buildLimitlessRedemptionPlan\(/,
      );

      const limitlessOrderBlock = sourceSlice(
        limitlessRoute,
        "   * POST /order\n   */",
        "   * POST /orders/amm",
      );
      assert.match(limitlessOrderBlock, /submitLimitlessClientSignedOrder/);
      assert.doesNotMatch(limitlessOrderBlock, /limitlessRequest/);
      assert.doesNotMatch(limitlessOrderBlock, /storeOrder/);

      const limitlessAmmOrderBlock = sourceSlice(
        limitlessRoute,
        "   * POST /orders/amm",
        "   * POST /orders/sync",
      );
      assert.match(limitlessAmmOrderBlock, /recordLimitlessAmmOrder/);
      assert.match(
        limitlessAmmOrderBlock,
        /settlementMode: "legacy_assume_filled"/,
      );
      assert.match(limitlessAmmOrderBlock, /orderId: result\.payload\.orderId/);
      assert.doesNotMatch(limitlessAmmOrderBlock, /storeOrder/);
      assert.doesNotMatch(
        limitlessAmmOrderBlock,
        /applyOptimisticPositionTrade/,
      );

      const limitlessSyncBlock = sourceSlice(
        limitlessRoute,
        "   * POST /orders/sync",
        "   * POST /orders/history/sync",
      );
      assert.match(limitlessSyncBlock, /syncLimitlessOpenOrdersRoute/);
      assert.doesNotMatch(limitlessSyncBlock, /limitlessRequest/);
      assert.doesNotMatch(limitlessSyncBlock, /storeOrder/);

      const limitlessHistorySyncBlock = sourceSlice(
        limitlessRoute,
        "   * POST /orders/history/sync",
        "   * GET /market/exchange",
      );
      assert.match(limitlessHistorySyncBlock, /syncLimitlessOrderHistoryRoute/);
      assert.doesNotMatch(
        limitlessHistorySyncBlock,
        /syncLimitlessHistoryForWallet/,
      );
      assert.doesNotMatch(
        limitlessHistorySyncBlock,
        /resolveLimitlessAuthContext/,
      );

      const limitlessMarketExchangeBlock = sourceSlice(
        limitlessRoute,
        "   * GET /market/exchange",
        "   * GET /orders/:orderId",
      );
      assert.match(
        limitlessMarketExchangeBlock,
        /fetchLimitlessMarketExchangeRoute/,
      );
      assert.doesNotMatch(limitlessMarketExchangeBlock, /limitlessRequest/);
      assert.doesNotMatch(
        limitlessMarketExchangeBlock,
        /extractLimitlessMarketExchangeAddress/,
      );

      const limitlessEmbeddedSignPrepareBlock = sourceSlice(
        limitlessRoute,
        '    "/embedded/sign-order/prepare"',
        '    "/embedded/sign-order"',
      );
      assert.match(
        limitlessEmbeddedSignPrepareBlock,
        /prepareEmbeddedLimitlessOrderSigningRequest/,
      );
      assert.doesNotMatch(
        limitlessEmbeddedSignPrepareBlock,
        /limitlessRequest/,
      );
      const limitlessEmbeddedPrepareHelperBlock = sourceSlice(
        limitlessRoute,
        "async function prepareEmbeddedLimitlessOrderSigningRequest",
        "function getHeaderValue",
      );
      assert.match(
        limitlessEmbeddedPrepareHelperBlock,
        /resolveLimitlessEmbeddedOrderSigningContext/,
      );
      assert.doesNotMatch(
        limitlessEmbeddedPrepareHelperBlock,
        /limitlessRequest/,
      );

      const limitlessOrderFetchBlock = sourceSlice(
        limitlessRoute,
        "   * GET /orders/:orderId",
        "   * DELETE /order/:orderId",
      );
      assert.match(limitlessOrderFetchBlock, /fetchLimitlessOrderRoute/);
      assert.doesNotMatch(limitlessOrderFetchBlock, /limitlessRequest/);
      assert.doesNotMatch(
        limitlessOrderFetchBlock,
        /requireLimitlessPartnerAuth/,
      );

      const limitlessSingleCancelBlock = sourceSlice(
        limitlessRoute,
        "   * DELETE /order/:orderId",
        "   * POST /orders/cancel-batch",
      );
      assert.match(limitlessSingleCancelBlock, /cancelLimitlessOrderRoute/);
      assert.doesNotMatch(limitlessSingleCancelBlock, /limitlessRequest/);
      assert.doesNotMatch(limitlessSingleCancelBlock, /createNotificationSafe/);

      const limitlessBatchCancelBlock = sourceSlice(
        limitlessRoute,
        "   * POST /orders/cancel-batch",
        "   * DELETE /orders/all/:slug",
      );
      assert.match(
        limitlessBatchCancelBlock,
        /cancelLimitlessOrdersBatchRoute/,
      );
      assert.doesNotMatch(limitlessBatchCancelBlock, /limitlessRequest/);
      assert.doesNotMatch(limitlessBatchCancelBlock, /createNotificationSafe/);

      const limitlessCancelAllBlock = sourceSlice(
        limitlessRoute,
        "   * DELETE /orders/all/:slug",
        "   * GET /orders/open",
      );
      assert.match(limitlessCancelAllBlock, /cancelAllLimitlessOrdersRoute/);
      assert.doesNotMatch(limitlessCancelAllBlock, /limitlessRequest/);
      assert.doesNotMatch(limitlessCancelAllBlock, /createNotificationSafe/);

      const limitlessOpenOrdersBlock = sourceSlice(
        limitlessRoute,
        "   * GET /orders/open",
        "\n};\n",
      );
      assert.match(limitlessOpenOrdersBlock, /fetchLimitlessOpenOrdersRoute/);
      assert.doesNotMatch(limitlessOpenOrdersBlock, /limitlessRequest/);
      assert.doesNotMatch(
        limitlessOpenOrdersBlock,
        /requireLimitlessPartnerAuth/,
      );

      assert.match(dflowRoute, /buildKalshiDflowOrderRoute/);
      assert.match(dflowRoute, /quoteKalshiDflowRoute/);
      assert.match(dflowRoute, /buildKalshiDflowSwapRoute/);
      assert.match(dflowRoute, /submitKalshiDflowSignedTransactionRoute/);
      assert.match(dflowRoute, /recordKalshiDflowExecutionRoute/);
      const dflowOrderBlock = sourceSlice(
        dflowRoute,
        "   * GET /order",
        '  z.get(\n    "/order-status"',
      );
      assert.match(dflowOrderBlock, /buildKalshiDflowOrderRoute/);
      assert.doesNotMatch(dflowOrderBlock, /dflowRequest/);
    },
  },
  {
    name: "api trading common is a compatibility barrel over focused modules",
    run: () => {
      const common = readFileSync(
        resolve(apiSrcDir, "services/api-trading-common.ts"),
        "utf8",
      );
      assert.match(common, /api-trading-effects\.js/);
      assert.match(common, /api-trading-market-repo\.js/);
      assert.match(common, /api-trading-utils\.js/);
      assert.match(common, /api-trading-wallet-signing\.js/);
      assert.doesNotMatch(common, /from "\.\.\/env\.js"/);
      assert.doesNotMatch(common, /from "\.\.\/privy-service\.js"/);
      assert.doesNotMatch(common, /SELECT\s/i);
      assert.doesNotMatch(common, /storeOrder/);
    },
  },
  {
    name: "API trading execution services are API-owned and not imported by the sidecar",
    run: () => {
      const source = readFileSync(
        resolve(apiSrcDir, "services/api-trading-service.ts"),
        "utf8",
      );
      assert.doesNotMatch(source, /trading-adapters\.js/);
      assert.doesNotMatch(source, /VenueTradingRegistry/);
      assert.doesNotMatch(source, /new PolymarketTradingAdapter/);
      assert.doesNotMatch(source, /privy-service\.js/);
      assert.doesNotMatch(source, /polymarketL2Request/);
      assert.doesNotMatch(source, /dflow-trading-service\.js/);
      assert.doesNotMatch(source, /limitlessRequest/);
      assert.doesNotMatch(source, /if\s*\(\s*venue\s*===/);
      assert.match(source, /polymarket-trading-execution-service\.js/);
      assert.match(source, /limitless-trading-execution-service\.js/);
      assert.match(source, /kalshi-trading-execution-service\.js/);

      const polymarket = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const limitless = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );
      const kalshi = readFileSync(
        resolve(apiSrcDir, "services/kalshi-trading-execution-service.ts"),
        "utf8",
      );
      assert.match(polymarket, /polymarketL2Request/);
      assert.match(polymarket, /privy-service\.js|createServerWalletClient/);
      assert.match(limitless, /limitlessRequest/);
      assert.match(kalshi, /dflow-trading-service\.js/);
    },
  },
  {
    name: "Polymarket bot submit preserves REST retry and FOK confirmation safeguards",
    run: () => {
      const polymarket = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const sharedSubmitBlock = sourceSlice(
        polymarket,
        "async function submitPolymarketClobOrderWithRetry(",
        "function exchangeAddressForNegRisk",
      );
      assert.match(sharedSubmitBlock, /isPolymarketServiceNotReadyResponse/);
      assert.match(sharedSubmitBlock, /POLYMARKET_ORDER_RETRY_DELAYS_MS/);
      const restSubmitBlock = sourceSlice(
        polymarket,
        "export async function submitPolymarketClientSignedOrder(",
        "async function getReadiness(",
      );
      const submitBlock = sourceSlice(
        polymarket,
        "async function submitPreparedTrade(",
        "export function createPolymarketTradingExecutionService",
      );
      assert.match(restSubmitBlock, /submitPolymarketClobOrderWithRetry/);
      assert.match(submitBlock, /submitPolymarketClobOrderWithRetry/);
      assert.match(
        submitBlock,
        /invalidatePolymarketCredentialsForInvalidApiKey/,
      );
      assert.match(submitBlock, /waitForPolymarketExecutionConfirmation/);
      assert.match(submitBlock, /POLYMARKET_UNCONFIRMED_STATUS/);
      assert.doesNotMatch(submitBlock, /venueOrderId:\s*payload\.orderHash/);

      const persistBlock = sourceSlice(
        polymarket,
        "async function persistTrade(",
        "export function createPolymarketTradingExecutionService",
      );
      assert.match(persistBlock, /orderPayloadVersion: "polymarket_clob_v2"/);
      assert.doesNotMatch(persistBlock, /orderPayloadVersion: "v2"/);

      const executorBlock = sourceSlice(
        polymarket,
        "export function createPolymarketTradingExecutionService",
        "};\n}",
      );
      assert.match(executorBlock, /executePreparedTradeLifecycle/);
      assert.match(executorBlock, /persistTrade\(ctx, persistInput\)/);
      assert.match(
        executorBlock,
        /applyOrderTradeEffects\(ctx, effectsInput\)/,
      );
    },
  },
  {
    name: "REST and bot CLOB submits share upstream venue submit helpers",
    run: () => {
      const polymarket = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const limitless = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );

      const polymarketHelperCalls =
        polymarket.match(/submitPolymarketClobOrderWithRetry\(/g) ?? [];
      assert.equal(polymarketHelperCalls.length, 3);

      const limitlessSharedSubmitBlock = sourceSlice(
        limitless,
        "function submitLimitlessClobOrderToVenue(",
        "function extractLimitlessSubmittedOrder(",
      );
      assert.match(limitlessSharedSubmitBlock, /limitlessRequest/);
      assert.match(limitlessSharedSubmitBlock, /requestPath: "\/orders"/);

      const limitlessRestSubmitBlock = sourceSlice(
        limitless,
        "export async function submitLimitlessClientSignedOrder(",
        "export async function quoteLimitlessAmmRoute(",
      );
      const limitlessBotSubmitBlock = sourceSlice(
        limitless,
        "async function submitPreparedTrade(",
        "async function persistTrade(",
      );
      const limitlessRestSyncServiceBlock = sourceSlice(
        limitless,
        "export async function syncLimitlessOpenOrdersRoute(",
        "export async function syncLimitlessOrderHistoryRoute(",
      );
      assert.match(limitlessRestSubmitBlock, /submitLimitlessClobOrderToVenue/);
      assert.match(limitlessRestSubmitBlock, /resolveLimitlessRouteAuth/);
      assert.match(
        limitlessRestSubmitBlock,
        /marketContextId:\s*requestedRawTokenId/,
      );
      assert.doesNotMatch(
        limitlessRestSubmitBlock,
        /marketContextId:\s*tokenId/,
      );
      const limitlessAmmFundingClaimBlock = sourceSlice(
        limitless,
        "export async function claimLimitlessAmmFundingTrade(",
        "export async function startLimitlessAmmFundingTrade(",
      );
      assert.match(
        limitlessAmmFundingClaimBlock,
        /const marketContextId = normalizeLimitlessRawTokenId\(input\.body\.tokenId\)/,
      );
      assert.match(limitlessAmmFundingClaimBlock, /marketContextId,\s*spend:/);
      assert.match(
        limitlessRestSubmitBlock,
        /if \(input\.body\.orderType === "FOK"\)/,
      );
      assert.doesNotMatch(
        limitlessRestSubmitBlock,
        /limitPrice:\s*coercedPrice/,
      );
      assert.match(limitlessRestSyncServiceBlock, /resolveLimitlessRouteAuth/);
      assert.match(limitlessBotSubmitBlock, /submitLimitlessClobOrderToVenue/);
      assert.match(
        limitlessBotSubmitBlock,
        /if \(payload\.orderType === "FOK"\)/,
      );
      assert.doesNotMatch(
        limitlessBotSubmitBlock,
        /limitPrice:\s*payload\.price/,
      );
      assert.match(limitlessRestSubmitBlock, /extractLimitlessSubmittedOrder/);
      assert.match(limitlessBotSubmitBlock, /extractLimitlessSubmittedOrder/);
    },
  },
  {
    name: "funding trade endpoints expose stable domain errors and rethrow unknown failures",
    run: () => {
      const internalMessage =
        'relation "funding_trade_attempts" violates secret_constraint';
      const reservationError = toPublicFundingTradeError(
        new FundingPersistenceError(
          "invalid_state_transition",
          internalMessage,
        ),
      );
      assert.deepEqual(reservationError, {
        code: "funding_reservation_not_ready",
        error: "Funding reservation is not ready for this exact trade.",
      });
      assert.doesNotMatch(
        JSON.stringify(reservationError),
        /secret_constraint/,
      );

      const attemptError = toPublicFundingTradeError(
        new FundingTradeAttemptError("attempt_conflict", internalMessage),
      );
      assert.deepEqual(attemptError, {
        code: "funding_trade_reconciling",
        error: "This funding trade is already being reconciled.",
      });
      assert.doesNotMatch(JSON.stringify(attemptError), /secret_constraint/);

      const unknownError = new Error(internalMessage);
      assert.throws(
        () => toPublicFundingTradeError(unknownError),
        (error) => error === unknownError,
      );

      const polymarket = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const limitless = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );
      const polymarketFundingSubmit = sourceSlice(
        polymarket,
        "export async function submitPolymarketClientSignedOrder(",
        "async function getReadiness(",
      );
      const limitlessFundingSubmit = sourceSlice(
        limitless,
        "export async function submitLimitlessClientSignedOrder(",
        "export async function quoteLimitlessAmmRoute(",
      );
      const limitlessAmmFunding = sourceSlice(
        limitless,
        "export async function claimLimitlessAmmFundingTrade(",
        "export async function recordLimitlessAmmOrder(",
      );

      assert.equal(
        (polymarketFundingSubmit.match(/toPublicFundingTradeError\(/g) ?? [])
          .length,
        3,
      );
      assert.equal(
        (limitlessFundingSubmit.match(/toPublicFundingTradeError\(/g) ?? [])
          .length,
        4,
      );
      assert.equal(
        (limitlessAmmFunding.match(/toPublicFundingTradeError\(/g) ?? [])
          .length,
        3,
      );
      assert.doesNotMatch(polymarketFundingSubmit, /error\.message/);
      assert.doesNotMatch(limitlessFundingSubmit, /error\.message/);
      assert.doesNotMatch(limitlessAmmFunding, /error\.message/);
    },
  },
  {
    name: "bot order effects use persisted context and idempotency markers",
    run: () => {
      const effects = readFileSync(
        resolve(apiSrcDir, "services/api-trading-effects.ts"),
        "utf8",
      );
      assert.match(effects, /readPersistedRawField\(input, "tokenId"\)/);
      assert.match(effects, /readPersistedRawField\(input, "walletAddress"\)/);
      assert.match(effects, /readPersistedStoredOrder/);
      assert.match(effects, /positionDeltaApplied/);
      assert.match(effects, /applyOptimisticPositionTradeOnce/);
      assert.match(effects, /shouldNotifyOrder/);
      assert.match(effects, /input\.submitResult\.status !== "no_fill"/);
      assert.doesNotMatch(effects, /claimOrderPositionDeltaApplication/);
      assert.doesNotMatch(effects, /clearOrderPositionDeltaApplicationClaim/);
      const optimisticApplyBlock = sourceSlice(
        effects,
        "const result = await applyOptimisticPositionTradeOnce",
        "const shouldNotifyOrder",
      );
      assert.match(optimisticApplyBlock, /orderId: storedOrder\.id/);

      const polymarket = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const limitless = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );
      assert.match(polymarket, /tokenId: payload\.tokenId/);
      assert.match(polymarket, /walletAddress: payload\.positionWalletAddress/);
      assert.match(limitless, /tokenId: payload\.tokenId/);
      assert.match(limitless, /walletAddress: input\.intent\.walletAddress/);
    },
  },
  {
    name: "Telegram confirm delegates executable lifecycle to shared executor",
    run: () => {
      const telegramTrading = readFileSync(
        resolve(apiSrcDir, "services/telegram-bot-trading.ts"),
        "utf8",
      );
      const confirmLifecycleBlock = sourceSlice(
        telegramTrading,
        "const quote = await trading.quote({ intent: sharedIntent });",
        "const resolution = resolveSubmitIntentStatus(submitResult);",
      );
      const previewBlock = sourceSlice(
        telegramTrading,
        "async function previewTelegramTradeIntent(",
        "function normalizeTelegramTradeInputSyntax(",
      );
      assert.match(confirmLifecycleBlock, /trading\.prepareTrade/);
      assert.match(confirmLifecycleBlock, /trading\.executePreparedTrade/);
      assert.match(confirmLifecycleBlock, /onSubmitted/);
      assert.match(previewBlock, /resolveFundingReturnPreviewAllowedStatuses/);
      assert.equal(
        previewBlock.match(
          /allowedStatuses: fundingReturnPreviewAllowedStatuses/g,
        )?.length,
        2,
        "both server funding-return branches must use the action-aware CAS helper",
      );
      assert.match(
        confirmLifecycleBlock,
        /const recorded = await updateIntentStatus\([\s\S]*?if \(!recorded\) \{[\s\S]*?before setup transaction evidence was recorded/,
      );
      assert.doesNotMatch(
        confirmLifecycleBlock,
        /trading\.submitPreparedTrade/,
      );
      assert.doesNotMatch(confirmLifecycleBlock, /trading\.persistTrade/);
      assert.doesNotMatch(confirmLifecycleBlock, /trading\.applyTradeEffects/);

      // Funding reaching a canonical on-chain receipt before Polymarket's
      // CLOB balance endpoint catches up is a retryable visibility delay, not
      // a failed Buy. Keep the exact CAS transition and its no-broadcast
      // guards pinned: otherwise a funded Telegram Buy regresses to terminal.
      const fundingBalancePendingBlock = sourceSlice(
        telegramTrading,
        'normalized.code === "funding_balance_pending"',
        "if (submitted)",
      );
      assert.match(
        fundingBalancePendingBlock,
        /fundingResumedForExecution[\s\S]*?!submitStarted[\s\S]*?setupTransactions\.length === 0/,
      );
      assert.match(
        fundingBalancePendingBlock,
        /set status = 'funding',[\s\S]*?funding_reservation_id = null,[\s\S]*?error_code = 'funding_balance_pending'/,
      );
      assert.match(
        fundingBalancePendingBlock,
        /and status = 'executing'[\s\S]*?and submit_started_at is null/,
      );

      // After a funding broadcast, cancelling must stop only the Buy. The
      // transfer keeps reconciling and, once ready, its consumer reservation
      // is released to ordinary venue cash rather than a later auto-submit.
      const progressSource = readFileSync(
        resolve(apiSrcDir, "services/telegram-trade-lifecycle-progress.ts"),
        "utf8",
      );
      const cancelFundingBlock = sourceSlice(
        telegramTrading,
        "const cancellingFundingIntent =",
        "const exitsToMarket =",
      );
      assert.match(
        cancelFundingBlock,
        /external_boundary_crossed === false[\s\S]*?cancelFundingOperation[\s\S]*?else[\s\S]*?cancellingBuyContinuation = true/,
      );
      assert.match(
        progressSource,
        /canCancelBuy:[\s\S]*?candidate\.has_broadcast_boundary/,
      );
      assert.match(
        progressSource,
        /releaseFundingReservationForAbandonedTradeInTransaction[\s\S]*?telegram_buy_cancelled_after_funding/,
      );
      // A shortfall Buy has the same durable venue_order_id as a direct Buy.
      // Its terminal card must retain that copyable proof instead of showing
      // only the funding route.
      assert.match(progressSource, /intent\.venue_order_id/);
      assert.match(progressSource, /venueOrderId: candidate\.venue_order_id/);
      assert.match(
        progressSource,
        /formatTelegramFieldWithMarkdownV2\([\s\S]*?"Order"[\s\S]*?formatTelegramCodeMarkdownV2\(progress\.venueOrderId\)/,
      );
    },
  },
  {
    name: "optimistic position effects mark orders atomically with mutation",
    run: () => {
      const optimistic = readFileSync(
        resolve(apiSrcDir, "services/positions-optimistic.ts"),
        "utf8",
      );
      const onceBlock = sourceSlice(
        optimistic,
        "export async function applyOptimisticPositionTradeOnce(",
        "export async function applyVenueConfirmedPositionTrade(",
      );
      assert.match(onceBlock, /withPositionMutationLock/);
      assert.match(onceBlock, /from orders/);
      assert.match(onceBlock, /for update/);
      assert.match(onceBlock, /context_matches/);
      assert.match(onceBlock, /user_id = \$2/);
      assert.match(onceBlock, /venue = \$3/);
      assert.match(onceBlock, /token_id = \$4/);
      assert.match(onceBlock, /wallet_address = \$5/);
      assert.match(onceBlock, /signer_address = \$5/);
      assert.match(onceBlock, /order_context_mismatch/);
      assert.match(onceBlock, /positionDeltaAppliedSqlExpression/);
      assert.match(onceBlock, /applyPositionTradeDeltaInTx/);
      assert.match(onceBlock, /_hunchPositionDeltaAppliedAt/);
      assert.ok(
        onceBlock.indexOf("applyPositionTradeDeltaInTx") <
          onceBlock.indexOf("update orders"),
      );

      const limitlessHistory = readFileSync(
        resolve(apiSrcDir, "services/limitless-history.ts"),
        "utf8",
      );
      assert.match(limitlessHistory, /applyOptimisticPositionTradeOnce/);
      assert.match(
        limitlessHistory,
        /result\.kind === "stored" \|\| !result\.order\.position_delta_applied/,
      );
      assert.doesNotMatch(limitlessHistory, /markOrderPositionDeltaApplied/);
    },
  },
  {
    name: "venue persistence preserves venue-specific safety checks",
    run: () => {
      const limitless = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );
      const kalshi = readFileSync(
        resolve(apiSrcDir, "services/kalshi-trading-execution-service.ts"),
        "utf8",
      );
      const dflowRoute = readFileSync(
        resolve(apiSrcDir, "routes/dflow-private.ts"),
        "utf8",
      );

      const limitlessExchangeBlock = sourceSlice(
        limitless,
        "function extractLimitlessMarketExchangeAddress(",
        "function extractLimitlessMarketAdapterAddress(",
      );
      assert.match(limitlessExchangeBlock, /venueExchange/);
      assert.match(limitlessExchangeBlock, /venue_exchange/);
      assert.match(limitlessExchangeBlock, /negRiskExchange/);
      assert.match(
        limitless,
        /extractLimitlessMarketExchangeAddress\(market\.metadata\)/,
      );
      assert.match(
        limitless,
        /upsertLimitlessVenueShareAccrualFromOrderPayload/,
      );
      assert.match(limitless, /upstreamPayload/);
      assert.match(limitless, /isLimitlessBotClobExecutable/);
      assert.match(limitless, /limitless_clob_slippage_guard_unavailable/);
      assert.match(
        limitless,
        /CLOB bot trading is disabled until slippage can be enforced/,
      );

      assert.match(kalshi, /extractDflowErrorCode/);
      assert.match(kalshi, /code === "route_not_found"/);
      assert.doesNotMatch(
        kalshi,
        /upstream\.payload\.code === "route_not_found"/,
      );
      assert.match(kalshi, /resolveKalshiExecutionSettlementStatus/);
      assert.match(kalshi, /clientStatus/);
      assert.match(kalshi, /executionStatus = "submitted"/);
      assert.match(dflowRoute, /statusMode: "legacy_client_status"/);
      const kalshiRecordBlock = sourceSlice(
        kalshi,
        "export async function recordKalshiDflowExecutionRoute(",
        "function requireFreshKalshiEligibility(",
      );
      assert.match(
        kalshiRecordBlock,
        /statusMode\?: "legacy_client_status" \| "verified"/,
      );
      assert.match(
        kalshiRecordBlock,
        /const statusMode = input\.statusMode \?\? "verified"/,
      );
      assert.match(
        kalshiRecordBlock,
        /statusMode === "verified" && txSignature/,
      );
      assert.match(
        kalshiRecordBlock,
        /statusMode === "verified" && isClientTerminal/,
      );
    },
  },
  {
    name: "Telegram bot trade intent migration distinguishes unknown submit state",
    run: () => {
      const migration = readFileSync(
        resolve(
          apiSrcDir,
          "../../../packages/db/migrations/0168_telegram_trade_intent_submit_state.sql",
        ),
        "utf8",
      );
      assert.match(migration, /ADD COLUMN IF NOT EXISTS submit_started_at/);
      assert.match(migration, /'reconcile_required'/);
      assert.match(migration, /status NOT IN \('submitted', 'filled'\)/);
      assert.doesNotMatch(migration, /prepared_snapshot <> '\{\}'::jsonb/);

      const actionMigration = readFileSync(
        resolve(
          apiSrcDir,
          "../../../packages/db/migrations/0172_telegram_trade_intent_actions.sql",
        ),
        "utf8",
      );
      assert.match(actionMigration, /action IN \('buy', 'sell', 'redeem'\)/);
      assert.match(actionMigration, /sell_percent IN \(50, 100\)/);
      assert.match(actionMigration, /shares_raw::numeric > 0/);
      assert.match(actionMigration, /action = 'redeem'[\s\S]*side IS NULL/);
    },
  },
  {
    name: "API trading execution validates setup before venue side effects",
    run: async () => {
      const trading = createApiTradingApplicationService({
        pool: {
          query: async () => ({ rows: [], rowCount: 0 }),
        } as unknown as Pool,
      });
      const intent = {
        action: "BUY" as const,
        actor: {
          kind: "telegram_bot" as const,
          userId: "user-1",
        },
        amount: { type: "usd" as const, value: "10" },
        idempotencyKey: "intent-1",
        target: {
          eventId: "event-1",
          marketId: "market-1",
          outcome: "YES",
          title: "Market",
          tokenId: null,
          venue: "polymarket" as const,
          venueMarketId: "venue-market-1",
        },
        venue: "polymarket" as const,
        walletAddress: "",
        walletChain: "ethereum" as const,
      };
      await assert.rejects(
        trading.quote({ intent }),
        /Trade target market id is required|Market not found/,
      );
      await assert.rejects(
        trading.prepareTrade({ intent, quote: null }),
        /Market not found/,
      );

      const executionSource = readFileSync(
        resolve(apiSrcDir, "services/polymarket-trading-execution-service.ts"),
        "utf8",
      );
      const ensureBlock = sourceSlice(
        executionSource,
        "async function ensureReadiness(",
        "async function quote(",
      );
      assert.match(ensureBlock, /action: input\.action \?\? "BUY"/);
      const prepareBlock = sourceSlice(
        executionSource,
        "async function prepareTrade(",
        "function extractPolymarketMessage",
      );
      const preflightIndex = prepareBlock.indexOf(
        "assertPolymarketPreparedFunds",
      );
      const fundingIndex = prepareBlock.indexOf(
        "executePolymarketSetupTransaction",
      );
      const builderValidationIndex = prepareBlock.indexOf(
        "validatePolymarketOrderBuilderCodeForConfig",
      );
      assert.notEqual(preflightIndex, -1);
      assert.notEqual(fundingIndex, -1);
      assert.notEqual(builderValidationIndex, -1);
      // Router movement belongs to the durable polymarket_deposit_pusd_fund_v1
      // profile. A reservation-backed Telegram Buy must therefore be rejected
      // before prepareTrade can issue a direct Router setup transaction, so
      // anchor this on the Router branch rather than on the unrelated
      // controller pUSD approval branch that shares the same expression.
      const routerGuardIndex = prepareBlock.indexOf(
        "const useLegacyTelegramFunding",
      );
      const routerSendIndex = prepareBlock.indexOf('kind: "funding_router"');
      assert.notEqual(routerGuardIndex, -1);
      assert.notEqual(routerSendIndex, -1);
      assert.ok(routerGuardIndex < routerSendIndex);
      const routerGuardBlock = prepareBlock.slice(
        routerGuardIndex,
        routerSendIndex,
      );
      assert.match(
        routerGuardBlock,
        /intent\.actor\.kind === "telegram_bot" && !intent\.fundingReservation/,
      );
      assert.match(
        routerGuardBlock,
        /if \(!useLegacyTelegramFunding\)[\s\S]*?throw tradingError/,
      );
      const setupExecutorBlock = sourceSlice(
        executionSource,
        "async function executePolymarketSetupTransaction(",
        "function readMakerAmountFromOrderPayload",
      );
      const setupFenceIndex = prepareBlock.indexOf(
        "onBeforeBroadcast: enterSetupBroadcastBoundary",
      );
      assert.match(
        setupExecutorBlock,
        /onBeforeBroadcast\?\.\(\)[\s\S]*?onSubmitted\?\.\(\{[\s\S]*?transactionId: null,[\s\S]*?txHash: null[\s\S]*?executeServerEmbeddedEthereumTransaction/,
      );
      assert.match(
        prepareBlock,
        /onBeforeBroadcast: enterSetupBroadcastBoundary/,
      );
      assert.match(prepareBlock, /syncPolymarketCollateralAfterFunding/);
      assert.match(
        prepareBlock,
        /intent\.actor\.kind === "telegram_bot" && intent\.fundingReservation[\s\S]*?syncPolymarketCollateralAfterFunding[\s\S]*?let executableFunds = await resolvePolymarketMaxSpendFunds/,
      );
      assert.ok(preflightIndex > builderValidationIndex);
      assert.ok(setupFenceIndex > preflightIndex);
      assert.ok(fundingIndex > preflightIndex);
      const factoryStart = executionSource.indexOf(
        "export function createPolymarketTradingExecutionService",
      );
      assert.notEqual(factoryStart, -1);
      const factoryBlock = executionSource.slice(factoryStart);
      assert.match(
        factoryBlock,
        /prepareTrade: \(input\) => prepareTrade\(ctx, input\)/,
      );
      assert.doesNotMatch(
        factoryBlock,
        /prepareTrade\(ctx, \{ intent: input\.intent/,
      );
      const accountBlock = sourceSlice(
        executionSource,
        "export async function fetchPolymarketAccountRoute",
        "export async function syncPolymarketOrdersRoute",
      );
      assert.doesNotMatch(
        accountBlock,
        /resolvePolymarketBotPolicyFundingCapRaw|fundingMaxRaw/,
      );
      const quoteRouteBlock = sourceSlice(
        executionSource,
        "export async function quotePolymarketOrderRoute",
        "export async function derivePolymarketFundersRoute",
      );
      assert.doesNotMatch(quoteRouteBlock, /fundingCapRaw:/);

      const envSource = readFileSync(resolve(apiSrcDir, "env.ts"), "utf8");
      assert.match(envSource, /0x0fEF62E1CD0600C132070855A45443852940EE72/);
      assert.match(
        envSource,
        /POLYMARKET_FUNDING_ROUTER_ADDRESS must be the verified immutable router/,
      );
    },
  },
  {
    name: "Telegram trading presentation never discloses managed funding addresses",
    run: () => {
      const source = readFileSync(
        resolve(apiSrcDir, "services/telegram-bot-trading.ts"),
        "utf8",
      );
      assert.doesNotMatch(
        source,
        /formatTelegramCodeMarkdownV2\([\s\S]{0,160}(?:wallet_address|walletAddress|funderAddress)/u,
      );
      assert.doesNotMatch(source, /Canonical deposit wallet|Internal wallet/u);
      assert.match(source, /canonicalWalletIdentity\(walletChain, address\)/u);
      assert.match(
        source,
        /sameAccountAddress\(\s*"evm:137",\s*credentials\.funderAddress,\s*context\.funderAddress/u,
      );
      assert.doesNotMatch(source, /funderAddress\?\.toLowerCase\(\)/u);
    },
  },
  {
    name: "signal bot trading runtime import graph does not reach API-wide env",
    run: () => {
      const graph = collectRuntimeImportGraph("signal-bot-runner.ts");
      assert.equal(
        graph.has(resolve(apiSrcDir, "env.ts")),
        false,
        "signal-bot-runner runtime imports must not transitively reach env.ts",
      );
      assert.equal(
        graph.has(resolve(apiSrcDir, "services/api-trading-service.ts")),
        false,
        "signal-bot-runner runtime imports must not transitively reach API trading execution",
      );
      const runnerSource = readFileSync(
        resolve(apiSrcDir, "signal-bot-runner.ts"),
        "utf8",
      );
      assert.match(runnerSource, /signal_bot_trading_internal_api_error/);
      for (const operation of [
        "status",
        "market-card",
        "disable",
        "callback",
      ]) {
        assert.match(
          runnerSource,
          new RegExp(`logTradingInternalApiFailure\\("${operation}"`),
        );
      }
    },
  },
  {
    name: "funding reconciliation sidecar import graph stays API-secret free",
    run: () => {
      const graph = collectRuntimeImportGraph(
        "funding/worker/funding-reconciliation-worker.ts",
      );
      assert.equal(
        graph.has(resolve(apiSrcDir, "env.ts")),
        false,
        "funding reconciliation runtime imports must not transitively reach env.ts",
      );
      assert.equal(
        graph.has(resolve(apiSrcDir, "services/telegram-bot-trading.ts")),
        false,
        "funding projection must not import API trading execution",
      );
      assert.equal(
        graph.has(
          resolve(apiSrcDir, "account-value/pyth-sol-usd-price-adapter.ts"),
        ),
        false,
        "finance-worker funding must not import the API-only Pyth reader",
      );
      assert.equal(
        graph.has(resolve(apiSrcDir, "account-value/runtime-read-service.ts")),
        false,
        "finance-worker funding must not import the API snapshot runtime",
      );
    },
  },
];

for (const test of tests) {
  await test.run();
  console.log(`ok - ${test.name}`);
}
