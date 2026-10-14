import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, Signature } from "ethers";
import { hypercorePlanTestFixture } from "./hypercore-plan-test-fixture.js";
import { validateRelayHypercoreQuote } from "./hypercore-quote.js";
import { RelayClient, RelayClientError } from "./client.js";
import {
  nativeFundingSignedRequest,
  nativeFundingActionReference,
} from "../../funding/execution/hypercore-signed-request.js";
import {
  nativeAuthRetryable,
  parseNativeFundingSubmission,
} from "../../funding/execution/hypercore-submission-contract.js";

const wallet = new Wallet(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
); // Unfunded public SDK test key, offline only.
const fixture = hypercorePlanTestFixture();
const pair = validateRelayHypercoreQuote(fixture.quoteInput.validation).actions;
const typed = pair.authorization.typedData;
const signature = await wallet.signTypedData(
  typed.domain,
  typed.types,
  typed.message,
);
const authorization = nativeFundingSignedRequest(
  pair,
  "nonce_mapping",
  signature,
);
assert.equal(authorization.stage, "nonce_mapping");

test("native signature request preserves separate Relay body/query and compact signature identity", () => {
  assert.deepEqual(authorization.body, pair.authorization.post.body);
  assert.equal("signature" in authorization.body, false);
  assert.equal(
    nativeFundingSignedRequest(
      pair,
      "nonce_mapping",
      Signature.from(signature).compactSerialized,
    ).requestFingerprint,
    authorization.requestFingerprint,
  );
  assert.throws(() =>
    nativeFundingSignedRequest(pair, "send_asset", signature),
  );
});
test("native SendAsset keeps typed action/nonce, not a fabricated transaction hash", async () => {
  const typed = pair.transfer.typedData;
  const signed = nativeFundingSignedRequest(
    pair,
    "send_asset",
    await wallet.signTypedData(typed.domain, typed.types, typed.message),
  );
  assert.equal(signed.stage, "send_asset");
  assert.deepEqual(signed.body.action, pair.transfer.action);
  assert.equal(signed.body.nonce, pair.binding.nonce);
  assert.match(
    nativeFundingActionReference(pair),
    /^hyperliquid-action:v1:mainnet:/,
  );
});
test("only bound, closed, unknown nonce mapping authorizations may retry", () => {
  const submission = {
    version: 1,
    stage: "nonce_mapping",
    phase: "closed",
    reason: "authorization_unknown",
    expiresAt: fixture.input.quote.candidate.expiresAt,
    pairFingerprint: pair.fingerprint,
    signer: wallet.address.toLowerCase(),
    nonce: pair.binding.nonce,
    admittedAt: fixture.input.now.toISOString(),
    requestFingerprint: authorization.requestFingerprint,
  };
  assert.equal(nativeAuthRetryable(true, submission), true);
  for (const patch of [
    { stage: "send_asset" },
    { phase: "admitted" },
    { reason: "cancelled" },
    { requestFingerprint: undefined },
    { version: 2 },
  ])
    assert.equal(nativeAuthRetryable(true, { ...submission, ...patch }), false);
  assert.equal(nativeAuthRetryable(false, submission), false);
  assert.equal(
    parseNativeFundingSubmission({ ...submission, clientPrivilege: true }),
    null,
  );
});
for (const status of [200, 204])
  test(`Relay authorization accepts documented HTTP ${status} ACK without requiring invented JSON fields`, async () => {
    let calls = 0;
    const client = new RelayClient({
      apiKey: "fixture-key",
      fetchImpl: async (input, init) => {
        calls++;
        const url = new URL(input);
        assert.equal(url.origin, "https://api.relay.link");
        assert.equal(url.pathname, "/authorize");
        assert.equal(url.searchParams.get("signature"), signature);
        assert.equal(init?.redirect, "error");
        assert.equal(init?.method, "POST");
        assert.deepEqual(
          JSON.parse(String(init?.body)),
          pair.authorization.post.body,
        );
        return new Response(status === 204 ? null : "{}", { status });
      },
    });
    await client.authorizeHypercore(
      authorization.body,
      authorization.signature,
    );
    assert.equal(calls, 1);
  });
test("Relay auth failure is redacted and never retries automatically", async () => {
  let calls = 0;
  const client = new RelayClient({
    apiKey: "fixture-key",
    fetchImpl: async (input) => {
      calls++;
      throw new Error(String(input));
    },
  });
  await assert.rejects(
    client.authorizeHypercore(authorization.body, authorization.signature),
    (error) =>
      error instanceof RelayClientError &&
      !error.message.includes(signature) &&
      error.code === "network_error",
  );
  assert.equal(calls, 1);
});
test("Relay auth rejects redirects and HTTP errors without replay", async () => {
  for (const status of [307, 400, 429, 500]) {
    let calls = 0;
    const client = new RelayClient({
      apiKey: "fixture-key",
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status });
      },
    });
    await assert.rejects(
      client.authorizeHypercore(authorization.body, authorization.signature),
      RelayClientError,
    );
    assert.equal(calls, 1);
  }
});
