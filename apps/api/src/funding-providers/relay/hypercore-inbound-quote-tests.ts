import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Interface } from "ethers";
import { resolveRelayHypercoreContracts } from "./hypercore-quote.js";
import {
  validateRelayHypercoreInboundQuote,
  type RelayHypercoreInboundQuoteInput,
} from "./hypercore-inbound-quote.js";
import { relayHexOrderId } from "./order-hash.js";
import { BASE_USDC, POLYGON_PUSD, POLYGON_USDC } from "./rehearsal.js";

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/hip4/relay-native-routes-20261014.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const depositInterface = new Interface([
  "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
]);
function example(index = 0) {
  const route = structuredClone(captured.routes[index]);
  const quote = route.response.body;
  const now = new Date(captured.capturedAt);
  const input: RelayHypercoreInboundQuoteInput = {
    quote,
    contracts: resolveRelayHypercoreContracts(
      { chains: captured.chains },
      route.request.originChainId,
    ),
    contractsObservedAt: now,
    maximumContractAgeMs: 60000,
    owner: route.request.user,
    recipient: route.request.recipient,
    sourceCurrency: route.request.originCurrency,
    amountMode: "exact_input",
    authorizedSourceRaw: "10000000",
    minimumOutputRaw: "850000000",
    expectedOutputTargetRaw: "850000000",
    maximumFeeRaw: "1500000",
    now,
    deadline: new Date(now.getTime() + 120000),
    maximumQuoteTtlMs: 60000,
  };
  return { quote, input };
}
function rehash(quote: ReturnType<typeof example>["quote"]) {
  const orderId = relayHexOrderId(quote.protocol.v2.orderData);
  quote.protocol.v2.orderId = orderId;
  const step = quote.steps.find((s: { id: string }) => s.id === "deposit");
  step.items[0].data.data = depositInterface.encodeFunctionData(
    "depositErc20",
    [
      quote.details.sender,
      quote.details.currencyIn.currency.address,
      quote.details.currencyIn.amount,
      orderId,
    ],
  );
}
for (const [index, name] of ["Base", "Polygon"].entries()) {
  test(`${name} live unsigned wire binds exact source, spot USDC8 output and both refunds`, () => {
    const { quote, input } = example(index);
    assert.equal(
      relayHexOrderId(quote.protocol.v2.orderData),
      quote.protocol.v2.orderId,
    );
    const result = validateRelayHypercoreInboundQuote(input);
    assert.notEqual(result.requestId, result.orderId);
    assert.equal(result.sourceAmountRaw, 10000000n);
    assert.equal(result.expectedOutputRaw, 877899800n);
    assert.equal(result.minimumOutputRaw, 860341800n);
    assert.equal(
      result.fees
        .filter((fee) => fee.kind !== "gas")
        .reduce((sum, fee) => sum + BigInt(fee.amount.raw), 0n),
      1221002n,
    );
    assert.equal(
      result.fees.find((fee) => fee.kind === "gas")?.amount.asset.decimals,
      18,
    );
    assert.equal(result.refundTargets.native.dex, "");
    assert.equal(result.refundTargets.native.owner, input.recipient);
    assert.equal(result.refundTargets.source.owner, input.owner);
    assert.equal(result.expiresAt.getTime(), input.now.getTime() + 60000);
    assert.deepEqual(
      result.actions.map((a) => a.stepId),
      ["approve", "deposit"],
    );
    // Existing approval is a valid recovery path, not another required tx.
    quote.steps.shift();
    assert.equal(validateRelayHypercoreInboundQuote(input).actions.length, 1);
  });
}

test("source owner and owned native recipient are distinct exact identities", () => {
  const { quote, input } = example();
  const otherOwner = `0x${"b".repeat(40)}`;
  quote.details.recipient = otherOwner;
  quote.protocol.v2.orderData.output.payments[0].recipient = otherOwner;
  quote.protocol.v2.orderData.inputs[0].refunds[1].recipient = otherOwner;
  rehash(quote);
  assert.throws(() => validateRelayHypercoreInboundQuote(input), /owner/);
  const result = validateRelayHypercoreInboundQuote({
    ...input,
    recipient: otherOwner,
  });
  assert.equal(result.refundTargets.native.owner, otherOwner);
  assert.equal(result.refundTargets.source.owner, input.owner);
});

