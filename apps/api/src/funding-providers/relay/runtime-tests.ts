import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Interface, ZeroAddress } from "ethers";

import type {
  ActionValidationContext,
  ProviderQuoteCandidate,
} from "../../funding/domain/contracts.js";
import type {
  FundingSourceRef,
  FundingTarget,
  NormalizedAction,
} from "../../funding/domain/types.js";
import { PRODUCTION_FUNDING_REGISTRY } from "../../funding/policies/funding-policy.js";
import { RelayPinnedActionValidator } from "./action-validator.js";
import { RelayClient, RelayClientError } from "./client.js";
import {
  assertStrictRelayDepositAddressPolicy,
  StrictRelayDepositAddressAdapter,
} from "./deposit-address.js";
import { RELAY_ROUTE_SPECS, relayChainIdForNetwork } from "./mappings.js";
import {
  createRelayDepositAddressCodec,
  createRelayReferenceCodec,
} from "./reference-codec.js";
import {
  rejectDisabledRelayCapabilities,
  RelayCapabilityRejectedError,
} from "./schemas.js";
import { classifyRelayStatus } from "./status.js";
import {
  EVM_NATIVE_ASSET_SENTINEL,
  POLYGON_PUSD,
  POLYGON_USDC,
  RELAY_DEPOSITORY_V2,
  RELAY_ROUTER_V3,
  RELAY_SEQUENTIAL_SWAP_EXECUTOR,
  relayRehearsalScenarios,
} from "./rehearsal.js";
import { verifyRelayWebhook } from "./webhook.js";
import { RelayWalletQuoteAdapter } from "./wallet-adapter.js";

const user = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const depositAddress = "0x6666666666666666666666666666666666666666";
const requestId = "fixture-runtime-request-0001";
const routerV3 = new Interface([
  "function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable",
]);
const sequentialSwap = new Interface([
  "function sequentialSwap(uint256 amountIn,address tokenIn,address tokenOut,uint256 minOut,address recipient,(uint16,address,uint256,uint256,bytes) params,bytes data)",
]);
const cleanup = new Interface([
  "function cleanupErc20sViaCall(address[] tokens,address[] recipients,bytes[] calls,uint256[] values)",
]);
const cleanupDeposit = new Interface([
  "function depositErc20(address depositor,address token,bytes32 id)",
]);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nativeWalletQuote() {
  const amount = "1000000000000000000";
  const cleanupData = cleanup.encodeFunctionData("cleanupErc20sViaCall", [
    [POLYGON_USDC],
    [RELAY_DEPOSITORY_V2],
    [
      cleanupDeposit.encodeFunctionData("depositErc20", [
        user,
        POLYGON_USDC,
        `0x${"22".repeat(32)}`,
      ]),
    ],
    [0n],
  ]);
  return {
    details: {
      operation: "swap",
      sender: user,
      recipient: user,
      currencyIn: {
        currency: {
          chainId: 137,
          address: ZeroAddress,
          decimals: 18,
        },
        amount,
        minimumAmount: amount,
      },
      currencyOut: {
        currency: {
          chainId: 8453,
          address: ZeroAddress,
          decimals: 18,
        },
        amount: "30000000000000",
        minimumAmount: "28000000000000",
      },
      timeEstimate: 2,
    },
    fees: {
      gas: {
        currency: {
          chainId: 137,
          address: ZeroAddress,
          decimals: 18,
        },
        amount: "100",
        minimumAmount: "100",
      },
      relayer: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
          decimals: 6,
        },
        amount: "30",
        minimumAmount: "30",
      },
      relayerGas: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
          decimals: 6,
        },
        amount: "10",
        minimumAmount: "10",
      },
      relayerService: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
          decimals: 6,
        },
        amount: "20",
        minimumAmount: "20",
      },
      app: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
          decimals: 6,
        },
        amount: "0",
        minimumAmount: "0",
      },
      subsidized: {
        currency: {
          chainId: 137,
          address: POLYGON_PUSD,
          decimals: 6,
        },
        amount: "0",
        minimumAmount: "0",
      },
    },
    steps: [
      {
        id: "deposit",
        kind: "transaction",
        requestId,
        items: [
          {
            status: "incomplete",
            data: {
              chainId: 137,
              from: user,
              to: RELAY_ROUTER_V3,
              data: routerV3.encodeFunctionData("multicall", [
                [
                  [
                    RELAY_SEQUENTIAL_SWAP_EXECUTOR,
                    false,
                    BigInt(amount),
                    sequentialSwap.encodeFunctionData("sequentialSwap", [
                      BigInt(amount),
                      EVM_NATIVE_ASSET_SENTINEL,
                      POLYGON_USDC,
                      1n,
                      RELAY_ROUTER_V3,
                      [
                        0,
                        ZeroAddress,
                        0n,
                        BigInt(`0x${"ff".repeat(32)}`),
                        "0x",
                      ],
                      "0xd001",
                    ]),
                  ],
                  [RELAY_ROUTER_V3, false, 0n, cleanupData],
                ],
                ZeroAddress,
                ZeroAddress,
                "0x1234",
              ]),
              value: amount,
              gas: "500000",
              maxFeePerGas: "500000000000",
              maxPriorityFeePerGas: "200000000000",
            },
            check: {
              endpoint: `/intents/status/v3?requestId=${requestId}`,
              method: "GET",
            },
          },
        ],
      },
    ],
  };
}

