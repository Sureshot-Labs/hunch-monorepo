// Protocol evidence tests only. Transport is mocked; returned actions are never executed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { hip4RawUnits } from "@hunch/shared";
import {
  RelayClient,
  type RelayQuoteRequest,
} from "./funding-providers/relay/client.js";
import type { RelayQuoteResponse } from "./funding-providers/relay/schemas.js";
import { parseHip4LedgerObservation } from "./services/hip4-account-contract.js";

type Fields = { name: string; type: string }[];
type Withdrawal = {
  name: string;
  schemaAccepted: boolean;
  steps: {
    id: string;
    kind: string;
    items: {
      dataKeys: string[];
      typedData: null | {
        domain: { name: string; version: string; chainId: number };
        types: Record<string, Fields>;
        safeFields: { chainId: string };
      };
    }[];
  }[];
  details: RelayQuoteResponse["details"];
  withdrawal: {
    envelopeType: string;
    action: {
      hyperliquidChain: string;
      sourceDex: string;
      destinationDex: string;
      token: string;
      amount: string;
      fromSubAccount: string;
    };
    eip712Types: Record<string, Fields>;
    eip712PrimaryType: string;
    relationships: {
      authorizeWalletMatchesUser: boolean;
      authorizeDepositorMatchesActionDestination: boolean;
      authorizationMatchesEnvelopeNonce: boolean;
      parameterNoncePresent: boolean;
      parameterNonceMatchesEnvelope: boolean;
    };
  };
};
const fixture: {
  request: {
    protocolVersion: "v2";
    tradeType: "EXACT_INPUT";
    useDepositAddress: false;
    requestedUiAmount: string;
  };
  accountReadContract: {
    role: string;
    abstraction: string;
    outcomeSpecificFeeFields: string[];
  };
  deposits: {
    name: string;
    schemaAccepted: boolean;
    origin: {
      chainId: number;
      currency: string;
      decimals: number;
      amount: string;
    };
    destination: {
      chainId: number;
      currency: string;
      decimals: number;
      amount: string;
      minimumAmount: string;
    };
    steps: { id: string; kind: string }[];
  }[];
  withdrawals: Withdrawal[];
} = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/hip4/relay-core-observations-20261012.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const sdkFixture: {
  vectors: { name: string; typedData: { types: Record<string, Fields> } }[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/signing-sdk-0.24.0.json", import.meta.url),
    "utf8",
  ),
);
const owner = "0x0000000000000000000000000000000000000001";
const destination = "0x0000000000000000000000000000000000000002";

test("observed unregistered default account is not evidence for funded standard mode or HIP fees", () => {
  assert.equal(fixture.accountReadContract.role, "missing");
  assert.equal(fixture.accountReadContract.abstraction, "default");
  assert.deepEqual(fixture.accountReadContract.outcomeSpecificFeeFields, []);
});