test("source currency is pinned independently of the quote, including same-chain stablecoins", () => {
  for (const [index, sourceCurrency] of [
    [0, POLYGON_PUSD],
    [0, POLYGON_USDC],
    [1, BASE_USDC],
    [1, `0x${"f".repeat(40)}`],
  ] as const) {
    const { input } = example(index);
    assert.throws(
      () => validateRelayHypercoreInboundQuote({ ...input, sourceCurrency }),
      /source_currency_unsupported/,
    );
  }
  const { input } = example(1);
  assert.throws(
    () =>
      validateRelayHypercoreInboundQuote({
        ...input,
        sourceCurrency: POLYGON_PUSD,
      }),
    /currency_mismatch/,
  );
});

test("unsigned fee summary cannot hide the committed same-USDC route loss", () => {
  const { quote, input } = example();
  for (const [kind, fee] of Object.entries(quote.fees) as [
    string,
    Record<string, string>,
  ][]) {
    if (kind === "gas") continue;
    fee.amount = "0";
    fee.minimumAmount = "0";
    fee.amountUsd = "0";
  }
  assert.throws(
    () => validateRelayHypercoreInboundQuote({ ...input, maximumFeeRaw: "0" }),
    /effective_fee_cap/,
  );
  assert.throws(
    () => validateRelayHypercoreInboundQuote(input),
    /summary_understates/,
  );
});

test("native token hex case is semantic, not a new asset or order commitment", () => {
  const { quote, input } = example();
  const before = validateRelayHypercoreInboundQuote(input);
  const payment = quote.protocol.v2.orderData.output.payments[0];
  payment.currency = `0x${payment.currency.slice(2).toUpperCase()}`;
  assert.equal(relayHexOrderId(quote.protocol.v2.orderData), before.orderId);
  assert.equal(
    validateRelayHypercoreInboundQuote(input).expectedOutputRaw,
    before.expectedOutputRaw,
  );
});

const mutations: [string, (q: ReturnType<typeof example>["quote"]) => void][] =
  [
    [
      "source amount",
      (q) => {
        q.protocol.v2.orderData.inputs[0].payment.amount = "10000001";
      },
    ],
    [
      "source asset",
      (q) => {
        q.protocol.v2.orderData.inputs[0].payment.currency = `0x${"2".repeat(40)}`;
      },
    ],
    [
      "source chain",
      (q) => {
        q.protocol.v2.orderData.inputs[0].payment.chainId = "polygon";
      },
    ],
    [
      "source depositor",
      (q) => {
        q.steps[1].items[0].data.from = `0x${"2".repeat(40)}`;
      },
    ],
    [
      "payment details",
      (q) => {
        q.protocol.v2.paymentDetails.amount = "9999999";
      },
    ],
    [
      "output owner",
      (q) => {
        q.protocol.v2.orderData.output.payments[0].recipient = `0x${"2".repeat(40)}`;
      },
    ],
    [
      "output spot vs perps",
      (q) => {
        q.protocol.v2.orderData.output.payments[0].currency = `0x${"0".repeat(32)}`;
      },
    ],
    [
      "output decimals",
      (q) => {
        q.details.currencyOut.currency.decimals = 6;
      },
    ],
    [
      "output amount",
      (q) => {
        q.protocol.v2.orderData.output.payments[0].expectedAmount = "999999999";
      },
    ],
    [
      "output minimum",
      (q) => {
        q.protocol.v2.orderData.output.payments[0].minimumAmount = "1";
      },
    ],
    [
      "output chain",
      (q) => {
        q.protocol.v2.orderData.output.chainId = "base";
      },
    ],
    [
      "extra calls",
      (q) => {
        q.protocol.v2.orderData.output.calls = ["0x1234"];
      },
    ],
    [
      "extra data",
      (q) => {
        q.protocol.v2.orderData.output.extraData = "0x1234";
      },
    ],
    [
      "unknown solver",
      (q) => {
        q.protocol.v2.orderData.solver = `0x${"2".repeat(40)}`;
      },
    ],
    [
      "refund source owner",
      (q) => {
        q.protocol.v2.orderData.inputs[0].refunds[0].recipient = `0x${"2".repeat(40)}`;
      },
    ],
    [
      "refund native owner",
      (q) => {
        q.protocol.v2.orderData.inputs[0].refunds[1].recipient = `0x${"2".repeat(40)}`;
      },
    ],
    [
      "refund native class",
      (q) => {
        q.protocol.v2.orderData.inputs[0].refunds[1].currency =
          q.details.currencyOut.currency.address;
      },
    ],
    [
      "refund deadline",
      (q) => {
        q.protocol.v2.orderData.inputs[0].refunds[1].deadline++;
      },
    ],
    [
      "refund duplicate",
      (q) => {
        q.protocol.v2.orderData.inputs[0].refunds[1] =
          q.protocol.v2.orderData.inputs[0].refunds[0];
      },
    ],
    [
      "fee denomination",
      (q) => {
        q.fees.gas.currency.decimals = 8;
      },
    ],
    [
      "fee coverage",
      (q) => {
        delete q.fees.relayer;
      },
    ],
    [
      "fee broken summary",
      (q) => {
        q.fees.relayerGas.amount = "0";
      },
    ],
    [
      "fee excess",
      (q) => {
        q.fees.app.amount = "2000000";
      },
    ],
    [
      "unknown step",
      (q) => {
        q.steps.push(q.steps[0]);
      },
    ],
    [
      "cross request",
      (q) => {
        q.steps[0].requestId = `0x${"1".repeat(64)}`;
      },
    ],
    [
      "nonzero native value",
      (q) => {
        q.steps[1].items[0].data.value = "1";
      },
    ],
    [
      "excessive gas",
      (q) => {
        q.steps[1].items[0].data.gas = "999999999999";
      },
    ],
    [
      "unknown executable field",
      (q) => {
        q.steps[1].items[0].data.authorizationList = [];
      },
    ],
    [
      "bad approval spender",
      (q) => {
        q.steps[0].items[0].data.data = `0x095ea7b3${"0".repeat(24)}${"2".repeat(40)}${"0".repeat(58)}989680`;
      },
    ],
  ];
