import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";
import { verifyRelayHypercoreTransfer } from "./hypercore-transfer-evidence.js";
function required<T>(value: T | null | undefined): T {
  assert.ok(value != null, "required fixture field");
  return value;
}

type RecordedRoute = {
  name: string;
  incoming: boolean;
  owner: string;
  nativeTx: { txHash: string; chainId: number; status: string; block: number };
  nativeActionUser: string;
  nativeAction: {
    type: string;
    hyperliquidChain: string;
    destination: string;
    sourceDex: string;
    destinationDex: string;
    token: string;
    amount: string;
    fromSubAccount: string;
    nonce: number;
  };
  nativeLedger: {
    matches: {
      hash: string;
      time: number;
      delta: {
        type: string;
        user: string;
        destination: string;
        sourceDex: string;
        destinationDex: string;
        token: string;
        amount: string;
        usdcValue: string;
        fee: string;
        nativeTokenFee: string;
        nonce: number;
        feeToken: string;
      };
    }[];
  };
  routeActual: { origin: { amount: string }; destination: { amount: string } };
  checks: { nativeActionHashAgrees: boolean; nativeActionNoError: boolean };
};
const recorded: { routes: RecordedRoute[] } = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/hip4/relay-receipts-20261012.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function example(route = required(recorded.routes[0])) {
  assert.equal(route.checks.nativeActionHashAgrees, true);
  assert.equal(route.checks.nativeActionNoError, true);
  // Reconstruct the selected Requests-v3 envelope from redacted P0 fields.
  // This is not a captured full response and makes no new network requests.
  return {
    expected: {
      asset: { ...HYPERCORE_MAINNET_USDC },
      owner: route.owner,
      direction: route.incoming ? ("credit" as const) : ("debit" as const),
      dex: (route.incoming
        ? route.nativeAction.destinationDex
        : route.nativeAction.sourceDex) as "spot" | "",
      transactionHash: route.nativeTx.txHash,
      actualRaw: (route.incoming
        ? route.routeActual.destination
        : route.routeActual.origin
      ).amount,
    },
    nativeTransaction: {
      ...route.nativeTx,
      data: {
        hash: route.nativeTx.txHash,
        error: null as string | null,
        user: route.nativeActionUser,
        action: { ...route.nativeAction },
      },
    },
    ledger: structuredClone(route.nativeLedger.matches),
  };
}

for (const route of recorded.routes) {
  test(`exact native ledger evidence: ${route.name}`, () => {
    const input = example(route);
    const result = verifyRelayHypercoreTransfer(input);
    assert.equal(result.kind, "verified");
    if (result.kind !== "verified") return;
    assert.equal(result.evidence.rawAmount, input.expected.actualRaw);
    assert.equal(result.evidence.owner, route.owner);
    assert.equal(result.evidence.sourceDex, route.nativeAction.sourceDex);
    assert.equal(
      result.evidence.destinationDex,
      route.nativeAction.destinationDex,
    );
    assert.equal(result.evidence.nonce, route.nativeAction.nonce);
    assert.equal(result.evidence.providerBlock, route.nativeTx.block);
    assert.ok(!("blockHash" in result.evidence));
    assert.ok(!("availableRaw" in result.evidence));
    assert.ok(!("spendable" in result.evidence));
  });
}

