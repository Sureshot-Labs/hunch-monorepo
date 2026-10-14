import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssetLocation } from "../../funding/domain/types.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../funding/reconciliation/owned-route-destination-observer.js";
import {
  hypercorePerpsRefundLocation,
  hypercoreSpotAccountLocation,
} from "../../account-value/canonical.js";
import { RELAY_ROUTE_SPECS } from "./mappings.js";
import { relayRequestEvidenceSchema } from "./request-evidence.js";
import {
  selectRelayRefundReceiptPlan,
  verifyRelayRefundReceipts,
} from "./refund-evidence.js";

const account = "refund-test-account";
const sourceOwner = `0x${"1".repeat(40)}`;
const nativeOwner = `0x${"cd".repeat(20)}`;
const provider = `0x${"ab".repeat(20)}`;
const orderId = `0x${"4".repeat(64)}`;
const hash = `0x${"ef".repeat(32)}`;
const otherHash = `0x${"6".repeat(64)}`;
const now = new Date("2026-10-14T18:00:00Z");
function required<T>(value: T | null | undefined): T {
  assert.ok(value != null, "required fixture field");
  return value;
}
function refundDestination(f: ReturnType<typeof fixture>) {
  return required(
    required(required(f.input.request.protocol).settlement).destination,
  );
}
function actualRoute(f: ReturnType<typeof fixture>) {
  return required(required(f.input.request.data.route).actual);
}
function fixture(native = false) {
  const source: AssetLocation = {
    kind: "wallet",
    accountId: account,
    locationId: "source",
    asset: RELAY_ROUTE_SPECS["base-usdc-to-hypercore-spot-usdc"].source,
    details: { address: sourceOwner, walletId: "source-wallet" },
  };
  const perps = hypercorePerpsRefundLocation({
    accountId: account,
    address: nativeOwner,
    controllerWalletId: "native-wallet",
  });
  const target = native ? perps : source;
  const raw = native ? "900000000" : "9000000";
  const chainId = native ? 1337 : 8453;
  const transaction = {
    txHash: hash,
    chainId,
    status: "success",
    timestamp: 1791990000,
    block: 123,
    data: native
      ? {
          hash,
          error: null,
          user: provider,
          action: {
            type: "sendAsset",
            hyperliquidChain: "Mainnet",
            destination: nativeOwner,
            sourceDex: "",
            destinationDex: "",
            token: `USDC:${perps.asset.assetId}`,
            amount: "9",
            fromSubAccount: "",
            nonce: 1791990000001,
          },
        }
      : null,
  };
  const input = {
    expected: {
      requestId: "offline-refund-exact-request",
      protocolOrderId: orderId,
      source,
      sourceAmount: { asset: source.asset, raw: "10000000" },
      refundLocations: [source, perps],
    },
    request: relayRequestEvidenceSchema.parse({
      id: "offline-refund-exact-request",
      status: "refund",
      sender: sourceOwner,
      recipient: nativeOwner,
      refundTo: sourceOwner,
      protocol: {
        orderId,
        settlement: {
          destination: { refunds: [{ chainId, transactionId: hash }] },
        },
      },
      data: {
        outTxs: [transaction],
        refundCurrencyData: {
          amount: raw,
          currency: {
            chainId,
            address: native
              ? "0x00000000000000000000000000000000"
              : source.asset.assetId,
            decimals: target.asset.decimals,
          },
        },
        route: {
          actual: {
            origin: {
              inputCurrency: {
                amount: "10000000",
                currency: {
                  chainId: 8453,
                  address: source.asset.assetId,
                  decimals: 6,
                },
              },
            },
            destination: {
              outputCurrency: {
                amount: "0",
                currency: {
                  chainId: 1337,
                  address: perps.asset.assetId,
                  decimals: 8,
                },
              },
            },
          },
        },
      },
    }),
    status: {
      requestId: "offline-refund-exact-request",
      status: "refund",
      txHashes: [hash],
    },
  };
  const evm: OwnedRouteCanonicalDestinationEvent = {
    networkId: source.asset.networkId,
    asset: source.asset,
    destinationAddress: sourceOwner,
    sourceAddress: provider,
    rawAmount: "9000000",
    transactionHash: hash,
    eventIndex: "7",
    ledgerHeight: "123",
    blockHash: `0x${"a".repeat(64)}`,
    observedAt: now,
  };
  const ledger = [
    {
      hash,
      time: 1791990000001,
      delta: {
        type: "send",
        user: provider,
        destination: nativeOwner,
        sourceDex: "",
        destinationDex: "",
        token: "USDC",
        amount: "9",
        usdcValue: "9",
        fee: "0",
        nativeTokenFee: "0",
        nonce: 1791990000001,
        feeToken: "USDC",
      },
    },
  ];
  return { input, target, evm, ledger };
}
function plan(f = fixture()) {
  const selected = selectRelayRefundReceiptPlan(f.input);
  assert.equal(selected.kind, "selected");
  return selected.plan;
}

