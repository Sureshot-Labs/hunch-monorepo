import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayClient, RelayClientError } from "./client.js";
import {
  parseRelayRefundRequestPage,
  type RelayRefundTransactionLookup,
} from "./request-evidence.js";

const hash = `0x${"ab".repeat(32)}`;
const lookup: RelayRefundTransactionLookup = {
  transactionHash: hash,
  chainId: 8453,
  limit: 2,
};
const row = {
  id: "refund-request-fixture",
  status: "pending",
  data: {},
  protocol: {
    orderId: `0x${"cd".repeat(32)}`,
    settlement: {
      destination: { refunds: [{ chainId: 8453, transactionId: hash }] },
    },
  },
};

test("reverse lookup is one exact refund hash, coalesces in-flight reads, preserves opaque continuation", async () => {
  const urls: URL[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    urls.push(new URL(url));
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    return Response.json({
      requests: [{ ...row, privateField: "discarded" }],
      continuation: "next+/=&",
    });
  };
  const client = new RelayClient({ apiKey: "fixture", fetchImpl });
  const secondClient = new RelayClient({ apiKey: "fixture", fetchImpl });
  const [first, same] = await Promise.all([
    client.refundRequestsByTransaction(lookup),
    secondClient.refundRequestsByTransaction({
      ...lookup,
      transactionHash: hash.toUpperCase().replace("0X", "0x"),
    }),
  ]);
  assert.equal(urls.length, 1);
  assert.deepEqual(first, same);
  assert.deepEqual(first.requests, [row]);
  assert.equal(first.continuation, "next+/=&");
  assert.deepEqual(Object.fromEntries(urls[0].searchParams), {
    refundTxHash: hash,
    limit: "2",
    includeChildRequests: "false",
    includeAuthenticatedData: "false",
    includeTotal: "false",
  });
  await client.refundRequestsByTransaction({
    ...lookup,
    continuation: "prior+/=&",
  });
  assert.equal(urls[1].searchParams.get("continuation"), "prior+/=&");
  await client.refundRequestsByTransaction(lookup);
  assert.equal(urls.length, 3, "finished reads are not cached");
});

test("reverse request parser rejects wrong chain/hash/role, ambiguous rows and malformed relevant projection", () => {
  const pages: unknown[] = [
    { requests: [row, row] },
    { requests: [row, { ...row, id: "second" }, { ...row, id: "third" }] },
    {
      requests: [
        { ...row, protocol: { ...row.protocol, orderId: "not-an-order" } },
      ],
    },
    {
      requests: [
        {
          ...row,
          protocol: {
            ...row.protocol,
            settlement: { destination: { refunds: null } },
          },
        },
      ],
    },
    {
      requests: [
        {
          ...row,
          protocol: {
            ...row.protocol,
            settlement: {
              destination: { refunds: [{ chainId: 137, transactionId: hash }] },
            },
          },
        },
      ],
    },
    {
      requests: [
        {
          ...row,
          protocol: {
            ...row.protocol,
            settlement: {
              destination: {
                refunds: [
                  { chainId: 8453, transactionId: `0x${"1".repeat(64)}` },
                ],
              },
            },
          },
        },
      ],
    },
    {
      requests: [
        {
          ...row,
          protocol: { orderId: row.protocol.orderId },
          data: {
            outTxs: [
              {
                chainId: 8453,
                txHash: hash,
                status: "success",
                timestamp: 1,
                data: null,
              },
            ],
          },
        },
      ],
    },
    { requests: [row], continuation: 12 },
    { requests: [row], continuation: "x".repeat(8193) },
  ];
  for (const page of pages)
    assert.throws(() => parseRelayRefundRequestPage(page, lookup));
  assert.throws(() =>
    parseRelayRefundRequestPage(
      { requests: [row], continuation: "same" },
      { ...lookup, continuation: "same" },
    ),
  );
  assert.deepEqual(
    parseRelayRefundRequestPage(
      { requests: [row, { ...row, id: "other-request" }] },
      lookup,
    ).requests.length,
    2,
  );
  assert.deepEqual(parseRelayRefundRequestPage({ requests: [] }, lookup), {
    requests: [],
    continuation: null,
  });
});

test("invalid reverse scope never reaches provider; failures/empty pages recover without stale negative caching", async () => {
  let calls = 0;
  let response: unknown = { requests: [] };
  const client = new RelayClient({
    apiKey: "fixture",
    fetchImpl: async () => {
      calls++;
      return Response.json(response);
    },
  });
  for (const invalid of [
    { ...lookup, transactionHash: `${hash},${hash}` },
    { ...lookup, transactionHash: `https://private.example/${hash}` },
    { ...lookup, chainId: 1337 as 8453 },
    { ...lookup, limit: 0 },
    { ...lookup, limit: 101 },
    { ...lookup, limit: 1.1 },
    { ...lookup, continuation: "" },
  ])
    await assert.rejects(client.refundRequestsByTransaction(invalid));
  assert.equal(calls, 0);
  assert.deepEqual(await client.refundRequestsByTransaction(lookup), {
    requests: [],
    continuation: null,
  });
  response = { requests: [{ ...row, refundTo: "" }] };
  await assert.rejects(
    client.refundRequestsByTransaction(lookup),
    (error: unknown) => {
      assert.ok(error instanceof RelayClientError);
      assert.equal(error.code, "invalid_response");
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes(row.id));
      return true;
    },
  );
  response = { requests: [row] };
  assert.equal(
    (await client.refundRequestsByTransaction(lookup)).requests.length,
    1,
  );
  assert.equal(calls, 3);
});

test("reverse transport uses bounded response/timeout, sanitized errors and no retry loop", async () => {
  const client = new RelayClient({
    apiKey: "fixture",
    timeoutMs: 10,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("private transport detail")),
          { once: true },
        );
      }),
  });
  await assert.rejects(
    client.refundRequestsByTransaction(lookup),
    (error: unknown) =>
      error instanceof RelayClientError &&
      error.code === "timeout" &&
      !error.message.includes("private"),
  );
  const huge = new RelayClient({
    apiKey: "fixture",
    fetchImpl: async () =>
      new Response("{}", {
        headers: { "content-length": String(3 * 1024 * 1024) },
      }),
  });
  await assert.rejects(
    huge.refundRequestsByTransaction(lookup),
    (error: unknown) =>
      error instanceof RelayClientError && error.code === "response_too_large",
  );
});
