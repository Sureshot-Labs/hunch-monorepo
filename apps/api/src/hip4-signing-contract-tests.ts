// Offline official SDK oracle, now also verifies the production action builder.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decode } from "@msgpack/msgpack";
import {
  concat,
  keccak256,
  Signature,
  toBeHex,
  TypedDataEncoder,
  verifyTypedData,
  Wallet,
  getBytes,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import {
  bindHip4TradeSignature,
  canonicalHip4TradeAction,
  prepareHip4TradeSigning,
} from "./services/hip4-trade-signing.js";

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
  action?: unknown;
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

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reversedKeys(entry)]),
    );
  return value;
}

for (const vector of fixture.vectors.filter((entry) => entry.packedAction)) {
  test(`production HIP action serialization and signature: ${vector.name}`, () => {
    assert.ok(vector.action);
    assert.ok(vector.nonce !== undefined);
    const input = {
      environment: vector.name.includes("mainnet")
        ? ("mainnet" as const)
        : ("testnet" as const),
      action: canonicalHip4TradeAction(vector.action),
      nonce: vector.nonce,
      vaultAddress: vector.vault ?? null,
      expiresAfter: vector.expiresAfter ?? null,
    };
    const actual = prepareHip4TradeSigning(input);
    assert.equal(actual.packedAction, vector.packedAction);
    assert.equal(actual.connectionId, vector.connectionId);
    assert.equal(actual.digest, vector.digest);
    assert.deepEqual(actual.action, vector.action);
    assert.deepEqual(
      prepareHip4TradeSigning({
        ...input,
        action: canonicalHip4TradeAction(reversedKeys(vector.action)),
      }),
      actual,
      "JSONB object ordering does not change the admitted signed action",
    );
    const signature = Signature.from({
      ...vector.signature,
      r: toBeHex(BigInt(vector.signature.r), 32),
      s: toBeHex(BigInt(vector.signature.s), 32),
    }).serialized;
    const payload = bindHip4TradeSignature(input, signature, fixture.signer);
    assert.deepEqual(payload.action, vector.action);
    assert.equal(payload.nonce, vector.nonce);
    assert.equal(payload.expiresAfter ?? null, vector.expiresAfter ?? null);
    for (const changed of [
      { ...input, nonce: input.nonce + 1 },
      {
        ...input,
        environment:
          input.environment === "mainnet"
            ? ("testnet" as const)
            : ("mainnet" as const),
      },
      { ...input, expiresAfter: (input.expiresAfter ?? input.nonce) + 1 },
      {
        ...input,
        vaultAddress: input.vaultAddress
          ? null
          : "0x0000000000000000000000000000000000000001",
      },
    ])
      assert.throws(() =>
        bindHip4TradeSignature(changed, signature, fixture.signer),
      );
    assert.throws(() =>
      bindHip4TradeSignature(
        input,
        signature,
        "0x0000000000000000000000000000000000000001",
      ),
    );
  });
}

test("HIP signing rejects unknown actions and fields rather than signing a different payload", () => {
  const original = fixture.vectors[0]?.action;
  const action = canonicalHip4TradeAction(original);
  assert.equal(action.type, "order");
  if (action.type !== "order") throw new Error("expected order fixture");
  const order = action.orders[0];
  assert.ok(order);
  for (const change of [
    { a: 1 },
    { a: 100115532 },
    { a: Number.MAX_SAFE_INTEGER + 1 },
    { p: "0.42250" },
    { p: "0.000001" },
    { p: "0" },
    { p: "1" },
    { p: 0.4225 },
    { s: "1.5" },
    { s: "0" },
    { r: true },
    { t: { limit: { tif: "Fok" } } },
    { c: "missing" },
    { extra: "not bound" },
  ])
    assert.throws(() =>
      canonicalHip4TradeAction({
        ...action,
        orders: [{ ...order, ...change }],
      }),
    );
  for (const candidate of [
    { ...action, type: "sendAsset" },
    { ...action, builder: { b: fixture.signer, f: 10 } },
    { ...action, grouping: "normalTpsl" },
    { ...action, orders: [] },
  ])
    assert.throws(() => canonicalHip4TradeAction(candidate));
  for (const nonce of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() =>
      prepareHip4TradeSigning({
        environment: "mainnet",
        action,
        nonce,
        vaultAddress: null,
        expiresAfter: null,
      }),
    );
});

test("HIP cancel order IDs retain uint64 MessagePack encoding above uint32", () => {
  for (const orderId of [2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const prepared = prepareHip4TradeSigning({
      environment: "mainnet",
      action: { type: "cancel", cancels: [{ a: 100115530, o: orderId }] },
      nonce: 1700000000000,
      vaultAddress: null,
      expiresAfter: null,
    });
    assert.deepEqual(decode(getBytes(prepared.packedAction)), prepared.action);
    // Official SDK msgpack uses unsigned 64-bit integer, not float64, here.
    assert.ok(
      prepared.packedAction.endsWith(`cf${toBeHex(orderId, 8).slice(2)}`),
    );
  }
});

test("HIP signature binds the actual order and never exposes invalid signature input", () => {
  const vector = fixture.vectors.find(
    (entry) => entry.name === "l1-mainnet-direct",
  );
  assert.ok(vector?.nonce !== undefined);
  const action = canonicalHip4TradeAction(vector.action);
  assert.ok(action.type === "order");
  const order = action.orders[0];
  assert.ok(order);
  const input = {
    environment: "mainnet" as const,
    action,
    nonce: vector.nonce,
    vaultAddress: null,
    expiresAfter: null,
  };
  const signature = Signature.from({
    ...vector.signature,
    r: toBeHex(BigInt(vector.signature.r), 32),
    s: toBeHex(BigInt(vector.signature.s), 32),
  }).serialized;
  for (const change of [
    { p: "0.4" },
    { s: "24" },
    { b: !order.b },
    { a: order.a + 1 },
    { c: `0x${"ab".repeat(16)}` },
    { t: { limit: { tif: "Ioc" as const } } },
  ]) {
    const changed = canonicalHip4TradeAction({
      ...action,
      orders: [{ ...order, ...change }],
    });
    assert.throws(
      () =>
        bindHip4TradeSignature(
          { ...input, action: changed },
          signature,
          fixture.signer,
        ),
      { message: "hip4_trade_signature_invalid" },
    );
  }
  const privateInput = "invalid-sensitive-signature";
  assert.throws(
    () => bindHip4TradeSignature(input, privateInput, fixture.signer),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "hip4_trade_signature_invalid");
      assert.equal(error.cause, undefined);
      assert.equal(String(error.stack).includes(privateInput), false);
      return true;
    },
  );
});
