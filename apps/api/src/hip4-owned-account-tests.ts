import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  hip4AccountAbstractionSchema,
  hip4SpotAccountStateSchema,
} from "./services/hip4-account-contract.js";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./services/hip4-account-projection.js";
import {
  DEFAULT_HIP4_ACCOUNT_POLICY,
  hip4AccountPolicySchema,
} from "./services/hip4-account-policy.js";
import { createHip4AccountClient } from "./services/hip4-client.js";
import { parseHip4ExecutionCursor } from "./services/hip4-account-repository.js";
import { registerHip4AccountRoutes } from "./routes/hip4-account.js";
import { hip4AccountReadResponse } from "./services/hip4-account-service.js";
import {
  hypercoreOrderCashCapacity,
  hypercoreRecipientCashCapacity,
  hypercoreSpotCashCapacity,
} from "./funding/domain/hypercore-cash-capacity.js";
import { projectHip4AccountValue } from "./account-value/hip4-account-value.js";
import { projectHip4PerpsCash } from "./services/hip4-perps-cash.js";

const address = "0x0000000000000000000000000000000000000001";
const observedAt = "2026-10-13T10:00:00.000Z";
const quote = {
  tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
  index: 0,
  weiDecimals: 8,
};
const cash = {
  coin: "USDC",
  token: 0,
  total: "100.00000001",
  hold: "3",
  entryNtl: "0",
};
const position = {
  coin: "+87750",
  total: "20.00001",
  hold: "2",
  entryNtl: "10",
};
const fill = {
  coin: "#87750",
  px: "0.5",
  sz: "2",
  side: "B",
  time: 1791885600000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  crossed: true,
  fee: "0.01",
  tid: 1,
  feeToken: "USDC",
  builderFee: "0.01",
};

test("recorded public funded snapshots retain native nonzero side holdings and separate risk capacity", () => {
  const recorded = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/hip4/public-account-state-20261012.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { accounts: { abstraction: unknown; spot: { snapshot: unknown } }[] };
  const snapshots = recorded.accounts.map((account) =>
    projectHip4Account({
      environment: "mainnet",
      observedAt,
      role: "user",
      mode: hip4AccountAbstractionSchema.parse(account.abstraction),
      quote,
      state: hip4SpotAccountStateSchema.parse(account.spot.snapshot),
    }),
  );
  assert.equal(snapshots[1].positions.length, 2);
  assert.equal(snapshots[2].positions.length, 1);
  assert.equal(
    snapshots[2].positions[0].marketId,
    "hyperliquid:mainnet:outcome:11382",
  );
  assert.equal(snapshots[2].cash.unheld, "23.4685116");
  assert.equal(snapshots[2].cash.availableAfterMaintenance, "26.6915116");
  assert.equal(snapshots[2].cash.ownedCash, null);
  assert.equal(snapshots[2].positions[0].costBasis, null);
});

