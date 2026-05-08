import assert from "node:assert/strict";
import { parseHyperliquidRunMode } from "./run-mode.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("--once keeps top-book sync one-shot and does not start websocket", () => {
  const mode = parseHyperliquidRunMode([
    "node",
    "dist/main.js",
    "--once",
    "--network",
    "mainnet",
  ]);

  assert.equal(mode.once, true);
  assert.equal(mode.dryRun, false);
  assert.equal(mode.network, "mainnet");
  assert.equal(mode.startWs, false);
});

test("--dry-run-top-books is a one-shot no-write diagnostic by default", () => {
  const mode = parseHyperliquidRunMode([
    "node",
    "dist/main.js",
    "--dry-run-top-books",
    "--network",
    "testnet",
  ]);

  assert.equal(mode.once, true);
  assert.equal(mode.dryRun, true);
  assert.equal(mode.topBookDryRun, true);
  assert.equal(mode.network, "testnet");
  assert.equal(mode.startWs, false);
});

test("--watch keeps the service loop active", () => {
  const mode = parseHyperliquidRunMode(["node", "dist/main.js", "--watch"]);

  assert.equal(mode.once, false);
  assert.equal(mode.watch, true);
  assert.equal(mode.startWs, true);
});

test("fixture mode is always dry-run and one-shot", () => {
  const mode = parseHyperliquidRunMode([
    "node",
    "dist/main.js",
    "--fixture-dir",
    "/tmp/hyperliquid-fixtures",
  ]);

  assert.equal(mode.fixtureDir, "/tmp/hyperliquid-fixtures");
  assert.equal(mode.dryRun, true);
  assert.equal(mode.once, true);
  assert.equal(mode.startWs, false);
});
