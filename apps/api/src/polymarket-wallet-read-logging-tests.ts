// @isolated-process
import assert from "node:assert/strict";
import Fastify from "fastify";
import { validatorCompiler } from "fastify-type-provider-zod";
import { stableOpaqueId } from "./account-value/canonical.js";
import { AuthService } from "./auth.js";
import { polymarketPrivateRoutes } from "./routes/polymarket-private.js";

const userId = "test-private-account-id";
const signer = "0x" + "1".repeat(40);
const otherWallet = "0x" + "2".repeat(40);
const rpcSecret = "https://rpc.private.example/private-rpc-secret";
const token = AuthService.generateToken(userId);
const accountKey = stableOpaqueId("trade", userId);
const original = {
  validateSession: AuthService.validateSession,
  getUserById: AuthService.getUserById,
  getUserWalletByAddress: AuthService.getUserWalletByAddress,
  getVenueCredentialsInfo: AuthService.getVenueCredentialsInfo,
};
let sessionWallet = signer;
let failCredentials = true;
AuthService.validateSession = async () =>
  ({ walletAddress: sessionWallet }) as never;
AuthService.getUserById = async () => ({ id: userId, isActive: true }) as never;
AuthService.getUserWalletByAddress = async () => null;
AuthService.getVenueCredentialsInfo = async () => {
  if (failCredentials) throw new Error(rpcSecret);
  return null;
};

const lines: string[] = [];
const app = Fastify({
  logger: { stream: { write: (line) => lines.push(line) } },
});
app.setValidatorCompiler(validatorCompiler);
app.addHook("onRequest", async (request, reply) => {
  if (request.headers["x-test-rate-limit"] === "yes")
    await reply.code(429).send({ error: "Rate limit exceeded" });
});
// Mirror the production API's fixed-message error logging; Fastify's
// standalone default logs the thrown message separately from its serializer.
app.setErrorHandler((err, req, reply) => {
  if (
    err &&
    typeof err === "object" &&
    "statusCode" in err &&
    err.statusCode === 400
  )
    return reply.code(400).send({ error: "Invalid request" });
  req.log.error({ err }, "Unhandled error");
  return reply.code(500).send({ error: "Internal server error" });
});
await app.register(polymarketPrivateRoutes, { prefix: "/trade/polymarket" });
const eventFor = (id: string) => {
  const completed = lines
    .map((line) => JSON.parse(line))
    .filter(
      (row) =>
        row.reqId === id && row.msg === "Polymarket wallet read completed",
    );
  assert.equal(completed.length, 1);
  assert.ok(completed[0].durationMs >= 0);
  return completed[0];
};
const auth = { authorization: `Bearer ${token}` };
try {
  const accountUrl = `/trade/polymarket/account?funderAddress=${otherWallet}`;
  const invalidQuery = "invalid-private-funder-input";
  const invalid = await app.inject({
    url: `/trade/polymarket/account?funderAddress=${invalidQuery}`,
    headers: auth,
  });
  assert.equal(invalid.statusCode, 400);
  const invalidEvent = eventFor(
    invalid.headers["x-hunch-request-id"] as string,
  );
  assert.equal(invalidEvent.code, "wallet_read_invalid_request");
  assert.equal(invalidEvent.accountKey, undefined);
  const limited = await app.inject({
    url: accountUrl,
    headers: { ...auth, "x-test-rate-limit": "yes" },
  });
  assert.equal(limited.statusCode, 429);
  const limitedEvent = eventFor(
    limited.headers["x-hunch-request-id"] as string,
  );
  assert.equal(limitedEvent.code, "wallet_read_rate_limited");
  assert.equal(limitedEvent.accountKey, undefined);

  const blocked = await app.inject({
    url: accountUrl,
    headers: { ...auth, "x-hunch-wallet": otherWallet },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(
    blocked.json().error,
    "Wallet is not linked to the authenticated user",
  );
  const blockedEvent = eventFor(
    blocked.headers["x-hunch-request-id"] as string,
  );
  assert.equal(blockedEvent.accountKey, accountKey);
  assert.equal(blockedEvent.stage, "polymarket_account");
  assert.equal(blockedEvent.status, 403);
  assert.equal(blockedEvent.code, "wallet_not_linked");

  const unowned = await app.inject({
    url: `/trade/polymarket/funder-derive?walletAddress=${otherWallet}`,
    headers: auth,
  });
  assert.equal(unowned.statusCode, 403);
  assert.equal(
    unowned.json().error,
    "walletAddress does not belong to the current user",
  );
  const funderEvent = eventFor(unowned.headers["x-hunch-request-id"] as string);
  assert.equal(funderEvent.accountKey, accountKey);
  assert.equal(funderEvent.stage, "polymarket_funder_derive");
  assert.equal(funderEvent.code, "wallet_not_linked");

  const unauthorized = await app.inject({ url: accountUrl });
  assert.equal(unauthorized.statusCode, 401);
  const anonEvent = eventFor(
    unauthorized.headers["x-hunch-request-id"] as string,
  );
  assert.equal(anonEvent.code, "wallet_read_unauthorized");
  assert.equal(anonEvent.accountKey, undefined);

  const head = await app.inject({ method: "HEAD", url: accountUrl });
  assert.equal(head.statusCode, 401);
  assert.ok(
    lines
      .map((line) => JSON.parse(line))
      .some(
        (row) =>
          row.reqId === head.headers["x-hunch-request-id"] &&
          row.req?.method === "HEAD",
      ),
  );

  const error = await app.inject({ url: accountUrl, headers: auth });
  assert.equal(error.statusCode, 500);
  const errorEvent = eventFor(error.headers["x-hunch-request-id"] as string);
  assert.equal(errorEvent.accountKey, accountKey);
  assert.equal(errorEvent.code, "wallet_read_interrupted");

  // Invalid legacy session signer is returned as an unchanged 200 warning by
  // the existing derivation service before any Polygon RPC call.
  sessionWallet = "0xinvalid-session-signer";
  failCredentials = false;
  const unavailable = await app.inject({
    url: "/trade/polymarket/account",
    headers: auth,
  });
  assert.equal(unavailable.statusCode, 502);
  assert.equal(
    unavailable.json().error,
    "Failed to fetch Polymarket account snapshot",
  );
  const unavailableEvent = eventFor(
    unavailable.headers["x-hunch-request-id"] as string,
  );
  assert.equal(unavailableEvent.accountKey, accountKey);
  assert.equal(unavailableEvent.code, "account_snapshot_unavailable");
  const success = await app.inject({
    url: "/trade/polymarket/funder-derive",
    headers: auth,
  });
  assert.equal(success.statusCode, 200);
  assert.equal(success.json().ok, true);
  assert.equal(success.json().recommended, null);
  const successEvent = eventFor(
    success.headers["x-hunch-request-id"] as string,
  );
  assert.equal(successEvent.accountKey, accountKey);
  assert.equal(successEvent.code, "wallet_read_ok");
  assert.equal(successEvent.hasRecommendedFunder, false);
  assert.equal(successEvent.candidateCount, 0);
  assert.equal(successEvent.warningCount, 1);

  for (const secret of [
    signer,
    otherWallet,
    rpcSecret,
    token,
    userId,
    sessionWallet,
    invalidQuery,
  ])
    assert.ok(
      !lines.join("").includes(secret),
      "sensitive field must not reach logs",
    );
} finally {
  Object.assign(AuthService, original);
  await app.close();
}
console.log(
  "Polymarket wallet-read logging: request-ID, owner rejection, sanitized errors and success",
);