for (const [name, mutate] of mutations)
  test(`inbound semantic rejection survives coherent order hash: ${name}`, () => {
    const { quote, input } = example();
    mutate(quote);
    rehash(quote);
    assert.throws(() => validateRelayHypercoreInboundQuote(input));
  });

test("deposit protocol ID cannot be replaced by Relay request ID or unknown commitment", () => {
  for (const orderId of [
    example().quote.steps[0].requestId,
    `0x${"a".repeat(64)}`,
  ]) {
    const { quote, input } = example();
    quote.steps[1].items[0].data.data = depositInterface.encodeFunctionData(
      "depositErc20",
      [
        input.owner,
        quote.details.currencyIn.currency.address,
        "10000000",
        orderId,
      ],
    );
    assert.throws(
      () => validateRelayHypercoreInboundQuote(input),
      /deposit_order/,
    );
  }
});
test("stale registry recovers after fresh observation, output mode and caps retain precision", () => {
  const { input } = example();
  assert.throws(
    () =>
      validateRelayHypercoreInboundQuote({
        ...input,
        contractsObservedAt: new Date(input.now.getTime() - 60000),
      }),
    /expired/,
  );
  assert.equal(
    validateRelayHypercoreInboundQuote({
      ...input,
      amountMode: "expected_output",
      authorizedSourceRaw: "11000000",
    }).sourceAmountRaw,
    10000000n,
  );
  assert.throws(
    () =>
      validateRelayHypercoreInboundQuote({
        ...input,
        amountMode: "expected_output",
        expectedOutputTargetRaw: "900000000",
      }),
    /floor/,
  );
  assert.throws(
    () =>
      validateRelayHypercoreInboundQuote({
        ...input,
        authorizedSourceRaw: "9999999",
      }),
    /cap/,
  );
  assert.throws(
    () =>
      validateRelayHypercoreInboundQuote({
        ...input,
        maximumFeeRaw: "1221001",
      }),
    /fee_cap/,
  );
  assert.equal(
    validateRelayHypercoreInboundQuote({ ...input, maximumFeeRaw: "1221002" })
      .sourceAmountRaw,
    10000000n,
  );
  const fresh = {
    ...input,
    contractsObservedAt: input.now,
    deadline: new Date(input.now.getTime() + 1000),
  };
  assert.equal(
    validateRelayHypercoreInboundQuote(fresh).expiresAt.getTime(),
    fresh.deadline.getTime(),
  );
});
