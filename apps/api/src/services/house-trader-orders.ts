import { randomBytes } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";
import {
  adverseEntry,
  costBasisForShares,
  priceExit,
  usdRaw,
  type HouseTraderPolicy,
} from "./house-trader-policy.js";
import {
  boundary,
  finish,
  finishHouseZeroFill,
  houseBuyEligibility,
  houseSellPosition,
  reserveBuy,
  type Account,
  type Action,
} from "./house-trader-store.js";
import { houseModel } from "./house-trader-ai.js";
import type { HouseWallet } from "./house-trader-wallet.js";
import { signHouseOrder } from "./polymarket-order-signature.js";
import {
  assertPolymarketFokDepth,
  calculatePolymarketQuote,
  loadPolymarketQuoteContext,
  PolymarketQuoteError,
  quotePolymarketMarketBuyWithinBudget,
} from "./polymarket-quote.js";
import {
  reconcilePolymarketTerminalOrder,
  invalidatePolymarketCredentialsForInvalidApiKey,
  submitPolymarketClientSignedOrder,
  syncPolymarketBalanceAllowanceRoute,
  syncPolymarketOrdersRoute,
} from "./polymarket-trading-execution-service.js";
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";
import { AuthService } from "../auth.js";
import { env } from "../env.js";
import {
  fetchPolymarketOrderByHash,
  fetchPolymarketTrades,
} from "./polymarket-clob-l2.js";
import { readPolymarketFillCandidates } from "./verified-buy-polymarket-provider.js";
import { EvidenceBudgetExhausted } from "./verified-buy.js";
import { fetchEmbeddedEthereumTransactionReceipt } from "./embedded-ethereum.js";
import {
  parsePolymarketAssetContext,
  type PolymarketAssetContext,
} from "@hunch/shared";
import { houseTradeReceipt } from "./house-trader-receipts.js";
import {
  HOUSE_MAX_FILL_EVIDENCE,
  houseAcknowledgedTransactionHashes,
  readHouseStoredOrder,
  readHouseTransactionHashes,
  resolveHouseFillLocators,
} from "./house-trader-fill-evidence.js";
import type { PolymarketFillObservation } from "./verified-buy-observer.js";
import { storeOrder } from "../repos/orders-repo.js";

export async function trackedShares(
  pool: Pool,
  accountId: string,
  positionId: string,
  token: string,
) {
  const {
    rows: [row],
  } = await pool.query<{ entryShares: string | null; exited: string }>(
    `select entry.result->>'fillSharesRaw' as "entryShares",
      coalesce((select sum((exit_row.result->>'fillSharesRaw')::numeric) from house_trader_actions exit_row
        where exit_row.account_user_id=$1 and exit_row.request->>'positionId'=$2
          and exit_row.state='done' and exit_row.kind in ('sell','redeem')),0)::text as exited
       from house_trader_actions entry where entry.id=$2::uuid and entry.account_user_id=$1
         and entry.token_id=$3 and entry.kind='buy' and entry.state='filled'`,
    [accountId, positionId, token],
  );
  return row?.entryShares ? BigInt(row.entryShares) - BigInt(row.exited) : 0n;
}

export async function contextFor(
  pool: Pool,
  job: Action,
  held?: PolymarketAssetContext,
) {
  if (!job.token_id || !job.market_id || !job.outcome)
    throw new Error("instrument_missing");
  const context = await loadPolymarketQuoteContext(pool, {
    tokenId: job.token_id,
    freshBook: true,
  });
  const instrument = context.assetContext;
  if (
    !instrument ||
    instrument.marketId !== job.market_id ||
    instrument.assetId !== job.token_id ||
    instrument.outcomeIndex !== (job.outcome === "YES" ? 0 : 1)
  )
    throw new Error("instrument_changed");
  if (
    held &&
    JSON.stringify(parsePolymarketAssetContext(instrument)) !==
      JSON.stringify(parsePolymarketAssetContext(held))
  )
    throw new Error("position_binding_changed");
  const priorContract = job.result.positionContract;
  if (priorContract && priorContract !== instrument.positionContract)
    throw new Error("instrument_generation_changed");
  if (
    job.kind === "buy" &&
    typeof job.request.generation === "string" &&
    job.request.generation !==
      `${instrument.chainId}:${instrument.positionContract.toLowerCase()}:${instrument.protocolVersion}`
  )
    throw new Error("instrument_generation_changed");
  return { context, instrument };
}