for (const observation of fixture.withdrawals) {
  test(`live contract: ${observation.name} preserves native fields through Relay transport`, async () => {
    const data = observation.withdrawal;
    const authorization = observation.steps[0].items[0].typedData;
    assert.ok(authorization);
    assert.deepEqual(authorization.domain, {
      name: "RelayNonceMapping",
      version: "2",
      chainId: 1,
    });
    assert.equal(authorization.safeFields.chainId, "hyperliquid");
    assert.equal(data.envelopeType, "sendAsset");
    assert.equal(data.eip712PrimaryType, "HyperliquidTransaction:SendAsset");
    const sdkTypes = sdkFixture.vectors.find(
      (vector) => vector.name === "send-asset-mainnet",
    )?.typedData.types[data.eip712PrimaryType];
    assert.deepEqual(data.eip712Types[data.eip712PrimaryType], sdkTypes);
    assert.equal(
      data.action.sourceDex,
      observation.name.includes("spot") ? "spot" : "",
    );
    assert.equal(data.action.destinationDex, "");
    assert.equal(data.action.token, "USDC:0x6d1e7cde53ba9467b783cb7c530ce054");
    assert.equal(
      hip4RawUnits(data.action.amount, 8).toString(),
      observation.details.currencyIn.amount,
    );
    assert.equal(data.relationships.authorizationMatchesEnvelopeNonce, true);
    assert.equal(data.relationships.parameterNonceMatchesEnvelope, true);
    // These are different provider concepts, not a valid equality guard.
    assert.equal(
      data.relationships.authorizeDepositorMatchesActionDestination,
      false,
    );

    const nonce = 1791806400000;
    // Synthetic aliases and nonce rebuild the selected live shape, NOT a replayable quote.
    const steps = [
      {
        id: "authorize",
        kind: "signature",
        requestId: "synthetic-quote",
        items: [
          {
            status: "incomplete",
            data: {
              sign: {
                signatureKind: "eip712",
                primaryType: "NonceMapping",
                domain: authorization.domain,
                types: authorization.types,
                value: {
                  chainId: authorization.safeFields.chainId,
                  wallet: owner,
                  depositor: owner,
                  id: `0x${"0".repeat(64)}`,
                  nonce,
                },
              },
            },
          },
        ],
      },
      {
        id: "deposit",
        kind: "transaction",
        requestId: "synthetic-quote",
        items: [
          {
            status: "incomplete",
            data: {
              action: {
                type: data.envelopeType,
                parameters: { ...data.action, destination, nonce },
              },
              nonce,
              eip712Types: data.eip712Types,
              eip712PrimaryType: data.eip712PrimaryType,
            },
          },
        ],
      },
    ];
    const input = observation.details.currencyIn;
    const output = observation.details.currencyOut;
    const request: RelayQuoteRequest = {
      user: owner,
      recipient: owner,
      originChainId: input.currency.chainId,
      destinationChainId: output.currency.chainId,
      originCurrency: input.currency.address,
      destinationCurrency: output.currency.address,
      amount: input.amount,
      tradeType: "EXACT_INPUT",
      protocolVersion: "v2",
      useDepositAddress: false,
    };
    const relay = new RelayClient({
      apiKey: "synthetic-key",
      fetchImpl: async (url, init) => {
        assert.equal(String(url), "https://api.relay.link/quote/v2");
        assert.deepEqual(JSON.parse(String(init?.body)), request);
        return Response.json({ steps, details: observation.details });
      },
    });
    const response = await relay.quote(request);
    assert.deepEqual(response.steps, steps);
    assert.equal(response.details.currencyIn.currency.decimals, 8);
    assert.equal(response.details.currencyOut.currency.decimals, 6);
    // Returned signature/transaction is data only. quote() made exactly one HTTP request.
  });
}

for (const observation of fixture.deposits) {
  test(`live contract: ${observation.name} uses actual destination amount, not nominal input`, async () => {
    assert.equal(observation.schemaAccepted, true);
    assert.equal(hip4RawUnits("10", 6).toString(), observation.origin.amount);
    assert.ok(
      BigInt(observation.destination.minimumAmount) <=
        BigInt(observation.destination.amount),
    );
    assert.ok(BigInt(observation.destination.amount) < hip4RawUnits("10", 8));
    const request: RelayQuoteRequest = {
      user: owner,
      recipient: owner,
      originChainId: observation.origin.chainId,
      destinationChainId: observation.destination.chainId,
      originCurrency: observation.origin.currency,
      destinationCurrency: observation.destination.currency,
      amount: observation.origin.amount,
      tradeType: "EXACT_INPUT",
      protocolVersion: "v2",
      useDepositAddress: false,
    };
    const details = {
      currencyIn: {
        currency: {
          chainId: observation.origin.chainId,
          address: observation.origin.currency,
          decimals: 6,
        },
        amount: observation.origin.amount,
        minimumAmount: observation.origin.amount,
      },
      currencyOut: {
        currency: {
          chainId: observation.destination.chainId,
          address: observation.destination.currency,
          decimals: 8,
        },
        amount: observation.destination.amount,
        minimumAmount: observation.destination.minimumAmount,
      },
    };
    const relay = new RelayClient({
      apiKey: "synthetic-key",
      fetchImpl: async (_url, init) => {
        const actual = JSON.parse(String(init?.body));
        assert.deepEqual(actual, request);
        return Response.json({
          details,
          steps: observation.steps.map((step) => ({
            ...step,
            requestId: "synthetic-quote",
            items: [{ status: "incomplete", data: {} }],
          })),
        });
      },
    });
    const parsed = await relay.quote(request);
    assert.deepEqual(parsed.details, details);
  });
}

