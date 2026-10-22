import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repo = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");

test("every backend Compose service gets bounded JSON logs without reading env files", () => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "ops/docker-compose.prod.yml",
      "config",
      "--no-env-resolution",
      "--no-interpolate",
      "--format",
      "json",
    ],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const services = JSON.parse(result.stdout).services;
  assert.equal(Object.keys(services).length, 13);
  for (const [name, service] of Object.entries(services)) {
    assert.deepEqual(
      service.logging,
      { driver: "json-file", options: { "max-size": "20m", "max-file": "3" } },
      name,
    );
  }
});

test("cron rotation covers the audited jobs without overlapping agent or nginx policies", () => {
  const config = read("ops/logrotate/hunch-cron");
  const paths = config.match(/^\/opt\/hunch-data\/logs\/[^\s]+$/gm);
  assert.equal(paths.length, 11);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(
    paths.every(
      (path) => !path.includes("*") && !path.includes("agent-theses"),
    ),
  );
  for (const file of [
    "wallet-intel",
    "whale-profiles",
    "market-maintenance",
    "holder-research",
    "ai-map-search",
  ])
    assert.ok(paths.includes(`/opt/hunch-data/logs/${file}.log`));
  for (const directive of [
    "daily",
    "maxsize 20M",
    "rotate 14",
    "compress",
    "copytruncate",
    "missingok",
    "notifempty",
    "su root root",
  ])
    assert.ok(config.includes(`    ${directive}\n`), directive);
  assert.ok(!/^\s*(size|delaycompress|postrotate|prerotate)\b/m.test(config));
});

test("nginx rotation keeps daily semantics and compresses the first rotated file", () => {
  const config = read("ops/logrotate/hunch-nginx");
  assert.match(config, /\/opt\/hunch-data\/nginx\/\*\.log/);
  assert.match(config, /\n    daily\n/);
  assert.match(config, /\n    maxsize 100M\n/);
  assert.ok(!/^\s*(size|delaycompress)\b/m.test(config));
});
