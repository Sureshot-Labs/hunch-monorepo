import assert from "node:assert/strict";

import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";
import {
  buildTelegramBotReferralCodeConfirmation,
  buildTelegramBotReferralCodeInputPrompt,
  normalizeTelegramBotReferralCode,
  parseTelegramBotRewardsCallbackRoute,
  telegramBotRewardsTestHooks,
} from "./services/telegram-bot-rewards.js";

type OverviewInput = Parameters<
  typeof telegramBotRewardsTestHooks.buildOverviewMessage
>[0];

const summary: OverviewInput["summary"] = {
  cashback: {
    bps: 2500,
    byChain: {
      "137": { claimable: 8.26, collected: 12, pending: 1 },
    },
    claimable: 8.26,
    collected: 12,
    pending: 1,
  },
  clout: {
    points: 312,
    qualificationPoints: 312,
    tierPoints: 312,
    volumeUsd: 312,
  },
  inboundReferral: null,
  multiplier: {
    asOf: new Date("2026-07-24T00:00:00.000Z"),
    label: null,
    referralCode: null,
    source: "global",
    value: 1,
  },
  nextTier: {
    cashbackBps: 2500,
    name: "Observer",
    points: 500,
    tier: 1,
  },
  policy: {
    effectiveAt: null,
    referralBonus: [
      { bonusBps: 500, minReferrals: 3 },
      { bonusBps: 1000, minReferrals: 5 },
      { bonusBps: 1500, minReferrals: 10 },
    ],
    referralQualification: { pointsRequired: 500 },
    tiers: [
      { cashbackBps: 0, name: "Novice", points: 0, tier: 0 },
      { cashbackBps: 2500, name: "Observer", points: 500, tier: 1 },
    ],
  },
  progress: { pct: 0.624, remaining: 188 },
  referralBonus: {
    bonusBps: 500,
    byChain: { "137": { collected: 4.18, pending: 1.1 } },
    collected: 4.18,
    pending: 1.1,
    qualifiedCount: 3,
  },
  tier: { cashbackBps: 0, name: "Novice", points: 0, tier: 0 },
};

