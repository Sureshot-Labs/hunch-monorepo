/** API/finance-worker composition only. Pure evidence modules do not import API env. */
import type { Pool } from "@hunch/infra";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import { hip4ReadPolicySchema } from "@hunch/shared";
import { env } from "../env.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  createVerifiedBuyObserver,
  createHip4NativeEvidenceFinalizer,
  type VerifiedBuyObserverDependencies,
  terminalZeroFill,
} from "./verified-buy-observer.js";
import { repairUnrecordedCopies } from "./verified-copy-repair.js";
import { EvidenceBudgetExhausted, repairVerifiedBuys } from "./verified-buy.js";
import { createEvmRpcProvider } from "./rpc-client-factory.js";
import { fetchSolanaParsedTransaction } from "./solana-rpc.js";
import { fetchLimitlessOrderStatusBatch } from "./limitless-order-status.js";
import { fetchKalshiNormalizedOrderStatus } from "./kalshi-executions.js";
import { recoverCopyPurchaseLinks } from "./social-copy.js";
import { AuthService } from "../auth.js";
import { createVerifiedRepairLaneRunner } from "./verified-repair-lanes.js";
import {
  fetchPolymarketOrderByHash,
  fetchPolymarketTrades,
} from "./polymarket-clob-l2.js";
import { createHip4AccountClient } from "./hip4-client.js";
import { admitHip4OrderEvidenceRequest } from "./hip4-order-evidence-budget.js";
import {
  claimHip4AccountRefresh,
  failHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4AccountPolicy,
  selectHip4ExactRecheckSources,
} from "./hip4-account-repository.js";
import { projectHip4Execution } from "./hip4-account-projection.js";

const runRepairLanes = createVerifiedRepairLaneRunner();