test("existing Relay callers do not acquire protocolVersion or native execution implicitly", async () => {
  let calls = 0;
  const relay = new RelayClient({
    apiKey: "synthetic-key",
    fetchImpl: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(Object.hasOwn(body, "protocolVersion"), false);
      return Response.json({
        steps: [
          {
            id: "deposit",
            kind: "transaction",
            requestId: "synthetic-quote",
            items: [{ status: "incomplete", data: {} }],
          },
        ],
        details: fixture.withdrawals[0].details,
      });
    },
  });
  await relay.quote({
    user: owner,
    recipient: owner,
    originChainId: 8453,
    destinationChainId: 137,
    originCurrency: "source",
    destinationCurrency: "destination",
    amount: "10000000",
    tradeType: "EXACT_INPUT",
  });
  assert.equal(calls, 1);
});

type ReceiptRoute = {
  name: string;
  incoming: boolean;
  owner: string;
  baseOwner: string;
  nativeTx: { txHash: string; chainId: number; status: string };
  nativeActionUser: string;
  nativeAction: {
    type: string;
    hyperliquidChain: string;
    amount: string;
    token: string;
    destination: string;
    sourceDex: string;
    destinationDex: string;
    fromSubAccount: string;
    nonce: number;
  };
  nativeLedger: { matches: unknown[] };
  baseReceipt: {
    transactionHash: string;
    blockHash: string;
    blockNumber: string;
    status: string;
  };
  baseCanonicalBlock: { number: string; hash: string };
  baseTransfers: {
    logIndex: string;
    from: string;
    to: string;
    amount: string;
    removed: boolean;
  }[];
  relayStatus: {
    status: string;
    inTxHashes: string[];
    txHashes: string[];
    failReason: string;
  };
  routeActual: Record<
    "origin" | "destination",
    {
      amount: string;
      currency: { chainId: number; address: string; decimals: number };
    }
  >;
};
const receipts: {
  requests: number;
  failures: unknown[];
  baseFinalizedBlock: string;
  baseTransferFilter: { address: string; topic0: string; topicCount: number };
  quoteToken: { name: string; tokenId: string; weiDecimals: number };
  routes: ReceiptRoute[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/relay-receipts-20261012.json", import.meta.url),
    "utf8",
  ),
);

