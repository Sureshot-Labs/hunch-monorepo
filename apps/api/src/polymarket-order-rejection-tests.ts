import assert from "node:assert/strict";
import {
  isPolymarketDefinitiveRejection,
  notifyPolymarketDefinitiveRejection,
  type PolymarketSubmissionResponse,
} from "./services/polymarket-order-rejection.js";

const firstRejection: PolymarketSubmissionResponse = {
  ok: false,
  status: 400,
  submissionAttempts: 1,
  payload: { error: "not enough balance / allowance" },
};
const scenarios: Array<{
  name: string;
  response: PolymarketSubmissionResponse;
  definitive: boolean;
}> = [
  {
    name: "first HTTP400 balance rejection",
    response: firstRejection,
    definitive: true,
  },
  {
    name: "HTTP200 explicit failed validation",
    response: {
      ...firstRejection,
      ok: true,
      status: undefined,
      payload: {
        success: false,
        errorMsg: "INVALID_ORDER_MIN_SIZE",
        orderID: "",
        transactionsHashes: [],
      },
    },
    definitive: true,
  },
  {
    name: "first HTTP401 invalid API key",
    response: {
      ...firstRejection,
      status: 401,
      payload: { error: "Unauthorized/Invalid api key" },
    },
    definitive: true,
  },
  {
    name: "first signature validation failure",
    response: { ...firstRejection, payload: { error: "invalid signature" } },
    definitive: true,
  },
  {
    name: "FOK no fill code",
    response: {
      ...firstRejection,
      payload: { error: "FOK_ORDER_NOT_FILLED_ERROR" },
    },
    definitive: true,
  },
  {
    name: "FOK no fill message",
    response: {
      ...firstRejection,
      payload: {
        error:
          "order couldn't be fully filled. FOK orders are fully filled or killed.",
      },
    },
    definitive: true,
  },
  {
    name: "FAK no matching orders",
    response: {
      ...firstRejection,
      payload: { error: "no orders found to match with FAK order" },
    },
    definitive: true,
  },
  {
    name: "minimum BUY amount",
    response: {
      ...firstRejection,
      payload: { error: "invalid amount for a marketable BUY order" },
    },
    definitive: true,
  },
  {
    name: "HTTP408 preserves uncertainty",
    response: { ...firstRejection, status: 408 },
    definitive: false,
  },
  {
    name: "HTTP500 preserves uncertainty",
    response: { ...firstRejection, status: 500 },
    definitive: false,
  },
  {
    name: "HTTP503 trading paused is still transport uncertainty",
    response: {
      ...firstRejection,
      status: 503,
      payload: { error: "trading is paused" },
    },
    definitive: false,
  },
  {
    name: "multiple transport submissions preserve uncertainty",
    response: { ...firstRejection, submissionAttempts: 2 },
    definitive: false,
  },
  {
    name: "missing submission certainty",
    response: { ...firstRejection, submissionAttempts: 0 },
    definitive: false,
  },
  {
    name: "duplicate code preserves existing purchase",
    response: {
      ...firstRejection,
      payload: { error: "INVALID_ORDER_DUPLICATED" },
    },
    definitive: false,
  },
  {
    name: "already exists plus validation conflict",
    response: {
      ...firstRejection,
      payload: { error: "not enough balance; order already exists" },
    },
    definitive: false,
  },
  {
    name: "already submitted nested conflict",
    response: {
      ...firstRejection,
      payload: {
        error: "not enough balance",
        data: { message: "order already submitted" },
      },
    },
    definitive: false,
  },
  {
    name: "already been placed contradicts a validation message",
    response: {
      ...firstRejection,
      payload: { error: "invalid signature; order has already been placed" },
    },
    definitive: false,
  },
  {
    name: "success false containing order identity",
    response: {
      ...firstRejection,
      ok: true,
      payload: {
        success: false,
        errorMsg: "not enough balance",
        orderID: "existing-order",
      },
    },
    definitive: false,
  },
  {
    name: "success false containing transaction identity",
    response: {
      ...firstRejection,
      ok: true,
      payload: {
        success: false,
        errorMsg: "invalid signature",
        transactionsHashes: ["0xreceipt"],
      },
    },
    definitive: false,
  },
  {
    name: "nested order identity",
    response: {
      ...firstRejection,
      payload: {
        error: "invalid signature",
        data: { order: { id: "existing-order" } },
      },
    },
    definitive: false,
  },
  {
    name: "execution quantity contradicts success false",
    response: {
      ...firstRejection,
      ok: true,
      payload: {
        success: false,
        errorMsg: "not enough balance",
        takingAmount: "1.25",
      },
    },
    definitive: false,
  },
  {
    name: "status contradicts rejection",
    response: {
      ...firstRejection,
      payload: { error: "not enough balance", status: "matched" },
    },
    definitive: false,
  },
  {
    name: "delayed response is not failure",
    response: {
      ...firstRejection,
      ok: true,
      payload: { success: false, errorMsg: "ORDER_DELAYED" },
    },
    definitive: false,
  },
  {
    name: "opaque error stays recoverable",
    response: { ...firstRejection, payload: { error: "unexpected error" } },
    definitive: false,
  },
  {
    name: "opaque success false stays recoverable",
    response: { ...firstRejection, ok: true, payload: { success: false } },
    definitive: false,
  },
  {
    name: "successful placement is never rejected",
    response: { ...firstRejection, ok: true, payload: { success: true } },
    definitive: false,
  },
  {
    name: "no HTTP status is not authoritative",
    response: { ...firstRejection, status: undefined },
    definitive: false,
  },
];

for (const scenario of scenarios) {
  assert.equal(
    isPolymarketDefinitiveRejection(scenario.response),
    scenario.definitive,
    scenario.name,
  );
  let callbacks = 0;
  await notifyPolymarketDefinitiveRejection(scenario.response, () => {
    callbacks++;
  });
  assert.equal(
    callbacks,
    scenario.definitive ? 1 : 0,
    `${scenario.name}: persistence callback`,
  );
}
await assert.rejects(
  () =>
    notifyPolymarketDefinitiveRejection(firstRejection, () => {
      throw new Error("persistence unavailable");
    }),
  /persistence unavailable/,
);
console.log(
  `Polymarket rejection: ${scenarios.length} classifications and actual callback outcomes passed`,
);
