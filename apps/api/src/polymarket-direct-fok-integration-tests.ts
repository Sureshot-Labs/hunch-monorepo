// @requires-db
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  observeDirectFok,
  readDirectFok,
  directFokView,
  advanceDirectFok,
  claimDirectFok,
} from "./services/polymarket-direct-fok-attempt.js";
import { normalizeOpenOrder } from "./services/polymarket-clob-l2.js";
import {
  submitPolymarketHttpOrder,
  getPolymarketDirectFokStatus,
  type submitPolymarketClientSignedOrder,
} from "./services/polymarket-trading-execution-service.js";

const db = await createIntegrationTestPool({ max: 4 });
const userId = randomUUID();
const signer = "0x0000000000000000000000000000000000000001";
const exchange = "0xE111180000d2663C0091e4f400237545B87B996B";
try {
  for (const side of ["BUY", "SELL"]) {
    const key = {
      userId,
      signer,
      orderHash: "0x" + randomBytes(32).toString("hex"),
    };
    const request = {
      pool: db,
      signer,
      userId,
      body: { orderType: "FOK", order: { side } },
    };
    let sent = 0;
    const loseResponse: typeof submitPolymarketClientSignedOrder = async (
      hooks,
    ) => {
      await hooks.onIdentified!(key.orderHash, exchange);
      await hooks.beforeSubmit!(key.orderHash);
      sent++;
      throw new Error("simulated loss after dispatch");
    };
    const results = await Promise.all([
      submitPolymarketHttpOrder(request, loseResponse),
      submitPolymarketHttpOrder(request, loseResponse),
    ]);
    assert.equal(sent, 1);
    assert.ok(
      results.every(
        (r) =>
          r.payload.state === "unknown" &&
          r.payload.nextAction === "check_original",
      ),
    );
    assert.equal((await readDirectFok(db, key))?.state, "unknown");
    assert.equal(
      await readDirectFok(db, { ...key, userId: randomUUID() }),
      null,
    );
    assert.equal(await readDirectFok(db, { ...key, signer: exchange }), null);
    const venue = (
      status: string,
      size_matched?: string,
      associate_trades?: unknown,
    ) =>
      normalizeOpenOrder({
        id: key.orderHash,
        maker_address: signer,
        status,
        size_matched,
        associate_trades,
      });
    assert.equal(
      observeDirectFok(null, null, key.orderHash, signer).state,
      "unknown",
    );
    assert.equal(
      observeDirectFok(null, venue("CANCELED", "0"), key.orderHash, exchange)
        .state,
      "unknown",
    );
    assert.equal(
      observeDirectFok(null, venue("CANCELED", "0"), "another-hash", signer)
        .state,
      "unknown",
    );
    assert.equal(
      observeDirectFok(null, venue("CANCELED", "0", []), key.orderHash, signer)
        .state,
      "no_fill",
    );
    for (const missingOrMalformed of [undefined, null, "invalid", [""]]) {
      assert.equal(
        observeDirectFok(
          null,
          venue("CANCELED", "0", missingOrMalformed),
          key.orderHash,
          signer,
        ).state,
        "closed_unknown",
      );
    }
    assert.equal(
      observeDirectFok(null, venue("CANCELED"), key.orderHash, signer).state,
      "closed_unknown",
    );
    assert.equal(
      observeDirectFok(null, venue("CANCELED", "0.75"), key.orderHash, signer)
        .state,
      "closed_unknown",
    );
    assert.equal(
      observeDirectFok(null, venue("DELAYED"), key.orderHash, signer).state,
      "accepted",
    );
    assert.equal(
      directFokView(
        key.orderHash,
        observeDirectFok(null, venue("CANCELED"), key.orderHash, signer),
      ).nextAction,
      "new_review",
    );
    await advanceDirectFok(db, key, {
      state: "accepted",
      orderId: key.orderHash,
    });
    await advanceDirectFok(db, key, {
      state: "filled",
      orderId: key.orderHash,
    });
    assert.equal(
      (await submitPolymarketHttpOrder(request, loseResponse)).payload.state,
      "filled",
    );
    assert.equal(sent, 1);
    key.orderHash = "0x" + randomBytes(32).toString("hex");
    const reject: typeof submitPolymarketClientSignedOrder = async (hooks) => {
      await hooks.onIdentified!(key.orderHash, exchange);
      return {
        ok: false,
        statusCode: 409,
        payload: { error: "balance changed" },
      };
    };
    assert.equal(
      (await submitPolymarketHttpOrder(request, reject)).payload.state,
      "not_submitted",
    );
    assert.equal(
      (await submitPolymarketHttpOrder(request, loseResponse)).payload.state,
      "not_submitted",
    );
    assert.equal(sent, 1);
  }
  const baseKey = {
    userId,
    signer,
    orderHash: "0x" + randomBytes(32).toString("hex"),
    binding: {
      maker: signer,
      tokenId: "42",
      side: "SELL",
      exchangeAddress: exchange,
      makerAmount: "1000000",
    },
  };
  assert.ok(
    await claimDirectFok(db, { ...baseKey, signer: exchange }, "not_submitted"),
  );
  assert.ok(await claimDirectFok(db, baseKey, "unknown"));
  const missing = async () => ({
    ok: false as const,
    status: 404,
    payload: null,
  });
  const withoutVenue = {
    credentials: async () => null,
    venue: missing,
    chain: async () => ({ filled: false, remaining: 500_000n }),
  };
  assert.equal(
    (await getPolymarketDirectFokStatus(db, baseKey, withoutVenue)).state,
    "unknown",
    "a partial execution does not mean the order is terminal",
  );
  const full = {
    ...withoutVenue,
    chain: async () => ({ filled: true, remaining: 0n }),
  };
  assert.equal(
    (await getPolymarketDirectFokStatus(db, baseKey, full)).state,
    "filled",
    "exact full chain evidence survives unavailable credentials",
  );
  assert.equal(
    (await getPolymarketDirectFokStatus(db, baseKey, withoutVenue)).state,
    "filled",
    "terminal state survives loss of RPC",
  );
  const old = { ...baseKey, orderHash: "0x" + randomBytes(32).toString("hex") };
  assert.equal(
    (await getPolymarketDirectFokStatus(db, old, full)).state,
    "unknown",
    "an unbound legacy hash cannot probe chain by itself",
  );
  const venueReader = {
    ...withoutVenue,
    credentials: async () => ({
      id: "test",
      userId,
      walletAddress: signer,
      venue: "polymarket" as const,
      apiKey: "stub",
      apiSecret: "stub",
      apiPassphrase: "stub",
      funderAddress: signer,
      isActive: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
    venue: async () => ({
      ok: true as const,
      payload: null,
      order: normalizeOpenOrder({
        id: old.orderHash,
        maker_address: signer,
        status: "CANCELED",
      }),
    }),
  };
  assert.equal(
    (await getPolymarketDirectFokStatus(db, old, venueReader)).state,
    "closed_unknown",
  );
  assert.equal(
    await claimDirectFok(db, old, "unknown"),
    false,
    "a late original POST cannot send after a proven legacy close",
  );
  for (const getWinsWith of ["filled", "no_fill"] as const) {
    const k = { ...old, orderHash: "0x" + randomBytes(32).toString("hex") };
    const request = {
      pool: db,
      signer,
      userId,
      body: { orderType: "FOK", order: { side: "SELL" } },
    };
    const raced = await submitPolymarketHttpOrder(request, async (hooks) => {
      await hooks.onIdentified!(k.orderHash, exchange);
      await hooks.beforeSubmit!(k.orderHash);
      const filled = getWinsWith === "filled";
      const v = await getPolymarketDirectFokStatus(db, k, {
        ...venueReader,
        chain: full.chain,
        venue: async () => ({
          ok: true as const,
          payload: null,
          order: normalizeOpenOrder({
            id: k.orderHash,
            maker_address: signer,
            status: filled ? "matched" : "canceled",
            size_matched: filled ? "1" : "0",
            associate_trades: [],
          }),
        }),
      });
      assert.equal(v.state, getWinsWith);
      if (filled) {
        await hooks.onDefinitiveRejection!();
        return {
          ok: false,
          statusCode: 409,
          payload: { error: "simulated late rejection" },
        };
      }
      await hooks.onAccepted!(k.orderHash);
      return {
        ok: true,
        payload: {
          ok: true,
          venue: "polymarket",
          orderId: k.orderHash,
          orderHash: k.orderHash,
          status: "matched",
          stored: "new",
          payload: null,
        },
      };
    });
    assert.equal(
      raced.payload.state,
      getWinsWith,
      "POST returns the actual persisted GET winner",
    );
    assert.equal(raced.ok, getWinsWith === "filled");
    assert.equal((await readDirectFok(db, k))?.state, getWinsWith);
  }
  for (const conflicting of [false, true]) {
    const k = { ...old, orderHash: "0x" + randomBytes(32).toString("hex") };
    const result = await submitPolymarketHttpOrder(
      {
        pool: db,
        signer,
        userId,
        body: { orderType: "FOK", order: { side: "BUY" } },
      },
      async (hooks) => {
        await hooks.onIdentified!(k.orderHash, exchange);
        await hooks.beforeSubmit!(k.orderHash);
        return {
          ok: false,
          statusCode: 503,
          payload: {
            code: "polymarket_trading_paused",
            payload: {
              error: "trading is disabled",
              ...(conflicting ? { orderID: k.orderHash } : {}),
            },
          },
        };
      },
    );
    assert.equal(result.payload.state, conflicting ? "unknown" : "no_fill");
  }
  console.log(
    "Direct FOK BUY/SELL: exact replay fence, lost response, pre-dispatch rejection, owner isolation and terminal evidence passed.",
  );
} finally {
  await db.end();
}
