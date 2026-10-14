import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  resolveRelayHypercoreContracts,
  validateRelayHypercoreQuote,
  type RelayHypercoreQuoteInput,
} from "./hypercore-quote.js";
import { normalizeRelayFees } from "./fees.js";
import { relayQuoteResponseSchema } from "./schemas.js";
import { RelayClient } from "./client.js";
import { relayHexOrderId } from "./order-hash.js";
import { POLYGON_PUSD } from "./rehearsal.js";

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/hip4/relay-native-quote-20261014.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function example() {
  const quote = structuredClone(captured.quote);
  const now = new Date(captured.capturedAt);
  const input: RelayHypercoreQuoteInput = {
    quote,
    contracts: resolveRelayHypercoreContracts(
      { chains: captured.chains },
      8453,
    ),
    contractsObservedAt: now,
    maximumContractAgeMs: 60000,
    owner: captured.request.user,
    recipient: captured.request.recipient,
    destinationRefundRecipient: captured.request.user,
    destinationCurrency: captured.request.destinationCurrency,
    sourceDex: "spot",
    amountMode: "exact_input",
    authorizedSourceRaw: "1000000000",
    minimumOutputRaw: "9700000",
    expectedOutputTargetRaw: "9700000",
    maximumFeeRaw: "10000000",
    now,
    deadline: new Date(now.getTime() + 120000),
    maximumQuoteTtlMs: 60000,
  };
  return { quote, input };
}

function rehash(quote: ReturnType<typeof example>["quote"]) {
  const id = relayHexOrderId(quote.protocol.v2.orderData);
  quote.protocol.v2.orderId = id;
  quote.steps[0].items[0].data.sign.value.id = id;
  quote.steps[0].items[0].data.post.body.id = id;
}

test("optional provider solver signature does not become a user action or replace hash validation", () => {
  const routes = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/hip4/relay-native-routes-20261014.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { quote, input } = example();
  quote.protocol.v2.orderSignature =
    routes.routes[0].response.body.protocol.v2.orderSignature;
  assert.match(quote.protocol.v2.orderSignature, /^0x[\da-fA-F]{130}$/u);
  const without = validateRelayHypercoreQuote(example().input);
  const withSignature = validateRelayHypercoreQuote(input);
  assert.deepEqual(
    { ...withSignature, fingerprint: without.fingerprint },
    without,
  );
  quote.protocol.v2.orderData.salt = `0x${"2".repeat(64)}`;
  assert.throws(() => validateRelayHypercoreQuote(input), /order_hash/);
  rehash(quote);
  quote.protocol.v2.orderSignature = "0xshort";
  assert.throws(() => validateRelayHypercoreQuote(input));
});

test("independent live orderId golden binds the exact monetary contract", () => {
  const { quote, input } = example();
  assert.equal(
    relayHexOrderId(quote.protocol.v2.orderData),
    captured.quote.protocol.v2.orderId,
  );
  const forged = `0x${"1".repeat(64)}`;
  quote.protocol.v2.orderId = forged;
  quote.steps[0].items[0].data.sign.value.id = forged;
  quote.steps[0].items[0].data.post.body.id = forged;
  assert.throws(() => validateRelayHypercoreQuote(input), /order_hash/);
});

test("changing protocol salt or output cannot retain a prior valid authorization ID", () => {
  const { quote, input } = example();
  quote.protocol.v2.orderData.salt = `0x${"4".repeat(64)}`;
  assert.throws(() => validateRelayHypercoreQuote(input), /order_hash/);
  rehash(quote);
  assert.doesNotThrow(() => validateRelayHypercoreQuote(input));
  quote.protocol.v2.orderData.output.payments[0].expectedAmount = (
    BigInt(quote.details.currencyOut.amount) + 1n
  ).toString();
  quote.details.currencyOut.amount =
    quote.protocol.v2.orderData.output.payments[0].expectedAmount;
  assert.throws(() => validateRelayHypercoreQuote(input), /order_hash/);
});