// A fixture acceptance oracle, not a production credit confirmer. P3 must bind
// these observations to trusted operation/owner/environment and handle recovery.
function assertReceiptEvidence(route: ReceiptRoute) {
  const { nativeAction: action, nativeTx, baseReceipt, relayStatus } = route;
  assert.equal(nativeTx.chainId, 1337);
  assert.equal(nativeTx.status, "success");
  assert.equal(action.hyperliquidChain, "Mainnet");
  assert.equal(action.type, "sendAsset");
  assert.equal(action.fromSubAccount, "");
  assert.equal(
    action.token,
    `${receipts.quoteToken.name}:${receipts.quoteToken.tokenId}`,
  );
  assert.equal(receipts.quoteToken.weiDecimals, 8);
  assert.equal(route.nativeLedger.matches.length, 1);
  const ledger = parseHip4LedgerObservation(route.nativeLedger.matches[0]);
  assert.equal(ledger.supported, true);
  assert.equal(ledger.entry.hash, nativeTx.txHash);
  const delta = ledger.entry.delta;
  assert.equal(delta.type, "send");
  assert.equal(delta.user, route.nativeActionUser);
  assert.equal(delta.destination, action.destination);
  assert.equal(delta.token, receipts.quoteToken.name);
  assert.equal(delta.nonce, action.nonce);
  assert.equal(delta.sourceDex, action.sourceDex);
  assert.equal(delta.destinationDex, action.destinationDex);
  assert.equal(route.incoming ? delta.destination : delta.user, route.owner);
  const expectedDex = route.name.includes("spot") ? "spot" : "";
  assert.equal(
    route.incoming ? action.destinationDex : action.sourceDex,
    expectedDex,
  );
  assert.equal(route.incoming ? action.sourceDex : action.destinationDex, "");
  assert.equal(typeof delta.amount, "string");
  const nativeAmount = hip4RawUnits(String(delta.amount), 8);
  assert.ok(nativeAmount > 0n);
  assert.equal(nativeAmount, hip4RawUnits(action.amount, 8));
  const actualNative = route.incoming
    ? route.routeActual.destination
    : route.routeActual.origin;
  const actualBase = route.incoming
    ? route.routeActual.origin
    : route.routeActual.destination;
  assert.equal(actualNative.currency.chainId, 1337);
  assert.equal(actualNative.currency.decimals, 8);
  assert.equal(
    actualNative.currency.address,
    expectedDex === "spot"
      ? receipts.quoteToken.tokenId
      : "0x00000000000000000000000000000000",
  );
  assert.equal(nativeAmount, BigInt(actualNative.amount));
  assert.equal(actualBase.currency.chainId, 8453);
  assert.equal(actualBase.currency.decimals, 6);
  assert.equal(
    actualBase.currency.address,
    receipts.baseTransferFilter.address,
  );
  assert.equal(baseReceipt.status, "0x1");
  assert.equal(baseReceipt.blockHash, route.baseCanonicalBlock.hash);
  assert.equal(baseReceipt.blockNumber, route.baseCanonicalBlock.number);
  assert.ok(
    BigInt(baseReceipt.blockNumber) <= BigInt(receipts.baseFinalizedBlock),
  );
  assert.ok(route.baseTransfers.length > 0);
  assert.equal(
    new Set(route.baseTransfers.map((log) => log.logIndex)).size,
    route.baseTransfers.length,
  );
  let baseAmount = 0n;
  for (const transfer of route.baseTransfers) {
    assert.equal(transfer.removed, false);
    assert.equal(route.incoming ? transfer.from : transfer.to, route.baseOwner);
    baseAmount += BigInt(transfer.amount);
  }
  assert.equal(baseAmount, BigInt(actualBase.amount));
  assert.equal(relayStatus.status, "success");
  assert.deepEqual(
    route.incoming ? relayStatus.txHashes : relayStatus.inTxHashes,
    [nativeTx.txHash],
  );
  assert.deepEqual(
    route.incoming ? relayStatus.inTxHashes : relayStatus.txHashes,
    [baseReceipt.transactionHash],
  );
  // Fee-inclusive route input and output are not the same amount, nor is a
  // native perp USDC alias the spot token ID, despite matching unit precision.
  assert.ok(
    BigInt(route.routeActual.origin.amount) * (route.incoming ? 100n : 1n) >
      BigInt(route.routeActual.destination.amount) *
        (route.incoming ? 1n : 100n),
  );
}

