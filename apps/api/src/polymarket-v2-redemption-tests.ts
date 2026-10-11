import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { ethers, Interface } from "ethers";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
  polymarketV2PositionIdentity,
  POLYMARKET_PROTOCOL_CONTRACTS as C,
} from "@hunch/shared";
import {
  buildPolymarketV2RedemptionPlan,
  POLYMARKET_V2_MODULE_ABI as M,
  POLYMARKET_V2_POSITION_ABI as P,
  POLYMARKET_V2_ROUTER_ABI as R,
} from "./services/polymarket-v2-redemption-plan.js";
import { buildPolymarketRedemptionPlan } from "./services/polymarket-redemption-plan.js";
import { polymarketRedemptionPlanQuerySchema } from "./schemas/polymarket-private.js";
import {
  polymarketV2RedemptionIdentity,
  polymarketV2RedemptionPayout,
} from "./funding/position-actions/polymarket-v2-redemption-evidence.js";
import {
  discoverCanonicalRedemption,
  type RedemptionRecoveryRpc,
} from "./funding/position-actions/canonical-redemption-recovery.js";
import type { StoredPositionAction } from "./funding/position-actions/position-action-repository.js";
import type { RedemptionPlan } from "./services/redemption-plan.js";
import {
  safeEvmReadContract,
  SafeEvmReadError,
} from "./services/safe-evm-read.js";

