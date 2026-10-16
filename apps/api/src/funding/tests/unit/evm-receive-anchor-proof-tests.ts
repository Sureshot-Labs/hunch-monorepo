import assert from "node:assert/strict";
import { test } from "node:test";
import { id, toBeHex, zeroPadValue } from "ethers";
import {
  fetchEvmBlockNumber,
  type EvmRpcTransactionReceipt,
} from "../../../services/polygon-rpc.js";
import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";
import type { FundingReceiveCanonicalEventInput } from "../../persistence/funding-receive-session-repository.js";
import { inspectEvmFundingReceiveAnchor } from "../../receive/evm-receive-anchor-proof.js";
import { receiveRoleEventFingerprint } from "../../receive/receive-role-progress.js";

const hash = (byte: string) => `0x${byte.repeat(32)}`;
const expected: FundingReceiveCanonicalEventInput = {
  networkId: "evm:8453",
  asset: {
    networkId: "evm:8453",
    assetId: `0x${"ab".repeat(20)}`,
    decimals: 6,
  },
  transactionHash: hash("12"),
  eventIndex: "7",
  ledgerHeight: "100",
  blockHash: hash("34"),
  sourceAddress: `0x${"cd".repeat(20)}`,
  destinationAddress: `0x${"ef".repeat(20)}`,
  rawAmount: "4000000",
  observedAt: new Date("2026-10-16T00:00:00Z"),
  now: new Date("2026-10-16T00:00:01Z"),
};
const sourceAddress = expected.sourceAddress;
assert.ok(sourceAddress);
const receipt: EvmRpcTransactionReceipt = {
  transactionHash: expected.transactionHash,
  succeeded: true,
  blockNumber: 100,
  blockHash: expected.blockHash,
  logs: [
    {
      address: expected.asset.assetId,
      logIndex: 7,
      data: zeroPadValue(toBeHex(4000000), 32),
      topics: [
        id("Transfer(address,address,uint256)"),
        zeroPadValue(sourceAddress, 32),
        zeroPadValue(expected.destinationAddress, 32),
      ],
    },
  ],
};
const rpc = {
  receipt: async () => receipt,
  head: async () => 200n,
  block: async () => expected.blockHash,
};
const input = () => ({ expected, deadlineMs: Date.now() + 10_000 });

test("known receive proof binds exact envelope, not observation time or a manufactured hash", async () => {
  const before = structuredClone(expected);
  assert.deepEqual(await inspectEvmFundingReceiveAnchor(input(), rpc), {
    kind: "canonical",
    eventFingerprint: receiveRoleEventFingerprint(expected),
  });
  assert.deepEqual(expected, before);
  assert.equal(
    (
      await inspectEvmFundingReceiveAnchor(input(), {
        ...rpc,
        receipt: async () => ({ ...receipt, transactionHash: undefined }),
      })
    ).kind,
    "deferred",
  );
});

test("only a confirmed exact replacement AND replaced old block proves a pending reanchor", async () => {
  const replacement = { ...receipt, blockNumber: 105, blockHash: hash("56") };
  const proof = await inspectEvmFundingReceiveAnchor(input(), {
    ...rpc,
    receipt: async () => replacement,
    block: async () => hash("56"),
  });
  assert.deepEqual(proof, {
    kind: "replacement_verified",
    eventFingerprint: receiveRoleEventFingerprint(expected),
    previousCanonicalHash: hash("56"),
    ledgerHeight: "105",
    blockHash: hash("56"),
  });
  assert.equal(
    (
      await inspectEvmFundingReceiveAnchor(input(), {
        ...rpc,
        receipt: async () => replacement,
        block: async ({ blockNumber }) =>
          blockNumber === 100 ? expected.blockHash : hash("56"),
      })
    ).kind,
    "deferred",
    "two live canonical anchors are inconsistent, not a repair permission",
  );
  assert.equal(
    (
      await inspectEvmFundingReceiveAnchor(input(), {
        ...rpc,
        receipt: async () => ({ ...replacement, blockNumber: 100 }),
        block: async () => hash("56"),
      })
    ).kind,
    "replacement_verified",
    "the same height can be replaced without changing the economic event",
  );
});

