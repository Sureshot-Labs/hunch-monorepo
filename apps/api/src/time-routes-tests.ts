import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

await test("GET /time returns server time without database dependency", async () => {
  const app = Fastify();
  await app.register(healthRoutes);

  try {
    const beforeMs = Date.now();
    const response = await app.inject({ method: "GET", url: "/time" });
    const afterMs = Date.now();

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const payload = response.json<{
      ok: unknown;
      nowMs: unknown;
      nowSec: unknown;
      iso: unknown;
    }>();

    assert.equal(payload.ok, true);
    const nowMs = payload.nowMs;
    const nowSec = payload.nowSec;
    const iso = payload.iso;
    assert.ok(typeof nowMs === "number");
    assert.ok(typeof nowSec === "number");
    assert.ok(typeof iso === "string");
    assert.ok(nowMs >= beforeMs);
    assert.ok(nowMs <= afterMs + 1000);
    assert.equal(nowSec, Math.floor(nowMs / 1000));
    assert.equal(new Date(iso).getTime(), nowMs);
  } finally {
    await app.close();
  }
});
