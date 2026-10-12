// Offline protocol evidence, NOT a production signer or submission adapter.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  concat,
  keccak256,
  Signature,
  toBeHex,
  TypedDataEncoder,
  verifyTypedData,
  Wallet,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

type Vector = {
  name: string;
  typedData: {
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  digest: string;
  signature: { r: string; s: string; v: number };
  packedAction?: string;
  nonce?: number;
  vault?: string | null;
  expiresAfter?: number | null;
  connectionId?: string;
};
const fixture: {
  sdk: { version: string; commit: string; signingSourceSha256: string };
  signer: string;
  vectors: Vector[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/signing-sdk-0.24.0.json", import.meta.url),
    "utf8",
  ),
);

// Published by the official SDK in tests/signing_test.py. Never funded, never
// read from the user's env, and never submitted to an exchange.
const exampleWallet = new Wallet(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);

test("official SDK provenance and synthetic signing scope are pinned", () => {
  assert.equal(fixture.sdk.version, "0.24.0");
  assert.equal(fixture.sdk.commit, "2fdb18f9517675ea03695a0962bd19eece9c83f0");
  assert.equal(
    fixture.sdk.signingSourceSha256,
    "938ec0a1f9611874b423ca946696e19a71d32d14709f521ea5d526f4398c0b85",
  );
  assert.equal(fixture.signer, exampleWallet.address);
  assert.equal(fixture.vectors.length, 20);
  assert.equal(new Set(fixture.vectors.map((vector) => vector.name)).size, 20);
  for (const environment of ["mainnet", "testnet"]) {
    for (const action of [
      "direct",
      "expiry",
      "vault",
      "vault-expiry",
      "ioc-sell",
      "alo",
      "batch",
      "cancel-oid",
      "cancel-cloid",
    ]) {
      assert.ok(
        fixture.vectors.some(
          (vector) => vector.name === `l1-${environment}-${action}`,
        ),
      );
    }
  }
});

for (const vector of fixture.vectors) {
  test(`official SDK golden: ${vector.name}`, async () => {
    const { domain, message, primaryType } = vector.typedData;
    // ethers derives EIP712Domain itself. Preserve every action field order.
    const types = Object.fromEntries(
      Object.entries(vector.typedData.types).filter(
        ([name]) => name !== "EIP712Domain",
      ),
    );
    assert.equal(TypedDataEncoder.getPrimaryType(types), primaryType);
    assert.equal(TypedDataEncoder.hash(domain, types, message), vector.digest);
    const expected = Signature.from({
      r: toBeHex(BigInt(vector.signature.r), 32),
      s: toBeHex(BigInt(vector.signature.s), 32),
      v: vector.signature.v,
    });
    assert.equal(
      verifyTypedData(domain, types, message, expected),
      fixture.signer,
    );
    assert.equal(
      await exampleWallet.signTypedData(domain, types, message),
      expected.serialized,
    );
    if (vector.packedAction) {
      assert.notEqual(vector.nonce, undefined);
      const tail = [
        toBeHex(vector.nonce ?? 0, 8),
        vector.vault ? concat(["0x01", vector.vault]) : "0x00",
      ];
      if (vector.expiresAfter != null)
        tail.push("0x00", toBeHex(vector.expiresAfter, 8));
      // MessagePack comes from the real SDK, not a second home-grown encoder.
      assert.equal(
        keccak256(concat([vector.packedAction, ...tail])),
        vector.connectionId,
      );
      assert.equal(message.connectionId, vector.connectionId);
      assert.equal(domain.chainId, 1337);
      // Order bytes, signer context, nonce and expiry are all signature-bound.
      for (const changedTail of [
        [toBeHex(Number(vector.nonce) + 1, 8), ...tail.slice(1)],
        [
          tail[0],
          vector.vault
            ? "0x00"
            : concat(["0x01", "0x0000000000000000000000000000000000000001"]),
        ],
      ]) {
        assert.notEqual(
          keccak256(concat([vector.packedAction, ...changedTail])),
          vector.connectionId,
        );
      }
      assert.notEqual(
        TypedDataEncoder.hash(domain, types, {
          ...message,
          source: message.source === "a" ? "b" : "a",
        }),
        vector.digest,
      );
    } else {
      assert.equal(primaryType, "HyperliquidTransaction:SendAsset");
      assert.equal(domain.chainId, 421614); // Signature domain, NOT the Core environment.
      assert.equal(message.amount, "1.00000001");
      for (const change of [
        { amount: "1.000000010" },
        { amount: "1.00000002" },
        { sourceDex: "" },
        { destinationDex: "spot" },
        { nonce: Number(message.nonce) + 1 },
        {
          hyperliquidChain:
            message.hyperliquidChain === "Mainnet" ? "Testnet" : "Mainnet",
        },
      ]) {
        assert.notEqual(
          TypedDataEncoder.hash(domain, types, { ...message, ...change }),
          vector.digest,
        );
      }
    }
  });
}
