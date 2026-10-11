import assert from "node:assert/strict";
import { buildLimitlessClobSubmissionContext } from "./services/limitless-clob-evidence-identity.js";
import {
  readLimitlessCopySubmission,
  retainLimitlessCopySubmission,
} from "./services/limitless-copy-submission.js";
import { LIMITLESS_CLOB_ORDER_TYPES } from "./services/limitless-order-contract.js";

const walletAddress = `0x${"1".repeat(40)}`;
const defaultExchange = `0x${"2".repeat(40)}`;
const alternateExchange = `0x${"3".repeat(40)}`;
const otherOwner = `0x${"4".repeat(40)}`;
const tokenId = "limitless:123";
const typedOrder = {
  salt: "71",
  maker: walletAddress,
  signer: walletAddress,
  taker: `0x${"0".repeat(40)}`,
  tokenId: "123",
  makerAmount: "10000000",
  takerAmount: "20000000",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
};
const signedOrder = {
  ...typedOrder,
  signature: "0xfixture-signature-must-not-be-retained",
  clientOrderId: "fixture-client-order",
  requestAuth: { secret: "fixture-auth-must-not-be-retained" },
  exchangeAddress: otherOwner,
  domain: { verifyingContract: otherOwner },
  _hunchLimitlessClob: { spoofed: true },
};
const alternateContext = buildLimitlessClobSubmissionContext(
  alternateExchange,
  typedOrder,
);
const retainedOrder = Object.fromEntries(
  Object.entries(typedOrder).map(([field, value]) => [field, String(value)]),
);
let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`ok - ${name}`);
}

test("retains exact typed fields and server context for default and alternate exchange", () => {
  for (const exchange of [defaultExchange, alternateExchange]) {
    const context = buildLimitlessClobSubmissionContext(exchange, typedOrder);
    const retained = retainLimitlessCopySubmission({
      order: signedOrder,
      context,
      walletAddress,
      tokenId,
    });
    assert.ok(retained);
    assert.deepEqual(retained, { context, order: retainedOrder });
    assert.deepEqual(
      Object.keys(retained.order).sort(),
      LIMITLESS_CLOB_ORDER_TYPES.Order.map((field) => field.name).sort(),
    );
    assert.deepEqual(
      readLimitlessCopySubmission(JSON.parse(JSON.stringify(retained)), {
        walletAddress,
        tokenId,
      }),
      retained,
      "JSON persistence round-trip preserves exact recovery identity",
    );
    assert.equal(JSON.stringify(retained).includes("fixture-signature"), false);
    assert.equal(JSON.stringify(retained).includes("fixture-auth"), false);
    assert.equal("_hunchLimitlessClob" in retained.order, false);
  }
});

test("retention does not mutate or keep references to the input signed payload", () => {
  const localOrder = { ...signedOrder };
  const localContext = { ...alternateContext };
  const retained = retainLimitlessCopySubmission({
    order: localOrder,
    context: localContext,
    walletAddress,
    tokenId,
  });
  assert.ok(retained);
  assert.equal(localOrder.signature, signedOrder.signature);
  localOrder.salt = "72";
  localContext.orderHash = `0x${"f".repeat(64)}`;
  assert.deepEqual(retained, {
    context: alternateContext,
    order: retainedOrder,
  });
});

test("provided invalid context cannot fall back to client exchange or domain extras", () => {
  for (const context of [
    null,
    {},
    { ...alternateContext, contextVersion: 2 },
    { ...alternateContext, chainId: 137 },
    { ...alternateContext, exchangeAddress: "invalid" },
    { ...alternateContext, orderHash: `0x${"f".repeat(64)}` },
    { ...alternateContext, exchangeAddress: defaultExchange },
  ]) {
    assert.equal(
      retainLimitlessCopySubmission({
        order: signedOrder,
        context,
        walletAddress,
        tokenId,
      }),
      null,
    );
  }
});

test("exact account, outcome token, and BUY identity are mandatory", () => {
  for (const order of [
    { ...typedOrder, maker: otherOwner },
    { ...typedOrder, signer: otherOwner },
    { ...typedOrder, tokenId: "124" },
    { ...typedOrder, side: 1 },
  ]) {
    const context = buildLimitlessClobSubmissionContext(
      alternateExchange,
      order,
    );
    assert.equal(
      retainLimitlessCopySubmission({
        order,
        context,
        walletAddress,
        tokenId,
      }),
      null,
    );
  }
});

test("incomplete or modified signed fields cannot be retained as exact evidence", () => {
  for (const field of LIMITLESS_CLOB_ORDER_TYPES.Order) {
    const incomplete: Record<string, unknown> = { ...typedOrder };
    delete incomplete[field.name];
    assert.equal(
      retainLimitlessCopySubmission({
        order: incomplete,
        context: alternateContext,
        walletAddress,
        tokenId,
      }),
      null,
      `missing ${field.name}`,
    );
  }
  assert.equal(
    retainLimitlessCopySubmission({
      order: { ...typedOrder, salt: "72" },
      context: alternateContext,
      walletAddress,
      tokenId,
    }),
    null,
  );
});

test("malformed persisted evidence remains pending-capable and exact evidence repairs it", () => {
  const valid = { context: alternateContext, order: retainedOrder };
  for (const value of [
    null,
    {},
    { context: alternateContext },
    { order: typedOrder },
    { ...valid, order: { ...typedOrder, salt: "72" } },
    { ...valid, context: { ...alternateContext, chainId: 137 } },
  ])
    assert.equal(
      readLimitlessCopySubmission(value, { walletAddress, tokenId }),
      null,
    );
  assert.deepEqual(
    readLimitlessCopySubmission(valid, { walletAddress, tokenId }),
    valid,
  );
});

console.log(`Limitless Copy retention: ${passed} focused unit fixtures passed`);