function strictDepositQuote() {
  return {
    details: {
      operation: "swap",
      sender: user,
      recipient,
      currencyIn: {
        currency: {
          chainId: 137,
          address: ZeroAddress,
          decimals: 18,
        },
        amount: "1000000000000000000",
        minimumAmount: "1000000000000000000",
      },
      currencyOut: {
        currency: {
          chainId: 8453,
          address: ZeroAddress,
          decimals: 18,
        },
        amount: "30000000000000",
        minimumAmount: "28000000000000",
      },
      timeEstimate: 2,
    },
    fees: {},
    steps: [
      {
        id: "deposit",
        kind: "transaction",
        requestId,
        depositAddress,
        items: [
          {
            status: "incomplete",
            data: {
              chainId: 137,
              from: user,
              to: depositAddress,
              data: "0x",
              value: "1000000000000000000",
            },
            check: {
              endpoint: `/intents/status/v3?requestId=${requestId}`,
              method: "GET",
            },
          },
        ],
      },
    ],
  };
}

const route = RELAY_ROUTE_SPECS["polygon-pol-to-base-eth"];
if (!route) throw new Error("test route missing");
const source: FundingSourceRef = {
  kind: "owned_location",
  location: {
    kind: "wallet",
    locationId: "wallet-source",
    accountId: "user-1",
    asset: route.source,
    details: { walletId: "wallet-1", address: user },
  },
};
const destination: FundingTarget = {
  kind: "owned_location",
  location: {
    kind: "wallet",
    locationId: "wallet-destination",
    accountId: "user-1",
    asset: route.destination,
    details: { walletId: "wallet-2", address: user },
  },
};

{
  let observedUrl = "";
  let observedBody: Record<string, unknown> = {};
  const client = new RelayClient({
    apiKey: "relay-test-secret",
    fetchImpl: async (input, init) => {
      observedUrl = input.toString();
      assert.equal(
        (init?.headers as Record<string, string>)["x-api-key"],
        "relay-test-secret",
      );
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(nativeWalletQuote());
    },
  });
  const normalized = await new RelayWalletQuoteAdapter(client).quote({
    route,
    source,
    destination,
    sourceAmount: {
      asset: route.source,
      raw: "1000000000000000000",
    },
    minimumOutput: {
      asset: route.destination,
      raw: "27000000000000",
    },
    userAddress: user,
    recipientAddress: user,
    senderWalletId: "wallet-1",
    quoteCorrelationId: "quote-correlation-1",
    deadline: new Date(Date.now() + 120_000),
  });
  assert.match(observedUrl, /\/quote\/v2$/u);
  assert.equal(observedBody.tradeType, "EXACT_INPUT");
  assert.equal(observedBody.useDepositAddress, false);
  assert.equal(normalized.requestId, requestId);
  assert.equal(normalized.actions.length, 1);
  assert.equal(normalized.actions[0]?.kind, "evm_transaction");
  assert.equal(normalized.candidate.fees[0]?.amount.asset.networkId, "evm:137");
  assert.deepEqual(
    normalized.candidate.fees.map(({ kind }) => kind),
    ["gas", "relayer"],
  );
  assert.doesNotMatch(normalized.candidate.opaqueQuoteRef, /runtime-request/u);
}

