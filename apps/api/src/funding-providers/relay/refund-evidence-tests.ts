import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssetLocation } from "../../funding/domain/types.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../funding/reconciliation/owned-route-destination-observer.js";
import {
  hypercorePerpsRefundLocation,
  hypercoreSpotAccountLocation,
} from "../../account-value/canonical.js";
import { RELAY_ROUTE_SPECS } from "./mappings.js";
import {
  RELAY_REQUEST_TRANSACTION_LIMIT,
  relayRequestEvidenceSchema,
} from "./request-evidence.js";
import {
  selectRelayRefundReceiptPlan,
  verifyRelayRefundReceipts,
} from "./refund-evidence.js";
import {
  readRelayExactRefundEvidence,
  observeRelayExactRefundEvidence,
} from "./exact-refund-observer.js";
import { FundingEvidenceBudgetExpiredError } from "../../funding/reconciliation/funding-evidence-budget.js";
import type { Pool } from "pg";

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
function fixture(
  native = false,
  sourceAsset = RELAY_ROUTE_SPECS["base-usdc-to-hypercore-spot-usdc"].source,
) {
  const source: AssetLocation = {
    kind: "wallet",
    accountId: account,
    locationId: "source",
    asset: sourceAsset,
    details: { address: sourceOwner, walletId: "source-wallet" },
  };
  const perps = hypercorePerpsRefundLocation({
    accountId: account,
    address: nativeOwner,
    controllerWalletId: "native-wallet",
  });
  const target = native ? perps : source;
  const raw = native ? "900000000" : "9000000";
  const sourceChainId = Number(source.asset.networkId.slice(4));
  const chainId = native ? 1337 : sourceChainId;
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
                  chainId: sourceChainId,
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

test("native DB-budget denial preserves the last read second; next job starts with the unread second", async () => {
  for (const failure of [
    new FundingEvidenceBudgetExpiredError(),
    Object.assign(new Error("offline timeout"), { code: "57014" }),
    Object.assign(new Error("offline lock timeout"), { code: "55P03" }),
  ]) {
    const f = fixture(true);
    const transaction = structuredClone(
      required(f.input.request.data.outTxs)[0],
    );
    transaction.txHash = otherHash;
    transaction.timestamp++;
    (transaction.data as { hash: string }).hash = otherHash;
    required(f.input.request.data.outTxs).push(transaction);
    required(refundDestination(f).refunds).push({
      chainId: 1337,
      transactionId: otherHash,
    });
    let admissions = 0;
    const query = async (sql: string) => {
      if (sql.includes("from runtime_policies")) return { rows: [] };
      if (sql.includes("insert into hip4_request_budget")) {
        admissions++;
        if (admissions === 2) throw failure;
        return { rows: [], rowCount: 1 };
      }
      assert.ok(
        sql === "begin" ||
          sql === "commit" ||
          sql === "rollback" ||
          sql.includes("set_config"),
      );
      return { rows: [] };
    };
    const pool = {
      query,
      connect: async () => ({ query, release() {} }),
    } as unknown as Pool;
    const visited: number[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      visited.push(request.startTime / 1000);
      return Response.json([]);
    };
    const relay = { requestEvidence: async () => f.input.request };
    const first = await observeRelayExactRefundEvidence(
      pool,
      relay,
      { ...f.input, now, deadlineMs: Date.now() + 60_000 },
      fetcher,
    );
    assert.equal(first.kind, "observed");
    assert.ok("ledgerAfterSecond" in first);
    assert.equal(first.reason, "native_ledger_budget_exhausted");
    assert.equal(first.ledgerAfterSecond, transaction.timestamp - 1);
    const retry = await observeRelayExactRefundEvidence(
      pool,
      relay,
      {
        ...f.input,
        now,
        ledgerAfterSecond: first.ledgerAfterSecond,
        deadlineMs: Date.now() + 60_000,
      },
      fetcher,
    );
    assert.equal(retry.kind, "observed");
    assert.equal(retry.reason, null);
    assert.equal(
      visited[1],
      transaction.timestamp,
      "denied second gets the first next-job transport",
    );
  }
});

test("exact evidence applies one read deadline to Relay and stops sibling EVM/native reads with resumable partial facts", async (t) => {
  let time = 1000;
  t.mock.method(Date, "now", () => time);
  for (const native of [false, true]) {
    time = 1000;
    const f = fixture(native);
    const transaction = structuredClone(
      required(f.input.request.data.outTxs)[0],
    );
    transaction.txHash = otherHash;
    transaction.timestamp++;
    if (native) (transaction.data as { hash: string }).hash = otherHash;
    required(f.input.request.data.outTxs).push(transaction);
    required(refundDestination(f).refunds).push({
      chainId: native ? 1337 : 8453,
      transactionId: otherHash,
    });
    let relayCalls = 0;
    let receiptCalls = 0;
    const dependencies = {
      requestEvidence: async (
        _id: string,
        options?: { deadlineMs: number },
      ) => {
        relayCalls++;
        assert.deepEqual(options, { deadlineMs: 1100 });
        return f.input.request;
      },
      readEvm: async () => {
        receiptCalls++;
        time = 1100;
        return [f.evm];
      },
      readNativeLedger: async () => {
        receiptCalls++;
        time = 1100;
        return f.ledger;
      },
    };
    const result = await readRelayExactRefundEvidence(
      { ...f.input, now, deadlineMs: 1100 },
      dependencies,
    );
    assert.equal(result.kind, "observed");
    assert.equal(relayCalls, 1);
    assert.equal(
      receiptCalls,
      1,
      "no subsequent receipt transport after absolute deadline",
    );
    if (result.kind === "observed") {
      assert.equal(
        native ? result.nativeLedger.length : result.evmEvents.length,
        1,
      );
      assert.equal(
        result.reason,
        native ? "native_ledger_deadline" : "refund_work_deadline",
      );
      if (native) {
        assert.ok("ledgerAfterSecond" in result);
        assert.equal(result.ledgerAfterSecond, transaction.timestamp - 1);
      }
    }
    assert.deepEqual(
      await readRelayExactRefundEvidence(
        { ...f.input, now, deadlineMs: 1100 },
        dependencies,
      ),
      { kind: "pending", reason: "refund_work_deadline" },
    );
    assert.equal(
      relayCalls,
      1,
      "already expired work does not even read Relay",
    );
  }
});

test("registered Polygon pUSD refunds keep exact source token and either committed EVM or native target", () => {
  for (const native of [false, true]) {
    const f = fixture(
      native,
      RELAY_ROUTE_SPECS["polygon-pusd-to-hypercore-spot-usdc"].source,
    );
    const selected = plan(f);
    const result = verifyRelayRefundReceipts({
      plan: selected,
      now,
      ...(native ? { nativeLedger: f.ledger } : { evmEvents: [f.evm] }),
    });
    assert.equal(result.kind, "verified");
    assert.deepEqual(result.events[0].asset, f.target.asset);
    actualRoute(f).origin.inputCurrency.currency.address =
      RELAY_ROUTE_SPECS["polygon-usdc-to-hypercore-spot-usdc"].source.assetId;
    assert.deepEqual(selectRelayRefundReceiptPlan(f.input), {
      kind: "unverified",
      reason: "refund_source_binding_mismatch",
    });
  }
});

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

test("explicit EVM refund recipient cannot be replaced by a coincident transfer to the source owner", () => {
  const f = fixture();
  f.input.request.refundTo = nativeOwner;
  assert.deepEqual(selectRelayRefundReceiptPlan(f.input), {
    kind: "unverified",
    reason: "refund_explicit_recipient_mismatch",
  });
  for (const refundTo of [
    sourceOwner.toUpperCase().replace("0X", "0x"),
    null,
    undefined,
  ]) {
    f.input.request.refundTo = refundTo;
    assert.equal(selectRelayRefundReceiptPlan(f.input).kind, "selected");
  }
  // A destination recipient is not a refund address, and a native fallback
  // does not rewrite the original EVM refundTo into the different native owner.
  assert.notEqual(f.input.request.recipient, sourceOwner);
  const native = fixture(true);
  assert.notEqual(native.input.request.refundTo, native.target.details.address);
  assert.equal(selectRelayRefundReceiptPlan(native.input).kind, "selected");
});

test("same-transaction partial returns cannot be summed across orders; distinct owners remain independent", () => {
  const f = fixture();
  const selected = plan(f);
  const partial = { ...f.evm, rawAmount: "4000000" };
  const otherReturn = { ...f.evm, eventIndex: "8", rawAmount: "5000000" };
  assert.deepEqual(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [partial, otherReturn],
    }),
    {
      kind: "unverified",
      reason: "refund_shared_transaction_requires_attribution",
    },
  );
  const independent = verifyRelayRefundReceipts({
    plan: selected,
    now,
    evmEvents: [
      f.evm,
      f.evm,
      { ...otherReturn, destinationAddress: nativeOwner },
    ],
  });
  assert.equal(independent.kind, "verified");
  assert.equal(independent.events.length, 1);
  assert.equal(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [partial],
    }).kind,
    "partial",
  );
  assert.equal(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [f.evm],
    }).kind,
    "verified",
    "a different, unambiguous input remains supported; this does not repair shared-log attribution",
  );
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

