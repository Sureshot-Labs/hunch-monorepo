#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "@hunch/infra";

import { createApiTradingApplicationService } from "./services/api-trading-service.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const apiSrcDir = dirname(fileURLToPath(import.meta.url));

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
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
    name: "API-owned trading execution advertises venue buy capabilities",
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
        assert.equal(capability.supportsSell, false);
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
        venue: "polymarket",
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
      assert.match(routeSource, /quotePolymarketOrder\(pool,/);
      assert.match(routeSource, /return reply\.send\(quote\)/);
    },
  },
  {
    name: "migrated REST execution endpoints delegate to shared venue services",
    run: () => {
      const polymarketRoute = readFileSync(
        resolve(apiSrcDir, "routes/polymarket-private.ts"),
        "utf8",
      );
      const polymarketOrderBlock = sourceSlice(
        polymarketRoute,
        '   * POST /order\n   * Place a signed Polymarket order',
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

      const polymarketOrderHashBlock = sourceSlice(
        polymarketRoute,
        "   * POST /order-hash",
        "   * GET /funder-derive",
      );
      assert.match(
        polymarketOrderHashBlock,
        /computePolymarketOrderHashRoute/,
      );
      assert.doesNotMatch(polymarketOrderHashBlock, /fetchPolymarketOrderHashV2/);
      assert.doesNotMatch(polymarketOrderHashBlock, /normalizeOrderForHash/);

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
      assert.doesNotMatch(polymarketMaxSpendBlock, /fetchOpenOrderCollateralLocks/);

      const polymarketAccountBlock = sourceSlice(
        polymarketRoute,
        "   * GET /account",
        "  z.get(\n    \"/redemption-plan\"",
      );
      assert.match(polymarketAccountBlock, /fetchPolymarketAccountRoute/);
      assert.doesNotMatch(polymarketAccountBlock, /fetchEvmCode/);
      assert.doesNotMatch(polymarketAccountBlock, /fetchPolymarketOnchainSnapshot/);

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
      const limitlessAmmQuoteBlock = sourceSlice(
        limitlessRoute,
        "   * GET /amm/quote",
        "   * GET /redemption/status",
      );
      assert.match(limitlessAmmQuoteBlock, /quoteLimitlessAmmRoute/);
      assert.doesNotMatch(limitlessAmmQuoteBlock, /quoteLimitlessAmmTrade/);

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
      assert.doesNotMatch(limitlessAmmOrderBlock, /storeOrder/);
      assert.doesNotMatch(limitlessAmmOrderBlock, /applyOptimisticPositionTrade/);

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
      assert.doesNotMatch(limitlessHistorySyncBlock, /syncLimitlessHistoryForWallet/);
      assert.doesNotMatch(limitlessHistorySyncBlock, /resolveLimitlessAuthContext/);

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
      assert.match(limitlessBatchCancelBlock, /cancelLimitlessOrdersBatchRoute/);
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

      const dflowRoute = readFileSync(
        resolve(apiSrcDir, "routes/dflow-private.ts"),
        "utf8",
      );
      assert.match(dflowRoute, /quoteKalshiDflowRoute/);
      assert.match(dflowRoute, /buildKalshiDflowSwapRoute/);
      assert.match(dflowRoute, /submitKalshiDflowSignedTransactionRoute/);
      assert.match(dflowRoute, /recordKalshiDflowExecutionRoute/);
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
          venue: "polymarket",
          venueMarketId: "venue-market-1",
        },
        venue: "polymarket",
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
    },
  },
];

for (const test of tests) {
  await test.run();
  console.log(`ok - ${test.name}`);
}