export async function evidenceFor(
  pool: Pool,
  market: string,
  event: string | null,
) {
  const { rows } = await pool.query<{
    id: string;
    text: string;
    at: Date;
    urls: unknown;
    fact: unknown;
  }>(
    `with target_candidates as materialized (
        select note_id from ai_note_targets where target_id=$1 and target_kind='market'
        union
        select note_id from ai_note_targets where target_id=$2 and target_kind='event'
      )
      select note_row.id,note_row.updated_at as at,left(note_row.title || ': ' || note_row.description,440) as text,
        note_row.model_meta->'public_source_citations' as urls,
        note_row.model_meta #> '{external_research,freshFact}' as fact
      from target_candidates join ai_notes note_row on note_row.id=target_candidates.note_id
      where note_row.status='active' and note_row.updated_at>=now()-interval '2 days'
        and note_row.producer_type in ('holder_research','map_signals','agent_theses')
      order by note_row.updated_at desc,note_row.id desc limit 6`,
    [market, event],
  );
  return rows.map(({ id, at, text, urls, fact }) => ({
    id,
    at: at.toISOString(),
    text,
    savedNews:
      fact &&
      typeof fact === "object" &&
      (fact as Record<string, unknown>).matchesExactContract === true &&
      (fact as Record<string, unknown>).trackerUpdateOnly === false
        ? fact
        : null,
    citations: Array.isArray(urls)
      ? urls.slice(0, 2).map((entry) => ({
          url: typeof entry?.url === "string" ? entry.url.slice(0, 200) : null,
          title:
            typeof entry?.title === "string" ? entry.title.slice(0, 100) : null,
        }))
      : [],
  }));
}

export function indicativeSellQuote(
  context: Awaited<ReturnType<typeof loadPolymarketQuoteContext>>,
  token: string,
  amount: bigint,
  policy: HouseTraderPolicy,
) {
  return calculatePolymarketQuote({
    context,
    tokenId: token,
    side: "SELL",
    orderType: "FOK",
    amountType: "shares",
    amountSharesRawInput: amount,
    slippageBps: policy.slippageBps,
    strictSlippage: true,
  });
}

export function sellQuote(
  context: Awaited<ReturnType<typeof loadPolymarketQuoteContext>>,
  token: string,
  amount: bigint,
  policy: HouseTraderPolicy,
) {
  const quote = indicativeSellQuote(context, token, amount, policy);
  assertPolymarketFokDepth(context.orderbook, quote);
  return quote;
}

export function sellNet(
  quote: Pick<
    ReturnType<typeof sellQuote>,
    "takerAmount" | "totalFeeEstimateRaw"
  >,
) {
  return BigInt(quote.takerAmount) - BigInt(quote.totalFeeEstimateRaw);
}

export async function assertHouseFokBeforeSubmit(
  context: Awaited<ReturnType<typeof loadPolymarketQuoteContext>>,
  quote: ReturnType<typeof sellQuote>,
  refresh: () => Promise<
    Awaited<ReturnType<typeof loadPolymarketQuoteContext>>
  >,
) {
  const isFresh = (book: typeof context) => {
    const expires = Date.parse(book.bookSnapshot?.expiresAt ?? "");
    return Number.isFinite(expires) && expires > Date.now();
  };
  const current = isFresh(context) ? context : await refresh();
  if (!isFresh(current))
    throw new PolymarketQuoteError(
      502,
      "Orderbook expired before submission",
      "stale_orderbook",
    );
  // Keep the already signed amounts and limit. A refreshed book may prove
  // they cannot be filled; it must never reprice or replace the order.
  assertPolymarketFokDepth(current.orderbook, quote);
}

