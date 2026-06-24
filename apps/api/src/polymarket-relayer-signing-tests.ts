import assert from "node:assert/strict";
import {
  createPolymarketRelayerHeaderPayload,
  normalizePolymarketRelayerBody,
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

console.log("[polymarket-relayer-signing-tests] passed");
