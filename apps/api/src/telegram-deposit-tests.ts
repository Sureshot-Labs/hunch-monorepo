import assert from "node:assert/strict";

import { Interface } from "ethers";

import { handleSignalBotInteractiveMenuCallback } from "./services/telegram-bot-menu-actions.js";
import { recordTelegramDepositResolutionAnalytics } from "./services/telegram-lifecycle-analytics.js";
import {
  buildTelegramDepositAddressPresentation,
  buildTelegramDepositMessage,
  resolveCanonicalLimitlessDeposit,
  resolveCanonicalPolymarketDeposit,
  resolveCanonicalPolymarketDepositAddress,
  type TelegramDepositResolverDependencies,
} from "./services/telegram-bot-deposit.js";
import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";

const DEPOSIT_PREFIX =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af4";
const fundingRouter = new Interface([
  "function depositWalletOf(address owner) view returns (address)",
]);
const depositWallet = new Interface([
  "function owner() view returns (address)",
]);

function depositRuntime(owner: string): string {
  const prefixBytes = (DEPOSIT_PREFIX.length - 2) / 2;
  return `${DEPOSIT_PREFIX}${"00".repeat(125 - prefixBytes - 20)}${owner.slice(2)}`;
}

function depositDb(owner: string, deposit: string) {
  return depositRowsDb([{ funder_address: deposit, wallet_address: owner }]);
}

function depositRowsDb(
  rows: Array<{ funder_address: string; wallet_address: string }>,
) {
  return {
    query: async () => ({ rows }),
  } as never;
}

function authorizationDb(walletAddress: string | null) {
  return {
    query: async () => ({
      rows: walletAddress == null ? [] : [{ wallet_address: walletAddress }],
    }),
  } as never;
}

const owner = "0x1111111111111111111111111111111111111111";
const otherOwner = "0x2222222222222222222222222222222222222222";
const deposit = "0x3333333333333333333333333333333333333333";
const router = "0x4444444444444444444444444444444444444444";
const productionOwner = "0x09c88f1d3cdD98C356A21434Cd4Af40CcE795314";
const productionDeposit = "0x496f46AA7500563E7f577D12CB8193421F2963C7";

