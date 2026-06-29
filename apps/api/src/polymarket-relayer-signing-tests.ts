import assert from "node:assert/strict";
import {
  createPolymarketRelayerHeaderPayload,
  normalizePolymarketRelayerBody,
  parsePolymarketRelayerSubmitBody,
  validatePolymarketRelayerSignRequestForWallet,
} from "./services/polymarket-relayer-signing.js";

assert.equal(normalizePolymarketRelayerBody(null), "");
assert.equal(normalizePolymarketRelayerBody("raw-body"), "raw-body");
assert.equal(
  normalizePolymarketRelayerBody({ hello: "world", count: 2 }),
  '{"hello":"world","count":2}',
);

const headers = createPolymarketRelayerHeaderPayload({
  key: "builder-key",
  secret: "YnVpbGRlci1zZWNyZXQ=",
  passphrase: "builder-passphrase",
  method: "POST",
  path: "/builder/orders",
  body: { hello: "world", count: 2 },
  timestamp: 1_700_000_000,
});

assert.deepEqual(headers, {
  POLY_BUILDER_API_KEY: "builder-key",
  POLY_BUILDER_PASSPHRASE: "builder-passphrase",
  POLY_BUILDER_SIGNATURE: "rZZeTtJULvXzMDWd2CnDeXbE7Xmwo1KFwyoPseSvKFg=",
  POLY_BUILDER_TIMESTAMP: "1700000000",
});

const walletAddress = "0xac19756e6037341868c586Cb9F50f1c6cB761CFE";
const validSubmitBody = JSON.stringify({
  type: "WALLET-CREATE",
  from: walletAddress,
  to: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
});

assert.equal(
  parsePolymarketRelayerSubmitBody(validSubmitBody).type,
  "WALLET-CREATE",
);
assert.doesNotThrow(() =>
  validatePolymarketRelayerSignRequestForWallet({
    method: "POST",
    path: "/submit",
    body: validSubmitBody,
    walletAddress: walletAddress.toLowerCase(),
  }),
);
assert.throws(
  () =>
    validatePolymarketRelayerSignRequestForWallet({
      method: "POST",
      path: "/submit",
      body: {
        type: "WALLET-CREATE",
        from: "0x0000000000000000000000000000000000000001",
        to: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
      },
      walletAddress,
    }),
  /does not match authenticated wallet/,
);
assert.throws(
  () =>
    validatePolymarketRelayerSignRequestForWallet({
      method: "GET",
      path: "/transactions",
      walletAddress,
    }),
  /only supports POST \/submit/,
);
assert.throws(
  () =>
    validatePolymarketRelayerSignRequestForWallet({
      method: "POST",
      path: "/submit",
      body: { type: "UNKNOWN", from: walletAddress },
      walletAddress,
    }),
  /submit type is not allowed/,
);

console.log("[polymarket-relayer-signing-tests] passed");