test("refund status is not money; exact returned amount can be less than source", () => {
  const f = fixture();
  const selected = plan(f);
  assert.equal(selected.expectedReturned.raw, "9000000");
  assert.equal(
    verifyRelayRefundReceipts({ plan: selected, now }).kind,
    "unverified",
  );
  const result = verifyRelayRefundReceipts({
    plan: selected,
    now,
    evmEvents: [f.evm, f.evm],
  });
  assert.equal(result.kind, "verified");
  assert.equal(result.events.length, 1);
  assert.equal(result.receivedRaw, "9000000");
});

test("native fallback is exact recipient perps credit, never restored EVM source or spot capacity", () => {
  const f = fixture(true),
    selected = plan(f);
  assert.notEqual(
    f.input.expected.source.details.address,
    selected.target.details.address,
  );
  const result = verifyRelayRefundReceipts({
    plan: selected,
    nativeLedger: f.ledger,
    now,
  });
  assert.equal(result.kind, "verified");
  assert.equal(result.events[0].nativeEvidence?.destinationDex, "");
  assert.equal(result.events[0].rawAmount, "900000000");
  assert.equal(
    result.events[0].eventIndex,
    "hypercore:send:destination_credit",
  );
  assert.ok(!("spendable" in result));
  assert.ok(!("availableRaw" in result));
});

test("partial refund, replay, missing sibling and provider-pending are not full settlement", () => {
  const f = fixture();
  required(refundDestination(f).refunds).push({
    chainId: 8453,
    transactionId: otherHash,
  });
  required(f.input.request.data.outTxs).push({
    ...required(f.input.request.data.outTxs)[0],
    txHash: otherHash,
  });
  const selected = plan(f);
  const first = { ...f.evm, rawAmount: "4000000" };
  const partial = verifyRelayRefundReceipts({
    plan: selected,
    now,
    evmEvents: [first, first],
  });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.receivedRaw, "4000000");
  assert.equal(partial.events.length, 1);
  assert.equal(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [
        first,
        { ...f.evm, transactionHash: otherHash, rawAmount: "5000000" },
      ],
    }).kind,
    "verified",
  );
  assert.equal(
    verifyRelayRefundReceipts({ plan: selected, now, evmEvents: [f.evm] }).kind,
    "partial",
    "declared sum cannot substitute missing referenced receipt",
  );
  const pending = fixture();
  pending.input.status.status = "refund_in_progress";
  pending.input.request.status = "pending";
  assert.equal(
    verifyRelayRefundReceipts({
      plan: plan(pending),
      now,
      evmEvents: [pending.evm],
    }).kind,
    "partial",
  );
});

