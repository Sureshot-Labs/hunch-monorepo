import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hip4Identity } from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import type { ApiTradeMarket } from "./services/api-trading-market-repo.js";
import { quoteTelegramNativeTradeReview } from "./services/telegram-native-trade-review.js";
import type { quoteHip4MarketOrderWithCurrentContext } from "./services/hip4-order-runtime.js";
import { calculateHip4OrderAmounts } from "./services/hip4-order-amounts.js";
import { sizeHip4MarketOrder } from "./services/hip4-market-order.js";
import { parseTelegramAppHandoffNativeTrade } from "./services/telegram-app-handoff-native-trade.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";

const identity = hip4Identity("mainnet", 123);
const userId = randomUUID();
const controllerWalletRef = randomUUID();
const telegramAccountLinkId = randomUUID();
const market: ApiTradeMarket = {
  id: identity.marketId,
  venue: "hyperliquid",
  venue_market_id: "123",
  event_id: "hyperliquid:mainnet:question:12",
  event_title: "Question",
  title: "Outcome",
  status: "ACTIVE",
  token_yes: identity.sides[0].tokenId,
  token_no: identity.sides[1].tokenId,
  accepting_orders: true,
  best_ask: null,
  best_bid: null,
  clob_token_ids: null,
  close_time: null,
  event_end_time: null,
  expiration_time: null,
  is_initialized: true,
  last_price: null,
  metadata: {},
  outcomes: '["Yes","No"]',
  slug: null,
  updated_at: null,
};

for (const side of ["BUY", "SELL"] as const) {
  for (const outcomeSide of ["YES", "NO"] as const) {
    const request = {
      requestKey: randomUUID(),
      controllerWalletRef,
      marketId: identity.marketId,
      side,
      outcomeSide,
      consentedDebitCapRaw: side === "BUY" ? "1000000001" : "2050001",
      slippageBps: 500,
    };
    const now = Date.now();
    const sized = sizeHip4MarketOrder({
      request,
      book: {
        coin: identity.sides[outcomeSide === "YES" ? 0 : 1].coin,
        time: now,
        levels: [
          [{ px: "0.49", sz: "1", n: 1 }],
          [{ px: "0.5", sz: "2", n: 1 }],
        ],
      },
      now,
      bookMaxAgeMs: 10000,
    });
    const amounts = calculateHip4OrderAmounts({
      ...sized.preparationRequest,
      environment: "mainnet",
      policy: { revision: "test-policy", minimumBuyNotionalUsd: "1" },
      feeCapRaw: "0",
    });
    assert.equal(amounts.kind, "calculated");
    if (amounts.kind !== "calculated") throw new Error("invalid fixture");
    const quoted = {
      ...sized,
      amounts,
      feeQuote: null,
      expiresAfter: now + 10000,
      profile: {
        walletId: controllerWalletRef,
        controllerWalletRef,
        networkId: "hyperliquid:mainnet",
        address: `0x${"1".repeat(40)}`,
        source: "external",
        serverWalletRef: null,
        signingModes: ["web_client"],
        sponsorshipPolicyIds: [],
      },
    } as unknown as Awaited<
      ReturnType<typeof quoteHip4MarketOrderWithCurrentContext>
    >;
    let reads = 0;
    const review = await quoteTelegramNativeTradeReview(
      {} as Pool,
      { userId, telegramAccountLinkId, market, request },
      {
        quote: async (_pool, input) => {
          reads++;
          assert.equal(input.actor, "web_app");
          assert.deepEqual(input.request, request);
          return quoted;
        },
      },
    );
    assert.equal(reads, 1);
    assert.equal(review.authority.walletSource, "external");
    assert.equal(review.authority.serverWalletRef, null);
    const native = parseTelegramAppHandoffNativeTrade(review.trade);
    assert.ok(native);
    assert.equal(native.consentedDebitCapRaw, request.consentedDebitCapRaw);
    assert.equal(native.quantity, sized.preparationRequest.quantity);
    assert.equal(native.limitPrice, sized.preparationRequest.limitPrice);
    assert.equal(native.timeInForce, "Ioc");
    assert.equal(review.trade.sharesRaw, undefined);
    assert.equal(review.trade.amountUsd, undefined);
    assert.equal(review.trade.minimumReceiveRaw, undefined);
    assert.deepEqual(
      review.requiredSpend,
      side === "BUY"
        ? { asset: HYPERCORE_MAINNET_USDC, raw: amounts.debitCapRaw }
        : null,
    );
    await assert.rejects(
      quoteTelegramNativeTradeReview(
        {} as Pool,
        { userId, telegramAccountLinkId, market, request },
        {
          quote: async () => ({
            ...quoted,
            preparationRequest: {
              ...quoted.preparationRequest,
              consentedDebitCapRaw: "999999999999",
            },
          }),
        },
      ),
      /quote_scope_changed/u,
    );
    await assert.rejects(
      quoteTelegramNativeTradeReview(
        {} as Pool,
        {
          userId,
          telegramAccountLinkId,
          market: { ...market, id: "hyperliquid:mainnet:outcome:124" },
          request,
        },
        {
          quote: async () => {
            throw new Error("must not query");
          },
        },
      ),
      /market_changed/u,
    );
  }
}
console.log(
  "telegram native trade review: ordinary IOC BUY/SELL YES/NO, external authority, exact caps and no legacy unit fallback passed",
);