const foreign = `0x${"f".repeat(40)}`;
const foreignHash = `0x${"f".repeat(64)}`;
const mutations: [string, (value: ReturnType<typeof example>) => void][] = [
  [
    "wrong owner",
    (value) => {
      value.expected.owner = foreign;
    },
  ],
  [
    "wrong environment",
    (value) => {
      value.expected.asset.networkId = "hyperliquid:testnet";
    },
  ],
  [
    "wrong precision",
    (value) => {
      value.expected.asset.decimals = 6;
    },
  ],
  [
    "wrong native token",
    (value) => {
      value.expected.asset.assetId = `0x${"a".repeat(32)}`;
    },
  ],
  [
    "wrong DEX",
    (value) => {
      value.expected.dex = "";
    },
  ],
  [
    "wrong reference",
    (value) => {
      value.expected.transactionHash = foreignHash;
    },
  ],
  [
    "nominal instead of credited amount",
    (value) => {
      value.expected.actualRaw = "4195200000";
    },
  ],
  [
    "one raw unit difference",
    (value) => {
      value.expected.actualRaw = (
        BigInt(value.expected.actualRaw) + 1n
      ).toString();
    },
  ],
  [
    "unsafe block number",
    (value) => {
      value.nativeTransaction.block = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "unsuccessful native action",
    (value) => {
      value.nativeTransaction.data.error = "rejected";
    },
  ],
  [
    "wrong transaction data hash",
    (value) => {
      value.nativeTransaction.data.hash = foreignHash;
    },
  ],
  [
    "wrong native environment",
    (value) => {
      value.nativeTransaction.data.action.hyperliquidChain = "Testnet";
    },
  ],
  [
    "wrong action owner",
    (value) => {
      value.nativeTransaction.data.user = foreign;
    },
  ],
  [
    "wrong native action token",
    (value) => {
      value.nativeTransaction.data.action.token =
        "USDC:0x00000000000000000000000000000000";
    },
  ],
  [
    "subaccount transfer",
    (value) => {
      value.nativeTransaction.data.action.fromSubAccount = foreign;
    },
  ],
  [
    "internal class transfer",
    (value) => {
      value.nativeTransaction.data.user = value.expected.owner;
      required(value.ledger[0]).delta.user = value.expected.owner;
    },
  ],
  [
    "fractional raw units",
    (value) => {
      value.nativeTransaction.data.action.amount += "000000001";
    },
  ],
  [
    "wrong ledger nonce",
    (value) => {
      required(value.ledger[0]).delta.nonce++;
    },
  ],
  [
    "wrong ledger token",
    (value) => {
      required(value.ledger[0]).delta.token = "USDH";
    },
  ],
  [
    "wrong ledger source",
    (value) => {
      required(value.ledger[0]).delta.user = foreign;
    },
  ],
  [
    "wrong ledger destination",
    (value) => {
      required(value.ledger[0]).delta.destination = foreign;
    },
  ],
  [
    "wrong ledger source DEX",
    (value) => {
      required(value.ledger[0]).delta.sourceDex = "spot";
    },
  ],
  [
    "wrong ledger destination DEX",
    (value) => {
      required(value.ledger[0]).delta.destinationDex = "";
    },
  ],
  [
    "wrong ledger amount",
    (value) => {
      required(value.ledger[0]).delta.amount = "1";
    },
  ],
  [
    "unknown native fee semantics",
    (value) => {
      required(value.ledger[0]).delta.nativeTokenFee = "0.01";
    },
  ],
  [
    "unknown token fee semantics",
    (value) => {
      required(value.ledger[0]).delta.fee = "0.01";
    },
  ],
  [
    "malformed known ledger event",
    (value) => {
      required(value.ledger[0]).delta.nonce = -1;
    },
  ],
  [
    "wrong ledger kind",
    (value) => {
      required(value.ledger[0]).delta.type = "futureCredit";
    },
  ],
];
for (const [name, mutate] of mutations) {
  test(`native evidence rejects ${name}`, () => {
    const input = example();
    mutate(input);
    assert.equal(verifyRelayHypercoreTransfer(input).kind, "unverified");
  });
}

test("provider success without independent native ledger is not credited; later exact evidence recovers", () => {
  const input = example();
  const ledger = input.ledger;
  input.ledger = [];
  assert.deepEqual(verifyRelayHypercoreTransfer(input), {
    kind: "unverified",
    reason: "native_ledger_missing",
  });
  input.ledger = ledger;
  assert.equal(verifyRelayHypercoreTransfer(input).kind, "verified");
});

test("replayed exact records produce one identical fact; conflicting same-hash records do not", () => {
  const input = example();
  const first = verifyRelayHypercoreTransfer(input);
  input.ledger.push(structuredClone(required(input.ledger[0])));
  assert.deepEqual(verifyRelayHypercoreTransfer(input), first);
  required(input.ledger[1]).time++;
  assert.deepEqual(verifyRelayHypercoreTransfer(input), {
    kind: "unverified",
    reason: "native_ledger_conflict",
  });
});

test("concurrent unrelated deposit cannot satisfy or invalidate an exact transfer", () => {
  const input = example();
  const first = verifyRelayHypercoreTransfer(input);
  const foreignEntry = structuredClone(required(input.ledger[0]));
  foreignEntry.hash = foreignHash;
  foreignEntry.delta.amount = "1000";
  input.ledger.push(foreignEntry);
  assert.deepEqual(verifyRelayHypercoreTransfer(input), first);
  input.ledger = [foreignEntry];
  assert.deepEqual(verifyRelayHypercoreTransfer(input), {
    kind: "unverified",
    reason: "native_ledger_missing",
  });
});
