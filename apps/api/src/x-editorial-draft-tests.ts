import assert from "node:assert/strict";

import {
  enableSignalBotChat,
  getSignalBotChatState,
  handleSignalBotCommand,
  parseSignalBotConfig,
  publishSignalBotTick,
  updateSignalBotContentProfile,
  type SignalBotRedisLike,
} from "./services/signal-bot.js";
import { parseSignalBotContentProfileRequest } from "./services/signal-bot-command-parsers.js";
import {
  buildXEditorialFallbackPost,
  buildXEditorialTelegramDraftMessage,
  loadXEditorialInitialRecoveryNoteIds,
} from "./services/signal-bot-x-editorial-delivery.js";
import {
  buildXEditorialDraftSystemPrompt,
  buildXEditorialSourceDigest,
  createOpenRouterXEditorialDraftComposer,
  parsePersistedXEditorialDraft,
  validateXEditorialModelOutput,
  X_EDITORIAL_PROMPT_VERSION,
  XEditorialComposerError,
  type XEditorialDraftSource,
} from "./services/x-editorial-draft.js";
import { HOLDER_RESEARCH_PUBLICATION_DECISION_V1 } from "./services/signal-publication-contract.js";

class FakeRedis implements SignalBotRedisLike {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly sets = new Map<string, Set<string>>();

  async del(key: string): Promise<number> {
    return this.hashes.delete(key) ? 1 : 0;
  }

  async eval(): Promise<number> {
    return 0;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async hSet(key: string, value: Record<string, string>): Promise<number> {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...value });
    return Object.keys(value).length;
  }

  async sAdd(key: string, member: string): Promise<number> {
    const values = this.sets.get(key) ?? new Set<string>();
    const before = values.size;
    values.add(member);
    this.sets.set(key, values);
    return values.size - before;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async sRem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async set(): Promise<string> {
    return "OK";
  }
}

const source: XEditorialDraftSource = {
  facts: [
    {
      id: "market",
      label: "Canonical market",
      value: {
        selectedSide: "YES",
        selectedSideLabel: "Spain to win",
        subject: "Spain to win the World Cup",
      },
    },
    {
      id: "actor",
      label: "Tracked trader",
      value: { positionUsd: 56_400, pnl30dUsd: 542_000 },
    },
  ],
  kind: "initial",
  marketId: "market-1",
  noteId: "00000000-0000-4000-8000-000000000001",
  recentOpenings: ["A different opening from yesterday."],
  selectedSide: "YES",
};