{
  const startedAt = new Date("2030-01-01T00:00:00.000Z");
  const deadline = new Date(startedAt.getTime() + 1_000);
  let clock = startedAt;
  const client = new RelayClient({
    apiKey: "relay-test-secret",
    fetchImpl: async () => {
      clock = new Date(deadline.getTime() + 1);
      return response(nativeWalletQuote());
    },
  });
  await assert.rejects(
    () =>
      new RelayWalletQuoteAdapter(client, () => clock).quote({
        route,
        source,
        destination,
        sourceAmount: {
          asset: route.source,
          raw: "1000000000000000000",
        },
        minimumOutput: {
          asset: route.destination,
          raw: "27000000000000",
        },
        userAddress: user,
        recipientAddress: user,
        senderWalletId: "wallet-1",
        quoteCorrelationId: "quote-correlation-expiry",
        deadline,
      }),
    /expired before validation completed/u,
  );
}

{
  for (const mutation of [
    {
      name: "fee breakdown mismatch",
      apply: (quote: ReturnType<typeof nativeWalletQuote>) => {
        quote.fees.relayerService.amount = "21";
      },
    },
    {
      name: "nonzero subsidy",
      apply: (quote: ReturnType<typeof nativeWalletQuote>) => {
        quote.fees.subsidized.amount = "1";
      },
    },
    {
      name: "unknown fee",
      apply: (quote: ReturnType<typeof nativeWalletQuote>) => {
        Object.assign(quote.fees, {
          futureFee: quote.fees.gas,
        });
      },
    },
  ] as const) {
    const quote = nativeWalletQuote();
    mutation.apply(quote);
    const client = new RelayClient({
      apiKey: "relay-test-secret",
      fetchImpl: async () => response(quote),
    });
    await assert.rejects(
      () =>
        new RelayWalletQuoteAdapter(client).quote({
          route,
          source,
          destination,
          sourceAmount: {
            asset: route.source,
            raw: "1000000000000000000",
          },
          minimumOutput: {
            asset: route.destination,
            raw: "27000000000000",
          },
          userAddress: user,
          recipientAddress: user,
          senderWalletId: "wallet-1",
          quoteCorrelationId: "quote-correlation-fee-mutation",
          deadline: new Date(Date.now() + 120_000),
        }),
      Error,
      mutation.name,
    );
  }
}

{
  const client = new RelayClient({
    apiKey: "relay-test-secret",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.useDepositAddress, true);
      assert.equal(body.strict, true);
      assert.equal(body.refundTo, user);
      return response(strictDepositQuote());
    },
  });
  const plan = await new StrictRelayDepositAddressAdapter(client).create({
    route,
    sourceAmount: {
      asset: route.source,
      raw: "1000000000000000000",
    },
    minimumOutput: {
      asset: route.destination,
      raw: "27000000000000",
    },
    senderAddress: user,
    recipientAddress: recipient,
    refundAddress: user,
    deadline: new Date(Date.now() + 120_000),
    policy: {
      mode: "strict",
      sourceKind: "controlled_wallet",
      controlledSender: true,
      refundOwnership: "user_owned",
      privyIngress: false,
      destinationCalldata: null,
    },
  });
  assert.equal(plan.depositAddress, depositAddress);
  assert.ok(Date.parse(plan.expiresAt) > Date.now());
  assert.equal(plan.requestTracking, "request_and_children");
  assert.equal(
    plan.wrongAssetBehavior,
    "stop_and_manual_recovery_not_guaranteed",
  );
  assert.equal(
    plan.wrongChainBehavior,
    "stop_and_manual_recovery_not_guaranteed",
  );
  assert.equal(plan.underpaymentBehavior, "fail_closed_and_reconcile_refund");
  assert.equal(
    plan.overpaymentBehavior,
    "execute_exact_and_reconcile_excess_refund",
  );
}

{
  const startedAt = new Date("2030-01-01T00:00:00.000Z");
  const deadline = new Date(startedAt.getTime() + 1_000);
  let clock = startedAt;
  const client = new RelayClient({
    apiKey: "relay-test-secret",
    fetchImpl: async () => {
      clock = new Date(deadline.getTime() + 1);
      return response(strictDepositQuote());
    },
  });
  await assert.rejects(
    () =>
      new StrictRelayDepositAddressAdapter(client, () => clock).create({
        route,
        sourceAmount: {
          asset: route.source,
          raw: "1000000000000000000",
        },
        minimumOutput: {
          asset: route.destination,
          raw: "27000000000000",
        },
        senderAddress: user,
        recipientAddress: recipient,
        refundAddress: user,
        deadline,
        policy: {
          mode: "strict",
          sourceKind: "controlled_wallet",
          controlledSender: true,
          refundOwnership: "user_owned",
          privyIngress: false,
          destinationCalldata: null,
        },
      }),
    /expired before validation completed/u,
  );
}

