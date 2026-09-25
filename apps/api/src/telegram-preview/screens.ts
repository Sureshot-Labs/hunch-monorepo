import { parseTelegramFundingCallbackRoute } from "../services/telegram-funding-contracts.js";
import assert from "node:assert/strict";
import { withTelegramPrivateNavigation } from "../services/telegram-bot-private-navigation.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import {
  buildSignalBotMenuScreen,
  type SignalBotMenuScreenName,
} from "../services/signal-bot.js";
import {
  stripTelegramCustomEmojiButtonIcons,
  stripTelegramCustomEmojiMarkdownV2,
} from "../services/telegram-custom-emoji.js";
import type { TelegramSendMessageInput } from "../services/signal-bot-contracts.js";
import {
  buildTelegramAccountValueMessage,
  buildTelegramAccountValueUnavailableMessage,
} from "../services/telegram-account-value.js";
import { buildTelegramPositionsSnapshotMessage } from "../services/telegram-bot-positions.js";
import { buildTelegramSettledPositionMessage } from "../services/telegram-position-presentation.js";
import { buildTelegramTradeHistorySnapshotMessage } from "../services/telegram-bot-trade-history.js";
import {
  buildDepositVenueMenu,
  buildJustDepositMenu,
} from "../services/telegram-bot-deposit.js";
import {
  buildTelegramFundingTargetMessage,
  buildTelegramFundingQrPhoto,
  buildTelegramFundingProgressMessage,
  buildTelegramFundingReviewQuoteMessage,
} from "../services/telegram-funding-presentation.js";
import {
  telegramPolygonFundingPresentation,
  TELEGRAM_POLYGON_USDCE_RETAINED_PRESENTATION,
} from "../services/telegram-funding-route.js";
import {
  telegramBotRewardsTestHooks as rewardRenderers,
  buildTelegramBotReferralCodeInputPrompt,
  buildTelegramBotReferralCodeConfirmation,
} from "../services/telegram-bot-rewards.js";
import {
  buildTelegramTradeProgressMessage,
  buildTelegramTradeInputPrompt,
} from "../services/telegram-bot-trading-presentation.js";
import {
  APP_URL,
  AS_OF,
  ID,
  market,
  marketMessage,
  marketRoutes,
  confirmation,
  lifecycle,
} from "./trading.js";
import { signalMessage } from "./signal.js";
import { account, position, rewards } from "./fixtures.js";

type Message = Pick<
  TelegramSendMessageInput,
  "text" | "parse_mode" | "reply_markup"
> & { rich_message?: object; photo?: { base64: string; filename: string } };
type Screen = {
  id: string;
  title: string;
  group: string;
  message: Message;
  fallback: Message;
  routes: Record<string, string>;
  input?: string;
};