const changes: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    "request",
    (f) => {
      f.input.request.id = "wrong-request";
    },
  ],
  [
    "status identity",
    (f) => {
      f.input.status.requestId = "wrong-request";
    },
  ],
  [
    "order",
    (f) => {
      required(f.input.request.protocol).orderId = otherHash;
    },
  ],
  [
    "sender",
    (f) => {
      f.input.request.sender = nativeOwner;
    },
  ],
  [
    "source amount",
    (f) => {
      actualRoute(f).origin.inputCurrency.amount = "9999999";
    },
  ],
  [
    "source network",
    (f) => {
      actualRoute(f).origin.inputCurrency.currency.chainId = 137;
    },
  ],
  [
    "refund token",
    (f) => {
      required(f.input.request.data.refundCurrencyData).currency.address =
        sourceOwner;
    },
  ],
  [
    "refund precision",
    (f) => {
      required(f.input.request.data.refundCurrencyData).currency.decimals = 8;
    },
  ],
  [
    "over source",
    (f) => {
      required(f.input.request.data.refundCurrencyData).amount = "10000001";
    },
  ],
  [
    "zero/no-refund",
    (f) => {
      required(f.input.request.data.refundCurrencyData).amount = "0";
    },
  ],
  [
    "missing refund summary",
    (f) => {
      delete f.input.request.data.refundCurrencyData;
    },
  ],
  [
    "foreign account",
    (f) => {
      f.input.expected.refundLocations[0] = {
        ...f.target,
        accountId: "foreign",
      };
    },
  ],
  [
    "ambiguous target",
    (f) => {
      f.input.expected.refundLocations.push(f.target);
    },
  ],
  [
    "missing reference",
    (f) => {
      refundDestination(f).refunds = [];
    },
  ],
  [
    "wrong reference network",
    (f) => {
      required(refundDestination(f).refunds)[0].chainId = 137;
    },
  ],
  [
    "superseded",
    (f) => {
      f.input.request.supersededByRequestId = "new-request";
    },
  ],
  [
    "duplicate child",
    (f) => {
      f.input.request.duplicateDeposits = { parentRequestId: "parent-request" };
    },
  ],
  [
    "duplicate refund",
    (f) => {
      f.input.request.duplicateDeposits = {
        refundRequestIds: ["child-request"],
      };
    },
  ],
];
for (const [name, change] of changes)
  test(`refund binding rejects ${name}; subsequent correct poll recovers`, () => {
    const f = fixture();
    change(f);
    assert.equal(selectRelayRefundReceiptPlan(f.input).kind, "unverified");
    assert.equal(
      selectRelayRefundReceiptPlan(fixture().input).kind,
      "selected",
    );
  });

test("wrong receipt asset/owner/hash does not count; conflicting duplicate or excess is rejected", () => {
  const f = fixture(),
    selected = plan(f);
  for (const event of [
    { ...f.evm, destinationAddress: nativeOwner },
    { ...f.evm, transactionHash: otherHash },
    { ...f.evm, asset: { ...f.evm.asset, decimals: 8 } },
    { ...f.evm, networkId: "evm:137" },
  ])
    assert.equal(
      verifyRelayRefundReceipts({ plan: selected, now, evmEvents: [event] })
        .kind,
      "unverified",
    );
  assert.equal(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [f.evm, { ...f.evm, rawAmount: "1" }],
    }).kind,
    "unverified",
  );
  assert.equal(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [{ ...f.evm, rawAmount: "9000001" }],
    }).kind,
    "unverified",
  );
});