test("public receipt sample spans all four directions without recording a financial runtime", () => {
  assert.equal(receipts.requests, 22);
  assert.deepEqual(receipts.failures, []);
  assert.deepEqual(
    receipts.routes.map((route) => route.name),
    [
      "base-to-core-spot",
      "base-to-core-perps",
      "core-spot-to-base",
      "core-perps-to-base",
    ],
  );
  assert.equal(
    receipts.baseTransferFilter.address,
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
  assert.equal(
    receipts.baseTransferFilter.topic0,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
  assert.equal(receipts.baseTransferFilter.topicCount, 3);
});

for (const route of receipts.routes) {
  test(`observed receipt: ${route.name} binds exact native ledger and finalized Base transfer`, () => {
    assertReceiptEvidence(route);
    assert.equal(route.relayStatus.failReason, "N/A");
  });
}

test("receipt evidence rejects conflicting identities, amounts, direction and finality despite provider success", () => {
  const original = receipts.routes[0];
  const changes: ((route: ReceiptRoute) => void)[] = [
    (r) => {
      r.nativeTx.txHash = `0x${"f".repeat(64)}`;
    },
    (r) => {
      r.nativeAction.nonce++;
    },
    (r) => {
      r.nativeAction.amount = "1";
    },
    (r) => {
      r.nativeAction.token = "WRONG";
    },
    (r) => {
      r.nativeAction.destinationDex = "";
    },
    (r) => {
      r.owner = `0x${"f".repeat(40)}`;
    },
    (r) => {
      r.nativeLedger.matches.push(r.nativeLedger.matches[0]);
    },
    (r) => {
      r.baseReceipt.status = "0x0";
    },
    (r) => {
      r.baseReceipt.blockHash = `0x${"f".repeat(64)}`;
    },
    (r) => {
      r.baseReceipt.blockNumber =
        r.baseCanonicalBlock.number = `0x${(BigInt(receipts.baseFinalizedBlock) + 1n).toString(16)}`;
    },
    (r) => {
      r.baseTransfers[0].amount = "1";
    },
    (r) => {
      r.baseTransfers[0].removed = true;
    },
    (r) => {
      r.baseTransfers[0].from = `0x${"f".repeat(40)}`;
    },
    (r) => {
      r.baseTransfers.push(r.baseTransfers[0]);
    },
    (r) => {
      r.routeActual.destination.currency.address =
        "0x00000000000000000000000000000000";
    },
    (r) => {
      r.routeActual.destination.currency.decimals = 6;
    },
    (r) => {
      r.relayStatus.inTxHashes = r.relayStatus.txHashes;
    },
  ];
  for (const change of changes) {
    const mutated = structuredClone(original);
    change(mutated);
    assert.throws(() => assertReceiptEvidence(mutated));
  }
});

const capturedCurrency = z.object({
  amount: z.string().regex(/^\d+$/),
  currency: z.object({
    chainId: z.number(),
    address: z.string(),
    decimals: z.number(),
  }),
});
const multiChain = z
  .object({
    requests: z.number(),
    failures: z.array(z.unknown()),
    routes: z.array(
      z.object({
        name: z.string(),
        origin: z.number(),
        destination: z.number(),
        currencyIn: z.string(),
        currencyOut: z.string(),
        quote: z.object({
          httpStatus: z.number(),
          schemaAccepted: z.boolean(),
          currencyIn: capturedCurrency,
          currencyOut: capturedCurrency,
        }),
        receipt: z.object({
          actual: z.object({
            origin: capturedCurrency,
            destination: capturedCurrency,
          }),
          nativeAction: z.object({
            amount: z.string(),
            sourceDex: z.string(),
            destinationDex: z.string(),
            token: z.string(),
            nonce: z.string(),
          }),
          nativeLedger: z.object({
            amount: z.string(),
            sourceDex: z.string(),
            destinationDex: z.string(),
            token: z.string(),
            nonce: z.string(),
          }),
          external: z.object({
            kind: z.string(),
            slot: z.number().nullable().optional(),
            rpcErrorCode: z.number().nullable().optional(),
            signedChange: z.string().optional(),
          }),
          checks: z.record(z.string(), z.boolean()),
        }),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/hip4/relay-multichain-observations-20261012.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
const solanaVersionRecovery = z
  .object({
    route: z.string(),
    requests: z.number(),
    attempts: z.array(
      z.object({
        maxSupportedTransactionVersion: z.number(),
        errorCode: z.number().nullable(),
        reportedVersion: z.number().nullable(),
        resultPresent: z.boolean(),
      }),
    ),
    receipt: z.object({
      version: z.number(),
      slot: z.number(),
      finalizedSlot: z.number(),
      debit: z.string(),
      expectedDebit: z.string(),
      checks: z.record(z.string(), z.boolean()),
      pre: z.array(z.object({ amount: z.string(), decimals: z.number() })),
      post: z.array(z.object({ amount: z.string(), decimals: z.number() })),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/hip4/relay-solana-version-observations-20261012.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

test("Polygon USDC/pUSD and Solana USDC quotes preserve all twelve Core route identities and units", () => {
  assert.equal(multiChain.requests, 70);
  assert.deepEqual(multiChain.failures, []);
  assert.equal(multiChain.routes.length, 12);
  assert.equal(new Set(multiChain.routes.map((r) => r.name)).size, 12);
  for (const route of multiChain.routes) {
    assert.equal(route.quote.httpStatus, 200);
    assert.equal(route.quote.schemaAccepted, true);
    const incoming = route.destination === 1337;
    for (const [value, chain, address] of [
      [route.quote.currencyIn, route.origin, route.currencyIn],
      [route.quote.currencyOut, route.destination, route.currencyOut],
      [route.receipt.actual.origin, route.origin, route.currencyIn],
      [route.receipt.actual.destination, route.destination, route.currencyOut],
    ] as const) {
      assert.equal(value.currency.chainId, chain);
      assert.equal(value.currency.address, address);
      assert.equal(value.currency.decimals, chain === 1337 ? 8 : 6);
    }
    assert.equal(
      route.quote.currencyIn.amount,
      incoming ? "10000000" : "1000000000",
    );
    const { nativeAction: action, nativeLedger: ledger } = route.receipt;
    assert.equal(action.token, "USDC:0x6d1e7cde53ba9467b783cb7c530ce054");
    assert.equal(ledger.token, "USDC");
    assert.equal(action.nonce, ledger.nonce);
    assert.equal(action.sourceDex, ledger.sourceDex);
    assert.equal(action.destinationDex, ledger.destinationDex);
    assert.equal(
      incoming ? action.destinationDex : action.sourceDex,
      route.name.includes("spot") ? "spot" : "",
    );
    assert.equal(
      hip4RawUnits(action.amount, 8),
      hip4RawUnits(ledger.amount, 8),
    );
    assert.equal(
      hip4RawUnits(action.amount, 8),
      BigInt(
        (incoming
          ? route.receipt.actual.destination
          : route.receipt.actual.origin
        ).amount,
      ),
    );
    // Capture diagnostics are not a substitute for runtime evidence verification.
    if (route.name !== solanaVersionRecovery.route)
      assert.ok(Object.values(route.receipt.checks).every(Boolean));
  }
});

test("a version-zero Solana reader cannot mistake an unsupported v1 receipt for zero transfer or success", () => {
  const route = multiChain.routes.find(
    (r) => r.name === solanaVersionRecovery.route,
  );
  assert.ok(route);
  assert.equal(route.receipt.external.rpcErrorCode, -32015);
  assert.equal(route.receipt.external.slot, null);
  assert.equal(route.receipt.checks.otherSucceeded, false);
  assert.equal(route.receipt.checks.otherAmount, false);
  assert.deepEqual(solanaVersionRecovery.attempts, [
    {
      maxSupportedTransactionVersion: 0,
      errorCode: -32015,
      reportedVersion: 1,
      resultPresent: false,
    },
    {
      maxSupportedTransactionVersion: 1,
      errorCode: null,
      reportedVersion: null,
      resultPresent: true,
    },
  ]);
  const { receipt } = solanaVersionRecovery;
  assert.equal(receipt.version, 1);
  assert.ok(receipt.slot <= receipt.finalizedSlot);
  const sum = (rows: { amount: string; decimals: number }[]) =>
    rows.reduce((total, row) => {
      assert.equal(row.decimals, 6);
      return total + BigInt(row.amount);
    }, 0n);
  assert.equal(sum(receipt.pre) - sum(receipt.post), BigInt(receipt.debit));
  assert.equal(receipt.debit, receipt.expectedDebit);
  assert.equal(receipt.debit, route.receipt.actual.origin.amount);
  assert.ok(Object.values(receipt.checks).every(Boolean));
});