{
  const mutations = [
    {
      name: "wrong source chain",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        quote.details.currencyIn.currency.chainId = 8453;
      },
    },
    {
      name: "wrong source token",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        quote.details.currencyIn.currency.address = recipient;
      },
    },
    {
      name: "wrong destination token",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        quote.details.currencyOut.currency.address = recipient;
      },
    },
    {
      name: "wrong transfer target",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        const step = quote.steps[0];
        const item = step?.items[0];
        if (!item) throw new Error("strict deposit item missing");
        item.data.to = recipient;
      },
    },
    {
      name: "wrong exact amount",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        const step = quote.steps[0];
        const item = step?.items[0];
        if (!item) throw new Error("strict deposit item missing");
        item.data.value = "999999999999999999";
      },
    },
    {
      name: "wrong request correlation",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        const step = quote.steps[0];
        const item = step?.items[0];
        if (!item) throw new Error("strict deposit item missing");
        item.check.endpoint = "/intents/status/v3?requestId=wrong-request";
      },
    },
    {
      name: "underpaid quoted source",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        quote.details.currencyIn.amount = "999999999999999999";
      },
    },
    {
      name: "minimum output below caller floor",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        quote.details.currencyOut.minimumAmount = "1";
      },
    },
    {
      name: "unknown transfer capability",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        const step = quote.steps[0];
        const item = step?.items[0];
        if (!item) throw new Error("strict deposit item missing");
        Object.assign(item.data, { futureExecutionField: false });
      },
    },
    {
      name: "multiple transfer items",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        const step = quote.steps[0];
        const item = step?.items[0];
        if (!step || !item) throw new Error("strict deposit item missing");
        step.items.push(structuredClone(item));
      },
    },
    {
      name: "conflicting top-level deposit address",
      apply: (quote: ReturnType<typeof strictDepositQuote>) => {
        Object.assign(quote, { depositAddress: recipient });
      },
    },
  ] as const;
  for (const mutation of mutations) {
    const quote = strictDepositQuote();
    mutation.apply(quote);
    const client = new RelayClient({
      apiKey: "relay-test-secret",
      fetchImpl: async () => response(quote),
    });
    await assert.rejects(
      () =>
        new StrictRelayDepositAddressAdapter(client).create({
          route,
          sourceAmount: {
            asset: route.source,
            raw: "1000000000000000000",
          },
          minimumOutput: {
            asset: route.destination,
            raw: "27000000000000",
          },
          senderAddress: user,
          recipientAddress: recipient,
          refundAddress: user,
          deadline: new Date(Date.now() + 120_000),
          policy: {
            mode: "strict",
            sourceKind: "controlled_wallet",
            controlledSender: true,
            refundOwnership: "user_owned",
            privyIngress: false,
            destinationCalldata: null,
          },
        }),
      Error,
      mutation.name,
    );
  }
}

{
  const basePolicy = {
    mode: "strict" as const,
    sourceKind: "controlled_wallet" as const,
    controlledSender: true,
    refundOwnership: "user_owned" as const,
    privyIngress: false,
    destinationCalldata: null,
  };
  assert.throws(
    () =>
      assertStrictRelayDepositAddressPolicy({
        ...basePolicy,
        mode: "open",
      }),
    /open\/variable/u,
  );
  for (const sourceKind of ["exchange", "privy", "manual"] as const) {
    assert.throws(() =>
      assertStrictRelayDepositAddressPolicy({
        ...basePolicy,
        sourceKind,
      }),
    );
  }
  assert.throws(() =>
    assertStrictRelayDepositAddressPolicy({
      ...basePolicy,
      refundOwnership: "app_controlled",
    }),
  );
  assert.throws(() =>
    assertStrictRelayDepositAddressPolicy({
      ...basePolicy,
      privyIngress: true,
    }),
  );
  assert.throws(() =>
    assertStrictRelayDepositAddressPolicy({
      ...basePolicy,
      destinationCalldata: "0x1234",
    }),
  );
}

