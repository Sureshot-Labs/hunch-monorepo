// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createIntegrationTestPool } from "./test-database-target.js";

// Exercise the actual CLI, not a second implementation of its branching.
// Only an explicitly guarded disposable DB and a loopback HTTP fixture are used.
const pool = await createIntegrationTestPool({ max: 2 });
const walletId = randomUUID();
const otherId = randomUUID();
const unknownId = randomUUID();
const address = `0x${walletId.replaceAll("-", "").padStart(40, "0")}`;
const startedAt = new Date();
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  assert.equal(
    new URL(request.url ?? "/", "http://localhost").pathname,
    "/v2/positions",
  );
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [], pagination: { next_cursor: null } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const listener = server.address();
assert.ok(listener && typeof listener !== "string");
const endpoint = `http://127.0.0.1:${listener.port}`;
const cli = async (args: string[]) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...(!process.versions.bun ? ["--import", "tsx"] : []),
        fileURLToPath(new URL("./wallet-intel-refresh.ts", import.meta.url)),
        ...args,
      ],
      {
        env: {
          ...process.env,
          HUNCH_RUNTIME_SECRETS_LOADED: "1",
          REDIS_URL: "",
          POLYMARKET_DATA_API_BASE: `${endpoint}/v2`,
          POLYGON_RPC_URL: endpoint,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("repair CLI test timeout"));
    }, 60000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
try {
  await pool.query(
    "insert into wallets(id,chain,address) values($1,'polygon',$2),($3,'polygon',$4)",
    [
      walletId,
      address,
      otherId,
      `0x${otherId.replaceAll("-", "").padStart(40, "0")}`,
    ],
  );
  await pool.query(
    `insert into wallet_tracking_subjects(wallet_id,venue,source,status,priority,
    last_selected_at,last_refreshed_at,last_refresh_attempted_at)
    values($1,'polymarket','whale','active',1,now()-interval '1 year',now(),now()),
    ($2,'polymarket','whale','active',1000,now(),now(),now())`,
    [walletId, otherId],
  );
  const initial = (
    await pool.query(
      "select wallet_id,last_refreshed_at,last_refresh_attempted_at from wallet_tracking_subjects where wallet_id=any($1::uuid[]) order by wallet_id",
      [[walletId, otherId]],
    )
  ).rows;
  const dry = await cli(["--repair", `--repair-wallet-ids=${walletId}`]);
  assert.equal(dry.code, 0);
  assert.match(dry.output, /eligible: 1/);
  assert.match(dry.output, /execute: false/);
  assert.equal(requests, 0, "default plan never calls providers");
  assert.deepEqual(
    (
      await pool.query(
        "select wallet_id,last_refreshed_at,last_refresh_attempted_at from wallet_tracking_subjects where wallet_id=any($1::uuid[]) order by wallet_id",
        [[walletId, otherId]],
      )
    ).rows,
    initial,
    "dry-run does not write attempt/freshness markers",
  );
  for (const args of [
    ["--repair"],
    ["--repair-wallet-ids"],
    [
      "--repair",
      `--repair-wallet-ids=${walletId}`,
      "--auto-tracked-wallet-limit=1000",
      "--repair-execute",
    ],
  ]) {
    const rejected = await cli(args);
    assert.equal(rejected.code, 1);
    assert.doesNotMatch(
      rejected.output,
      /\[wallets:intel:repair\] done|\[wallets:intel:refresh\] start/,
    );
  }
  const excluded = await cli([
    "--repair",
    `--repair-wallet-ids=${unknownId}`,
    "--repair-execute",
  ]);
  assert.equal(
    excluded.code,
    2,
    "an excluded request must not silently exit success",
  );
  assert.match(excluded.output, /unknown_wallet/);
  assert.equal(requests, 0);
  const executed = await cli([
    "--repair",
    `--repair-wallet-ids=${walletId}`,
    "--repair-execute",
  ]);
  assert.equal(executed.code, 0);
  assert.match(executed.output, /\[wallets:intel:repair\] done/);
  assert.match(executed.output, /coverage: ["']hunch_catalog["']/);
  assert.match(executed.output, /refreshed: 1/);
  assert.equal(
    requests,
    1,
    "only the explicit wallet was read, no normal/global scans",
  );
  const updated = (
    await pool.query(
      "select wallet_id,last_refreshed_at,last_refresh_attempted_at from wallet_tracking_subjects where wallet_id=any($1::uuid[]) order by wallet_id",
      [[walletId, otherId]],
    )
  ).rows;
  assert.deepEqual(
    updated.find((row) => row.wallet_id === otherId),
    initial.find((row) => row.wallet_id === otherId),
    "higher ranked unrelated wallet untouched",
  );
  const repaired = updated.find((row) => row.wallet_id === walletId);
  assert.ok(repaired?.last_refreshed_at instanceof Date);
  assert.ok(repaired.last_refreshed_at >= startedAt);
  assert.equal(
    repaired.last_refreshed_at.getTime(),
    repaired.last_refresh_attempted_at.getTime(),
  );
  console.log(
    "[wallet Intel repair CLI] native dry-run, option rejection, exact cohort, excluded exit2 and Hunch-scoped empty-inventory completion passed",
  );
} finally {
  await pool.query("delete from wallets where id=any($1::uuid[])", [
    [walletId, otherId],
  ]);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
}