export async function doTrade(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
) {
  const auto = job.request.automatic === true;
  if (
    !a.deposit_wallet ||
    !a.settings ||
    !job.token_id ||
    !job.market_id ||
    (auto && (!a.active || a.revision !== job.revision))
  )
    return finish(pool, job, "skipped", "strategy_changed_or_paused");
  const side = job.kind === "buy" ? "BUY" : "SELL";
  if (side === "BUY") {
    const reason = await houseBuyEligibility(pool, a, job);
    if (reason) return finish(pool, job, "skipped", reason);
  }
  if (
    !(await venueLifecycleAllowsTradingAction(pool, "polymarket", side, {
      automation: auto,
    }))
  )
    return finish(pool, job, "skipped", "venue_disabled");
  const uncertain = await pool.query(
    `select 1 from house_trader_actions where account_user_id=$1 and id<>$2
       and state in ('submitting','submitted') and
         ((kind='withdraw' and coalesce(result->>'phase','')<>'sweep') or token_id=$4 or ($3='BUY' and kind='setup')) limit 1`,
    [a.user_id, job.id, side, job.token_id],
  );
  if (uncertain.rows.length)
    return finish(pool, job, "skipped", "outstanding_submission");
  const policy = a.settings;
  const position = side === "SELL" ? await houseSellPosition(pool, job) : null;
  const held =
    position && parsePolymarketAssetContext(position.result.assetContext);
  if (side === "SELL" && !held)
    return finish(pool, job, "skipped", "position_binding_unavailable");
  let { context, instrument } = await contextFor(pool, job, held ?? undefined);
  const token = job.token_id;
  let quote: ReturnType<typeof sellQuote>;
  let decisionReason = auto
    ? String(job.request.trigger ?? "signal")
    : "manual_sell";
  if (side === "BUY") {
    const balance = await wallet.balance(a.deposit_wallet);
    let size = usdRaw(policy.fixedBuyUsd);
    if (policy.aiEntry) {
      const tentative = quotePolymarketMarketBuyWithinBudget({
        context,
        tokenId: token,
        budgetRaw: size,
        executableFundsRaw: size < balance ? size : balance,
        slippageBps: policy.slippageBps,
        minimumNominalRaw: 1_000_000n,
      });
      if (
        adverseEntry(
          Number(tentative.price),
          Number(job.request.entry),
          policy.maxAdverseBps,
        )
      )
        return finish(pool, job, "skipped", "price_moved");
      const { decision: model, reason: unavailable } = await houseModel(
        pool,
        job,
        policy,
        "entry",
        {
          side: job.outcome,
          signalId: job.request.noteId,
          signalPublishedAt: job.request.publishedAt,
          entryAsk: job.request.entry,
          quote: tentative.price,
          balanceRaw: balance.toString(),
          category: job.request.category,
          closesAt: job.request.closesAt,
          evidence: await evidenceFor(pool, job.market_id, job.event_id),
        },
      );
      if (!model || model.action !== "buy")
        return finish(pool, job, "skipped", model?.reason ?? unavailable);
      size = usdRaw(model.buyUsd);
      if (
        size < usdRaw(policy.minAiBuyUsd) ||
        size > usdRaw(policy.maxOrderUsd)
      )
        return finish(pool, job, "skipped", "ai_size_outside_limits");
      decisionReason = model.reason;
      ({ context, instrument } = await contextFor(pool, job));
    }
    quote = quotePolymarketMarketBuyWithinBudget({
      context,
      tokenId: token,
      budgetRaw: size,
      executableFundsRaw: size < balance ? size : balance,
      slippageBps: policy.slippageBps,
      minimumNominalRaw: 1_000_000n,
    });
    const signedPrice = Number(quote.makerAmount) / Number(quote.takerAmount);
    if (
      adverseEntry(signedPrice, Number(job.request.entry), policy.maxAdverseBps)
    )
      return finish(pool, job, "skipped", "price_moved");
    const spend = BigInt(quote.totalRequiredUsdcRaw ?? "0");
    if (spend <= 0n || spend > size)
      return finish(pool, job, "skipped", "invalid_or_expired_quote");
    const why = await reserveBuy(pool, job, spend, balance);
    if (why) return finish(pool, job, "skipped", why);
  } else {
    const observed = await wallet.position(
      a.deposit_wallet,
      instrument.positionContract,
      token,
    );
    if (typeof job.request.positionId !== "string")
      return finish(pool, job, "skipped", "position_not_found");
    const tracked = await trackedShares(
      pool,
      a.user_id,
      job.request.positionId,
      token,
    );
    const available = observed < tracked ? observed : tracked;
    if (available <= 0n)
      return finish(pool, job, "skipped", "no_sellable_position");
    let amount = auto ? available : usdRaw(String(job.request.shares));
    const basis =
      auto && position
        ? {
            raw: String(position.result.cashDeltaRaw),
            units: String(position.result.fillSharesRaw),
          }
        : null;
    const remainingCost = basis
      ? costBasisForShares(-BigInt(basis.raw), BigInt(basis.units), available)
      : null;
    if (auto && remainingCost === null)
      return finish(pool, job, "skipped", "position_cost_unavailable");
    if (auto && job.request.trigger === "ai") {
      if (!policy.aiExit) return finish(pool, job, "skipped", "ai_disabled");
      const full = indicativeSellQuote(context, token, available, policy);
      const { decision: model, reason: unavailable } = await houseModel(
        pool,
        job,
        policy,
        "exit",
        {
          side: job.outcome,
          bid: full.price,
          feeAdjustedProceedsRaw: sellNet(full).toString(),
          sharesRaw: available.toString(),
          entryCostRaw: remainingCost?.toString(),
          evidence: await evidenceFor(pool, job.market_id, job.event_id),
        },
      );
      if (!model || model.action !== "sell")
        return finish(pool, job, "skipped", model?.reason ?? unavailable);
      if (model.sellBps <= 0 || model.sellBps > policy.aiMaxSellBps)
        return finish(pool, job, "skipped", "ai_exit_outside_limits");
      amount = (available * BigInt(model.sellBps)) / 10_000n;
      decisionReason = model.reason;
      ({ context, instrument } = await contextFor(
        pool,
        job,
        held ?? undefined,
      ));
    }
    if (amount <= 0n || amount > available)
      return finish(pool, job, "skipped", "shares_changed");
    quote = sellQuote(context, token, amount, policy);
    if (BigInt(quote.makerAmount) > amount || sellNet(quote) <= 0n)
      return finish(pool, job, "skipped", "sell_quote_unavailable");
    if (auto && job.request.trigger === "price") {
      const currentCost = basis
        ? costBasisForShares(
            -BigInt(basis.raw),
            BigInt(basis.units),
            BigInt(quote.makerAmount),
          )
        : null;
      const cause =
        currentCost === null
          ? null
          : priceExit(sellNet(quote), currentCost, policy);
      if (!cause) return finish(pool, job, "skipped", "exit_threshold_not_met");
      decisionReason = cause;
    }
    if (!auto) {
      if (!job.request.confirmedBy)
        return finish(pool, job, "review", "confirm_preview", {
          quote: {
            netRaw: sellNet(quote).toString(),
            shares: quote.makerAmount,
            price: quote.price,
            positionContract: instrument.positionContract,
          },
        });
      const preview = job.result.quote as
        | { netRaw: string; positionContract: string; shares: string }
        | undefined;
      if (
        !preview ||
        preview.positionContract !== instrument.positionContract ||
        preview.shares !== quote.makerAmount ||
        sellNet(quote) < BigInt(preview.netRaw)
      )
        return finish(pool, job, "skipped", "sell_preview_changed");
    }
  }
  const order = {
    salt: BigInt(`0x${randomBytes(6).toString("hex")}`).toString(),
    maker: a.deposit_wallet,
    signer: a.deposit_wallet,
    tokenId: token,
    side: side === "BUY" ? 0 : 1,
    makerAmount: quote.makerAmount,
    takerAmount: quote.takerAmount,
    signatureType: 3,
    timestamp: Date.now().toString(),
    metadata: ethers.ZeroHash,
    builder: context.feePolicySnapshot.builderCode ?? ethers.ZeroHash,
  };
  const signature = await signHouseOrder(wallet.key, {
    order,
    exchange: instrument.exchangeAddress,
    version: instrument.orderDomainVersion,
  });
  const allowance = await syncPolymarketBalanceAllowanceRoute({
    userId: a.user_id,
    signer: wallet.key.address,
    body:
      side === "BUY"
        ? { assetType: "COLLATERAL", signatureType: 3 }
        : {
            assetType: instrument.conditionalAssetType,
            assetContext: instrument,
            tokenId: token,
            signatureType: 3,
          },
  });
  if (!allowance.ok)
    return finish(pool, job, "skipped", "venue_balance_sync_unavailable");
  const result = await submitPolymarketClientSignedOrder({
    pool,
    signer: wallet.key.address,
    userId: a.user_id,
    body: {
      order: { ...order, signature, expiration: "0" },
      assetContext: instrument,
      orderType: "FOK",
      ...(side === "SELL" ? { positionWalletAddress: a.deposit_wallet } : {}),
    },
    beforeSubmit: async (hash) => {
      if (
        !(await venueLifecycleAllowsTradingAction(pool, "polymarket", side, {
          automation: auto,
        }))
      )
        throw new Error("venue_disabled");
      await assertHouseFokBeforeSubmit(
        context,
        quote,
        async () => (await contextFor(pool, job, instrument)).context,
      );
      await boundary(pool, job, hash, {
        decisionReason,
        quotePrice: quote.price,
        makerRaw: quote.makerAmount,
        takerRaw: quote.takerAmount,
        positionContract: instrument.positionContract,
        assetContext: instrument,
      });
    },
    onDefinitiveRejection: () =>
      finish(pool, job, "skipped", "venue_definitive_rejection"),
  });
  const row = (
    await pool.query<Action>("select * from house_trader_actions where id=$1", [
      job.id,
    ])
  ).rows[0];
  if (row.state === "skipped") return;
  if (result.ok)
    await finish(pool, job, "submitted", null, {
      venueOrderId: result.payload.orderId,
      acknowledgedExecution: result.payload.status === "matched",
      acknowledgedTransactionHashes: houseAcknowledgedTransactionHashes(
        result.payload.payload,
        result.payload.orderId,
        result.payload.orderHash,
      ),
    });
  else {
    if (row.state === "working")
      await finish(pool, job, "skipped", "trade_preflight_rejected");
    else
      await finish(
        pool,
        job,
        "submitted",
        "trade_response_requires_reconciliation",
      );
  }
}