test("same physical refund cannot discard a changed anchor while deduplicating current and stored proof", () => {
  const f = fixture(),
    selected = plan(f);
  for (const changed of [
    { ...f.evm, ledgerHeight: "124" },
    { ...f.evm, blockHash: `0x${"b".repeat(64)}` },
  ])
    for (const evmEvents of [
      [f.evm, changed],
      [changed, f.evm],
    ])
      assert.deepEqual(
        verifyRelayRefundReceipts({ plan: selected, now, evmEvents }),
        {
          kind: "unverified",
          reason: "refund_receipt_conflict",
        },
      );
  assert.equal(
    verifyRelayRefundReceipts({
      plan: selected,
      now,
      evmEvents: [f.evm, { ...f.evm, observedAt: new Date(now.getTime() + 1) }],
    }).kind,
    "verified",
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
      v[0].delta.destination = sourceOwner;
    },
    (v: typeof f.ledger) => {
      v[0].delta.fee = "-0.01";
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

test("exact incoming native refund preserves nonzero fee provenance without changing returned money", () => {
  const f = fixture(true),
    selected = plan(f);
  for (const feeObservation of [
    { fee: "1.0", nativeTokenFee: "0.0", feeToken: "" },
    { fee: "1.0", nativeTokenFee: "0.0000000001", feeToken: "" },
    { fee: "1.0", nativeTokenFee: "0.01", feeToken: "HYPE" },
  ]) {
    const ledger = structuredClone(f.ledger);
    Object.assign(ledger[0].delta, feeObservation);
    const result = verifyRelayRefundReceipts({
      plan: selected,
      now,
      nativeLedger: ledger,
    });
    assert.equal(result.kind, "verified");
    assert.equal(result.receivedRaw, "900000000");
    assert.equal(result.events.length, 1);
    const event = required(result.events[0]);
    assert.equal(event.rawAmount, "900000000");
    assert.equal(event.eventIndex, "hypercore:send:destination_credit");
    assert.deepEqual(event.nativeEvidence?.feeObservation, feeObservation);
    assert.deepEqual(
      verifyRelayRefundReceipts({
        plan: selected,
        now,
        nativeLedger: [...ledger, ...structuredClone(ledger)],
      }),
      result,
      "replayed fee-bearing receipt does not double-count the native refund",
    );
    for (const raw of ["800000000", "1000000000"])
      assert.deepEqual(
        verifyRelayRefundReceipts({
          plan: {
            ...selected,
            expectedReturned: { ...selected.expectedReturned, raw },
          },
          now,
          nativeLedger: ledger,
        }),
        { kind: "unverified", reason: "refund_native_total_mismatch" },
        "neither a second fee subtraction nor fee addition proves the returned amount",
      );
  }
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

test("current refund manifest is bounded even for an internal typed caller", () => {
  const f = fixture();
  const destination = required(
    required(required(f.input.request.protocol).settlement).destination,
  );
  const reference = required(destination.refunds)[0];
  destination.refunds = Array.from(
    { length: RELAY_REQUEST_TRANSACTION_LIMIT },
    () => reference,
  );
  assert.equal(selectRelayRefundReceiptPlan(f.input).kind, "selected");
  destination.refunds.push(reference);
  assert.deepEqual(selectRelayRefundReceiptPlan(f.input), {
    kind: "unverified",
    reason: "refund_reference_manifest_too_large",
  });
});
