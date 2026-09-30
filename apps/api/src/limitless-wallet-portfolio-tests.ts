#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { env } from "./env.js";
import type { LimitlessAuthContext } from "./services/limitless-auth.js";
import {
  fetchLimitlessWalletPortfolio,
  isLimitlessPortfolioSnapshot,
} from "./services/limitless-wallet-portfolio.js";
import { extractLimitlessTokenBalances } from "./services/positions-sync.js";

const firstWallet = "0x0000000000000000000000000000000000000017";
const secondWallet = "0x0000000000000000000000000000000000000070";
function context(id: number, account: string): LimitlessAuthContext {
  return {
    authMode: "partner_hmac",
    creds: {} as never,
    storedProfile: { id, account },
  };
}
async function test(name: string, run: () => Promise<void> | void) {
  await run();
  console.log(`ok - ${name}`);
}
const originalFetch = globalThis.fetch;
const originalToken = env.limitlessHmacTokenId;
const originalSecret = env.limitlessHmacSecret;
env.limitlessHmacTokenId = "fixture-token";
env.limitlessHmacSecret = Buffer.from("fixture-secret").toString("base64");
const calls: { path: string; profile: string | null }[] = [];
try {
  await test("two wallets receive their own CLOB and AMM portfolio, never the partner portfolio", async () => {
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const profile = new Headers(init?.headers).get("x-on-behalf-of");
      calls.push({ path, profile });
      assert.equal(path, "/portfolio/positions");
      assert.ok(profile === "17" || profile === "70");
      const token = profile === "17" ? "111" : "222";
      return Response.json({
        clob: [{ tokensBalance: { [token]: "2500000" } }],
        amm: [],
      });
    }) as typeof fetch;
    for (const [walletAddress, id, tokenId] of [
      [firstWallet, 17, "limitless:111"],
      [secondWallet, 70, "limitless:222"],
    ] as const) {
      const payload = await fetchLimitlessWalletPortfolio({
        walletAddress,
        authContext: context(id, walletAddress),
      });
      assert.deepEqual(extractLimitlessTokenBalances(payload), [
        { tokenId, size: "2.5" },
      ]);
    }
    assert.equal(calls.length, 2);
  });
  await test("an unauthorized profile falls back only to the exact public wallet address", async () => {
    calls.length = 0;
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const profile = new Headers(init?.headers).get("x-on-behalf-of");
      calls.push({ path, profile });
      if (path === "/portfolio/positions")
        return Response.json(
          { message: "Not authorized to act on behalf of this profile" },
          { status: 403 },
        );
      assert.equal(path, `/portfolio/${firstWallet}/positions`);
      assert.equal(profile, null);
      return Response.json({ clob: [], amm: [] });
    }) as typeof fetch;
    await fetchLimitlessWalletPortfolio({
      walletAddress: firstWallet,
      authContext: context(17, firstWallet),
    });
    assert.equal(calls.length, 2);
    calls.length = 0;
    await fetchLimitlessWalletPortfolio({
      walletAddress: firstWallet,
      authContext: context(70, secondWallet),
    });
    assert.deepEqual(calls, [
      { path: `/portfolio/${firstWallet}/positions`, profile: null },
    ]);
  });
  await test("a malformed successful response is not an empty balance snapshot", async () => {
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    await assert.rejects(
      fetchLimitlessWalletPortfolio({
        walletAddress: firstWallet,
        authContext: context(17, firstWallet),
      }),
      /incomplete portfolio/,
    );
    assert.equal(
      isLimitlessPortfolioSnapshot({ data: { clob: [], amm: [] } }),
      true,
    );
    assert.equal(isLimitlessPortfolioSnapshot(null), false);
  });
  await test("provider timeouts propagate instead of writing zero balances", async () => {
    globalThis.fetch = async () => {
      throw new DOMException("fixture timeout", "TimeoutError");
    };
    await assert.rejects(
      fetchLimitlessWalletPortfolio({
        walletAddress: firstWallet,
        authContext: context(17, firstWallet),
      }),
    );
  });
} finally {
  globalThis.fetch = originalFetch;
  env.limitlessHmacTokenId = originalToken;
  env.limitlessHmacSecret = originalSecret;
}