test("native refund needs matching ledger and DEX, neither provider success nor EVM-shaped event suffices", () => {
  const f = fixture(true),
    selected = plan(f);
  assert.equal(
    verifyRelayRefundReceipts({ plan: selected, now, evmEvents: [f.evm] }).kind,
    "unverified",
  );
  for (const mutate of [
    (v: typeof f.ledger) => {
      v[0].delta.destinationDex = "spot";
    },
    (v: typeof f.ledger) => {
      v[0].delta.amount = "8";
    },
    (v: typeof f.ledger) => {
      v[0].delta.fee = "0.01";
    },
  ]) {
    const ledger = structuredClone(f.ledger);
    mutate(ledger);
    assert.equal(
      verifyRelayRefundReceipts({ plan: selected, now, nativeLedger: ledger })
        .kind,
      "unverified",
    );
  }
  const wrongCurrency = fixture(true);
  required(
    wrongCurrency.input.request.data.refundCurrencyData,
  ).currency.address = wrongCurrency.target.asset.assetId;
  assert.equal(
    selectRelayRefundReceiptPlan(wrongCurrency.input).kind,
    "unverified",
  );
});

test("two native refund receipts retain a partial ledger and replay without double-counting", () => {
  const f = fixture(true);
  const original = required(f.input.request.data.outTxs)[0];
  const originalData = original.data as {
    hash: string;
    action: { amount: string; nonce: number };
  };
  const secondLedger = structuredClone(f.ledger[0]);
  f.ledger[0].delta.amount = "4";
  f.ledger[0].delta.usdcValue = "4";
  secondLedger.hash = otherHash;
  secondLedger.delta.amount = "5";
  secondLedger.delta.usdcValue = "5";
  secondLedger.delta.nonce++;
  secondLedger.time++;
  f.input.request.data.outTxs = [
    {
      ...original,
      data: {
        ...originalData,
        action: { ...originalData.action, amount: "4" },
      },
    },
    {
      ...original,
      txHash: otherHash,
      data: {
        ...originalData,
        hash: otherHash,
        action: {
          ...originalData.action,
          amount: "5",
          nonce: secondLedger.delta.nonce,
        },
      },
    },
  ];
  required(refundDestination(f).refunds).push({
    chainId: 1337,
    transactionId: otherHash,
  });
  const selected = plan(f);
  const partial = verifyRelayRefundReceipts({
    plan: selected,
    now,
    nativeLedger: f.ledger,
  });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.receivedRaw, "400000000");
  assert.equal(partial.events.length, 1);
  const complete = verifyRelayRefundReceipts({
    plan: selected,
    now,
    nativeLedger: [...f.ledger, secondLedger, ...f.ledger, secondLedger],
  });
  assert.equal(complete.kind, "verified");
  assert.equal(complete.receivedRaw, "900000000");
  assert.equal(complete.events.length, 2);
});

test("native spot outflow refunds into perps and a failed destination may be absent", () => {
  const f = fixture(true);
  f.input.expected.source = hypercoreSpotAccountLocation({
    accountId: account,
    address: nativeOwner,
    controllerWalletId: "native-wallet",
  }).location;
  f.input.expected.sourceAmount = {
    asset: f.input.expected.source.asset,
    raw: "1000000000",
  };
  f.input.expected.refundLocations = [f.target];
  f.input.request.sender = nativeOwner;
  actualRoute(f).origin.inputCurrency = {
    amount: "1000000000",
    currency: {
      chainId: 1337,
      address: f.input.expected.source.asset.assetId,
      decimals: 8,
    },
  };
  delete actualRoute(f).destination;
  f.input.request = relayRequestEvidenceSchema.parse(f.input.request);
  assert.equal(
    verifyRelayRefundReceipts({ plan: plan(f), now, nativeLedger: f.ledger })
      .kind,
    "verified",
  );
});

test("unrelated protocol presentation remains compatible without a refund order", () => {
  assert.doesNotThrow(() =>
    relayRequestEvidenceSchema.parse({
      id: "old-request",
      status: "pending",
      data: {},
      protocol: { orderId: null },
    }),
  );
  assert.doesNotThrow(() =>
    relayRequestEvidenceSchema.parse({
      id: "old-request",
      status: "pending",
      data: {},
      protocol: {},
    }),
  );
});

