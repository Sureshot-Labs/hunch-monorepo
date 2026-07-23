import assert from "node:assert/strict";
import { Interface, ZeroAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";
import {
  BASE_USDC,
  EVM_NATIVE_ASSET_SENTINEL,
  MAYAN_ALLOWANCE_HOLDER,
  MAYAN_FORWARDER,
  POLYGON_PUSD,
  POLYGON_USDC,
  POLYGON_USDCE_LEGACY,
  POLYMARKET_COLLATERAL_OFFRAMP,
  RELAY_APPROVAL_PROXY_V3,
  RELAY_DEPOSITORY_V2,
  RELAY_ROUTER_V3,
  RELAY_SEQUENTIAL_SWAP_EXECUTOR,
  RELAY_SOLVER,
  SOLANA_NATIVE,
  relayRehearsalScenarios,
  validateRelayRehearsalQuote,
} from "./rehearsal.js";

const user = "0x1111111111111111111111111111111111111111";
const solanaRecipient = "78Hpb2CbmvW2Gp2aJGZec8nphXdqtRdfjPwwLfxKgo6t";
const routeTarget = "0x2222222222222222222222222222222222222222";
const requestId = "fixture-rehearsal-request";
const erc20 = new Interface([
  "function approve(address spender, uint256 amount)",
]);
const routerV3 = new Interface([
  "function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable",
]);
const approvalProxyV3 = new Interface([
  "function transferAndMulticall(address[] tokens,uint256[] amounts,(address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable",
]);
const depositoryV2 = new Interface([
  "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
]);
const cleanup = new Interface([
  "function cleanupErc20sViaCall(address[] tokens,address[] recipients,bytes[] calls,uint256[] values)",
]);
const cleanupDeposit = new Interface([
  "function depositErc20(address depositor,address token,bytes32 id)",
]);
const sequentialSwap = new Interface([
  "function sequentialSwap(uint256 amountIn,address tokenIn,address tokenOut,uint256 minOut,address recipient,(uint16,address,uint256,uint256,bytes) params,bytes data)",
]);
const collateralOfframp = new Interface([
  "function unwrap(address asset,address to,uint256 amount)",
]);
const mayanAllowanceHolder = new Interface([
  "function exec(address tokenIn,address tokenOut,uint256 amountIn,address recipient,bytes data)",
]);
const mayanExecutor = new Interface([
  "function execute((address,address,uint256) order,bytes[] calls,bytes32 orderHash)",
]);

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function step(input: {
  chainId?: number;
  data: string;
  id: "approve" | "deposit";
  to: string;
  value: string;
}) {
  return {
    id: input.id,
    kind: "transaction",
    requestId,
    items: [
      {
        status: "incomplete",
        data: {
          chainId: input.chainId ?? 137,
          from: user,
          to: input.to,
          data: input.data,
          value: input.value,
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
  };
}

function details(input: {
  destinationAddress: string;
  destinationAmount: string;
  destinationChainId: number;
  destinationMinimumAmount: string;
  originAddress: string;
  originAmount: string;
  originChainId: number;
  recipient?: string;
}) {
  return {
    sender: user,
    recipient: input.recipient ?? user,
    currencyIn: {
      currency: {
        chainId: input.originChainId,
        address: input.originAddress,
      },
      amount: input.originAmount,
      minimumAmount: input.originAmount,
    },
    currencyOut: {
      currency: {
        chainId: input.destinationChainId,
        address: input.destinationAddress,
      },
      amount: input.destinationAmount,
      minimumAmount: input.destinationMinimumAmount,
    },
  };
}

function relayCleanupCall(token: string) {
  return [
    RELAY_ROUTER_V3,
    false,
    0n,
    cleanup.encodeFunctionData("cleanupErc20sViaCall", [
      [token],
      [RELAY_DEPOSITORY_V2],
      [
        cleanupDeposit.encodeFunctionData("depositErc20", [
          user,
          token,
          `0x${"22".repeat(32)}`,
        ]),
      ],
      [0n],
    ]),
  ] as const;
}

function crossVmNativeQuote(
  input: Readonly<{
    calls?: readonly string[];
    orderOutputToken?: string;
  }> = {},
) {
  const amount = 2_000_000_000_000_000_000n;
  const recipientBytes = Buffer.from(
    new PublicKey(solanaRecipient).toBytes(),
  ).toString("hex");
  const calls = input.calls ?? [
    "0xbd01c226",
    "0x38c9c147",
    "0x38c9c147",
    "0xaf72634f",
    `0x34ee90ca${recipientBytes}`,
  ];
  const mayanPayload = mayanExecutor.encodeFunctionData("execute", [
    [RELAY_ROUTER_V3, input.orderOutputToken ?? POLYGON_USDC, 1n],
    calls,
    `0x${"33".repeat(32)}`,
  ]);
  return {
    details: details({
      originChainId: 137,
      originAddress: ZeroAddress,
      originAmount: amount.toString(),
      destinationChainId: 792703809,
      destinationAddress: SOLANA_NATIVE,
      destinationAmount: "1400000",
      destinationMinimumAmount: "1300000",
      recipient: solanaRecipient,
    }),
    fees: {},
    protocol: { v2: {} },
    steps: [
      step({
        id: "deposit",
        to: RELAY_ROUTER_V3,
        value: amount.toString(),
        data: routerV3.encodeFunctionData("multicall", [
          [
            [
              MAYAN_ALLOWANCE_HOLDER,
              false,
              amount,
              mayanAllowanceHolder.encodeFunctionData("exec", [
                MAYAN_FORWARDER,
                ZeroAddress,
                amount,
                MAYAN_FORWARDER,
                mayanPayload,
              ]),
            ],
            relayCleanupCall(POLYGON_USDC),
          ],
          ZeroAddress,
          ZeroAddress,
          "0x1234",
        ]),
      }),
    ],
  };
}

function nativeQuote(
  input: Readonly<{
    paramsCap?: bigint;
    paramsTarget?: string;
    routeData?: string;
  }> = {},
) {
  const amount = 1_000_000_000_000_000_000n;
  return {
    details: details({
      originChainId: 137,
      originAddress: ZeroAddress,
      originAmount: amount.toString(),
      destinationChainId: 8453,
      destinationAddress: ZeroAddress,
      destinationAmount: "30000000000000",
      destinationMinimumAmount: "28000000000000",
    }),
    fees: {},
    protocol: { v2: {} },
    steps: [
      step({
        id: "deposit",
        to: RELAY_ROUTER_V3,
        value: amount.toString(),
        data: routerV3.encodeFunctionData("multicall", [
          [
            [
              RELAY_SEQUENTIAL_SWAP_EXECUTOR,
              false,
              amount,
              sequentialSwap.encodeFunctionData("sequentialSwap", [
                amount,
                EVM_NATIVE_ASSET_SENTINEL,
                POLYGON_USDC,
                1n,
                RELAY_ROUTER_V3,
                [
                  0,
                  input.paramsTarget ?? ZeroAddress,
                  0n,
                  input.paramsCap ?? BigInt(`0x${"ff".repeat(32)}`),
                  "0x",
                ],
                input.routeData ?? "0xd001",
              ]),
            ],
            relayCleanupCall(POLYGON_USDC),
          ],
          ZeroAddress,
          ZeroAddress,
          "0x1234",
        ]),
      }),
    ],
  };
}

function erc20Quote() {
  const amount = 1_000_000n;
  const quote = {
    details: details({
      originChainId: 137,
      originAddress: POLYGON_PUSD,
      originAmount: amount.toString(),
      destinationChainId: 8453,
      destinationAddress:
        relayRehearsalScenarios["polygon-pusd-to-base-usdc"]
          .destinationCurrency,
      destinationAmount: "960000",
      destinationMinimumAmount: "920000",
    }),
    fees: {},
    protocol: { v2: {} },
    steps: [
      step({
        id: "approve",
        to: POLYGON_PUSD,
        value: "0",
        data: erc20.encodeFunctionData("approve", [
          RELAY_APPROVAL_PROXY_V3,
          amount,
        ]),
      }),
      step({
        id: "deposit",
        to: RELAY_APPROVAL_PROXY_V3,
        value: "0",
        data: approvalProxyV3.encodeFunctionData("transferAndMulticall", [
          [POLYGON_PUSD],
          [amount],
          [
            [
              POLYGON_PUSD,
              false,
              0n,
              erc20.encodeFunctionData("approve", [RELAY_ROUTER_V3, amount]),
            ],
            [
              POLYGON_PUSD,
              false,
              0n,
              erc20.encodeFunctionData("approve", [
                POLYMARKET_COLLATERAL_OFFRAMP,
                amount,
              ]),
            ],
            [
              POLYMARKET_COLLATERAL_OFFRAMP,
              false,
              0n,
              collateralOfframp.encodeFunctionData("unwrap", [
                POLYGON_USDCE_LEGACY,
                RELAY_ROUTER_V3,
                amount,
              ]),
            ],
            relayCleanupCall(POLYGON_USDCE_LEGACY),
          ],
          RELAY_SOLVER,
          RELAY_SOLVER,
          "0x1234",
        ]),
      }),
    ],
  };
  const approveStep = required(quote.steps[0], "approve step");
  delete (
    required(approveStep.items[0], "approve item") as {
      check?: unknown;
    }
  ).check;
  return quote;
}

function v2Erc20Quote() {
  const amount = 500_000n;
  const quote = {
    details: details({
      originChainId: 8453,
      originAddress: BASE_USDC,
      originAmount: amount.toString(),
      destinationChainId: 137,
      destinationAddress: POLYGON_PUSD,
      destinationAmount: "490000",
      destinationMinimumAmount: "450000",
    }),
    fees: {},
    protocol: { v2: {} },
    steps: [
      step({
        id: "approve",
        chainId: 8453,
        to: BASE_USDC,
        value: "0",
        data: erc20.encodeFunctionData("approve", [
          RELAY_DEPOSITORY_V2,
          amount,
        ]),
      }),
      step({
        id: "deposit",
        chainId: 8453,
        to: RELAY_DEPOSITORY_V2,
        value: "0",
        data: depositoryV2.encodeFunctionData("depositErc20", [
          user,
          BASE_USDC,
          amount,
          `0x${"11".repeat(32)}`,
        ]),
      }),
    ],
  };
  const approveStep = required(quote.steps[0], "approve step");
  delete (
    required(approveStep.items[0], "approve item") as {
      check?: unknown;
    }
  ).check;
  return quote;
}

{
  const validated = validateRelayRehearsalQuote({
    amount: 1_000_000_000_000_000_000n,
    minimumOutputFloor: 20_000_000_000_000n,
    quote: nativeQuote(),
    scenario: relayRehearsalScenarios["polygon-pol-to-base-eth"],
    user,
  });
  assert.equal(validated.routeShape, "relay-router-v3-native");
  assert.equal(validated.actions.length, 1);
  assert.equal(validated.minimumOutputRaw, 28_000_000_000_000n);
}

for (const [name, quote] of [
  ["sequentialSwap nonzero target", nativeQuote({ paramsTarget: routeTarget })],
  ["sequentialSwap reduced cap", nativeQuote({ paramsCap: 1n })],
  [
    "sequentialSwap unknown route envelope",
    nativeQuote({ routeData: "0x1234" }),
  ],
] as const) {
  assert.throws(
    () =>
      validateRelayRehearsalQuote({
        amount: 1_000_000_000_000_000_000n,
        minimumOutputFloor: 20_000_000_000_000n,
        quote,
        scenario: relayRehearsalScenarios["polygon-pol-to-base-eth"],
        user,
      }),
    Error,
    name,
  );
}

{
  const validated = validateRelayRehearsalQuote({
    amount: 1_000_000n,
    minimumOutputFloor: 850_000n,
    quote: erc20Quote(),
    scenario: relayRehearsalScenarios["polygon-pusd-to-base-usdc"],
    user,
  });
  assert.equal(validated.routeShape, "relay-approval-proxy-v3-erc20");
  assert.deepEqual(
    validated.actions.map((action) => action.stepId),
    ["approve", "deposit"],
  );
}

{
  const validated = validateRelayRehearsalQuote({
    amount: 2_000_000_000_000_000_000n,
    minimumOutputFloor: 1_100_000n,
    quote: crossVmNativeQuote(),
    recipient: solanaRecipient,
    scenario: relayRehearsalScenarios["polygon-pol-to-solana-sol"],
    user,
  });
  assert.equal(validated.routeShape, "relay-router-v3-native");
  assert.equal(validated.minimumOutputRaw, 1_300_000n);
}

{
  const quote = crossVmNativeQuote();
  quote.details.recipient = "9HXGB1nMpw4vhMUCZC5JLfpZt6RXZoaf2HptmormMReH";
  assert.throws(
    () =>
      validateRelayRehearsalQuote({
        amount: 2_000_000_000_000_000_000n,
        minimumOutputFloor: 1_100_000n,
        quote,
        recipient: solanaRecipient,
        scenario: relayRehearsalScenarios["polygon-pol-to-solana-sol"],
        user,
      }),
    /details.recipient mismatch/,
  );
}

for (const [name, quote] of [
  [
    "Mayan wrong output token",
    crossVmNativeQuote({ orderOutputToken: POLYGON_PUSD }),
  ],
  [
    "Mayan unknown nested selector",
    crossVmNativeQuote({
      calls: [
        "0x12345678",
        "0x38c9c147",
        "0x38c9c147",
        "0xaf72634f",
        `0x34ee90ca${Buffer.from(
          new PublicKey(solanaRecipient).toBytes(),
        ).toString("hex")}`,
      ],
    }),
  ],
  [
    "Mayan missing recipient binding",
    crossVmNativeQuote({
      calls: [
        "0xbd01c226",
        "0x38c9c147",
        "0x38c9c147",
        "0xaf72634f",
        "0x34ee90ca",
      ],
    }),
  ],
] as const) {
  assert.throws(
    () =>
      validateRelayRehearsalQuote({
        amount: 2_000_000_000_000_000_000n,
        minimumOutputFloor: 1_100_000n,
        quote,
        recipient: solanaRecipient,
        scenario: relayRehearsalScenarios["polygon-pol-to-solana-sol"],
        user,
      }),
    Error,
    name,
  );
}

{
  const validated = validateRelayRehearsalQuote({
    amount: 500_000n,
    minimumOutputFloor: 400_000n,
    quote: v2Erc20Quote(),
    scenario: relayRehearsalScenarios["base-usdc-to-polygon-pusd"],
    user,
  });
  assert.equal(validated.routeShape, "relay-depository-v2-erc20");
  assert.deepEqual(
    validated.actions.map((action) => action.stepId),
    ["approve", "deposit"],
  );
}

for (const mutation of [
  {
    name: "wrong top-level target",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const depositStep = required(quote.steps[1], "deposit step");
      required(depositStep.items[0], "deposit item").data.to = routeTarget;
    },
  },
  {
    name: "approval exceeds exact input",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const approveStep = required(quote.steps[0], "approve step");
      required(approveStep.items[0], "approve item").data.data =
        erc20.encodeFunctionData("approve", [
          RELAY_APPROVAL_PROXY_V3,
          1_000_001n,
        ]);
    },
  },
  {
    name: "wrong source chain",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const depositStep = required(quote.steps[1], "deposit step");
      required(depositStep.items[0], "deposit item").data.chainId = 8453;
    },
  },
  {
    name: "wrong source token",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      quote.details.currencyIn.currency.address = BASE_USDC;
    },
  },
  {
    name: "wrong approval spender",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const approveStep = required(quote.steps[0], "approve step");
      required(approveStep.items[0], "approve item").data.data =
        erc20.encodeFunctionData("approve", [routeTarget, 1_000_000n]);
    },
  },
  {
    name: "wrong approval selector",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const approveStep = required(quote.steps[0], "approve step");
      required(approveStep.items[0], "approve item").data.data = "0x12345678";
    },
  },
  {
    name: "provider authorization action",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const depositStep = required(quote.steps[1], "deposit step");
      Object.assign(required(depositStep.items[0], "deposit item").data, {
        authorizationList: [],
      });
    },
  },
  {
    name: "unknown executable field",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      const depositStep = required(quote.steps[1], "deposit step");
      Object.assign(required(depositStep.items[0], "deposit item").data, {
        futureExecutionField: false,
      });
    },
  },
  {
    name: "wrong controlled recipient",
    apply: (quote: ReturnType<typeof erc20Quote>) => {
      quote.details.recipient = routeTarget;
    },
  },
]) {
  const quote = erc20Quote();
  mutation.apply(quote);
  assert.throws(
    () =>
      validateRelayRehearsalQuote({
        amount: 1_000_000n,
        minimumOutputFloor: 850_000n,
        quote,
        scenario: relayRehearsalScenarios["polygon-pusd-to-base-usdc"],
        user,
      }),
    Error,
    mutation.name,
  );
}

assert.throws(
  () =>
    validateRelayRehearsalQuote({
      amount: 1_000_000n,
      minimumOutputFloor: 950_000n,
      quote: erc20Quote(),
      scenario: relayRehearsalScenarios["polygon-pusd-to-base-usdc"],
      user,
    }),
  /minimum output below authorized floor/,
);

console.log(
  "[relay-rehearsal] V2/V3 calldata allowlist, cross-VM recipient, exact spend, correlation, and negative mutations ok",
);