export async function runVerifiedBuyRepairJob(pool: Pool) {
  const { policy, revision } = await resolveSocialPolicy(pool);
  if (!policy.repairEnabled)
    return {
      skipped: true,
      nextIntervalSeconds: policy.repairIntervalSeconds,
      revision,
    };
  await recoverCopyPurchaseLinks(pool, policy.repairBatchSize);
  let budget = policy.repairProviderRequestBudget;
  const consume = () => {
    if (budget <= 0) throw new EvidenceBudgetExhausted(1, budget);
    budget--;
  };
  const providers = new Map<number, ReturnType<typeof createEvmRpcProvider>>();
  const readHip4Evidence = async (
    request: Parameters<ReturnType<typeof createHip4AccountClient>>[0],
  ) => {
    // Existing-admission evidence is independent of new-exposure enablement.
    // Keep both the social request budget and shared native IP-weight budget.
    consume();
    const active = await fetchActiveRuntimePolicy(
      pool,
      "hip4_read",
      new Date(),
      { missingTable: "error" },
    );
    const policy = {
      ...hip4ReadPolicySchema.parse(active?.payload ?? {}),
      environment: "mainnet" as const,
    };
    const read = createHip4AccountClient(policy, (weight) =>
      admitHip4OrderEvidenceRequest(pool, {
        environment: "mainnet",
        weight,
        policy,
        periodic: true,
      }),
    );
    return read(request);
  };
  const dependencies: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: policy.repairProviderRequestBudget,
    assertEvidenceBudget: (needed) => {
      if (needed > budget) throw new EvidenceBudgetExhausted(needed, budget);
    },
    limitlessPositionContract: env.limitlessConditionalTokensAddress,
    limitlessExchangeAddress: env.limitlessClobAddress,
    solanaCollateralMint: env.solanaUsdcMint,
    readEvmReceipt: async (chainId, hash) => {
      let provider = providers.get(chainId);
      if (!provider) {
        if (chainId !== 137 && chainId !== 8453)
          throw new Error("Unsupported observation chain");
        provider = createEvmRpcProvider(
          chainId === 137 ? env.polygonRpcUrl : env.baseRpcUrl,
          chainId,
        );
        providers.set(chainId, provider);
      }
      consume();
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) return null;
      consume();
      const finalized = await provider.getBlock("finalized");
      if (!finalized || receipt.blockNumber > finalized.number) return null;
      consume();
      const block = await provider.getBlock(receipt.blockHash);
      if (!block || block.hash !== receipt.blockHash) return null;
      return {
        receipt: {
          hash: receipt.hash,
          status: receipt.status,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: [...log.topics],
            data: log.data,
            index: log.index,
          })),
        },
        timestamp: new Date(block.timestamp * 1000).toISOString(),
      };
    },
    readFinalizedSolanaTransaction: async (signature) => {
      consume();
      return fetchSolanaParsedTransaction({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        maxAttempts: 1,
        totalTimeoutMs: env.solanaRpcTimeoutMs,
        signature,
      });
    },
    readLimitlessOrder: async ({ providerOrderId, clientOrderId }) => {
      consume();
      const found = await fetchLimitlessOrderStatusBatch([
        { orderId: providerOrderId, clientOrderId },
      ]);
      return (
        (clientOrderId
          ? found.get(`client:${clientOrderId}`)
          : providerOrderId
            ? found.get(providerOrderId)
            : null
        )?.payload ?? null
      );
    },
    readDflowOrder: async (signature) => {
      consume();
      return (await fetchKalshiNormalizedOrderStatus({ signature })).raw;
    },
    readHip4OrderStatus: async ({ environment, accountAddress, cloid }) => {
      // Evidence for an already-admitted order survives new-exposure/read
      // disablement. Protocol/resource policy and BOTH request budgets remain.
      if (environment !== "mainnet")
        throw new Error("hip4_evidence_scope_invalid");
      return readHip4Evidence({
        type: "orderStatus",
        user: accountAddress,
        oid: cloid,
      });
    },
    recheckHip4OrderFills: async ({
      environment,
      accountAddress,
      coin,
      orderId,
      timeMs,
    }) => {
      const { policy } = await readHip4AccountPolicy(pool);
      if (policy.historyRepairPagesPerRefresh <= 0)
        throw new Error("hip4_evidence_recheck_paused");
      const lease = await claimHip4AccountRefresh(
        pool,
        environment,
        accountAddress,
        policy.leaseMs,
        new Date(),
        "order_fills",
      );
      if (!lease) throw new Error("hip4_account_refresh_in_progress");
      let saved = false;
      try {
        // A single millisecond source slice, not a new account-history scan.
        // Bound the FULL response before filtering. A capped/empty page proves
        // no absence; only an actual exact provider row may clear its marker.
        const selected = selectHip4ExactRecheckSources(
          await readHip4Evidence({
            type: "userFillsByTime",
            user: accountAddress,
            startTime: timeMs,
            endTime: timeMs + 1,
            aggregateByTime: false,
          }),
          { coin, orderId, timeMs },
        );
        if (!selected.length) return;
        saved = await persistHip4AccountRefresh(pool, {
          environment,
          address: accountAddress,
          lease,
          observation: null,
          executions: selected.map((source) =>
            projectHip4Execution(environment, accountAddress, source),
          ),
          executionSources: selected,
          ledger: [],
          history: {},
          error: null,
          preserveAttemptError: true,
        });
        if (!saved) throw new Error("hip4_account_lease_lost");
      } finally {
        if (!saved)
          await failHip4AccountRefresh(
            pool,
            environment,
            accountAddress,
            lease,
            "hip4_exact_source_recheck_unavailable",
            true,
          );
      }
    },
    readPolymarketFills: async ({
      userId,
      owner,
      signer,
      orderHash,
      tokenId,
    }) => {
      const saved = await AuthService.getPolymarketCredentialsForEvidence(
        userId,
        signer,
        orderHash,
      );
      if (!saved?.apiKey || !saved.apiSecret || !saved.apiPassphrase)
        throw new Error("Provider credential unavailable");
      const common = {
        baseUrl: env.polymarketClobBase,
        timeoutMs: env.polygonRpcTimeoutMs,
        address: signer,
        creds: {
          apiKey: saved.apiKey,
          apiSecret: saved.apiSecret,
          apiPassphrase: saved.apiPassphrase,
        },
      };
      consume();
      const order = await fetchPolymarketOrderByHash({ ...common, orderHash });
      if (
        !order.ok ||
        !order.order ||
        order.order.id?.toLowerCase() !== orderHash.toLowerCase() ||
        order.order.makerAddress?.toLowerCase() !== owner.toLowerCase() ||
        order.order.assetId !== tokenId ||
        order.order.side?.toUpperCase() !== "BUY"
      )
        return [];
      if (
        terminalZeroFill({
          status: order.order.status,
          filledQuantity: order.order.sizeMatched,
          evidenceCount: order.order.associateTrades.length,
        })
      )
        return [{ provider_tx_hash: null, provider_status: "NO_FILL" }];
      if (
        order.order.associateTrades.length > policy.repairProviderRequestBudget
      )
        throw new EvidenceBudgetExhausted(
          order.order.associateTrades.length,
          policy.repairProviderRequestBudget,
        );
      const result: Array<{
        provider_tx_hash: string | null;
        provider_status: string | null;
      }> = [];
      for (const id of order.order.associateTrades) {
        consume();
        const trades = await fetchPolymarketTrades({
          ...common,
          query: { id },
        });
        if (!trades.ok) throw new Error("Provider observation unavailable");
        const trade = trades.trades.find(
          (item) =>
            item.id === id &&
            (item.takerOrderId?.toLowerCase() === orderHash.toLowerCase() ||
              item.makerOrders.some(
                (maker) =>
                  maker.orderId?.toLowerCase() === orderHash.toLowerCase(),
              )),
        );
        if (!trade) throw new Error("Provider trade identity mismatch");
        result.push({
          provider_tx_hash: trade.transactionHash,
          provider_status: trade.status,
        });
      }
      return result;
    },
  };
  const observer = createVerifiedBuyObserver(pool, dependencies);
  try {
    const { purchases, copies, firstLane } = await runRepairLanes({
      hasBudget: () => budget > 0,
      purchases: () =>
        repairVerifiedBuys(pool, {
          batchSize: policy.repairBatchSize,
          leaseSeconds: policy.repairLeaseSeconds,
          concurrency: policy.repairConcurrency,
          retrySeconds: policy.repairRetrySeconds,
          verifiedRecheckSeconds: policy.repairMaxRetrySeconds,
          observe: observer,
          finalizeNativeEvidence: createHip4NativeEvidenceFinalizer(pool),
        }),
      copies: () =>
        repairUnrecordedCopies(pool, dependencies, {
          batchSize: policy.repairBatchSize,
          concurrency: policy.repairConcurrency,
          leaseSeconds: policy.repairLeaseSeconds,
          retrySeconds: policy.repairRetrySeconds,
          recheckSeconds: policy.repairMaxRetrySeconds,
        }),
    });
    return {
      ...(purchases ?? {
        claimed: 0,
        verified: 0,
        pending: 0,
        revoked: 0,
        leaseLost: 0,
        budgetExhausted: 0,
      }),
      copies: copies ?? {
        checked: 0,
        confirmed: 0,
        revoked: 0,
        pending: 0,
        leaseLost: 0,
        budgetExhausted: 0,
      },
      firstLane,
      revision,
      nextIntervalSeconds: policy.repairIntervalSeconds,
    };
  } finally {
    for (const provider of providers.values()) provider.destroy();
  }
}
