#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "@hunch/infra";

import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import { TradingServiceError } from "./services/trading-errors.js";

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

const tests: TestCase[] = [
  {
    name: "API-owned bot execution stays fail-closed for all venues",
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
        assert.equal(capability.supportsBuy, false);
        assert.equal(capability.supportsSell, false);
        assert.equal(capability.supportsSetup, false);
        assert.equal(capability.authorizationModes.includes("unsupported"), true);
      }
      const readiness = await trading.getReadiness({
        actor: {
          kind: "telegram_bot",
          userId: "user-1",
        },
        venue: "polymarket",
        walletAddress: "0x0000000000000000000000000000000000000001",
        walletChain: "ethereum",
      });
      assert.equal(readiness.ready, false);
      assert.equal(readiness.executable, false);
      assert.equal(readiness.reasonCode, "unsupported_capability");
    },
  },
  {
    name: "Polymarket quote route remains token-only REST compatible",
    run: () => {
      const routeSource = readFileSync(
        resolve(apiSrcDir, "routes/polymarket-private.ts"),
        "utf8",
      );
      assert.doesNotMatch(routeSource, /createApiTradingApplicationService/);
      assert.match(routeSource, /quotePolymarketOrder\(pool,/);
      assert.match(routeSource, /return reply\.send\(quote\)/);
    },
  },
  {
    name: "API bot executor is a small fail-closed boundary",
    run: () => {
      const source = readFileSync(
        resolve(apiSrcDir, "services/api-trading-service.ts"),
        "utf8",
      );
      assert.doesNotMatch(source, /trading-adapters\.js/);
      assert.doesNotMatch(source, /VenueTradingRegistry/);
      assert.doesNotMatch(source, /new PolymarketTradingAdapter/);
      assert.doesNotMatch(source, /privy-service\.js/);
      assert.doesNotMatch(source, /from "\.\.\/env\.js"/);
      assert.doesNotMatch(source, /polymarketL2Request/);
      assert.doesNotMatch(source, /dflow-trading-service\.js/);
      assert.doesNotMatch(source, /limitlessRequest/);
      assert.match(source, /BOT_EXECUTION_DISABLED_MESSAGE/);
    },
  },
  {
    name: "API bot executor rejects quote and submit before venue side effects",
    run: async () => {
      const trading = createApiTradingApplicationService({
        pool: {} as Pool,
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
        walletAddress: "0x0000000000000000000000000000000000000001",
        walletChain: "ethereum" as const,
      };
      await assert.rejects(
        trading.quote({ intent }),
        (error: unknown) =>
          error instanceof TradingServiceError &&
          error.code === "unsupported_capability",
      );
      await assert.rejects(
        trading.prepareTrade({ intent, quote: null }),
        (error: unknown) =>
          error instanceof TradingServiceError &&
          error.code === "unsupported_capability",
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