test("missing, conflicting or unconfirmed chain facts never authorize old or replacement publication", async () => {
  const firstLog = receipt.logs[0];
  assert.ok(firstLog);
  const [transferTopic, sourceTopic, destinationTopic] = firstLog.topics;
  assert.ok(transferTopic && sourceTopic && destinationTopic);
  for (const changed of [
    null,
    { ...receipt, succeeded: false },
    { ...receipt, transactionHash: hash("78") },
    { ...receipt, blockHash: hash("78") },
    { ...receipt, logs: [] },
    { ...receipt, logs: [firstLog, firstLog] },
    {
      ...receipt,
      logs: [firstLog, { ...firstLog, address: `0x${"01".repeat(20)}` }],
    },
    { ...receipt, logs: [{ ...firstLog, logIndex: 8 }] },
    { ...receipt, logs: [{ ...firstLog, address: `0x${"01".repeat(20)}` }] },
    {
      ...receipt,
      logs: [{ ...firstLog, data: zeroPadValue(toBeHex(4000001), 32) }],
    },
    {
      ...receipt,
      logs: [
        {
          ...firstLog,
          topics: [
            transferTopic,
            zeroPadValue(`0x${"01".repeat(20)}`, 32),
            destinationTopic,
          ],
        },
      ],
    },
    {
      ...receipt,
      logs: [
        {
          ...firstLog,
          topics: [
            transferTopic,
            sourceTopic,
            zeroPadValue(`0x${"01".repeat(20)}`, 32),
          ],
        },
      ],
    },
  ]) {
    for (const replaced of [false, true]) {
      const proof = await inspectEvmFundingReceiveAnchor(input(), {
        ...rpc,
        receipt: async () => changed,
        block: async () => (replaced ? hash("56") : expected.blockHash),
      });
      assert.equal(proof.kind, "deferred");
    }
  }
  for (const overrides of [
    { head: async () => 100n },
    { block: async () => null },
    {
      receipt: async () => {
        throw new Error("private RPC URL");
      },
    },
    {
      head: async () => 105n,
      receipt: async () => ({
        ...receipt,
        blockNumber: 105,
        blockHash: hash("56"),
      }),
      block: async () => hash("56"),
    },
  ]) {
    const proof = await inspectEvmFundingReceiveAnchor(input(), {
      ...rpc,
      ...overrides,
    });
    assert.equal(proof.kind, "deferred");
    assert.ok(!JSON.stringify(proof).includes("private"));
  }
});

test("proof uses one bounded known-transaction pass and never starts extra reads after its deadline", async (context) => {
  let clock = 1000;
  context.mock.method(Date, "now", () => clock);
  let reads = 0;
  const proof = await inspectEvmFundingReceiveAnchor(
    { expected, deadlineMs: 1100 },
    {
      head: async (request) => {
        reads++;
        assert.equal(request.maxAttempts, 1);
        assert.ok(request.timeoutMs <= 100);
        assert.equal(request.bypassCache, true);
        assert.equal(request.isolateBudget, true);
        return 200n;
      },
      block: async (request) => {
        reads++;
        assert.equal(request.blockNumber, 100);
        assert.equal(request.maxAttempts, 1);
        return hash("56");
      },
      receipt: async (request) => {
        reads++;
        assert.equal(request.transactionHash, expected.transactionHash);
        assert.equal(request.maxAttempts, 1);
        clock = 1100;
        return { ...receipt, blockNumber: 105, blockHash: hash("56") };
      },
    },
  );
  assert.deepEqual(proof, {
    kind: "deferred",
    reason: "receive_anchor_deadline",
  });
  assert.equal(
    reads,
    3,
    "no replacement-block read after the shared budget expired",
  );
});

