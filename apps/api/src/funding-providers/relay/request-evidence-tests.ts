import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Pool } from "pg";
import { observeRelayHypercoreDestinationReceipts } from "./hypercore-destination-observer.js";
import { RelayClient, RelayClientError } from "./client.js";
import {
  relayRequestEvidenceSchema,
  parseRelayRequestEvidence,
} from "./request-evidence.js";
import { verifyRelayHypercoreRequest } from "./hypercore-request-evidence.js";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";

const requestId = "fixture-exact-request";
function required<T>(value: T | null | undefined): T {
  assert.ok(value != null, "required fixture field");
  return value;
}
const minimal = { id: requestId, status: "pending", data: {} };

test("Requests v3 uses exact ID, no child search/private data, and strips unrelated fields", async () => {
  let calls = 0;
  const client = new RelayClient({
    apiKey: "fixture-key",
    fetchImpl: async (url, init) => {
      calls++;
      const request = new URL(url);
      assert.equal(request.origin, "https://api.relay.link");
      assert.equal(request.pathname, "/requests/v3");
      assert.deepEqual(Object.fromEntries(request.searchParams), {
        id: requestId,
        limit: "1",
        includeChildRequests: "false",
        includeAuthenticatedData: "false",
        includeTotal: "false",
      });
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      return Response.json({
        requests: [{ ...minimal, privateField: "not-retained" }],
      });
    },
  });
  const pair = await Promise.all([
    client.requestEvidence(requestId),
    client.requestEvidence(requestId),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(pair, [minimal, minimal]);
  await client.requestEvidence(requestId);
  assert.equal(calls, 2, "completed observations are not a stale cache");
  await assert.rejects(client.requestEvidence(`${requestId},another-id`));
  assert.equal(calls, 2, "ambiguous scope is rejected before provider call");
});

test("exact request lookup rejects identity/shape/truncation and recovers on the next poll", async () => {
  const invalidPages = [
    { requests: [{ ...minimal, id: "a-different-request" }] },
    { requests: [minimal, minimal] },
    { requests: [minimal], continuation: "more" },
    { requests: [{ ...minimal, data: null }] },
    { requests: [minimal], continuation: 1 },
  ];
  for (const page of invalidPages) {
    let response: unknown = page;
    const client = new RelayClient({
      apiKey: "fixture",
      fetchImpl: async () => Response.json(response),
    });
    await assert.rejects(
      client.requestEvidence(requestId),
      (error: unknown) =>
        error instanceof RelayClientError &&
        error.code === "invalid_response" &&
        error.retryable,
    );
    response = { requests: [minimal] };
    assert.deepEqual(await client.requestEvidence(requestId), minimal);
  }
  assert.equal(parseRelayRequestEvidence({ requests: [] }, requestId), null);
});

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/hip4/relay-receipts-20261012.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
// Selected, redacted P0 facts reconstructed into the documented v3 envelope.
// No claim that this synthetic envelope is an unmodified provider response.
function example(index = 0) {
  const route = structuredClone(captured.routes[index]);
  assert.equal(route.checks.nativeActionHashAgrees, true);
  assert.equal(route.checks.nativeActionNoError, true);
  const native = {
    ...route.nativeTx,
    data: {
      hash: route.nativeTx.txHash,
      error: null,
      user: route.nativeActionUser,
      action: route.nativeAction,
    },
  };
  return {
    expected: {
      requestId: route.requestId,
      asset: { ...HYPERCORE_MAINNET_USDC },
      owner: route.owner,
      dex: (route.incoming
        ? route.nativeAction.destinationDex
        : route.nativeAction.sourceDex) as "spot" | "",
      direction: route.incoming ? ("credit" as const) : ("debit" as const),
    },
    request: relayRequestEvidenceSchema.parse({
      id: route.requestId,
      status: route.status,
      sender: route.incoming ? route.baseOwner : route.owner,
      recipient: route.incoming ? route.owner : route.baseOwner,
      data: {
        inTxs: route.incoming ? [] : [native],
        outTxs: route.incoming ? [native] : [],
        route: {
          actual: {
            origin: { inputCurrency: route.routeActual.origin },
            destination: { outputCurrency: route.routeActual.destination },
          },
        },
      },
    }),
    status: route.relayStatus,
    ledger: route.nativeLedger.matches,
  };
}

function observerFixture() {
  const proof = example(0);
  let admissions = 0;
  let admitted = true;
  let evidenceCalls = 0;
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes("from runtime_policies"))
        return {
          rows:
            values[0] === "hip4_read"
              ? [
                  {
                    id: "test-policy",
                    payload: { environment: "testnet", enabled: false },
                  },
                ]
              : [],
        };
      assert.ok(sql.includes("insert into hip4_request_budget"));
      admissions++;
      return { rowCount: admitted ? 1 : 0, rows: [] };
    },
  } as unknown as Pool;
  const input = {
    asset: proof.expected.asset,
    destinationAddress: proof.expected.owner,
    transactionHashes: proof.status.txHashes,
    now: new Date(),
    native: {
      requestId: proof.expected.requestId,
      status: proof.status,
      dex: proof.expected.dex,
      knownTransactionHashes: [] as string[],
    },
  };
  const relay = {
    requestEvidence: async () => {
      evidenceCalls++;
      return proof.request;
    },
  };
  return {
    proof,
    pool,
    input,
    relay,
    admissions: () => admissions,
    evidenceCalls: () => evidenceCalls,
    admit: (value: boolean) => {
      admitted = value;
    },
  };
}