test("captured unsigned live spot quote binds native source, perps deposit, EVM output and both signatures", () => {
  const { input } = example();
  const result = validateRelayHypercoreQuote(input);
  assert.equal(result.sourceAmountRaw, 1000000000n);
  assert.equal(
    result.expectedOutputRaw,
    BigInt(captured.quote.details.currencyOut.amount),
  );
  assert.equal(result.actions.binding.sourceDex, "spot");
  assert.equal(result.actions.binding.destinationDex, "");
  assert.equal(result.actions.binding.depository, input.contracts.depository);
  assert.equal(result.refundSourceDex, "");
  assert.equal(result.expiresAt.getTime(), input.now.getTime() + 60000);
  assert.equal(result.fees.length, 1);
  assert.equal(result.fees[0]?.amount.raw, captured.quote.fees.relayer.amount);
  assert.equal(result.fees[0]?.amount.asset.decimals, 8);
});

test("native fee summary is counted once; rounding variance is diagnostic, old EVM/SVM parser stays strict", () => {
  const { quote, input } = example();
  quote.fees.relayerGas.amount = "10";
  quote.fees.relayerGas.minimumAmount = "10";
  quote.fees.relayerService.amount = (
    BigInt(quote.fees.relayer.amount) - 11n
  ).toString();
  quote.fees.relayerService.minimumAmount = quote.fees.relayerService.amount;
  const result = validateRelayHypercoreQuote(input);
  assert.equal(result.feeBreakdownVarianceRaw, "1");
  assert.equal(result.fees[0]?.amount.raw, quote.fees.relayer.amount);
  const legacy = structuredClone(quote);
  for (const fee of Object.values(legacy.fees) as { currency: unknown }[])
    fee.currency = {
      chainId: 8453,
      address: captured.request.destinationCurrency,
      decimals: 6,
    };
  assert.throws(
    () => normalizeRelayFees(relayQuoteResponseSchema.parse(legacy)),
    /breakdown/,
  );
  legacy.fees.relayerService.amount = (
    BigInt(legacy.fees.relayer.amount) - 10n
  ).toString();
  assert.equal(
    normalizeRelayFees(relayQuoteResponseSchema.parse(legacy)).length,
    1,
  );
});

test("native-to-USDC fee cap also binds committed expected output, not only provider summary", () => {
  const { quote, input } = example();
  for (const fee of Object.values(quote.fees) as Record<string, string>[]) {
    fee.amount = "0";
    fee.minimumAmount = "0";
    fee.amountUsd = "0";
  }
  assert.throws(
    () => validateRelayHypercoreQuote({ ...input, maximumFeeRaw: "0" }),
    /effective_fee_cap/,
  );
  assert.throws(
    () => validateRelayHypercoreQuote(input),
    /summary_understates/,
  );
});

test("USDC downscale permits less than one raw6 unit, not an unreported fee", () => {
  for (const remainder of [99n, 100n]) {
    const { quote, input } = example();
    const loss =
      BigInt(quote.details.currencyIn.amount) -
      BigInt(quote.details.currencyOut.amount) * 100n;
    const declared = (loss - remainder).toString();
    quote.fees.relayer.amount = quote.fees.relayer.minimumAmount = declared;
    quote.fees.relayerGas.amount = quote.fees.relayerGas.minimumAmount = "0";
    quote.fees.relayerService.amount = quote.fees.relayerService.minimumAmount =
      declared;
    if (remainder === 99n)
      assert.doesNotThrow(() =>
        validateRelayHypercoreQuote({ ...input, maximumFeeRaw: declared }),
      );
    else
      assert.throws(
        () =>
          validateRelayHypercoreQuote({ ...input, maximumFeeRaw: declared }),
        /effective_fee_cap/,
      );
  }
});