const config = {
  enabled: true,
  maxCharacters: 1_000,
  maxOutputTokens: 700,
  maxParagraphs: 10,
  model: "test/editorial-model",
};

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "content profile parser accepts short aliases and optional channel IDs",
    run: () => {
      assert.deepEqual(
        parseSignalBotContentProfileRequest(
          "/signal_profile twitter 4249870297",
        ),
        {
          profile: "x_editorial_draft_v1",
          targetChatId: "-1004249870297",
        },
      );
      assert.deepEqual(
        parseSignalBotContentProfileRequest("/signal_profile x"),
        {
          profile: "x_editorial_draft_v1",
          targetChatId: null,
        },
      );
      assert.deepEqual(
        parseSignalBotContentProfileRequest("/signal_profile telegram"),
        { profile: "telegram_signal_v11", targetChatId: null },
      );
      assert.equal(
        parseSignalBotContentProfileRequest("/signal_profile unknown"),
        null,
      );
    },
  },
  {
    name: "old channel state defaults to Telegram and profile round-trips in Redis",
    run: async () => {
      const redis = new FakeRedis();
      const enabled = await enableSignalBotChat({
        chat: { id: -100123456, title: "Editorial", type: "channel" },
        enabledBy: 42,
        now: new Date("2026-08-01T12:00:00.000Z"),
        redis,
      });
      assert.equal(enabled.contentProfile, "telegram_signal_v11");
      const rawState = redis.hashes.get("tg:signal_bot:v1:chat:-100123456");
      assert.ok(rawState);
      rawState.contentProfile = "";
      assert.equal(
        (await getSignalBotChatState(redis, "-100123456"))?.contentProfile,
        "telegram_signal_v11",
      );
      assert.equal(
        await updateSignalBotContentProfile({
          chatId: "-100123456",
          contentProfile: "x_editorial_draft_v1",
          redis,
        }),
        true,
      );
      assert.equal(
        (await getSignalBotChatState(redis, "-100123456"))?.contentProfile,
        "x_editorial_draft_v1",
      );
    },
  },
  {
    name: "only an admin can select the editorial profile and status reports it",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: -100123456, title: "Editorial", type: "channel" },
        enabledBy: 42,
        redis,
      });
      const replies: Array<Record<string, unknown>> = [];
      const commandInput = (userId: number, text: string) => ({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "42",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
          HUNCH_SIGNAL_BOT_X_EDITORIAL_ENABLED: "true",
        }),
        message: {
          chat: { id: 42, type: "private" },
          date: 0,
          from: { id: userId },
          message_id: replies.length + 1,
          text,
        },
        redis,
        sendMessage: async (message: Record<string, unknown>) => {
          replies.push(message);
          return { messageId: replies.length, ok: true as const };
        },
        sendTestSignal: async () => ({ status: "not_found" as const }),
      });
      await handleSignalBotCommand(
        commandInput(7, "/signal_profile twitter -100123456") as never,
      );
      assert.equal(
        (await getSignalBotChatState(redis, "-100123456"))?.contentProfile,
        "telegram_signal_v11",
      );
      assert.match(String(replies.at(-1)?.text), /Not authorized/);

      await handleSignalBotCommand(
        commandInput(42, "/signal_profile twitter -100123456") as never,
      );
      assert.equal(
        (await getSignalBotChatState(redis, "-100123456"))?.contentProfile,
        "x_editorial_draft_v1",
      );
      await handleSignalBotCommand(
        commandInput(42, "/status -100123456") as never,
      );
      const statusText = String(replies.at(-1)?.text).replace(/[\\*]/g, "");
      assert.match(statusText, /Twitter editorial drafts/);
      assert.match(statusText, /composer: enabled/i);
    },
  },
  {
    name: "editorial prompt explicitly requests human factual copy",
    run: () => {
      const prompt = buildXEditorialDraftSystemPrompt(config);
      assert.match(prompt, /trader-story post/i);
      assert.match(prompt, /HOOK —/);
      assert.match(prompt, /Run a story gate/i);
      assert.match(prompt, /SNAPSHOT PROFILE —/);
      assert.match(prompt, /LIVE ACTION —/);
      assert.match(prompt, /does not need an analysis paragraph/i);
      assert.match(prompt, /punchline/i);
      assert.match(prompt, /light first-person editorial voice/i);
      assert.match(prompt, /Use only supplied facts/i);
      assert.match(prompt, /No Markdown/i);
      assert.match(prompt, /Telegram\/X formatting/i);
      assert.match(prompt, /field name is text, never snippet/i);
      assert.match(prompt, /STYLE EXAMPLE — compact snapshot/);
      assert.match(prompt, /Strong record\. Thin upside\. Still holding\./);
      assert.match(prompt, /Boring market\. Serious consistency\./);
      assert.match(prompt, /Never reuse their people, markets, numbers/i);
      assert.match(prompt, /editorial display strings verbatim/i);
      assert.match(prompt, /Never announce your structure/i);
      assert.match(prompt, /Use no emoji by default/i);
      assert.match(prompt, /sports\/esports do not require one/i);
      assert.match(prompt, /Never create a list for one position/i);
      assert.match(prompt, /at least three of joined, added, trimmed, exited/i);
      assert.match(prompt, /has beaten market prices by 14 points/i);
      assert.match(prompt, /ending in 'by\.\.\.\?'/i);
      assert.match(
        prompt,
        /Non-temporal idioms such as 'not just' are allowed/i,
      );
      assert.match(prompt, /keep that trader as the protagonist/i);
      assert.match(prompt, /on NO — the side betting/i);
      assert.match(prompt, /small red on the position/i);
      assert.match(prompt, /keeps paying/i);
      assert.match(prompt, /recentDraftsToAvoidImitating/i);
      assert.match(prompt, /1000 visible characters/i);
    },
  },
  {
    name: "validator rejects unsafe, promotional, and synthetic-person copy",
    run: () => {
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText:
            "I found an insider AI bot. Buy now with our code. #predictionmarkets",
          formatting: [{ style: "bold", text: "I found an insider AI bot." }],
          storyFamily: "fresh_bet",
          usedFactIds: ["market", "missing"],
          safetyFlags: [],
        },
        source,
      });
      assert.deepEqual(validated.issues.sort(), [
        "hashtag",
        "promotional_cta",
        "unknown_fact_id:missing",
        "unsupported_accusation",
      ]);
    },
  },
  {
    name: "validator rejects dashboard language from the old fallback voice",
    run: () => {
      const postText =
        "Tracked money is backing Spain. The important part is who is there. https://app.hunch.trade";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText,
          formatting: [{ style: "bold", text: postText }],
          storyFamily: "fresh_bet",
          usedFactIds: ["market"],
          safetyFlags: [],
        },
        source,
      });
      assert.ok(validated.issues.includes("internal_language"));
      assert.ok(validated.issues.includes("dashboard_voice"));
      assert.ok(validated.issues.includes("url"));
    },
  },
  {
    name: "validator rejects the raw numeric and templated voice seen in live previews",
    run: () => {
      const validate = (postText: string) =>
        validateXEditorialModelOutput({
          config,
          output: {
            version: 1,
            status: "ready",
            marketId: "market-1",
            selectedSide: "YES",
            postText,
            formatting: [
              { style: "bold", text: postText.split("\n")[0] ?? postText },
            ],
            storyFamily: "trader_profile",
            usedFactIds: ["market", "actor"],
            safetyFlags: [],
          },
          source,
        }).issues;

      const first = validate(
        "@eCash is still holding $22,612.756146 on NO.\n\nThe trader has receipts:\n→ Up $72.4K over the last 30 days\n\nThis is a credentialed fade.",
      );
      assert.ok(first.includes("raw_numeric_format"));
      assert.ok(first.includes("editorial_scaffolding"));
      assert.ok(first.includes("analyst_jargon"));

      const second = validate(
        "The market has NO at 0.645.\n@eCash holds 10167.2113 on NO.\n\nThe credential stack is the story:\n→ Up $72.3K over the last 30 days\n\nMy read: this is a credibility check.",
      );
      assert.ok(second.includes("raw_numeric_format"));
      assert.ok(second.includes("editorial_scaffolding"));
      assert.ok(second.includes("analyst_jargon"));

      const third = validate(
        "@881112 is holding $14,386.44 on NO.\n\nThe trader has some receipts:\n→ Up $26.9K over the last 30 days.",
      );
      assert.ok(third.includes("raw_numeric_format"));
      assert.ok(third.includes("editorial_scaffolding"));

      const fourth = validate(
        "@BBQChickenisthebesttt has $15.7K on NIP at 81¢.\n\nReceipts:\n→ open PnL: $700\n\nThe sharper question is whether this edge is still worth respecting.",
      );
      assert.ok(fourth.includes("editorial_scaffolding"));
      assert.ok(fourth.includes("analyst_jargon"));
    },
  },
  {
    name: "validator accepts compact human copy using publication-ready values",
    run: () => {
      const editorialSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: { subject: "Iranian blockade ending by August 15" },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: { displayName: "@eCash", position: "$22.6K" },
          },
          {
            id: "price",
            label: "Publication-ready price",
            value: { displayPrice: "92.5¢" },
          },
          {
            id: "credentials",
            label: "Public track record",
            value: [
              "Up $72.4K over the last 30 days",
              "Beat market prices by 23 points across 10 resolved bets",
            ],
          },
        ],
        kind: "initial",
        marketId: "market-1",
        noteId: "00000000-0000-4000-8000-000000000888",
        selectedSide: "NO",
      };
      const postText =
        "@eCash has $22.6K betting Iran’s blockade lasts past August 15.\n\nNO already trades at 92.5¢. Hardly a contrarian bet.\n\nBut this wallet is up $72.4K in 30 days and has beaten market prices by 23 points across 10 resolved bets.\n\nConsensus is one thing. Consensus backed by a proven trader is another.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "NO",
          postText,
          formatting: [
            {
              style: "bold",
              text: "@eCash has $22.6K betting Iran’s blockade lasts past August 15.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor", "price", "credentials"],
          safetyFlags: [],
        },
        source: editorialSource,
      });
      assert.deepEqual(validated.issues, []);
    },
  },
  {
    name: "validator rejects the artificial NIP analysis and unsupported buying claim",
    run: () => {
      const nipSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              eventTitle: "Weibo Gaming vs Ninjas in Pyjamas",
              selectedSideLabel: "NIP",
            },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: {
              displayName: "@BBQChickenisthebesttt",
              openPnl: "+$700",
              position: "$15.7K",
            },
          },
          {
            id: "price",
            label: "Publication-ready price",
            value: { displayPrice: "81¢" },
          },
          {
            id: "credentials",
            label: "Public track record",
            value: [
              "Up $81.8K over the last 30 days",
              "Beat market prices by 16 points across 26 resolved bets",
              "Traded $274.5K over the last 30 days",
            ],
          },
        ],
        kind: "initial",
        marketId: "nip-market",
        noteId: "00000000-0000-4000-8000-000000000889",
        selectedSide: "YES",
      };
      const postText =
        "@BBQChickenisthebesttt is still sitting on $15.7K of NIP in Weibo Gaming vs Ninjas in Pyjamas.\n\nNIP is 81¢ now. The position is already showing +$700, and the holder’s last 30 days are not quiet: up $81.8K, with $274.5K traded.\n\nThe cleaner stat: they beat market prices by 16 points across 26 resolved bets.\n\nThat is the actual tension here: not whether NIP is favored, but whether this trader is right to keep paying favorite prices.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "nip-market",
          selectedSide: "YES",
          postText,
          formatting: [
            {
              style: "bold",
              text: "@BBQChickenisthebesttt is still sitting on $15.7K of NIP in Weibo Gaming vs Ninjas in Pyjamas.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor", "price", "credentials"],
          safetyFlags: [],
        },
        source: nipSource,
      });
      assert.ok(validated.issues.includes("editorial_scaffolding"));
      assert.ok(validated.issues.includes("analyst_jargon"));
      assert.ok(validated.issues.includes("unsupported_trade_action"));
    },
  },
  {
    name: "validator rejects the second live NIP preview as a weak unsafe snapshot",
    run: () => {
      const nipSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              eventTitle: "Weibo Gaming vs Ninjas in Pyjamas",
              marketQuestion: "Will Weibo Gaming win the BO3?",
              selectedSideLabel: "NIP to win the BO3",
            },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: {
              displayName: "@BBQChickenisthebesttt",
              openPnl: "+$700",
              position: "$15.7K",
            },
          },
          {
            id: "price",
            label: "Publication-ready price",
            value: { displayPrice: "81¢", displaySide: "NO" },
          },
          {
            id: "credentials",
            label: "Public track record",
            value: [
              "Up $81.8K over the last 30 days",
              "Beat market prices by 16 points across 26 resolved bets",
            ],
          },
        ],
        kind: "initial",
        marketId: "nip-market",
        noteId: "00000000-0000-4000-8000-000000000891",
        selectedSide: "NO",
      };
      const postText =
        "$15.7K on NIP at 81¢.\n\n@BBQChickenisthebesttt is holding the NO side for Weibo Gaming vs Ninjas in Pyjamas — meaning NIP to win the BO3.\n\nThe price is already heavy, but the holder is up $81.8K over the last 30 days and has beaten market prices by 16 points across 26 resolved bets.\n\nNot a cheap entry anymore. Still a serious holder.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "nip-market",
          selectedSide: "NO",
          postText,
          formatting: [
            { style: "bold", text: "$15.7K on NIP at 81¢." },
            {
              style: "bold",
              text: "up $81.8K over the last 30 days",
            },
            {
              style: "italic",
              text: "Not a cheap entry anymore. Still a serious holder.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor", "price", "credentials"],
          safetyFlags: [],
        },
        source: nipSource,
      });
      assert.ok(validated.issues.includes("weak_position_hook"));
      assert.ok(validated.issues.includes("binary_side_explanation"));
      assert.ok(validated.issues.includes("analyst_jargon"));
      assert.ok(validated.issues.includes("unsupported_trade_action"));
      assert.equal(validated.issues.includes("missing_topical_emoji"), false);
    },
  },
  {
    name: "validator accepts a clipped NIP profile with one topical emoji",
    run: () => {
      const nipSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              eventTitle: "Weibo Gaming vs Ninjas in Pyjamas",
              selectedSideLabel: "NIP",
            },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: {
              displayName: "@BBQChickenisthebesttt",
              openPnl: "+$700",
              position: "$15.7K",
            },
          },
          {
            id: "price",
            label: "Publication-ready price",
            value: { displayPrice: "81¢" },
          },
          {
            id: "credentials",
            label: "Public track record",
            value: [
              "Up $81.8K over the last 30 days",
              "Beat market prices by 16 points across 26 resolved bets",
            ],
          },
        ],
        kind: "initial",
        marketId: "nip-market",
        noteId: "00000000-0000-4000-8000-000000000890",
        selectedSide: "YES",
      };
      const postText =
        "🎮 $81.8K profit in 30 days. And one trader is still holding $15.7K on Ninjas in Pyjamas against Weibo Gaming.\n\nNIP are already 81¢. The position is only +$700.\n\nAcross 26 resolved bets, @BBQChickenisthebesttt has beaten market prices by 16 points.\n\nStrong record. Thin upside. Still holding.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "nip-market",
          selectedSide: "YES",
          postText,
          formatting: [
            {
              style: "bold",
              text: "🎮 $81.8K profit in 30 days. And one trader is still holding $15.7K on Ninjas in Pyjamas against Weibo Gaming.",
            },
            {
              style: "italic",
              text: "Strong record. Thin upside. Still holding.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor", "price", "credentials"],
          safetyFlags: [],
        },
        source: nipSource,
      });
      assert.deepEqual(validated.issues, []);
    },
  },
  {
    name: "validator does not force emoji into esports drafts",
    run: () => {
      const nipSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: { eventTitle: "Weibo Gaming vs Ninjas in Pyjamas" },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: { position: "$15.7K" },
          },
        ],
        kind: "initial",
        marketId: "nip-market",
        noteId: "00000000-0000-4000-8000-000000000892",
        recentOpenings: ["🎮 An esports post from the previous batch."],
        selectedSide: "NO",
      };
      const postText =
        "One trader is still holding $15.7K on Ninjas in Pyjamas against Weibo Gaming.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "nip-market",
          selectedSide: "NO",
          postText,
          formatting: [{ style: "bold", text: postText }],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor"],
          safetyFlags: [],
        },
        source: nipSource,
      });
      assert.deepEqual(validated.issues, []);
    },
  },
  {
    name: "validator rejects the live Hormuz profile grammar and editorial scaffolding",
    run: () => {
      const hormuzSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              marketQuestion:
                "Will Iran charge fees for passage through the Strait of Hormuz by August 31?",
              selectedSideLabel: "No fees by August 31",
            },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: { displayName: "@groth", position: "$6.6K" },
          },
          {
            id: "price",
            label: "Publication-ready price",
            value: { displayPrice: "90.5¢" },
          },
          {
            id: "credentials",
            label: "Public track record",
            value: [
              "Up $3.8K over the last 30 days",
              "Beat market prices by 14 points across 20 resolved bets",
            ],
          },
        ],
        kind: "initial",
        marketId: "hormuz-fees",
        noteId: "00000000-0000-4000-8000-000000000893",
        selectedSide: "NO",
      };
      const postText =
        "@groth is still holding $6.6K against Iran charging Hormuz fees by August 31.\n\nNO is 90.5¢ now, so this is not a long-shot fade. The market is already heavily on no fees by the deadline.\n\nThe better reason to notice it: @groth is up $3.8K over the last 30 days and has beat market prices by 14 points across 20 resolved bets.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "hormuz-fees",
          selectedSide: "NO",
          postText,
          formatting: [
            {
              style: "bold",
              text: "@groth is still holding $6.6K against Iran charging Hormuz fees by August 31.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor", "price", "credentials"],
          safetyFlags: [],
        },
        source: hormuzSource,
      });
      assert.ok(validated.issues.includes("grammar_error"));
      assert.ok(validated.issues.includes("editorial_scaffolding"));
    },
  },
  {
    name: "validator rejects raw followthrough titles and prose wallet inventories",
    run: () => {
      const followthroughSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              marketQuestion:
                "Will the US announce an end to the Iranian blockade by August 31?",
              selectedSideLabel: "No announcement by August 31",
            },
          },
          {
            id: "followthrough",
            label: "Computed change since the signal",
            value: {
              addedWallets: 7,
              entryPrice: "93¢",
              estimatedOpenPnl: "+$3K",
              exitedWallets: 2,
              joinedWallets: 1,
              markPrice: "96.9¢",
              netSignalSideFlow: "+$49.5K",
              stillHoldingWallets: 15,
              trimmedWallets: 6,
            },
          },
        ],
        kind: "followthrough_stats",
        marketId: "iran-blockade-followthrough",
        noteId: "00000000-0000-4000-8000-000000000894",
        selectedSide: "NO",
      };
      const postText =
        "US announces end of Iranian blockade by...? moved from 93¢ to 96.9¢.\n\n$49.5K more moved onto NO after the original signal.\n\n1 new wallet joined. 7 existing wallets added. 6 trimmed the position. 2 exited. 15 wallets are still in.\n\nEstimated open PnL is +$3K.\n\nThe price moved one way. The wallets did not.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "iran-blockade-followthrough",
          selectedSide: "NO",
          postText,
          formatting: [
            {
              style: "bold",
              text: "US announces end of Iranian blockade by...? moved from 93¢ to 96.9¢.",
            },
          ],
          storyFamily: "followthrough",
          usedFactIds: ["market", "followthrough"],
          safetyFlags: [],
        },
        source: followthroughSource,
      });
      assert.ok(validated.issues.includes("raw_market_title"));
      assert.ok(validated.issues.includes("wallet_activity_needs_list"));
      assert.ok(validated.issues.includes("misleading_wallet_summary"));
    },
  },
  {
    name: "validator accepts mixed followthrough wallet activity as arrow lines",
    run: () => {
      const followthroughSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              marketQuestion:
                "Will the US announce an end to the Iranian blockade by August 31?",
              selectedSideLabel: "No announcement by August 31",
            },
          },
          {
            id: "followthrough",
            label: "Computed change since the signal",
            value: {
              addedWallets: 7,
              entryPrice: "93¢",
              estimatedOpenPnl: "+$3K",
              exitedWallets: 2,
              joinedWallets: 1,
              markPrice: "96.9¢",
              netSignalSideFlow: "+$49.5K",
              stillHoldingWallets: 15,
              trimmedWallets: 6,
            },
          },
        ],
        kind: "followthrough_stats",
        marketId: "iran-blockade-followthrough",
        noteId: "00000000-0000-4000-8000-000000000895",
        selectedSide: "NO",
      };
      const postText =
        "NO climbed from 93¢ to 96.9¢ after the original signal. Another $49.5K followed it.\n\n→ 1 wallet joined\n→ 7 added\n→ 6 trimmed\n→ 2 exited\n→ 15 still hold\n\nEstimated open PnL is +$3K.\n\nPrice climbed. Wallet conviction split.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "iran-blockade-followthrough",
          selectedSide: "NO",
          postText,
          formatting: [
            {
              style: "bold",
              text: "NO climbed from 93¢ to 96.9¢ after the original signal.",
            },
            {
              style: "italic",
              text: "Price climbed. Wallet conviction split.",
            },
          ],
          storyFamily: "followthrough",
          usedFactIds: ["market", "followthrough"],
          safetyFlags: [],
        },
        source: followthroughSource,
      });
      assert.deepEqual(validated.issues, []);
    },
  },
  {
    name: "validator rejects abstract side hooks and repeated endings",
    run: () => {
      const cashSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              marketQuestion:
                "Will the US announce an end to the Iranian blockade by August 31?",
              selectedSideLabel: "No announcement by August 31",
            },
          },
          {
            id: "actor",
            label: "Publication-ready actor",
            value: { displayName: "@eCash", position: "$11.1K" },
          },
          {
            id: "price",
            label: "Publication-ready price move",
            value: { displayMove: "7 points", displayPrice: "71.5¢" },
          },
          {
            id: "credentials",
            label: "Public track record",
            value: [
              "Up $73.7K over the last 30 days",
              "Beat market prices by 27 points across 13 resolved bets",
            ],
          },
        ],
        kind: "initial",
        marketId: "iran-blockade-ecash",
        noteId: "00000000-0000-4000-8000-000000000896",
        selectedSide: "NO",
      };
      const postText =
        "NO on an August 31 blockade-end announcement has moved 7 points to 71.5¢.\n\n@eCash is still there with $11.1K on the same side — betting the US does not announce an end to the Iranian blockade by that deadline.\n\nThe record is the reason to care: up $73.7K over the last 30 days, with a 27-point edge versus market prices across 13 resolved bets.\n\nPrice moved with the thesis. The holder is still there.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "iran-blockade-ecash",
          selectedSide: "NO",
          postText,
          formatting: [
            {
              style: "bold",
              text: "NO on an August 31 blockade-end announcement has moved 7 points to 71.5¢.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor", "price", "credentials"],
          safetyFlags: [],
        },
        source: cashSource,
      });
      assert.ok(validated.issues.includes("side_label_hook"));
      assert.ok(validated.issues.includes("editorial_scaffolding"));
      assert.ok(validated.issues.includes("repeated_phrase:still_there"));
    },
  },
  {
    name: "validator rejects the live eCash followthrough and accepts trader-led copy",
    run: () => {
      const followthroughSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              marketQuestion:
                "Will the US announce an end to the Iranian blockade by August 31?",
              selectedSideLabel: "No announcement by August 31",
            },
          },
          {
            id: "original_signal",
            label: "Original quality-gated signal",
            value: {
              credentials: [
                "Up $73.7K over the last 30 days",
                "Beat market prices by 27 points across 13 resolved bets",
              ],
              displayName: "@eCash",
              position: "$11.1K",
            },
          },
          {
            id: "followthrough",
            label: "Computed change since the signal",
            value: {
              entryPrice: "64.5¢",
              estimatedOpenPnl: "-$78",
              markPrice: "71.5¢",
              priceMove: "7 points",
            },
          },
        ],
        kind: "followthrough_stats",
        marketId: "iran-blockade-ecash-followthrough",
        noteId: "00000000-0000-4000-8000-000000000897",
        selectedSide: "NO",
      };
      const badPostText =
        "NO has moved from 64.5¢ to 71.5¢ on whether the US announces an end to the Iranian blockade by August 31.\n\n@eCash is still holding $11.1K on NO — the side betting there is no announcement by that deadline. Small red on the position: -$78.\n\nThe same trader is up $73.7K over the last 30 days and has beaten market prices by 27 points across 13 resolved bets.\n\nThe move is no longer subtle. The named holder with the recent record is on the side that says the deadline passes without it.";
      const bad = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "iran-blockade-ecash-followthrough",
          selectedSide: "NO",
          postText: badPostText,
          formatting: [
            {
              style: "bold",
              text: "NO has moved from 64.5¢ to 71.5¢",
            },
            {
              style: "bold",
              text: "@eCash is still holding $11.1K",
            },
          ],
          storyFamily: "followthrough",
          usedFactIds: ["market", "original_signal", "followthrough"],
          safetyFlags: [],
        },
        source: followthroughSource,
      });
      assert.ok(bad.issues.includes("actor_buried_in_followthrough"));
      assert.ok(bad.issues.includes("binary_side_explanation"));
      assert.ok(bad.issues.includes("analyst_jargon"));

      const latestLivePostText =
        "NO moved 7 points to 71.5¢ on whether the US announces an end to the Iranian blockade by August 31.\n\n@eCash is still holding $11.1K on no announcement by the deadline. The position is down $78.\n\nThis is the same trader up $73.7K over the last 30 days, and has beaten market prices by 27 points across 13 resolved bets.\n\nPrice followed the thesis; the holder stayed with it.";
      const latestLive = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "iran-blockade-ecash-followthrough",
          selectedSide: "NO",
          postText: latestLivePostText,
          formatting: [
            {
              style: "bold",
              text: "NO moved 7 points to 71.5¢",
            },
            {
              style: "bold",
              text: "@eCash is still holding $11.1K",
            },
            {
              style: "italic",
              text: "Price followed the thesis; the holder stayed with it.",
            },
          ],
          storyFamily: "followthrough",
          usedFactIds: ["market", "original_signal", "followthrough"],
          safetyFlags: [],
        },
        source: followthroughSource,
      });
      assert.ok(latestLive.issues.includes("actor_buried_in_followthrough"));
      assert.ok(latestLive.issues.includes("binary_side_shorthand"));
      assert.ok(latestLive.issues.includes("grammar_error"));
      assert.ok(latestLive.issues.includes("analyst_jargon"));

      const goodPostText =
        "@eCash is still holding $11.1K against an August 31 end to the Iranian blockade.\n\nNO moved from 64.5¢ to 71.5¢ after the original signal. The position is down $78.\n\nOver the last 30 days, @eCash is up $73.7K and has beaten market prices by 27 points across 13 resolved bets.";
      const good = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "iran-blockade-ecash-followthrough",
          selectedSide: "NO",
          postText: goodPostText,
          formatting: [
            {
              style: "bold",
              text: "@eCash is still holding $11.1K against an August 31 end to the Iranian blockade.",
            },
            {
              style: "bold",
              text: "NO moved from 64.5¢ to 71.5¢",
            },
          ],
          storyFamily: "followthrough",
          usedFactIds: ["market", "original_signal", "followthrough"],
          safetyFlags: [],
        },
        source: followthroughSource,
      });
      assert.deepEqual(good.issues, []);
    },
  },
  {
    name: "validator requires explicit evidence for trade action and recency",
    run: () => {
      const snapshotText =
        "One trader just bought $56.4K of Spain today. The position is still open.";
      const unsupported = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText: snapshotText,
          formatting: [{ style: "bold", text: snapshotText }],
          storyFamily: "fresh_bet",
          usedFactIds: ["market", "actor"],
          safetyFlags: [],
        },
        source,
      });
      assert.ok(unsupported.issues.includes("unsupported_trade_action"));
      assert.ok(unsupported.issues.includes("unsupported_recency"));

      const nonTemporalJust = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText:
            "This is not just a large position. The trader is still holding $56.4K on Spain.",
          formatting: [
            {
              style: "bold",
              text: "This is not just a large position.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor"],
          safetyFlags: [],
        },
        source,
      });
      assert.equal(
        nonTemporalJust.issues.includes("unsupported_recency"),
        false,
      );

      const actionSource: XEditorialDraftSource = {
        ...source,
        facts: [
          ...source.facts,
          {
            id: "research_update",
            label: "Material change",
            value: "The trader added $5K to the position today",
          },
        ],
        kind: "research_update",
      };
      const actionText = "The trader added $5K to the position today.";
      const supported = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText: actionText,
          formatting: [{ style: "bold", text: actionText }],
          storyFamily: "fresh_bet",
          usedFactIds: ["research_update"],
          safetyFlags: [],
        },
        source: actionSource,
      });
      assert.deepEqual(supported.issues, []);
    },
  },
  {
    name: "validator allows editorial first person but rejects fabricated personal activity",
    run: () => {
      const validate = (postText: string) =>
        validateXEditorialModelOutput({
          config,
          output: {
            version: 1,
            status: "ready",
            marketId: "market-1",
            selectedSide: "YES",
            postText,
            formatting: [{ style: "bold", text: postText }],
            storyFamily: "fresh_bet",
            usedFactIds: ["market"],
            safetyFlags: [],
          },
          source,
        }).issues;
      assert.equal(
        validate("I found a concentrated Spain position.").includes(
          "fake_first_person",
        ),
        false,
      );
      assert.equal(
        validate(
          "The latest move told us where attention is building.",
        ).includes("fake_first_person"),
        false,
      );
      assert.ok(
        validate("We bought a fresh position in the election market.").includes(
          "fake_first_person",
        ),
      );
      assert.ok(
        validate("My position is backing Spain to win.").includes(
          "fake_first_person",
        ),
      );
    },
  },
  {
    name: "editorial fallback builds a trader story instead of replaying research copy",
    run: () => {
      const fallbackSource: XEditorialDraftSource = {
        facts: [
          {
            id: "market",
            label: "Canonical market",
            value: {
              eventTitle: "Paris Saint-Germain match",
              selectedSide: "NO",
              selectedSideLabel: "Betting against Paris Saint-Germain",
              subject: "Paris Saint-Germain",
            },
          },
          {
            id: "price",
            label: "Selected-side signal price",
            value: { displayPrice: "44¢", displaySide: "NO" },
          },
          {
            id: "research_copy",
            label: "Old research copy",
            value: {
              description:
                "The important part is who is there: tracked money is against PSG.",
              headline:
                "Two recent winners are betting against Paris Saint-Germain.",
            },
          },
          {
            id: "actor",
            label: "Tracked group",
            value: {
              clusterOpenPnl: "-$926",
              clusterPosition: "$27K",
              clusterSharpHolders: 2,
            },
          },
          {
            id: "credentials",
            label: "Verified credentials",
            value: ["Both traders are recent winners"],
          },
        ],
        kind: "initial",
        marketId: "polymarket:psg",
        noteId: "00000000-0000-4000-8000-000000000777",
        selectedSide: "NO",
      };

      const draft = buildXEditorialFallbackPost({
        failureCode: "schema_mismatch",
        source: fallbackSource,
      });

      assert.equal(draft.promptVersion, X_EDITORIAL_PROMPT_VERSION);
      assert.match(
        draft.postText ?? "",
        /^Two traders have \$27K betting against Paris Saint-Germain\./,
      );
      assert.match(draft.postText ?? "", /That outcome is priced at 44¢\./);
      assert.match(draft.postText ?? "", /Both traders are recent winners\./);
      assert.match(draft.postText ?? "", /The position is down \$926/);
      assert.match(
        draft.postText ?? "",
        /The market is undecided\. They are not\./,
      );
      assert.doesNotMatch(
        draft.postText ?? "",
        /The important part|tracked money|trades around 44c/i,
      );
      assert.deepEqual(draft.formatting, [
        {
          style: "bold",
          text: "Two traders have $27K betting against Paris Saint-Germain.",
        },
        {
          style: "italic",
          text: "The market is undecided. They are not.",
        },
      ]);
    },
  },
  {
    name: "Telegram renderer applies editorial formatting without links or a copy block",
    run: () => {
      const postText =
        "$56.4K is backing Spain.\n\nOne position. No hedge.\n\nEither conviction — or chaos?";
      const message = buildXEditorialTelegramDraftMessage({
        draft: {
          characterCount: Array.from(postText).length,
          formatting: [
            { style: "bold", text: "$56.4K is backing Spain." },
            { style: "italic", text: "Either conviction — or chaos?" },
          ],
          generatedAt: "2026-01-02T01:00:00.000Z",
          marketId: "market-1",
          model: "test/editorial-model",
          postText,
          promptVersion: X_EDITORIAL_PROMPT_VERSION,
          safetyFlags: [],
          selectedSide: "YES",
          sourceDigest: buildXEditorialSourceDigest(source),
          status: "ready",
          storyFamily: "fresh_bet",
          usedFactIds: ["market", "actor"],
          version: 1,
        },
      });
      assert.match(message, /^\*\$56\\\.4K is backing Spain\\\.\*/);
      assert.match(message, /_Either conviction — or chaos\?_$/);
      assert.doesNotMatch(message, /```|Bold in X|Italic in X|🎨/);
      assert.doesNotMatch(message, /https?:\/\/|Website|Mini App/);
    },
  },
  {
    name: "validator accepts influencer-style receipts and a grounded first-person hook",
    run: () => {
      const postText =
        "I found a trader with $56.4K on Spain. ⚽\n\n→ Position: $56.4K\n→ 30-day PnL: $542K\n\nThe bet is interesting. The track record is why it matters.";
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText,
          formatting: [
            {
              style: "bold",
              text: "I found a trader with $56.4K on Spain. ⚽",
            },
            {
              style: "italic",
              text: "The track record is why it matters.",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor"],
          safetyFlags: [],
        },
        source,
      });
      assert.deepEqual(validated.issues, []);
    },
  },
  {
    name: "OpenRouter composer repairs a rejected first draft once",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const requests: unknown[] = [];
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        requests.push(JSON.parse(String(init?.body)) as unknown);
        const content =
          requests.length === 1
            ? {
                version: 1,
                status: "ready",
                marketId: "market-1",
                selectedSide: "YES",
                postText: "We found an insider. #alpha",
                formatting: [{ style: "bold", text: "We found an insider." }],
                storyFamily: "fresh_bet",
                usedFactIds: ["market"],
                safetyFlags: [],
              }
            : {
                version: 1,
                status: "ready",
                marketId: "market-1",
                selectedSide: "YES",
                postText:
                  "$56.4K is backing Spain to win the World Cup.\n\nThe position stands out because the tracked trader is up $542K over the supplied period.",
                formatting: [
                  {
                    style: "bold",
                    text: "$56.4K is backing Spain to win the World Cup.",
                  },
                  {
                    style: "italic",
                    text: "the tracked trader is up $542K",
                  },
                ],
                storyFamily: "trader_profile",
                usedFactIds: ["market", "actor"],
                safetyFlags: [],
              };
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(content) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const compose = createOpenRouterXEditorialDraftComposer({
          apiKey: "test-key",
          config,
        });
        const draft = await compose({ source });
        assert.equal(requests.length, 2);
        assert.equal(draft.status, "ready");
        assert.equal(draft.storyFamily, "trader_profile");
        assert.match(draft.postText ?? "", /\$56\.4K/);
        assert.deepEqual(draft.usedFactIds, ["market", "actor"]);
        assert.equal(draft.sourceDigest, buildXEditorialSourceDigest(source));
        assert.deepEqual(
          parsePersistedXEditorialDraft(JSON.parse(JSON.stringify(draft))),
          draft,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "OpenRouter composer safely normalizes formatting snippet to text",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    status: "ready",
                    marketId: "market-1",
                    selectedSide: "YES",
                    postText: "$56.4K is backing Spain to win the World Cup.",
                    formatting: [
                      {
                        style: "bold",
                        snippet:
                          "$56.4K is backing Spain to win the World Cup.",
                      },
                    ],
                    storyFamily: "fresh_bet",
                    usedFactIds: ["market", "actor"],
                    safetyFlags: [],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const compose = createOpenRouterXEditorialDraftComposer({
          apiKey: "test-key",
          config,
        });
        const draft = await compose({ source });
        assert.equal(requests, 1);
        assert.deepEqual(draft.formatting, [
          {
            style: "bold",
            text: "$56.4K is backing Spain to win the World Cup.",
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "OpenRouter composer reports persistent output contract mismatches",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    status: "ready",
                    marketId: "market-1",
                    selectedSide: "YES",
                    postText: "$56.4K is backing Spain to win the World Cup.",
                    formatting: [{ style: "bold", snippet: 42 }],
                    storyFamily: "fresh_bet",
                    usedFactIds: ["market", "actor"],
                    safetyFlags: [],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const compose = createOpenRouterXEditorialDraftComposer({
          apiKey: "test-key",
          config,
        });
        await assert.rejects(
          () => compose({ source }),
          (error: unknown) => {
            assert.ok(error instanceof XEditorialComposerError);
            assert.equal(error.code, "schema_mismatch");
            assert.ok(
              error.issues.some((issue) =>
                issue.startsWith("formatting.0.text:"),
              ),
            );
            return true;
          },
        );
        assert.equal(requests, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "OpenRouter composer limits reasoning and recovers empty content with more output budget",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "length",
                  message: { content: null },
                  native_finish_reason: "max_tokens",
                },
              ],
              usage: {
                completion_tokens: 700,
                completion_tokens_details: { reasoning_tokens: 700 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    version: 1,
                    status: "ready",
                    marketId: "market-1",
                    selectedSide: "YES",
                    postText:
                      "$56.4K is backing Spain to win the World Cup.\n\nOne position. No hedge.",
                    formatting: [
                      {
                        style: "bold",
                        text: "$56.4K is backing Spain to win the World Cup.",
                      },
                    ],
                    storyFamily: "fresh_bet",
                    usedFactIds: ["market", "actor"],
                    safetyFlags: [],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const compose = createOpenRouterXEditorialDraftComposer({
          apiKey: "test-key",
          config,
        });
        const draft = await compose({ source });
        assert.equal(draft.status, "ready");
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0]?.reasoning, {
          effort: "minimal",
          exclude: true,
        });
        assert.equal(requests[0]?.max_tokens, 700);
        assert.equal(requests[1]?.max_tokens, 1_400);
        assert.equal(
          (requests[0]?.response_format as { type?: unknown }).type,
          "json_schema",
        );
        assert.deepEqual(requests[0]?.provider, {
          require_parameters: true,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "OpenRouter composer reports missing content after one repair retry",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "error", message: {} }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const compose = createOpenRouterXEditorialDraftComposer({
          apiKey: "test-key",
          config,
        });
        await assert.rejects(
          () => compose({ source }),
          (error: unknown) => {
            assert.ok(error instanceof XEditorialComposerError);
            assert.equal(error.code, "missing_content");
            assert.ok(error.issues.includes("finish_reason:error"));
            return true;
          },
        );
        assert.equal(requests, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "OpenRouter composer keeps an explicit model block terminal",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    status: "blocked",
                    marketId: "market-1",
                    selectedSide: "YES",
                    postText: null,
                    formatting: [],
                    storyFamily: "fresh_bet",
                    usedFactIds: [],
                    safetyFlags: [],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;
      try {
        const compose = createOpenRouterXEditorialDraftComposer({
          apiKey: "test-key",
          config,
        });
        const draft = await compose({ source });
        assert.equal(draft.status, "blocked");
        assert.deepEqual(draft.safetyFlags, ["model_blocked"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "validator rejects invented numbers and a flipped market contract",
    run: () => {
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "another-market",
          selectedSide: "NO",
          postText:
            "$99K is backing Spain at 73% after a 12-day winning streak.",
          formatting: [
            {
              style: "bold",
              text: "$99K is backing Spain at 73%",
            },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor"],
          safetyFlags: [],
        },
        source,
      });
      assert.deepEqual(validated.issues.sort(), [
        "market_id_mismatch",
        "selected_side_mismatch",
        "unsupported_number:$99K",
        "unsupported_number:12",
        "unsupported_number:73%",
      ]);
    },
  },
  {
    name: "validator requires exact non-overlapping X formatting snippets",
    run: () => {
      const validated = validateXEditorialModelOutput({
        config,
        output: {
          version: 1,
          status: "ready",
          marketId: "market-1",
          selectedSide: "YES",
          postText:
            "$56.4K is backing Spain to win the World Cup while the tracked trader remains up $542K.",
          formatting: [
            {
              style: "bold",
              text: "$56.4K is backing Spain",
            },
            { style: "italic", text: "backing Spain" },
            { style: "italic", text: "not present in the post" },
          ],
          storyFamily: "trader_profile",
          usedFactIds: ["market", "actor"],
          safetyFlags: [],
        },
        source,
      });
      assert.deepEqual(validated.issues.sort(), [
        "formatting_overlap:1",
        "formatting_text_missing:2",
      ]);
    },
  },
  {
    name: "recent opening history does not change the canonical source digest",
    run: () => {
      assert.equal(
        buildXEditorialSourceDigest(source),
        buildXEditorialSourceDigest({
          ...source,
          recentOpenings: ["Completely different comparison set"],
        }),
      );
    },
  },
  {
    name: "legacy X initial recovery selects only unsent composer skips",
    run: async () => {
      let capturedSql = "";
      let capturedParams: unknown[] = [];
      const noteIds = await loadXEditorialInitialRecoveryNoteIds({
        chatId: "-100987654",
        db: {
          query: async (sql: string, params?: unknown[]) => {
            capturedSql = sql;
            capturedParams = params ?? [];
            return {
              rows: [{ note_id: "00000000-0000-4000-8000-000000000321" }],
            } as never;
          },
        } as never,
      });

      assert.deepEqual(noteIds, ["00000000-0000-4000-8000-000000000321"]);
      assert.match(capturedSql, /telegram_message_id is null/);
      assert.match(
        capturedSql,
        /message_kind in \('initial', 'research_update'\)/,
      );
      assert.match(capturedSql, /editorialComposerV1,outcome/);
      assert.match(capturedSql, /editorialDraftV1,status/);
      assert.deepEqual(capturedParams, [
        "-100987654",
        "x_editorial_draft_v1",
        1,
      ]);
    },
  },
  {
    name: "publisher sends an editorial draft even when its signal-time quote is old",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: -100987654, title: "X drafts", type: "channel" },
        enabledBy: 42,
        now: new Date("2026-07-31T12:00:00.000Z"),
        redis,
      });
      await updateSignalBotContentProfile({
        chatId: "-100987654",
        contentProfile: "x_editorial_draft_v1",
        redis,
      });
      const now = new Date();
      const noteId = "00000000-0000-4000-8000-000000000321";
      const storedMessages = new Map<
        string,
        { id: string; messageId: number | null; metrics: unknown }
      >();
      const noteRow = {
        id: noteId,
        note_key: "holder_research:v2:test-editorial",
        title: "One trader is backing Spain",
        description:
          "A tracked trader has $56.4K on Spain while the market prices the outcome near 19%.",
        rationale: "Verified performance makes the minority position notable.",
        producer_run_id: "run-editorial",
        direction: "up",
        confidence: "0.9",
        model_meta: {},
        metrics: {
          publicationDecisionV1: HOLDER_RESEARCH_PUBLICATION_DECISION_V1,
          telegramMarketIdentityV1: {
            asOf: now.toISOString(),
            eventId: "polymarket:event-spain",
            eventTitle: "2026 World Cup winner",
            marketGroupItemTitle: "Spain",
            marketId: "polymarket:market-spain",
            marketQuestion: "Will Spain win the 2026 World Cup?",
            predicate: "win the 2026 World Cup",
            selectedSide: "YES",
            selectedSideLabel: "Spain",
            source: "canonical_market",
            subject: "Spain",
            venue: "polymarket",
            version: 1,
          },
          signalPriceSnapshotV1: {
            asOf: "2026-01-01T00:00:00.000Z",
            displayPrice: 0.19,
            displayPriceSource: "midpoint",
            displaySide: "YES",
            marketId: "polymarket:market-spain",
            NO: { ask: 0.82, bid: 0.8, mark: 0.81 },
            venue: "polymarket",
            version: 1,
            YES: { ask: 0.2, bid: 0.18, mark: 0.19 },
          },
        },
        created_at: now,
        revision_kind: "initial",
        meaningful_delta_reasons: [],
        decision_snapshot: null,
        previous_decision_snapshot: null,
        thesis_key: "holder_research:v2:spain:YES",
        thesis_root_note_id: noteId,
        primary_target_meta: { side: "YES" },
        market_id: "polymarket:market-spain",
        event_id: "polymarket:event-spain",
        market_venue: "polymarket",
        market_title: "Will Spain win the 2026 World Cup?",
        market_slug: "spain-world-cup",
        market_description: null,
        market_metadata: {},
        event_title: "2026 World Cup winner",
        event_description: null,
        category: "sports",
        event_category: "sports",
        series_key: null,
        series_title: null,
        close_time: new Date(now.getTime() + 86_400_000),
        expiration_time: null,
        outcomes: '["YES","NO"]',
        resolution_source: null,
        market_segment: "sports",
        best_bid: "0.18",
        best_ask: "0.20",
        last_price: "0.19",
        holder_address: "0x1234567890123456789012345678901234567890",
        holder_chain: "polygon",
        holder_wallet_id: "00000000-0000-4000-8000-000000000999",
        holder_target_meta: {
          actorMode: "single_holder",
          credentialBullets: ["Up $542K over the last 30 days"],
          openPnlUsd: -3_900,
          positionUsd: 56_400,
          side: "YES",
        },
      };
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          if (/from runtime_policies/i.test(sql)) return { rows: [] };
          if (sql.includes("publish_notes_seen")) {
            return {
              rows: [{ non_directional: 0, publish_notes_seen: 1, total: 1 }],
            };
          }
          if (sql.includes("from signal_bot_messages prior")) {
            return { rows: [] };
          }
          if (sql.includes("as post_text")) return { rows: [] };
          if (sql.includes("select id::text, telegram_message_id, metrics")) {
            const stored = storedMessages.get(String(params[2]));
            return {
              rows: stored
                ? [
                    {
                      id: stored.id,
                      metrics: stored.metrics,
                      telegram_message_id: stored.messageId,
                    },
                  ]
                : [],
            };
          }
          if (
            sql.includes("update signal_bot_messages") &&
            sql.includes("metrics #>> '{deliveryStateV2,attemptId}'")
          ) {
            const entry = [...storedMessages.entries()].find(
              ([, stored]) => stored.id === String(params[0]),
            );
            if (!entry) return { rowCount: 0, rows: [] };
            const [key, stored] = entry;
            const metrics = stored.metrics as {
              deliveryStateV2?: { attemptId?: unknown; status?: unknown };
            };
            const finishing = sql.includes("set telegram_message_id = $4");
            const expectedStatus = finishing ? params[1] : "reserved";
            const attemptId = finishing ? params[2] : params[1];
            if (
              metrics.deliveryStateV2?.status !== expectedStatus ||
              metrics.deliveryStateV2?.attemptId !== attemptId
            ) {
              return { rowCount: 0, rows: [] };
            }
            storedMessages.set(key, {
              id: stored.id,
              messageId:
                finishing && typeof params[3] === "number"
                  ? (params[3] as number)
                  : stored.messageId,
              metrics: JSON.parse(
                String(finishing ? params[4] : params[2]),
              ) as unknown,
            });
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("insert into signal_bot_messages")) {
            const messageKind = String(params[4]);
            if (storedMessages.has(messageKind)) {
              return { rowCount: 0, rows: [] };
            }
            const stored = {
              id: String(params[0]),
              messageId:
                typeof params[5] === "number" ? (params[5] as number) : null,
              metrics: JSON.parse(String(params[9])) as unknown,
            };
            storedMessages.set(messageKind, stored);
            return { rowCount: 1, rows: [{ id: stored.id }] };
          }
          if (sql.includes("from ai_notes n")) return { rows: [noteRow] };
          return { rows: [] };
        },
      };
      const telegramMessages: Array<Record<string, unknown>> = [];
      const telegram = {
        sendMessage: async (message: Record<string, unknown>) => {
          telegramMessages.push(message);
          return { messageId: 777, ok: true as const };
        },
      };
      let composeCalls = 0;
      const editorialText =
        "$56.4K is backing Spain to win the World Cup.\n\nSpain trades at 19¢. The wallet is up $542K over the last 30 days.\n\nLong odds. Proven hand.";
      const composer = async (input: { source: XEditorialDraftSource }) => {
        composeCalls += 1;
        const actor = input.source.facts.find((fact) => fact.id === "actor");
        const price = input.source.facts.find((fact) => fact.id === "price");
        assert.deepEqual(actor?.value, {
          actorMode: "single_holder",
          clusterOpenPnl: null,
          clusterPnl30d: null,
          clusterSharpHolders: null,
          clusterPosition: null,
          displayName: null,
          openPnl: "-$3.9K",
          positionSide: "YES",
          position: "$56.4K",
        });
        assert.deepEqual(price?.value, {
          displayPrice: "19¢",
          displaySide: "YES",
        });
        return {
          characterCount: Array.from(editorialText).length,
          formatting: [
            {
              style: "bold" as const,
              text: "$56.4K is backing Spain to win the World Cup.",
            },
          ],
          generatedAt: now.toISOString(),
          marketId: "polymarket:market-spain",
          model: "test/editorial-model",
          postText: editorialText,
          promptVersion: X_EDITORIAL_PROMPT_VERSION,
          safetyFlags: [],
          selectedSide: "YES" as const,
          sourceDigest: "",
          status: "ready" as const,
          storyFamily: "trader_profile" as const,
          usedFactIds: ["market", "price", "actor", "credentials"],
          version: 1 as const,
        };
      };
      const configWithEditorial = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TOKEN: "token",
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          "https://t.me/hunch_signal_bot/hunch",
        HUNCH_SIGNAL_BOT_X_EDITORIAL_ENABLED: "true",
      });
      const composedWithDigest = async (
        input: Parameters<typeof composer>[0],
      ) => {
        const draft = await composer(input);
        return {
          ...draft,
          sourceDigest: buildXEditorialSourceDigest(input.source),
        };
      };
      const first = await publishSignalBotTick({
        config: configWithEditorial,
        db: db as never,
        redis,
        telegram: telegram as never,
        xEditorialComposer: composedWithDigest,
      });
      const second = await publishSignalBotTick({
        config: configWithEditorial,
        db: db as never,
        redis,
        telegram: telegram as never,
        xEditorialComposer: composedWithDigest,
      });
      assert.equal(first.sent, 1);
      assert.equal(second.sent, 0);
      assert.equal(composeCalls, 1);
      assert.equal(telegramMessages.length, 1);
      const deliveredText = String(telegramMessages[0]?.text);
      assert.match(
        deliveredText,
        /^\*\$56\\\.4K is backing Spain to win the World Cup\\\.\*/,
      );
      assert.doesNotMatch(deliveredText, /```|Bold in X|Italic in X|🎨/);
      assert.doesNotMatch(deliveredText, /https?:\/\/|Website|Mini App/);
      assert.equal(telegramMessages[0]?.parse_mode, "MarkdownV2");
      assert.equal("reply_markup" in (telegramMessages[0] ?? {}), false);
      assert.equal(
        (
          storedMessages.get("initial")?.metrics as {
            contentProfile?: string;
            status?: string;
          }
        ).contentProfile,
        "x_editorial_draft_v1",
      );
      assert.equal(
        (
          storedMessages.get("initial")?.metrics as {
            status?: string;
          }
        ).status,
        "sent",
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[x-editorial-draft-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[x-editorial-draft-tests] passed ${passed}/${tests.length}`);