{
  for (const field of [
    "authorizationList",
    "depositFeePayer",
    "gasless",
    "subsidizeFees",
    "topupGas",
  ]) {
    assert.throws(
      () => rejectDisabledRelayCapabilities({ nested: { [field]: false } }),
      (error: unknown) => error instanceof RelayCapabilityRejectedError,
    );
  }
  assert.doesNotThrow(() =>
    rejectDisabledRelayCapabilities({
      fees: { subsidized: { amount: "0" } },
    }),
  );
}

{
  const expectedStatuses: Readonly<
    Record<string, ReturnType<typeof classifyRelayStatus>["category"]>
  > = {
    waiting: "awaiting_source",
    depositing: "awaiting_source",
    pending: "in_progress",
    submitted: "in_progress",
    success: "provider_success",
    failure: "provider_failure",
    refund: "refund_in_progress",
    refunded: "unknown",
    delayed: "unknown",
    future_status: "unknown",
  };
  for (const [status, category] of Object.entries(expectedStatuses)) {
    const decision = classifyRelayStatus(status);
    assert.equal(decision.category, category);
    assert.equal(decision.terminalForFunding, false);
  }
}

{
  const encryptionKey = Buffer.alloc(32, 7);
  const codecConfig = {
    encryptionKey,
    lookupHmacKey: "lookup-secret-key-material".repeat(2),
    keyVersion: 3,
  };
  const requestCodec = createRelayReferenceCodec(codecConfig);
  const addressCodec = createRelayDepositAddressCodec(codecConfig);
  const ciphertext = requestCodec.encrypt(requestId);
  assert.equal(requestCodec.decrypt(ciphertext), requestId);
  assert.notEqual(requestCodec.encrypt(requestId), ciphertext);
  assert.equal(
    requestCodec.fingerprint(requestId),
    requestCodec.fingerprint(requestId),
  );
  assert.notEqual(
    requestCodec.fingerprint(depositAddress),
    addressCodec.fingerprint(depositAddress),
  );
  assert.throws(() => addressCodec.decrypt(ciphertext), /domain mismatch/u);
}

{
  const rawBody = Buffer.from(
    JSON.stringify({
      event: "request.status.updated",
      timestamp: 1_800_000_000_000,
      data: { status: "success", requestId },
    }),
  );
  const apiKey = "relay-webhook-test-secret";
  const timestamp = "1800000000000";
  const signature = crypto
    .createHmac("sha256", apiKey)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  const verified = verifyRelayWebhook({
    rawBody,
    headers: {
      "X-Signature-Timestamp": timestamp,
      "X-Signature-SHA256": signature,
    },
    apiKey,
    now: new Date(1_800_000_000_100),
  });
  assert.equal(verified.payload.data.requestId, requestId);
  assert.throws(() =>
    verifyRelayWebhook({
      rawBody: Buffer.concat([rawBody, Buffer.from(" ")]),
      headers: {
        "X-Signature-Timestamp": timestamp,
        "X-Signature-SHA256": signature,
      },
      apiKey,
      now: new Date(1_800_000_000_100),
    }),
  );
  assert.throws(() =>
    verifyRelayWebhook({
      rawBody,
      headers: {
        "X-Signature-Timestamp": timestamp,
        "X-Signature-SHA256": signature,
      },
      apiKey,
      now: new Date(1_800_001_000_000),
    }),
  );
  const mismatchedTimestamp = "1800000000001";
  const mismatchedTimestampSignature = crypto
    .createHmac("sha256", apiKey)
    .update(`${mismatchedTimestamp}.`)
    .update(rawBody)
    .digest("hex");
  assert.throws(() =>
    verifyRelayWebhook({
      rawBody,
      headers: {
        "X-Signature-Timestamp": mismatchedTimestamp,
        "X-Signature-SHA256": mismatchedTimestampSignature,
      },
      apiKey,
      now: new Date(Number(mismatchedTimestamp)),
    }),
  );
}