const owner = "0x0000000000000000000000000000000000000017";
const amount = 1_000_001n;
const transfer = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
function context(negRisk = false, outcome: 0 | 1 = 0, base = 1n) {
  const condition =
    (BigInt(negRisk ? 2 : 1) << 248n) |
    (base << 120n) |
    (negRisk ? 3n << 104n : 0n);
  const protocol = resolvePolymarketMarketAssets({
    version: "v2",
    conditionId: ethers.toBeHex(condition, 32),
    positionIds: [condition.toString(), (condition | 1n).toString()],
    outcomes: ["Yes", "No"],
    negRisk,
  });
  return buildPolymarketAssetContext(
    "polymarket:v2-redemption-fixture",
    protocol,
    protocol.assets[outcome],
  );
}
type State = {
  balance?: bigint;
  result?: bigint[];
  moduleWrong?: boolean;
  previewWrong?: boolean;
  rpcFail?: boolean;
};
async function plan(
  state: State = {},
  assetContext = context(),
  interactive: boolean | "route" = false,
): Promise<RedemptionPlan> {
  const originalFetch = globalThis.fetch;
  const id = polymarketV2PositionIdentity(assetContext);
  const result = state.result ?? [1_000_000n, 0n];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: { to: string; data: string }[];
    };
    assert.ok(
      ["eth_getCode", "eth_call"].includes(request.method),
      "no mutating RPC in plan fixtures",
    );
    if (state.rpcFail)
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x" }),
        { headers: { "content-type": "application/json" } },
      );
    let encoded = "0x1234";
    if (request.method === "eth_call") {
      const call = request.params[0];
      assert.ok(call);
      const iface =
        call.to.toLowerCase() === C.router.toLowerCase()
          ? R
          : call.to.toLowerCase() === C.positionManager.toLowerCase()
            ? P
            : M;
      const parsed = iface.parseTransaction(call);
      assert.ok(parsed);
      let values: unknown[];
      switch (parsed.name) {
        case "POSITION_MANAGER":
          values = [C.positionManager];
          break;
        case "COLLATERAL_TOKEN":
          values = [C.collateral];
          break;
        case "moduleById":
          values = [state.moduleWrong ? owner : id.moduleAddress];
          break;
        case "balanceOf":
          values = [state.balance ?? amount * 2n];
          break;
        case "getResult":
          values = [result];
          break;
        case "getPayout": {
          assert.equal(parsed.args[0], id.positionId);
          assert.equal(
            parsed.args[1],
            amount,
            "never enlarge to full current balance",
          );
          values = [
            state.previewWrong
              ? 123n
              : (amount * (result[assetContext.outcomeIndex] ?? 0n)) /
                1_000_000n,
          ];
          break;
        }
        default:
          throw new Error(`unexpected ${parsed.name}`);
      }
      encoded = iface.encodeFunctionResult(parsed.name, values);
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: encoded }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    if (interactive === "route") {
      const { AuthService } = await import("./auth.js");
      const { buildPolymarketRedemptionPlanRoute } =
        await import("./services/polymarket-trading-execution-service.js");
      const originalCredentials = AuthService.getVenueCredentialsInfo;
      AuthService.getVenueCredentialsInfo = async () => null;
      const reads: string[] = [];
      const db = {
        query: async (sql: string, params: unknown[]) => {
          assert.match(sql.trim(), /^select/i, "plan endpoint only reads");
          reads.push(sql);
          if (!sql.includes("from polymarket_asset_bindings"))
            return { rows: [] };
          assert.deepEqual(params, [
            137,
            assetContext.assetId,
            C.positionManager.toLowerCase(),
          ]);
          return {
            rows: [
              {
                chain_id: 137,
                position_contract: C.positionManager,
                asset_id: assetContext.assetId,
                market_id: assetContext.marketId,
                protocol_version: "v2",
                asset_kind: "position_manager",
                condition_id: assetContext.conditionId,
                outcome_index: assetContext.outcomeIndex,
                neg_risk: assetContext.negRisk,
                exchange_address: C.exchangeV3,
                order_domain_version: "3",
                conditional_asset_type: "CONDITIONAL-V2",
              },
            ],
          };
        },
      } as unknown as Pool;
      try {
        const result = await buildPolymarketRedemptionPlanRoute({
          userId: "interactive-fixture",
          signer: owner,
          pool: db,
          query: {
            funderAddress: owner,
            tokenId: assetContext.assetId,
            outcome: assetContext.outcomeIndex === 0 ? "YES" : "NO",
            positionContract: C.positionManager,
            positionSize: "1.000001",
            conditionId: `0x${"ff".repeat(32)}`,
            negRisk: !assetContext.negRisk,
          },
        });
        assert.equal(result.ok, true);
        assert.ok(
          reads.some((sql) => sql.includes("from polymarket_asset_bindings")),
          "archived token uses durable ledger binding",
        );
        return result.payload as RedemptionPlan;
      } finally {
        AuthService.getVenueCredentialsInfo = originalCredentials;
      }
    }
    if (interactive)
      return await buildPolymarketRedemptionPlan({
        rpcUrl: `mock://interactive-poly-v2-${Math.random()}`,
        timeoutMs: 300,
        funder: owner,
        assetContext,
        positionSize: "1.000001",
        positionTokenId: assetContext.assetId,
        outcome: assetContext.outcomeIndex === 0 ? "YES" : "NO",
        // Stale legacy market hints must not cause the V2 path to read CTF.
        conditionalTokensAddress: C.conditionalTokens,
        collateralTokenAddress: C.collateral,
        negRiskAdapterAddress: null,
        isNegRisk: false,
        conditionId: `0x${"ff".repeat(32)}`,
      });
    return await buildPolymarketV2RedemptionPlan({
      rpcUrl: `mock://poly-v2-${Math.random()}`,
      timeoutMs: 300,
      funder: owner,
      assetContext,
      positionSize: "1.000001",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
function operation(redemptionPlan: RedemptionPlan): StoredPositionAction {
  const asset = redemptionPlan.assetContext;
  assert.ok(asset);
  return {
    action: "redeem",
    venueId: "polymarket",
    marketId: asset.marketId,
    ownerAddress: owner,
    planSnapshot: {
      tokenId: asset.assetId,
      assetContext: asset,
      positionContract: asset.positionContract.toLowerCase(),
      outcome: asset.outcomeIndex === 0 ? "YES" : "NO",
      plan: JSON.parse(JSON.stringify(redemptionPlan)),
    },
  } as unknown as StoredPositionAction;
}
const event = (
  iface: Interface,
  address: string,
  name: string,
  values: unknown[],
) => ({ address, ...iface.encodeEventLog(name, values) });
function consumption(op: StoredPositionAction) {
  const identity = polymarketV2RedemptionIdentity(op);
  assert.ok(identity);
  return [
    event(P, C.positionManager, "TransferSingle", [
      C.router,
      owner,
      identity.moduleAddress,
      identity.positionId,
      identity.amount,
    ]),
    event(P, C.positionManager, "TransferSingle", [
      identity.moduleAddress,
      identity.moduleAddress,
      ethers.ZeroAddress,
      identity.positionId,
      identity.amount,
    ]),
    event(M, identity.moduleAddress, "PositionRedeemed", [
      C.router,
      identity.positionId,
      owner,
      identity.amount,
      identity.payout,
    ]),
    event(R, C.router, "RouterPositionRedeemed", [
      owner,
      identity.positionId,
      identity.amount,
    ]),
  ];
}
function mint(value: bigint, sender = ethers.ZeroAddress) {
  return event(transfer, C.collateral, "Transfer", [sender, owner, value]);
}
const ready = await plan();
for (const negRisk of [false, true])
  for (const outcome of [0, 1] as const) {
    const assetContext = context(negRisk, outcome);
    const interactive = await plan({}, assetContext, true);
    assert.equal(interactive.redeemable, true);
    assert.equal(interactive.positionContract, C.positionManager);
    assert.equal(interactive.targetAddress, C.router);
    assert.equal(interactive.operatorApprovalAddress, C.router);
    assert.equal(interactive.assetContext?.assetId, assetContext.assetId);
    assert.equal(interactive.redeemAmountRaw, amount.toString());
    const endpoint = await plan({}, assetContext, "route");
    assert.equal(endpoint.redeemable, true);
    assert.equal(endpoint.positionContract, C.positionManager);
    assert.equal(endpoint.assetContext?.assetId, assetContext.assetId);
    assert.equal(endpoint.redeemAmountRaw, amount.toString());
  }
for (const positionSize of [undefined, "0", "-1", "1.0000001", "1e6"]) {
  const assetContext = context();
  const unavailable = await buildPolymarketRedemptionPlan({
    rpcUrl: "mock://no-read",
    timeoutMs: 300,
    funder: owner,
    assetContext,
    positionSize,
    positionTokenId: assetContext.assetId,
    outcome: "YES",
    conditionalTokensAddress: C.conditionalTokens,
    collateralTokenAddress: C.collateral,
    negRiskAdapterAddress: null,
    isNegRisk: false,
  });
  assert.equal(unavailable.redeemable, false);
  assert.equal(unavailable.reason, "no_redeemable_balance");
}
const v2Query = {
  tokenId: context().assetId,
  outcome: "YES",
  positionContract: C.positionManager,
  positionSize: "1.000001",
};
assert.equal(
  polymarketRedemptionPlanQuerySchema.safeParse(v2Query).success,
  true,
);
assert.equal(
  polymarketRedemptionPlanQuerySchema.safeParse({
    tokenId: "1",
    outcome: "YES",
  }).success,
  true,
);
for (const value of ["-1", "1e6", "1.0000001", "NaN"])
  assert.equal(
    polymarketRedemptionPlanQuerySchema.safeParse({
      ...v2Query,
      positionSize: value,
    }).success,
    false,
  );
assert.equal(
  polymarketRedemptionPlanQuerySchema.safeParse({
    ...v2Query,
    positionContract: C.exchangeV3,
  }).success,
  false,
);
assert.equal(ready.redeemable, true);
assert.equal(ready.redeemAmountRaw, amount.toString());
assert.equal(ready.operatorApprovalAddress, C.router);
assert.equal(R.decodeFunctionData("redeem", ready.data ?? "0x")[2], amount);
assert.equal(
  (await plan({ balance: amount - 1n })).reason,
  "no_redeemable_balance",
);
assert.equal((await plan({ result: [] })).reason, "condition_unresolved");
assert.equal((await plan({ moduleWrong: true })).reason, "adapter_unavailable");
assert.equal(
  (await plan({ previewWrong: true })).reason,
  "adapter_unavailable",
);
assert.equal(
  (await plan({ result: [500_000n, 499_999n] })).reason,
  "adapter_unavailable",
);
assert.equal((await plan({ rpcFail: true })).reason, "preflight_unavailable");
const fraction = await plan({ result: [333_333n, 666_667n] }, context(true));
assert.equal(
  fraction.expectedPayoutRaw,
  ((amount * 333_333n) / 1_000_000n).toString(),
  "integer floor matches module",
);
const loser = await plan({}, context(false, 1));
assert.equal(
  loser.redeemable,
  true,
  "resolved loser can consume exact shares with zero payout",
);
assert.equal(loser.expectedPayoutRaw, "0");
const invalid = { ...context(), assetId: "1" };
assert.equal(
  (
    await buildPolymarketV2RedemptionPlan({
      rpcUrl: "mock://not-called",
      timeoutMs: 300,
      funder: owner,
      assetContext: invalid,
      positionSize: "1",
    })
  ).reason,
  "missing_token_id",
);
assert.throws(
  () =>
    polymarketV2PositionIdentity({
      ...context(),
      conditionId: ethers.toBeHex(
        BigInt(context().conditionId) | (137n << 24n),
        32,
      ),
    }),
  /identity/,
);
const op = operation(ready);
const logs = [...consumption(op), mint(amount)];
const receipt = { succeeded: true, logs };
assert.equal(polymarketV2RedemptionPayout(op, receipt), amount);
for (let i = 0; i < logs.length; i++)
  assert.equal(
    polymarketV2RedemptionPayout(op, {
      ...receipt,
      logs: logs.filter((_, index) => index !== i),
    }),
    null,
    `missing evidence ${i}`,
  );
assert.equal(
  polymarketV2RedemptionPayout(op, { ...receipt, succeeded: false }),
  null,
);
assert.equal(
  polymarketV2RedemptionPayout(op, {
    ...receipt,
    logs: [...consumption(op), mint(amount, C.router)],
  }),
  null,
  "pUSD is minted, not transferred from Router",
);
assert.equal(
  polymarketV2RedemptionPayout(op, {
    ...receipt,
    logs: [...logs, logs[3] as (typeof logs)[number]],
  }),
  null,
  "duplicate redemption event",
);
assert.equal(
  polymarketV2RedemptionPayout(op, {
    ...receipt,
    logs: logs.map((log, index) => ({
      ...log,
      logIndex: index === 4 ? 3 : index,
    })),
  }),
  null,
  "duplicate RPC log index",
);
assert.equal(
  polymarketV2RedemptionPayout(op, {
    ...receipt,
    logs: logs.map((log, index) =>
      index === 0 ? { ...log, address: C.conditionalTokens } : log,
    ),
  }),
  null,
  "wrong asset ledger",
);
assert.equal(
  polymarketV2RedemptionPayout(operation(loser), {
    succeeded: true,
    logs: consumption(operation(loser)),
  }),
  0n,
  "zero payout requires full independent consumption proof",
);
const sibling = operation(await plan({}, context(false, 0, 2n)));
const bundled = {
  succeeded: true,
  logs: [...consumption(op), ...consumption(sibling), mint(amount * 2n)],
};
assert.equal(polymarketV2RedemptionPayout(op, bundled), amount);
assert.equal(polymarketV2RedemptionPayout(sibling, bundled), amount);
const hash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const rpc: RedemptionRecoveryRpc = {
  finalizedBlock: async () => 2000n,
  timestamp: async (block) => block,
  logs: async (from, to, target) => {
    assert.equal(target, C.router);
    const log = consumption(op)[3];
    assert.ok(log);
    return from <= 1250n && to >= 1250n
      ? [{ ...log, blockNumber: 1250n, transactionHash: hash, blockHash }]
      : [];
  },
  receipt: async () => ({ ...receipt, blockNumber: 1250, blockHash }),
  blockHash: async () => blockHash,
};
assert.equal(
  await discoverCanonicalRedemption(
    op,
    new Date(1200 * 1000),
    C.positionManager,
    rpc,
  ),
  hash,
  "missing submission recovered without execution",
);
console.log(
  "[polymarket-v2-redemption-tests] exact Router amount, resolution, module, zero payout, bundled receipts and recovery passed",
);
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => {
    throw new Error("fixture transport failure");
  };
  await assert.rejects(
    () =>
      safeEvmReadContract({
        rpcUrl: `mock://code-failure-${Math.random()}`,
        timeoutMs: 300,
        target: C.router,
        iface: R,
        functionName: "COLLATERAL_TOKEN",
      }),
    (error: unknown) =>
      error instanceof SafeEvmReadError && error.reason === "rpc_error",
  );
} finally {
  globalThis.fetch = originalFetch;
}