test("complete native snapshot preserves exact cash, holds and side identity without inventing cost basis", () => {
  const view = projectHip4Account({
    environment: "mainnet",
    observedAt,
    role: "user",
    mode: "disabled",
    quote,
    state: { balances: [cash, position] },
  });
  assert.equal(view.cash.unheld, "97.00000001");
  assert.equal(view.cash.ownedCash, "97.00000001");
  assert.equal(view.cash.spendable, null);
  assert.equal(view.cash.canTrade, false);
  assert.equal(view.positions[0].tokenId, "hyperliquid:mainnet:87750");
  assert.equal(view.positions[0].quantity, "20.00001");
  assert.equal(view.positions[0].costBasis, null);
  assert.equal(view.positions[0].realizedPnl, null);
});
test("default spot ownership needs explicit ancillary evidence and never becomes native-send or perps capacity", () => {
  const args = {
    environment: "mainnet" as const,
    observedAt,
    role: "user" as const,
    mode: "default" as const,
    quote,
    state: { balances: [cash, position] },
  };
  assert.equal(projectHip4Account(args).cash.ownedCash, null);
  for (const legacyDexAbstraction of [null, false]) {
    const view = projectHip4Account({
      ...args,
      defaultSpotCashEvidence: {
        legacyDexAbstraction,
        borrowLendState: {
          tokenToState: [],
          health: "healthy",
          healthFactor: null,
        },
      },
    });
    assert.equal(view.mode, "default");
    assert.equal(view.cash.ownedCash, "97.00000001");
    assert.equal(view.cash.spendable, null);
    assert.equal(
      view.cash.canTrade,
      false,
      "qualified ownership is not permission or an automatic BUY",
    );
    const capacityInput = {
      observation: view,
      environment: "mainnet" as const,
      snapshotMaxAgeMs: 60000,
      now: Date.parse(observedAt),
    };
    assert.equal(hypercoreOrderCashCapacity(capacityInput).known, true);
    assert.deepEqual(hypercoreSpotCashCapacity(capacityInput), {
      known: false,
      reason: "unsupported_cash_mode",
    });
    assert.equal(hypercoreRecipientCashCapacity(capacityInput).known, true);
    assert.equal(
      hypercoreOrderCashCapacity({
        ...capacityInput,
        now: Date.parse(observedAt) + 60000,
      }).known,
      false,
    );
    assert.equal(
      projectHip4PerpsCash({
        mode: view.mode,
        role: view.role,
        state: {},
        observedAt,
        now: Date.parse(observedAt),
      }).state,
      "unsupported",
    );
    const value = projectHip4AccountValue({
      userId: "owner",
      now: Date.parse(observedAt),
      read: {
        environment: "mainnet",
        snapshotMaxAgeMs: 60000,
        accounts: [{ address, observation: view }],
        positions: [],
        coverage: {
          state: "ready",
          policyRevision: "test",
          accounts: 1,
          missingAccounts: 0,
          staleAccounts: 0,
          unresolvedBalances: 0,
          missingCostBasis: 0,
          unpricedPositions: 0,
        },
      },
    });
    assert.equal(value.assets[0].estimatedUsd?.value, cash.total);
    assert.equal(
      value.availability[0].availabilityKnown,
      false,
      "Account Value does not authorize native source spending",
    );
  }
});
test("default ancillary proof rejects supplied or borrowed inventory and contradictory risk fields", () => {
  const evidence = {
    legacyDexAbstraction: null,
    borrowLendState: {
      tokenToState: [],
      health: "healthy",
      healthFactor: null,
    },
  };
  const args = {
    environment: "mainnet" as const,
    observedAt,
    role: "user" as const,
    mode: "default" as const,
    quote,
    state: { balances: [cash] },
    defaultSpotCashEvidence: evidence,
  };
  for (const state of [
    { balances: [{ ...cash, supplied: "1" }] },
    { balances: [{ ...cash, total: "-1" }] },
    { balances: [{ ...cash, total: "2" }] },
    { balances: [cash], tokenToAvailableAfterMaintenance: [[0, "0"]] },
    { balances: [cash], tokenToPortfolioBorrowRatio: [[0, "0"]] },
    { balances: [cash], portfolioMarginRatio: "1" },
  ])
    assert.equal(projectHip4Account({ ...args, state }).cash.ownedCash, null);
  assert.throws(() =>
    projectHip4Account({
      ...args,
      state: { balances: [{ ...cash, hold: "-1" }] },
    }),
  );
  assert.throws(() =>
    projectHip4Account({
      ...args,
      state: { balances: [cash], portfolioMarginEnabled: "false" },
    }),
  );
  assert.equal(
    projectHip4Account({
      ...args,
      state: {
        balances: [
          { ...cash, borrowed: "0", supplied: "0", ltv: "0.9" },
          {
            coin: "HYPE",
            token: 150,
            total: "1.123456789012345678",
            hold: "0",
            entryNtl: "0",
            ltv: "0.5",
          },
        ],
      },
    }).cash.ownedCash,
    "97.00000001",
    "collateral eligibility is not a debt or a reason to hide independently verified spot cash",
  );
  const supply = {
    tokenToState: [
      [
        0,
        {
          borrow: { basis: "0", value: "0" },
          supply: { basis: "0", value: "1" },
        },
      ],
    ],
    health: "healthy",
    healthFactor: null,
  };
  assert.equal(
    projectHip4Account({
      ...args,
      defaultSpotCashEvidence: { ...evidence, borrowLendState: supply },
    }).cash.ownedCash,
    null,
  );
  const missing = projectHip4Account({
    ...args,
    role: "missing",
    state: { balances: [] },
  });
  assert.equal(missing.cash.ownedCash, null);
  const input = {
    observation: missing,
    environment: "mainnet" as const,
    snapshotMaxAgeMs: 60000,
    now: Date.parse(observedAt),
  };
  assert.equal(hypercoreRecipientCashCapacity(input).known, true);
  assert.equal(hypercoreOrderCashCapacity(input).known, false);
  assert.equal(
    hypercoreRecipientCashCapacity({ ...input, now: input.now + 60000 }).known,
    false,
  );
  assert.equal(
    hypercoreRecipientCashCapacity({ ...input, environment: "testnet" }).known,
    false,
  );
});
test("unified and margin risk capacity is separate from owned unheld cash", () => {
  for (const mode of [
    "unifiedAccount",
    "portfolioMargin",
    "default",
    "dexAbstraction",
  ] as const) {
    const view = projectHip4Account({
      environment: "mainnet",
      observedAt,
      role: "user",
      mode,
      quote,
      state: {
        balances: [cash],
        tokenToAvailableAfterMaintenance: [[0, "120"]],
      },
    });
    assert.equal(view.cash.total, cash.total);
    assert.equal(view.cash.availableAfterMaintenance, "120");
    assert.equal(view.cash.ownedCash, null);
  }
  const view = projectHip4Account({
    environment: "mainnet",
    observedAt,
    role: "user",
    mode: "unifiedAccount",
    quote,
    state: { balances: [{ ...cash, borrowed: "0", supplied: "0" }] },
  });
  assert.equal(view.cash.ownedCash, "97.00000001");
});
test("outcome bookkeeping aliases remain unresolved and duplicate or malformed side balances reject", () => {
  const args = {
    environment: "mainnet" as const,
    observedAt,
    role: "user" as const,
    mode: "disabled" as const,
    quote,
  };
  const view = projectHip4Account({
    ...args,
    state: { balances: [cash, position, { ...position, coin: "o8775" }] },
  });
  assert.deepEqual(view.unresolvedBalances, ["o8775"]);
  assert.equal(view.positions.length, 1);
  const zeroBookkeeping = projectHip4Account({
    ...args,
    state: {
      balances: [
        position,
        { coin: "o8775", total: "0.00000", hold: "0", entryNtl: "-0.0" },
      ],
    },
  });
  assert.deepEqual(zeroBookkeeping.unresolvedBalances, []);
  assert.equal(zeroBookkeeping.balances.length, 2);
  assert.equal(zeroBookkeeping.positions.length, 1);
  const unknownBasis = projectHip4Account({
    ...args,
    state: {
      balances: [{ coin: "o8775", total: "0", hold: "0", entryNtl: "1" }],
    },
  });
  assert.deepEqual(unknownBasis.unresolvedBalances, ["o8775"]);
  assert.throws(
    () =>
      projectHip4Account({
        ...args,
        state: { balances: [position, position] },
      }),
    /duplicate_outcome/,
  );
  assert.throws(
    () =>
      projectHip4Account({
        ...args,
        state: { balances: [{ ...position, hold: "30" }] },
      }),
    /invalid_position_hold/,
  );
});
test("builder fee is counted once and transformations never become cash sales", () => {
  const entry = projectHip4Execution("mainnet", address, fill);
  assert.equal(entry.grossNotional, "1");
  assert.equal(entry.netQuoteCash, "-1.01");
  assert.deepEqual(
    projectHip4Execution("mainnet", address, {
      ...fill,
      px: "0.500",
      sz: "2.00000",
      fee: "0.010",
      builderFee: "0.0100",
      closedPnl: "0.000",
    }),
    entry,
  );
  const sale = projectHip4Execution("mainnet", address, {
    ...fill,
    dir: "Sell",
    side: "A",
  });
  assert.equal(sale.netQuoteCash, "0.99");
  assert.equal(
    projectHip4Execution("mainnet", address, { ...fill, dir: "Merge Outcome" })
      .netQuoteCash,
    null,
  );
  assert.equal(
    projectHip4Execution("mainnet", address, { ...fill, feeToken: "" })
      .netQuoteCash,
    null,
  );
  assert.notEqual(entry.id, projectHip4Execution("testnet", address, fill).id);
  assert.notEqual(
    entry.id,
    projectHip4Execution("mainnet", address, { ...fill, tid: 2 }).id,
  );
});
test("account transport reserves full response weight and cannot submit an exchange action", async () => {
  const weights: number[] = [];
  let calls = 0;
  const read = createHip4AccountClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => {
      weights.push(weight);
      return true;
    },
    async () => {
      calls++;
      return Response.json([]);
    },
  );
  await read({ type: "userRole", user: address });
  await read({ type: "userFills", user: address, aggregateByTime: false });
  await read({ type: "spotClearinghouseState", user: address });
  assert.deepEqual(weights, [60, 120, 2]);
  await assert.rejects(read({ type: "order", user: address } as never));
  assert.equal(calls, 3);
});
test("disabled account defaults and unsupported policy fields never enable trading", () => {
  assert.equal(DEFAULT_HIP4_ACCOUNT_POLICY.enabled, false);
  assert.throws(() => hip4AccountPolicySchema.parse({ tradeEnabled: true }));
  assert.throws(() => hip4AccountPolicySchema.parse({ snapshotMaxAgeMs: 0 }));
});
test("cursor is tied to environment, economic owner and market filter", () => {
  const encode = (extra: object = {}) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        environment: "mainnet",
        address,
        marketId: null,
        time: 1,
        coin: "#87750",
        tid: "1",
        oid: "2",
        ...extra,
      }),
    ).toString("base64url");
  assert.equal(
    parseHip4ExecutionCursor(encode(), "mainnet", address)?.oid,
    "2",
  );
  assert.throws(() => parseHip4ExecutionCursor(encode(), "testnet", address));
  assert.throws(() =>
    parseHip4ExecutionCursor(
      encode(),
      "mainnet",
      address,
      "hyperliquid:mainnet:outcome:8775",
    ),
  );
});
test("observation expires without a successful later refresh and unknown stays unavailable", () => {
  const base = {
    policy: DEFAULT_HIP4_READ_POLICY,
    accountPolicy: DEFAULT_HIP4_ACCOUNT_POLICY,
    revision: "test",
    address,
    now: Date.parse(observedAt),
  };
  assert.equal(
    hip4AccountReadResponse({ ...base, row: null }).state,
    "unavailable",
  );
  const observation = projectHip4Account({
    environment: "mainnet",
    observedAt,
    role: "missing",
    mode: "default",
    quote,
    state: { balances: [] },
  });
  const row = {
    observation,
    history: {},
    attempt_at: null,
    attempt_error: null,
    lease_until: null,
  };
  assert.equal(hip4AccountReadResponse({ ...base, row }).state, "fresh");
  const waiting = hip4AccountReadResponse({
    ...base,
    row: { ...row, observation: null, lease_until: new Date(base.now + 60000) },
  });
  assert.equal(waiting.refreshState, "refreshing");
  assert.equal(waiting.refreshAfterMs, DEFAULT_HIP4_READ_POLICY.policyCheckMs);
  assert.equal(
    hip4AccountReadResponse({
      ...base,
      row,
      now: base.now + DEFAULT_HIP4_ACCOUNT_POLICY.snapshotMaxAgeMs + 1,
    }).state,
    "stale",
  );
});
test("ownership and policy checks precede every cache/history read and errors stay recoverable", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  let owned = false,
    enabled = true,
    reads = 0;
  registerHip4AccountRoutes(app, {
    authorize: async (request) => {
      request.user = { id: "fixture" } as never;
      request.walletAddress = address;
    },
    owns: async () => owned,
    service: {
      market: async () => {
        reads++;
        return null;
      },
      policy: async () => ({
        readPolicy: { ...DEFAULT_HIP4_READ_POLICY, enabled: true },
        accountPolicy: { ...DEFAULT_HIP4_ACCOUNT_POLICY, enabled },
        revision: "test",
      }),
      load: async () => {
        reads++;
        throw new Error("internal_provider_payload");
      },
    },
    executions: async () => {
      reads++;
      return {
        environment: "mainnet",
        address,
        items: [],
        nextCursor: null,
        allTimeComplete: false,
      };
    },
  });
  try {
    assert.equal(
      (await app.inject("/markets/hyperliquid/canary/account")).statusCode,
      403,
    );
    assert.equal(reads, 0);
    assert.equal(
      (
        await app.inject(
          "/markets/hyperliquid/canary/account/market?marketId=hyperliquid:mainnet:outcome:8775",
        )
      ).statusCode,
      403,
    );
    assert.equal(reads, 0);
    owned = true;
    enabled = false;
    assert.equal(
      (await app.inject("/markets/hyperliquid/canary/account/executions"))
        .statusCode,
      404,
    );
    assert.equal(reads, 0);
    enabled = true;
    const failure = await app.inject("/markets/hyperliquid/canary/account");
    assert.equal(failure.statusCode, 503);
    assert.equal(failure.json().error, "hip4_account_unavailable");
    assert.equal(
      (await app.inject("/markets/hyperliquid/canary/account/executions"))
        .statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