export async function observeTrade(
  pool: Pool,
  a: Account,
  job: Action,
  budget: { remaining: number; receiptsRemaining: number },
) {
  const instrument = parsePolymarketAssetContext(job.result.assetContext);
  if (
    !a.controller ||
    !job.reference ||
    !a.deposit_wallet ||
    !instrument ||
    instrument.assetId !== job.token_id ||
    instrument.marketId !== job.market_id ||
    (instrument.outcomeIndex === 0 ? "YES" : "NO") !== job.outcome
  )
    return finish(pool, job, "submitted", "order_identity_unavailable");
  const hash = job.reference;
  const side = job.kind === "buy" ? "BUY" : "SELL";
  const signer = a.controller;
  const stored = await readHouseStoredOrder(pool, {
    userId: a.user_id,
    hash,
    owner: a.deposit_wallet,
    signer,
    asset: instrument,
    side,
  });
  if (stored.state !== "ok")
    return finish(
      pool,
      job,
      "submitted",
      stored.state === "limit"
        ? "fill_evidence_limit_review"
        : "stored_order_identity_conflict",
    );
  const current = await AuthService.getVenueCredentials(
    a.user_id,
    "polymarket",
    a.controller,
  );
  const acknowledged = readHouseTransactionHashes(
    job.result.acknowledgedTransactionHashes,
  ).map((hash) => ({ provider_tx_hash: hash, provider_status: null }));
  const local = [...stored.fills, ...acknowledged];
  const hasCredentials =
    current?.apiKey && current.apiSecret && current.apiPassphrase;
  if (!hasCredentials && !local.length)
    return finish(pool, job, "submitted", "clob_credentials_pending");
  let result: PolymarketFillObservation = { state: "unavailable" };
  if (current?.apiKey && current.apiSecret && current.apiPassphrase) {
    const request = {
      baseUrl: env.polymarketClobBase,
      address: a.controller,
      timeoutMs: 8_000,
      creds: {
        apiKey: current.apiKey,
        apiSecret: current.apiSecret,
        apiPassphrase: current.apiPassphrase,
      },
    };
    result = await readPolymarketFillCandidates({
      owner: a.deposit_wallet,
      orderHash: hash,
      tokenId: instrument.assetId,
      side,
      consume: () => {
        if (budget.remaining <= 0) throw new EvidenceBudgetExhausted(1, 0);
        budget.remaining--;
      },
      assertBudget: (count) => {
        const available = Math.min(HOUSE_MAX_FILL_EVIDENCE, budget.remaining);
        if (count > available)
          throw new EvidenceBudgetExhausted(count, available);
      },
      readOrder: async () => {
        const read = await fetchPolymarketOrderByHash({
          ...request,
          orderHash: hash,
        });
        if (!read.ok)
          await invalidatePolymarketCredentialsForInvalidApiKey({
            endpoint: "house-trader-order-observe",
            signer,
            upstream: read,
            userId: a.user_id,
          });
        return read;
      },
      readTrades: async (id) => {
        const read = await fetchPolymarketTrades({ ...request, query: { id } });
        if (!read.ok)
          await invalidatePolymarketCredentialsForInvalidApiKey({
            endpoint: "house-trader-fill-observe",
            signer,
            upstream: read,
            userId: a.user_id,
          });
        return read;
      },
    });
  }
  const locators = resolveHouseFillLocators(
    local,
    result,
    stored.hasExecution || job.result.acknowledgedExecution === true,
  );
  if ("noFill" in locators) return finishHouseZeroFill(pool, job, hash);
  if ("pending" in locators)
    return finish(pool, job, "submitted", locators.pending);
  const { hashes } = locators;
  if (hashes.length > budget.receiptsRemaining)
    throw new EvidenceBudgetExhausted(hashes.length, budget.receiptsRemaining);
  let cash = 0n,
    shares = 0n,
    maker = 0n;
  for (const txHash of hashes) {
    budget.receiptsRemaining--;
    const receipt = await fetchEmbeddedEthereumTransactionReceipt({
      chainId: 137,
      txHash,
      requireFinalized: true,
    });
    if (!receipt)
      return finish(
        pool,
        job,
        "submitted",
        "polygon_finalized_receipt_pending",
      );
    if (!receipt.succeeded)
      return finish(pool, job, "submitted", "polygon_fill_reverted");
    const observed = houseTradeReceipt(receipt.logs, {
      hash,
      exchange: instrument.exchangeAddress,
      owner: a.deposit_wallet,
      tokenId: instrument.assetId,
      ledger: instrument.positionContract,
      collateral: env.polymarketPusdAddress,
      side,
    });
    if (!observed)
      return finish(pool, job, "submitted", "polygon_fill_receipt_mismatch");
    cash += observed.cash;
    shares += observed.shares;
    maker += observed.maker;
  }
  // FOK must match the full signed maker quantity. For BUY the actual cash may
  // include fees and price improvement; never use the quote as actual cost.
  if (maker !== BigInt(String(job.result.makerRaw)))
    return finish(pool, job, "submitted", "polygon_fill_amount_mismatch");
  const price = Number(cash < 0n ? -cash : cash) / Number(shares);
  if (!stored.venueOrderId)
    await storeOrder(pool, {
      userId: a.user_id,
      walletAddress: a.deposit_wallet,
      signerAddress: a.controller,
      venue: "polymarket",
      venueOrderId: hash,
      tokenId: instrument.assetId,
      side,
      orderType: "FOK",
      price,
      size: Number(shares) / 1e6,
      status: "matched",
      errorMessage: null,
      rawError: null,
      orderHash: hash,
      orderPayloadVersion: "polymarket_clob_v2",
      orderPayload: {
        assetContext: instrument,
        makerAmount: job.result.makerRaw,
        takerAmount: job.result.takerRaw,
      },
      fundingRecoveryMode: "explicit_only",
    });
  const venueOrderId = stored.venueOrderId ?? hash;
  const terminal = await reconcilePolymarketTerminalOrder({
    userId: a.user_id,
    venueOrderId,
    statusHint: "matched",
    externalFilledSize: Number(shares) / 1e6,
    externalFillPrice: price,
    externalHasExecution: true,
    allowExternalExecutionEvidence: true,
    skipOnchainExecutionCheck: true,
  });
  if (terminal?.status !== "matched")
    return finish(
      pool,
      job,
      "submitted",
      "shared_order_reconciliation_pending",
    );
  return finish(pool, job, job.kind === "buy" ? "filled" : "done", null, {
    venueOrderId,
    fillSize: Number(shares) / 1e6,
    fillSharesRaw: shares.toString(),
    fillPrice: price,
    cashDeltaRaw: cash.toString(),
    tradeTxHashes: hashes,
    sharedFillSyncPending: true,
  });
}

