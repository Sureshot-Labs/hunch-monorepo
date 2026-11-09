/** API/finance-worker composition only. Pure evidence modules do not import API env. */
import type { Pool } from "@hunch/infra";
import { env } from "../env.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  createVerifiedBuyObserver,
  type VerifiedBuyObserverDependencies,
} from "./verified-buy-observer.js";
import { repairUnrecordedCopies } from "./verified-copy-repair.js";
import { EvidenceBudgetExhausted, repairVerifiedBuys } from "./verified-buy.js";
import { createEvmRpcProvider } from "./rpc-client-factory.js";
import { fetchSolanaParsedTransaction } from "./solana-rpc.js";
import { fetchLimitlessVerifiedBuyOrderStatus } from "./limitless-order-status.js";
import { readCanonicalFinalizedBuyReceipt } from "./verified-buy-evm-receipt.js";
import { fetchKalshiNormalizedOrderStatus } from "./kalshi-executions.js";
import { recoverCopyPurchaseLinks } from "./social-copy.js";
import { AuthService } from "../auth.js";
import { createVerifiedRepairLaneRunner } from "./verified-repair-lanes.js";
import { readPolymarketFillCandidates } from "./verified-buy-polymarket-provider.js";
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
      return readCanonicalFinalizedBuyReceipt(provider, hash, consume);
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
      return fetchLimitlessVerifiedBuyOrderStatus({
        orderId: providerOrderId,
        clientOrderId,
      });
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
        return { state: "unavailable" };
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
      return readPolymarketFillCandidates({
        owner,
        orderHash,
        tokenId,
        consume,
        assertBudget: (needed) => {
          if (needed > budget)
            throw new EvidenceBudgetExhausted(needed, budget);
        },
        readOrder: () => fetchPolymarketOrderByHash({ ...common, orderHash }),
        readTrades: (id) => fetchPolymarketTrades({ ...common, query: { id } }),
      });
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