test("refund-only schema drift cannot block ordinary canonical native credit", async () => {
  const proof = example(0);
  for (const extras of [
    { protocol: { settlement: null } },
    { protocol: { settlement: { destination: null } } },
    { protocol: { settlement: { destination: { refunds: null } } } },
    { refundTo: "" },
    { duplicateDeposits: { refundRequestIds: null } },
    { data: { ...proof.request.data, refundCurrencyData: {} } },
  ]) {
    const client = new RelayClient({
      apiKey: "offline-fixture",
      fetchImpl: async () =>
        Response.json({ requests: [{ ...proof.request, ...extras }] }),
    });
    const request = required(
      await client.requestEvidence(proof.expected.requestId),
    );
    assert.equal(request.refundProjectionInvalid, true);
    assert.equal(
      verifyRelayHypercoreRequest({ ...proof, request }).kind,
      "verified",
    );
  }
});

test("native observer stays on frozen mainnet and exact second despite disabled/testnet read policy", async () => {
  const fixture = observerFixture();
  const output = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    async (url, init) => {
      assert.equal(url, "https://api.hyperliquid.xyz/info");
      const timestamp = required(
        required(fixture.proof.request.data.outTxs)[0],
      ).timestamp;
      assert.deepEqual(JSON.parse(required(init).body as string), {
        type: "userNonFundingLedgerUpdates",
        user: fixture.input.destinationAddress.toLowerCase(),
        startTime: timestamp * 1000,
        endTime: timestamp * 1000 + 999,
      });
      return Response.json(fixture.proof.ledger);
    },
  );
  assert.equal(output.pendingReason, null);
  assert.equal(output.events.length, 1);
  assert.equal(fixture.admissions(), 1);
  fixture.input.native.knownTransactionHashes = fixture.input.transactionHashes;
  const replay = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    async () => {
      throw new Error("unexpected provider read");
    },
  );
  assert.deepEqual(replay, { events: [], pendingReason: null });
  assert.equal(fixture.admissions(), 1);
  assert.equal(fixture.evidenceCalls(), 1);
});

test("native observer rejects wrong request/owner/chain before native account lookup", async () => {
  for (const mutation of ["request", "owner", "chain"] as const) {
    const fixture = observerFixture();
    if (mutation === "request") fixture.proof.request.id = "wrong";
    if (mutation === "owner")
      fixture.proof.request.recipient = `0x${"1".repeat(40)}`;
    if (mutation === "chain")
      fixture.input.native.status.destinationChainId = 8453;
    const output = await observeRelayHypercoreDestinationReceipts(
      fixture.pool,
      fixture.relay,
      fixture.input,
      async () => {
        throw new Error("unexpected account read");
      },
    );
    assert.equal(output.events.length, 0);
    assert.match(required(output.pendingReason), /mismatch/u);
    assert.equal(fixture.admissions(), 0);
  }
});

test("native observation retries missing/budget/transport failures without treating provider success as money", async () => {
  const fixture = observerFixture();
  const missing = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    async () => Response.json([]),
  );
  assert.deepEqual(missing, {
    events: [],
    pendingReason: "native_ledger_missing",
    ledgerAfterSecond: required(required(fixture.proof.request.data.outTxs)[0])
      .timestamp,
  });
  fixture.admit(false);
  const exhausted = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    async () => {
      throw new Error("must not call when budget denied");
    },
  );
  assert.deepEqual(exhausted, {
    events: [],
    pendingReason: "native_ledger_budget_exhausted",
  });
  fixture.admit(true);
  for (const [fetcher, reason] of [
    [
      async () => new Response("private transport detail", { status: 500 }),
      "native_ledger_http_error",
    ],
    [async () => Response.json({ malformed: true }), "native_ledger_invalid"],
    [
      async () => {
        throw new Error("secret URL");
      },
      "native_ledger_transport_error",
    ],
    [
      async () => {
        throw new DOMException("secret URL", "TimeoutError");
      },
      "native_ledger_timeout",
    ],
  ] as const) {
    const output = await observeRelayHypercoreDestinationReceipts(
      fixture.pool,
      fixture.relay,
      fixture.input,
      fetcher,
    );
    assert.deepEqual(output, {
      events: [],
      pendingReason: reason,
      ledgerAfterSecond: required(
        required(fixture.proof.request.data.outTxs)[0],
      ).timestamp,
    });
  }
  const recovered = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    async () => Response.json(fixture.proof.ledger),
  );
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.pendingReason, null);
});

