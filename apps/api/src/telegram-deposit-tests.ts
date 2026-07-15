import assert from "node:assert/strict";

import { Interface } from "ethers";

import { handleSignalBotInteractiveMenuCallback } from "./services/telegram-bot-menu-actions.js";
import {
  buildTelegramDepositMessage,
  resolveCanonicalPolymarketDeposit,
  resolveCanonicalPolymarketDepositAddress,
} from "./services/telegram-bot-deposit.js";

const DEPOSIT_PREFIX =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af4";
const fundingRouter = new Interface([
  "function depositWalletOf(address owner) view returns (address)",
]);

function depositRuntime(owner: string): string {
  const prefixBytes = (DEPOSIT_PREFIX.length - 2) / 2;
  return `${DEPOSIT_PREFIX}${"00".repeat(125 - prefixBytes - 20)}${owner.slice(2)}`;
}

function depositDb(owner: string, deposit: string) {
  return {
    query: async () => ({
      rows: [{ funder_address: deposit, wallet_address: owner }],
    }),
  } as never;
}

const owner = "0x1111111111111111111111111111111111111111";
const otherOwner = "0x2222222222222222222222222222222222222222";
const deposit = "0x3333333333333333333333333333333333333333";
const router = "0x4444444444444444444444444444444444444444";
const productionOwner = "0x09c88f1d3cdD98C356A21434Cd4Af40CcE795314";
const productionDeposit = "0x496f46AA7500563E7f577D12CB8193421F2963C7";

function dependencies(derived = deposit, runtimeOwner = owner) {
  return {
    fetchCall: async () =>
      fundingRouter.encodeFunctionResult("depositWalletOf", [derived]),
    fetchCode: async () => depositRuntime(runtimeOwner),
    fundingRouterAddress: router,
    polygonRpcTimeoutMs: 1_000,
    polygonRpcUrl: "http://polygon.invalid",
  };
}

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "deposit resolver accepts mixed-case canonical production vector",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(productionOwner, productionDeposit),
          dependencies: {
            ...dependencies(productionDeposit, productionOwner.toLowerCase()),
            fetchCode: async () =>
              depositRuntime(productionOwner.toLowerCase()),
          },
          telegramUserId: 20,
        }),
        { address: productionDeposit, status: "ready" },
      );
    },
  },
  {
    name: "deposit resolver requires stored, derived, and runtime owner agreement",
    run: async () => {
      assert.equal(
        await resolveCanonicalPolymarketDepositAddress({
          db: depositDb(owner, deposit),
          dependencies: dependencies(),
          telegramUserId: 20,
        }),
        deposit,
      );
      assert.equal(
        await resolveCanonicalPolymarketDepositAddress({
          db: depositDb(owner, deposit),
          dependencies: dependencies(otherOwner),
          telegramUserId: 20,
        }),
        null,
      );
      assert.equal(
        await resolveCanonicalPolymarketDepositAddress({
          db: depositDb(owner, deposit),
          dependencies: dependencies(deposit, otherOwner),
          telegramUserId: 20,
        }),
        null,
      );
    },
  },
  {
    name: "deposit resolver distinguishes RPC errors and missing router",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: {
            ...dependencies(),
            fetchCall: async () => {
              throw new Error("RPC unavailable");
            },
          },
          telegramUserId: 20,
        }),
        { address: null, status: "temporarily_unavailable" },
      );
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: { fundingRouterAddress: null },
          telegramUserId: 20,
        }),
        { address: null, status: "temporarily_unavailable" },
      );
    },
  },
  {
    name: "deposit message does not misreport RPC failure as missing setup",
    run: async () => {
      const message = await buildTelegramDepositMessage({
        appBaseUrl: "https://app.hunch.trade",
        dependencies: {
          ...dependencies(),
          fetchCall: async () => {
            throw new Error("RPC unavailable");
          },
        },
        pool: depositDb(owner, deposit),
        telegramUserId: 20,
      });
      assert.match(message.text, /temporarily unavailable/);
      assert.doesNotMatch(message.text, /Finish Trading Wallet setup/);
    },
  },
  {
    name: "QR keeps the contextual Deposit card and sends only the photo",
    run: async () => {
      let renderCalls = 0;
      let photoCalls = 0;
      await handleSignalBotInteractiveMenuCallback({
        callbackPrefix: "hm:v1:",
        chatId: "20",
        loadDeposit: async () => ({
          qrText: deposit,
          text: "Generic deposit",
        }),
        messageId: 42,
        redis: { get: async () => null },
        render: async () => {
          renderCalls += 1;
        },
        renderExpiredSearch: async () => undefined,
        route: { kind: "deposit", showQr: true, venue: "polymarket" },
        sendPhoto: async () => {
          photoCalls += 1;
        },
        telegramUserId: 20,
      });
      assert.equal(renderCalls, 0);
      assert.equal(photoCalls, 1);
    },
  },
];

for (const test of tests) {
  try {
    await test.run();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    console.error(`✗ ${test.name}`);
    throw error;
  }
}
