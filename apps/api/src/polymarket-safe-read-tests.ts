import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerPolymarketSafeReadRoute } from "./routes/polymarket-safe-read.js";
import { fetchPolymarketRelayerNonce } from "./services/polymarket-deposit-wallet-relayer.js";
import { deriveSafeProxyAddress } from "./services/polymarket-safe-address.js";
import {
  readPolymarketSafeRelayer,
  SafeRelayerReadError,
} from "./services/polymarket-safe-relayer-read.js";

const owner = "0x7f0f3913f02ddfd037bf590f9bdb069cbed20e88";
const safeAddress = deriveSafeProxyAddress(owner);
assert.ok(safeAddress);
let payload: unknown = { deployed: true };
let status = 200;
let transportFails = false;
const requests: Array<{ url: URL; init?: RequestInit }> = [];
const fetchImpl: typeof fetch = async (url, init) => {
  requests.push({ url: new URL(String(url)), init });
  if (transportFails) throw new Error("private upstream detail");
  return new Response(JSON.stringify(payload), { status });
};
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
registerPolymarketSafeReadRoute(app, {
  authenticate: async (request, reply) => {
    if (!request.headers.authorization)
      return reply.code(401).send({ error: "Unauthorized" });
  },
  getWalletAddresses: async () => [owner, "solana-address"],
  fetchImpl,
});
const request = (kind: string, address = owner, auth = true, extra = "") =>
  app.inject({
    method: "GET",
    url: `/auth/polymarket/relayer-safe-read?kind=${kind}&address=${address}${extra}`,
    headers: auth ? { authorization: "test-session" } : {},
  });
try {
  assert.equal((await request("deployed", owner, false)).statusCode, 401);
  assert.equal(
    (await request("deployed", "0x1111111111111111111111111111111111111111"))
      .statusCode,
    400,
  );
  assert.equal((await request("deployed", "invalid")).statusCode, 400);
  assert.equal((await request("submit")).statusCode, 400);
  assert.equal(
    (await request("nonce", owner, true, "&type=WALLET")).statusCode,
    400,
  );
  assert.equal(
    requests.length,
    0,
    "unauthorized/invalid requests never reach the provider",
  );
  const deployed = await request("deployed");
  assert.equal(deployed.statusCode, 200);
  assert.deepEqual(deployed.json(), {
    kind: "deployed",
    safeAddress,
    deployed: true,
  });
  assert.match(String(deployed.headers["cache-control"]), /no-store/);
  assert.equal(requests[0]?.url.origin, "https://relayer-v2.polymarket.com");
  assert.equal(requests[0]?.url.searchParams.get("address"), safeAddress);
  assert.equal(requests[0]?.url.searchParams.has("type"), false);
  payload = { deployed: false };
  assert.equal((await request("deployed")).json().deployed, false);
  payload = { nonce: "0" };
  assert.deepEqual((await request("nonce")).json(), {
    kind: "nonce",
    safeAddress,
    nonce: "0",
  });
  assert.equal(requests.at(-1)?.url.searchParams.get("type"), "SAFE");
  assert.equal(
    requests.at(-1)?.url.searchParams.get("address")?.toLowerCase(),
    owner,
  );
  for (const invalid of [null, {}, { deployed: "true" }, { deployed: 1 }]) {
    payload = invalid;
    assert.equal((await request("deployed")).statusCode, 502);
  }
  for (const invalid of [
    null,
    {},
    { nonce: 12 },
    { nonce: "-1" },
    { nonce: "1.2" },
  ]) {
    payload = invalid;
    assert.equal((await request("nonce")).statusCode, 502);
  }
  for (const failureStatus of [403, 429, 500]) {
    status = failureStatus;
    payload = { error: "private upstream detail" };
    const failed = await request("deployed");
    assert.equal(failed.statusCode, 502);
    assert.doesNotMatch(failed.body, /private upstream/);
  }
  transportFails = true;
  assert.equal((await request("nonce")).statusCode, 502);
  transportFails = false;
  status = 200;
  payload = { nonce: "12" };
  assert.equal(
    (await request("nonce")).statusCode,
    200,
    "a later explicit retry can recover",
  );
  assert.equal(await fetchPolymarketRelayerNonce(owner, fetchImpl), "12");
  assert.equal(
    requests.at(-1)?.url.searchParams.get("type"),
    "WALLET",
    "Deposit Wallet nonce remains separate",
  );
  assert.ok(
    requests.every(({ init }) => init?.method === "GET" && init?.signal),
  );
} finally {
  await app.close();
}
console.log("[polymarket-safe-read-tests] passed");

await assert.rejects(
  readPolymarketSafeRelayer({
    address: owner,
    kind: "nonce",
    walletAddresses: [owner],
    fetchImpl: async () => new Response("<html>provider challenge</html>"),
  }),
  (error: unknown) =>
    error instanceof SafeRelayerReadError &&
    error.reason === "invalid_response",
);
// Keep Node alive while the unref'ed AbortSignal timer bounds the pending read.
const keepAlive = setInterval(() => {}, 1000);
try {
  await assert.rejects(
    readPolymarketSafeRelayer({
      address: owner,
      kind: "nonce",
      walletAddresses: [owner],
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          assert.ok(init?.signal);
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    }),
    (error: unknown) =>
      error instanceof SafeRelayerReadError && error.reason === "timeout",
  );
} finally {
  clearInterval(keepAlive);
}
console.log("[polymarket-safe-read-tests] timeout and invalid JSON passed");