for (const native of [false, true])
  test(`${native ? "native" : "EVM"} missing provider sibling preserves exact partial, then recovers`, () => {
    const f = fixture(native);
    required(refundDestination(f).refunds).push({
      chainId: native ? 1337 : 8453,
      transactionId: otherHash,
    });
    const first = required(f.input.request.data.outTxs)[0];
    const ledger = structuredClone(f.ledger);
    ledger[0].delta.amount = "4";
    ledger[0].delta.usdcValue = "4";
    if (native) {
      const data = first.data as { action: { amount: string } };
      data.action.amount = "4";
    }
    const partial = verifyRelayRefundReceipts({
      plan: plan(f),
      now,
      nativeLedger: ledger,
      evmEvents: [{ ...f.evm, rawAmount: "4000000" }],
    });
    assert.equal(partial.kind, "partial");
    assert.equal(partial.events.length, 1);
    const second = structuredClone(first);
    second.txHash = otherHash;
    if (native) {
      const data = second.data as {
        hash: string;
        action: { amount: string; nonce: number };
      };
      data.hash = otherHash;
      data.action.amount = "5";
      data.action.nonce++;
    }
    required(f.input.request.data.outTxs).push(second);
    const secondLedger = {
      ...ledger[0],
      hash: otherHash,
      delta: {
        ...ledger[0].delta,
        amount: "5",
        usdcValue: "5",
        nonce: ledger[0].delta.nonce + 1,
      },
    };
    assert.equal(
      verifyRelayRefundReceipts({
        plan: plan(f),
        now,
        nativeLedger: [...ledger, secondLedger],
        evmEvents: [
          { ...f.evm, rawAmount: "4000000" },
          { ...f.evm, transactionHash: otherHash, rawAmount: "5000000" },
        ],
      }).kind,
      "verified",
    );
  });

for (const native of [false, true])
  test(`${native ? "native" : "EVM"} repeated transaction observations have semantic identity`, () => {
    const f = fixture(native);
    const original = required(f.input.request.data.outTxs)[0];
    const duplicate = structuredClone(original);
    duplicate.txHash = `0x${hash.slice(2).toUpperCase()}`;
    duplicate.timestamp++;
    duplicate.block = 124;
    if (native) {
      const data = duplicate.data as {
        hash: string;
        user: string;
        action: { destination: string; amount: string };
      };
      data.hash = duplicate.txHash;
      data.user = `0x${provider.slice(2).toUpperCase()}`;
      data.action.destination = `0x${nativeOwner.slice(2).toUpperCase()}`;
      data.action.amount = "9.00000000";
    }
    required(f.input.request.data.outTxs).push(duplicate);
    const selected = plan(f);
    assert.equal(selected.transactions.length, 1);
    if (native)
      assert.deepEqual(selected.ledgerSeconds, [
        original.timestamp,
        duplicate.timestamp,
      ]);
    assert.equal(
      verifyRelayRefundReceipts({
        plan: selected,
        now,
        nativeLedger: f.ledger,
        evmEvents: [f.evm],
      }).kind,
      "verified",
    );
    if (native) {
      (duplicate.data as { action: { amount: string } }).action.amount = "8";
      assert.equal(selectRelayRefundReceiptPlan(f.input).kind, "unverified");
    }
  });

test("32-byte order zero cannot substitute the 16-byte Relay perps selector", () => {
  const f = fixture(true);
  required(f.input.request.data.refundCurrencyData).currency.address =
    `0x${"0".repeat(64)}`;
  assert.equal(selectRelayRefundReceiptPlan(f.input).kind, "unverified");
});

test("malformed refund projection cannot become proof even when the base request is readable", () => {
  const f = fixture();
  f.input.request = relayRequestEvidenceSchema.parse({
    ...f.input.request,
    protocol: { orderId, settlement: null },
  });
  assert.equal(f.input.request.refundProjectionInvalid, true);
  assert.deepEqual(selectRelayRefundReceiptPlan(f.input), {
    kind: "unverified",
    reason: "refund_request_fields_invalid",
  });
});