export async function repairHouseFillHistory(pool: Pool, a: Account) {
  if (!a.controller) return;
  const {
    rows: [job],
  } = await pool.query<Action>(
    `select * from house_trader_actions where account_user_id=$1
      and result->>'sharedFillSyncPending'='true' order by updated_at,id limit 1`,
    [a.user_id],
  );
  if (!job || typeof job.result.venueOrderId !== "string") return;
  await finish(pool, job, job.state, job.reason);
  const synced = await syncPolymarketOrdersRoute({
    userId: a.user_id,
    authWalletAddress: a.controller,
    body: { orderIds: [job.result.venueOrderId] },
    log: { warn: () => {}, error: () => {} },
  });
  if (!synced.ok) return;
  const {
    rows: [observed],
  } = await pool.query<{ raw: string }>(
    `select coalesce(sum(fills.fill_size),0)::text as raw from orders order_row
       join order_fills fills on fills.order_id=order_row.id
      where order_row.user_id=$1 and order_row.venue='polymarket' and order_row.venue_order_id=$2`,
    [a.user_id, job.result.venueOrderId],
  );
  if (Number(observed.raw) < Number(job.result.fillSize)) return;
  await pool.query(
    "update house_trader_actions set result=result - 'sharedFillSyncPending' where id=$1",
    [job.id],
  );
}
