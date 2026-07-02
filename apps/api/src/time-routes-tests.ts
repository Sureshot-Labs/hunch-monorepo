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
    const payload = response.json<{
      ok?: boolean;
      nowMs?: number;
      nowSec?: number;
      iso?: string;
    }>();

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.nowMs, "number");
    assert.equal(typeof payload.nowSec, "number");
    assert.equal(typeof payload.iso, "string");
    assert.ok(payload.nowMs! >= beforeMs);
    assert.ok(payload.nowMs! <= afterMs + 1000);
    assert.equal(payload.nowSec, Math.floor(payload.nowMs! / 1000));
    assert.equal(new Date(payload.iso!).getTime(), payload.nowMs);
  } finally {
    await app.close();
  }
});