const tests: Array<{ name: string; run: () => void }> = [
  {
    name: "overview uses a native gift icon and reserves Hunch emoji for Mini App",
    run: () => {
      const message = telegramBotRewardsTestHooks.buildOverviewMessage({
        appBaseUrl: "https://app.hunch.trade",
        callbackPrefix: "hm:v1:",
        code: "HUNCH42",
        hasReferrer: false,
        miniAppEnabled: true,
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        summary,
        totalReferrals: 7,
      });
      assert.match(message.text, /^🎁 \*Rewards & referrals\*/);
      assert.match(message.text, /7 total/);
      assert.match(message.text, /312 \/ 500 qualification points/);
      const buttons = message.reply_markup.inline_keyboard.flat();
      assert.deepEqual(
        buttons.map((button) => button.text),
        [
          "📨 Share invite",
          "👥 My referrals",
          "💰 Earnings",
          "✏️ Change code",
          "❓ How it works",
          "🏷 Enter invite code",
          "Open Rewards",
          "⬅️ Back",
        ],
      );
      const brandedButtons = buttons.filter(
        (button) => "icon_custom_emoji_id" in button,
      );
      assert.equal(brandedButtons.length, 1);
      const brandedButton = brandedButtons[0];
      assert.equal(
        brandedButton && "icon_custom_emoji_id" in brandedButton
          ? brandedButton.icon_custom_emoji_id
          : null,
        TELEGRAM_CUSTOM_EMOJI.hunch.id,
      );
      assert.equal(brandedButton?.text, "Open Rewards");
      const shareButton = buttons.find(
        (button) => button.text === "📨 Share invite",
      );
      assert.ok(shareButton && "url" in shareButton);
      const sharedUrl = new URL(
        new URL(
          shareButton && "url" in shareButton ? shareButton.url : "",
        ).searchParams.get("url") ?? "",
      );
      assert.equal(sharedUrl.origin, "https://t.me");
      assert.equal(sharedUrl.pathname, "/hunch_bot/hunch");
      assert.equal(sharedUrl.searchParams.get("startapp"), "ref_HUNCH42");
      const miniApp = buttons.find((button) => button.text === "Open Rewards");
      assert.equal(
        miniApp && "web_app" in miniApp ? miniApp.web_app.url : null,
        "https://app.hunch.trade/rewards",
      );
      assert.doesNotMatch(message.text, /Your invite/);
      assert.match(message.text, /🏷 \*Code:\*/);
      assert.match(message.text, /🔗 \*Invite link:\*/);
      assert.equal(
        message.text
          .split("\n")
          .filter((line) => line.startsWith(">"))
          .some(
            (line) => line.includes("Code:") || line.includes("Referrals:"),
          ),
        false,
      );
    },
  },
  {
    name: "empty referral list hides meaningless sorting controls",
    run: () => {
      const message = telegramBotRewardsTestHooks.buildReferralsMessage({
        callbackPrefix: "hm:v1:",
        data: {
          hasMore: false,
          limit: 5,
          offset: 0,
          policy: summary.policy,
          referrals: [],
          total: 0,
        },
        page: 0,
        sortBy: "bonus",
        summary,
      });
      assert.deepEqual(
        message.reply_markup.inline_keyboard
          .flat()
          .map((button) => button.text),
        ["⬅️ Back", "🏠 Home"],
      );
      assert.match(message.text, /👥 \*No referrals yet\*/);
      assert.doesNotMatch(message.text, /Sorted by/);
    },
  },
  {
    name: "populated referral list explains sorting and only shows alternatives",
    run: () => {
      const message = telegramBotRewardsTestHooks.buildReferralsMessage({
        callbackPrefix: "hm:v1:",
        data: {
          hasMore: true,
          limit: 5,
          offset: 0,
          policy: summary.policy,
          referrals: [
            {
              bonus: 4.18,
              createdAt: new Date("2026-07-24T00:00:00.000Z"),
              id: "referral-1",
              points: 700,
              qualifiedAt: new Date("2026-07-24T00:00:00.000Z"),
              status: "qualified",
              tier: summary.tier,
              walletAddress: "0x1234567890abcdef",
            },
          ],
          total: 6,
        },
        page: 0,
        sortBy: "bonus",
        summary: {
          ...summary,
          clout: { ...summary.clout, qualificationPoints: 500 },
        },
      });
      assert.deepEqual(
        message.reply_markup.inline_keyboard
          .flat()
          .map((button) => button.text),
        ["⭐ Points", "🕒 Newest", "Next ➡️", "⬅️ Back", "🏠 Home"],
      );
      assert.match(message.text, /\*Sorted by:\* Referral earnings/);
      assert.match(message.text, /\*Page:\* 1 \/ 2/);
      assert.doesNotMatch(message.text, /^>/m);
    },
  },
  {
    name: "earnings summary uses ordinary lines instead of a quote card",
    run: () => {
      const message = telegramBotRewardsTestHooks.buildEarningsMessage({
        appBaseUrl: "https://app.hunch.trade",
        callbackPrefix: "hm:v1:",
        miniAppEnabled: true,
        summary,
      });
      assert.match(message.text, /🎁 \*Current bonus:\*/);
      assert.match(message.text, /💰 \*Referral earned:\*/);
      assert.doesNotMatch(message.text, /^>/m);
      assert.doesNotMatch(message.text, /Rewards summary/);
    },
  },
  {
    name: "reward callbacks remain compact and reject malformed pagination",
    run: () => {
      assert.deepEqual(parseTelegramBotRewardsCallbackRoute("rewards"), {
        kind: "rewards_view",
        view: { kind: "overview" },
      });
      assert.deepEqual(parseTelegramBotRewardsCallbackRoute("rw:r:p:12"), {
        kind: "rewards_view",
        view: { kind: "referrals", page: 12, sortBy: "points" },
      });
      assert.equal(parseTelegramBotRewardsCallbackRoute("rw:r:p:-1"), null);
      assert.equal(parseTelegramBotRewardsCallbackRoute("rw:r:x:0"), null);
    },
  },
  {
    name: "referral code confirmation normalizes code and requires explicit action",
    run: () => {
      assert.equal(normalizeTelegramBotReferralCode(" alpha-7 "), "ALPHA7");
      const message = buildTelegramBotReferralCodeConfirmation({
        action: "change",
        callbackPrefix: "hm:v1:",
        code: "ALPHA7",
        currentCode: "HUNCH42",
      });
      assert.match(message.text, /HUNCH42/);
      assert.match(message.text, /ALPHA7/);
      assert.deepEqual(
        message.reply_markup.inline_keyboard
          .flat()
          .map((button) =>
            "callback_data" in button ? button.callback_data : null,
          ),
        ["hm:v1:rw:ok:c", "hm:v1:rw:x"],
      );
      assert.doesNotMatch(message.text, />.*(?:Current|New):/);
      assert.match(message.text, />⚠️ \*Before you change it\*/);
    },
  },
  {
    name: "input and help screens reserve quotes for important warnings",
    run: () => {
      const changePrompt = buildTelegramBotReferralCodeInputPrompt({
        action: "change",
        callbackPrefix: "hm:v1:",
      });
      const attachPrompt = buildTelegramBotReferralCodeInputPrompt({
        action: "attach",
        callbackPrefix: "hm:v1:",
      });
      const help = telegramBotRewardsTestHooks.buildHelpMessage({
        callbackPrefix: "hm:v1:",
        summary,
      });

      assert.doesNotMatch(changePrompt.text, /^>/m);
      assert.match(attachPrompt.text, />⚠️ \*One\\-time attachment\*/);
      assert.doesNotMatch(help.text, />.*(?:qualified|Referral bonus rates)/);
      assert.match(help.text, />⚠️ \*Changing your code\*/);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-bot-rewards-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-bot-rewards-tests] passed ${passed}/${tests.length}`);