test("invalid/unsupported frozen identities and absent budgets perform no provider reads", async () => {
  const forbidden = async (): Promise<never> => {
    throw new Error("unexpected RPC");
  };
  let reads = 0;
  const rejectedRpc = {
    head: async () => {
      reads++;
      return forbidden();
    },
    block: forbidden,
    receipt: forbidden,
  };
  for (const patch of [
    { networkId: "solana:mainnet" },
    { asset: { ...expected.asset, networkId: "evm:137" } },
    { sourceAddress: null },
    { transactionHash: "invalid" },
    { eventIndex: "-1" },
    { ledgerHeight: "9007199254740992" },
    { rawAmount: "0" },
  ])
    assert.equal(
      (
        await inspectEvmFundingReceiveAnchor(
          { ...input(), expected: { ...expected, ...patch } },
          rejectedRpc,
        )
      ).kind,
      "deferred",
    );
  for (const deadlineMs of [Infinity, NaN, Date.now() - 1])
    assert.equal(
      (
        await inspectEvmFundingReceiveAnchor(
          { expected, deadlineMs },
          rejectedRpc,
        )
      ).kind,
      "deferred",
    );
  assert.equal(reads, 0);
});

test("canonical/moved anchors accept the exact existing finality boundary with bounded positive call counts", async () => {
  for (const networkId of ["evm:137", "evm:8453"]) {
    for (const moved of [false, true]) {
      let reads = 0;
      const event = {
        ...expected,
        networkId,
        asset: { ...expected.asset, networkId },
      };
      const proof = await inspectEvmFundingReceiveAnchor(
        { expected: event, deadlineMs: Date.now() + 1000 },
        {
          head: async () => {
            reads++;
            return moved ? 106n : 101n;
          },
          block: async () => {
            reads++;
            return moved ? hash("56") : expected.blockHash;
          },
          receipt: async () => {
            reads++;
            return moved
              ? { ...receipt, blockNumber: 105, blockHash: hash("56") }
              : receipt;
          },
        },
      );
      assert.equal(proof.kind, moved ? "replacement_verified" : "canonical");
      assert.equal(reads, moved ? 4 : 3);
    }
  }
  const replay: FundingReceiveCanonicalEventInput = {
    ...expected,
    now: new Date(0),
    observedAt: new Date(0),
  };
  assert.equal(
    receiveRoleEventFingerprint(replay),
    receiveRoleEventFingerprint(expected),
    "observing a replay later cannot change its economic/anchor fingerprint",
  );
});

test("default RPC proof cannot inherit an unrelated in-flight fresh head's wider timeout/retries", async () => {
  const originalFetch = globalThis.fetch;
  let releaseWideHead: (() => void) | undefined;
  let headRequests = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let wideHead: Promise<bigint> | undefined;
  let proofTask: ReturnType<typeof inspectEvmFundingReceiveAnchor> | undefined;
  let markWideHeadStarted: () => void = () => undefined;
  const wideHeadStarted = new Promise<void>((resolve) => {
    markWideHeadStarted = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === "eth_blockNumber") {
      headRequests++;
      if (headRequests === 1) {
        markWideHeadStarted();
        await new Promise<void>((resolve) => {
          releaseWideHead = resolve;
        });
      }
      result = "0xc8";
    } else if (request.method === "eth_getBlockByNumber") {
      result = { hash: expected.blockHash };
    } else if (request.method === "eth_getTransactionReceipt") {
      result = {
        transactionHash: expected.transactionHash,
        status: "0x1",
        blockNumber: "0x64",
        blockHash: expected.blockHash,
        logs: receipt.logs.map((log) => ({ ...log, logIndex: "0x7" })),
      };
    } else assert.fail("unexpected RPC; no network permitted");
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  try {
    wideHead = fetchEvmBlockNumber({
      rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
      timeoutMs: 5000,
      maxAttempts: 2,
      bypassCache: true,
    });
    await wideHeadStarted;
    proofTask = inspectEvmFundingReceiveAnchor({
      expected,
      deadlineMs: Date.now() + 500,
    });
    const proof = await Promise.race([
      proofTask,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("bounded proof inherited the held wide-budget head"),
            ),
          1000,
        );
      }),
    ]);
    assert.equal(proof.kind, "canonical");
    assert.equal(
      headRequests,
      2,
      "bounded caller uses the common RPC's budget-specific lane",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    releaseWideHead?.();
    await wideHead;
    await proofTask?.catch(() => undefined);
    globalThis.fetch = originalFetch;
  }
});