{
  const expected: NormalizedAction = {
    kind: "evm_transaction",
    actionId: "relay:fixture:deposit",
    networkId: "evm:137",
    senderWalletId: "wallet-1",
    to: RELAY_ROUTER_V3,
    data: "0x12345678",
    valueRaw: "100",
    gasLimitRaw: "500000",
  };
  const validator = new RelayPinnedActionValidator(expected);
  const context: ActionValidationContext = {
    operationId: "operation-1",
    expectedState: { status: "awaiting_user", stage: "committed" },
    expectedNetworkId: "evm:137",
    expectedSignerWalletId: "wallet-1",
    sourceAmount: { asset: route.source, raw: "100" },
    minimumOutput: { asset: route.destination, raw: "1" },
    policyRevision: "policy-1",
    routeId: "polygon-pol-to-base-eth",
  };
  await validator.validate(expected, context);
  const mutations: readonly Partial<typeof expected>[] = [
    { to: recipient },
    { data: "0x87654321" },
    { valueRaw: "101" },
    { gasLimitRaw: "1" },
    { networkId: "evm:8453" },
    { senderWalletId: "wallet-2" },
  ];
  for (const mutation of mutations) {
    await assert.rejects(() =>
      validator.validate({ ...expected, ...mutation }, context),
    );
  }
  assert.throws(
    () =>
      new RelayPinnedActionValidator({
        kind: "signature",
        actionId: "relay:forbidden:signature",
        networkId: "evm:137",
        signerWalletId: "wallet-1",
        payloadKind: "eip712",
        payload: {},
      }),
    /signature and authorization/u,
  );
}

{
  assert.equal(relayChainIdForNetwork("solana:mainnet"), 792703809);
  assert.deepEqual(
    Object.keys(RELAY_ROUTE_SPECS).sort(),
    [
      ...Object.keys(relayRehearsalScenarios),
      "solana-usdc-to-polygon-pusd",
    ].sort(),
  );
  assert.equal(PRODUCTION_FUNDING_REGISTRY.networkExecutors.length, 0);
  assert.ok(
    PRODUCTION_FUNDING_REGISTRY.providerAdapters.some(
      ({ id }) => id === "relay_quote_v2",
    ),
  );
}

{
  const client = new RelayClient({
    apiKey: "relay-requests-secret",
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      assert.equal(url.pathname, "/requests/v2");
      assert.equal(url.searchParams.get("depositAddress"), depositAddress);
      assert.equal(url.searchParams.get("includeChildRequests"), "true");
      assert.equal(url.searchParams.get("limit"), "50");
      assert.equal(url.searchParams.get("sortBy"), "updatedAt");
      assert.equal(url.searchParams.get("sortDirection"), "asc");
      return response({
        requests: [
          {
            id: requestId,
            status: "refund",
            updatedAt: "2026-07-23T10:00:01.000Z",
            depositAddress: { address: depositAddress },
            data: {
              failReason: "N/A",
              refundFailReason: "N/A",
            },
          },
        ],
      });
    },
  });
  const requests = await client.requestsByDepositAddress(depositAddress);
  assert.deepEqual(requests, [
    {
      requestId,
      status: "refund",
      updatedAt: Date.parse("2026-07-23T10:00:01.000Z"),
      depositAddress: { address: depositAddress },
      failReason: "N/A",
      refundFailReason: "N/A",
    },
  ]);

  const driftedClient = new RelayClient({
    apiKey: "relay-requests-secret",
    fetchImpl: async () =>
      response({
        requests: [{ requestId, status: "pending" }],
      }),
  });
  await assert.rejects(
    () => driftedClient.requestsByDepositAddress(depositAddress),
    (error: unknown) =>
      error instanceof RelayClientError && error.code === "invalid_response",
  );
}

{
  const client = new RelayClient({
    apiKey: "not-leaked-secret",
    fetchImpl: async () => response({ error: "no" }, 503),
  });
  await assert.rejects(
    () => client.status(requestId),
    (error: unknown) => {
      assert.ok(error instanceof RelayClientError);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /not-leaked-secret/u);
      return true;
    },
  );
}

{
  const client = new RelayClient({
    apiKey: "relay-timeout-secret",
    timeoutMs: 20,
    fetchImpl: async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("aborted")),
              { once: true },
            );
          },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    () => client.status(requestId),
    (error: unknown) =>
      error instanceof RelayClientError && error.code === "timeout",
  );
  assert.throws(
    () =>
      new RelayClient({
        apiKey: "relay-timeout-secret",
        timeoutMs: 60_001,
      }),
    /between 1 and 60000/u,
  );
}

const candidateTypeCheck: ProviderQuoteCandidate["amountMode"] = "exact_input";
assert.equal(candidateTypeCheck, "exact_input");
console.log("[relay-runtime-tests] passed");
