#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { AuthService } from "./auth.js";
import { env } from "./env.js";
import { PrivyService } from "./privy-service.js";
import { limitlessPrivateRoutes } from "./routes/limitless-private.js";
import {
  extractLimitlessPartnerAccountProfile,
  extractLimitlessPartnerAccountProfiles,
  buildLimitlessWalletRequestAuthInputs,
  isLimitlessAuthUnavailable,
  loadLimitlessProfileForWallet,
  verifyLimitlessAuthContext,
  type LimitlessAuthContext,
} from "./services/limitless-auth.js";

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function buildAuthContext(
  profile: { id?: number; account?: string; client?: string } | null,
): LimitlessAuthContext {
  return {
    creds: {
      id: "cred-1",
      userId: "user-1",
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
      venue: "limitless",
      apiKey: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
      apiSecret: "",
      isActive: true,
      additionalData: profile
        ? { authMode: "partner_hmac", profile }
        : { authMode: "partner_hmac" },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    authMode: "partner_hmac",
    storedProfile: profile,
  };
}

test("verifyLimitlessAuthContext rejects when partner HMAC is not configured", async () => {
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;
  env.limitlessHmacTokenId = "";
  env.limitlessHmacSecret = "";

  try {
    const result = await verifyLimitlessAuthContext({
      authContext: buildAuthContext({
        id: 460208,
        account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
        client: "eoa",
      }),
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 503);
    assert.equal(result.message, "Limitless is temporarily unavailable.");
  } finally {
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
});

test("verifyLimitlessAuthContext rejects stored profiles bound to another wallet", async () => {
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;
  env.limitlessHmacTokenId = "token-id";
  env.limitlessHmacSecret = "c2VjcmV0";

  try {
    const result = await verifyLimitlessAuthContext({
      authContext: buildAuthContext({
        id: 123,
        account: "0x1111111111111111111111111111111111111111",
        client: "eoa",
      }),
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.equal(
      result.message,
      "Stored Limitless profile belongs to a different account.",
    );
  } finally {
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
});

test("loadLimitlessProfileForWallet merges stored and base profile fields", async () => {
  const profile = await loadLimitlessProfileForWallet({
    walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    authContext: { authMode: "partner_hmac" },
    additionalData: {
      authMode: "partner_hmac",
      profile: {
        account: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
        client: "eoa",
      },
    },
    baseProfile: {
      id: 460208,
      rank: { feeRateBps: 300 },
    },
  });

  assert.equal(profile?.id, 460208);
  assert.equal(profile?.client, "eoa");
  assert.equal(profile?.rank?.feeRateBps, 300);
});

test("extractLimitlessPartnerAccountProfile accepts direct account lookup shape", async () => {
  const profile = extractLimitlessPartnerAccountProfile(
    {
      profileId: 789,
      account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
    },
    "0xd829f31579e3129a551c9ab3980efa8e5e041131",
  );

  assert.equal(profile?.id, 789);
  assert.equal(profile?.account, "0xD829f31579e3129a551c9AB3980eFA8E5E041131");
});

test("extractLimitlessPartnerAccountProfile picks matching account from list wrappers", async () => {
  const payload = {
    items: [
      {
        profileId: 111,
        account: "0x1111111111111111111111111111111111111111",
      },
      {
        profile: {
          id: 222,
          walletAddress: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
          rank: { feeRateBps: "250" },
        },
      },
    ],
  };

  const profiles = extractLimitlessPartnerAccountProfiles(payload);
  const profile = extractLimitlessPartnerAccountProfile(
    payload,
    "0xd829f31579e3129a551c9ab3980efa8e5e041131",
  );

  assert.equal(profiles.length, 2);
  assert.equal(profile?.id, 222);
  assert.equal(profile?.rank?.feeRateBps, 250);
});

test("extractLimitlessPartnerAccountProfile rejects non-matching accounts", async () => {
  const profile = extractLimitlessPartnerAccountProfile(
    {
      profileId: 789,
      account: "0x1111111111111111111111111111111111111111",
    },
    "0xd829f31579e3129a551c9ab3980efa8e5e041131",
  );

  assert.equal(profile, null);
});

test("extractLimitlessPartnerAccountProfile rejects lookup entries without profile id", async () => {
  const profile = extractLimitlessPartnerAccountProfile(
    {
      account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
    },
    "0xd829f31579e3129a551c9ab3980efa8e5e041131",
  );

  assert.equal(profile, null);
});

test("resolveLimitlessAuthContext does not upgrade legacy auth rows implicitly", async () => {
  const { resolveLimitlessAuthContext } =
    await import("./services/limitless-auth.js");
  const { AuthService } = await import("./auth.js");

  const originalGetVenueCredentials = AuthService.getVenueCredentials;
  AuthService.getVenueCredentials = async () =>
    ({
      id: "cred-legacy",
      userId: "user-1",
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
      venue: "limitless",
      apiKey: "legacy",
      apiSecret: "",
      isActive: true,
      additionalData: {
        authMode: "session",
        profile: {
          id: 460208,
          account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
          client: "eoa",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as Awaited<ReturnType<typeof AuthService.getVenueCredentials>>;

  try {
    const result = await resolveLimitlessAuthContext(
      "user-1",
      "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    );
    assert.equal(result, null);
  } finally {
    AuthService.getVenueCredentials = originalGetVenueCredentials;
  }
});

const delegatedWallet = "0x0000000000000000000000000000000000000017";
const otherDelegatedWallet = "0x0000000000000000000000000000000000000070";

test("callers distinguish unavailable verification from confirmed reconnect", async () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(
      isLimitlessAuthUnavailable({
        ok: false,
        status,
        payload: null,
        message: null,
      }),
      true,
    );
  }
  for (const status of [400, 401, 403]) {
    assert.equal(
      isLimitlessAuthUnavailable({
        ok: false,
        status,
        payload: null,
        message: null,
      }),
      false,
    );
  }
  assert.equal(
    isLimitlessAuthUnavailable({ ok: true, profile: null, payload: null }),
    false,
  );
});

async function withPartnerLookup(
  payload: unknown,
  status: number,
  run: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;
  env.limitlessHmacTokenId = "fixture-token";
  env.limitlessHmacSecret = Buffer.from("fixture-secret").toString("base64");
  globalThis.fetch = (async (input, init) => {
    assert.equal(
      new URL(String(input)).searchParams.get("account"),
      delegatedWallet,
    );
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
}

test("private wallet requests cannot use an absent or another wallet's profile", async () => {
  assert.throws(() =>
    buildLimitlessWalletRequestAuthInputs(
      buildAuthContext(null),
      delegatedWallet,
    ),
  );
  assert.throws(() =>
    buildLimitlessWalletRequestAuthInputs(
      buildAuthContext({ id: 1, account: otherDelegatedWallet }),
      delegatedWallet,
    ),
  );
  assert.deepEqual(
    buildLimitlessWalletRequestAuthInputs(
      buildAuthContext({ id: 17, account: delegatedWallet }),
      delegatedWallet,
    ),
    { auth: "partner_hmac", headers: { "x-on-behalf-of": "17" } },
  );
});

test("an expired stored delegation requires reconnect after a complete empty lookup", async () => {
  // Historical incident shape: valid local profile; provider data=[].
  await withPartnerLookup({ data: [] }, 200, async () => {
    const context = buildAuthContext({ id: 70, account: delegatedWallet });
    const result = await verifyLimitlessAuthContext({
      authContext: context,
      walletAddress: delegatedWallet,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.deepEqual(result.payload, { code: "limitless_reconnect_required" });
    assert.equal(context.creds.isActive, true);
  });
});

test("lookup binds a changed authorized profile ID without mixing another account", async () => {
  await withPartnerLookup(
    {
      data: [
        { id: 70, account: otherDelegatedWallet },
        { id: 171, account: delegatedWallet, rank: { feeRateBps: 125 } },
      ],
    },
    200,
    async () => {
      const context = buildAuthContext({ id: 17, account: delegatedWallet });
      const result = await verifyLimitlessAuthContext({
        authContext: context,
        walletAddress: delegatedWallet,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.profile?.id, 171);
      assert.equal(context.storedProfile?.id, 171);
      const merged = await loadLimitlessProfileForWallet({
        walletAddress: delegatedWallet,
        baseProfile: result.profile,
        additionalData: {
          profile: {
            id: 17,
            account: delegatedWallet,
            rank: { feeRateBps: 999 },
          },
        },
      });
      assert.equal(merged?.rank?.feeRateBps, 125);
    },
  );
});

test("temporary and malformed responses do not claim delegation was revoked", async () => {
  for (const [payload, status] of [
    [{ error: "temporarily unavailable" }, 503],
    [{}, 200],
    [null, 200],
    [{ error: "Unauthorized partner" }, 403],
  ] as const) {
    await withPartnerLookup(payload, status, async () => {
      const context = buildAuthContext({ id: 17, account: delegatedWallet });
      const result = await verifyLimitlessAuthContext({
        authContext: context,
        walletAddress: delegatedWallet,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, 503);
      assert.equal(context.storedProfile?.id, 17);
      assert.equal(context.creds.isActive, true);
    });
  }
});

test("timeout leaves the stored delegation intact and retryable", async () => {
  await withPartnerLookup({}, 200, async () => {
    globalThis.fetch = async () => {
      throw new DOMException("fixture timeout", "TimeoutError");
    };
    const context = buildAuthContext({ id: 17, account: delegatedWallet });
    const result = await verifyLimitlessAuthContext({
      authContext: context,
      walletAddress: delegatedWallet,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 503);
    assert.equal(context.storedProfile?.id, 17);
  });
});

test("embedded preparation never requests a reconnect signature for an unavailable lookup", async () => {
  type Handler = (request: unknown, reply: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const app = {
    withTypeProvider() {
      return this;
    },
    get() {},
    delete() {},
    post(path: string, _options: unknown, handler: Handler) {
      handlers.set(path, handler);
    },
    log: { error() {}, warn() {}, info() {} },
  };
  await limitlessPrivateRoutes(app as never, {});
  const handler = handlers.get("/embedded/ensure-ready/prepare");
  assert.ok(handler);

  const originalFetch = globalThis.fetch;
  const originalCredentials = AuthService.getVenueCredentials;
  const originalPrivyUser = PrivyService.getUserById;
  const originalClassification = PrivyService.classifyWallets;
  const originalToken = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;
  try {
    env.limitlessHmacTokenId = "fixture-token";
    env.limitlessHmacSecret = Buffer.from("fixture-secret").toString("base64");
    AuthService.getVenueCredentials = async () =>
      buildAuthContext({ id: 17, account: delegatedWallet }).creds;
    PrivyService.getUserById = async () => ({}) as never;
    PrivyService.classifyWallets = () =>
      [
        {
          walletType: "ethereum",
          address: delegatedWallet,
          isInternalWallet: true,
          walletId: "fixture-wallet",
        },
      ] as never;

    const cases = [
      { payload: { message: "Temporary lookup outage" }, status: 503 },
      { payload: { message: "Partner outage" }, status: 403 },
      { payload: {}, status: 200 },
      { payload: null, status: 200 },
      { payload: null, status: 200, timeout: true },
      { payload: { data: [] }, status: 200, reconnect: true },
      {
        payload: { data: [{ id: 17, account: delegatedWallet }] },
        status: 200,
        connected: true,
      },
    ];
    for (const fixture of cases) {
      const paths: string[] = [];
      globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/profiles/partner-accounts") {
          if (fixture.timeout)
            throw new DOMException("fixture timeout", "TimeoutError");
          return Response.json(fixture.payload, { status: fixture.status });
        }
        assert.equal(path, "/auth/signing-message");
        return Response.json({ message: "Fixture connect authorization" });
      };
      let status = 200;
      let payload: Record<string, unknown> = {};
      const reply = {
        code(value: number) {
          status = value;
          return this;
        },
        header() {
          return this;
        },
        send(value: Record<string, unknown>) {
          payload = value;
          return this;
        },
      };
      await handler(
        {
          user: { id: "fixture-user", privyUserId: "fixture-privy" },
          walletAddress: delegatedWallet,
          body: {},
        },
        reply,
      );
      if (fixture.reconnect) {
        assert.equal(status, 200);
        assert.equal(payload.connected, false);
        assert.deepEqual(paths, [
          "/profiles/partner-accounts",
          "/auth/signing-message",
        ]);
        const requests = payload.requests as Array<{
          id: string;
          input: { body: { method: string } };
        }>;
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.id, "limitless-connect");
        assert.equal(requests[0]?.input.body.method, "personal_sign");
      } else if (fixture.connected) {
        assert.equal(status, 200);
        assert.equal(payload.connected, true);
        assert.deepEqual(payload.requests, []);
        assert.deepEqual(paths, ["/profiles/partner-accounts"]);
      } else {
        assert.equal(status, 503);
        assert.equal(payload.code, "limitless_auth_status_unavailable");
        assert.equal(payload.requests, undefined);
        assert.equal(payload.connected, undefined);
        assert.deepEqual(paths, ["/profiles/partner-accounts"]);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    AuthService.getVenueCredentials = originalCredentials;
    PrivyService.getUserById = originalPrivyUser;
    PrivyService.classifyWallets = originalClassification;
    env.limitlessHmacTokenId = originalToken;
    env.limitlessHmacSecret = originalSecret;
  }
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