test("pUSD keeps declared fee cap and exact output floor without inventing a USDC parity rate", () => {
  const { quote, input } = example();
  const contracts = resolveRelayHypercoreContracts(
    { chains: captured.chains },
    137,
  );
  const output = quote.protocol.v2.orderData.output;
  output.chainId = "polygon";
  output.extraData = contracts.destinationExtraData;
  output.payments[0].currency = POLYGON_PUSD;
  output.payments[0].expectedAmount = "8500000";
  output.payments[0].minimumAmount = "8400000";
  quote.details.currencyOut.currency.chainId = 137;
  quote.details.currencyOut.currency.address = POLYGON_PUSD;
  quote.details.currencyOut.amount = "8500000";
  quote.details.currencyOut.minimumAmount = "8400000";
  const refund = quote.protocol.v2.orderData.inputs[0].refunds[1];
  refund.chainId = "polygon";
  refund.currency = POLYGON_PUSD;
  refund.extraData = contracts.destinationExtraData;
  rehash(quote);
  const changed = {
    ...input,
    contracts,
    destinationCurrency: POLYGON_PUSD,
    minimumOutputRaw: "8400000",
    expectedOutputTargetRaw: "8500000",
  };
  assert.equal(
    validateRelayHypercoreQuote(changed).expectedOutputRaw,
    8500000n,
  );
  assert.throws(
    () => validateRelayHypercoreQuote({ ...changed, maximumFeeRaw: "0" }),
    /fee_cap/,
  );
  assert.throws(
    () =>
      validateRelayHypercoreQuote({ ...changed, minimumOutputRaw: "8500000" }),
    /floor/,
  );
});

test("expected output mode allows a smaller source within cap, not below the target or floor", () => {
  const { input } = example();
  const expected = {
    ...input,
    amountMode: "expected_output" as const,
    authorizedSourceRaw: "2000000000",
  };
  assert.equal(
    validateRelayHypercoreQuote(expected).sourceAmountRaw,
    1000000000n,
  );
  assert.throws(
    () =>
      validateRelayHypercoreQuote({
        ...expected,
        expectedOutputTargetRaw: "10000000",
      }),
    /floor/,
  );
  assert.throws(
    () =>
      validateRelayHypercoreQuote({
        ...expected,
        authorizedSourceRaw: "999999999",
      }),
    /cap/,
  );
});

test("perps source uses its class selector, never impersonates a spot source", () => {
  const { quote, input } = example();
  quote.details.currencyIn.currency.address = `0x${"0".repeat(32)}`;
  quote.steps[1].items[0].data.action.parameters.sourceDex = "";
  assert.throws(() => validateRelayHypercoreQuote(input), /currency/);
  assert.equal(
    validateRelayHypercoreQuote({ ...input, sourceDex: "" }).actions.binding
      .sourceDex,
    "",
  );
});

test("external withdrawal still requires independently owned refund recipient", () => {
  const { quote, input } = example();
  const recipient = `0x${"7".repeat(40)}`;
  quote.details.recipient = recipient;
  quote.protocol.v2.orderData.output.payments[0].recipient = recipient;
  rehash(quote);
  assert.doesNotThrow(() =>
    validateRelayHypercoreQuote({ ...input, recipient }),
  );
  quote.protocol.v2.orderData.inputs[0].refunds[1].recipient = recipient;
  rehash(quote);
  assert.throws(
    () => validateRelayHypercoreQuote({ ...input, recipient }),
    /refund/,
  );
});

test("contract rotation recovers with a fresh independent registry read, not a stale allowlist", () => {
  const { quote, input } = example();
  const replacement = `0x${"9".repeat(40)}`;
  quote.protocol.v2.paymentDetails.depository = replacement;
  quote.steps[1].items[0].data.action.parameters.destination = replacement;
  assert.throws(() => validateRelayHypercoreQuote(input), /protocol/);
  const chains = structuredClone(captured.chains);
  chains.find((c: { id: number }) => c.id === 1337).protocol.v2.depository =
    replacement;
  const contracts = resolveRelayHypercoreContracts({ chains }, 8453);
  assert.notEqual(contracts.revision, input.contracts.revision);
  assert.equal(
    validateRelayHypercoreQuote({ ...input, contracts }).actions.binding
      .depository,
    replacement,
  );
});