function dependencies(
  derived = deposit,
  contractOwner = owner,
  runtime = depositRuntime(contractOwner),
): TelegramDepositResolverDependencies {
  return {
    fetchCall: async ({ to }) =>
      to.toLowerCase() === router.toLowerCase()
        ? fundingRouter.encodeFunctionResult("depositWalletOf", [derived])
        : depositWallet.encodeFunctionResult("owner", [contractOwner]),
    fetchCode: async () => runtime,
    fundingRouterAddress: router,
    polygonRpcTimeoutMs: 1_000,
    polygonRpcUrl: "http://polygon.invalid",
  };
}

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "Limitless deposit prefers the internal Telegram signer",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalLimitlessDeposit({
          db: authorizationDb(otherOwner),
          internalWallets: [
            { walletAddress: owner, walletChain: "ethereum" },
            { walletAddress: otherOwner, walletChain: "ethereum" },
          ],
          telegramUserId: 20,
        }),
        { address: otherOwner, reason: null, status: "ready" },
      );
    },
  },
  {
    name: "Limitless deposit uses only an unambiguous internal EVM wallet",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalLimitlessDeposit({
          db: authorizationDb(null),
          internalWallets: [
            { walletAddress: owner, walletChain: "ethereum" },
            { walletAddress: "solana-wallet", walletChain: "solana" },
          ],
          telegramUserId: 20,
        }),
        { address: owner, reason: null, status: "ready" },
      );
      assert.deepEqual(
        await resolveCanonicalLimitlessDeposit({
          db: authorizationDb("0x5555555555555555555555555555555555555555"),
          internalWallets: [
            { walletAddress: owner, walletChain: "ethereum" },
            { walletAddress: otherOwner, walletChain: "ethereum" },
          ],
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "owner_mismatch",
          status: "verification_failed",
        },
      );
      assert.deepEqual(
        await resolveCanonicalLimitlessDeposit({
          db: authorizationDb(null),
          internalWallets: [],
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "setup_required",
          status: "setup_required",
        },
      );
    },
  },
  {
    name: "Deposit menu exposes active supported venues and Limitless Base address",
    run: async () => {
      const menu = await buildTelegramDepositMessage({
        appBaseUrl: "https://app.hunch.trade",
        dependencies: { allowedVenues: ["polymarket", "limitless"] },
        pool: authorizationDb(null),
        telegramUserId: 20,
      });
      assert.match(menu.text, /Polymarket[\s\S]*Polygon/);
      assert.match(menu.text, /Limitless[\s\S]*Base/);
      assert.match(menu.text, new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id));
      assert.match(JSON.stringify(menu.reply_markup), /deposit:limitless/);
      const venueButtons = menu.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        venueButtons.find((button) => button.text === "Polymarket")
          ?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.polymarket.id,
      );
      assert.equal(
        venueButtons.find((button) => button.text === "Limitless")
          ?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.limitless.id,
      );
      assert.doesNotMatch(menu.text, /Kalshi/);

      const limitless = await buildTelegramDepositMessage({
        appBaseUrl: "https://app.hunch.trade",
        internalWallets: [{ walletAddress: owner, walletChain: "ethereum" }],
        pool: authorizationDb(owner),
        telegramMiniAppEnabled: true,
        telegramUserId: 20,
        venue: "limitless",
      });
      assert.equal(limitless.depositAddress, owner);
      assert.equal(limitless.qrText, owner);
      assert.equal(limitless.venue, "limitless");
      assert.match(limitless.text, /\*Network:\* Base/);
      assert.match(limitless.text, /\*Asset:\* USDC/);
      assert.match(limitless.text, new RegExp(TELEGRAM_CUSTOM_EMOJI.base.id));
      assert.match(limitless.text, new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id));
      const markup = JSON.stringify(limitless.reply_markup);
      assert.match(markup, /deposit_qr:limitless/);
      assert.match(markup, /venue=limitless/);
      assert.match(
        markup,
        /address=0x1111111111111111111111111111111111111111/,
      );
    },
  },
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
        { address: productionDeposit, reason: null, status: "ready" },
      );
    },
  },
  {
    name: "deposit resolver verifies beacon-style runtime through owner()",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: dependencies(deposit, owner, "0x6001600055"),
          telegramUserId: 20,
        }),
        { address: deposit, reason: null, status: "ready" },
      );
    },
  },
  {
    name: "linked user with a beacon wallet gets a ready deposit card and QR controls",
    run: async () => {
      const calls: string[] = [];
      const message = await buildTelegramDepositMessage({
        appBaseUrl: "https://app.hunch.trade",
        dependencies: dependencies(deposit, owner, "0x6001600055"),
        pool: {
          query: async (sql: string) => {
            calls.push(sql);
            if (/join user_venue_credentials/i.test(sql)) {
              return {
                rows: [
                  {
                    funder_address: deposit,
                    wallet_address: owner,
                  },
                ],
              };
            }
            if (/select user_id/i.test(sql)) {
              return { rows: [{ user_id: "new-linked-user" }] };
            }
            return { rows: [] };
          },
        } as never,
        telegramMiniAppEnabled: true,
        telegramUserId: 20,
        venue: "polymarket",
      });
      assert.equal(message.depositAddress, deposit);
      assert.equal(message.qrText, deposit);
      assert.match(message.text, new RegExp(deposit));
      assert.match(message.text, /\*Network:\* Polygon/);
      assert.match(message.text, /\*Assets:\* pUSD or USDC\\\.e/);
      assert.match(message.text, /📍 \*Deposit address\*/);
      assert.ok(message.text.includes(`\`${deposit}\``));
      assert.match(message.text, />⚠️ \*Important\*/);
      assert.match(
        message.text,
        />Send only \*pUSD\* or \*USDC\\\.e\* on \*Polygon\*/,
      );
      assert.doesNotMatch(message.text, /setup|required|not configured/i);
      const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        buttons.some(
          (button) =>
            "copy_text" in button && button.copy_text.text === deposit,
        ),
        true,
      );
      assert.equal(
        buttons.find((button) => "copy_text" in button)?.text,
        "📋 Copy address",
      );
      assert.equal(
        buttons.some(
          (button) =>
            "callback_data" in button &&
            button.callback_data === "hm:v1:deposit_qr:polymarket",
        ),
        true,
      );
      assert.equal(
        buttons.some((button) => "web_app" in button),
        true,
      );
      assert.equal(
        calls.some((sql) => /analytics_server_events/i.test(sql)),
        true,
      );
    },
  },
  {
    name: "deposit resolver reports deterministic verification reasons",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: dependencies(otherOwner),
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "router_mismatch",
          status: "verification_failed",
        },
      );
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: dependencies(deposit, owner, "0x"),
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "missing_code",
          status: "verification_failed",
        },
      );
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: dependencies(deposit, otherOwner, "0x6001"),
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "owner_mismatch",
          status: "verification_failed",
        },
      );
    },
  },
  {
    name: "deposit resolver skips stale credentials and accepts a later canonical wallet",
    run: async () => {
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositRowsDb([
            {
              funder_address: "0x5555555555555555555555555555555555555555",
              wallet_address: otherOwner,
            },
            { funder_address: deposit, wallet_address: owner },
          ]),
          dependencies: dependencies(deposit, owner, "0x6001"),
          telegramUserId: 20,
        }),
        { address: deposit, reason: null, status: "ready" },
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
        {
          address: null,
          reason: "rpc_unavailable",
          status: "temporarily_unavailable",
        },
      );
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: depositDb(owner, deposit),
          dependencies: { fundingRouterAddress: null },
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "rpc_unavailable",
          status: "temporarily_unavailable",
        },
      );
      assert.deepEqual(
        await resolveCanonicalPolymarketDeposit({
          db: {
            query: async () => {
              throw new Error("database unavailable");
            },
          } as never,
          dependencies: dependencies(),
          telegramUserId: 20,
        }),
        {
          address: null,
          reason: "rpc_unavailable",
          status: "temporarily_unavailable",
        },
      );
    },
  },
  {
    name: "deposit presentation exposes address, copy, and on-demand QR separately",
    run: () => {
      const presentation = buildTelegramDepositAddressPresentation({
        address: deposit,
        venue: "polymarket",
      });
      assert.match(presentation.lines.join("\n"), new RegExp(deposit));
      assert.deepEqual(presentation.buttonRows[0], [
        { copy_text: { text: deposit }, text: "📋 Copy address" },
      ]);
      assert.deepEqual(presentation.buttonRows[1], [
        {
          callback_data: "hm:v1:deposit_qr:polymarket",
          text: "🔳 Show QR",
        },
      ]);
    },
  },
  {
    name: "deposit analytics stores internal context without Telegram or wallet identifiers",
    run: async () => {
      const calls: Array<{ params: unknown[]; sql: string }> = [];
      await recordTelegramDepositResolutionAnalytics({
        db: {
          query: async (sql: string, params: unknown[] = []) => {
            calls.push({ params, sql });
            return /select user_id/i.test(sql)
              ? { rows: [{ user_id: "user-1" }] }
              : { rows: [] };
          },
        } as never,
        reason: null,
        source: "deposit_menu",
        status: "ready",
        telegramUserId: 999,
        venue: "polymarket",
      });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1]?.params.slice(0, 5), [
        "user-1",
        "hf_telegram_deposit_resolution",
        "deposit_menu",
        "ready",
        "polymarket",
      ]);
      const payload = JSON.parse(String(calls[1]?.params[6])) as Record<
        string,
        unknown
      >;
      assert.equal(payload.chain, "polygon");
      assert.equal(JSON.stringify(payload).includes("999"), false);
      assert.equal(JSON.stringify(payload).includes(deposit), false);
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
        venue: "polymarket",
      });
      assert.match(message.text, /temporarily unavailable/);
      assert.match(message.text, /Mini App temporarily unavailable/);
      assert.doesNotMatch(message.text, /Finish Trading Wallet setup/);
    },
  },
  {
    name: "QR keeps the contextual Deposit card and uses venue metadata",
    run: async () => {
      let renderCalls = 0;
      let photoCalls = 0;
      let photoCaption = "";
      let photoFilename = "";
      await handleSignalBotInteractiveMenuCallback({
        callbackPrefix: "hm:v1:",
        chatId: "20",
        loadDeposit: async () => ({
          qrText: deposit,
          text: "Generic deposit",
          venue: "limitless",
        }),
        messageId: 42,
        redis: { get: async () => null },
        render: async () => {
          renderCalls += 1;
        },
        renderExpiredSearch: async () => undefined,
        route: { kind: "deposit", showQr: true, venue: "polymarket" },
        sendPhoto: async (photo) => {
          photoCalls += 1;
          photoCaption = photo.caption ?? "";
          photoFilename = photo.filename;
        },
        telegramUserId: 20,
      });
      assert.equal(renderCalls, 0);
      assert.equal(photoCalls, 1);
      assert.match(photoCaption, /Base/);
      assert.match(
        photoCaption,
        new RegExp(TELEGRAM_CUSTOM_EMOJI.limitless.id),
      );
      assert.match(photoCaption, new RegExp(TELEGRAM_CUSTOM_EMOJI.base.id));
      assert.match(photoCaption, new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id));
      assert.match(photoCaption, />⚠️ \*Important\*/);
      assert.match(photoCaption, />Send only \*USDC\* on \*Base\*/);
      assert.match(photoFilename, /limitless/);
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
