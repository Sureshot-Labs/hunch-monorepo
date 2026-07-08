#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "@hunch/infra";

import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import { executePreparedTradeLifecycle } from "./services/api-trading-utils.js";
import type { PreparedTrade, SubmitResult } from "./services/trading-types.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const apiSrcDir = dirname(fileURLToPath(import.meta.url));

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
      assert.doesNotMatch(limitlessAccountBlock, /fetchEvmCode/);
      assert.doesNotMatch(
        limitlessAccountBlock,
        /fetchLimitlessOnchainSnapshot/,
      );
      assert.doesNotMatch(limitlessAccountBlock, /fetchErc1155BalancesByOwner/);

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

      const dflowRoute = readFileSync(
        resolve(apiSrcDir, "routes/dflow-private.ts"),
        "utf8",
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
      assert.match(executorBlock, /applyOrderTradeEffects\(ctx, effectsInput\)/);
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
      assert.match(limitlessRestSyncServiceBlock, /resolveLimitlessRouteAuth/);
      assert.match(limitlessBotSubmitBlock, /submitLimitlessClobOrderToVenue/);
      assert.match(limitlessRestSubmitBlock, /extractLimitlessSubmittedOrder/);
      assert.match(limitlessBotSubmitBlock, /extractLimitlessSubmittedOrder/);
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
      assert.match(confirmLifecycleBlock, /trading\.prepareTrade/);
      assert.match(confirmLifecycleBlock, /trading\.executePreparedTrade/);
      assert.match(confirmLifecycleBlock, /onSubmitted/);
      assert.doesNotMatch(confirmLifecycleBlock, /trading\.submitPreparedTrade/);
      assert.doesNotMatch(confirmLifecycleBlock, /trading\.persistTrade/);
      assert.doesNotMatch(confirmLifecycleBlock, /trading\.applyTradeEffects/);
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
      assert.doesNotMatch(
        limitlessHistory,
        /markOrderPositionDeltaApplied/,
      );
    },
  },
  {
    name: "bot trading readiness and persistence preserve venue-specific safety checks",
    run: () => {
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
      const dflowRoute = readFileSync(
        resolve(apiSrcDir, "routes/dflow-private.ts"),
        "utf8",
      );

      const polymarketReadinessBlock = sourceSlice(
        polymarket,
        "async function getReadiness(",
        "async function quote(",
      );
      assert.match(
        polymarketReadinessBlock,
        /resolvePolymarketMaxSpendFunds/,
      );
      assert.match(polymarketReadinessBlock, /executableFundsRaw <= 0n/);

      const limitlessExchangeBlock = sourceSlice(
        limitless,
        "function extractLimitlessMarketExchangeAddress(",
        "function extractLimitlessMarketAdapterAddress(",
      );
      assert.match(limitlessExchangeBlock, /venueExchange/);
      assert.match(limitlessExchangeBlock, /venue_exchange/);
      assert.match(limitlessExchangeBlock, /negRiskExchange/);
      assert.match(limitless, /extractLimitlessMarketExchangeAddress\(market\.metadata\)/);
      assert.match(limitless, /upsertLimitlessVenueShareAccrualFromOrderPayload/);
      assert.match(limitless, /upstreamPayload/);
      assert.match(limitless, /isLimitlessBotClobExecutable/);
      assert.match(limitless, /limitless_clob_slippage_guard_unavailable/);
      assert.match(
        limitless,
        /CLOB bot trading is disabled until slippage can be enforced/,
      );

      assert.match(kalshi, /extractDflowErrorCode/);
      assert.match(kalshi, /code === "route_not_found"/);
      assert.doesNotMatch(kalshi, /upstream\.payload\.code === "route_not_found"/);
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
      assert.match(kalshiRecordBlock, /statusMode === "verified" && txSignature/);
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
      assert.doesNotMatch(
        migration,
        /prepared_snapshot <> '\{\}'::jsonb/,
      );
    },
  },
  {
    name: "Limitless bot AMM path is backend-executed and receipt-gated",
    run: () => {
      const limitless = readFileSync(
        resolve(apiSrcDir, "services/limitless-trading-execution-service.ts"),
        "utf8",
      );
      const readinessBlock = sourceSlice(
        limitless,
        "async function getReadiness(",
        "async function quote(",
      );
      assert.match(limitless, /readString\(metadata\.tradeType\)/);
      assert.match(readinessBlock, /readLimitlessAmmMarketAddress/);
      assert.doesNotMatch(
        readinessBlock,
        /AMM bot execution is not route-equivalent/,
      );

      const quoteBlock = sourceSlice(
        limitless,
        "async function quote(",
        "function canonicalLimitlessOrderPayload",
      );
      assert.match(quoteBlock, /quoteLimitlessAmmTrade/);
      assert.match(quoteBlock, /kind: "limitless_amm"/);

      const prepareAmmBlock = sourceSlice(
        limitless,
        "async function prepareLimitlessAmmTrade(",
        "async function prepareTrade(",
      );
      assert.match(prepareAmmBlock, /fetchLimitlessOnchainSnapshot/);
      assert.match(prepareAmmBlock, /allowanceRaw < amountRaw/);
      assert.match(prepareAmmBlock, /minOutcomeTokensRaw/);

      const submitAmmBlock = sourceSlice(
        limitless,
        "async function submitLimitlessAmmPreparedTrade(",
        "function parseLimitlessPreparedPayload",
      );
      assert.match(submitAmmBlock, /sendLimitlessServerEvmTransaction/);
      assert.match(submitAmmBlock, /encodeLimitlessAmmUsdcApproval/);
      assert.match(submitAmmBlock, /encodeLimitlessAmmBuy/);
      assert.match(submitAmmBlock, /status: "filled"/);

      const sendBlock = sourceSlice(
        limitless,
        "async function sendLimitlessServerEvmTransaction(",
        "async function getReadiness(",
      );
      assert.match(sendBlock, /executeServerEmbeddedEthereumTransaction/);

      const recordBlock = sourceSlice(
        limitless,
        "export async function recordLimitlessAmmOrder(",
        "function isLimitlessAmmMarket",
      );
      assert.match(recordBlock, /waitForEmbeddedEthereumTransactionReceipt/);
      assert.match(recordBlock, /settlementMode === "legacy_assume_filled"/);
      assert.match(recordBlock, /settlementMode === "confirmed"/);
      assert.match(
        recordBlock,
        /Limitless AMM transaction not confirmed yet; recording pending order/,
      );
      assert.match(
        recordBlock,
        /const status = onchainConfirmed \? "filled" : "submitted"/,
      );
      assert.match(recordBlock, /onchainConfirmed/);
      assert.match(recordBlock, /includes\("failed onchain"\)/);
      assert.match(recordBlock, /statusCode: 409/);
      assert.match(recordBlock, /dbOrderId: stored\.order\.id/);

      const persistBlock = sourceSlice(
        limitless,
        "async function persistTrade(",
        "async function applyLimitlessTradeEffects",
      );
      assert.match(persistBlock, /orderId: recorded\.payload\.dbOrderId/);
      assert.match(
        persistBlock,
        /_hunchUpstream:\s*upstreamPayload/,
      );
      assert.match(persistBlock, /upstreamPayload,\s*filledAt,/);

      const embeddedEthereum = readFileSync(
        resolve(apiSrcDir, "services/embedded-ethereum.ts"),
        "utf8",
      );
      const serverEvmBlock = sourceSlice(
        embeddedEthereum,
        "export async function executeServerEmbeddedEthereumTransaction(",
        "export async function executeEmbeddedEthereumTransactionRequests(",
      );
      assert.match(serverEvmBlock, /walletApi\.ethereum\.sendTransaction/);
      assert.match(serverEvmBlock, /waitForEvmTransaction/);

      assert.match(
        limitless,
        /applyTradeEffects: \(input\) => applyLimitlessTradeEffects/,
      );
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