const mutations: [
  string,
  (quote: ReturnType<typeof example>["quote"]) => void,
][] = [
  [
    "wrong source chain",
    (q) => {
      q.details.currencyIn.currency.chainId = 999;
    },
  ],
  [
    "wrong native decimals",
    (q) => {
      q.details.currencyIn.currency.decimals = 6;
    },
  ],
  [
    "source cap exceeded",
    (q) => {
      q.details.currencyIn.amount = "1000000001";
    },
  ],
  [
    "missing sender",
    (q) => {
      delete q.details.sender;
    },
  ],
  [
    "wrong output token",
    (q) => {
      q.details.currencyOut.currency.address = `0x${"1".repeat(40)}`;
    },
  ],
  [
    "missing output decimals",
    (q) => {
      delete q.details.currencyOut.currency.decimals;
    },
  ],
  [
    "output below floor",
    (q) => {
      q.details.currencyOut.minimumAmount = "1";
    },
  ],
  [
    "native payment amount mismatch",
    (q) => {
      q.protocol.v2.paymentDetails.amount = "1";
    },
  ],
  [
    "native payment class mismatch",
    (q) => {
      q.protocol.v2.paymentDetails.currency = captured.request.originCurrency;
    },
  ],
  [
    "unexpected solver",
    (q) => {
      q.protocol.v2.orderData.solver = `0x${"1".repeat(40)}`;
    },
  ],
  [
    "extra output calls",
    (q) => {
      q.protocol.v2.orderData.output.calls.push({
        target: `0x${"1".repeat(40)}`,
      });
    },
  ],
  [
    "extra protocol fee",
    (q) => {
      q.protocol.v2.orderData.fees.push({ amount: "1" });
    },
  ],
  [
    "output extraData mismatch",
    (q) => {
      q.protocol.v2.orderData.output.extraData = "0x";
    },
  ],
  [
    "output payment mismatch",
    (q) => {
      q.protocol.v2.orderData.output.payments[0].minimumAmount = "1";
    },
  ],
  [
    "unknown native refund account",
    (q) => {
      q.protocol.v2.orderData.inputs[0].refunds[0].recipient = `0x${"1".repeat(40)}`;
    },
  ],
  [
    "duplicate refund chain",
    (q) => {
      q.protocol.v2.orderData.inputs[0].refunds[1] =
        q.protocol.v2.orderData.inputs[0].refunds[0];
    },
  ],
  [
    "refund deadline mismatch",
    (q) => {
      q.protocol.v2.orderData.inputs[0].refunds[0].deadline++;
    },
  ],
  [
    "missing fee coverage",
    (q) => {
      delete q.fees.relayer;
    },
  ],
  [
    "wrong fee units",
    (q) => {
      q.fees.relayer.currency.decimals = 6;
    },
  ],
  [
    "wrong fee class",
    (q) => {
      q.fees.relayer.currency.address = captured.request.originCurrency;
    },
  ],
  [
    "fee exceeds cap",
    (q) => {
      q.fees.relayer.amount = "10000001";
    },
  ],
  [
    "unsupported fee",
    (q) => {
      q.fees.unknown = structuredClone(q.fees.relayer);
    },
  ],
  [
    "incomplete fee breakdown",
    (q) => {
      delete q.fees.relayerGas;
    },
  ],
  [
    "nonce mismatch",
    (q) => {
      q.steps[1].items[0].data.nonce++;
    },
  ],
  [
    "protocol order mismatch",
    (q) => {
      q.protocol.v2.orderId = `0x${"1".repeat(64)}`;
    },
  ],
  [
    "transfer destination class mismatch",
    (q) => {
      q.steps[1].items[0].data.action.parameters.destinationDex = "spot";
    },
  ],
];
for (const [label, mutate] of mutations)
  test(`native quote rejects ${label}`, () => {
    const { quote, input } = example();
    mutate(quote);
    assert.throws(() => validateRelayHypercoreQuote(input));
  });

