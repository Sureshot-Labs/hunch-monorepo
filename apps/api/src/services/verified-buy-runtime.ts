/** API/finance-worker composition only. Pure evidence modules do not import API env. */
import type { Pool } from "@hunch/infra";
import { env } from "../env.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  createVerifiedBuyObserver,
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
