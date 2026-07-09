#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type TestCase = {
  name: string;
  run: () => void;
};

const root = dirname(fileURLToPath(import.meta.url));

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker ${end}`);
  return source.slice(startIndex, endIndex);
}

function sliceWindow(source: string, start: string, length: number): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker ${start}`);
  return source.slice(startIndex, startIndex + length);
}

const tests: TestCase[] = [
  {
    name: "Polymarket bot prepare uses quote fee snapshot and fee-inclusive spend",
    run: () => {
      const source = read("services/polymarket-trading-execution-service.ts");
      const prepare = sliceBetween(
        source,
        "async function prepareTrade(",
        "function extractPolymarketMessage(",
      );
      assert.match(prepare, /readPolymarketFeePolicySnapshot/);
      assert.match(prepare, /totalRequiredUsdcRaw/);
      assert.match(prepare, /requiredSpendRaw/);
      assert.match(
        prepare,
        /executableFunds\.executableFundsRaw < requiredSpendRaw/,
      );
      assert.match(prepare, /!executableFunds\.buyApproval\.ok/);
      assert.doesNotMatch(
        prepare,
        /resolvePolymarketFeePolicySnapshot\(ctx\.pool\)/,
      );
    },
  },
  {
    name: "Polymarket bot readiness fails closed on missing buy approvals",
    run: () => {
      const source = read("services/polymarket-trading-execution-service.ts");
      const readiness = sliceBetween(
        source,
        "async function getReadiness(",
        "async function quote(",
      );
      assert.match(readiness, /negRisk: targetMarket/);
      assert.match(readiness, /!funds\.buyApproval\.ok/);
      assert.match(readiness, /Polymarket buy approvals are missing/);
    },
  },
  {
    name: "DFlow submit gates and validates Kalshi transactions before broadcast",
    run: () => {
      const source = read("routes/dflow-private.ts");
      const submit = sliceWindow(source, '"/submit"', 5_000);
      assert.match(submit, /ensureDflowReady\(reply\)/);
      assert.match(submit, /deriveKalshiDflowTransactionContext/);
      assert.match(submit, /strictKalshiSubmit && !userPublicKey/);
      assert.match(submit, /strictKalshiSubmit && !context/);
      assert.match(submit, /strictKalshiSubmit \|\| context/);
      assert.match(submit, /enforceKalshiProof/);
      assert.match(submit, /validateKalshiDflowTransaction/);
      assert.match(submit, /submitKalshiDflowSignedTransactionRoute/);
      assert.match(submit, /context\?\.inputMint === env\.solanaUsdcMint/);
      assert.ok(
        submit.indexOf("validateKalshiDflowTransaction") <
          submit.indexOf("submitKalshiDflowSignedTransactionRoute"),
      );
      const routes = read("routes/index.ts");
      assert.match(routes, /prefix: "\/trade\/kalshi"[\s\S]*strictKalshiSubmit: true/);
      assert.match(routes, /prefix: "\/trade\/dflow"[\s\S]*strictKalshiSubmit: false/);
    },
  },
  {
    name: "Telegram marks submit started only from pre-broadcast hook",
    run: () => {
      const source = read("services/telegram-bot-trading.ts");
      const preparedUpdate = sliceBetween(
        source,
        "const preparedRecorded = await updateIntentStatus({",
        "    if (!preparedRecorded)",
      );
      assert.match(preparedUpdate, /preparedSnapshot/);
      assert.doesNotMatch(preparedUpdate, /markSubmitStarted: true/);
      const confirm = sliceWindow(
        source,
        "const preparedRecorded = await updateIntentStatus",
        3_000,
      );
      assert.match(confirm, /onBeforeBroadcast: async/);
      assert.match(confirm, /markSubmitStarted: true/);
      assert.ok(
        confirm.indexOf("onBeforeBroadcast: async") <
          confirm.indexOf("markSubmitStarted: true"),
      );
    },
  },
  {
    name: "Kalshi validator fails closed on transient balance errors and uses RPC timeouts",
    run: () => {
      const source = read("services/kalshi-dflow-transaction-safety.ts");
      assert.match(source, /function createTimedSolanaConnection/);
      const lookup = sliceBetween(
        source,
        "async function fetchAddressLookupTableAccounts(",
        "function resolveTransactionAccounts(",
      );
      assert.match(lookup, /createTimedSolanaConnection/);
      assert.match(lookup, /input\.rpcTimeoutMs/);
      const balance = sliceBetween(
        source,
        "async function fetchTokenBalanceRaw(",
        "export const kalshiDflowTransactionSafetyTestHooks",
      );
      assert.match(balance, /isMissingSolanaTokenAccountError/);
      assert.doesNotMatch(balance, /if \(!input\.required\) return 0n/);
      const simulation = sliceBetween(
        source,
        "async function loadKalshiDflowTransactionSimulation(",
        "export async function validateKalshiDflowTransaction(",
      );
      assert.match(simulation, /createTimedSolanaConnection/);
      assert.match(simulation, /DEFAULT_SOLANA_RPC_TIMEOUT_MS/);
    },
  },
  {
    name: "Limitless AMM marks submit started before approval side effects",
    run: () => {
      const source = read("services/limitless-trading-execution-service.ts");
      const ammSubmit = sliceBetween(
        source,
        "async function submitLimitlessAmmPreparedTrade(",
        "function parseLimitlessPreparedPayload(",
      );
      assert.match(ammSubmit, /const markBeforeBroadcast = async/);
      assert.ok(
        ammSubmit.indexOf("await markBeforeBroadcast();") <
          ammSubmit.indexOf('label: "Limitless AMM USDC approval"'),
      );
      assert.ok(
        ammSubmit.lastIndexOf("await markBeforeBroadcast();") <
          ammSubmit.indexOf('label: "Limitless AMM buy"'),
      );
    },
  },
  {
    name: "Telegram intent locking is market scoped and cancels stale siblings",
    run: () => {
      const source = read("services/telegram-bot-trading.ts");
      const lock = sliceBetween(
        source,
        "async function lockTelegramIntentMarket(",
        "async function transitionIntentToConfirming(",
      );
      assert.match(lock, /marketId/);
      assert.doesNotMatch(lock, /side/);
      const transition = sliceBetween(
        source,
        "async function transitionIntentToConfirming(",
        "async function updateIntentStatus(",
      );
      assert.match(transition, /superseded_by_intent/);
      assert.match(transition, /status = ANY\(\$4::text\[\]\)/);
      assert.match(transition, /\["draft", "previewed"\]/);
      assert.match(transition, /market_id = \$2/);
      assert.doesNotMatch(transition, /side:/);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed += 1;
  } catch (error) {
    console.error(`[trading-ready-static-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[trading-ready-static-tests] passed ${passed}/${tests.length}`);