// Recompute every signing ID after a mutation: prove the semantic guards are
// still active independently of the new cryptographic consistency check.
for (const [label, mutate] of mutations.filter(([label]) =>
  [
    "unexpected solver",
    "output extraData mismatch",
    "output payment mismatch",
    "unknown native refund account",
    "duplicate refund chain",
    "refund deadline mismatch",
  ].includes(label),
))
  test(`semantic rejection survives a valid order hash: ${label}`, () => {
    const { quote, input } = example();
    mutate(quote);
    rehash(quote);
    assert.throws(() => validateRelayHypercoreQuote(input), /binding_mismatch/);
  });

test("expiry uses the local quote policy, not the seven-day provider refund deadline", () => {
  const { input, quote } = example();
  assert.throws(
    () =>
      validateRelayHypercoreQuote({
        ...input,
        now: new Date(input.now.getTime() + 60001),
      }),
    /expired/,
  );
  assert.throws(
    () =>
      validateRelayHypercoreQuote({
        ...input,
        contractsObservedAt: new Date(input.now.getTime() + 1),
      }),
    /expired/,
  );
  const deadline = Math.floor(input.now.getTime() / 1000);
  quote.protocol.v2.orderData.output.deadline = deadline;
  for (const refund of quote.protocol.v2.orderData.inputs[0].refunds)
    refund.deadline = deadline;
  rehash(quote);
  assert.throws(() => validateRelayHypercoreQuote(input), /expired/);
});

test("optional refund summary cannot contradict the canonical refund and omission is safe", () => {
  const { quote, input } = example();
  quote.details.refundCurrency.currency.address =
    captured.request.originCurrency;
  assert.throws(() => validateRelayHypercoreQuote(input));
  delete quote.details.refundCurrency;
  assert.doesNotThrow(() => validateRelayHypercoreQuote(input));
});

test("expiring contract observation also shortens quote validity", () => {
  const { input } = example();
  const observedAt = new Date(input.now.getTime() - 59000);
  assert.equal(
    validateRelayHypercoreQuote({
      ...input,
      contractsObservedAt: observedAt,
    }).expiresAt.getTime(),
    input.now.getTime() + 1000,
  );
});

test("chain contracts reject disabled, missing, duplicate or cross-VM identities", () => {
  for (const mutate of [
    (chains: typeof captured.chains) => {
      chains.find((c: { id: number }) => c.id === 1337).disabled = true;
    },
    (chains: typeof captured.chains) => {
      chains.find((c: { id: number }) => c.id === 1337).vmType = "evm";
    },
    (chains: typeof captured.chains) => {
      chains.find((c: { id: number }) => c.id === 8453).protocol.v2.chainId =
        "polygon";
    },
    (chains: typeof captured.chains) => {
      chains.push(chains.find((c: { id: number }) => c.id === 1337));
    },
  ]) {
    const chains = structuredClone(captured.chains);
    mutate(chains);
    assert.throws(() => resolveRelayHypercoreContracts({ chains }, 8453));
  }
});

test("registry client coalesces only in-flight reads; failure and rotation can recover", async () => {
  let count = 0;
  const transport = async (url: string | URL) => {
    assert.equal(String(url), "https://api.relay.link/chains");
    count++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json(
      count === 1 ? { chains: [] } : { chains: captured.chains },
    );
  };
  const client = new RelayClient({
    apiKey: "native-chain-test",
    fetchImpl: transport,
  });
  const failed = await Promise.allSettled([
    client.hypercoreContracts(8453),
    client.hypercoreContracts(8453),
  ]);
  assert.equal(count, 1);
  assert.ok(failed.every((v) => v.status === "rejected"));
  const result = await client.hypercoreContracts(8453);
  assert.equal(count, 2);
  assert.equal(result.destinationChain, "base");
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
});
