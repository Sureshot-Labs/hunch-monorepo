import assert from "node:assert/strict";
import { test } from "node:test";
import { relayDestinationReferenceIdentity } from "./destination-reference.js";
import { createRelayReferenceCodec } from "./reference-codec.js";

test("successful destination identity survives HMAC rotation and hex case", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const oldCodec = createRelayReferenceCodec({
    encryptionKey: Buffer.alloc(32, 1),
    lookupHmacKey: "old-key".repeat(10),
    keyVersion: 1,
  });
  const newCodec = createRelayReferenceCodec({
    encryptionKey: Buffer.alloc(32, 1),
    lookupHmacKey: "new-key".repeat(10),
    keyVersion: 2,
  });
  assert.notEqual(oldCodec.fingerprint(hash), newCodec.fingerprint(hash));
  assert.equal(
    relayDestinationReferenceIdentity(hash),
    relayDestinationReferenceIdentity(`0x${"AB".repeat(32)}`),
  );
  assert.match(relayDestinationReferenceIdentity(hash), /^[a-f0-9]{64}$/u);
  assert.notEqual(
    relayDestinationReferenceIdentity(hash),
    oldCodec.fingerprint(hash),
  );
});

test("destination reference identity preserves case-sensitive non-EVM identities", () => {
  assert.notEqual(
    relayDestinationReferenceIdentity("Abc123Tx"),
    relayDestinationReferenceIdentity("abc123Tx"),
  );
  assert.throws(() => relayDestinationReferenceIdentity(" "));
  assert.throws(() => relayDestinationReferenceIdentity("a".repeat(257)));
});