export async function buildScreens() {
  const screens: Screen[] = [];
  function add(
    id: string,
    title: string,
    group: string,
    value: Message,
    input?: string,
  ) {
    if ((group === "Funding" || group === "Deposit routes") && !value.photo) {
      value = withTelegramPrivateNavigation(value);
    }
    // Select only Telegram wire fields; discard live-service metadata/IDs.
    const message: Message = {
      text: value.text,
      ...(value.parse_mode ? { parse_mode: value.parse_mode } : {}),
      ...(value.reply_markup ? { reply_markup: value.reply_markup } : {}),
      ...(value.rich_message ? { rich_message: value.rich_message } : {}),
      ...(value.photo ? { photo: value.photo } : {}),
    };
    const fallback = stripTelegramCustomEmojiButtonIcons({
      ...message,
      text: stripTelegramCustomEmojiMarkdownV2(message.text),
    });
    screens.push({
      id,
      title,
      group,
      message,
      fallback,
      routes: {},
      ...(input ? { input } : {}),
    });
  }

  const preferences = {
    bridgeUpdates: true,
    depositReceived: true,
    orderFilled: true,
    orderIssues: true,
    payoutsRewards: true,
    positionResolved: true,
    positionSignals: true,
    interestSignals: false,
    reachable: true,
    userId: ID,
  };
  const menus: Array<[SignalBotMenuScreenName, string]> = [
    ["home", "Home · signed in"],
    ["settings", "Settings"],
    ["help", "Help"],
    ["account", "Account"],
    ["notifications", "Notifications"],
    ["notification_trading", "Trading notifications"],
    ["notification_funds", "Funds notifications"],
    ["signals", "Signals"],
    ["market_input", "Search markets"],
  ];
  for (const [screen, title] of menus) {
    const value = buildSignalBotMenuScreen({
      appBaseUrl: APP_URL,
      audience: "linked",
      isAdmin: false,
      miniAppEnabled: true,
      notificationPreferences: preferences,
      screen,
    });
    add(
      screen,
      title,
      "Menu",
      {
        text: value.text,
        parse_mode: "MarkdownV2",
        reply_markup: value.keyboard,
      },
      screen === "market_input" ? "market" : undefined,
    );
  }
  for (const audience of ["guest", "unavailable"] as const) {
    const value = buildSignalBotMenuScreen({
      appBaseUrl: APP_URL,
      audience,
      isAdmin: false,
      miniAppEnabled: true,
      screen: "home",
    });
    add(`home_${audience}`, `Home · ${audience}`, "Menu", {
      text: value.text,
      parse_mode: "MarkdownV2",
      reply_markup: value.keyboard,
    });
  }
  for (const [topic, field] of Object.entries({
    order_filled: "orderFilled",
    order_issues: "orderIssues",
    position_resolved: "positionResolved",
    deposit_received: "depositReceived",
    bridge_updates: "bridgeUpdates",
    payouts_rewards: "payoutsRewards",
    position_signals: "positionSignals",
  })) {
    const screen =
      topic === "position_signals"
        ? "signals"
        : ["deposit_received", "bridge_updates", "payouts_rewards"].includes(
              topic,
            )
          ? "notification_funds"
          : "notification_trading";
    const value = buildSignalBotMenuScreen({
      appBaseUrl: APP_URL,
      audience: "linked",
      isAdmin: false,
      miniAppEnabled: true,
      notificationPreferences: { ...preferences, [field]: false },
      screen,
    });
    add(`off_${topic}`, `${topic} · off`, "Notifications", {
      text: value.text,
      parse_mode: "MarkdownV2",
      reply_markup: value.keyboard,
    });
  }
  add(
    "balance",
    "Balance · demo $175",
    "Account",
    buildTelegramAccountValueMessage({ account: account() }),
  );
  add(
    "balance_unavailable",
    "Balance unavailable",
    "Account",
    buildTelegramAccountValueUnavailableMessage(),
  );
  add(
    "positions",
    "My positions",
    "Account",
    buildTelegramPositionsSnapshotMessage({
      appBaseUrl: APP_URL,
      telegramMiniAppEnabled: true,
      snapshot: { partialFailure: false, positions: [position()] },
    }),
  );
  add(
    "positions_empty",
    "No positions",
    "Account",
    buildTelegramPositionsSnapshotMessage({
      appBaseUrl: APP_URL,
      telegramMiniAppEnabled: true,
      snapshot: { partialFailure: false, positions: [] },
    }),
  );
  for (const status of ["redeemable", "resolved_not_redeemable", "redeemed"]) {
    const message = buildTelegramSettledPositionMessage({
      appBaseUrl: APP_URL,
      telegramMiniAppEnabled: true,
      page: 0,
      detail: position(status),
    });
    assert.ok(message);
    add(status, `Position · ${status}`, "Account", message);
  }
  add(
    "trade_history",
    "Trading history",
    "Account",
    buildTelegramTradeHistorySnapshotMessage({
      snapshot: {
        trades: ["BUY", "SELL"].map((action) => ({
          action: action as "BUY" | "SELL",
          eventTitle: market.event_title,
          marketTitle: market.title,
          notionalUsd: 25,
          outcome: "YES",
          price: 0.42,
          shares: 59.52,
          tradedAt: new Date(AS_OF),
          venue: "polymarket",
        })),
      },
    }),
  );
  add("market", "Market · Buy & Sell", "Trading", await marketMessage());
  for (const side of ["YES", "NO"] as const)
    add(
      `market_${side}`,
      `Market · change amount · ${side}`,
      "Trading",
      await marketMessage(side),
    );
  for (const action of ["buy", "sell"] as const) {
    for (const side of ["YES", "NO"] as const) {
      add(
        `input_${action}_${side}`,
        `Custom ${action} · ${side}`,
        "Trading",
        buildTelegramTradeInputPrompt({ action, id: ID }),
        `${action}_${side}_${action === "buy" ? 25 : 50}`,
      );
      for (const amount of action === "buy" ? [10, 25, 50] : [50, 100]) {
        add(
          `${action}_${side}_${amount}`,
          `${action} ${side} · ${action === "buy" ? "$" : ""}${amount}${action === "sell" ? "%" : ""}`,
          "Confirmations",
          confirmation(action, side, amount),
        );
        for (const state of ["filled", "cancelled"] as const)
          add(
            `${action}_${side}_${amount}_${state}`,
            `${action} ${side} ${amount} · ${state}`,
            "Trade results",
            lifecycle(action, state, side, amount),
          );
      }
    }
    for (const state of [
      "awaiting_client",
      "filled",
      "failed",
      "cancelled",
      "quote_expired",
    ] as const) {
      add(
        `${action}_${state}`,
        `${action} · ${state}`,
        "Trade status",
        lifecycle(action, state),
      );
    }
  }
  for (const state of ["processing", "resolving"] as const)
    add(state, `Trade · ${state}`, "Trade status", {
      text: buildTelegramTradeProgressMessage(state),
      parse_mode: "MarkdownV2",
    });

  add(
    "deposit",
    "Deposit · venues",
    "Funding",
    buildDepositVenueMenu(["polymarket", "limitless"], null),
  );
  add(
    "deposit_active",
    "Deposit · active",
    "Funding",
    buildDepositVenueMenu(["polymarket", "limitless"], {
      canCancel: true,
      venue: "polymarket",
    }),
  );
  add(
    "deposit_any",
    "Deposit · assets & networks",
    "Funding",
    buildJustDepositMenu({
      solReceiveChoiceToken: "ps",
      usdcReceiveChoiceToken: "pu",
    }),
  );
  const presentation = telegramPolygonFundingPresentation("pusd_direct");
  const expiresAt = "2026-09-24T12:00:00.000Z";
  add(
    "fund_target",
    "Deposit · pUSD on Polygon",
    "Funding",
    buildTelegramFundingTargetMessage({
      automaticConversion: false,
      contextId: ID,
      expiresAt,
      presentation,
    }),
  );
  for (const state of [
    "waiting_for_transfer",
    "funds_received",
    "converting",
    "ready",
    "expired",
    "cancelled",
    "needs_attention",
  ] as const) {
    add(
      `fund_${state}`,
      `Funding · ${state}`,
      "Funding",
      buildTelegramFundingProgressMessage({
        version: 2,
        fundingContextId: ID,
        state,
        terminal: ["ready", "expired", "cancelled"].includes(state),
        presentation,
        assetSymbol: "pUSD",
        rawAmount: state === "waiting_for_transfer" ? null : "25000000",
        receiveAddress: "DEMO-ADDRESS-DO-NOT-SEND",
        expiresAt,
        observedAt: AS_OF,
      }),
    );
  }
  for (const [choice, mode] of [
    ["pd", "pusd_direct"],
    ["pw", "polymarket_polygon_usdce_retained"],
    ["ld", "limitless_base_usdc_direct"],
    ["ps", "polymarket_solana_sol_retained"],
    ["pu", "polymarket_solana_usdc_retained"],
  ] as const) {
    const route =
      choice === "pw"
        ? TELEGRAM_POLYGON_USDCE_RETAINED_PRESENTATION
        : telegramPolygonFundingPresentation(mode);
    const label = `${route.acceptedAssetSymbols.join(" / ")} · ${route.networkLabel}`;
    add(
      `fund_route_${choice}`,
      `Deposit · ${label}`,
      "Deposit routes",
      buildTelegramFundingTargetMessage({
        automaticConversion: false,
        contextId: ID,
        expiresAt,
        presentation: route,
      }),
    );
    const projection = {
      version: 2 as const,
      fundingContextId: ID,
      state: "waiting_for_transfer" as const,
      terminal: false,
      presentation: route,
      assetSymbol: route.destinationAssetSymbol,
      rawAmount: null,
      receiveAddress: "DEMO-ADDRESS-DO-NOT-SEND",
      expiresAt,
      observedAt: AS_OF,
    };
    add(
      `fund_waiting_${choice}`,
      `Waiting · ${label}`,
      "Deposit routes",
      buildTelegramFundingProgressMessage(projection),
    );
    add(
      `fund_ready_${choice}`,
      `Received · ${label}`,
      "Deposit routes",
      buildTelegramFundingProgressMessage({
        ...projection,
        state: "ready",
        terminal: true,
        rawAmount: "25000000",
      }),
    );
    const qr = await buildTelegramFundingQrPhoto(projection);
    add(`fund_qr_${choice}`, `QR · ${label}`, "Deposit routes", {
      text: qr.caption,
      parse_mode: "MarkdownV2",
      reply_markup: qr.reply_markup,
      photo: {
        base64: Buffer.from(qr.photo).toString("base64"),
        filename: qr.filename,
      },
    });
  }
  const asset = {
    assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
    networkId: "evm:137",
    decimals: 6,
  };
  add(
    "fund_quote",
    "Confirm conversion",
    "Funding",
    buildTelegramFundingReviewQuoteMessage({
      contextId: ID,
      quote: {
        quoteId: ID,
        liquidityProjectionId: ID,
        selectedSourceOptionId: ID,
        destinationOptionId: ID,
        venueBindingOptionId: ID,
        planKind: "wallet_route",
        experienceMode: "prepare_first",
        consentMode: "explicit_economic_review",
        sourceAmounts: [
          { safeLabel: "Demo pUSD", amount: { asset, raw: "25000000" } },
        ],
        expectedDestination: { asset, raw: "24800000" },
        minimumDestination: { asset, raw: "24500000" },
        fees: [],
        eta: null,
        requiredActions: [],
        ingress: null,
        planHash: "demo",
        consentToken: `consent_${"a".repeat(43)}`,
        expiresAt,
        policyVersion: 1,
      },
    }),
  );

  const rewardInput = {
    appBaseUrl: APP_URL,
    callbackPrefix: "hm:v1:",
    miniAppEnabled: true,
    summary: rewards,
  };
  add(
    "rewards",
    "Rewards & referrals",
    "Rewards",
    rewardRenderers.buildOverviewMessage({
      ...rewardInput,
      code: "DEMO42",
      hasReferrer: false,
      miniAppLinkBase: "https://t.me/preview_invalid_bot/demo",
      totalReferrals: 3,
    }),
  );
  add(
    "rewards_earnings",
    "Earnings",
    "Rewards",
    rewardRenderers.buildEarningsMessage(rewardInput),
  );
  add(
    "rewards_help",
    "How rewards work",
    "Rewards",
    rewardRenderers.buildHelpMessage(rewardInput),
  );
  add(
    "rewards_referrals",
    "My referrals",
    "Rewards",
    rewardRenderers.buildReferralsMessage({
      ...rewardInput,
      page: 0,
      sortBy: "createdAt",
      data: {
        referrals: [],
        total: 0,
        policy: rewards.policy,
        limit: 10,
        offset: 0,
        hasMore: false,
      },
    }),
  );
  add(
    "referral_input",
    "Change invite code",
    "Rewards",
    buildTelegramBotReferralCodeInputPrompt({
      callbackPrefix: "hm:v1:",
      action: "change",
    }),
    "referral_confirm",
  );
  add(
    "referral_attach",
    "Enter invite code",
    "Rewards",
    buildTelegramBotReferralCodeInputPrompt({
      callbackPrefix: "hm:v1:",
      action: "attach",
    }),
    "referral_attach_confirm",
  );
  add(
    "referral_attach_confirm",
    "Attach invite code",
    "Rewards",
    buildTelegramBotReferralCodeConfirmation({
      callbackPrefix: "hm:v1:",
      action: "attach",
      code: "DEMO2026",
    }),
  );
  add(
    "referral_confirm",
    "Confirm invite code",
    "Rewards",
    buildTelegramBotReferralCodeConfirmation({
      callbackPrefix: "hm:v1:",
      action: "change",
      code: "DEMO2026",
      currentCode: "DEMO42",
    }),
  );

  const signal = signalMessage();
  assert.ok(signal.publishable, "Demo signal must be publishable");
  add("signal_markdown", "Signal post · Markdown", "Signals", {
    text: signal.text,
    parse_mode: "MarkdownV2",
    reply_markup: signal.keyboard,
  });
  add("signal_rich", "Signal post · RichMessage", "Signals", {
    text: signal.text,
    parse_mode: "MarkdownV2",
    reply_markup: signal.keyboard,
    rich_message: signal.richMessage,
  });

  const menuRoutes: Record<string, string> = {
    home: "home",
    balance: "balance",
    positions: "positions",
    trade_history: "trade_history",
    settings: "settings",
    help: "help",
    notifications: "notifications",
    "trading:market_input": "market_input",
    "trading:cancel_input": "home",
    "settings:notifications": "notifications",
    "settings:notifications:trading": "notification_trading",
    "settings:notifications:funds": "notification_funds",
    "settings:signals": "signals",
    "settings:account": "account",
    deposit: "deposit",
    "deposit:any": "deposit_any",
    "deposit:polymarket": "fund_target",
    "deposit:limitless": "fund_route_ld",
    deposit_cancel_active: "fund_cancelled",
    rewards: "rewards",
  };
  for (const screen of screens) {
    for (const button of screen.message.reply_markup?.inline_keyboard.flat() ??
      []) {
      if (!("callback_data" in button)) continue;
      const callback = button.callback_data;
      let destination = menuRoutes[callback.replace(/^hm:v1:/, "")];
      const toggle = /^hm:v1:ntf:([^:]+):(on|off)$/.exec(callback);
      if (toggle) {
        const topic = (
          {
            fill: "order_filled",
            issues: "order_issues",
            resolution: "position_resolved",
            deposit: "deposit_received",
            bridge: "bridge_updates",
            payout: "payouts_rewards",
            position_signals: "position_signals",
          } as Record<string, string>
        )[toggle[1] ?? ""];
        destination =
          toggle[2] === "off"
            ? `off_${topic}`
            : topic === "position_signals"
              ? "signals"
              : [
                    "deposit_received",
                    "bridge_updates",
                    "payouts_rewards",
                  ].includes(topic ?? "")
                ? "notification_funds"
                : "notification_trading";
      }
      if (/^hm:v1:pos:/.test(callback)) destination = "market";
      if (/^hm:v1:pos_(hide|show):/.test(callback)) destination = "positions";
      if (/^hm:v1:positions_/.test(callback)) destination = "positions";
      if (/^hm:v1:deposit_route:/.test(callback))
        destination = `fund_route_${callback.split(":").at(-1)}`;
      const fundingRoute = parseTelegramFundingCallbackRoute(
        callback.replace(/^hm:v1:/, ""),
      );
      if (fundingRoute) {
        const choice =
          /^fund_(?:route|waiting|qr|ready)_([a-z]{2})$/.exec(screen.id)?.[1] ??
          "pd";
        destination =
          fundingRoute.kind === "select"
            ? `fund_waiting_${fundingRoute.choiceToken}`
            : (
                {
                  cancel: "fund_cancelled",
                  refresh: `fund_ready_${choice}`,
                  confirm_conversion: "fund_converting",
                  targets: "deposit_any",
                  qr: `fund_qr_${choice}`,
                  hide_qr: `fund_waiting_${choice}`,
                  review_conversion: "fund_quote",
                  back_to_market: "market",
                  review_buy: "buy_YES_25",
                  change_buy_amount: "input_buy_YES",
                } as Record<string, string>
              )[fundingRoute.kind];
      }
      if (/^hbt:/.test(callback)) {
        const action = callback.split(":")[1];
        const sell = screen.id.startsWith("sell_");
        if (marketRoutes[callback]) destination = marketRoutes[callback];
        else
          destination = (
            {
              cancel_input: "market",
              confirm: /^(buy|sell)_(YES|NO)_\d+$/.test(screen.id)
                ? `${screen.id}_filled`
                : sell
                  ? "sell_filled"
                  : "buy_filled",
              cancel: /^(buy|sell)_(YES|NO)_\d+$/.test(screen.id)
                ? "market"
                : sell
                  ? "sell_cancelled"
                  : "buy_cancelled",
              open_market: "market",
              change_amount: `market_${screen.id.includes("_NO_") ? "NO" : "YES"}`,
              retry_buy: sell ? "sell_filled" : "buy_filled",
              refresh_quote: sell ? "sell_YES_50" : "buy_YES_25",
            } as Record<string, string>
          )[action ?? ""];
      }
      if (/^hm:v1:rw:/.test(callback)) {
        const part = callback.split(":")[3];
        destination = (
          {
            r: "rewards_referrals",
            e: "rewards_earnings",
            h: "rewards_help",
            c: "referral_input",
            a: "referral_attach",
            ok: "rewards",
            x: "rewards",
          } as Record<string, string>
        )[part ?? ""];
      }
      assert.ok(destination, `${screen.id}: unmapped callback ${callback}`);
      screen.routes[callback] = destination;
    }
  }
  const ids = new Set(screens.map((screen) => screen.id));
  assert.equal(ids.size, screens.length);
  for (const screen of screens) {
    assert.ok(screen.message.text.trim(), `${screen.id}: empty screen`);
    for (const destination of Object.values(screen.routes))
      assert.ok(ids.has(destination), `${screen.id} -> ${destination}`);
  }
  return screens;
}
