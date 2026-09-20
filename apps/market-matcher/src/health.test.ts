import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_MAX_AGE_MS, isHealthy, markHealthy } from "./health.js";

test("heartbeat rejects missing, stale and future files and recovers on progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "matcher-health-"));
  const path = join(dir, "heartbeat");
  try {
    assert.equal(await isHealthy(path), false);
    await markHealthy(path);
    assert.equal(await isHealthy(path, Date.now() + 10), true);
    const now = Date.now();
    const stale = new Date(now - HEARTBEAT_MAX_AGE_MS - 1000);
    await utimes(path, stale, stale);
    assert.equal(await isHealthy(path, now), false);
    const future = new Date(now + 10_000);
    await utimes(path, future, future);
    assert.equal(await isHealthy(path, now), false);
    await markHealthy(path);
    assert.equal(await isHealthy(path, Date.now() + 10), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