test("missing first receipt cannot starve a later credit under a one-read budget", async () => {
  const fixture = observerFixture();
  const first = required(required(fixture.proof.request.data.outTxs)[0]);
  const second = structuredClone(first);
  const amount =
    BigInt(
      required(
        required(required(fixture.proof.request.data.route).actual).destination,
      ).outputCurrency.amount,
    ) - 100000000n;
  const decimal = amount.toString().padStart(9, "0");
  (first.data as { action: { amount: string } }).action.amount = "1";
  const secondData = second.data as {
    hash: string;
    action: { amount: string; nonce: number };
  };
  second.txHash = secondData.hash = `0x${"f".repeat(64)}`;
  second.timestamp++;
  secondData.action.nonce++;
  secondData.action.amount = `${decimal.slice(0, -8)}.${decimal.slice(-8)}`;
  const secondLedger = structuredClone(fixture.proof.ledger[0]);
  secondLedger.hash = second.txHash;
  secondLedger.time = second.timestamp * 1000;
  secondLedger.delta.amount = secondData.action.amount;
  secondLedger.delta.nonce = secondData.action.nonce;
  required(fixture.proof.request.data.outTxs).push(second);
  fixture.proof.status.txHashes.push(second.txHash);
  const reads: number[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const start = JSON.parse(required(init).body as string).startTime;
    reads.push(start);
    fixture.admit(false);
    return Response.json(
      start === second.timestamp * 1000 ? [secondLedger] : [],
    );
  };
  const firstPoll = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    fetcher,
  );
  assert.equal(firstPoll.events.length, 0);
  assert.equal(firstPoll.ledgerAfterSecond, first.timestamp);
  fixture.admit(true);
  const secondPoll = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    {
      ...fixture.input,
      native: {
        ...fixture.input.native,
        ledgerAfterSecond: firstPoll.ledgerAfterSecond,
      },
    },
    fetcher,
  );
  assert.equal(secondPoll.events.length, 1);
  assert.equal(required(secondPoll.events[0]).transactionHash, second.txHash);
  assert.equal(required(secondPoll.events[0]).rawAmount, amount.toString());
  assert.equal(secondPoll.ledgerAfterSecond, second.timestamp);
  assert.deepEqual(reads, [first.timestamp * 1000, second.timestamp * 1000]);
  second.timestamp = Number.MAX_SAFE_INTEGER;
  fixture.proof.ledger[0].delta.amount = "1";
  fixture.admit(true);
  const invalidTail = await observeRelayHypercoreDestinationReceipts(
    fixture.pool,
    fixture.relay,
    fixture.input,
    async () => Response.json(fixture.proof.ledger),
  );
  assert.equal(
    invalidTail.events.length,
    1,
    "invalid later timestamp must not discard proven earlier credit",
  );
  assert.equal(required(invalidTail.events[0]).transactionHash, first.txHash);
  assert.equal(invalidTail.pendingReason, "native_timestamp_invalid");
});

for (let i = 0; i < 4; i++) {
  test(`request and status bind exact native economic leg: ${captured.routes[i].name}`, () => {
    const input = example(i);
    const result = verifyRelayHypercoreRequest(input);
    assert.equal(result.kind, "verified");
    if (result.kind === "verified") assert.equal(result.transfers.length, 1);
    const original = result;
    const transactions =
      input.expected.direction === "credit"
        ? required(input.request.data.outTxs)
        : required(input.request.data.inTxs);
    transactions.push(structuredClone(required(transactions[0])));
    assert.deepEqual(
      verifyRelayHypercoreRequest(input),
      original,
      "replayed provider row never doubles credited amount",
    );
  });
}

