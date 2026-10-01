#!/usr/bin/env tsx
import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { AuthService } from "./auth.js";
import { env } from "./env.js";
import type { LimitlessAuthContext } from "./services/limitless-auth.js";
import {
  fetchLimitlessWalletPortfolio,
  isLimitlessPortfolioSnapshot,
} from "./services/limitless-wallet-portfolio.js";
import {
  extractLimitlessTokenBalances,
  syncPositionsForUserWallet,
} from "./services/positions-sync.js";

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
      const authContext = context(id, walletAddress);
      const { snapshot, privateAuthContext } =
        await fetchLimitlessWalletPortfolio({
          walletAddress,
          authContext,
        });
      assert.equal(privateAuthContext, authContext);
      assert.deepEqual(extractLimitlessTokenBalances(snapshot), [
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
      return Response.json({
        clob: [{ tokensBalance: { "111": "2500000" } }],
        amm: [],
      });
    }) as typeof fetch;
    const rejectedContext = context(17, firstWallet);
    const rejectedResult = await fetchLimitlessWalletPortfolio({
      walletAddress: firstWallet,
      authContext: rejectedContext,
    });
    assert.equal(rejectedResult.privateAuthContext, null);
    assert.deepEqual(extractLimitlessTokenBalances(rejectedResult.snapshot), [
      { tokenId: "limitless:111", size: "2.5" },
    ]);
    assert.equal(rejectedContext.storedProfile?.id, 17);
    assert.equal(calls.length, 2);
    calls.length = 0;
    const mismatchedResult = await fetchLimitlessWalletPortfolio({
      walletAddress: firstWallet,
      authContext: context(70, secondWallet),
    });
    assert.equal(mismatchedResult.privateAuthContext, null);
    assert.deepEqual(calls, [
      { path: `/portfolio/${firstWallet}/positions`, profile: null },
    ]);
  });
  await test("public-only reads never authorize private history", async () => {
    for (const authContext of [
      null,
      { ...context(17, firstWallet), storedProfile: null },
      context(0, firstWallet),
    ]) {
      calls.length = 0;
      globalThis.fetch = (async (input, init) => {
        const path = new URL(String(input)).pathname;
        const headers = new Headers(init?.headers);
        calls.push({ path, profile: headers.get("x-on-behalf-of") });
        for (const header of [
          "lmts-api-key",
          "lmts-signature",
          "lmts-timestamp",
        ])
          assert.equal(headers.has(header), false);
        return Response.json({ clob: [], amm: [] });
      }) as typeof fetch;
      const result = await fetchLimitlessWalletPortfolio({
        walletAddress: firstWallet,
        authContext,
      });
      assert.equal(result.privateAuthContext, null);
      assert.deepEqual(calls, [
        { path: `/portfolio/${firstWallet}/positions`, profile: null },
      ]);
    }
  });
  await test("a malformed successful response is not an empty balance snapshot", async () => {
    for (const privateStatus of [200, 403]) {
      globalThis.fetch = (async (input) =>
        Response.json(
          {},
          {
            status:
              new URL(String(input)).pathname === "/portfolio/positions"
                ? privateStatus
                : 200,
          },
        )) as typeof fetch;
      await assert.rejects(
        fetchLimitlessWalletPortfolio({
          walletAddress: firstWallet,
          authContext: context(17, firstWallet),
        }),
        /incomplete portfolio/,
      );
    }
    assert.equal(
      isLimitlessPortfolioSnapshot({ data: { clob: [], amm: [] } }),
      true,
    );
    assert.equal(isLimitlessPortfolioSnapshot(null), false);
  });
  await test("a failed public fallback does not become an empty snapshot", async () => {
    globalThis.fetch = (async (input) =>
      Response.json(
        { message: "fixture unavailable" },
        {
          status:
            new URL(String(input)).pathname === "/portfolio/positions"
              ? 403
              : 503,
        },
      )) as typeof fetch;
    await assert.rejects(
      fetchLimitlessWalletPortfolio({
        walletAddress: firstWallet,
        authContext: context(17, firstWallet),
      }),
      /fixture unavailable/,
    );
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
  await test("temporary HTTP failures do not become public empty snapshots", async () => {
    for (const status of [429, 500, 503]) {
      calls.length = 0;
      globalThis.fetch = (async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, profile: null });
        return Response.json({ message: "fixture unavailable" }, { status });
      }) as typeof fetch;
      await assert.rejects(
        fetchLimitlessWalletPortfolio({
          walletAddress: firstWallet,
          authContext: context(17, firstWallet),
        }),
        /fixture unavailable/,
      );
      assert.ok(calls.length > 0);
      assert.ok(calls.every((call) => call.path === "/portfolio/positions"));
    }
  });
  await test("position sync skips rejected private history, retries next time, and isolates history failures", async () => {
    const originalCredentials = AuthService.getVenueCredentials;
    const originalWarn = console.warn;
    const authContext = context(17, firstWallet);
    const storedCredentials = {
      additionalData: {
        authMode: "partner_hmac",
        profile: authContext.storedProfile,
      },
      isActive: true,
    } as Awaited<ReturnType<typeof AuthService.getVenueCredentials>>;
    const client = {
      query: async () => ({ rows: [], rowCount: 0 }),
      release() {},
    };
    const pool = {
      query: client.query,
      connect: async () => client,
    } as unknown as Pool;
    const warnings: unknown[][] = [];
    AuthService.getVenueCredentials = async () => storedCredentials;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      // Production incident shape: stored wallet/profile match, but private
      // portfolio is forbidden while the exact public wallet remains readable.
      for (const [privateStatus, historyStatus] of [
        [403, 200],
        [401, 200],
        [200, 200],
        [200, 403],
      ]) {
        calls.length = 0;
        warnings.length = 0;
        globalThis.fetch = (async (input, init) => {
          const path = new URL(String(input)).pathname;
          const profile = new Headers(init?.headers).get("x-on-behalf-of");
          calls.push({ path, profile });
          if (path === "/portfolio/positions") {
            assert.equal(profile, "17");
            return Response.json(
              { clob: [], amm: [] },
              { status: privateStatus },
            );
          }
          if (path === `/portfolio/${firstWallet}/positions`) {
            assert.equal(profile, null);
            return Response.json({ clob: [], amm: [] });
          }
          assert.equal(path, "/portfolio/history");
          assert.equal(profile, "17");
          return Response.json(
            historyStatus === 200
              ? { data: [] }
              : { message: "Not authorized to act on behalf of this profile" },
            { status: historyStatus },
          );
        }) as typeof fetch;
        const result = await syncPositionsForUserWallet(pool, {
          userId: "fixture-user",
          walletAddress: firstWallet,
          venue: "limitless",
        });
        assert.equal(result.venue, "limitless");
        assert.equal(result.heldTokens, 0);
        assert.equal(result.flattenedPositions, 0);
        assert.deepEqual(
          calls.map((call) => call.path),
          [
            "/portfolio/positions",
            privateStatus === 200
              ? "/portfolio/history"
              : `/portfolio/${firstWallet}/positions`,
          ],
        );
        assert.equal(warnings.length, historyStatus === 403 ? 1 : 0);
        assert.equal(storedCredentials?.isActive, true);
        assert.deepEqual(storedCredentials?.additionalData, {
          authMode: "partner_hmac",
          profile: { id: 17, account: firstWallet },
        });
      }
    } finally {
      AuthService.getVenueCredentials = originalCredentials;
      console.warn = originalWarn;
    }
  });
} finally {
  globalThis.fetch = originalFetch;
  env.limitlessHmacTokenId = originalToken;
  env.limitlessHmacSecret = originalSecret;
}