test("one missing native ledger leg does not discard an already-proven transfer", () => {
  const input = example(0);
  const first = required(required(input.request.data.outTxs)[0]);
  const second = structuredClone(first);
  // Synthetic split of the captured route's total, with two distinct hashes.
  const total = BigInt(
    required(required(required(input.request.data.route).actual).destination)
      .outputCurrency.amount,
  );
  const remaining = (total - 100000000n).toString().padStart(9, "0");
  const firstData = first.data as { action: { amount: string; nonce: number } };
  const secondData = second.data as {
    hash: string;
    action: { amount: string; nonce: number };
  };
  firstData.action.amount = "1";
  input.ledger[0].delta.amount = "1";
  second.txHash = secondData.hash = `0x${"f".repeat(64)}`;
  secondData.action.amount = `${remaining.slice(0, -8)}.${remaining.slice(-8)}`;
  secondData.action.nonce++;
  required(input.request.data.outTxs).push(second);
  input.status.txHashes.push(second.txHash);
  const partial = verifyRelayHypercoreRequest(input);
  assert.equal(partial.kind, "partial");
  if (partial.kind !== "partial") return;
  assert.equal(partial.reason, "native_ledger_missing");
  assert.deepEqual(
    partial.transfers.map((row) => row.rawAmount),
    ["100000000"],
  );
  const secondLedger = structuredClone(input.ledger[0]);
  secondLedger.hash = second.txHash;
  secondLedger.delta.nonce = secondData.action.nonce;
  secondLedger.delta.amount = secondData.action.amount;
  input.ledger.push(secondLedger);
  const complete = verifyRelayHypercoreRequest(input);
  assert.equal(complete.kind, "verified");
  if (complete.kind === "verified") {
    assert.equal(complete.transfers.length, 2);
    assert.equal(
      complete.transfers.reduce((sum, row) => sum + BigInt(row.rawAmount), 0n),
      total,
    );
    assert.deepEqual(complete.transfers[0], partial.transfers[0]);
  }
});

test("semantic replay folds hash case and decimal formatting, but not a different amount or nonce", () => {
  for (const mutation of [
    "case",
    "decimal",
    "corroboration",
    "nonce",
    "amount",
  ] as const) {
    const input = example(1);
    const original = verifyRelayHypercoreRequest(input);
    const copy = structuredClone(
      required(required(input.request.data.outTxs)[0]),
    );
    const data = copy.data as {
      hash: string;
      action: { amount: string; nonce: number };
    };
    if (mutation === "case") {
      copy.txHash = `0x${copy.txHash.slice(2).toUpperCase()}`;
      data.hash = copy.txHash;
    } else if (mutation === "decimal") data.action.amount += "00";
    else if (mutation === "corroboration") {
      copy.timestamp++;
      copy.block = required(copy.block) + 1;
    } else if (mutation === "nonce") data.action.nonce++;
    else data.action.amount = "1";
    required(input.request.data.outTxs).push(copy);
    const result = verifyRelayHypercoreRequest(input);
    if (mutation === "nonce" || mutation === "amount")
      assert.equal(result.kind, "unverified");
    else assert.deepEqual(result, original);
  }
});

const mutations: [string, (input: ReturnType<typeof example>) => void][] = [
  [
    "status chain",
    (input) => {
      input.status.originChainId = 8453;
      input.status.destinationChainId = 8453;
    },
  ],
  [
    "request ID",
    (input) => {
      input.request.id = "different";
    },
  ],
  [
    "status ID",
    (input) => {
      input.status.requestId = "different";
    },
  ],
  [
    "opposite status leg",
    (input) => {
      const original = input.status.txHashes;
      input.status.txHashes = input.status.inTxHashes;
      input.status.inTxHashes = original;
    },
  ],
  [
    "request owner",
    (input) => {
      input.request.sender = input.request.recipient = `0x${"f".repeat(40)}`;
    },
  ],
  [
    "asset environment",
    (input) => {
      input.expected.asset.networkId = "hyperliquid:testnet";
    },
  ],
  [
    "ledger direction",
    (input) => {
      input.ledger[0].delta.destination = `0x${"f".repeat(40)}`;
    },
  ],
  [
    "missing actual route",
    (input) => {
      input.request.data.route = undefined;
    },
  ],
  [
    "wrong actual amount",
    (input) => {
      required(
        required(input.request.data.route).actual,
      ).origin.inputCurrency.amount = "1";
      required(
        required(required(input.request.data.route).actual).destination,
      ).outputCurrency.amount = "1";
    },
  ],
  [
    "wrong actual precision",
    (input) => {
      required(
        required(input.request.data.route).actual,
      ).origin.inputCurrency.currency.decimals = 6;
      required(
        required(required(input.request.data.route).actual).destination,
      ).outputCurrency.currency.decimals = 6;
    },
  ],
  [
    "wrong balance class",
    (input) => {
      input.expected.dex = input.expected.dex === "spot" ? "" : "spot";
    },
  ],
];
for (let i = 0; i < 4; i++) {
  for (const [label, mutate] of mutations) {
    test(`native request rejects ${label}: ${captured.routes[i].name}`, () => {
      const input = example(i);
      mutate(input);
      assert.equal(verifyRelayHypercoreRequest(input).kind, "unverified");
    });
  }
}
